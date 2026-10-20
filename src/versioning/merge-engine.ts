/**
 * [TDD]-merge_engine — reconciliation plan 的原子执行与失败字节级回退。
 *
 * merge 是版本的唯一落盘点：不重新解释 plan（confirm 的判定即最终判定；
 * 用 `buildReconciliation`/`inputFingerprint` 重算仅为过期校验，执行只依据
 * 版本元数据的 `confirmed_plan.operations`），不触碰宿主仓代码（宿主提交在
 * confirm 完成，`code_base`/`code_result` 保留 confirm 绑定值）。
 *
 * 边界（硬约束）：
 * - 执行前对 docs 与 .meta 做完整字节级快照；执行阶段（applyPlan → 基线重建 →
 *   specgraph sync/mergeIntoBaseline → 元数据与版本索引 → docs 提交 → 绑定提交 →
 *   tag）任一步异常 → 字节级恢复 → MERGE_ROLLBACK（可安全重试）；
 * - 指纹校验与 plan 比对在快照与任何写入之前：不符即 CONFIRMATION_STALE，零落盘；
 *   `confirmed_plan` 为 null 即 CONFIRMATION_REQUIRED，同样零落盘；
 * - tag 创建失败不阻断（可回滚性由绑定字段 SHA 兜底），创建成功必须验证存在；
 * - docs 仓非 git：提交与 tag 跳过，commit=null、git=unavailable，不报错；
 * - 宿主仓非 git：code_base/code_result 不写入，merge 其余语义不受影响；
 * - 合入后版本工作区、版本索引、版本图**保留**（与 Python 一致，供历史查询）；
 *   只改写本版本的版本元数据与版本索引 status，不触碰其它版本的任何 .meta 文件。
 *
 * 持久化形态（v0.5 对齐 Python 版 ait）：
 * - 确认计划存于版本元数据 `confirmed_plan`（ReconciliationPlanSchema），
 *   不再有 `.meta/plan-<v>.yaml` 这类独立计划文件；
 * - 版本索引无 chunk `hash` 字段（索引不存内容哈希）；
 * - 变更记录 `chg-NNN.yaml` 由 version_manager 的 commit 产出，merge 不写；
 * - 版本锚点 tag：`refs/tags/ait/<v>`。
 *
 * 本模块 import 零副作用；一切 IO 只发生在函数调用内。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectRoot } from "../foundation/root.js";
import { atomicWriteText, ensureWithin } from "../foundation/io.js";
import { loadModel, saveModel } from "../foundation/yaml.js";
import { parseText, type ParsedFile } from "../doc-model/chunk-parser.js";
import {
  VersionMetaSchema,
  type GenerationVerification,
  type ReconciliationOperation,
  type ReconciliationPlan,
  type RevertAnchor,
  type VersionMeta,
} from "../doc-model/schemas.js";
import { IndexManager } from "../indexing/index-manager.js";
import { SpecGraphStore } from "../specgraph/graph-model.js";
import { evaluateGovernance, type GovernanceFinding } from "../new-model/governance.js";
import { verifyGenerationReceipts } from "../orchestration/generation-receipts.js";
import {
  assertSpecIntegrity,
  buildReconciliation,
  inputFingerprint,
  type ConflictPolicy,
} from "./version-manager.js";

// ---------------------------------------------------------------------------
// 公开类型与错误
// ---------------------------------------------------------------------------

export interface MergeResult {
  version: string;
  merged_chunks: string[];
  commit: string | null;
  git: "committed" | "unavailable";
  tag_created: boolean;
  plan_fingerprint: string;
  generation_receipts: GenerationVerification;
  warnings: GovernanceFinding[];
}

export class MergeError extends Error {
  readonly code:
    | "CONFIRMATION_REQUIRED"
    | "CONFIRMATION_STALE"
    | "GENERATION_RECEIPTS_FAILED"
    | "INVARIANT_VIOLATION"
    | "MERGE_ROLLBACK";

  constructor(
    code: MergeError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MergeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 内部数据模型（不导出）
// ---------------------------------------------------------------------------

interface TreeSnapshotEntry {
  /** 目标目录（docs / .meta）绝对路径。 */
  target: string;
  /** 快照副本路径；existed=false 时为 null（恢复时删除目标）。 */
  copy: string | null;
  existed: boolean;
}

interface TreeSnapshot {
  tmpDir: string;
  entries: TreeSnapshotEntry[];
}

// ---------------------------------------------------------------------------
// 纯工具（不导出）
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

