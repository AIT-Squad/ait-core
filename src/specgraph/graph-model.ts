/**
 * [TDD]-graph_model — SpecGraph 权威存储、从索引重建节点并保留显式边、
 * baseline∪version 组合视图（chunk_id 身份空间坍缩）、合入时版本图并入基线图。
 *
 * 图文件形态与 Python `specgraph.py` 一致：specs 为按 uri 排序的数组，
 * 节点 {uri,title,type,version,chunk_id,file,metadata}，边 {src,dst,rel,weight,metadata}，
 * 边端点为 uri。关系不从命名或文档结构推断：sync 只重建节点、保留显式边
 * （metadata.source ∈ {manual, new-model-cli, fsd-declaration}）；一切新边只经 addEdge 出生。
 * 组合视图是派生物随取随算，不持久化；视图节点的 heading/summary/target_file 在构建
 * 视图时从索引与文档取得，不写入图文件。已合入版本的版本图只读。
 * 本文件不做关系合法性判定（归 new_model 域）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ZodError } from "zod";
import { parse as parseYaml } from "yaml";
import type { ProjectRoot } from "../foundation/root.js";
import { loadYaml, saveModel, YamlIoError } from "../foundation/yaml.js";
import { ensureWithin } from "../foundation/io.js";
import { parseFile, type ParsedFile } from "../doc-model/chunk-parser.js";
import { IndexManager } from "../indexing/index-manager.js";
import {
  SpecGraphSchema,
  type SpecGraph,
  type Spec,
  type Edge as GraphEdge,
} from "../doc-model/schemas.js";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type SpecType = "prd" | "fsd" | "tdd" | "other";

/** 四类关系（new_model 域建边原语使用）。 */
export type EdgeRel = "derives" | "decomposes" | "details" | "depends_on";

/** 组合视图节点：身份为 chunk_id；version/file/uri 取自胜出一侧。 */
export interface ViewNode {
  chunk_id: string;
  type: SpecType;
  version: string;
  file: string;
  title: string;
  uri: string;
  heading: string;
  summary: string | null;
  target_file?: string;
}

/** 组合视图边：端点已坍缩到 chunk_id。 */
export interface ViewEdge {
  src: string;
  dst: string;
  rel: string;
  metadata: Record<string, unknown>;
}

/** 兼容别名：视图消费方（validator/queries 等）沿用的名字。 */
export type SpecNode = ViewNode;
export type Edge = ViewEdge;

export type SpecGraphErrorCode =
  | "MISSING_ENDPOINT"
  | "DUPLICATE_EDGE"
  | "GRAPH_UNREADABLE";

export class SpecGraphError extends Error {
  readonly code: SpecGraphErrorCode;

  constructor(code: SpecGraphErrorCode, message: string) {
    super(message);
    this.name = "SpecGraphError";
    this.code = code;
  }
}

const BASELINE = "baseline";
const DECLARATION_OVERRIDES = "fsd_declaration_overrides";

/**
 * 显式来源集合：这些 metadata.source 的边跨 sync 存活（与 Python `_preserve_explicit_edges`
 * 白名单一致）。fsd-declaration 边由 new_model 域的 FSD create 流程建立，sync 只保留重建。
 */
const EXPLICIT_SOURCES: ReadonlySet<string> = new Set([
  "manual",
  "new-model-cli",
  "fsd-declaration",
]);

// ─────────────────────────────────────────────────────────────
// 导出工具函数（与 Python specgraph.py 一致）
// ─────────────────────────────────────────────────────────────

/** 节点类型：file 首段（prd/fsd/tdd）优先，否则按 id 前缀，否则 other。 */
export function specType(chunkId: string, file?: string): SpecType {
  if (file) {
    const first = (file.split("/", 1)[0] ?? "").toLowerCase();
    if (first === "prd" || first === "fsd" || first === "tdd") {
      return first;
    }
  }
  if (chunkId.startsWith("[PRD]-")) return "prd";
  if (chunkId.startsWith("[FSD]-")) return "fsd";
  if (chunkId.startsWith("[TDD]-")) return "tdd";
  return "other";
}

