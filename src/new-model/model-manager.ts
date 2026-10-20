/**
 * [TDD]-model_manager — 三层文档创建/确认/返工、四出生地建边、讨论背景与令牌、写时门禁。
 *
 * 边界（硬约束）：
 * - 讨论背景模式零写入；一切写操作先过内容闸与写时门禁（失败零落盘）；
 * - phase 严格自顶向下：fsd create 需 prd-confirm、tdd create 需 fsd-confirm；
 * - 不做 merge、不做版本三态流转之外的版本生命周期（归 versioning 域；
 *   活动版本唯一性 ACTIVE_VERSION_EXISTS 亦属 versioning 域语义，此处仅引用）；
 * - 不自行生成变更记录（归 versioning 域的提交能力）：层冻结只置相位并委托
 *   `VersionManager.versionCommit`，chg-NNN.yaml 由 versioning 域写出；
 * - 不直接读写 .meta 索引/图（委托 indexing/specgraph 域）；
 * - 不做内容生成（讨论背景只组装现状，不调用 LLM）。
 *
 * 版本图节点注册说明：TDD 要求"关系随内容创建原子出生（四出生地）"，而已有 chunk
 * 端点由 baseline 侧承载，版本图仅需登记本次出生的 chunk。本文件经 SpecGraphStore.load
 * /save 写入版本图节点（形状为 Python 当前
 * 形态：specs 为按 uri 排序的数组）；一切边的创建仍走 SpecGraphStore.addEdge，
 * 幽灵端点/重复边/baseline 物化语义留在 specgraph 域。
 *
 * 本模块 import 零副作用；一切 IO 只发生在方法调用内。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, parseDocument } from "yaml";
import type { ProjectRoot } from "../foundation/root.js";
import { atomicWriteBytes, atomicWriteText, ensureWithin, stripMdExt } from "../foundation/io.js";
import { loadModel, saveModel } from "../foundation/yaml.js";
import {
  isLegalChunkId,
  parseText,
  type Chunk,
} from "../doc-model/chunk-parser.js";
import {
  VersionMetaSchema,
  type Action,
  type DiscussionUsage,
  type Spec,
  type VersionChunkEntry,
  type VersionMeta,
  type VersionPhase,
} from "../doc-model/schemas.js";
import {
  IndexManager,
  VersionIndexError,
  type VersionIndex,
} from "../indexing/index-manager.js";
import {
  SpecGraphStore,
  combinedView,
  extractTargetFile,
  makeUri,
  specType,
  CombinedView,
  type ViewEdge,
  type ViewNode,
  type EdgeRel,
} from "../specgraph/graph-model.js";
import { VersionManager } from "../versioning/version-manager.js";
import {
  checkEdgeWrite,
  scanContentRelations,
  scanPrdRequirementContract,
  validateTargetFileUniqueness,
  type Violation,
} from "./validator.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

export type DocLayer = "prd" | "fsd" | "tdd";

export interface CreateOpts {
  parent?: string;
  content?: string;
  action?: "add" | "modify";
  contextToken?: string;
  skipContext?: boolean;
  file?: string;
  /** 根 chunk 改名：写入的 id 为被替换的基线 id。 */
  overrides?: string;
}

/** 上下文令牌绑定的意图：层级/目标/父锚点/action。 */
export interface ContextIntent {
  layer: DocLayer;
  id: string;
  parent?: string;
  action?: Action;
}

export interface SkipContextAudit {
  skip_context: true;
  at: string;
}

export interface DiscussionContextResult {
  mode: "discussion-context";
  version: string;
  layer: DocLayer;
  id: string;
  parent: string | null;
  background: string;
  context_token: string;
}

export interface EdgeRef {
  src: string;
  dst: string;
  rel: EdgeRel;
}

/** 待建边及来源标记：命令出生边 `new-model-cli`、FSD 声明边 `fsd-declaration`。 */
interface TaggedEdge extends EdgeRef {
  source: EdgeSource;
}

/** 边来源：显式来源集合（specgraph 域跨 sync 保留）。 */
type EdgeSource = string;

const EDGE_SOURCE_CLI: EdgeSource = "new-model-cli";
const EDGE_SOURCE_DECL: EdgeSource = "fsd-declaration";

export interface WrittenResult {
  mode: "written";
  layer: DocLayer;
  id: string;
  file: string;
  chunks: string[];
  edges: EdgeRef[];
  phase: VersionPhase;
  audit?: SkipContextAudit;
}

export type CreateResult = DiscussionContextResult | WrittenResult;

export interface ConfirmResult {
  version: string;
  confirmed: string[];
  phase: VersionPhase;
}

export interface RevertResult {
  version: string;
  reverted: string[];
  phase: VersionPhase;
}

export interface DecomposeWritten {
  mode: "written";
  src: string;
  dst: string;
  rel: "decomposes";
  file: string;
  phase: VersionPhase;
  audit?: SkipContextAudit;
}

export type DecomposeResult = DiscussionContextResult | DecomposeWritten;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type ModelManagerErrorCode =
  | "CONTEXT_TOKEN_INVALID"
  | "CONTEXT_TOKEN_STALE"
  | "USAGE_ERROR"
  | "NO_ACTIVE_VERSION"
  | "PRD_NOT_CONFIRMED"
  | "FSD_NOT_CONFIRMED"
  | "TDD_NOT_CONFIRMED"
  | "PRD_LAYER_NOT_OPEN"
  | "FSD_LAYER_NOT_OPEN"
  | "TDD_LAYER_NOT_OPEN"
  | "MARKDOWN_CONTAINS_RELATION"
  | "PRD_REQUIREMENT_CONTRACT_VIOLATION"
  | "TDD_TARGET_FILE_REQUIRED"
  | "ROOT_CHUNK_REQUIRED"
  | "DUPLICATE_BASELINE_CHUNK"
  | "CHUNK_LOCKED"
  | "MISSING_ENDPOINT"
  | "TDD_MULTI_PARENT"
  | "PRD_FSD_LINK_NOT_UNIQUE"
  | "DUPLICATE_TARGET_FILE"
  | "INVALID_FILE_NAME"
  | "DERIVES_NOT_PRD"
  | "FSD_DECLARATION_INVALID";

export class ModelManagerError extends Error {
  readonly code: ModelManagerErrorCode;

