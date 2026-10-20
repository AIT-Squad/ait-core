/**
 * [TDD]-version_manager — 版本生命周期：创建/提交/状态/confirm/回滚与 phase 机。
 *
 * 边界（硬约束）：
 * - 一次一个开放版本：activeVersion 非空再 create → ACTIVE_VERSION_EXISTS；
 * - confirm 纯校验：docs 零落盘，`.meta` 只写**本版本元数据**（confirmed_plan、
 *   code_result、recovery_journal=null）；已合入版本的元数据只读；
 * - 真实文档/索引/原始图一致性只读校验，六不变式与正文契约委托 new_model validator；
 * - 治理与回执在验收前后核验，确认指纹包含策略、交付、回执与实际制品状态；
 * - 制品验收：exit≠0 → ACCEPTANCE_FAILED；未配置跳过=真空通过；配置损坏
 *   CONFIG_UNREADABLE 拒而不放（foundation ConfigUnreadableError 直接上抛）；
 * - merge 的执行归 merge_engine（本文件只产出计划与指纹）；
 * - 不判定文档合法性、不解析文档内容（只按 doc_model 解析器取 chunk 正文）；
 * - 取正文的三类根因不得归并：文件缺失 / 文件内无该 chunk → MERGE_SOURCE_MISSING；
 *   文件存在但解析失败（如重复 chunk id）→ CHUNK_PARSE_ERROR 带文件与行列，原样上抛；
 * - 宿主 git 操作经子进程，失败不吞；宿主非 git 仓 code_result=null，其余语义不变；
 * - merged 版本 revert：只读预检零写入 → 写补偿基准（recovery_journal）→ 双仓
 *   reset（任一失败恢复操作前 HEAD）→ 清理后续版本 → 校验双仓 clean 且锚点达成。
 *
 * 持久化布局（与 Python 版 ait 当前形态一致，doc-model schema 为权威）：
 * - 版本元数据：`.meta/versions/<v>.yaml`（VersionMetaSchema，含 `version` 字段）；
 * - 变更记录：`.meta/changes/chg-NNN.yaml`（ChangeRecordSchema，一条一文件，全仓
 *   共享编号空间，编号按数值最大值+1、至少三位补零）；
 * - 版本索引：`.meta/chunks-index-<v>.yaml`；版本图：`.meta/specgraph-<v>.yaml`；
 * - 确认计划：**版本元数据的 `confirmed_plan` 字段**（ReconciliationPlanSchema），
 *   不写 `plan-<v>.yaml`、`changes-<v>.yaml` 这类 Python 不认识的独立文件。
 *
 * 本模块 import 零副作用；一切 IO 只发生在方法调用内。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { ProjectRoot } from "../foundation/root.js";
import { ensureWithin, toPosixRel } from "../foundation/io.js";
import { loadModel, saveModel } from "../foundation/yaml.js";
import { loadAcceptanceCommand } from "../foundation/config.js";
import { normalize } from "../foundation/hash.js";
import { parseFile, parseText, type Chunk, type ParsedFile } from "../doc-model/chunk-parser.js";
import {
  ChangeRecordSchema,
  RecoveryJournalSchema,
  VersionIndexSchema,
  VersionMetaSchema,
  type Action,
  type ChangeRecord,
  type ChangeType,
  type GenerationVerification,
  type ReconciliationOperation,
  type ReconciliationPlan,
  type RecoveryJournal,
  type VersionChunkEntry,
  type VersionIndex,
  type VersionMeta,
  type VersionPhase,
} from "../doc-model/schemas.js";
import {
  IndexManager,
  VersionIndexError,
  type VersionIndexStats,
} from "../indexing/index-manager.js";
import {
  CombinedView, SpecGraphStore, combinedView, extractTargetFile, makeUri, specType,
  type ViewNode,
} from "../specgraph/graph-model.js";
import { scanContentRelations, scanPrdRequirementContract, validateInvariants } from "../new-model/validator.js";
import { evaluateGovernance, governancePolicyFingerprint, type GovernanceFinding } from "../new-model/governance.js";
import { generationFingerprint, verifyGenerationReceipts } from "../orchestration/generation-receipts.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 版本索引统计（{total_chunks, by_action, by_state, tasks_summary}）的兼容别名。 */
export type ChunkStateSummary = VersionIndexStats;

/** 冲突策略取值（ReconciliationPlanSchema 的 conflict_policy 枚举）。 */
export type ConflictPolicy = ReconciliationPlan["conflict_policy"];

export interface AcceptanceOutcome {
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
}

export interface ConfirmResult {
  version: string;
  passed: true;
  plan_fingerprint: string;
  planned_operations: number;
  conflict_policy: string;
  acceptance: AcceptanceOutcome;
  generation_receipts: GenerationVerification;
  warnings: GovernanceFinding[];
  code_result: string | null;
}

export interface RevertResult {
  version: string;
  reverted: true;
  mode: "unmerged" | "merged";
  docs_anchor: string | null;
  host_anchor: string | null;
  removed_versions: string[];
}

/** backfill-tags 的跳过原因（四类，互斥且穷尽）。 */
export type BackfillSkipReason =
  | "no_anchor"
  | "tag_present"
  | "no_docs_commit"
  | "tag_failed";

export interface BackfillSkip {
  version: string;
  reason: BackfillSkipReason;
}

export interface BackfillRevertTagsResult {
  backfilled: string[];
  skipped: BackfillSkip[];
  git: "committed" | "unavailable";
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type VersionManagerErrorCode =
  | "ACTIVE_VERSION_EXISTS"
  | "VERSION_NOT_FOUND"
  | "COMMIT_EMPTY"
  | "INVARIANT_VIOLATION"
  | "SPEC_CONTENT_MISMATCH"
  | "MARKDOWN_CONTAINS_RELATION"
  | "PRD_REQUIREMENT_CONTRACT_VIOLATION"
  | "GENERATION_RECEIPTS_FAILED"
  | "MODIFY_RENAME_COLLISION"
  | "DUPLICATE_OVERRIDES_TARGET"
  | "ACCEPTANCE_FAILED"
  | "MERGE_TARGET_MISSING"
  | "MERGE_SOURCE_MISSING"
  | "CHUNK_PARSE_ERROR"
  | "REVERT_PRECHECK_FAILED"
  | "REVERT_FAILED"
  | "GIT_FAILED"
  | "USAGE_ERROR";

export class VersionManagerError extends Error {
  readonly code: VersionManagerErrorCode;

