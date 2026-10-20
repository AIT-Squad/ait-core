/**
 * [TDD]-model_validator — 规格图合法性的单一权威：六不变式全量校验（供 version
 * confirm/merge 门禁消费）、写时局部门禁（永远非法的关联在落盘前拒绝）、PRD 内容
 * 契约校验与正文关系残留扫描。纯函数模块，零 IO（视图由调用方提供 CombinedView）。
 * 不判定业务内容质量（只查结构契约）；不存储关系（委托 specgraph 域）。
 */

import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CombinedView,
  Edge,
  EdgeRel,
  SpecNode,
} from "../specgraph/graph-model.js";

export interface Violation {
  code: string;
  message: string;
  chunkId?: string;
  file?: string;
  enforcement?: "block" | "warn";
}

// ── chunk id 形态（doc-model 契约：[PRD]/[FSD]/[TDD] 前缀 + 可选 :<split名>，保留大写 :TEST）──

type Layer = "prd" | "fsd" | "tdd";

const TREE_RELS: ReadonlySet<string> = new Set([
  "derives",
  "decomposes",
  "details",
]);

function layerOf(chunkId: string): Layer | null {
  const tag = chunkId.slice(0, 5);
  if (tag === "[PRD]") return "prd";
  if (tag === "[FSD]") return "fsd";
  if (tag === "[TDD]") return "tdd";
  return null;
}

function isRootChunk(chunkId: string): boolean {
  return !chunkId.includes(":");
}

function isInternalSplit(chunkId: string): boolean {
  return chunkId.includes(":");
}

/** 验收 split（保留大写 `:TEST`）：自身不接收 derives 边。 */
function isAcceptanceSplit(chunkId: string): boolean {
  return chunkId.endsWith(":TEST");
}

function parentChunkId(chunkId: string): string {
  return chunkId.split(":")[0] as string;
}

/** chunk 所属文档（按 id 结构派生）：<layer>/<根id>.md。 */
function deriveFileOf(chunkId: string): string {
  const layer = layerOf(chunkId);
  const base = parentChunkId(chunkId);
  return layer === null ? `${base}.md` : `${layer}/${base}.md`;
}

function fileOf(view: CombinedView, chunkId: string): string {
  return view.nodes.get(chunkId)?.file ?? deriveFileOf(chunkId);
}