/** 节点 uri：spec:<type>:<version>:<chunk_id>。 */
export function makeUri(chunkId: string, version: string, file?: string): string {
  return `spec:${specType(chunkId, file)}:${version}:${chunkId}`;
}

/** 从 TDD chunk 内容提取 ```yaml target_file 声明（供视图节点携带，validator 消费）。 */
export function extractTargetFile(content: string): string | undefined {
  const m = /```yaml\s*\ntarget_file:\s*([^ \t\r\n]+)/.exec(content);
  return m?.[1];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助（不导出）
// ─────────────────────────────────────────────────────────────

function emptyGraph(): SpecGraph {
  return { version: 1, updated: null, specs: [], edges: [] };
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** uri 解析为 chunk_id（spec:<type>:<version>:<chunk_id>，chunk_id 可含 ":"）；非法返回 null。 */
function parseUri(uri: string): { version: string; chunkId: string } | null {
  const parts = uri.split(":");
  if (parts.length < 4 || parts[0] !== "spec") return null;
  return { version: parts[2] as string, chunkId: parts.slice(3).join(":") };
}

/** 稳定序列化（对象键排序，数组保序），用于语义等同比较。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 同 src/dst/rel 合并（更新 weight、合并 metadata），否则追加。 */
function mergeEdge(edges: GraphEdge[], edge: GraphEdge): void {
  const existing = edges.find(
    (e) => e.src === edge.src && e.dst === edge.dst && e.rel === edge.rel,
  );
  if (existing !== undefined) {
    existing.weight = edge.weight;
    existing.metadata = { ...existing.metadata, ...edge.metadata };
    return;
  }
  edges.push({ ...edge, metadata: { ...edge.metadata } });
}

/** 读图：不存在返回空图；YAML 或 schema 失败抛 GRAPH_UNREADABLE（含路径与首个 issue 字段路径）。 */
function readGraph(file: string): SpecGraph {
  if (!fs.existsSync(file)) {
    return emptyGraph();
  }
  let raw: unknown;
  try {
    raw = loadYaml(file);
  } catch (err) {
    if (isEnoent(err)) return emptyGraph();
    if (err instanceof YamlIoError) {
      throw new SpecGraphError("GRAPH_UNREADABLE", `图文件不可读（${file}）：${err.message}`);
    }
    throw err;
  }
  return validateGraph(file, raw ?? {});
}

/** 读写共用 schema 归一与校验，失败时保留文件及字段定位。 */
function validateGraph(file: string, value: unknown): SpecGraph {
  try {
    return SpecGraphSchema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const issuePath = first && first.path.length > 0 ? first.path.join(".") : "(root)";
      throw new SpecGraphError(
        "GRAPH_UNREADABLE",
        `图文件 schema 校验失败（${file}）于 ${issuePath}：${first?.message ?? err.message}`,
      );
    }
    throw err;
  }
}

/**
 * 写图：specs 按 uri 排序；磁盘现有文件的 specs 与 edges 语义等同于待写内容时不写盘
 * （updated 不滚动）；否则置 updated 为当前 ISO 时间后原子写。返回落盘形态的图。
 */
function writeGraph(file: string, graph: SpecGraph): SpecGraph {
  const normalized = validateGraph(file, graph);
  const specs = [...normalized.specs].sort((a, b) => compareStr(a.uri, b.uri));
  const edges = normalized.edges;
  if (fs.existsSync(file)) {
    let existing: SpecGraph | null = null;
    try {
      existing = readGraph(file);
    } catch {
      existing = null; // 现有文件损坏：视为不同，覆盖写
    }
    if (
      existing !== null &&
      canonical(existing.specs) === canonical(specs) &&
      canonical(existing.edges) === canonical(edges)
    ) {
      return { version: existing.version, updated: existing.updated, specs, edges };
    }
  }
  const out: SpecGraph = {
    version: normalized.version,
    updated: new Date().toISOString(),
    specs,
    edges,
  };
  saveModel(file, out);
  return out;
}

/** 旧图中 metadata.source 属显式来源集合的边并入新图（同 src/dst/rel 合并）。 */
function preserveExplicitEdges(prev: SpecGraph, cur: SpecGraph): void {
  for (const edge of prev.edges) {
    const source = edge.metadata["source"];
    if (typeof source !== "string" || !EXPLICIT_SOURCES.has(source)) continue;
    mergeEdge(cur.edges, edge);
  }
}

/** sync 保留同 chunk 的声明键标记；索引显式携带新值时优先使用索引值。 */
function preserveDeclarationOverrides(prev: SpecGraph, cur: SpecGraph): void {
  const previous = new Map(prev.specs.map((spec) => [spec.chunk_id, spec]));
  for (const spec of cur.specs) {
    if (Object.hasOwn(spec.metadata, DECLARATION_OVERRIDES)) continue;
    const old = previous.get(spec.chunk_id);
    if (old !== undefined && Object.hasOwn(old.metadata, DECLARATION_OVERRIDES)) {
      spec.metadata[DECLARATION_OVERRIDES] = old.metadata[DECLARATION_OVERRIDES];
    }
  }
}

/** 基线元数据不携带版本生命周期字段；其余自定义字段保留。 */
function baselineMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const baseline: Record<string, unknown> = { ...metadata, source: BASELINE };
  delete baseline["state"];
  delete baseline["action"];
  delete baseline["commit_id"];
  delete baseline[DECLARATION_OVERRIDES];
  return baseline;
}

/** 版本图中出现的 FSD 根（旧格式 owned-scope）。 */
function ownedRootsOf(vgraph: SpecGraph): Set<string> {
  const roots = new Set<string>();
  for (const spec of vgraph.specs) {
    if (spec.type === "fsd" && !spec.chunk_id.includes(":")) {
      roots.add(spec.chunk_id);
    }
  }
  return roots;
}

/** baseline 侧 depends_on 边是否落在 owned-scope 内（src 为被版本接管的 FSD 根的 split）。 */
function isOwnedScopeDependsOn(srcChunk: string, rel: string, ownedRoots: ReadonlySet<string>): boolean {
  if (rel !== "depends_on" || !srcChunk.includes(":")) return false;
  return ownedRoots.has(srcChunk.split(":", 1)[0] as string);
}

/** 新格式按文件启用键级所有权；无标记的文件沿用旧 ownedRoots 语义。 */
function baselineEdgeOverrides(
  baseline: SpecGraph,
  vgraph: SpecGraph,
): (edge: GraphEdge, src: string, dst: string) => boolean {
  const ownedRoots = ownedRootsOf(vgraph);
  const nodes = new Map([...baseline.specs, ...vgraph.specs].map((spec) => [spec.chunk_id, spec]));
  const versionNodes = new Map(vgraph.specs.map((spec) => [spec.chunk_id, spec]));
  const markedFiles = new Set(
    vgraph.specs
      .filter((spec) => spec.type === "fsd" && Object.hasOwn(spec.metadata, DECLARATION_OVERRIDES))
      .map((spec) => spec.file),
  );
  return (edge, src, dst) => {
    const ownerId = edge.rel === "derives" ? dst : src;
    const owner = nodes.get(ownerId);
    if (owner?.type === "fsd" && markedFiles.has(owner.file)) {
      if (
        edge.metadata["source"] !== "fsd-declaration" ||
        !ownerId.includes(":") ||
        (edge.rel !== "derives" && edge.rel !== "depends_on")
      ) return false;
      const marker = versionNodes.get(ownerId)?.metadata[DECLARATION_OVERRIDES];
      return marker !== null && typeof marker === "object" &&
        (marker as Record<string, unknown>)[edge.rel] === true;
    }
    return isOwnedScopeDependsOn(src, edge.rel, ownedRoots);
  };
}

interface VersionIndexLike {
  status: string;
  chunks: ReadonlyArray<{
    id: string;
    file: string | null;
    heading: string | null;
    action: string;
    state: string;
    commit_id: string | null;
    overrides: string | null;
    summary: string | null;
    metadata: Record<string, unknown>;
  }>;
}

/** 加载版本索引；索引文件不存在时按空的开发中索引处理（与 Python 一致）。 */
function loadVersionIndexOrEmpty(indexes: IndexManager, version: string): VersionIndexLike {
  try {
    return indexes.loadVersionIndex(version) as VersionIndexLike;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "VERSION_NOT_FOUND") {
      return { status: "developing", chunks: [] };
    }
    throw err;
  }
}

/** 边端点 uri → chunk_id：先查已知节点，兜底解析 uri；非法 uri 返回 null。 */
function chunkOfUri(uri: string, known: ReadonlyMap<string, string>): string | null {
  const hit = known.get(uri);
  if (hit !== undefined) return hit;
  return parseUri(uri)?.chunkId ?? null;
}

function uriToChunkMap(...graphs: SpecGraph[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of graphs) {
    for (const spec of g.specs) map.set(spec.uri, spec.chunk_id);
  }
  return map;
}



// ─────────────────────────────────────────────────────────────
// SpecGraphStore
// ─────────────────────────────────────────────────────────────

export class SpecGraphStore {
  private readonly root: ProjectRoot;

  constructor(root: ProjectRoot) {
    this.root = root;
  }

  /** 图文件路径：baseline → .meta/specgraph.yaml；版本 → .meta/specgraph-<version>.yaml。 */
  private graphPath(version: string): string {
    const name = version === BASELINE ? "specgraph.yaml" : `specgraph-${version}.yaml`;
    return ensureWithin(this.root.root, path.join(this.root.meta, name));
  }

  /** 加载图：文件不存在返回空图；损坏抛 GRAPH_UNREADABLE。 */
  load(version: string = BASELINE): SpecGraph {
    return readGraph(this.graphPath(version));
  }

  /** 候选图经校验后原子保存；语义不变时不写盘。 */
  save(version: string, graph: SpecGraph): void {
    writeGraph(this.graphPath(version), graph);
  }

  /**
   * 从索引重建节点并保留显式边与版本声明键标记。
   * baseline 图 + 每个未合入版本的版本图。
   * 不生成任何树边、不读文档内容推断关系；已合入版本不读不写。返回 baseline 图。
   */
  sync(): SpecGraph {
    const indexes = new IndexManager(this.root);

    // baseline
    const basePath = this.graphPath(BASELINE);
    const prevBase = readGraph(basePath);
    const base = emptyGraph();
    const baselineIndex = indexes.loadBaseline();
    for (const entry of baselineIndex.chunks) {
      base.specs.push({
        uri: makeUri(entry.id, BASELINE, entry.file),
        title: entry.heading,
        type: specType(entry.id, entry.file),
        version: BASELINE,
        chunk_id: entry.id,
        file: entry.file,
        metadata: baselineMetadata(entry.metadata),
      });
    }

    // 只保留显式来源的边（manual/new-model-cli/fsd-declaration）。
    // sync 绝不从文档内容推断/建立 fsd-declaration 边——它们由 new_model 域的
    // FSD create 流程建立与对账（Python 同构：sync 只保留，不创建）。
    preserveExplicitEdges(prevBase, base);

    const written = writeGraph(basePath, base);

    // 版本
    for (const version of indexes.listVersions()) {
      const vindex = loadVersionIndexOrEmpty(indexes, version);
      if (vindex.status === "merged") continue; // 已合入：不读不写
      this.syncVersionGraph(version, vindex);
    }

    return written;
  }

  /** 仅从真实版本索引同步指定版本图；已合入版本返回原图，不写基线或其它版本。 */
  syncVersion(version: string): SpecGraph {
    const vindex = new IndexManager(this.root).loadVersionIndex(version);
    if (vindex.status === "merged") return this.load(version);
    return this.syncVersionGraph(version, vindex);
  }

  /** 全图同步与版本专用同步共用节点重建、声明标记和显式边保留逻辑。 */
  private syncVersionGraph(version: string, vindex: VersionIndexLike): SpecGraph {
    const vPath = this.graphPath(version);
    const prev = readGraph(vPath);
    const vg = emptyGraph();
    for (const entry of vindex.chunks) {
      const file = entry.file ?? "";
      vg.specs.push({
        uri: makeUri(entry.id, version, file),
        title: entry.heading ?? "",
        type: specType(entry.id, file),
        version,
        chunk_id: entry.id,
        file,
        metadata: {
          source: "version",
          state: entry.state,
          action: entry.action,
          commit_id: entry.commit_id,
          ...entry.metadata,
        },
      });
    }
    preserveDeclarationOverrides(prev, vg);
    preserveExplicitEdges(prev, vg);
    return writeGraph(vPath, vg);
  }

  /**
   * 底层建边原语（仅供 new_model 域）：写版本图。端点（chunk_id）须在 baseline∪version
   * 节点中存在（MISSING_ENDPOINT，零写入）；同 src/dst/rel 已存在报 DUPLICATE_EDGE（零写入）；
   * 端点在版本图缺节点时从 baseline 节点物化为版本节点；边写为
   * {src:uri, dst:uri, rel, weight:1.0, metadata:{source}}。
   */
  addEdge(version: string, src: string, dst: string, rel: EdgeRel, source: string): void {
    const file = this.graphPath(version);
    const baseline = this.load();
    const vgraph = version === BASELINE ? baseline : readGraph(file);

    const findNode = (graph: SpecGraph, chunkId: string): Spec | undefined =>
      graph.specs.find((s) => s.chunk_id === chunkId);

    for (const endpoint of [src, dst]) {
      if (findNode(vgraph, endpoint) === undefined && findNode(baseline, endpoint) === undefined) {
        throw new SpecGraphError(
          "MISSING_ENDPOINT",
          `addEdge 幽灵端点：${endpoint}（${src} -[${rel}]-> ${dst}）不在 baseline∪${version} 中`,
        );
      }
    }

    const known = uriToChunkMap(vgraph);
    const duplicate = vgraph.edges.some(
      (e) => e.rel === rel && chunkOfUri(e.src, known) === src && chunkOfUri(e.dst, known) === dst,
    );
    if (duplicate) {
      throw new SpecGraphError(
        "DUPLICATE_EDGE",
        `addEdge 重复边：${src} -[${rel}]-> ${dst} 已存在于 ${version}`,
      );
    }

    const uriOf = (chunkId: string): string => {
      const existing = findNode(vgraph, chunkId);
      if (existing !== undefined) return existing.uri;
      // 版本图缺节点：从 baseline 节点物化为版本节点
      const baseNode = findNode(baseline, chunkId) as Spec;
      const materialized: Spec = {
        ...baseNode,
        uri: makeUri(chunkId, version, baseNode.file),
        version,
        metadata: { ...baseNode.metadata, source: "version" },
      };
      vgraph.specs.push(materialized);
      return materialized.uri;
    };
    const srcUri = uriOf(src);
    const dstUri = uriOf(dst);

    vgraph.edges.push({ src: srcUri, dst: dstUri, rel, weight: 1.0, metadata: { source } });
    writeGraph(file, vgraph);
  }

  /**
   * 合入：版本图节点 uri 版本段改写为 baseline、metadata.source=baseline，替换同 chunk 的
   * baseline 节点；版本图边端点按同一映射改写后并入基线图（同 src/dst/rel 合并）；
   * 按声明键所有权删除被取代的基线边，旧格式沿用 owned-scope；端点悬空的边丢弃。
   * 只写基线图；版本图文件保留不改。
   */
  mergeIntoBaseline(version: string): void {
    const baseline = this.load();
    const vgraph = readGraph(this.graphPath(version));

    const promoted = new Map<string, Spec>(); // chunk_id → 提升后节点
    for (const spec of vgraph.specs) {
      promoted.set(spec.chunk_id, {
        ...spec,
        uri: makeUri(spec.chunk_id, BASELINE, spec.file),
        version: BASELINE,
        metadata: baselineMetadata(spec.metadata),
      });
    }
    const nodes = new Map<string, Spec>();
    for (const spec of baseline.specs) {
      if (!promoted.has(spec.chunk_id)) {
        nodes.set(spec.chunk_id, { ...spec, metadata: baselineMetadata(spec.metadata) });
      }
    }
    for (const [chunkId, spec] of promoted) nodes.set(chunkId, spec);

    const baseKnown = uriToChunkMap(baseline);
    const verKnown = uriToChunkMap(vgraph);
    const isOverridden = baselineEdgeOverrides(baseline, vgraph);
    const edges: GraphEdge[] = [];
    const take = (e: GraphEdge, known: ReadonlyMap<string, string>, fromBaseline: boolean): void => {
      const s = chunkOfUri(e.src, known);
      const d = chunkOfUri(e.dst, known);
      if (s === null || d === null) return;
      const sNode = nodes.get(s);
      const dNode = nodes.get(d);
      if (sNode === undefined || dNode === undefined) return; // 悬空丢弃
      if (fromBaseline && isOverridden(e, s, d)) return; // 被版本侧明确取代
      mergeEdge(edges, { ...e, src: sNode.uri, dst: dNode.uri });
    };
    for (const e of baseline.edges) take(e, baseKnown, true);
    for (const e of vgraph.edges) take(e, verKnown, false);

    writeGraph(this.graphPath(BASELINE), {
      version: baseline.version,
      updated: baseline.updated,
      specs: [...nodes.values()],
      edges,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 组合视图
// ─────────────────────────────────────────────────────────────

export class CombinedView {
  readonly nodes: ReadonlyMap<string, ViewNode>;
  private readonly edges: readonly ViewEdge[];
  private readonly outIndex = new Map<string, ViewEdge[]>();
  private readonly inIndex = new Map<string, ViewEdge[]>();

  constructor(nodes: ReadonlyMap<string, ViewNode>, edges: readonly ViewEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
    for (const e of edges) {
      const out = this.outIndex.get(e.src);
      if (out) out.push(e);
      else this.outIndex.set(e.src, [e]);
      const inc = this.inIndex.get(e.dst);
      if (inc) inc.push(e);
      else this.inIndex.set(e.dst, [e]);
    }
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  edgesFrom(id: string, rel?: string): ViewEdge[] {
    return (this.outIndex.get(id) ?? []).filter((e) => rel === undefined || e.rel === rel);
  }

  edgesTo(id: string, rel?: string): ViewEdge[] {
    return (this.inIndex.get(id) ?? []).filter((e) => rel === undefined || e.rel === rel);
  }
}

/**
 * baseline∪version 组合视图（随取随算，不持久化）：节点按 chunk_id 坍缩、版本侧覆盖 baseline；
 * rename 式 modify 把 baseline 端点重定向到替换后的 id；边端点映射到 chunk_id，悬空丢弃；
 * 新格式按声明键所有权覆盖基线声明边，旧格式沿用 owned-scope；
 * 同 (src,dst,rel) 去重（先到者保留）。版本图不存在时退化为 baseline 视图。
 */
export function combinedView(root: ProjectRoot, version?: string): CombinedView {
  const store = new SpecGraphStore(root);
  const indexes = new IndexManager(root);
  const baseline = store.load();

  let vgraph: SpecGraph | null = null;
  let vindex: VersionIndexLike | null = null;
  if (version !== undefined && version !== BASELINE) {
    const vPath = ensureWithin(root.root, path.join(root.meta, `specgraph-${version}.yaml`));
    if (fs.existsSync(vPath)) {
      vgraph = store.load(version);
      vindex = loadVersionIndexOrEmpty(indexes, version);
    }
  }

  // rename 式 modify：overrides(旧 id) → 新 id
  const overrides = new Map<string, string>();
  if (vgraph !== null && vindex !== null) {
    const versionIds = new Set(vgraph.specs.map((s) => s.chunk_id));
    for (const entry of vindex.chunks) {
      if (
        entry.action === "modify" &&
        entry.overrides &&
        entry.overrides !== entry.id &&
        versionIds.has(entry.id)
      ) {
        overrides.set(entry.overrides, entry.id);
      }
    }
  }

  // 摘要来源：基线索引与版本索引（版本侧同 id 多条记录时取最后写入者）
  const baseSummary = new Map<string, string | null>();
  for (const entry of indexes.loadBaseline().chunks) {
    baseSummary.set(entry.id, entry.summary ?? null);
  }
  const verSummary = new Map<string, string | null>();
  for (const entry of vindex?.chunks ?? []) {
    verSummary.set(entry.id, entry.summary ?? null);
  }

  const docReader = makeDocReader(root, vgraph !== null ? version : undefined);

  const nodes = new Map<string, ViewNode>();
  const place = (spec: Spec, versionSide: boolean): void => {
    const summary = versionSide
      ? (verSummary.get(spec.chunk_id) ?? baseSummary.get(spec.chunk_id) ?? null)
      : (baseSummary.get(spec.chunk_id) ?? null);
    const node: ViewNode = {
      chunk_id: spec.chunk_id,
      type: normalizeType(spec.type, spec.chunk_id, spec.file),
      version: spec.version,
      file: spec.file,
      title: spec.title,
      uri: spec.uri,
      heading: spec.title,
      summary,
    };
    if (node.type === "tdd") {
      const tf = docReader(spec.chunk_id, spec.file);
      if (tf !== undefined) node.target_file = tf;
    }
    nodes.set(spec.chunk_id, node);
  };
  for (const spec of baseline.specs) {
    if (overrides.has(spec.chunk_id)) continue; // 被 rename 替换的 baseline 身份
    place(spec, false);
  }
  for (const spec of vgraph?.specs ?? []) {
    place(spec, true);
  }

  // 边：端点坍缩到 chunk_id（rename 重定向），悬空丢弃，owned-scope 覆盖，先到者去重
  const known = uriToChunkMap(baseline, ...(vgraph !== null ? [vgraph] : []));
  const endpoint = (uri: string): string | null => {
    const chunkId = chunkOfUri(uri, known);
    if (chunkId === null) return null;
    return overrides.get(chunkId) ?? chunkId;
  };
  const isOverridden = vgraph !== null ? baselineEdgeOverrides(baseline, vgraph) : null;
  const edges: ViewEdge[] = [];
  const seen = new Set<string>();
  const collect = (graph: SpecGraph, fromBaseline: boolean): void => {
    for (const e of graph.edges) {
      const src = endpoint(e.src);
      const dst = endpoint(e.dst);
      if (src === null || dst === null) continue;
      if (!nodes.has(src) || !nodes.has(dst)) continue; // 悬空：写侧校验负责
      if (fromBaseline && isOverridden?.(e, src, dst)) continue;
      const key = `${src}\t${dst}\t${e.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ src, dst, rel: e.rel, metadata: { ...e.metadata } });
    }
  };
  collect(baseline, vgraph !== null);
  if (vgraph !== null) collect(vgraph, false);

  return new CombinedView(nodes, edges);
}