  constructor(code: ModelManagerErrorCode, message: string) {
    super(message);
    this.name = "ModelManagerError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 常量与纯函数内部辅助（不导出）
// ---------------------------------------------------------------------------

const LAYERS: readonly DocLayer[] = ["prd", "fsd", "tdd"];

const PHASE_ORDER: readonly VersionPhase[] = [
  "empty",
  "prd-creating",
  "prd-confirm",
  "fsd-creating",
  "fsd-confirm",
  "tdd-creating",
  "tdd-confirm",
  "merged",
];

/** create 各层允许的起始相位（下层 create 需上层已 confirm）。 */
const CREATE_PRE_PHASE: Record<DocLayer, VersionPhase> = {
  prd: "empty",
  fsd: "prd-confirm",
  tdd: "fsd-confirm",
};

const TOKEN_PREFIX = "ctx-v1.";
const TOKEN_PATTERN = /^ctx-v1\.[0-9a-f]{64}$/;

function layerTag(layer: DocLayer): string {
  return `[${layer.toUpperCase()}]`;
}

function idPrefixOf(layer: DocLayer): string {
  return `${layerTag(layer)}-`;
}

function layerOfId(id: string): DocLayer | null {
  if (id.startsWith("[PRD]-")) return "prd";
  if (id.startsWith("[FSD]-")) return "fsd";
  if (id.startsWith("[TDD]-")) return "tdd";
  return null;
}

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

interface YamlBlock {
  startLine: number;
  endLine: number;
  text: string;
  closed: boolean;
}

interface FsdDeclarations {
  derives: Map<string, string[]>;
  dependsOn: Map<string, string[]>;
  replacements: { startLine: number; endLine: number; lines: string[] }[];
}

interface PreparedFile {
  target: string;
  file: string;
  text: string;
  chunks: Chunk[];
  submitted: Chunk[];
}

/** 仅枚举最外层 YAML 围栏，闭合围栏必须与开围栏同种且不短于它。 */
function extractYamlBlocksOutsideFences(content: string): YamlBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: YamlBlock[] = [];
  let fence: { marker: string; length: number; start: number; yaml: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (fence === null) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match !== null) {
        const marker = match[1] as string;
        fence = {
          marker: marker[0] as string,
          length: marker.length,
          start: i,
          yaml: (match[2] ?? "").trim().toLowerCase() === "yaml",
        };
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close === null || close[1]?.[0] !== fence.marker || close[1].length < fence.length) {
      continue;
    }
    if (fence.yaml) {
      blocks.push({
        startLine: fence.start + 1,
        endLine: i + 1,
        text: lines.slice(fence.start + 1, i).join("\n"),
        closed: true,
      });
    }
    fence = null;
  }
  if (fence?.yaml) {
    blocks.push({
      startLine: fence.start + 1,
      endLine: lines.length,
      text: lines.slice(fence.start + 1).join("\n"),
      closed: false,
    });
  }
  return blocks;
}

function edgeKey(edge: EdgeRef): string {
  return `${edge.src}\t${edge.dst}\t${edge.rel}`;
}

function chunkRoot(id: string): string {
  return id.split(":", 1)[0] as string;
}

// ---------------------------------------------------------------------------
// NewModelManager
// ---------------------------------------------------------------------------

export class NewModelManager {
  private readonly root: ProjectRoot;
  private readonly index: IndexManager;
  private readonly graph: SpecGraphStore;
  private readonly versions: VersionManager;

  constructor(root: ProjectRoot) {
    this.root = root;
    this.index = new IndexManager(root);
    this.graph = new SpecGraphStore(root);
    this.versions = new VersionManager(root);
  }

  // -------------------------------------------------------------------------
  // 公开接口
  // -------------------------------------------------------------------------

  /**
   * 三层文档创建。无 content：讨论背景模式（零写入），返回背景 + context_token。
   * 有 content：令牌核验 → 内容闸 → 写时门禁 → 原子写入 → 建边 → 更新索引 → 推进 phase。
   */
  async createDocument(
    layer: DocLayer,
    id: string,
    opts: CreateOpts,
  ): Promise<CreateResult> {
    const checkedLayer = this.checkLayer(layer);
    this.checkMutualExclusion(opts);
    this.checkIdForLayer(checkedLayer, id);
    if (checkedLayer === "prd" && opts.parent !== undefined) {
      throw new ModelManagerError(
        "USAGE_ERROR",
        `PRD 层无父锚点：--parent 仅适用于 fsd/tdd（id=${id}）`,
      );
    }

    const intent = this.intentOf(checkedLayer, id, opts);

    if (opts.content === undefined) {
      // 讨论背景模式：零写入
      const { version, background } = this.assembleBackground(checkedLayer, id, opts.parent);
      return {
        mode: "discussion-context",
        version,
        layer: checkedLayer,
        id,
        parent: opts.parent ?? null,
        background,
        context_token: this.issueToken(intent, background),
      };
    }

    return this.writeDocument(checkedLayer, id, opts, this.parentEdge(checkedLayer, id, opts.parent));
  }

  /**
   * FSD 向下拆分：父 split 存在性与类型校验（仅 FSD split 可为父）→
   * 与 create 同路的令牌/门禁 → 原子写子 FSD + decomposes 边。
   */
  async decompose(
    parentSplit: string,
    childRootId: string,
    opts: CreateOpts,
  ): Promise<DecomposeResult> {
    this.checkMutualExclusion(opts);
    if (!parentSplit.startsWith("[FSD]-") || !parentSplit.includes(":")) {
      throw new ModelManagerError(
        "USAGE_ERROR",
        `decompose 父锚点必须是 FSD split：${parentSplit}`,
      );
    }
    this.checkIdForLayer("fsd", childRootId);
    if (childRootId.includes(":")) {
      throw new ModelManagerError(
        "USAGE_ERROR",
        `decompose 子锚点必须是 FSD 根 chunk：${childRootId}`,
      );
    }

    const intent = this.intentOf("fsd", childRootId, {
      ...(opts.action !== undefined ? { action: opts.action } : {}),
      parent: parentSplit,
    });

    if (opts.content === undefined) {
      const { version, background } = this.assembleBackground("fsd", childRootId, parentSplit);
      return {
        mode: "discussion-context",
        version,
        layer: "fsd",
        id: childRootId,
        parent: parentSplit,
        background,
        context_token: this.issueToken(intent, background),
      };
    }

    const written = this.writeDocument("fsd", childRootId, { ...opts, parent: parentSplit }, {
      src: parentSplit,
      dst: childRootId,
      rel: "decomposes",
      source: EDGE_SOURCE_CLI,
    });
    return {
      mode: "written",
      src: parentSplit,
      dst: childRootId,
      rel: "decomposes",
      file: written.file,
      phase: written.phase,
      ...(written.audit === undefined ? {} : { audit: written.audit }),
    };
  }

  /**
   * 层级冻结：phase 前置校验（XX_LAYER_NOT_OPEN）→ 层内 chunk working→committed
   * → 相位置 <layer>-confirm 并加锁 → 委托 versioning 域提交该层 working 条目。
   */
  confirmLayer(layer: string): ConfirmResult {
    const checked = this.checkLayer(layer);
    const { version, meta } = this.activeVersionMeta();
    const creating = `${checked}-creating` as VersionPhase;
    if (meta.phase !== creating) {
      throw new ModelManagerError(
        `${checked.toUpperCase()}_LAYER_NOT_OPEN` as ModelManagerErrorCode,
        `confirm 前置失败：当前相位 ${meta.phase}，期望 ${creating}`,
      );
    }
    this.validateLayer(version, checked);
    // 相位先落定：prd 层 prd_locked，fsd/tdd 层 impl_locked
    this.setLayerPhase(meta, checked, true);
    this.saveMeta(version, meta);

    // 该层 working 条目非空时才提交（提交归 versioning 域：生成变更记录、
    // 置 committed 与 commit_id、追加提交项）；无 working 条目只推进相位
    const prefix = idPrefixOf(checked);
    const index = this.loadVersionIndex(version);
    const working = index.chunks
      .filter((r) => r.id.startsWith(prefix) && r.state === "working")
      .map((r) => r.id);
    if (working.length === 0) {
      return { version, confirmed: [], phase: meta.phase };
    }
    this.versions.versionCommit(version, `${checked} layer confirm`);
    return {
      version,
      confirmed: this.layerStateIds(version, checked, "committed"),
      phase: meta.phase,
    };
  }