/** TDD 节点上随视图携带的 target_file 声明（未携带视为缺失）。 */
function targetFileOf(node: SpecNode | undefined): string | undefined {
  const value = node?.target_file;
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** 枚举已知节点的邻接边；两端均不存在的边须由视图提供方诊断。 */
function allEdges(view: CombinedView): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const id of view.nodes.keys()) {
    for (const e of [...view.edgesFrom(id), ...view.edgesTo(id)]) {
      const key = `${e.src}	${e.rel}	${e.dst}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
  }
  return out;
}

/** 只有真实端点、真实结构父与合法类型的树关系可以承载追溯。 */
function isLegalTreeEdge(view: CombinedView, edge: Edge): boolean {
  const { src, dst, rel } = edge;
  if ([src, dst].some((id) =>
    !view.hasNode(id) || (isInternalSplit(id) && !view.hasNode(parentChunkId(id)))
  )) return false;
  if (rel === "derives") {
    return layerOf(src) === "prd" && layerOf(dst) === "fsd" &&
      isRootChunk(src) === isRootChunk(dst) && !isAcceptanceSplit(dst);
  }
  if (rel === "decomposes") {
    return layerOf(src) === "fsd" && isInternalSplit(src) &&
      layerOf(dst) === "fsd" && isRootChunk(dst);
  }
  return rel === "details" && layerOf(src) === "fsd" &&
    isInternalSplit(src) && layerOf(dst) === "tdd";
}

/** TDD 沿 details→decomposes→derives（含 id 结构父通道）上溯是否可达 PRD。 */
function tracesToPrd(view: CombinedView, tddId: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [tddId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !view.hasNode(cur)) {
      continue;
    }
    seen.add(cur);
    if (layerOf(cur) === "prd" && isRootChunk(cur)) {
      return true;
    }
    for (const e of view.edgesTo(cur)) {
      if (isLegalTreeEdge(view, e)) {
        stack.push(e.src);
      }
    }
    if (isInternalSplit(cur) && view.hasNode(parentChunkId(cur))) {
      stack.push(parentChunkId(cur));
    }
  }
  return false;
}

/** Kahn 拓扑剥叶，返回参与成环的残余节点（字典序）。与 specgraph 同语义，本文件自含避免反向依赖。 */
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

// ── 六不变式全量校验 ──

/**
 * ①每 PRD 根 derives 恰 1（PRD_FSD_LINK_NOT_UNIQUE）②每 TDD details 父恰 1
 * （TDD_MULTI_PARENT）且必有 target_file（TDD_TARGET_FILE_REQUIRED）③target_file
 * 归一化后唯一（DUPLICATE_TARGET_FILE）④全部边端点存在（MISSING_ENDPOINT）⑤除
 * PRD 根外无孤儿（ORPHAN_CHUNK）⑥每 TDD 沿 details→decomposes→derives
 * 可达 PRD（TRACE_BROKEN）；树关系+id 结构通道 Kahn 判环（SPEC_CYCLE，depends_on
 * 环不判）。六条逐条独立判定、违例聚合返回；空视图零违例（合法）。
 */
export function validateInvariants(view: CombinedView): Violation[] {
  const violations: Violation[] = [];
  const chunkIds = [...view.nodes.keys()].filter((id) => layerOf(id) !== null);
  const edges = allEdges(view);

  // ④ 全部边端点存在
  for (const e of edges) {
    for (const endpoint of [e.src, e.dst]) {
      if (!view.hasNode(endpoint)) {
        violations.push({
          code: "MISSING_ENDPOINT",
          message: `边端点不存在：${endpoint}（${e.src} -[${e.rel}]-> ${e.dst}）`,
          chunkId: endpoint,
          file: deriveFileOf(endpoint),
        });
      }
    }
  }

  // ① 每 PRD 根 derives 恰 1（PRD 需求 split 的 M:N derives 不受此约束）
  for (const id of chunkIds) {
    if (layerOf(id) !== "prd" || !isRootChunk(id)) {
      continue;
    }
    const targets = [
      ...new Set(view.edgesFrom(id, "derives")
        .filter((e) => view.hasNode(e.dst) && layerOf(e.dst) === "fsd" && isRootChunk(e.dst))
        .map((e) => e.dst)),
    ].sort();
    if (targets.length !== 1) {
      violations.push({
        code: "PRD_FSD_LINK_NOT_UNIQUE",
        message: `PRD 根 ${id} 的 derives 关联应为恰 1 个 FSD，实际 ${targets.length}：${targets.join(", ") || "（无）"}`,
        chunkId: id,
        file: fileOf(view, id),
      });
    }
  }

  // ② 每 TDD details 父恰 1 且必有 target_file
  for (const id of chunkIds) {
    if (layerOf(id) !== "tdd") {
      continue;
    }
    const parents = [
      ...new Set(view.edgesTo(id, "details")
        .filter((e) => isLegalTreeEdge(view, e))
        .map((e) => e.src)),
    ].sort();
    if (parents.length !== 1) {
      violations.push({
        code: "TDD_MULTI_PARENT",
        message: `TDD ${id} 的 details 父应为恰 1 个，实际 ${parents.length}：${parents.join(", ") || "（无）"}`,
        chunkId: id,
        file: fileOf(view, id),
      });
    }
    if (targetFileOf(view.nodes.get(id)) === undefined) {
      violations.push({
        code: "TDD_TARGET_FILE_REQUIRED",
        message: `TDD ${id} 未声明 target_file`,
        chunkId: id,
        file: fileOf(view, id),
      });
    }
  }

  // ③ target_file 归一化后唯一
  violations.push(...validateTargetFileUniqueness(view));

  // id 结构通道：根 → 内部 split
  const structuralChildren = new Map<string, string[]>();
  for (const id of chunkIds) {
    if (isInternalSplit(id)) {
      const parent = parentChunkId(id);
      if (!view.hasNode(parent)) continue;
      const list = structuralChildren.get(parent);
      if (list) {
        list.push(id);
      } else {
        structuralChildren.set(parent, [id]);
      }
    }
  }

  // ⑤ 仅 PRD 根豁免；其余须自真实 PRD 根沿合法树关系+结构通道可达
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const id of chunkIds) {
    if (layerOf(id) === "prd" && isRootChunk(id)) {
      reachable.add(id);
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const next: string[] = [...(structuralChildren.get(cur) ?? [])];
    for (const e of view.edgesFrom(cur)) {
      if (isLegalTreeEdge(view, e)) {
        next.push(e.dst);
      }
    }
    for (const n of next) {
      if (reachable.has(n) || !view.hasNode(n) || layerOf(n) === null) {
        continue;
      }
      reachable.add(n);
      queue.push(n);
    }
  }
  for (const id of [...chunkIds].sort()) {
    if (reachable.has(id)) {
      continue;
    }
    violations.push({
      code: "ORPHAN_CHUNK",
      message: `孤儿 chunk（自任一 PRD 沿树关系不可达）：${id}`,
      chunkId: id,
      file: fileOf(view, id),
    });
  }

  // ⑥ 每 TDD 沿 details→decomposes→derives 可达 PRD
  for (const id of chunkIds) {
    if (layerOf(id) !== "tdd") {
      continue;
    }
    if (!tracesToPrd(view, id)) {
      violations.push({
        code: "TRACE_BROKEN",
        message: `TDD 沿 details→decomposes→derives 不可达 PRD：${id}`,
        chunkId: id,
        file: fileOf(view, id),
      });
    }
  }

  // 树关系+id 结构通道 Kahn 判环（depends_on 环不判，设计如此）
  const treeEdges: Array<readonly [string, string]> = [];
  for (const e of edges) {
    if (TREE_RELS.has(e.rel) && view.hasNode(e.src) && view.hasNode(e.dst)) {
      treeEdges.push([e.src, e.dst]);
    }
  }
  for (const [root, splits] of structuralChildren) {
    for (const split of splits) {
      treeEdges.push([root, split]);
    }
  }
  const residual = kahnResidual(treeEdges);
  if (residual.length > 0) {
    violations.push({
      code: "SPEC_CYCLE",
      message: `树关系+id 结构通道成环：${residual.join(", ")}`,
    });
  }

  // 写时与全图共用类型、唯一父与整份 FSD 的子类型规则。
  for (const edge of edges) {
    if (TREE_RELS.has(edge.rel) || edge.rel === "depends_on") {
      violations.push(...checkEdgeWrite(view, edge.src, edge.dst, edge.rel as EdgeRel));
    }
  }
  return violations.filter((violation, index) => violations.findIndex((other) =>
    other.code === violation.code && other.chunkId === violation.chunkId &&
    other.file === violation.file
  ) === index);
}

// ── 写时局部门禁 ──

/** FSD 根唯一上游、整份 FSD 的所有 split 不混合子 FSD 与 TDD。 */
function checkFsdStructure(
  view: CombinedView,
  src: string,
  dst: string,
  rel: EdgeRel,
): Violation[] {
  const violations: Violation[] = [];
  const candidate: Edge = { src, dst, rel, metadata: {} };
  if (layerOf(dst) === "fsd" && isRootChunk(dst) &&
    (rel === "derives" || rel === "decomposes")) {
    const parents = [...new Set([...view.edgesTo(dst), candidate]
      .filter((edge) => isLegalTreeEdge(view, edge))
      .map((edge) => edge.src))].sort();
    if (parents.length > 1) {
      violations.push({
        code: "FSD_MULTI_PARENT",
        message: `FSD 根 ${dst} 须有唯一上游，实际：${parents.join(", ")}`,
        chunkId: dst,
        file: fileOf(view, dst),
      });
    }
  }
  if (layerOf(src) === "fsd" && isInternalSplit(src) &&
    (rel === "decomposes" || rel === "details")) {
    const root = parentChunkId(src);
    const children = [...allEdges(view), candidate].filter((edge) =>
      parentChunkId(edge.src) === root && isInternalSplit(edge.src) &&
      isLegalTreeEdge(view, edge));
    if (children.some((edge) => edge.rel === "decomposes") &&
      children.some((edge) => edge.rel === "details")) {
      violations.push({
        code: "FSD_MIXED_CHILDREN",
        message: `FSD 文档 ${root} 的 split 不得同时分解子 FSD 与细化 TDD（含 :TEST）`,
        chunkId: root,
        file: fileOf(view, root),
      });
    }
  }
  return violations;
}

/**
 * 写时局部门禁（落盘前拒绝永远非法的关联）：幽灵端点（MISSING_ENDPOINT）；按 rel
 * 校验端点类型——derives: PRD→FSD（:TEST 与 FSD 根不是需求级 derives 合法目标，
 * DERIVES_ILLEGAL_TARGET；PRD 根→FSD 根的 1:1 派生除外）、decomposes: FSD split→FSD
 * 根、details: FSD split→TDD、depends_on: 同父兄弟 split；基数——TDD 第二父
 * （TDD_MULTI_PARENT）、PRD 第二 FSD（PRD_FSD_LINK_NOT_UNIQUE）。全局完备性
 * （孤儿/断链/成环）归 validateInvariants，建设中的图合法地暂违，不在此判。
 */
export function checkEdgeWrite(
  view: CombinedView,
  src: string,
  dst: string,
  rel: EdgeRel,
): Violation[] {
  const violations: Violation[] = [];
  if (!view.hasNode(src)) {
    violations.push({
      code: "MISSING_ENDPOINT",
      message: `边源端点不存在：${src}`,
      chunkId: src,
      file: deriveFileOf(src),
    });
  }
  if (!view.hasNode(dst)) {
    violations.push({
      code: "MISSING_ENDPOINT",
      message: `边目标端点不存在：${dst}`,
      chunkId: dst,
      file: deriveFileOf(dst),
    });
  }
  for (const endpoint of [src, dst]) {
    const root = parentChunkId(endpoint);
    if (isInternalSplit(endpoint) && !view.hasNode(root)) {
      violations.push({
        code: "MISSING_ENDPOINT",
        message: `split 的所属根不存在：${root}（${endpoint}）`,
        chunkId: root,
        file: deriveFileOf(root),
      });
    }
  }
  if (violations.length > 0) {
    return violations;
  }

  const srcLayer = layerOf(src);
  const dstLayer = layerOf(dst);

  if (rel === "derives") {
    if (srcLayer !== "prd" || dstLayer !== "fsd") {
      violations.push({
        code: "INVALID_DERIVES",
        message: `derives 端点类型非法（应为 PRD→FSD）：${src} -[derives]-> ${dst}`,
        chunkId: src,
        file: fileOf(view, src),
      });
      return violations;
    }
    if (isAcceptanceSplit(dst) || isRootChunk(src) !== isRootChunk(dst)) {
      violations.push({
        code: "DERIVES_ILLEGAL_TARGET",
        message: `derives 非法目标：${dst}（PRD 根仅派生 FSD 根；PRD 需求仅映射非 :TEST 的 FSD split）`,
        chunkId: dst,
        file: fileOf(view, dst),
      });
    }
    if (isRootChunk(src) && isRootChunk(dst)) {
      const others = view
        .edgesFrom(src, "derives")
        .map((e) => e.dst)
        .filter((d) => d !== dst && view.hasNode(d) && layerOf(d) === "fsd" && isRootChunk(d))
        .sort();
      if (others.length > 0) {
        violations.push({
          code: "PRD_FSD_LINK_NOT_UNIQUE",
          message: `PRD ${src} 已 derives ${others.join(", ")}，拒绝第二 FSD：${dst}`,
          chunkId: src,
          file: fileOf(view, src),
        });
      }
    }
    violations.push(...checkFsdStructure(view, src, dst, rel));
    return violations;
  }

  if (rel === "decomposes") {
    if (srcLayer !== "fsd" || dstLayer !== "fsd") {
      violations.push({
        code: "INVALID_DECOMPOSES_TYPES",
        message: `decomposes 端点类型非法（应为 FSD split→FSD 根）：${src} -[decomposes]-> ${dst}`,
        chunkId: src,
        file: fileOf(view, src),
      });
    } else if (!isInternalSplit(src) || !isRootChunk(dst)) {
      violations.push({
        code: "INVALID_FSD_DECOMPOSES",
        message: `decomposes 应连接父 FSD split 与子 FSD 根：${src} -[decomposes]-> ${dst}`,
        chunkId: src,
        file: fileOf(view, src),
      });
    }
    if (violations.length === 0) {
      violations.push(...checkFsdStructure(view, src, dst, rel));
    }
    return violations;
  }

  if (rel === "details") {
    if (srcLayer !== "fsd" || !isInternalSplit(src) || dstLayer !== "tdd") {
      violations.push({
        code: "INVALID_DETAILS",
        message: `details 端点类型非法（应为 FSD split→TDD）：${src} -[details]-> ${dst}`,
        chunkId: src,
        file: fileOf(view, src),
      });
      return violations;
    }
    const others = view
      .edgesTo(dst, "details")
      .filter((e) => isLegalTreeEdge(view, e))
      .map((e) => e.src)
      .filter((s) => s !== src)
      .sort();
    if (others.length > 0) {
      violations.push({
        code: "TDD_MULTI_PARENT",
        message: `TDD ${dst} 已有 details 父 ${others.join(", ")}，拒绝第二父：${src}`,
        chunkId: dst,
        file: fileOf(view, dst),
      });
    }
    violations.push(...checkFsdStructure(view, src, dst, rel));
    const target = targetFileOf(view.nodes.get(dst));
    if (target !== undefined) {
      const targetViolations = validateTargetFileUniqueness(view);
      const invalid = targetViolations.filter((violation) =>
        violation.code === "INVALID_TARGET_FILE" && violation.chunkId === dst);
      if (invalid.length > 0) {
        violations.push(...invalid);
      } else {
        const normalized = normalizeTargetFile(target);
        violations.push(...targetViolations.filter((violation) =>
          violation.code === "DUPLICATE_TARGET_FILE" && violation.file === normalized));
      }
    }
    return violations;
  }

  // depends_on：同父兄弟 split
  if (srcLayer !== "fsd" || dstLayer !== "fsd") {
    violations.push({
      code: "INVALID_DEPENDS_ON_TYPES",
      message: `depends_on 端点类型非法（应为 FSD split 之间）：${src} -[depends_on]-> ${dst}`,
      chunkId: src,
      file: fileOf(view, src),
    });
  } else if (!isInternalSplit(src) || !isInternalSplit(dst)) {
    violations.push({
      code: "DEPENDS_ON_ROOT_CHUNK",
      message: `depends_on 端点须为 FSD split，不得指向根 chunk：${src} -[depends_on]-> ${dst}`,
      chunkId: src,
      file: fileOf(view, src),
    });
  } else if (src === dst) {
    violations.push({
      code: "DEPENDS_ON_SELF",
      message: `depends_on 不得引用自身：${src}`,
      chunkId: src,
      file: fileOf(view, src),
    });
  } else if (parentChunkId(src) !== parentChunkId(dst)) {
    violations.push({
      code: "DEPENDS_ON_CROSS_LEVEL",
      message: `depends_on 须连接同父兄弟 split：${src} -[depends_on]-> ${dst}`,
      chunkId: src,
      file: fileOf(view, src),
    });
  }
  return violations;
}

// ── target_file 归一化与唯一性 ──

/** 词法归一化项目相对路径；不访问文件系统或解析 symlink。 */
export function normalizeTargetFile(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = value.replace(/\\/g, "/");
  const normalized = posix.normalize(path);
  if (path.startsWith("/") || /^[a-z]:/i.test(path) ||
    /^[a-z]:/i.test(normalized) || normalized === "." ||
    normalized === ".." || normalized.startsWith("../")) {
    throw Object.assign(new Error(`target_file 必须是项目内文件的相对路径：${value}`), {
      code: "INVALID_TARGET_FILE",
    });
  }
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** ③ 制品恰 1 TDD 持有：target_file 归一化后撞车即 DUPLICATE_TARGET_FILE。 */
export function validateTargetFileUniqueness(view: CombinedView): Violation[] {
  const violations: Violation[] = [];
  const byTarget = new Map<string, string[]>();
  for (const [id, node] of view.nodes) {
    if (layerOf(id) !== "tdd") {
      continue;
    }
    const target = targetFileOf(node);
    if (target === undefined) {
      continue; // 缺失归 TDD_TARGET_FILE_REQUIRED，不在此重复报告
    }
    let normalized: string;
    try {
      normalized = normalizeTargetFile(target);
    } catch (error) {
      violations.push({
        code: "INVALID_TARGET_FILE",
        message: error instanceof Error ? error.message : String(error),
        chunkId: id,
        file: target,
      });
      continue;
    }
    const owners = byTarget.get(normalized);
    if (owners) {
      owners.push(id);
    } else {
      byTarget.set(normalized, [id]);
    }
  }
  for (const [target, owners] of [...byTarget.entries()].sort()) {
    const unique = [...new Set(owners)].sort();
    if (unique.length > 1) {
      violations.push({
        code: "DUPLICATE_TARGET_FILE",
        message: `target_file 归一化后撞车：${target} 由多个 TDD 持有：${unique.join(", ")}`,
        chunkId: unique[0] as string,
        file: target,
      });
    }
  }
  return violations;
}

// ── 内容契约与正文关系残留 ──

const USER_STORY_RE = /^[ \t]*\*\*用户故事[:：]\*\*/m;
const ACCEPTANCE_HEADING_RE = /^(#{2,6})[ \t]*验收标准[ \t]*\r?$/m;
const ACCEPTANCE_ITEM_RE = /^\s*\d+[a-z]?\.\s+\S/m;

/**
 * PRD 需求 chunk（`[PRD]-<root>:<slug>` 内部 split）必须含 `**用户故事:**` 行与带
 * 编号条目的验收标准小节（空壳小节不视为满足契约），缺则
 * PRD_REQUIREMENT_CONTRACT_VIOLATION。PRD 根 chunk 不受本契约约束（根承载
 * 概述/范围/目标，不写验收标准）。
 */
export function scanPrdRequirementContract(
  chunkId: string,
  content: string,
): Violation[] {
  if (!chunkId.startsWith("[PRD]-") || !isInternalSplit(chunkId)) {
    return [];
  }
  const missing: string[] = [];
  if (!USER_STORY_RE.test(content)) {
    missing.push("用户故事");
  }
  const heading = ACCEPTANCE_HEADING_RE.exec(content);
  if (heading === null) {
    missing.push("验收标准");
  } else {
    const remainder = content.slice(heading.index + heading[0].length);
    const nextSection = new RegExp("^#{1," + heading[1]!.length + "}[ \t]+\\S", "m");
    const section = remainder.split(nextSection, 1)[0] ?? "";
    if (!ACCEPTANCE_ITEM_RE.test(section)) {
      missing.push("验收标准条目");
    }
  }
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: "PRD_REQUIREMENT_CONTRACT_VIOLATION",
      message: `PRD 需求 chunk ${chunkId} 缺：${missing.join("、")}（须含 **用户故事:** 行与带编号条目的验收标准小节）`,
      chunkId,
    },
  ];
}

const REL_COMMENT_RE = /<!--\s*@(ref|extract)\b[\s\S]*?-->/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const REL_DECL_KEY_RE = /^(?:depends_on|derives)\s*:/m;

/** 同长反引号才闭合；未闭合 span 不遮蔽正文，也不跨过段落或围栏边界。 */
function maskInlineCodeSpans(content: string): string {
  const tokens = /\\[\\`]|<!--[\s\S]*?-->|`+/g;
  const closers = /`+|\n[ \t]*\n/g;
  const parts: string[] = [];
  let copiedThrough = 0;
  for (let token = tokens.exec(content); token !== null; token = tokens.exec(content)) {
    if (token[0][0] !== "`") continue;
    closers.lastIndex = tokens.lastIndex;
    let closing = closers.exec(content);
    while (closing !== null && closing[0][0] === "`" &&
      closing[0].length !== token[0].length) {
      closing = closers.exec(content);
    }
    if (closing === null || closing[0][0] !== "`") continue;
    parts.push(content.slice(copiedThrough, token.index), " ");
    copiedThrough = closers.lastIndex;
    tokens.lastIndex = copiedThrough;
  }
  parts.push(content.slice(copiedThrough));
  return parts.join("");
}