  constructor(code: VersionManagerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VersionManagerError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 内部辅助：小工具（不导出）
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 读文件原始文本；不存在返回 null（缺失是合法态，不抛）。 */
function readTextOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * 用 schema 归一一个字面量（补齐 opt() 默认值并校验）——版本元数据/索引/变更记录的
 * 唯一构造通道，保证落盘形态与 schema 默认值一致。
 */
function parseWithDefaults<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(value) as z.infer<S>;
}

/** action → 变更记录 type（大写）。 */
function changeTypeOf(action: Action): ChangeType {
  return action.toUpperCase() as ChangeType;
}

/**
 * 版本是否已合入：硬约束按 `merged_at` 判定（已合入版本只按 merged_at 判定，
 * 不要求其它字段齐全）；phase=merged 一并视为已合入。
 */
function isMerged(meta: VersionMeta): boolean {
  return meta.merged_at !== null || meta.phase === "merged";
}

// ---------------------------------------------------------------------------
// 版本工作区 / 基线文件读取（不导出）
// ---------------------------------------------------------------------------

/** 版本工作区某文件绝对路径：`.md` 存盘，索引中 file 不含扩展名。 */
function workspaceFile(root: ProjectRoot, version: string, file: string): string {
  const name = file.endsWith(".md") ? file : `${file}.md`;
  return ensureWithin(root.root, path.join(root.root, "versions", version, name));
}

/** 基线文档某文件绝对路径（file 为 docs/ 下的 posix 相对路径，不含扩展名）。 */
function baselineFile(root: ProjectRoot, file: string): string {
  const name = file.endsWith(".md") ? file : `${file}.md`;
  return ensureWithin(root.docs, path.join(root.docs, name));
}

/**
 * 读取某文件内指定 chunk 的正文，三种根因严格区分（不得归并）：
 *
 * - 文件不存在 → null（调用方按 MERGE_SOURCE_MISSING）；
 * - 文件存在但其中无该 chunk → null（同上）；
 * - 文件存在但解析失败（如重复 chunk id）→ **ChunkParseError 原样上抛**，其自带
 *   `code=CHUNK_PARSE_ERROR`、`file`（相对 baseDir 的 posix 路径）与 `line` 行号，
 *   调用方不得把它吞成 null 再报成"源缺失"。
 *
 * 文件只读一次并以文本解析：避免先探存在、再按路径重读之间文件消失造成根因错判。
 */
function chunkContent(absPath: string, chunkId: string, baseDir: string): string | null {
  const text = readTextOrNull(absPath);
  if (text === null) return null;
  const parsed = parseText(text, toPosixRel(baseDir, absPath));
  return parsed.chunks.find((c) => c.id === chunkId)?.content ?? null;
}

// ---------------------------------------------------------------------------
// buildReconciliation / inputFingerprint（confirm 与 merge 共用，导出）
// ---------------------------------------------------------------------------

/** 同 id 多条版本记录取最新：committed 中 commit_id 数值最大者，否则写入序最后者。 */
function commitOrdinal(commitId: string | null): number {
  if (commitId === null) return -1;
  const m = /(\d+)(?!.*\d)/.exec(commitId);
  return m === null ? -1 : Number(m[1]);
}

/** committed 条目按 id 分组，同 id 取最新（commit_id 数值最大）；返回 id 首次出现序的数组。 */
function latestCommitted(entries: readonly VersionChunkEntry[]): VersionChunkEntry[] {
  const picked = new Map<string, VersionChunkEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.state !== "committed") continue;
    const prev = picked.get(entry.id);
    if (prev === undefined) {
      order.push(entry.id);
      picked.set(entry.id, entry);
      continue;
    }
    if (commitOrdinal(entry.commit_id) >= commitOrdinal(prev.commit_id)) {
      picked.set(entry.id, entry);
    }
  }
  return order.map((id) => picked.get(id) as VersionChunkEntry);
}

/** 解析基线文件为指纹用的 {file, header, chunks:[{id,content}]}；文件缺失按空文件。 */
function baselineFingerprintFile(
  root: ProjectRoot,
  file: string,
): { file: string; header: string; chunks: { id: string; content: string }[] } {
  const abs = baselineFile(root, file);
  const text = readTextOrNull(abs);
  if (text === null) {
    return { file, header: "", chunks: [] };
  }
  const parsed = parseFile(abs, root.docs);
  return {
    file,
    header: parsed.fileHeader,
    chunks: parsed.chunks.map((c) => ({ id: c.id, content: c.content })),
  };
}

/** 图文件文本；缺失返回空串（缺失是合法判定输入态）。 */
function graphText(p: string): string {
  return readTextOrNull(p) ?? "";
}

/** 基线 chunk id → 基线条目（file 等）。 */
function baselineById(root: ProjectRoot): Map<string, { file: string }> {
  const map = new Map<string, { file: string }>();
  for (const entry of new IndexManager(root).loadBaseline().chunks) {
    map.set(entry.id, { file: entry.file });
  }
  return map;
}

function loadVersionIndexOrThrow(root: ProjectRoot, id: string): VersionIndex {
  return new IndexManager(root).loadVersionIndex(id);
}

/**
 * override 冲突前置校验（与 Python `_assert_no_override_conflicts` 同规则）：
 *
 * - modify 改名：`id !== overrides` 且 `id` 已存在于基线——合并会产生重复 `@id`
 *   → MODIFY_RENAME_COLLISION；
 * - 两条记录（modify/delete）有效目标 `overrides ?? id` 相同且持有者不同——后者会
 *   静默覆盖前者 → DUPLICATE_OVERRIDES_TARGET。
 *
 * 只读判定，失败零落盘；add 记录不参与（其 target_id 合并时归一为 null）。
 */
function assertNoOverrideConflicts(
  records: readonly VersionChunkEntry[],
  baseline: ReadonlyMap<string, { file: string }>,
): void {
  const owners = new Map<string, string>();
  for (const record of records) {
    if (record.action !== "modify" && record.action !== "delete") continue;
    const overrides =
      typeof record.overrides === "string" && record.overrides !== "" ? record.overrides : null;
    const target = overrides ?? record.id;
    if (
      record.action === "modify" &&
      overrides !== null &&
      record.id !== overrides &&
      baseline.has(record.id)
    ) {
      throw new VersionManagerError(
        "MODIFY_RENAME_COLLISION",
        `modify 改名撞已存在 baseline id: '${record.id}'(overrides '${overrides}') —— 合并会产生重复 @id`,
      );
    }
    const owner = owners.get(target);
    if (owner !== undefined && owner !== record.id) {
      throw new VersionManagerError(
        "DUPLICATE_OVERRIDES_TARGET",
        `两条记录撞同一 override 目标 '${target}': '${owner}' 与 '${record.id}' —— 后者会静默覆盖前者`,
      );
    }
    owners.set(target, record.id);
  }
}