function normalizeType(type: string, chunkId: string, file: string): SpecType {
  return type === "prd" || type === "fsd" || type === "tdd" || type === "other"
    ? type
    : specType(chunkId, file);
}

/**
 * TDD target_file 读取器：读该 chunk 所在文档（版本工作区 versions/<v>/ 优先、否则 docs/），
 * 经 chunk-parser 定位 chunk 后 extractTargetFile。任何读取/解析失败 → undefined（不报错）。
 */
function makeDocReader(
  root: ProjectRoot,
  version: string | undefined,
): (chunkId: string, file: string) => string | undefined {
  const cache = new Map<string, ParsedFile | null>();
  const parse = (abs: string, baseDir: string): ParsedFile | null => {
    if (cache.has(abs)) return cache.get(abs) ?? null;
    let parsed: ParsedFile | null = null;
    try {
      if (fs.existsSync(abs)) parsed = parseFile(abs, baseDir);
    } catch {
      parsed = null;
    }
    cache.set(abs, parsed);
    return parsed;
  };
  return (chunkId, file) => {
    if (!file) return undefined;
    const candidates: Array<[string, string]> = [];
    if (version !== undefined) {
      const vdir = path.join(root.root, "versions", version);
      candidates.push([path.join(vdir, `${file}.md`), vdir]);
    }
    candidates.push([path.join(root.docs, `${file}.md`), root.docs]);
    for (const [abs, baseDir] of candidates) {
      const chunk = parse(abs, baseDir)?.chunks.find((c) => c.id === chunkId);
      if (chunk !== undefined) return extractTargetFile(chunk.content);
    }
    return undefined;
  };
}