  /** 成对返工：层内 committed/staged 条目退回 working、清空 commit_id → 相位回退并解锁。 */
  revertLayer(layer: string): RevertResult {
    const checked = this.checkLayer(layer);
    const { version, meta } = this.activeVersionMeta();
    const confirmedPhase = `${checked}-confirm` as VersionPhase;
    if (meta.phase !== confirmedPhase) {
      throw new ModelManagerError(
        `${checked.toUpperCase()}_LAYER_NOT_OPEN` as ModelManagerErrorCode,
        `revert 前置失败：当前相位 ${meta.phase}，期望 ${confirmedPhase}`,
      );
    }
    const index = this.loadVersionIndex(version);
    const prefix = idPrefixOf(checked);
    const reverted: string[] = [];
    for (const r of index.chunks) {
      if (r.id.startsWith(prefix) && (r.state === "committed" || r.state === "staged")) {
        r.state = "working";
        r.commit_id = null;
        reverted.push(r.id);
      }
    }
    this.setLayerPhase(meta, checked, false);
    meta.generation = null;
    meta.confirmed_plan = null;
    this.withVersionTransaction(version, [], () => {
      this.index.saveVersionIndex(index);
      this.saveMeta(version, meta);
    });
    return { version, reverted, phase: meta.phase };
  }

  /** 令牌签发（FSD 能力契约形态）：绑定层级/目标/父锚点/action 与背景摘要，前缀 ctx-v1.。 */
  issueContextToken(intent: ContextIntent, background: string): string {
    return this.issueToken(intent, background);
  }

  /** 令牌核验（FSD 能力契约形态）：格式非法 CONTEXT_TOKEN_INVALID；摘要不符 CONTEXT_TOKEN_STALE。 */
  verifyContextToken(
    token: string,
    intent: ContextIntent,
    background: string,
  ): void {
    this.verifyToken(token, intent, background);
  }

  // -------------------------------------------------------------------------
  // 内部辅助：校验与相位（不导出）
  // -------------------------------------------------------------------------

  /** create/decompose 共用：所有候选计算及校验完成后，才进入有限的版本事务。 */
  private writeDocument(
    layer: DocLayer,
    id: string,
    opts: CreateOpts,
    parent: TaggedEdge | null,
  ): WrittenResult {
    const { version, meta } = this.activeVersionMeta();
    this.assertNotLocked(id);
    this.createPhaseGate(layer, meta.phase);
    if (opts.skipContext !== true) {
      this.verifyToken(opts.contextToken, this.intentOf(layer, id, opts),
        this.assembleBackground(layer, id, opts.parent).background);
    }
    if (opts.file?.includes(":")) {
      throw new ModelManagerError("INVALID_FILE_NAME", `--file 含冒号：${opts.file}`);
    }
    const action = this.effectiveAction(id, opts.action);
    const view = combinedView(this.root, version);
    const content = opts.content as string;
    const fileName = this.fileNameFor(id, opts.file);
    const sourceFile = `${layer}/${fileName}`;
    const parsed = parseText(content, sourceFile);
    this.rejectViolations(scanContentRelations(content, layer));
    const declarations = layer === "fsd"
      ? this._parseFsdDeclarations(id, content, sourceFile, parsed.chunks)
      : { derives: new Map<string, string[]>(), dependsOn: new Map<string, string[]>(), replacements: [] };
    const stripped = this._stripDeclarationBlocks(content, declarations);
    const prepared = this.prepareChunkFile(layer, version, fileName, stripped);
    const roots = new Set(prepared.chunks.map((chunk) => chunkRoot(chunk.id)));
    roots.add(chunkRoot(id));
    const hydrated = this.hydrateFsdDeclarationEdges(roots, view);
    const declarationEdges = [
      ...this._reconcileSiblingDerives(declarations.derives, hydrated),
      ...this._reconcileSiblingDependsOn(declarations.dependsOn, hydrated),
    ];
    const edges = [...declarationEdges, ...(parent === null ? [] : [parent])];
    // owned-scope 会覆盖本文件 baseline depends_on，命令出生边也必须物化保留。
    if (layer === "fsd") {
      for (const node of view.nodes.keys()) {
        if (!node.includes(":") || !roots.has(chunkRoot(node))) continue;
        for (const edge of view.edgesFrom(node, "depends_on")) {
          if (edge.metadata["source"] === EDGE_SOURCE_DECL) continue;
          edges.push({ ...edge, rel: "depends_on", source: String(edge.metadata["source"] ?? EDGE_SOURCE_CLI) });
        }
      }
    }
    const candidate = this.candidateView(view, version, id, prepared, declarations, edges, opts.overrides);
    this.contentGates(layer, id, content, parsed.chunks, candidate, sourceFile);
    const pending = this.writeGates(id, action, candidate, parsed.chunks, edges);
    const discussionUsage = this.discussionUsage(opts);

    this.withVersionTransaction(version, [prepared.target], () => {
      fs.mkdirSync(path.dirname(prepared.target), { recursive: true });
      atomicWriteText(prepared.target, prepared.text);
      this.registerVersionNodes(version, id, action, prepared.file, prepared.submitted, declarations);
      const graph = this.graph.load(version);
      const known = new Map(graph.specs.map((node) => [node.uri, node.chunk_id]));
      const existing = new Set(graph.edges.map((edge) => edgeKey({
        src: known.get(edge.src) ?? edge.src.split(":").slice(3).join(":"),
        dst: known.get(edge.dst) ?? edge.dst.split(":").slice(3).join(":"),
        rel: edge.rel as EdgeRel,
      })));
      for (const edge of pending) {
        if (existing.has(edgeKey(edge))) continue;
        this.graph.addEdge(version, edge.src, edge.dst, edge.rel, edge.source);
        existing.add(edgeKey(edge));
      }
      this.upsertVersionIndex(version, action, prepared.file, prepared.submitted, discussionUsage, opts.overrides);
      this.advancePhase(meta, layer);
      this.saveMeta(version, meta);
    });
    return {
      mode: "written", layer, id, file: prepared.file,
      chunks: prepared.submitted.map((chunk) => chunk.id), edges: pending, phase: meta.phase,
      ...(opts.skipContext === true ? { audit: { skip_context: true as const, at: new Date().toISOString() } } : {}),
    };
  }

  private rejectViolations(violations: Violation[]): void {
    const first = violations.find((violation) => violation.enforcement !== "warn");
    if (first !== undefined) {
      throw new ModelManagerError(first.code as ModelManagerErrorCode,
        `${first.message}${first.file === undefined ? "" : `（${first.file}）`}`);
    }
  }

