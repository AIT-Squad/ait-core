import type { Direction } from "../api/types.js";
import type { CombinedView, Edge, EdgeRel } from "./graph-model.js";

const TREE_RELS: ReadonlySet<string> = new Set(["derives", "decomposes", "details"]);
const DEPENDS_ON = "depends_on";
const QUERY_RELS: ReadonlySet<string> = new Set([...TREE_RELS, DEPENDS_ON]);

class QueryUsageError extends Error {
  readonly code = "USAGE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "QueryUsageError";
  }
}

function validateDepsArguments(direction: unknown, rels: unknown): void {
  if (direction !== "in" && direction !== "out" && direction !== "both") {
    throw new QueryUsageError("direction 必须为 in、out 或 both");
  }
  if (rels === undefined) return;
  if (!Array.isArray(rels)) {
    throw new QueryUsageError("rels 必须为关系数组");
  }
  for (const rel of rels) {
    if (typeof rel !== "string" || !QUERY_RELS.has(rel)) {
      throw new QueryUsageError("rels 仅支持 derives、decomposes、details、depends_on");
    }
  }
}

export interface DepsResult {
  found: boolean;
  target: string;
  direction: Direction;
  edges: Edge[];
}

export interface ImpactResult {
  found: boolean;
  impacted: string[];
  count: number;
}

/** id 结构通道：根 → split（直接子：去掉父前缀后不再含 ":"）。 */
function structuralChildren(view: CombinedView, id: string): string[] {
  const prefix = `${id}:`;
  const children: string[] = [];
  for (const nodeId of view.nodes.keys()) {
    if (nodeId.startsWith(prefix) && !nodeId.slice(prefix.length).includes(":")) {
      children.push(nodeId);
    }
  }
  return children;
}

/** Kahn 拓扑剥叶，返回参与成环的残余节点（字典序）。 */
function kahnResidual(edges: ReadonlyArray<readonly [string, string]>): string[] {
  const nodes = new Set<string>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const [src, dst] of edges) {
    nodes.add(src);
    nodes.add(dst);
    indegree.set(dst, (indegree.get(dst) ?? 0) + 1);
    if (!indegree.has(src)) {
      indegree.set(src, 0);
    }
    const list = outgoing.get(src);
    if (list) {
      list.push(dst);
    } else {
      outgoing.set(src, [dst]);
    }
  }
  const queue: string[] = [];
  for (const n of nodes) {
    if ((indegree.get(n) ?? 0) === 0) {
      queue.push(n);
    }
  }
  const removed = new Set<string>();
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (removed.has(n)) {
      continue;
    }
    removed.add(n);
    for (const m of outgoing.get(n) ?? []) {
      const d = (indegree.get(m) ?? 0) - 1;
      indegree.set(m, d);
      if (d === 0) {
        queue.push(m);
      }
    }
  }
  return [...nodes].filter((n) => !removed.has(n)).sort();
}

export function queryDeps(
  view: CombinedView,
  target: string,
  direction: Direction = "both",
  rels?: EdgeRel[],
): DepsResult {
  validateDepsArguments(direction, rels);
  if (!view.nodes.has(target)) {
    return { found: false, target, direction, edges: [] };
  }
  const selectedRels = rels === undefined ? undefined : new Set<string>(rels);
  const seen = new Set<string>();
  const edges: Edge[] = [];
  const collect = (list: Iterable<Edge>): void => {
    for (const e of list) {
      if (selectedRels !== undefined && !selectedRels.has(e.rel)) continue;
      const key = `${e.src}${e.rel}${e.dst}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(e);
      }
    }
  };
  if (direction === "out" || direction === "both") {
    collect(view.edgesFrom(target));
  }
  if (direction === "in" || direction === "both") {
    collect(view.edgesTo(target));
  }
  return { found: true, target, direction, edges };
}

export function analyzeImpact(view: CombinedView, target: string): ImpactResult {
  if (!view.nodes.has(target)) {
    return { found: false, impacted: [], count: 0 };
  }
  const visited = new Set<string>([target]);
  const impacted = new Set<string>();
  const queue: string[] = [target];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const next = new Set<string>();
    // 正向树关系：derives / decomposes / details
    for (const e of view.edgesFrom(cur)) {
      if (TREE_RELS.has(e.rel)) {
        next.add(e.dst);
      }
    }
    // id 结构子节点
    for (const child of structuralChildren(view, cur)) {
      next.add(child);
    }
    // 反向 depends_on：依赖当前节点者受影响
    for (const e of view.edgesTo(cur, DEPENDS_ON)) {
      next.add(e.src);
    }
    for (const n of next) {
      if (!visited.has(n)) {
        visited.add(n);
        impacted.add(n);
        queue.push(n);
      }
    }
  }
  const sorted = [...impacted].sort();
  return { found: true, impacted: sorted, count: sorted.length };
}

export function detectCycle(view: CombinedView): string[][] {
  // depends_on 不参与判环：仅树关系 + id 结构通道
  const edges: Array<readonly [string, string]> = [];
  for (const id of view.nodes.keys()) {
    for (const e of view.edgesFrom(id)) {
      if (TREE_RELS.has(e.rel)) {
        edges.push([e.src, e.dst]);
      }
    }
    for (const child of structuralChildren(view, id)) {
      edges.push([id, child]);
    }
  }
  const residual = new Set(kahnResidual(edges));
  if (residual.size === 0) {
    return [];
  }
  // 残余节点按无向连通分量分组
  const adj = new Map<string, Set<string>>();
  for (const [src, dst] of edges) {
    if (!residual.has(src) || !residual.has(dst)) {
      continue;
    }
    let s = adj.get(src);
    if (!s) {
      s = new Set<string>();
      adj.set(src, s);
    }
    s.add(dst);
    let d = adj.get(dst);
    if (!d) {
      d = new Set<string>();
      adj.set(dst, d);
    }
    d.add(src);
  }
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const start of [...residual].sort()) {
    if (seen.has(start)) {
      continue;
    }
    const component: string[] = [];
    const stack: string[] = [start];
    seen.add(start);
    while (stack.length > 0) {
      const n = stack.pop()!;
      component.push(n);
      for (const m of adj.get(n) ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    groups.push(component.sort());
  }
  return groups;
}