/** 只读核对实际文档、索引与原始图；不借 sync 或组合视图过滤修复输入。 */
export function assertSpecIntegrity(root: ProjectRoot, version: string): void {
  const indexes = new IndexManager(root);
  const baseline = new Map(indexes.loadBaseline().chunks.map((entry) => [entry.id, entry]));
  const index = indexes.loadVersionIndex(version);
  const meta = loadModel(
    ensureWithin(root.root, path.join(root.meta, "versions", version + ".yaml")),
    VersionMetaSchema,
  );
  function mismatch(message: string): never {
    throw new VersionManagerError("SPEC_CONTENT_MISMATCH", message);
  }
  if (index.version_name !== version || meta.version !== version) {
    mismatch("版本元数据或索引的版本名不一致：" + version);
  }
  assertNoOverrideConflicts(latestCommitted(index.chunks), baseline);

  // 与索引查询一致：committed > staged > working；committed 按提交编号取最新。
  const records = new Map<string, VersionChunkEntry>();
  for (const state of ["working", "staged"] as const) {
    for (const entry of index.chunks) if (entry.state === state) records.set(entry.id, entry);
  }
  for (const entry of latestCommitted(index.chunks)) records.set(entry.id, entry);
  const renamed = new Map<string, string>();
  const deleted = new Set<string>();
  type Source = { file: string; heading: string | null; level: number | null; versionSide: boolean };
  const effective = new Map<string, Source>();
  for (const entry of baseline.values()) effective.set(entry.id, { ...entry, versionSide: false });
  for (const entry of records.values()) {
    const target = entry.overrides || entry.id;
    if (entry.action === "delete") {
      deleted.add(target);
      deleted.add(entry.id);
      effective.delete(target);
      effective.delete(entry.id);
    } else {
      if (entry.action === "modify" && target !== entry.id) {
        renamed.set(target, entry.id);
        effective.delete(target);
      }
      const file = entry.file ?? baseline.get(target)?.file;
      if (!file) mismatch("版本索引缺少 chunk 来源文件：" + entry.id);
      effective.set(entry.id, {
        file, heading: entry.heading, level: entry.level, versionSide: true,
      });
    }
  }

  const fileKey = (file: string): string => file.replace(/\\/g, "/").replace(/\.md$/, "");
  type Actual = { chunk: Chunk; parsed: ParsedFile; file: string };
  const scan = (baseDir: string, versionSide: boolean): Map<string, Actual> => {
    const actual = new Map<string, Actual>();
    const pending = ["prd", "fsd", "tdd"].map((kind) => path.join(baseDir, kind));
    while (pending.length > 0) {
      const dir = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        const abs = ensureWithin(baseDir, path.join(dir, entry.name));
        if (entry.isDirectory()) {
          pending.push(abs);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const parsed = parseFile(abs, baseDir);
        const file = fileKey(parsed.file);
        for (const chunk of parsed.chunks) {
          const inherited = versionSide && !records.has(chunk.id);
          const declared = versionSide
            ? records.get(chunk.id) ?? baseline.get(chunk.id) : baseline.get(chunk.id);
          const declaredFile = declared?.file ??
            (versionSide ? baseline.get(records.get(chunk.id)?.overrides || chunk.id)?.file : undefined);
          if (declared === undefined || declaredFile === undefined ||
            fileKey(declaredFile) !== file || actual.has(chunk.id)) {
            mismatch("文档 chunk 与索引归属不一致：" + abs + "#" + chunk.id);
          }
          if (inherited) {
            const original = actualBase.get(chunk.id);
            if (original === undefined || original.file !== file ||
              normalize(original.chunk.content) !== normalize(chunk.content)) {
              mismatch("版本文档中未登记的 baseline chunk 已被修改：" + abs + "#" + chunk.id);
            }
          }
          actual.set(chunk.id, { chunk, parsed, file });
        }
      }
    }
    return actual;
  };
  const actualBase = scan(root.docs, false);
  const actualVersion = scan(ensureWithin(root.root, path.join(root.root, "versions", version)), true);

  const store = new SpecGraphStore(root);
  const graphs = [store.load(), store.load(version)];
  const specs = new Map(graphs.flatMap((graph) => graph.specs).map((spec) => [spec.uri, spec]));
  const endpointSpec = (uri: string) => {
    const exact = specs.get(uri);
    if (exact !== undefined) return exact;
    // sync 可移除从 baseline 物化的版本节点，但已保存的边仍引用其版本 URI。
    const parts = /^spec:([^:]+):([^:]+):(.+)$/.exec(uri);
    if (parts === null || (parts[2] !== "baseline" && parts[2] !== version)) return undefined;
    return [...specs.values()].find((spec) => spec.chunk_id === parts[3] &&
      makeUri(spec.chunk_id, parts[2]!, spec.file) === uri);
  };
  const endpointViolations: string[] = [];
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      for (const uri of [edge.src, edge.dst]) {
        const spec = endpointSpec(uri);
        const id = spec?.chunk_id;
        if (id !== undefined && deleted.has(id)) continue;
        if (id === undefined || !effective.has(renamed.get(id) ?? id)) {
          endpointViolations.push("MISSING_ENDPOINT: 原始图边端点不存在：" + uri +
            "（" + edge.src + " -[" + edge.rel + "]-> " + edge.dst + "）");
        }
      }
    }
  }
  if (endpointViolations.length > 0) {
    throw new VersionManagerError("INVARIANT_VIOLATION", endpointViolations.join("\n"));
  }
  for (const [side, graph] of graphs.entries()) {
    for (const spec of graph.specs) {
      const declared = side === 0 ? baseline.get(spec.chunk_id) :
        records.get(spec.chunk_id) ?? baseline.get(spec.chunk_id);
      if (declared === undefined || spec.uri !== makeUri(spec.chunk_id, spec.version, spec.file)) {
        mismatch("原始图节点与索引或 URI 身份不一致：" + spec.uri);
      }
      if (deleted.has(spec.chunk_id)) continue;
      if (declared.file === null || fileKey(spec.file) !== fileKey(declared.file) ||
        spec.type !== specType(spec.chunk_id, declared.file) || spec.title !== declared.heading) {
        mismatch("原始图节点与索引归属不一致：" + spec.uri);
      }
    }
  }

  // 组合视图只负责既有的覆盖和边选择；节点正文从上面严格限定的来源取得。
  const view = combinedView(root, version);
  const nodes = new Map<string, ViewNode>();
  const checkedHeaders = new Set<ParsedFile>();
  const changes = new Map<string, ChangeRecord>();
  for (const changeId of meta.changes) {
    const change = loadModel(
      ensureWithin(root.root, path.join(root.meta, "changes", changeId + ".yaml")),
      ChangeRecordSchema,
    );
    if (change.version !== version) mismatch("变更记录不属于当前版本：" + changeId);
    changes.set(change.target, change);
  }
  for (const [id, source] of effective) {
    const actual = (source.versionSide ? actualVersion : actualBase).get(id);
    if (actual === undefined) {
      if (source.versionSide) {
        throw new VersionManagerError("MERGE_SOURCE_MISSING", "版本工作区缺少 chunk：" + source.file + "#" + id);
      }
      mismatch("基线文档缺少索引声明的 chunk：" + source.file + "#" + id);
    }
    const node = view.nodes.get(id);
    const { chunk, parsed, file } = actual;
    if (fileKey(source.file) !== file || source.heading !== chunk.heading || source.level !== chunk.level ||
      node === undefined || fileKey(node.file) !== file || node.heading !== chunk.heading) {
      mismatch("真实 chunk、索引与图不一致：" + source.file + "#" + id);
    }
    const kind = specType(id, source.file);
    if (kind === "prd" || kind === "fsd" || kind === "tdd") {
      const content = (checkedHeaders.has(parsed) ? "" : parsed.fileHeader + "\n") + chunk.content;
      checkedHeaders.add(parsed);
      // FSD 声明只在 create 时允许；持久化正文中的声明也必须已经剥离。
      const contentViolations = [
        ...scanContentRelations(content, kind === "fsd" ? "prd" : kind),
        ...scanPrdRequirementContract(id, chunk.content),
      ];
      if (contentViolations.length > 0) {
        const first = contentViolations[0]!;
        throw new VersionManagerError(first.code as VersionManagerErrorCode,
          source.file + "#" + id + ": " + contentViolations.map((item) =>
            kind === "fsd" ? item.message.replace("非 FSD 层（prd）正文", "已持久化 FSD 正文") : item.message,
          ).join("\n"));
      }
    }
    const target = kind === "tdd" ? extractTargetFile(chunk.content) : undefined;
    if (node.target_file !== target) mismatch("TDD target_file 与有效来源不一致：" + id);
    const change = source.versionSide && records.get(id)?.state === "committed"
      ? changes.get(source.file + "#" + id) : undefined;
    if (change !== undefined && (change.new_content === null ||
      normalize(change.new_content) !== normalize(chunk.content))) {
      mismatch("已提交 chunk 的正文与变更记录不一致：" + source.file + "#" + id);
    }
    nodes.set(id, { ...node });
  }
  const edges = [...nodes.keys()].flatMap((id) => view.edgesFrom(id))
    .filter((edge) => nodes.has(edge.src) && nodes.has(edge.dst));
  const violations = validateInvariants(new CombinedView(nodes, edges));
  if (violations.length > 0) {
    throw new VersionManagerError("INVARIANT_VIOLATION",
      "规格六不变式违例：\n" + violations.map((item) => item.code + ": " + item.message).join("\n"));
  }
}