  private candidateView(
    view: CombinedView,
    version: string,
    id: string,
    prepared: PreparedFile,
    declarations: FsdDeclarations,
    pending: TaggedEdge[],
    overrides: string | undefined,
  ): CombinedView {
    const nodes = new Map(view.nodes);
    const file = stripMdExt(prepared.file);
    if (overrides !== undefined && overrides !== id) nodes.delete(overrides);
    for (const chunk of prepared.chunks) {
      const target = extractTargetFile(chunk.content);
      const node: ViewNode = {
        chunk_id: chunk.id, type: specType(chunk.id, file), version, file,
        title: chunk.heading, heading: chunk.heading, uri: makeUri(chunk.id, version, file),
        summary: chunk.summary,
        ...(target === undefined ? {} : { target_file: target }),
      };
      nodes.set(chunk.id, node);
    }
    if (!nodes.has(id)) {
      nodes.set(id, {
        chunk_id: id, type: specType(id, file), version, file, title: id,
        heading: id, uri: makeUri(id, version, file), summary: null,
      });
    }
    const allEdges = new Map<string, ViewEdge>();
    for (const node of view.nodes.keys()) {
      for (const edge of view.edgesFrom(node)) {
        if (edge.metadata["source"] === EDGE_SOURCE_DECL &&
            ((edge.rel === "derives" && declarations.derives.has(edge.dst)) ||
             (edge.rel === "depends_on" && declarations.dependsOn.has(edge.src)))) continue;
        const replaced = {
          ...edge,
          src: edge.src === overrides ? id : edge.src,
          dst: edge.dst === overrides ? id : edge.dst,
        };
        allEdges.set(edgeKey(replaced as EdgeRef), replaced);
      }
    }
    for (const edge of pending) {
      if (!allEdges.has(edgeKey(edge))) {
        allEdges.set(edgeKey(edge), { src: edge.src, dst: edge.dst, rel: edge.rel, metadata: { source: edge.source } });
      }
    }
    return new CombinedView(nodes, [...allEdges.values()]);
  }