function versionMetaPath(root: ProjectRoot, id: string): string {
  return ensureWithin(root.root, path.join(root.meta, "versions", `${id}.yaml`));
}

function loadVersionMeta(root: ProjectRoot, id: string): VersionMeta {
  return loadModel(versionMetaPath(root, id), VersionMetaSchema);
}

/** `refs/tags/ait/<v>` 锚点 ref 名。 */
function anchorRef(id: string): string {
  return `refs/tags/ait/${id}`;
}

/** 目标 docs 文件绝对路径（file 为 docs/ 下的 posix 相对路径，可含或不含 `.md`）。 */
function docsFilePath(root: ProjectRoot, file: string): string {
  return ensureWithin(root.docs, path.join(root.docs, `${file}.md`));
}

/** 计划文件存在性：以基线文件是否可解析为准（不存在即视为新建文件）。 */
function readBaselineFile(root: ProjectRoot, file: string): ParsedFile | null {
  const abs = docsFilePath(root, file);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return parseText(text, file);
}

// ---------------------------------------------------------------------------
// 字节级快照 / 恢复（不导出）——原子性的核心
// ---------------------------------------------------------------------------

/**
 * 对给定目录做完整字节拷贝到临时区（os.tmpdir 下 mkdtemp）。
 * 目录不存在记录 existed=false（恢复时删除目标）。
 */
function snapshotTree(dirs: string[]): TreeSnapshot {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-merge-"));
  const entries: TreeSnapshotEntry[] = [];
  for (const dir of dirs) {
    const existed = fs.existsSync(dir);
    let copy: string | null = null;
    if (existed) {
      copy = path.join(tmpDir, `snap-${entries.length}`);
      fs.cpSync(dir, copy, { recursive: true });
    }
    entries.push({ target: dir, copy, existed });
  }
  return { tmpDir, entries };
}

/**
 * 字节级回退：清空目标目录现有内容（含执行期间新增文件），
 * 再从临时区完整拷回；快照时不存在的目录直接删除。
 */