/** 共享治理报告：block 在任何提交前拒绝，warn 只作为结果返回。 */
function checkGovernance(root: ProjectRoot, version: string): GovernanceFinding[] {
  const report = evaluateGovernance(root, version);
  if (report.violations.length > 0) {
    throw new VersionManagerError("INVARIANT_VIOLATION",
      "治理门禁失败：\n" + report.violations.map((finding) =>
        finding.code + ": " + [finding.chunkId, finding.file, finding.targetFile]
          .filter((value) => value !== undefined).join(" / ") + " — " + finding.message,
      ).join("\n"));
  }
  return report.warnings;
}

/** report 只返回诊断，block 的任一 finding 都拒绝确认。 */
function checkGenerationReceipts(root: ProjectRoot, version: string): GenerationVerification {
  const result = verifyGenerationReceipts(root, version);
  if (result.enforcement === "block" && result.findings.length > 0) {
    throw new VersionManagerError("GENERATION_RECEIPTS_FAILED",
      "生成回执核验失败：\n" + result.findings.map((finding) => finding.code + ": " + finding.message).join("\n"));
  }
  return result;
}

/**
 * reconciliation plan：版本索引 committed 条目（同 id 取最新）逐条生成操作。
 *
 * - 目标文件：`overrides ?? id` 在基线中的条目 file 优先，否则条目自身 file；
 *   两者皆无 → MERGE_TARGET_MISSING；
 * - add/modify 的 new_content 取版本工作区该 chunk 内容（缺失 → MERGE_SOURCE_MISSING）；
 *   版本工作区文件存在但解析失败（如重复 chunk id）→ CHUNK_PARSE_ERROR 带文件与行号，
 *   原样上抛、不转译为 MERGE_SOURCE_MISSING；
 * - modify 且目标不在基线 → 归一为 add、target_id=null；
 * - 按版本索引顺序保留（不做排序）。
 */
export function buildReconciliation(
  root: ProjectRoot,
  id: string,
  conflictPolicy: ConflictPolicy = "use-version",
): { plan: ReconciliationPlan } {
  const index = loadVersionIndexOrThrow(root, id);
  const baseline = baselineById(root);
  const records = latestCommitted(index.chunks);
  assertNoOverrideConflicts(records, baseline);
  const operations: ReconciliationOperation[] = [];

  for (const entry of records) {
    const targetId = typeof entry.overrides === "string" && entry.overrides !== "" ? entry.overrides : entry.id;

    const baseFile = baseline.get(targetId)?.file;
    const file = baseFile ?? entry.file ?? null;
    if (file === null || file === "") {
      throw new VersionManagerError(
        "MERGE_TARGET_MISSING",
        `chunk ${entry.id} 无目标文件（基线无 ${targetId} 条目且索引条目 file 缺失）`,
      );
    }

    let action: Action = entry.action;
    let newContent: string | null = null;
    if (action !== "delete") {
      newContent = chunkContent(
        workspaceFile(root, id, file),
        entry.id,
        path.join(root.root, "versions", id),
      );
      if (newContent === null) {
        throw new VersionManagerError(
          "MERGE_SOURCE_MISSING",
          `chunk ${entry.id} 在版本工作区取不到内容（${file}）`,
        );
      }
    }

    const targetInBaseline = baseline.has(targetId);
    let normalizedTargetId: string | null = targetId;
    if (action === "modify" && !targetInBaseline) {
      // 基线不存在目标：归一为新增（target_id 置 null），不论记录 action
      action = "add";
      normalizedTargetId = null;
    }

    operations.push({
      file,
      chunk_id: entry.id,
      action,
      target_id: normalizedTargetId,
      insert_after: entry.insert_after ?? null,
      base_hash: entry.base_hash ?? null,
      new_content: newContent,
    });
  }

  return {
    plan: { operations, input_fingerprint: "", conflict_policy: conflictPolicy },
  };
}

/**
 * 判定输入指纹：对
 * `{baseline:[涉及的基线文件按文件名排序，每个 {file, header, chunks:[{id,content}]}],
 *   operations:[归一前操作], conflict_policy, specgraph:{baseline, version}, generation, governance_policy}`
 * 做键排序的紧凑 JSON，取 sha256 小写 hex。
 */