  /** 只快照本次版本写入集合；失败恢复原始 bytes，且报告任何恢复失败。 */
  private withVersionTransaction<T>(version: string, files: string[], operation: () => T): T {
    const targets = [...new Set([
      ...files,
      path.join(this.root.meta, `chunks-index-${version}.yaml`),
      path.join(this.root.meta, `specgraph-${version}.yaml`),
      path.join(this.root.meta, "versions", `${version}.yaml`),
    ].map((file) => ensureWithin(this.root.root, file)))];
    const originals = new Map<string, Buffer | null>();
    const newDirectories = new Set<string>();
    for (const target of targets) {
      try {
        originals.set(target, fs.readFileSync(target));
      } catch (error) {
        if (!isEnoent(error)) throw error;
        originals.set(target, null);
      }
      let directory = path.dirname(target);
      while (!fs.existsSync(directory)) {
        ensureWithin(this.root.root, directory);
        newDirectories.add(directory);
        directory = path.dirname(directory);
      }
    }
    try {
      return operation();
    } catch (originalError) {
      const restoreErrors: unknown[] = [];
      for (const [target, bytes] of [...originals].reverse()) {
        try {
          if (bytes === null) {
            if (fs.existsSync(target)) fs.unlinkSync(target);
          } else if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) {
            atomicWriteBytes(target, bytes);
          }
        } catch (error) {
          restoreErrors.push(new Error(`恢复 ${target} 失败`, { cause: error }));
        }
      }
      for (const directory of [...newDirectories].sort((a, b) => b.length - a.length)) {
        try {
          if (fs.existsSync(directory)) fs.rmdirSync(directory);
        } catch (error) {
          restoreErrors.push(new Error(`清理新建目录 ${directory} 失败`, { cause: error }));
        }
      }
      if (restoreErrors.length > 0) {
        throw Object.assign(new AggregateError([originalError, ...restoreErrors],
          "版本写入失败且恢复未完成；请检查原始错误与恢复错误", { cause: originalError }),
        { code: "PERSISTENCE_ROLLBACK_FAILED" });
      }
      throw originalError;
    }
  }

  private validateLayer(version: string, layer: DocLayer): void {
    const view = combinedView(this.root, version);
    const seen = new Set<string>();
    const index = this.loadVersionIndex(version);
    for (const entry of index.chunks) {
      if (!entry.id.startsWith(idPrefixOf(layer)) || entry.file === null || seen.has(entry.file)) continue;
      seen.add(entry.file);
      const file = ensureWithin(this.root.root, path.join(this.root.root, "versions", version,
        entry.file.endsWith(".md") ? entry.file : `${entry.file}.md`));
      const content = fs.readFileSync(file, "utf-8");
      this.rejectViolations(scanContentRelations(content, layer));
      for (const chunk of parseText(content, file).chunks) {
        const record = index.chunks.find((item) => item.id === chunk.id);
        if (record !== undefined) this.rejectViolations(scanPrdRequirementContract(chunk.id, chunk.content));
        if (layer === "tdd" && extractTargetFile(chunk.content) === undefined) {
          throw new ModelManagerError("TDD_TARGET_FILE_REQUIRED", `TDD 内容缺 target_file：${chunk.id}（${file}）`);
        }
      }
    }
    for (const node of view.nodes.keys()) {
      for (const edge of view.edgesFrom(node)) {
        if (layerOfId(edge.src) !== layer && layerOfId(edge.dst) !== layer) continue;
        if (["derives", "decomposes", "details", "depends_on"].includes(edge.rel)) {
          this.rejectViolations(checkEdgeWrite(view, edge.src, edge.dst, edge.rel as EdgeRel));
        }
      }
    }
    if (layer === "tdd") this.rejectViolations(validateTargetFileUniqueness(view));
  }

  private checkLayer(layer: string): DocLayer {
    if ((LAYERS as readonly string[]).includes(layer)) {
      return layer as DocLayer;
    }
    throw new ModelManagerError(
      "USAGE_ERROR",
      `非法层级：${layer}（期望 prd|fsd|tdd）`,
    );
  }

  private checkMutualExclusion(opts: CreateOpts): void {
    if (opts.contextToken !== undefined && opts.skipContext === true) {
      throw new ModelManagerError(
        "USAGE_ERROR",
        "--context-token 与 --skip-context 互斥，不得同现",
      );
    }
  }

  private checkIdForLayer(layer: DocLayer, id: string): void {
    if (!isLegalChunkId(id)) {
      throw new ModelManagerError("USAGE_ERROR", `非法 chunk id：${id}`);
    }
    if (layerOfId(id) !== layer) {
      throw new ModelManagerError(
        "USAGE_ERROR",
        `chunk id 层级与目标层不符：id=${id} layer=${layer}`,
      );
    }
  }

  /**
   * 层相位与锁定字段：confirm 置 `<layer>-confirm`（prd 层 prd_locked=true，
   * fsd/tdd 层 impl_locked=true）；revert 回退 `<layer>-creating` 并解锁。
   */
  private setLayerPhase(
    meta: VersionMeta,
    layer: DocLayer,
    confirmed: boolean,
  ): void {
    meta.phase = `${layer}-${confirmed ? "confirm" : "creating"}` as VersionPhase;
    if (layer === "prd") {
      meta.prd_locked = confirmed;
    } else {
      meta.impl_locked = confirmed;
    }
  }

  /** 版本索引中该层处于指定三态的条目 id（写入序）。 */
  private layerStateIds(
    version: string,
    layer: DocLayer,
    state: "working" | "staged" | "committed",
  ): string[] {
    const prefix = idPrefixOf(layer);
    return this.loadVersionIndex(version)
      .chunks.filter((r) => r.id.startsWith(prefix) && r.state === state)
      .map((r) => r.id);
  }

  /**
   * 冻结保护：同 id 已有 staged/committed 条目时拒绝重写
   * （CHUNK_LOCKED 零落盘，须先 revert 该层）。
   */
  private assertNotLocked(id: string): void {
    const { version } = this.activeVersionMeta();
    const index = this.loadVersionIndex(version);
    const locked = index.chunks.find(
      (r) => r.id === id && (r.state === "staged" || r.state === "committed"),
    );
    if (locked !== undefined) {
      throw new ModelManagerError(
        "CHUNK_LOCKED",
        `chunk ${id} 已冻结（state=${locked.state}，commit_id=${locked.commit_id ?? "null"}），` +
          `须先 revert 该层：${id}`,
      );
    }
  }

  /** 讨论令牌回执：令牌写入 → receipt，skipContext → skipped，二者皆无 → null。 */
  private discussionUsage(opts: CreateOpts): DiscussionUsage | null {
    if (opts.skipContext === true) {
      return { mode: "skipped", receipt_digest: null };
    }
    if (opts.contextToken === undefined) {
      return null;
    }
    return {
      mode: "receipt",
      receipt_digest: `sha256:${opts.contextToken.slice(TOKEN_PREFIX.length)}`,
    };
  }

  private intentOf(layer: DocLayer, id: string, opts: CreateOpts): ContextIntent {
    const intent: ContextIntent = { layer, id };
    if (opts.parent !== undefined) intent.parent = opts.parent;
    if (opts.action !== undefined) intent.action = opts.action;
    return intent;
  }

  private effectiveAction(id: string, action: Action | undefined): Action {
    if (action !== undefined) return action;
    return this.index.queryBaseline(id) !== null ? "modify" : "add";
  }

  /** 活动版本：.meta/versions 中相位非 merged 的数值序首个版本（唯一性由 versioning 域保证）。 */
  private activeVersionMeta(): { version: string; meta: VersionMeta } {
    for (const version of this.index.listVersions()) {
      const meta = this.loadMeta(version);
      if (meta.phase !== "merged") {
        return { version, meta };
      }
    }
    throw new ModelManagerError(
      "NO_ACTIVE_VERSION",
      "无活动版本（.meta/versions 中不存在相位非 merged 的版本）",
    );
  }

  private loadMeta(version: string): VersionMeta {
    const p = ensureWithin(
      this.root.root,
      path.join(this.root.meta, "versions", `${version}.yaml`),
    );
    return loadModel(p, VersionMetaSchema);
  }

  private saveMeta(version: string, meta: VersionMeta): void {
    const p = ensureWithin(
      this.root.root,
      path.join(this.root.meta, "versions", `${version}.yaml`),
    );
    saveModel(p, meta);
  }

  private loadVersionIndex(version: string): VersionIndex {
    try {
      return this.index.loadVersionIndex(version);
    } catch (err) {
      if (err instanceof VersionIndexError) {
        // 版本已活化但索引尚未落盘：按空索引起步（save 时 stats 自动重算）
        return {
          version: 1,
          scope: "version",
          version_name: version,
          based_on_hash: null,
          status: "developing",
          chunks: [],
          commits: [],
          stats: {
            total_chunks: 0,
            by_action: {},
            by_state: {},
            tasks_summary: {},
          },
        };
      }
      throw err;
    }
  }

  /** create 相位门禁：严格自顶向下，下层 create 需上层已 confirm。 */
  private createPhaseGate(layer: DocLayer, phase: VersionPhase): void {
    const pre = CREATE_PRE_PHASE[layer];
    const creating = `${layer}-creating` as VersionPhase;
    if (phase === pre || phase === creating) return;
    if (layer !== "prd") {
      const notConfirmed = (
        layer === "fsd" ? "PRD_NOT_CONFIRMED" : "FSD_NOT_CONFIRMED"
      ) as ModelManagerErrorCode;
      if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(pre)) {
        throw new ModelManagerError(
          notConfirmed,
          `${layer} create 需上层已 confirm：当前相位 ${phase}，期望 ${pre} 或 ${creating}`,
        );
      }
    }
    throw new ModelManagerError(
      `${layer.toUpperCase()}_LAYER_NOT_OPEN` as ModelManagerErrorCode,
      `${layer} 层已 confirm 锁定，不再开放 create：当前相位 ${phase}`,
    );
  }

  /** create 后推进相位：仅当仍处于本层起始相位时进入 <layer>-creating。 */
  private advancePhase(
    meta: VersionMeta,
    layer: DocLayer,
  ): { phase: VersionPhase } {
    if (meta.phase === CREATE_PRE_PHASE[layer]) {
      meta.phase = `${layer}-creating` as VersionPhase;
    }
    return { phase: meta.phase };
  }

  // -------------------------------------------------------------------------
  // 内部辅助：讨论背景与令牌（不导出）
  // -------------------------------------------------------------------------

  /**
   * 讨论背景组装（确定性输出，令牌摘要可复算）三形态：
   * - 锚定式（anchored）：给定父锚点——父节点摘要 + 既有同父子节点；
   * - 现状式（survey）：无父锚点且本层已有 chunk——本层现有 chunk 清单；
   * - 发现式（discovery）：本层为空——上层可用锚点候选。
   */
  private assembleBackground(
    layer: DocLayer,
    id: string,
    parent: string | undefined,
  ): { version: string; background: string } {
    const { version: active, meta } = this.activeVersionMeta();
    this.createPhaseGate(layer, meta.phase);
    const phase = meta.phase;
    const commits = meta.changes;
    const view = combinedView(this.root, active);
    const index = this.loadVersionIndex(active);
    const anchor = parent ?? view.edgesTo(id, "details")[0]?.src ??
      view.edgesTo(id, "decomposes")[0]?.src ??
      (view.hasNode(id) && id.includes(":") ? chunkRoot(id) : undefined);
    const lines = [
      "# 讨论背景", `- 层级: ${layer}`, `- 目标: ${id}`,
      `- 父锚点: ${anchor ?? "(无)"}`, `- 活动版本: ${active}`,
      `- 相位: ${phase}`, `- 版本提交: ${commits.join(", ") || "(无)"}`,
    ];
    const selected = new Set<string>();
    if (view.hasNode(id)) selected.add(id);
    if (anchor !== undefined) {
      lines.push("- 形态: anchored");
      if (view.hasNode(anchor)) selected.add(anchor);
      else lines.push(`- 父节点: ${anchor} — (当前不存在于视图)`);
      for (const edge of [...view.edgesFrom(anchor), ...view.edgesTo(anchor)]) {
        selected.add(edge.src);
        selected.add(edge.dst);
      }
      for (const node of view.nodes.keys()) {
        if (node.startsWith(`${chunkRoot(anchor)}:`)) selected.add(node);
      }
    } else {
      const currentLayer = [...view.nodes.keys()].filter((node) => node.startsWith(idPrefixOf(layer)));
      if (currentLayer.length > 0) {
        lines.push("- 形态: survey");
        for (const node of currentLayer) selected.add(node);
      } else {
        lines.push("- 形态: discovery");
        for (const node of view.nodes.keys()) {
          if (layer === "tdd" ? node.startsWith("[FSD]-") && node.includes(":") : node.startsWith("[PRD]-")) {
            selected.add(node);
          }
        }
      }
    }
    const upperLayer = layer === "tdd" ? "fsd" : layer === "fsd" ? "prd" : null;
    for (const entry of index.chunks) {
      if (upperLayer !== null && entry.id.startsWith(idPrefixOf(upperLayer)) && view.hasNode(entry.id)) {
        selected.add(entry.id);
      }
    }
    const queue = [...selected];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor] as string;
      const ancestors = view.edgesTo(node)
        .filter((edge) => ["derives", "decomposes", "details"].includes(edge.rel))
        .map((edge) => edge.src);
      if (node.includes(":")) ancestors.push(chunkRoot(node));
      for (const ancestor of ancestors) {
        if (!selected.has(ancestor) && view.hasNode(ancestor)) {
          selected.add(ancestor);
          queue.push(ancestor);
        }
      }
    }
    for (const chunkId of [...selected].sort((a, b) => a === id ? -1 : b === id ? 1 : a.localeCompare(b))) {
      const node = view.nodes.get(chunkId);
      if (node === undefined) continue;
      const record = index.chunks.find((entry) => entry.id === chunkId);
      const relative = record?.file ?? node.file;
      const file = relative.endsWith(".md") ? relative : `${relative}.md`;
      const candidates = [
        ensureWithin(this.root.root, path.join(this.root.root, "versions", active, file)),
        ensureWithin(this.root.root, path.join(this.root.docs, file)),
      ];
      let body: string | undefined;
      for (let position = 0; position < candidates.length; position++) {
        const source = candidates[position] as string;
        if (!fs.existsSync(source)) {
          if (position === 0 && record !== undefined) {
            throw new ModelManagerError("MISSING_ENDPOINT", `讨论背景源文件缺失：${source}（chunk=${chunkId}）`);
          }
          continue;
        }
        const content = fs.readFileSync(source, "utf-8");
        const chunk = parseText(content, source).chunks.find((item) => item.id === chunkId);
        if (chunk !== undefined) {
          body = content.split(/\r?\n/).slice(chunk.startLine - 1, chunk.endLine).join("\n");
          break;
        }
        if (position === 0 && record !== undefined) {
          throw new ModelManagerError("MISSING_ENDPOINT", `讨论背景源 chunk 缺失：${chunkId}（${source}）`);
        }
      }
      lines.push("", `## ${chunkId === id ? "目标" : "关联"}: ${chunkId}`, body ?? node.summary ?? "");
    }
    return { version: active, background: lines.join("\n") };
  }

  /** 令牌签发：ctx-v1. + SHA-256(层级/目标/父锚点/action/背景摘要) 拼装摘要。 */
  private issueToken(intent: ContextIntent, background: string): string {
    const payload = [
      "ctx-v1",
      intent.layer,
      intent.id,
      intent.parent ?? "",
      intent.action ?? "",
      sha256hex(background),
    ].join("\n");
    return TOKEN_PREFIX + sha256hex(payload);
  }

  /** 令牌核验：缺失/格式非法 → CONTEXT_TOKEN_INVALID；背景或意图已变 → CONTEXT_TOKEN_STALE。 */
  private verifyToken(
    token: string | undefined,
    intent: ContextIntent,
    background: string,
  ): void {
    if (token === undefined || !TOKEN_PATTERN.test(token)) {
      throw new ModelManagerError(
        "CONTEXT_TOKEN_INVALID",
        "上下文令牌缺失或格式非法（期望 ctx-v1.<64 hex>）",
      );
    }
    if (this.issueToken(intent, background) !== token) {
      throw new ModelManagerError(
        "CONTEXT_TOKEN_STALE",
        "上下文令牌已失效：背景或意图（层级/目标/父锚点/action）已变化，请重新获取令牌",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 内部辅助：内容闸（不导出）——失败零落盘
  // -------------------------------------------------------------------------

  /**
   * 内容闸：MARKDOWN_CONTAINS_RELATION（@ref/@extract 注释，或非 FSD 层的
   * depends_on/derives 声明块）、PRD 需求契约、TDD target_file 必填、
   * ROOT_CHUNK_REQUIRED（split 的父根 chunk 须已存在）。
   */
  private contentGates(
    layer: DocLayer,
    id: string,
    content: string,
    chunks: Chunk[],
    view: CombinedView,
    file: string,
  ): void {
    this.rejectViolations(scanContentRelations(content, layer));
    for (const chunk of chunks) {
      this.checkIdForLayer(layer, chunk.id);
      this.rejectViolations(scanPrdRequirementContract(chunk.id, chunk.content));
      if (layer === "tdd" && extractTargetFile(chunk.content) === undefined) {
        throw new ModelManagerError("TDD_TARGET_FILE_REQUIRED", `TDD 内容缺 target_file：${chunk.id}（${file}）`);
      }
    }
    if (layer === "tdd" && chunks.length === 0 && extractTargetFile(content) === undefined) {
      throw new ModelManagerError("TDD_TARGET_FILE_REQUIRED", `TDD 内容缺 target_file：${id}（${file}）`);
    }
    for (const chunkId of new Set([id, ...chunks.map((chunk) => chunk.id)])) {
      if (chunkId.includes(":") && !view.hasNode(chunkRoot(chunkId))) {
        throw new ModelManagerError("ROOT_CHUNK_REQUIRED", `创建 split ${chunkId} 需父根 chunk：${chunkRoot(chunkId)}（${file}）`);
      }
    }
  }

  /** 关系键的“未提供”与 [] 分开记录；只消费 FSD split 的顶层键。 */
  private _parseFsdDeclarations(
    rootId: string,
    content: string,
    file: string,
    chunks: Chunk[],
  ): FsdDeclarations {
    const result: FsdDeclarations = { derives: new Map(), dependsOn: new Map(), replacements: [] };
    const lines = content.split(/\r?\n/);
    for (const block of extractYamlBlocksOutsideFences(content)) {
      const owner = chunks.find((chunk) => block.startLine >= chunk.startLine && block.endLine <= chunk.endLine);
      if (owner === undefined || !owner.id.startsWith("[FSD]-") || !owner.id.includes(":")) continue;
      const document = parseDocument(block.text);
      if (!isMap(document.contents)) continue;
      const hasDerives = document.has("derives");
      const hasDependsOn = document.has("depends_on");
      if (!hasDerives && !hasDependsOn) continue;
      const fail = (message: string, relativeLine = 1, column = 1): never => {
        throw new ModelManagerError("FSD_DECLARATION_INVALID",
          `${file}:${block.startLine + relativeLine}:${column} chunk=${owner.id} root=${rootId}：${message}`);
      };
      if (!block.closed) fail("关系声明 YAML 围栏未闭合");
      const error = document.errors[0];
      if (error !== undefined) {
        fail(error.message, error.linePos?.[0]?.line ?? 1, error.linePos?.[0]?.col ?? 1);
      }
      const data = document.toJS() as Record<string, unknown>;
      for (const [key, destination] of [["derives", result.derives], ["depends_on", result.dependsOn]] as const) {
        if (!document.has(key)) continue;
        const values = data[key];
        if (!Array.isArray(values) || !values.every((value): value is string => typeof value === "string")) {
          fail(`${key} 必须是字符串数组`);
        }
        const resolved: string[] = [];
        for (const value of values as string[]) {
          if (key === "derives") {
            if (!value.startsWith("[PRD]-")) {
              throw new ModelManagerError("DERIVES_NOT_PRD", `${file}:${block.startLine} chunk=${owner.id}：derives 目标必须为 PRD：${value}`);
            }
            if (!isLegalChunkId(value)) fail(`非法 derives 目标：${value}`);
            resolved.push(value);
          } else {
            const target = this._resolveDependsOnShortName(value, chunkRoot(owner.id));
            if (target === null || target === owner.id) fail(`非法 depends_on 短名或自依赖：${value}`);
            resolved.push(target as string);
          }
        }
        destination.set(owner.id, [...new Set([...(destination.get(owner.id) ?? []), ...resolved])]);
        document.delete(key);
      }
      result.replacements.push({
        startLine: block.startLine,
        endLine: block.endLine,
        lines: document.contents.items.length === 0 ? [] : [
          lines[block.startLine - 1] as string,
          ...document.toString().trimEnd().split("\n"),
          lines[block.endLine - 1] as string,
        ],
      });
    }
    return result;
  }

  private _stripDeclarationBlocks(content: string, declarations: FsdDeclarations): string {
    if (declarations.replacements.length === 0) return content;
    const lines = content.split(/\r?\n/);
    for (const replacement of [...declarations.replacements].reverse()) {
      lines.splice(replacement.startLine - 1, replacement.endLine - replacement.startLine + 1, ...replacement.lines);
    }
    return lines.join("\n");
  }

  private _resolveDependsOnShortName(shortName: string, parentRoot: string): string | null {
    const resolved = `${parentRoot}:${shortName}`;
    return shortName.includes(":") || !isLegalChunkId(resolved) ? null : resolved;
  }

  private hydrateFsdDeclarationEdges(roots: ReadonlySet<string>, view: CombinedView): TaggedEdge[] {
    const edges: TaggedEdge[] = [];
    for (const node of view.nodes.keys()) {
      if (!node.startsWith("[FSD]-") || !node.includes(":") || !roots.has(chunkRoot(node))) continue;
      for (const edge of [...view.edgesTo(node, "derives"), ...view.edgesFrom(node, "depends_on")]) {
        if (edge.metadata["source"] === EDGE_SOURCE_DECL) {
          edges.push({ src: edge.src, dst: edge.dst, rel: edge.rel as EdgeRel, source: EDGE_SOURCE_DECL });
        }
      }
    }
    return edges;
  }

  private _reconcileSiblingDerives(declared: Map<string, string[]>, hydrated: TaggedEdge[]): TaggedEdge[] {
    return [
      ...hydrated.filter((edge) => edge.rel === "derives" && !declared.has(edge.dst)),
      ...[...declared].flatMap(([split, requirements]) => requirements.map((requirement) => ({
        src: requirement, dst: split, rel: "derives" as const, source: EDGE_SOURCE_DECL,
      }))),
    ];
  }

  private _reconcileSiblingDependsOn(declared: Map<string, string[]>, hydrated: TaggedEdge[]): TaggedEdge[] {
    return [
      ...hydrated.filter((edge) => edge.rel === "depends_on" && !declared.has(edge.src)),
      ...[...declared].flatMap(([split, siblings]) => siblings.map((sibling) => ({
        src: split, dst: sibling, rel: "depends_on" as const, source: EDGE_SOURCE_DECL,
      }))),
    ];
  }

  private parentEdge(
    layer: DocLayer,
    id: string,
    parent: string | undefined,
  ): TaggedEdge | null {
    if (parent === undefined) return null;
    if (layer === "fsd") {
      return { src: parent, dst: id, rel: "derives", source: EDGE_SOURCE_CLI };
    }
    if (layer === "tdd") {
      return { src: parent, dst: id, rel: "details", source: EDGE_SOURCE_CLI };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 内部辅助：写时门禁（不导出）——全部零落盘
  // -------------------------------------------------------------------------

  /**
   * 写时门禁：--file 冒号（INVALID_FILE_NAME）、action=add 命中 baseline 已有
   * chunk（DUPLICATE_BASELINE_CHUNK）、幽灵端点（MISSING_ENDPOINT）、TDD 第二父
   * （TDD_MULTI_PARENT）、PRD 第二 FSD（PRD_FSD_LINK_NOT_UNIQUE）、制品撞车
   * （DUPLICATE_TARGET_FILE）。返回去重后的待建边清单（已存在于视图的边幂等跳过）。
   * 全部提交端点与边在同一候选视图中交给生产 validator 校验。
   */
  private writeGates(
    id: string,
    action: Action,
    candidate: CombinedView,
    chunks: Chunk[],
    edges: TaggedEdge[],
  ): TaggedEdge[] {
    for (const submittedId of new Set([id, ...chunks.map((chunk) => chunk.id)])) {
      this.assertNotLocked(submittedId);
      if (action === "add" && this.index.queryBaseline(submittedId) !== null) {
        throw new ModelManagerError("DUPLICATE_BASELINE_CHUNK", `action=add 命中 baseline 已有 chunk：${submittedId}`);
      }
    }
    const pending = [...new Map(edges.map((edge) => [edgeKey(edge), edge])).values()];
    for (const edge of pending) {
      this.rejectViolations(checkEdgeWrite(candidate, edge.src, edge.dst, edge.rel));
    }
    this.rejectViolations(validateTargetFileUniqueness(candidate));
    return pending;
  }

  // -------------------------------------------------------------------------
  // 内部辅助：落盘与索引/图更新（不导出）
  // -------------------------------------------------------------------------

  /**
   * 目标文件名：显式 --file 优先；split create 省略 --file 时落父根文件
   * （`fsd/[FSD]-<父根>.md`），不派生含冒号文件名。
   */
  private fileNameFor(id: string, file: string | undefined): string {
    if (file !== undefined) return file;
    const colon = id.indexOf(":");
    if (colon >= 0) {
      return `${id.slice(0, colon)}.md`;
    }
    return `${id}.md`;
  }

  /**
   * 解析写入版本工作区文件：源文本优先取版本工作区同名文件，否则取基线同名文件；
   * 提交正文按 chunk id 逐条覆盖合成——正文中出现的 id 替换源文本中同 id chunk 的
   * 行区间，源文本中未出现的既有 chunk 原样保留，整体保持源顺序；正文中新增的
   * chunk 追加在末尾。因此「完整文档 replay」与「仅根 chunk」两种提交形态结果一致，
   * 均不产生重复 chunk id。此处只预计算；原子落盘在统一版本事务中执行。
   */
  private prepareChunkFile(
    layer: DocLayer,
    version: string,
    fileName: string,
    content: string,
  ): PreparedFile {
    const layerDir = path.join(this.root.root, "versions", version, layer);
    const target = ensureWithin(this.root.root, path.join(layerDir, fileName));
    const baselineFile = ensureWithin(this.root.root, path.join(this.root.docs, layer, fileName));
    let sourceText = "";
    if (fs.existsSync(target)) sourceText = fs.readFileSync(target, "utf-8");
    else if (fs.existsSync(baselineFile)) sourceText = fs.readFileSync(baselineFile, "utf-8");
    const composed = sourceText.trim() === "" ? content : composeByChunkId(sourceText, content, target);
    const text = composed.endsWith("\n") ? composed : `${composed}\n`;
    return {
      target, file: `${layer}/${fileName}`, text,
      chunks: parseText(text, target).chunks,
      submitted: parseText(content, target).chunks,
    };
  }

  /**
   * 注册版本图节点（`specgraph-<version>.yaml`，经 specgraph 域读写），使随后经
   * `addEdge` 出生的边端点可识别本次写入的 chunk。节点形态为 Python 当前形态：
   * `{uri=spec:<type>:<version>:<id>, title=heading, type, version, chunk_id, file(去 .md),
   * metadata:{source:"version", state:"working", action}}`；既有同 uri 节点按最新内容覆盖。
   */
  private registerVersionNodes(
    version: string,
    id: string,
    action: Action,
    file: string,
    chunks: Chunk[],
    declarations: FsdDeclarations,
  ): void {
    const graph = this.graph.load(version);
    const known = new Map(graph.specs.map((node) => [node.uri, node.chunk_id]));
    graph.edges = graph.edges.filter((edge) => {
      if (edge.metadata["source"] !== EDGE_SOURCE_DECL) return true;
      const src = known.get(edge.src) ?? edge.src.split(":").slice(3).join(":");
      const dst = known.get(edge.dst) ?? edge.dst.split(":").slice(3).join(":");
      return !(edge.rel === "derives" && declarations.derives.has(dst)) &&
        !(edge.rel === "depends_on" && declarations.dependsOn.has(src));
    });
    const relFile = stripMdExt(file);
    const place = (chunkId: string, heading: string): void => {
      const uri = makeUri(chunkId, version, relFile);
      const existing = graph.specs.find((node) => node.chunk_id === chunkId);
      const priorOverrides = existing?.metadata["fsd_declaration_overrides"];
      const declarationOverrides = {
        ...(priorOverrides !== null && typeof priorOverrides === "object" ? priorOverrides : {}),
        ...(declarations.derives.has(chunkId) ? { derives: true } : {}),
        ...(declarations.dependsOn.has(chunkId) ? { depends_on: true } : {}),
      };
      const node: Spec = {
        uri,
        title: heading,
        type: specType(chunkId, relFile),
        version,
        chunk_id: chunkId,
        file: relFile,
        metadata: {
          ...existing?.metadata, source: "version", state: "working", action,
          ...(chunkId.startsWith("[FSD]-") ? { fsd_declaration_overrides: declarationOverrides } : {}),
        },
      };
      const at = graph.specs.findIndex((s) => s.uri === uri);
      if (at >= 0) {
        graph.specs[at] = node;
      } else {
        graph.specs.push(node);
      }
    };
    for (const chunk of chunks) {
      place(chunk.id, chunk.heading);
    }
    // 内容可能未包含目标 chunk 本体（异常输入），兜底注册目标 id（title=id）
    if (!chunks.some((c) => c.id === id)) {
      if (!graph.specs.some((s) => s.chunk_id === id)) {
        place(id, id);
      }
    }
    this.graph.save(version, graph);
  }

  /**
   * 版本索引 upsert（与 Python `add_chunk` 一致）：同 id 已有 staged/committed 条目
   * → CHUNK_LOCKED 零落盘；同 id 已有 working 条目原地替换（保持列表位置）；否则追加。
   */
  private upsertVersionIndex(
    version: string,
    action: Action,
    file: string,
    chunks: Chunk[],
    discussionUsage: DiscussionUsage | null,
    overrides: string | undefined,
  ): void {
    const index = this.loadVersionIndex(version);
    const relFile = stripMdExt(file);
    for (const chunk of chunks) {
      const entry: VersionChunkEntry = {
        id: chunk.id,
        file: relFile,
        heading: chunk.heading,
        level: chunk.level,
        action,
        state: "working",
        commit_id: null,
        overrides: chunk.id.includes(":") ? null : overrides ?? null,
        amends: null,
        insert_after: null,
        base_hash: null,
        source_req: null,
        discussion_usage: discussionUsage,
        summary: this.summaryFor(index, chunk),
        metadata: {},
      };
      const positions = index.chunks
        .map((r, i) => (r.id === chunk.id ? i : -1))
        .filter((i) => i >= 0);
      const locked = positions.find(
        (i) => (index.chunks[i] as VersionChunkEntry).state !== "working",
      );
      if (locked !== undefined) {
        const at = index.chunks[locked] as VersionChunkEntry;
        throw new ModelManagerError(
          "CHUNK_LOCKED",
          `chunk ${chunk.id} 已冻结（state=${at.state}），拒绝重写（零落盘），须先 revert 该层`,
        );
      }
      if (positions.length > 0) {
        // 原地替换首条 working 记录（保持列表位置），其余同 id 冗余记录移除
        index.chunks[positions[0] as number] = entry;
        for (const i of positions.slice(1).reverse()) {
          index.chunks.splice(i, 1);
        }
      } else {
        index.chunks.push(entry);
      }
    }
    this.index.saveVersionIndex(index);
  }

  /**
   * 条目摘要取值链：chunk 摘要 ≤120 时取之 → 该 id 先前条目摘要 → 基线条目摘要 → null。
   * 本域只做沿用，绝不从正文/标题派生。
   */
  private summaryFor(index: VersionIndex, chunk: Chunk): string | null {
    const parsed = chunk.summary ?? "";
    if (parsed !== "" && parsed.length <= 120) {
      return parsed;
    }
    const previous = index.chunks.find((r) => r.id === chunk.id)?.summary;
    if (previous != null) {
      return previous;
    }
    return this.index.queryBaseline(chunk.id)?.summary ?? null;
  }
}

/**
 * 按 chunk id 覆盖合成（镜像 Python `_compose_fsd_content`）：
 * 遍历源文本中的 chunk（保持源顺序），正文中有同 id chunk 时以其行区间替换源行区间，
 * 否则原样保留源行区间；正文中源文本未出现的 chunk 追加在末尾。
 * 两侧文本先由 doc_model 解析；重复 id 等结构错误保持原始解析诊断。
 */
function composeByChunkId(
  sourceText: string,
  incomingText: string,
  file: string,
): string {
  const sourceLines = sourceText.split(/\r?\n/);
  const incomingLines = incomingText.split(/\r?\n/);
  const sourceChunks = parseText(sourceText, file).chunks;
  const incomingChunks = parseText(incomingText, "<written>").chunks;

  const replacement = new Map<string, Chunk>();
  for (const chunk of incomingChunks) {
    if (!replacement.has(chunk.id)) {
      replacement.set(chunk.id, chunk);
    }
  }

  const emitted = new Set<string>();
  const out: string[] = [];
  let cursor = 0;
  for (const existing of sourceChunks) {
    if (emitted.has(existing.id)) continue;
    const start = existing.startLine - 1;
    if (start < cursor) continue;
    out.push(...sourceLines.slice(cursor, start));
    const next = replacement.get(existing.id);
    if (next === undefined) {
      out.push(...sourceLines.slice(start, existing.endLine));
    } else {
      out.push(...incomingLines.slice(next.startLine - 1, next.endLine));
    }
    emitted.add(existing.id);
    cursor = existing.endLine;
  }
  out.push(...sourceLines.slice(cursor));

  for (const chunk of incomingChunks) {
    if (emitted.has(chunk.id)) continue;
    emitted.add(chunk.id);
    out.push(
      "",
      ...incomingLines.slice(chunk.startLine - 1, chunk.endLine),
    );
  }

  return out.join("\n");
}