/** 普通 YAML 的嵌套同名字段不是关系声明；语法坏的声明仍交由调用方拒绝。 */
function isRelationDeclaration(content: string): boolean {
  try {
    const value: unknown = parseYaml(content, { logLevel: "silent" });
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      (Object.hasOwn(value, "depends_on") || Object.hasOwn(value, "derives"));
  } catch {
    return REL_DECL_KEY_RE.test(content);
  }
}

/**
 * 正文关系残留扫描：内容含 `@ref`/`@extract` 注释，或（非 fsd 层的）```yaml
 * depends_on:/derives: 声明块 → MARKDOWN_CONTAINS_RELATION（拒于落盘之前；关系
 * 只经四出生地建边，FSD 层声明块由创建方解析建边后剥离，正文零关系声明）。
 */
export function scanContentRelations(
  content: string,
  kind: "prd" | "fsd" | "tdd",
): Violation[] {
  const violations: Violation[] = [];
  const prose: string[] = [];
  const yamlBlocks: string[] = [];
  let fence: { marker: string; length: number; yaml: boolean; lines: string[] } | null = null;
  for (const line of content.split(/\r?\n/)) {
    const match = FENCE_RE.exec(line);
    if (fence !== null) {
      if (match !== null && match[1]![0] === fence.marker &&
        match[1]!.length >= fence.length && match[2]!.trim() === "") {
        if (fence.yaml) yamlBlocks.push(fence.lines.join("\n"));
        fence = null;
      } else if (fence.yaml) {
        fence.lines.push(line);
      }
      continue;
    }
    if (match !== null && (match[1]![0] !== "`" || !match[2]!.includes("`"))) {
      fence = {
        marker: match[1]![0]!,
        length: match[1]!.length,
        yaml: /^yaml(?:[ \t].*)?$/i.test(match[2]!.trim()),
        lines: [],
      };
      prose.push("");
      continue;
    }
    prose.push(line);
  }
  if (fence?.yaml) yamlBlocks.push(fence.lines.join("\n"));
  const comments = [...maskInlineCodeSpans(prose.join("\n")).matchAll(REL_COMMENT_RE)];
  const hasRef = comments.some((match) => match[1] === "ref");
  const hasExtract = comments.some((match) => match[1] === "extract");
  if (hasRef) {
    violations.push({
      code: "MARKDOWN_CONTAINS_RELATION",
      message: "正文不得含 @ref 注释（关系只存于 SpecGraph，正文零关系声明）",
    });
  }
  if (hasExtract) {
    violations.push({
      code: "MARKDOWN_CONTAINS_RELATION",
      message: "正文不得含 @extract 注释（关系只存于 SpecGraph，正文零关系声明）",
    });
  }
  if (kind !== "fsd") {
    for (const block of yamlBlocks) {
      if (isRelationDeclaration(block)) {
        violations.push({
          code: "MARKDOWN_CONTAINS_RELATION",
          message: `非 FSD 层（${kind}）正文不得含 depends_on/derives 声明块`,
        });
        break;
      }
    }
  }
  return violations;
}