function restoreTree(snapshot: TreeSnapshot): void {
  for (const entry of snapshot.entries) {
    fs.rmSync(entry.target, { recursive: true, force: true });
    if (entry.existed && entry.copy !== null) {
      fs.cpSync(entry.copy, entry.target, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// applyPlan —— 逐文件逐 chunk 合并进 docs/（不导出）
// ---------------------------------------------------------------------------

/**
 * 合并后文件序列化："文件头 + chunk 内容以空行分隔 + 末尾换行"。
 * 与 Python `merge_engine._serialize` 同形：各部分 `rstrip` 后以空行连接、结尾补一个 `\n`。
 */
function serializeFile(fileHeader: string, chunks: readonly string[]): string {
  const parts: string[] = [];
  const header = fileHeader.replace(/\s+$/, "");
  if (header !== "") {
    parts.push(header);
  }
  for (const content of chunks) {
    parts.push(content.replace(/\s+$/, ""));
  }
  return `${parts.join("\n\n")}\n`;
}

/** chunk id → 内容（取自 operation.new_content 中同 id 的 chunk）。 */
function parseNewChunk(
  operation: ReconciliationOperation,
): { id: string; content: string } | null {
  if (operation.new_content === null) return null;
  const parsed = parseText(operation.new_content, operation.file);
  const chunk = parsed.chunks.find((c) => c.id === operation.chunk_id);
  return chunk === undefined ? null : { id: chunk.id, content: chunk.content };
}

/**
 * 单文件合并：基线 chunk 顺序为骨架，按 operation 逐条处理。
 *
 * - modify：替换 `target_id` 的 chunk 内容为 `new_content` 中同 id chunk；
 *   目标不在基线 → 归一为尾部追加（不静默丢弃）；
 * - add：按 `insert_after` 插到该基线 chunk 之后；无锚点或锚点不存在 → 追加末尾；
 *   锚点被 delete 掉 → 插入该锚点之前的最后一个存活 chunk 之后；
 * - delete：移除 `target_id`（无 override 时不删，杜绝误删）；
 * - 未列出的 chunk 原样保留（省略≠删除），文件头保留。
 */
function mergeFileInto(
  baseline: ParsedFile,
  operations: readonly ReconciliationOperation[],
): string {
  const baseIds = new Set(baseline.chunks.map((c) => c.id));

  const modifyMap = new Map<string, ReconciliationOperation>();
  const deleteSet = new Set<string>();
  const addAfterMap = new Map<string, ReconciliationOperation[]>();
  const addTail: ReconciliationOperation[] = [];
  const orphanAdds: ReconciliationOperation[] = [];

  for (const operation of operations) {
    const targetId = operation.target_id ?? operation.chunk_id;
    if (operation.action === "modify") {
      if (baseIds.has(targetId)) {
        modifyMap.set(targetId, operation);
      } else {
        addTail.push(operation); // 基线无目标 → 视为新增，追加而不丢弃
      }
    } else if (operation.action === "delete") {
      if (operation.target_id !== null) {
        deleteSet.add(operation.target_id);
      }
    } else if (operation.insert_after === null) {
      addTail.push(operation);
    } else if (baseIds.has(operation.insert_after)) {
      const bucket = addAfterMap.get(operation.insert_after);
      if (bucket === undefined) {
        addAfterMap.set(operation.insert_after, [operation]);
      } else {
        bucket.push(operation);
      }
    } else {
      orphanAdds.push(operation);
    }
  }

  // insert_after 指向的基线 chunk 在本计划中被删除 → 该 add 变孤儿，改挂其之前的存活者
  const pendingOrphans: ReconciliationOperation[] = [];
  for (const [anchor, bucket] of [...addAfterMap.entries()]) {
    if (deleteSet.has(anchor)) {
      pendingOrphans.push(...bucket);
      addAfterMap.delete(anchor);
    }
  }
  orphanAdds.push(...pendingOrphans);

  const result: string[] = [];
  let lastKeptIndex: number | null = null;
  const contentOf = (op: ReconciliationOperation): string | null =>
    parseNewChunk(op)?.content ?? null;

  for (const chunk of baseline.chunks) {
    if (deleteSet.has(chunk.id)) {
      // 锚点被删：其 add 依附最后一个存活 chunk
      if (lastKeptIndex !== null) {
        for (const op of orphanAdds.filter((o) => o.insert_after === chunk.id)) {
          const content = contentOf(op);
          if (content !== null) {
            result.push(content);
            lastKeptIndex = result.length - 1;
            orphanAdds.splice(orphanAdds.indexOf(op), 1);
          }
        }
      }
      continue;
    }

    if (modifyMap.has(chunk.id)) {
      const replaced = contentOf(modifyMap.get(chunk.id) as ReconciliationOperation);
      result.push(replaced ?? chunk.content);
      lastKeptIndex = result.length - 1;
    } else {
      result.push(chunk.content);
      lastKeptIndex = result.length - 1;
    }

    for (const op of addAfterMap.get(chunk.id) ?? []) {
      const content = contentOf(op);
      if (content !== null) {
        result.push(content);
        lastKeptIndex = result.length - 1;
      }
    }

    // 锚点不在任何基线 chunk 中的孤儿 add：依附最早出现的存活 chunk
    for (const op of orphanAdds.filter((o) => !baseIds.has(o.insert_after ?? ""))) {
      const content = contentOf(op);
      if (content !== null) {
        result.push(content);
        lastKeptIndex = result.length - 1;
        orphanAdds.splice(orphanAdds.indexOf(op), 1);
      }
    }
  }

  for (const op of addTail) {
    const content = contentOf(op);
    if (content !== null) {
      result.push(content);
    }
  }

  // 仍未落位的孤儿 add：置顶（紧随文件头之后），保证不丢内容
  for (const op of [...orphanAdds]) {
    const content = contentOf(op);
    if (content !== null) {
      result.unshift(content);
    }
  }

  return serializeFile(baseline.fileHeader, result);
}

/** 基线文件不存在：以 add 的 chunk 新建文件（非 add 操作在 confirm 端已归一）。 */
function newFileContent(
  operations: readonly ReconciliationOperation[],
): string {
  const chunks: string[] = [];
  for (const operation of operations) {
    if (operation.action !== "add") {
      continue;
    }
    const content = parseNewChunk(operation)?.content;
    if (content !== undefined) {
      chunks.push(content);
    }
  }
  return serializeFile("", chunks);
}

/**
 * 按 operation 分文件执行计划并原子写回 docs/；返回 plan 顺序的已合并 chunk id 列表。
 * 文件内 chunk 的序列化与 Python `merge_engine.execute_plan` 同形。
 */
function applyPlan(
  root: ProjectRoot,
  operations: readonly ReconciliationOperation[],
): string[] {
  const byFile = new Map<string, ReconciliationOperation[]>();
  for (const operation of operations) {
    const bucket = byFile.get(operation.file);
    if (bucket === undefined) {
      byFile.set(operation.file, [operation]);
    } else {
      bucket.push(operation);
    }
  }

  for (const [file, fileOps] of byFile) {
    const baseline = readBaselineFile(root, file);
    const content =
      baseline === null
        ? newFileContent(fileOps)
        : mergeFileInto(baseline, fileOps);
    const dst = docsFilePath(root, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    atomicWriteText(dst, content);
  }

  return operations.map((operation) => operation.chunk_id);
}

// ---------------------------------------------------------------------------
// 基线索引 / 图 / 版本元数据 / 版本索引（不导出）
// ---------------------------------------------------------------------------

/** 基线索引重建 + 图 sync + 版本图并入基线图（委托 indexing / specgraph 既有能力）。 */
function rebuildAndPromoteStores(root: ProjectRoot, id: string): void {
  new IndexManager(root).rebuildBaseline();
  const store = new SpecGraphStore(root);
  store.sync();
  store.mergeIntoBaseline(id);
}

/**
 * 本版本元数据置终态并落盘：`merged_at=now`、`phase=merged`、`snapshot=null`。
 * 不触碰其它版本的任何 .meta 文件。
 */
function markVersionMerged(root: ProjectRoot, id: string): void {
  const meta = loadVersionMeta(root, id);
  meta.merged_at = new Date().toISOString();
  meta.phase = "merged";
  meta.snapshot = null;
  saveModel(versionMetaPath(root, id), meta);
}

/** 版本索引 status=merged（已 merged 的索引只读，重复调用不写）。 */
function markIndexMerged(root: ProjectRoot, id: string): void {
  const index = new IndexManager(root);
  const versionIndex = index.loadVersionIndex(id);
  if (versionIndex.status === "merged") {
    return;
  }
  versionIndex.status = "merged";
  index.saveVersionIndex(versionIndex);
}

/**
 * 绑定字段落盘：docs_commit（提交成功时）、code_base/code_result（宿主为 git 仓时取
 * HEAD，`code_result` 已有 confirm 绑定值则保留）、revert_anchor={docs_ref, code_result}。
 */
function recordBindings(
  root: ProjectRoot,
  id: string,
  mergeCommit: string | null,
  hostHead: string | null,
): void {
  const meta = loadVersionMeta(root, id);
  if (mergeCommit !== null) {
    meta.docs_commit = mergeCommit;
  }
  if (hostHead !== null) {
    meta.code_base = hostHead;
    meta.code_result = meta.code_result ?? hostHead;
  }
  const anchor: RevertAnchor = {
    docs_ref: anchorRef(id),
    code_result: meta.code_result ?? null,
  };
  meta.revert_anchor = anchor;
  saveModel(versionMetaPath(root, id), meta);
}

// ---------------------------------------------------------------------------
// docs 仓 git（不导出）
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitTry(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

/** docs 仓是否可用（非 git 仓 → 提交/tag 步骤整体跳过）。 */
function docsRepoAvailable(root: ProjectRoot): boolean {
  return gitTry(root.root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * docs 仓提交：`git add -A && commit`；无变化则不产生提交、沿用 HEAD 作为绑定点；
 * 提交步骤失败上抛（由调用方走字节级回退，不伪造成功）。
 */
function commitDocs(root: ProjectRoot, message: string): string | null {
  git(root.root, ["add", "-A"]);
  if (git(root.root, ["status", "--porcelain"]).trim() !== "") {
    git(root.root, ["commit", "-m", message]);
  }
  return gitTry(root.root, ["rev-parse", "HEAD"]);
}

/**
 * 创建锚点 tag 并验证存在（tag 创建失败不阻断：可回滚性由绑定字段 SHA 兜底）。
 * 已存在的同名 tag 不移动（`git tag` 非 -f），验证失败即 tag_created=false。
 */
function createTag(root: ProjectRoot, ref: string, commit: string): boolean {
  if (!docsRepoAvailable(root)) {
    return false;
  }
  const name = ref.replace(/^refs\/tags\//, "");
  try {
    git(root.root, ["tag", name, commit]);
  } catch {
    return false;
  }
  return gitTry(root.root, ["rev-parse", "--verify", ref]) !== null;
}

/** 宿主仓 HEAD（非 git 仓/无提交 → null）。 */
function hostHeadOrNull(root: ProjectRoot): string | null {
  if (gitTry(root.cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return null;
  }
  return gitTry(root.cwd, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// 计划一致性（execution 只依据持久化计划）
// ---------------------------------------------------------------------------

/** operation 逐项全等（顺序敏感：plan 顺序即执行顺序）。 */
function sameOperation(
  a: ReconciliationOperation,
  b: ReconciliationOperation,
): boolean {
  return (
    a.file === b.file &&
    a.chunk_id === b.chunk_id &&
    a.action === b.action &&
    a.target_id === b.target_id &&
    a.insert_after === b.insert_after &&
    a.base_hash === b.base_hash &&
    a.new_content === b.new_content
  );
}

function sameOperations(
  a: readonly ReconciliationOperation[],
  b: readonly ReconciliationOperation[],
): boolean {
  return a.length === b.length && a.every((op, i) => sameOperation(op, b[i] as ReconciliationOperation));
}

/** 只读核验确认计划、共享治理与生成回执；诊断随最终合并结果返回。 */
function verifyMergeInputs(
  root: ProjectRoot,
  id: string,
  plan: ReconciliationPlan,
): Pick<MergeResult, "generation_receipts" | "warnings"> {
  const policy: ConflictPolicy = plan.conflict_policy;

  // 过期校验：按持久化的 conflict_policy 重算计划与判定输入指纹，逐项与持久化计划比对
  let expected: ReconciliationPlan;
  let fingerprint: string;
  try {
    const built = buildReconciliation(root, id, policy);
    fingerprint = inputFingerprint(root, id, built.plan.operations, policy);
    expected = {
      operations: built.plan.operations,
      input_fingerprint: fingerprint,
      conflict_policy: policy,
    };
  } catch (err) {
    throw new MergeError(
      "CONFIRMATION_STALE",
      `确认计划已无法按 conflict_policy=${policy} 重算（${errorMessage(err)}）：` +
        `confirm 之后版本索引/工作区或生成状态已变化；recovery：重新执行 version confirm，再重试 merge`,
      { cause: err },
    );
  }

  const governance = evaluateGovernance(root, id);
  const governanceFailures = governance.violations.map((finding) =>
    finding.code + ": " + [finding.chunkId, finding.file, finding.targetFile]
      .filter((value) => value !== undefined).join(" / ") + " — " + finding.message,
  ).join("\n");

  if (
    plan.input_fingerprint !== fingerprint ||
    policy !== expected.conflict_policy ||
    !sameOperations(plan.operations, expected.operations)
  ) {
    const reason =
      plan.input_fingerprint !== fingerprint
        ? `判定输入指纹不符（当前 ${fingerprint}，plan 记录 ${plan.input_fingerprint}）`
        : "计划操作与当前判定输入重算结果不全等";
    throw new MergeError(
      "CONFIRMATION_STALE",
      `确认计划已过期：${reason}（conflict_policy=${policy}）；recovery：重新执行 version confirm，再重试 merge` +
        (governanceFailures === "" ? "" : `\n治理门禁失败：\n${governanceFailures}`),
    );
  }

  if (governance.violations.length > 0) {
    throw new MergeError(
      "INVARIANT_VIOLATION",
      "治理门禁失败：\n" + governanceFailures,
    );
  }

  const generationReceipts = verifyGenerationReceipts(root, id);
  if (generationReceipts.enforcement === "block" && !generationReceipts.passed) {
    throw new MergeError(
      "GENERATION_RECEIPTS_FAILED",
      "生成回执核验失败：\n" + generationReceipts.findings
        .map((finding) => `${finding.code}: ${finding.message}`).join("\n"),
    );
  }
  return { generation_receipts: generationReceipts, warnings: governance.warnings };
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/**
 * reconciliation plan 的原子执行：
 * 校验版本元数据与 confirmed_plan（缺失 CONFIRMATION_REQUIRED；与当前判定输入
 * 不符 CONFIRMATION_STALE，均零落盘并附 recovery 指引：重新 confirm）→
 * 快照 docs 与 .meta（字节级）→ 按计划执行（chunk 级提升、基线索引重建、图并入、
 * 版本元数据 phase=merged + merged_at、版本索引 status=merged、docs 仓提交、
 * 绑定字段与 revert_anchor、绑定提交、tag refs/tags/ait/<v> 创建并验证存在）→
 * 返回 MergeResult；执行阶段任一步异常 → 恢复快照 → MERGE_ROLLBACK（含失败步骤，可安全重试）。
 */
export async function versionMerge(
  root: ProjectRoot,
  id: string,
): Promise<MergeResult> {
  // 1. 读本版本元数据（只读；一切失败零落盘）
  let meta: VersionMeta;
  try {
    meta = loadVersionMeta(root, id);
  } catch (err) {
    throw new MergeError(
      "CONFIRMATION_REQUIRED",
      `USAGE_ERROR：版本 ${id} 元数据不可读（${errorMessage(err)}）；` +
        `recovery：确认版本存在后先执行 version confirm，再重试 merge`,
      { cause: err },
    );
  }

  // 已合入版本拒绝重放（历史只读）
  if (meta.merged_at !== null || meta.phase === "merged") {
    throw new MergeError(
      "CONFIRMATION_REQUIRED",
      `USAGE_ERROR：版本 ${id} 已合入，merge 只对未合入版本开放（已合入版本元数据只读）；` +
        `recovery：如需回退请执行 version revert ${id}`,
    );
  }

  // 2. confirmed_plan 必须存在（缺失零落盘）
  const plan: ReconciliationPlan | null = meta.confirmed_plan;
  if (plan === null) {
    throw new MergeError(
      "CONFIRMATION_REQUIRED",
      `USAGE_ERROR：版本 ${id} 尚无 confirmed_plan（未 confirm）；` +
        `recovery：先执行 version confirm 生成最终 reconciliation plan，再重试 merge`,
    );
  }
  // 3. 真实规格与确认计划均只读核验，不修复输入或重解释执行计划。
  assertSpecIntegrity(root, id);
  verifyMergeInputs(root, id, plan);

  // 4. 字节级快照 docs 与 .meta（任何业务写入之前）
  let snapshot: TreeSnapshot;
  try {
    snapshot = snapshotTree([root.docs, root.meta]);
  } catch (err) {
    throw new MergeError(
      "MERGE_ROLLBACK",
      `merge 在步骤 snapshotTree 失败：${errorMessage(err)}；` +
        `失败发生于任何业务落盘之前，docs 与 .meta 未被改动；可安全重试`,
      { cause: err },
    );
  }

  // 首次基线写入前重新读取治理事实并核验最终指纹与回执；门禁失败零业务落盘。
  let verification: ReturnType<typeof verifyMergeInputs>;
  try {
    verification = verifyMergeInputs(root, id, plan);
  } catch (err) {
    fs.rmSync(snapshot.tmpDir, { recursive: true, force: true });
    throw err;
  }

  // 5. 执行（任一步异常 → 字节级回退 → MERGE_ROLLBACK）
  let mergedChunks: string[];
  let commit: string | null = null;
  let tagCreated = false;
  let step = "applyPlan";
  try {
    mergedChunks = applyPlan(root, plan.operations);

    step = "rebuildAndPromoteStores";
    rebuildAndPromoteStores(root, id);

    step = "markVersionMerged";
    markVersionMerged(root, id);

    step = "markIndexMerged";
    markIndexMerged(root, id);

    const gitAvailable = docsRepoAvailable(root);
    if (gitAvailable) {
      step = "commitDocs";
      const message = meta.title ?? `AIT ${id} merge`;
      commit = commitDocs(root, message);

      step = "recordBindings";
      recordBindings(root, id, commit, hostHeadOrNull(root));

      step = "commitBindings";
      commit = commitDocs(root, `AIT ${id} meta: record bindings`);

      step = "createTag";
      if (commit !== null) {
        tagCreated = createTag(root, anchorRef(id), commit);
      }
    } else {
      step = "recordBindings";
      recordBindings(root, id, null, hostHeadOrNull(root));
    }
  } catch (err) {
    let restoreNote = "docs 与 .meta 已按字节级快照恢复到操作前状态";
    try {
      restoreTree(snapshot);
    } catch (restoreErr) {
      restoreNote = `快照恢复失败（${errorMessage(restoreErr)}），请人工核对 docs 与 .meta`;
    } finally {
      fs.rmSync(snapshot.tmpDir, { recursive: true, force: true });
    }
    throw new MergeError(
      "MERGE_ROLLBACK",
      `merge 在步骤 ${step} 失败：${errorMessage(err)}；${restoreNote}；可安全重试`,
      { cause: err },
    );
  }

  // 6. 成功：清理快照临时区（版本工作区/索引/图保留，供历史查询）
  fs.rmSync(snapshot.tmpDir, { recursive: true, force: true });

  return {
    version: id,
    merged_chunks: mergedChunks,
    commit,
    git: commit === null ? "unavailable" : "committed",
    tag_created: tagCreated,
    plan_fingerprint: plan.input_fingerprint,
    generation_receipts: verification.generation_receipts,
    warnings: verification.warnings,
  };
}