export function inputFingerprint(
  root: ProjectRoot,
  id: string,
  operations: ReconciliationOperation[],
  conflictPolicy: ConflictPolicy,
): string {
  const baseline = baselineById(root);

  // 涉及的基线文件：全部操作的目标文件 + 基线中存在的 target_id 所属文件
  const files = new Set<string>();
  for (const op of operations) {
    files.add(op.file);
    const target = op.target_id ?? op.chunk_id;
    const baseEntry = baseline.get(target);
    if (baseEntry !== undefined) {
      files.add(baseEntry.file);
    }
  }
  const payload = {
    baseline: [...files]
      .sort(compareStr)
      .map((file) => baselineFingerprintFile(root, file)),
    operations,
    conflict_policy: conflictPolicy,
    specgraph: {
      baseline: graphText(ensureWithin(root.root, path.join(root.meta, "specgraph.yaml"))),
      version: graphText(ensureWithin(root.root, path.join(root.meta, `specgraph-${id}.yaml`))),
    },
    generation: generationFingerprint(root, id),
    governance_policy: governancePolicyFingerprint(root),
  };
  return sha256Hex(canonicalJson(payload));
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 键排序的紧凑 JSON（对象键字典序，数组保序，无空白）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// VersionManager
// ---------------------------------------------------------------------------

export class VersionManager {
  private readonly root: ProjectRoot;
  private readonly index: IndexManager;

  constructor(root: ProjectRoot) {
    this.root = root;
    this.index = new IndexManager(root);
  }

  // -------------------------------------------------------------------------
  // 公开接口
  // -------------------------------------------------------------------------

  /**
   * 创建版本：唯一开放版本（ACTIVE_VERSION_EXISTS）；版本元数据或工作区已存在
   * →USAGE_ERROR；based_on 取数值序最后一个已合入版本；写版本元数据与空版本
   * 索引（version_name、status: developing），建工作区目录。
   */
  versionCreate(id: string): {
    version: string;
    created_at: string;
    based_on: string | null;
  } {
    const active = this.activeVersion();
    if (active !== null) {
      throw new VersionManagerError(
        "ACTIVE_VERSION_EXISTS",
        `已存在开放版本 ${active}，拒绝再创建 ${id}（一次一个开放版本）`,
      );
    }
    if (fs.existsSync(this.metaPath(id)) || fs.existsSync(this.workspaceDir(id))) {
      throw new VersionManagerError(
        "USAGE_ERROR",
        `版本 ${id} 已存在（版本元数据或工作区已在磁盘上）`,
      );
    }

    let basedOn: string | null = null;
    for (const v of this.index.listVersions()) {
      if (isMerged(this.loadMeta(v))) {
        basedOn = v; // 数值序最后一个已合入版本
      }
    }

    const meta = parseWithDefaults(VersionMetaSchema, {
      version: id,
      created_at: new Date().toISOString(),
      dependencies: { based_on: basedOn },
    });
    fs.mkdirSync(this.workspaceDir(id), { recursive: true });
    this.saveMeta(id, meta);

    const index = parseWithDefaults(VersionIndexSchema, {
      version_name: id,
      status: "developing",
      chunks: [],
      commits: [],
    });
    this.saveVersionIndex(index);

    return { version: id, created_at: meta.created_at, based_on: basedOn };
  }

  /**
   * 提交：版本索引中 state∈{working,staged} 的条目逐个生成变更记录并置
   * state=committed、commit_id=c<commits.length+1>；重新保存索引后调用
   * specgraph syncVersion(id)，只同步当前版本图。无可提交条目报 COMMIT_EMPTY。
   */
  versionCommit(id: string, message = "version commit"): {
    committed: string[];
    changes: string[];
  } {
    const meta = this.loadMeta(id); // 版本不存在 → VERSION_NOT_FOUND
    const index = this.loadVersionIndex(id);

    const targets = index.chunks.filter(
      (c) => c.state === "working" || c.state === "staged",
    );
    if (targets.length === 0) {
      throw new VersionManagerError(
        "COMMIT_EMPTY",
        `版本 ${id} 无 state∈{working,staged} 的条目可提交`,
      );
    }

    const commitId = `c${index.commits.length + 1}`;
    const at = new Date().toISOString();
    const committed: string[] = [];
    const changes: string[] = [];

    for (const entry of targets) {
      let changeId: string;
      const record = this.buildChangeRecord(id, entry, message, at);
      changeId = this.nextChangeId();
      const parsed = parseWithDefaults(ChangeRecordSchema, { ...record, id: changeId });
      this.saveChangeRecord(changeId, parsed);

      entry.state = "committed";
      entry.commit_id = commitId;
      committed.push(entry.id);
      changes.push(changeId);
      meta.changes.push(changeId);
    }

    index.commits.push({
      id: commitId,
      timestamp: at,
      message,
      chunks: committed,
      req_id: null,
    });
    this.saveVersionIndex(index);
    this.saveMeta(id, meta);
    new SpecGraphStore(this.root).syncVersion(id);

    return { committed, changes };
  }

  /** 状态查询：按版本索引条目 state 分组返回 id 列表与 by_action 计数。 */
  versionStatus(id: string): {
    version: string;
    phase: VersionPhase;
    working: string[];
    staged: string[];
    committed: string[];
    by_action: Record<string, number>;
  } {
    const meta = this.loadMeta(id);
    const index = this.loadVersionIndex(id);
    const working: string[] = [];
    const staged: string[] = [];
    const committed: string[] = [];
    const byAction: Record<string, number> = {};
    for (const entry of index.chunks) {
      byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;
      if (entry.state === "working") working.push(entry.id);
      else if (entry.state === "staged") staged.push(entry.id);
      else if (entry.state === "committed") committed.push(entry.id);
    }
    return {
      version: id,
      phase: meta.phase,
      working,
      staged,
      committed,
      by_action: byAction,
    };
  }

  /**
   * confirm 门禁：已合入→拒绝；真实规格/原始图/override 校验 → 治理与回执核验
   * → 制品验收（未配置真空通过；exit≠0 ACCEPTANCE_FAILED；配置损坏拒绝）
   * → 验收后重新核验 → buildReconciliation + inputFingerprint → 版本元数据
   * `confirmed_plan`、`recovery_journal=null` → commitHostIfDirty 绑定 code_result
   * → 保存版本元数据（唯一持久化；docs 零落盘）。
   */
  async versionConfirm(id: string): Promise<ConfirmResult> {
    let meta = this.loadMeta(id);
    if (isMerged(meta)) {
      throw new VersionManagerError(
        "USAGE_ERROR",
        `版本 ${id} 已合入，confirm 只对未合入版本开放（已合入版本元数据只读）`,
      );
    }

    // ① 真实文档、索引、原始图与 override 门禁（只读，违例零落盘）。
    assertSpecIntegrity(this.root, id);

    // ② 验收前先检查治理与回执，block 时不执行验收命令。
    checkGovernance(this.root, id);
    checkGenerationReceipts(this.root, id);

    // ③ 制品验收（配置损坏由 foundation 抛 CONFIG_UNREADABLE，拒而不放）
    const acceptance = this.runAcceptance();
    if (!acceptance.passed) {
      throw new VersionManagerError(
        "ACCEPTANCE_FAILED",
        `制品验收命令 exit=${acceptance.exitCode ?? "?"}（期望 0）`,
      );
    }

    // ④ 验收可能改写制品或规格；最终状态必须重新核验，不能保存验收前快照。
    assertSpecIntegrity(this.root, id);
    const warnings = checkGovernance(this.root, id);
    const generationReceipts = checkGenerationReceipts(this.root, id);
    meta = this.loadMeta(id);

    // 最终 reconciliation plan 与判定输入指纹
    const conflictPolicy: ConflictPolicy = "use-version";
    const { plan } = buildReconciliation(this.root, id, conflictPolicy);
    const fingerprint = inputFingerprint(this.root, id, plan.operations, conflictPolicy);

    // ⑤ 制品绑定（非 git 仓 null 不报错）
    meta.code_result = this.commitHostIfDirty(id);

    // ⑥ 唯一持久化：本版本元数据
    meta.confirmed_plan = {
      operations: plan.operations,
      input_fingerprint: fingerprint,
      conflict_policy: conflictPolicy,
    };
    meta.recovery_journal = null;
    this.saveMeta(id, meta);

    return {
      version: id,
      passed: true,
      plan_fingerprint: fingerprint,
      planned_operations: plan.operations.length,
      conflict_policy: conflictPolicy,
      acceptance,
      generation_receipts: generationReceipts,
      warnings,
      code_result: meta.code_result ?? null,
    };
  }

  /**
   * 回滚：未合入→物理清空工作区/版本索引/版本图/版本元数据/本版本产生的变更记录；
   * merged→只读预检（锚点解析 + 两仓可访问，皆失败 REVERT_PRECHECK_FAILED 零写入）
   * → 写 recovery_journal{phase:"prepared"} → 双仓 reset（任一失败恢复操作前 HEAD）
   * → 清理后续版本 → 校验双仓 clean 且锚点达成。
   */
  async versionRevert(
    id: string,
    opts: { confirm: boolean },
  ): Promise<RevertResult> {
    if (opts.confirm !== true) {
      throw new VersionManagerError(
        "USAGE_ERROR",
        `revert 需显式 confirm：versionRevert(${id}, { confirm: true })`,
      );
    }
    const meta = this.loadMeta(id);

    if (!isMerged(meta)) {
      this.purgeVersionArtifacts(id, { removeChangeRecords: true });
      return {
        version: id,
        reverted: true,
        mode: "unmerged",
        docs_anchor: null,
        host_anchor: null,
        removed_versions: [],
      };
    }

    // ── 只读预检（零写入）───────────────────────────────────────────────
    const docsCwd = this.root.root;
    const hostCwd = this.root.cwd;
    if (!this.isGitRepo(docsCwd)) {
      throw new VersionManagerError(
        "REVERT_PRECHECK_FAILED",
        `docs 仓不可访问（非 git 仓）：${docsCwd}，预检失败零写入`,
      );
    }
    const hostRepo = this.isGitRepo(hostCwd);

    const docsAnchor = this.resolveAnchor(meta, { cwd: docsCwd, side: "docs", version: id });
    const hostAnchor = hostRepo
      ? this.resolveAnchor(meta, { cwd: hostCwd, side: "host", version: id })
      : null;
    if (docsAnchor === null) {
      throw new VersionManagerError(
        "REVERT_PRECHECK_FAILED",
        `版本 ${id} 的 docs 锚点不可解析（revert_anchor.docs_ref → refs/tags/ait/${id} → docs_commit ` +
          `依次 cat-file -e 均失败），预检失败零写入`,
      );
    }
    if (hostRepo && hostAnchor === null) {
      throw new VersionManagerError(
        "REVERT_PRECHECK_FAILED",
        `版本 ${id} 已绑定宿主锚点但不可解析（code_result/code_base 均 cat-file -e 失败），预检失败零写入`,
      );
    }

    const docsCurrent = this.git(docsCwd, ["rev-parse", "HEAD"]);
    const hostCurrent = hostRepo ? this.gitTry(hostCwd, ["rev-parse", "HEAD"]) : null;
    const versions = this.index.listVersions();
    const laterVersions = versions.slice(versions.indexOf(id) + 1);

    // ── 写补偿基准（recovery_journal，phase=prepared）────────────────────
    const journal: RecoveryJournal = {
      docs_head: docsCurrent,
      host_head: hostCurrent,
      docs_target: docsAnchor ?? docsCurrent,
      host_target: hostAnchor,
      later_versions: laterVersions,
      phase: "prepared",
      diagnostic: null,
    };
    meta.recovery_journal = parseWithDefaults(RecoveryJournalSchema, journal);
    this.saveMeta(id, meta);

    // ── 双仓 reset（任一失败恢复操作前 HEAD）────────────────────────────
    let docsReset = false;
    let hostReset = false;
    try {
      if (docsAnchor !== null) {
        this.git(docsCwd, ["reset", "--hard", docsAnchor]);
        docsReset = true;
      }
      if (hostAnchor !== null) {
        this.git(hostCwd, ["reset", "--hard", hostAnchor]);
        hostReset = true;
      }
    } catch (err) {
      if (docsReset) {
        try {
          this.git(docsCwd, ["reset", "--hard", docsCurrent]);
        } catch {
          // 补偿失败不掩盖原始错误
        }
      }
      if (hostReset && hostCurrent !== null) {
        try {
          this.git(hostCwd, ["reset", "--hard", hostCurrent]);
        } catch {
          // 补偿失败不掩盖原始错误
        }
      }
      throw new VersionManagerError(
        "REVERT_FAILED",
        `双仓 reset 失败，已尝试恢复操作前 HEAD：${errorMessage(err)}`,
        { cause: err },
      );
    }

    // ── 清理后续版本与本版本制品 ─────────────────────────────────────────
    // 只清后续版本（Python `to_clean = later_versions ∪ active`，不含被回滚版本本身）：
    // 被回滚版本的制品由 reset --hard 回到锚点时恢复为企业已提交状态，删了反而使工作树变脏。
    for (const v of laterVersions) {
      this.purgeVersionArtifacts(v, { removeChangeRecords: true });
    }

    // ── 校验双仓 clean 且锚点达成 ────────────────────────────────────────
    this.assertRepoState(docsCwd, docsAnchor, "docs");
    if (hostRepo) {
      this.assertRepoState(hostCwd, hostAnchor, "host");
    }

    return {
      version: id,
      reverted: true,
      mode: "merged",
      docs_anchor: docsAnchor,
      host_anchor: hostAnchor,
      removed_versions: laterVersions,
    };
  }

  /**
   * backfill-tags：为历史已合入版本补建缺失的 docs 锚点标签。
   *
   * 幂等、只读判定 + 只创建缺失标签，不改写任何版本元数据：
   * - 非 git 宿主 → `{backfilled:[], skipped:[], git:"unavailable"}`，不报错；
   * - 遍历全部已合入版本（元数据 + 索引全量扫描，不限于最末一个）：
   *   无 anchor 或 `anchor.docs_ref` 为空 → skipped(no_anchor)；
   *   `git cat-file -e <docs_ref>^{commit}` 成功 → skipped(tag_present)（重复执行为全 skipped）；
   *   无 docs_commit → skipped(no_docs_commit)；
   *   否则以 docs_commit 重建 `docs_ref` 标签：成功记入 backfilled，失败 skipped(tag_failed)。
   */
  backfillRevertTags(): BackfillRevertTagsResult {
    const docsCwd = this.root.root;
    if (!this.isGitRepo(docsCwd)) {
      return { backfilled: [], skipped: [], git: "unavailable" };
    }

    const backfilled: string[] = [];
    const skipped: BackfillSkip[] = [];
    for (const version of this.index.listVersions()) {
      const meta = this.loadMeta(version);
      if (!isMerged(meta)) continue;

      const anchor = meta.revert_anchor;
      const docsRef = anchor === null ? "" : anchor.docs_ref;
      if (docsRef === "") {
        skipped.push({ version, reason: "no_anchor" });
        continue;
      }
      if (this.gitTry(docsCwd, ["cat-file", "-e", `${docsRef}^{commit}`]) !== null) {
        skipped.push({ version, reason: "tag_present" });
        continue;
      }
      if (meta.docs_commit === null || meta.docs_commit === "") {
        skipped.push({ version, reason: "no_docs_commit" });
        continue;
      }
      // 已存在的同名 tag 不移动（git tag 非 -f）；创建后验证指向目标提交
      const name = docsRef.replace(/^refs\/tags\//, "");
      const created = this.gitTry(docsCwd, ["tag", name, meta.docs_commit]);
      const resolved =
        created === null ? null : this.gitTry(docsCwd, ["rev-parse", `${docsRef}^{commit}`]);
      if (created !== null && resolved === meta.docs_commit) {
        backfilled.push(version);
      } else {
        skipped.push({ version, reason: "tag_failed" });
      }
    }
    return { backfilled, skipped, git: "committed" };
  }

  // -------------------------------------------------------------------------
  // 内部辅助：版本枚举与存取（不导出）
  // -------------------------------------------------------------------------

  /** 活动版本：无 merged_at 且 phase≠merged 的版本（数值序首个）；无则 null。 */
  private activeVersion(): string | null {
    for (const version of this.index.listVersions()) {
      if (!isMerged(this.loadMeta(version))) {
        return version;
      }
    }
    return null;
  }

  private loadMeta(version: string): VersionMeta {
    const p = this.metaPath(version);
    try {
      return loadModel(p, VersionMetaSchema);
    } catch (err) {
      if (isEnoent(err)) {
        throw new VersionManagerError(
          "VERSION_NOT_FOUND",
          `版本元数据不存在：${version}（${p}）`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  private saveMeta(version: string, meta: VersionMeta): void {
    saveModel(this.metaPath(version), meta);
  }

  /** 版本索引：文件不存在按空索引起步（save 时 stats 自动重算）。 */
  private loadVersionIndex(version: string): VersionIndex {
    try {
      return this.index.loadVersionIndex(version);
    } catch (err) {
      if (err instanceof VersionIndexError) {
        return parseWithDefaults(VersionIndexSchema, {
          version_name: version,
          status: "developing",
          chunks: [],
          commits: [],
        });
      }
      throw err;
    }
  }

  private saveVersionIndex(index: VersionIndex): void {
    this.index.saveVersionIndex(index);
  }

  /**
   * 下一个变更记录编号：扫描 `.meta/changes/chg-*.yaml`，取文件名中可解析的
   * 最大数值 +1（至少三位补零）；不可解析的文件名跳过，绝不覆盖既有记录。
   */
  private nextChangeId(): string {
    const used = new Set<number>();
    for (const name of this.listChangeFiles()) {
      const m = /^chg-(\d+)\.yaml$/.exec(name);
      if (m === null) continue;
      used.add(Number(m[1]));
    }
    let max = 0;
    for (const n of used) {
      if (n > max) max = n;
    }
    return `chg-${String(max + 1).padStart(3, "0")}`;
  }

  /** 枚举 `.meta/changes/` 下的 chg-*.yaml 文件名；目录不存在返回空。 */
  private listChangeFiles(): string[] {
    try {
      return fs
        .readdirSync(this.changesDir())
        .filter((n) => n.startsWith("chg-") && n.endsWith(".yaml"));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  /** 变更记录文件名列表（版本元数据 `changes` 字段形态，如 `chg-001`）。 */
  private changeIdsOfMeta(version: string): string[] {
    const meta = this.loadMeta(version);
    return [...meta.changes];
  }

  /**
   * 组装一条变更记录（不含 id；id 由 nextChangeId 分配后写入）：
   * type 为 action 大写；target=`<file>#<chunk_id>`（file 缺失时取 overrides 的
   * 基线条目 file，否则 `unknown`）；base_hash/discussion_usage 取自条目；
   * new_content 为版本工作区该 chunk 内容；base_content 为基线中 `overrides`
   * 目标的内容（仅 modify/delete 且有 overrides）。
   */
  private buildChangeRecord(
    version: string,
    entry: VersionChunkEntry,
    message: string,
    at: string,
  ): Omit<ChangeRecord, "id"> {
    const overrideTarget =
      typeof entry.overrides === "string" && entry.overrides !== "" ? entry.overrides : null;
    const baseEntryFile =
      overrideTarget === null ? undefined : baselineById(this.root).get(overrideTarget)?.file;
    const file = entry.file ?? baseEntryFile ?? "unknown";

    let newContent: string | null = null;
    if (entry.action !== "delete") {
      newContent = chunkContent(
        workspaceFile(this.root, version, file),
        entry.id,
        path.join(this.root.root, "versions", version),
      );
    }

    let baseContent: string | null = null;
    if ((entry.action === "modify" || entry.action === "delete") && overrideTarget !== null) {
      const fileForBase = baseEntryFile ?? file;
      if (fileForBase !== "unknown") {
        baseContent = chunkContent(baselineFile(this.root, fileForBase), overrideTarget, this.root.docs);
      }
    }

    return {
      version,
      type: changeTypeOf(entry.action),
      target: `${file}#${entry.id}`,
      author: "system",
      date: at,
      message,
      base_hash: entry.base_hash ?? null,
      discussion_usage: entry.discussion_usage ?? null,
      base_content: baseContent,
      new_content: newContent,
    };
  }

  private saveChangeRecord(changeId: string, record: ChangeRecord): void {
    fs.mkdirSync(this.changesDir(), { recursive: true });
    saveModel(this.changeRecordPath(changeId), record);
  }

  // -------------------------------------------------------------------------
  // 内部辅助：confirm（不导出）
  // -------------------------------------------------------------------------

  /**
   * 制品验收：未配置（null）跳过=真空通过；配置损坏 CONFIG_UNREADABLE 由
   * foundation 抛出直接上抛（拒而不放）；exit≠0 由调用方报 ACCEPTANCE_FAILED。
   */
  private runAcceptance(): AcceptanceOutcome {
    const command = loadAcceptanceCommand(this.root.meta);
    if (command === null) {
      return { ran: false, passed: true, exitCode: null };
    }
    const res = spawnSync(command, {
      cwd: this.root.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    if (res.error !== undefined) {
      throw new VersionManagerError(
        "ACCEPTANCE_FAILED",
        `制品验收命令无法执行：${errorMessage(res.error)}`,
        { cause: res.error },
      );
    }
    const exitCode = res.status ?? 1;
    return { ran: true, passed: exitCode === 0, exitCode };
  }

  /**
   * 宿主制品绑定：非 git 仓 → null（不报错）；脏 → add -A + commit 后绑定新 HEAD；
   * clean → 绑定 HEAD（无 HEAD 的空仓 → null）。
   */
  private commitHostIfDirty(version: string): string | null {
    const cwd = this.root.cwd;
    if (!this.isGitRepo(cwd)) {
      return null;
    }
    const status = this.git(cwd, ["status", "--porcelain"]);
    if (status !== "") {
      this.git(cwd, ["add", "-A"]);
      this.git(cwd, ["commit", "-m", `ait: confirm ${version} 制品绑定`]);
    }
    return this.gitTry(cwd, ["rev-parse", "HEAD"]);
  }

  // -------------------------------------------------------------------------
  // 内部辅助：revert（不导出）
  // -------------------------------------------------------------------------

  /**
   * 锚点解析（按 meta 与仓侧）：docs 侧 `revert_anchor.docs_ref` → `refs/tags/ait/<v>`
   * → `docs_commit`；host 侧 `revert_anchor.code_result` → `code_base`。
   * 每个候选先 `git cat-file -e <ref>^{commit}` 验证，再 rev-parse 为 commit SHA；
   * 全部失败返回 null（只读，零写入）。
   */
  private resolveAnchor(
    meta: VersionMeta,
    opts: { cwd: string; side: "docs" | "host"; version: string },
  ): string | null {
    const { cwd, side, version } = opts;
    const candidates: string[] = [];
    const anchor = meta.revert_anchor;
    if (side === "docs") {
      if (anchor !== null) candidates.push(anchor.docs_ref);
      candidates.push(`refs/tags/ait/${version}`);
      if (meta.docs_commit !== null) candidates.push(meta.docs_commit);
    } else {
      if (anchor !== null && anchor.code_result !== null) candidates.push(anchor.code_result);
      if (meta.code_base !== null) candidates.push(meta.code_base);
    }

    for (const ref of candidates) {
      if (ref === "" ) continue;
      if (this.gitTry(cwd, ["cat-file", "-e", `${ref}^{commit}`]) === null) continue;
      const sha = this.gitTry(cwd, ["rev-parse", `${ref}^{commit}`]);
      if (sha !== null && sha !== "") {
        return sha;
      }
    }
    return null;
  }

  /** reset 后校验：锚点达成（HEAD == 目标 SHA，目标为 null 时跳过）且工作区 clean。 */
  private assertRepoState(cwd: string, anchor: string | null, label: string): void {
    if (anchor !== null) {
      const head = this.git(cwd, ["rev-parse", "HEAD"]);
      if (head !== anchor) {
        throw new VersionManagerError(
          "REVERT_FAILED",
          `${label} 仓锚点未达成：HEAD=${head}，期望 ${anchor}`,
        );
      }
    }
    const status = this.git(cwd, ["status", "--porcelain"]);
    if (status !== "") {
      throw new VersionManagerError(
        "REVERT_FAILED",
        `${label} 仓 reset 后非 clean：${status.split("\n")[0] ?? status}`,
      );
    }
  }

  /**
   * 物理清空某版本的全部制品：工作区、版本索引、版本图、版本元数据；该版本元数据
   * `changes` 列出的变更记录文件是否同清由调用方决定（只删本版本产生的记录，
   * 不触碰历史版本）：
   * - 未合入版本回滚（`removeChangeRecords: true`）——变更记录随版本一同消失，
   *   与 Python 未合入路径一致；
   * - 已合入版本回滚（`removeChangeRecords: false`）——变更记录是 docs 仓历史提交
   *   的一部分，删文件只会让工作树相对锚点变脏（Python 此路径同样不删记录，
   *   只清版本制品后 `git clean -fd versions/`）。
   */
  private purgeVersionArtifacts(
    version: string,
    opts: { removeChangeRecords: boolean },
  ): void {
    // 必读先于删除：变更记录清单取自版本元数据 `changes`，必须在删除元数据之前取到，
    // 否则读失败被吞成空清单，本版本产生的变更记录永远清不掉。
    let changeIds: string[] = [];
    if (opts.removeChangeRecords) {
      try {
        changeIds = this.changeIdsOfMeta(version);
      } catch {
        changeIds = []; // 元数据缺失：仅清其余制品
      }
    }

    fs.rmSync(this.workspaceDir(version), { recursive: true, force: true });
    for (const p of [
      this.versionIndexPath(version),
      this.versionGraphPath(version),
      this.metaPath(version),
    ]) {
      fs.rmSync(p, { force: true });
    }
    for (const changeId of changeIds) {
      fs.rmSync(this.changeRecordPath(changeId), { force: true });
    }
  }

  // -------------------------------------------------------------------------
  // 内部辅助：git 子进程封装（不导出）——失败不吞
  // -------------------------------------------------------------------------

  /**
   * git 子进程封装：非零退出/启动失败抛 GIT_FAILED（失败不吞）；stdout 去尾空白。
   * stdin 取 ignore（绝不 pipe：本实现与 git 命令均不读 stdin）。
   */
  private git(cwd: string, args: string[]): string {
    const res = this.spawnGit(cwd, args);
    if (res.error !== undefined || res.status !== 0) {
      const detail =
        typeof res.stderr === "string" && res.stderr.trim() !== ""
          ? res.stderr.trim()
          : errorMessage(res.error ?? "non-zero exit");
      throw new VersionManagerError(
        "GIT_FAILED",
        `git ${args.join(" ")} 失败（cwd=${cwd}，exit=${res.status ?? "?"}）：${detail}`,
        { cause: res.error },
      );
    }
    return typeof res.stdout === "string" ? res.stdout.trim() : "";
  }

  /** 探测型 git：成功返回 stdout（去尾空白，可为空串），失败返回 null。 */
  private gitTry(cwd: string, args: string[]): string | null {
    const res = this.spawnGit(cwd, args);
    if (res.error !== undefined || res.status !== 0) {
      return null;
    }
    return typeof res.stdout === "string" ? res.stdout.trim() : "";
  }

  /** spawnSync 封装：stdin=ignore、stdout/stderr=pipe、utf-8；启动异常不抛，经 res.error 呈现。 */
  private spawnGit(
    cwd: string,
    args: string[],
  ): ReturnType<typeof spawnSync> {
    return spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private isGitRepo(cwd: string): boolean {
    return this.gitTry(cwd, ["rev-parse", "--git-dir"]) !== null;
  }

  // -------------------------------------------------------------------------
  // 内部辅助：路径（不导出）
  // -------------------------------------------------------------------------

  private metaPath(version: string): string {
    return ensureWithin(
      this.root.root,
      path.join(this.root.meta, "versions", `${version}.yaml`),
    );
  }

  private versionIndexPath(version: string): string {
    return ensureWithin(
      this.root.root,
      path.join(this.root.meta, `chunks-index-${version}.yaml`),
    );
  }

  private versionGraphPath(version: string): string {
    return ensureWithin(
      this.root.root,
      path.join(this.root.meta, `specgraph-${version}.yaml`),
    );
  }

  private changeRecordPath(changeId: string): string {
    return ensureWithin(this.root.root, path.join(this.changesDir(), `${changeId}.yaml`));
  }

  private changesDir(): string {
    return ensureWithin(this.root.root, path.join(this.root.meta, "changes"));
  }

  private workspaceDir(version: string): string {
    return ensureWithin(
      this.root.root,
      path.join(this.root.root, "versions", version),
    );
  }
}
