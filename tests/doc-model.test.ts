// [TDD]-doc_model_tests：doc_model 域（chunk-parser/schemas）集成验收
// 覆盖 [FSD]-ait-core-doc_model:TEST 第 1~9 条全部断言点。
//
// 约定：
// - 解析用例以内联 markdown 文本为主（少落盘），围栏用行数组书写避免模板字符串自嵌套；
// - schema 用例直接构造数据对象断言；
// - 历史形态样本以内联对象书写，每个样本注明它对应的 Python 历史形态；
// - 真实语料用例只读、不写；语料根经 AIT_CORPUS_DIRS（";" 分隔的 .meta 目录列表）给出，
//   缺省为 ait-core 自身 project-docs/.meta；目录不存在时该组 skip 并打印原因；
// - 每个用例独立，零共享状态（临时目录用毕即删，语料只读）。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import {
  ChunkParseError,
  isLegalChunkId,
  parseText,
} from "../src/doc-model/chunk-parser.js";
import type { Chunk, ParsedFile } from "../src/doc-model/chunk-parser.js";
import {
  ActionSchema,
  ArtifactScopeSchema,
  BaselineChunkEntrySchema,
  BaselineIndexSchema,
  ChangeRecordSchema,
  ChangeTypeSchema,
  CommitEntrySchema,
  CoreResultSchema,
  DiscussionUsageSchema,
  EdgeSchema,
  GenerationArtifactStateSchema,
  GenerationDeliveryRecordSchema,
  GenerationStateSchema,
  HistoricalAnchorRepairSchema,
  LocalConfigSchema,
  NextActionSchema,
  ProjectConfigSchema,
  ReconciliationOperationSchema,
  ReconciliationPlanSchema,
  RecoveryJournalSchema,
  RevertAnchorSchema,
  SpecGraphSchema,
  SpecSchema,
  StateSchema,
  StoredGenerationReceiptSchema,
  VersionChunkEntrySchema,
  VersionIndexSchema,
  VersionIndexStatsSchema,
  VersionMetaSchema,
  VersionPhaseSchema,
} from "../src/doc-model/schemas.js";
import type {
  Action,
  ArtifactScope,
  BaselineIndex,
  ChangeRecord,
  CoreResult,
  GenerationArtifactState,
  GenerationDeliveryInput,
  GenerationDeliveryRecord,
  GenerationReceipt,
  GenerationState,
  GenerationVerification,
  LocalConfig,
  NextAction,
  ProjectConfig,
  SpecGraph,
  State,
  StoredGenerationReceipt,
  VersionChunkEntry,
  VersionIndex,
  VersionMeta,
  VersionPhase,
} from "../src/doc-model/schemas.js";
import { dumpModel, loadModel } from "../src/foundation/yaml.js";

// ---------------------------------------------------------------------------
// 通用助手（不承载任何断言语义）
// ---------------------------------------------------------------------------

/** 取数组第 n 项并显式失败：规避 noUncheckedIndexedAccess 的 undefined 噪声。 */
function at<T>(list: readonly T[], index: number, label: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`${label}: 期望存在第 ${index} 项，实际数组长度 ${list.length}`);
  }
  return value;
}

/** 捕获同步调用抛出的错误（比 expect(...).toThrow 更能拿到错误对象本身）。 */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** 断言返回 ChunkParseError 并给出类型收窄后的对象。 */
function expectChunkParseError(fn: () => unknown, label: string): ChunkParseError {
  const caught = catchError(fn);
  if (!(caught instanceof ChunkParseError)) {
    throw new Error(
      `${label}: 期望抛出 ChunkParseError，实际为 ${caught === undefined ? "未抛出错误" : String(caught)}`,
    );
  }
  return caught;
}

/** safeParse 失败的 issue path 字符串集合（"." 连接）。 */
function issuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.join("."));
}

/**
 * 未知字段拒绝的"字段路径"报告。
 * zod 对 .strict() 的尾随未知键使用 code=unrecognized_keys，其 path 指向**宿主对象**
 * （对象级未知键即根，嵌套对象为宿主路径），具体字段名在 `keys` 里；因此字段路径
 * 由 `path` 与 `keys` 组合得出。
 *
 * 判别联合（z.union）失败时外层只有一个 invalid_union issue，真实字段信息在
 * `unionErrors` 的成员 issue 里，故一并展开——每个成员都是"另一种解释"，任一成员
 * 的字段路径都算命中（测试只需证明"报得出该字段"）。
 */
function issuePathsDeep(issues: readonly z.ZodIssue[]): string[] {
  const paths: string[] = [];
  for (const issue of issues) {
    const prefix = issue.path.join(".");
    const keys =
      issue.code === "unrecognized_keys"
        ? (issue as { keys?: readonly string[] }).keys ?? []
        : [];
    if (keys.length > 0) {
      for (const key of keys) {
        paths.push(prefix === "" ? key : `${prefix}.${key}`);
      }
    } else if (prefix !== "") {
      paths.push(prefix);
    }
    const nested = (issue as { unionErrors?: readonly z.ZodError[] }).unionErrors;
    if (nested !== undefined) {
      for (const err of nested) {
        paths.push(...issuePathsDeep(err.issues));
      }
    }
  }
  return paths;
}

/** 未知字段路径集合（含判别联合成员展开）。 */
function unknownFieldPaths(error: z.ZodError): string[] {
  return issuePathsDeep(error.issues);
}

/** 独立临时目录助手：每个用例独立，零共享状态。 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ait-doc-model-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// fixtures 区（minimal-valid 样本随 schema 演进漂移时集中在此维护，禁止散落）
// 形态一律取自 Python 版 ait 当前 dump（AIT-project/project-docs/.meta 真实文件）。
// ---------------------------------------------------------------------------

const ISO = "2026-10-02T10:23:41.952192+00:00";
const DIGEST = `sha256:${"a".repeat(64)}`;
const FINGERPRINT = "e10db69c55f7e633ec42e33b230f69f654e8eb374418d1d304294166bad6a26d";

/** 基线索引最小样本（chunks-index.yaml）。 */
const MIN_BASELINE_INDEX = {
  version: 1,
  scope: "global",
  updated: ISO,
  chunks: [
    {
      id: "[FSD]-ait-core-doc_model",
      file: "fsd/[FSD]-ait-core-doc_model",
      heading: "doc_model 域功能分解根",
      level: 2,
      summary: null,
      metadata: {},
    },
  ],
} as const;

/** 版本索引最小样本（chunks-index-<version>.yaml）。 */
const MIN_VERSION_INDEX = {
  version: 1,
  scope: "version",
  version_name: "v2.10",
  based_on_hash: null,
  status: "merged",
  chunks: [
    {
      id: "[FSD]-ait-core-doc_model",
      file: "fsd/[FSD]-ait-core-doc_model",
      heading: "doc_model 域功能分解根",
      level: 2,
      action: "modify",
      state: "committed",
      commit_id: "c1",
      overrides: null,
      amends: null,
      insert_after: null,
      base_hash: null,
      source_req: null,
      discussion_usage: null,
      summary: null,
      metadata: {},
    },
  ],
  commits: [
    {
      id: "c1",
      timestamp: ISO,
      message: "doc_model 对齐 Python 形态",
      chunks: ["[FSD]-ait-core-doc_model"],
      req_id: null,
    },
  ],
  stats: {
    total_chunks: 1,
    by_action: { modify: 1 },
    by_state: { committed: 1 },
    tasks_summary: {},
  },
} as const;

/** 关系图最小样本（specgraph.yaml）——specs 为按 uri 排序的数组，节点身份为 uri。 */
const MIN_SPEC_GRAPH = {
  version: 1,
  updated: ISO,
  specs: [
    {
      uri: "spec:fsd:baseline:[FSD]-ait-core-doc_model",
      title: "doc_model 域功能分解根",
      type: "fsd",
      version: "baseline",
      chunk_id: "[FSD]-ait-core-doc_model",
      file: "fsd/[FSD]-ait-core-doc_model",
      metadata: { source: "baseline" },
    },
  ],
  edges: [
    {
      src: "spec:prd:baseline:[PRD]-ait-core",
      dst: "spec:fsd:baseline:[FSD]-ait-core-doc_model",
      rel: "derives",
      weight: 1.0,
      metadata: { source: "fsd-declaration" },
    },
  ],
} as const;

/** 版本元数据最小样本（versions/<version>.yaml，含 confirmed_plan/revert_anchor/recovery_journal）。 */
const MIN_VERSION_META = {
  version: "v3.5",
  created_at: ISO,
  merged_at: ISO,
  owner: "system",
  changes: ["chg-1102"],
  dependencies: { based_on: null, conflicts_with: [], merge_after: [] },
  snapshot: null,
  phase: "merged",
  title: null,
  prd_locked: false,
  impl_locked: false,
  docs_commit: "1a931eca2bdfa5c8120e28859efaade06a8d5bf6",
  code_base: "de7b16661d7fb11dc548ca603a28b82c144e32fa",
  code_result: "de7b16661d7fb11dc548ca603a28b82c144e32fa",
  confirmed_plan: {
    operations: [
      {
        file: "prd/[PRD]-ait-core",
        chunk_id: "[PRD]-ait-core",
        action: "modify",
        target_id: "[PRD]-ait-core",
        insert_after: null,
        base_hash: null,
        new_content: "<!-- @id:[PRD]-ait-core -->\n## ait-core 产品 PRD\n",
      },
    ],
    input_fingerprint: FINGERPRINT,
    conflict_policy: "use-version",
  },
  revert_anchor: { docs_ref: "refs/tags/ait/v3.5", code_result: "de7b16661d7fb11dc548ca603a28b82c144e32fa" },
  recovery_journal: null,
  historical_anchor_repairs: [],
} as const;

/** 变更记录最小样本（changes/chg-NNN.yaml，单文件单记录）。 */
const MIN_CHANGE_RECORD = {
  id: "chg-1000",
  version: "v3.1",
  type: "MODIFY",
  target: "fsd/[FSD]-ait-core#[FSD]-ait-core:doc_model",
  author: "system",
  date: ISO,
  message: "fsd layer confirm",
  base_hash: null,
  discussion_usage: { mode: "receipt", receipt_digest: DIGEST },
  base_content: null,
  new_content: "<!-- @id:[FSD]-ait-core:doc_model -->\n## doc_model 域功能分解根\n",
} as const;

/** 共享配置最小样本（config.yaml）——开放字典，artifact_scopes 为以范围名为键的对象。 */
const MIN_PROJECT_CONFIG = {
  id_prefix_separator: "-",
  version_format: "{major}.{minor}",
  auto_snapshot_on_merge: false,
  custom_relations: ["refines", "depends-on"],
  id_prefixes: { prd: "产品需求与设计意图" },
  mvp_scope_tags: [],
  artifact_scopes: {
    "tests/": {
      parent_suffix: ":TEST",
      enforcement: "block",
      exempt_test_splits: ["[FSD]-ait-state:TEST"],
      exempt_paths: ["tests/__init__.py"],
    },
  },
  initialized: true,
} as const;

/** 本地配置最小样本（config.local.yaml）——开放字典，字段可空。 */
const MIN_LOCAL_CONFIG = {
  skill_dir: "C:\\Users\\n4ll_\\.claude\\skills\\ait",
  cli_path: null,
  wrapper_path: "project-docs/.ait/ait-cli.cmd",
  acceptance_command: null,
} as const;

/** Node 生成状态样本；与上方 Python 历史持久化样本分开维护。 */
const GENERATION_HASH = "a".repeat(64);
const ARTIFACT_HASH = "b".repeat(64);
const MIN_GENERATION_RECEIPT = {
  version: "v0.10",
  tdd_root: "[TDD]-doc_model_tests",
  target_file: "tests/doc-model.test.ts",
  bundle_sha256: GENERATION_HASH,
  artifact_sha256: ARTIFACT_HASH,
  generated_at: ISO,
  delivery_id: "delivery-doc-model",
} as const;

const MIN_GENERATION_DELIVERY = {
  delivery_id: MIN_GENERATION_RECEIPT.delivery_id,
  token_digest: "c".repeat(64),
  version: MIN_GENERATION_RECEIPT.version,
  version_created_at: ISO,
  tdd_root: MIN_GENERATION_RECEIPT.tdd_root,
  target_file: MIN_GENERATION_RECEIPT.target_file,
  bundle_sha256: MIN_GENERATION_RECEIPT.bundle_sha256,
  spec_fingerprint: FINGERPRINT,
  before_artifact: { state: "loaded", sha256: GENERATION_HASH },
  receipt: MIN_GENERATION_RECEIPT,
} as const;

const MIN_GENERATION_STATE = {
  epoch: "epoch-doc-model",
  deliveries: [MIN_GENERATION_DELIVERY],
} as const;

const MIN_BASELINE_GENERATION_STATE = {
  epoch: "epoch-baseline",
  deliveries: [{
    ...MIN_GENERATION_DELIVERY,
    version: null,
    version_created_at: null,
    before_artifact: { state: "absent", sha256: null },
    receipt: { ...MIN_GENERATION_RECEIPT, version: null },
  }],
} as const;

const MIN_GENERATION_VERSION_META = {
  ...MIN_VERSION_META,
  version: MIN_GENERATION_DELIVERY.version,
  generation: MIN_GENERATION_STATE,
} as const;

const VALID_NEXT_ACTIONS = [
  { type: "present_and_collect", instruction: "展示并收集", required_next_call: "ait prd confirm" },
  { type: "report", message: "校验完成" },
  { type: "continue", instruction: "继续确认", next_call: "ait tdd confirm" },
] as const;

/** 当前形态样本矩阵：合法通过 / 加未知字段拒绝（报路径）/ 非法值拒绝。 */
interface CurrentShapeCase {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  /** 归一后仍存在的未知字段名（.strict() 必须拒绝并报此路径）。 */
  unknownField: string;
}

const CURRENT_SHAPE_CASES: CurrentShapeCase[] = [
  {
    name: "BaselineIndex",
    schema: BaselineIndexSchema,
    valid: MIN_BASELINE_INDEX,
    unknownField: "__drift",
  },
  {
    name: "BaselineChunkEntry",
    schema: BaselineChunkEntrySchema,
    valid: MIN_BASELINE_INDEX.chunks[0],
    unknownField: "hash",
  },
  {
    name: "VersionIndex",
    schema: VersionIndexSchema,
    valid: MIN_VERSION_INDEX,
    unknownField: "__drift",
  },
  {
    name: "VersionChunkEntry",
    schema: VersionChunkEntrySchema,
    valid: MIN_VERSION_INDEX.chunks[0],
    unknownField: "hash",
  },
  {
    name: "CommitEntry",
    schema: CommitEntrySchema,
    valid: MIN_VERSION_INDEX.commits[0],
    unknownField: "extra_field",
  },
  {
    name: "VersionIndexStats",
    schema: VersionIndexStatsSchema,
    valid: MIN_VERSION_INDEX.stats,
    unknownField: "notes",
  },
  {
    name: "SpecGraph",
    schema: SpecGraphSchema,
    valid: MIN_SPEC_GRAPH,
    unknownField: "__drift",
  },
  {
    name: "Spec",
    schema: SpecSchema,
    valid: MIN_SPEC_GRAPH.specs[0],
    unknownField: "heading",
  },
  {
    name: "Edge",
    schema: EdgeSchema,
    valid: MIN_SPEC_GRAPH.edges[0],
    unknownField: "source",
  },
  {
    name: "VersionMeta",
    schema: VersionMetaSchema,
    valid: MIN_VERSION_META,
    unknownField: "__drift",
  },
  {
    name: "ChangeRecord",
    schema: ChangeRecordSchema,
    valid: MIN_CHANGE_RECORD,
    unknownField: "action",
  },
];

/** 配置类：开放字典，未知键必须保留而非拒绝。 */
interface OpenConfigCase {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  /** 语料中真实出现的未知键（Python config 扩展键）。 */
  extraKey: string;
  extraValue: unknown;
}

const OPEN_CONFIG_CASES: OpenConfigCase[] = [
  {
    name: "ProjectConfig",
    schema: ProjectConfigSchema,
    valid: MIN_PROJECT_CONFIG,
    extraKey: "target_file_existence",
    extraValue: { enforcement: "block" },
  },
  {
    name: "LocalConfig",
    schema: LocalConfigSchema,
    valid: MIN_LOCAL_CONFIG,
    extraKey: "derives_residue",
    extraValue: { enforcement: "warn" },
  },
];

// ---------------------------------------------------------------------------
// chunk_parser 边界
// ---------------------------------------------------------------------------

describe("chunk_parser 边界", () => {
  // [:TEST 1] 多 chunk 边界正确、围栏内标记屏蔽、首段归入 fileHeader
  it("多 chunk 归属：边界、heading/level、行号、fileHeader、尾段", () => {
    const text = [
      "# 文档标题", // 1
      "头部说明。", // 2
      "<!-- @id:[PRD]-alpha -->", // 3
      "## Alpha", // 4
      "alpha 内容。", // 5
      "<!-- @id:[PRD]-beta:TEST -->", // 6
      "### Beta", // 7
      "beta 内容。", // 8
      "结尾散段。", // 9
    ].join("\n");
    const parsed: ParsedFile = parseText(text, "docs/demo.md");

    expect(parsed.file).toBe("docs/demo.md");
    // 首个 @id 之前的非空内容归 fileHeader（不含 @id 注释行）
    expect(parsed.fileHeader).toBe("# 文档标题\n头部说明。");
    expect(parsed.chunks).toHaveLength(2);

    const alpha = at(parsed.chunks, 0, "chunks");
    expect(alpha.id).toBe("[PRD]-alpha");
    expect(alpha.heading).toBe("Alpha");
    expect(alpha.level).toBe(2);
    expect(alpha.startLine).toBe(3);
    // 上一个 chunk 止于下一个 @id 行之前
    expect(alpha.endLine).toBe(5);
    expect(alpha.content).toContain("alpha 内容。");
    expect(alpha.content).not.toContain("beta 内容。");

    const beta = at(parsed.chunks, 1, "chunks");
    expect(beta.id).toBe("[PRD]-beta:TEST");
    expect(beta.heading).toBe("Beta");
    expect(beta.level).toBe(3);
    expect(beta.startLine).toBe(6);
    // 无标记尾段归入最后一个 chunk
    expect(beta.content).toContain("beta 内容。");
    expect(beta.content).toContain("结尾散段。");
  });

  it("chunk 内无标题时 heading=id、level=0", () => {
    const text = ["<!-- @id:[TDD]-no_heading -->", "直接正文。"].join("\n");
    const parsed = parseText(text, "t.md");
    expect(parsed.chunks).toHaveLength(1);
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.heading).toBe("[TDD]-no_heading");
    expect(chunk.level).toBe(0);
    expect(chunk.content).toContain("直接正文。");
  });

  it("空文件：空 chunks、空 fileHeader、空 refs", () => {
    const parsed = parseText("", "empty.md");
    expect(parsed.file).toBe("empty.md");
    expect(parsed.fileHeader).toBe("");
    expect(parsed.chunks).toEqual([]);
    expect(parsed.refs).toEqual([]);
  });

  it("无 @id 文件：全部内容归 fileHeader（仅去尾部空白，保留前导空行）", () => {
    const parsed = parseText("# 只有标题\n正文。\n", "plain.md");
    expect(parsed.chunks).toEqual([]);
    expect(parsed.refs).toEqual([]);
    expect(parsed.fileHeader).toBe("# 只有标题\n正文。");
  });

  // [:TEST 1] 文本口径以 Python 为准：fileHeader 走 rstrip（仅尾部），前导空行原样保留
  it("fileHeader 保留前导空行、仅去尾部空白（Python rstrip 口径）", () => {
    const parsed = parseText(
      "\n\n# 标题\n正文。\n\n\n<!-- @id:[PRD]-lead_blanks -->\n内容。",
      "lead.md",
    );
    expect(parsed.chunks).toHaveLength(1);
    // 前导两个空行保留（trim 会连带吃掉，与 Python 不一致）
    expect(parsed.fileHeader).toBe("\n\n# 标题\n正文。");
    expect(parsed.fileHeader.startsWith("\n\n#")).toBe(true);
    // 尾部空白已去除
    expect(parsed.fileHeader.endsWith("正文。")).toBe(true);
  });

  it("无 @id 文件的 fileHeader 同样保留前导空行、仅去尾部空白", () => {
    const parsed = parseText("\n\n# 标题\n正文。\n\n\n", "plain-lead.md");
    expect(parsed.chunks).toEqual([]);
    expect(parsed.fileHeader).toBe("\n\n# 标题\n正文。");
  });

  // [:TEST 1] Chunk.content 含 @id 注释行（Python lines[line_idx:end_idx+1]），尾部空行已去除
  it("Chunk.content 含 @id 注释行本身，且无尾部空行", () => {
    const text = [
      "<!-- @id:[PRD]-content_shape -->", // 1
      "正文。", // 2
      "", // 3
      "", // 4
      "<!-- @id:[PRD]-next_chunk -->", // 5
      "乙。", // 6
    ].join("\n");
    const parsed = parseText(text, "shape.md");
    const first = at(parsed.chunks, 0, "chunks");

    // @id 行留在 content 内：两版对同一 chunk 取到同一段文本
    expect(first.content).toContain("<!-- @id:[PRD]-content_shape -->");
    expect(first.content.startsWith("<!-- @id:[PRD]-content_shape -->")).toBe(true);
    // 尾部空行不计入 content（endLine 亦收在正文末行）
    expect(first.content).toBe("<!-- @id:[PRD]-content_shape -->\n正文。");
    expect(first.endLine).toBe(2);
    // 区间不含下一个 chunk 的任何内容
    expect(first.content).not.toContain("next_chunk");
    expect(first.content).not.toContain("乙。");
  });

  it("单行 chunk（仅 @id 行）：content 即该行本身，无尾部换行", () => {
    const chunk = at(parseText("<!-- @id:[PRD]-id_only -->", "only.md").chunks, 0, "chunks");
    expect(chunk.content).toBe("<!-- @id:[PRD]-id_only -->");
    expect(chunk.startLine).toBe(1);
    expect(chunk.endLine).toBe(1);
    // 无标题行：heading 回退为 id、level 为 0
    expect(chunk.heading).toBe("[PRD]-id_only");
    expect(chunk.level).toBe(0);
  });

  it("chunk 起止行号覆盖整段区间（含 @id 注释行本身）", () => {
    const text = [
      "<!-- @id:[TDD]-first -->", // 1
      "第一段。", // 2
      "<!-- @id:[TDD]-second -->", // 3
      "第二段。", // 4
    ].join("\n");
    const parsed = parseText(text, "lines.md");
    const first = at(parsed.chunks, 0, "chunks");
    const second = at(parsed.chunks, 1, "chunks");
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(2);
    expect(second.startLine).toBe(3);
    expect(second.endLine).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// chunk_parser 围栏
// ---------------------------------------------------------------------------

describe("chunk_parser 围栏", () => {
  // [:TEST 1] 围栏内示例 @id 被屏蔽
  it("围栏内 @id/@ref 屏蔽，作为普通文本保留在 chunk 内容中", () => {
    // 以行数组书写围栏定界，避免模板字符串自嵌套
    const text = [
      "<!-- @id:[FSD]-doc -->", // 1
      "正文。", // 2
      "```", // 3
      "<!-- @id:[PRD]-example -->", // 4
      "<!-- @ref:fsd/[FSD]-doc#[FSD]-doc:schemas rel:decomposes -->", // 5
      "示例内容", // 6
      "```", // 7
      "尾部。", // 8
    ].join("\n");
    const parsed = parseText(text, "fence.md");

    expect(parsed.chunks).toHaveLength(1);
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.id).toBe("[FSD]-doc");
    expect(chunk.content).toContain("<!-- @id:[PRD]-example -->");
    expect(chunk.content).toContain("示例内容");
    expect(chunk.content).toContain("尾部。");
    // 围栏内标记不产生 ref 记录
    expect(parsed.refs).toEqual([]);
  });

  it("围栏未闭合：容忍，按文本结束处理且不报错", () => {
    const text = [
      "<!-- @id:[TDD]-open_fence -->",
      "开头。",
      "```",
      "<!-- @id:[PRD]-hidden -->",
      "仍在围栏内。",
    ].join("\n");

    const caught = catchError(() => parseText(text, "unclosed.md"));
    expect(caught).toBeUndefined();

    const parsed = parseText(text, "unclosed.md");
    expect(parsed.chunks).toHaveLength(1);
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.content).toContain("<!-- @id:[PRD]-hidden -->");
    expect(chunk.content).toContain("仍在围栏内。");
  });

  it("围栏关闭后标记重新生效：围栏后 @id 正常定界", () => {
    const text = [
      "<!-- @id:[TDD]-before -->", // 1
      "```", // 2
      "<!-- @id:[PRD]-masked -->", // 3
      "```", // 4
      "<!-- @id:[TDD]-after -->", // 5
      "正文。", // 6
    ].join("\n");
    const parsed = parseText(text, "toggle.md");
    expect(parsed.chunks.map((c: Chunk) => c.id)).toEqual([
      "[TDD]-before",
      "[TDD]-after",
    ]);
    expect(at(parsed.chunks, 0, "chunks").content).toContain("<!-- @id:[PRD]-masked -->");
  });
});

// ---------------------------------------------------------------------------
// chunk_parser id 形态
// ---------------------------------------------------------------------------

describe("chunk_parser id 形态", () => {
  const LEGAL_IDS = [
    "[PRD]-ait-core",
    "[PRD]-a",
    "[FSD]-ait-core-doc_model",
    "[FSD]-x-y_z-1",
    "[TDD]-chunk_parser",
    "[TDD]-doc_model_tests",
    "[PRD]-ait-core:chunk_versioning",
    "[FSD]-ait-core-doc_model:chunk_parser",
    // 内部 split 保留大写 :TEST
    "[FSD]-ait-core-doc_model:TEST",
    "[TDD]-doc_model_tests:TEST",
  ] as const;

  it.each(LEGAL_IDS)("合法 id 通过：%s", (id) => {
    expect(isLegalChunkId(id)).toBe(true);
    const parsed = parseText(`<!-- @id:${id} -->\n内容。`, "ids.md");
    expect(parsed.chunks).toHaveLength(1);
    expect(at(parsed.chunks, 0, "chunks").id).toBe(id);
  });

  const ILLEGAL_IDS = [
    "[XXX]-foo", // 错误前缀
    "[prd]-foo", // 小写前缀
    "PRD-foo", // 缺方括号
    "[PRD]-", // 空名称
    "[PRD]-Foo", // 名称含大写
    "[PRD]-foo.bar", // 名称含非法字符
    "[PRD]-foo:bar:baz", // 两段 split
    "[PRD]-foo:", // split 名为空
  ] as const;

  // [:TEST 2] 非法 id 报含文件与行号的结构化错误，不静默容错
  it.each(ILLEGAL_IDS)("非法 id 拒绝（含文件与行号）：%s", (id) => {
    const text = ["# 头部", "", `<!-- @id:${id} -->`, "内容。"].join("\n");
    const err = expectChunkParseError(() => parseText(text, "bad/ids.md"), `非法 id ${id}`);

    expect(err.code).toBe("CHUNK_PARSE_ERROR");
    expect(err.file).toBe("bad/ids.md");
    expect(err.line).toBe(3);
    // 错误信息须给出可定位的描述，不静默容错
    expect(err.message).toContain("id");
    expect(err.message.length).toBeGreaterThan(0);
    expect(isLegalChunkId(id)).toBe(false);
  });

  it("@id 行尾有多余文本：整行不匹配 id 注释形态，视为普通内容行", () => {
    // 行内 id 形态 `[^\s>]+?` 吃掉 `[PRD]-foo` 后遇空格无法闭合，故整行不是 @id 注释
    const text = [
      "<!-- @id:[PRD]-ok -->",
      "内容。",
      "<!-- @id:[PRD]-foo bar -->",
    ].join("\n");
    const parsed = parseText(text, "tail.md");
    expect(parsed.chunks).toHaveLength(1);
    expect(at(parsed.chunks, 0, "chunks").id).toBe("[PRD]-ok");
    expect(at(parsed.chunks, 0, "chunks").content).toContain("<!-- @id:[PRD]-foo bar -->");
  });

  it("非法 id 的行号反映其真实位置（非固定首行）", () => {
    const text = [
      "<!-- @id:[PRD]-ok -->",
      "内容。",
      "",
      "<!-- @id:[XXX]-bad -->",
    ].join("\n");
    const err = expectChunkParseError(() => parseText(text, "late.md"), "非法 id 行号");
    expect(err.file).toBe("late.md");
    expect(err.line).toBe(4);
  });

  it("重复 chunk id 拒绝：错误含重复行号与首个出现行号", () => {
    const text = [
      "<!-- @id:[PRD]-dup -->", // 1
      "甲。", // 2
      "<!-- @id:[PRD]-dup -->", // 3
      "乙。", // 4
    ].join("\n");
    const err = expectChunkParseError(() => parseText(text, "dup.md"), "重复 id");
    expect(err.code).toBe("CHUNK_PARSE_ERROR");
    expect(err.file).toBe("dup.md");
    // 报重复出现处
    expect(err.line).toBe(3);
    // message 说明首个出现行号
    expect(err.message).toContain("1");
  });

  it("同一文件不同 id 不误判为重复", () => {
    const text = [
      "<!-- @id:[PRD]-one -->",
      "甲。",
      "<!-- @id:[PRD]-two -->",
      "乙。",
    ].join("\n");
    expect(() => parseText(text, "twice.md")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// chunk_parser refs
// ---------------------------------------------------------------------------

describe("chunk_parser refs", () => {
  it("@ref/@extract 记录 kind/raw/line，不建边", () => {
    const text = [
      "<!-- @id:[PRD]-refs-demo -->", // 1
      "内容。", // 2
      "<!-- @ref:fsd/[FSD]-ait-core-doc_model#[FSD]-ait-core-doc_model rel:derives -->", // 3
      "<!-- @extract:dynamic/schema#[PRD]-refs-demo -->", // 4
    ].join("\n");
    const parsed = parseText(text, "refs.md");

    expect(parsed.chunks).toHaveLength(1);
    expect(parsed.refs).toHaveLength(2);

    const ref = at(parsed.refs, 0, "refs");
    expect(ref.kind).toBe("ref");
    expect(ref.line).toBe(3);
    expect(ref.raw).toContain("@ref:");
    expect(ref.raw).toContain("[FSD]-ait-core-doc_model");

    const extract = at(parsed.refs, 1, "refs");
    expect(extract.kind).toBe("extract");
    expect(extract.line).toBe(4);
    expect(extract.raw).toContain("@extract:");
  });

  it("@ref 记录不进入 content 剥离逻辑（作为普通正文保留）", () => {
    const text = [
      "<!-- @id:[PRD]-keep -->",
      "<!-- @ref:fsd/[FSD]-a#[FSD]-a rel:derives -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "keep.md");
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.content).toContain("@ref:");
    expect(chunk.content).toContain("正文。");
  });

  it("文首（chunk 之外）的 @ref 不归属任何 chunk", () => {
    const text = [
      "<!-- @ref:fsd/[FSD]-a#[FSD]-a rel:derives -->",
      "<!-- @id:[PRD]-root -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "header-ref.md");
    expect(parsed.chunks).toHaveLength(1);
    // 文件头区的 @ref 不计入 chunk 的 refs 归属（解析层不建边，也不归属）
    expect(parsed.refs.every((r) => r.kind === "ref")).toBe(true);
  });

  it("空 refs：无 @ref/@extract 时为空数组", () => {
    const parsed = parseText("<!-- @id:[PRD]-plain -->\n正文。", "plain.md");
    expect(parsed.refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// chunk_parser 摘要（@summary / @prd-no-impl 元注释）
// ---------------------------------------------------------------------------

describe("chunk_parser 摘要", () => {
  // [:TEST 3] summary 无注释即 null，不得由首行/标题派生
  it("① 无 @summary 的 chunk：summary === null，且不等于首行文本", () => {
    const text = [
      "<!-- @id:[PRD]-no_summary -->",
      "## 这是标题行",
      "正文内容。",
    ].join("\n");
    const parsed = parseText(text, "no-summary.md");
    const chunk = at(parsed.chunks, 0, "chunks");

    expect(chunk.summary).toBeNull();
    // 显式锁死"不派生"：不得回退为标题或首行
    expect(chunk.summary).not.toBe("## 这是标题行");
    expect(chunk.summary).not.toBe("这是标题行");
    expect(chunk.heading).toBe("这是标题行");
  });

  it("① 正文首行非空但仍无 @summary：summary 仍为 null", () => {
    const parsed = parseText(
      "<!-- @id:[TDD]-body_only -->\n这是一句很长的正文首行，绝不应被当作摘要。",
      "body.md",
    );
    expect(at(parsed.chunks, 0, "chunks").summary).toBeNull();
  });

  // [:TEST 3] @summary 取 trim 后文本且注释行不出现在 content
  it("② @summary 取值 trim 且行被剥离出 content", () => {
    const text = [
      "<!-- @id:[PRD]-with_summary -->",
      "<!-- @summary:   摘要文本   -->",
      "## 标题",
      "正文内容。",
    ].join("\n");
    const parsed = parseText(text, "summary.md");
    const chunk = at(parsed.chunks, 0, "chunks");

    expect(chunk.summary).toBe("摘要文本");
    expect(chunk.content).not.toContain("@summary");
    expect(chunk.content).not.toContain("摘要文本");
    expect(chunk.content).toContain("## 标题");
    expect(chunk.content).toContain("正文内容。");
  });

  it("② 剥离 @summary 时连同其后紧邻的一个空行", () => {
    const text = [
      "<!-- @id:[PRD]-strip_blank -->",
      "<!-- @summary: 摘要 -->",
      "",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "strip.md");
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.summary).toBe("摘要");
    expect(chunk.content).not.toContain("@summary");
    // @summary 行与其后紧邻的一个空行一并剥离：区间内只余 @id 行与正文
    expect(chunk.content).toBe("<!-- @id:[PRD]-strip_blank -->\n\n正文。");
    expect(chunk.content.endsWith("正文。")).toBe(true);
  });

  // [:TEST 3] 多条 @summary 取末条
  it("③ 一 chunk 内多条 @summary：取最后一条", () => {
    const text = [
      "<!-- @id:[PRD]-multi_summary -->",
      "<!-- @summary: 第一条 -->",
      "正文。",
      "<!-- @summary: 最后一条 -->",
    ].join("\n");
    const parsed = parseText(text, "multi.md");
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.summary).toBe("最后一条");
    expect(chunk.content).not.toContain("@summary");
  });

  it("③ 末条 @summary 随 chunk 边界收敛：不跨 chunk 取用", () => {
    const text = [
      "<!-- @id:[PRD]-first -->",
      "<!-- @summary: 甲的摘要 -->",
      "甲。",
      "<!-- @id:[PRD]-second -->",
      "乙。",
    ].join("\n");
    const parsed = parseText(text, "boundary.md");
    expect(at(parsed.chunks, 0, "chunks").summary).toBe("甲的摘要");
    expect(at(parsed.chunks, 1, "chunks").summary).toBeNull();
  });

  it("④ 围栏内 @summary 不生效：summary 仍为 null 且该行保留在 content", () => {
    const text = [
      "<!-- @id:[TDD]-fenced_summary -->", // 1
      "正文。", // 2
      "```", // 3
      "<!-- @summary: 围栏内的假摘要 -->", // 4
      "```", // 5
    ].join("\n");
    const parsed = parseText(text, "fenced-summary.md");
    const chunk = at(parsed.chunks, 0, "chunks");

    expect(chunk.summary).toBeNull();
    // 围栏内行不参与匹配、不参与剥离，原样保留
    expect(chunk.content).toContain("<!-- @summary: 围栏内的假摘要 -->");
  });

  it("@summary: 后为空不匹配该行形态 → summary 为 null（不是空字符串）", () => {
    const text = [
      "<!-- @id:[PRD]-empty_summary -->",
      "<!-- @summary: -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "empty-summary.md");
    expect(at(parsed.chunks, 0, "chunks").summary).toBeNull();
  });

  it("@summary 行必须独占一行：行尾多余文本不匹配", () => {
    const text = [
      "<!-- @id:[PRD]-inline_summary -->",
      "<!-- @summary: 摘要 --> 尾随文本",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "inline-summary.md");
    expect(at(parsed.chunks, 0, "chunks").summary).toBeNull();
  });

  // [:TEST 3] 元注释标记名以 Python 为准：`@prd-no-impl`
  it("⑤ @prd-no-impl 置 noImpl 且该行被剥离", () => {
    const text = [
      "<!-- @id:[PRD]-no_impl -->",
      "<!-- @prd-no-impl -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "noimpl.md");
    const chunk = at(parsed.chunks, 0, "chunks");

    expect(chunk.noImpl).toBe(true);
    expect(chunk.content).not.toContain("@prd-no-impl");
    expect(chunk.content).toContain("正文。");
  });

  it("⑤ @prd-no-impl 剥离时连同其后紧邻的一个空行", () => {
    const text = [
      "<!-- @id:[PRD]-noimpl_blank -->",
      "<!-- @prd-no-impl -->",
      "",
      "正文。",
    ].join("\n");
    const chunk = at(parseText(text, "noimpl-blank.md").chunks, 0, "chunks");
    expect(chunk.noImpl).toBe(true);
    expect(chunk.content).not.toContain("@prd-no-impl");
    expect(chunk.content).toBe("<!-- @id:[PRD]-noimpl_blank -->\n\n正文。");
  });

  it("无 @prd-no-impl 的 chunk：noImpl 为 false", () => {
    const parsed = parseText("<!-- @id:[PRD]-normal -->\n正文。", "normal.md");
    expect(at(parsed.chunks, 0, "chunks").noImpl).toBe(false);
  });

  // [:TEST 3] 裸 @no-impl（无 prd- 前缀）Python 不识别：不得为兼容而额外放宽
  it("⑥ 裸 @no-impl 不识别：noImpl 为 false 且该行留在 content", () => {
    const text = [
      "<!-- @id:[PRD]-bare_noimpl -->",
      "<!-- @no-impl -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "bare-noimpl.md");
    const chunk = at(parsed.chunks, 0, "chunks");

    expect(chunk.noImpl).toBe(false);
    // 不属元注释：原样保留在 content
    expect(chunk.content).toContain("<!-- @no-impl -->");
    expect(chunk.content).toContain("正文。");
  });

  it("围栏内 @prd-no-impl 不生效且保留在 content", () => {
    const text = [
      "<!-- @id:[PRD]-fenced_noimpl -->",
      "```",
      "<!-- @prd-no-impl -->",
      "```",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "fenced-noimpl.md");
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.noImpl).toBe(false);
    expect(chunk.content).toContain("<!-- @prd-no-impl -->");
  });

  it("@summary 与 @prd-no-impl 并存：两者各自生效、均被剥离", () => {
    const text = [
      "<!-- @id:[PRD]-both_meta -->",
      "<!-- @summary: 并存摘要 -->",
      "",
      "<!-- @prd-no-impl -->",
      "正文。",
    ].join("\n");
    const parsed = parseText(text, "both.md");
    const chunk = at(parsed.chunks, 0, "chunks");
    expect(chunk.summary).toBe("并存摘要");
    expect(chunk.noImpl).toBe(true);
    expect(chunk.content).not.toContain("@summary");
    expect(chunk.content).not.toContain("@prd-no-impl");
    expect(chunk.content).toContain("正文。");
  });
});

// ---------------------------------------------------------------------------
// chunk_parser 确定性
// ---------------------------------------------------------------------------

describe("chunk_parser 确定性", () => {
  it("同一文本两次解析深度相等", () => {
    const text = [
      "# 头部",
      "<!-- @id:[PRD]-det -->",
      "<!-- @summary: 摘要 -->",
      "## 标题",
      "内容。",
      "```",
      "<!-- @id:[FSD]-fenced -->",
      "```",
      "<!-- @ref:fsd/[FSD]-det#[FSD]-det:two rel:decomposes -->",
      "<!-- @id:[FSD]-det-two:TEST -->", // 10
      "第二段。", // 11
      "<!-- @prd-no-impl -->", // 12
    ].join("\n");
    const first = parseText(text, "det.md");
    const second = parseText(text, "det.md");
    expect(second).toEqual(first);
  });

  it("同一文本解析两次：chunk 数与 refs 数稳定且互不共享引用", () => {
    const text = "<!-- @id:[PRD]-share -->\n正文。";
    const first = parseText(text, "share.md");
    const second = parseText(text, "share.md");
    expect(second.chunks).toHaveLength(first.chunks.length);
    first.chunks[0]!.content = "被改写";
    expect(at(second.chunks, 0, "chunks").content).toContain("正文。");
  });
});

// ---------------------------------------------------------------------------
// schemas 当前形态
// ---------------------------------------------------------------------------

describe("schemas 当前形态", () => {
  // [:TEST 4] 每个持久化 schema 的当前形态样本通过；归一后仍有未知字段即拒绝并按字段路径报告
  for (const c of CURRENT_SHAPE_CASES) {
    it(`${c.name}：Python 当前形态样本通过、未知字段 ${c.unknownField} 拒绝且报字段路径`, () => {
      const valid = c.schema.safeParse(c.valid);
      if (!valid.success) {
        throw new Error(
          `${c.name} 当前形态样本被拒：${valid.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join(" | ")}`,
        );
      }
      expect(valid.success).toBe(true);

      const polluted = { ...(c.valid as Record<string, unknown>), [c.unknownField]: 1 };
      const rejected = c.schema.safeParse(polluted);
      expect(rejected.success).toBe(false);
      if (rejected.success) {
        return;
      }
      expect(unknownFieldPaths(rejected.error)).toContain(c.unknownField);
    });
  }

  it("嵌套未知字段报完整路径（chunks.0.<field>）", () => {
    const polluted = {
      ...MIN_BASELINE_INDEX,
      chunks: [{ ...MIN_BASELINE_INDEX.chunks[0], bogus_nested: true }],
    };
    const result = BaselineIndexSchema.safeParse(polluted);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(unknownFieldPaths(result.error)).toContain("chunks.0.bogus_nested");
  });

  it("枚举别名：Action/State/ChangeType/VersionPhase 合法取值通过、枚举外拒绝", () => {
    for (const value of ["add", "modify", "delete"]) {
      expect(ActionSchema.safeParse(value).success).toBe(true);
    }
    expect(ActionSchema.safeParse("remove").success).toBe(false);

    for (const value of ["working", "staged", "committed"]) {
      expect(StateSchema.safeParse(value).success).toBe(true);
    }
    expect(StateSchema.safeParse("merged").success).toBe(false);

    for (const value of ["ADD", "MODIFY", "DELETE"]) {
      expect(ChangeTypeSchema.safeParse(value).success).toBe(true);
    }
    expect(ChangeTypeSchema.safeParse("add").success).toBe(false);

    // 当前流程取值
    for (const phase of [
      "empty",
      "prd-creating",
      "prd-confirm",
      "fsd-creating",
      "fsd-confirm",
      "tdd-creating",
      "tdd-confirm",
      "merged",
    ]) {
      expect(VersionPhaseSchema.safeParse(phase).success).toBe(true);
    }
    // legacy phase 可读
    for (const phase of ["prd_locked", "impl_locked", "coding"]) {
      expect(VersionPhaseSchema.safeParse(phase).success).toBe(true);
    }
    expect(VersionPhaseSchema.safeParse("done").success).toBe(false);
  });

  // [:TEST 4] 合法数据往返 dump/load 语义一致
  it("BaselineIndex dump→load 语义一致", () => {
    withTempDir((dir) => {
      const path = join(dir, "chunks-index.yaml");
      const model = BaselineIndexSchema.parse(MIN_BASELINE_INDEX) as BaselineIndex;
      writeFileSync(path, dumpModel(model), "utf-8");
      expect(loadModel(path, BaselineIndexSchema)).toEqual(model);
    });
  });

  it("VersionIndex dump→load 语义一致", () => {
    withTempDir((dir) => {
      const path = join(dir, "chunks-index-v2.10.yaml");
      const model = VersionIndexSchema.parse(MIN_VERSION_INDEX) as VersionIndex;
      writeFileSync(path, dumpModel(model), "utf-8");
      expect(loadModel(path, VersionIndexSchema)).toEqual(model);
    });
  });

  it("SpecGraph dump→load 语义一致", () => {
    withTempDir((dir) => {
      const path = join(dir, "specgraph.yaml");
      const model = SpecGraphSchema.parse(MIN_SPEC_GRAPH) as SpecGraph;
      writeFileSync(path, dumpModel(model), "utf-8");
      expect(loadModel(path, SpecGraphSchema)).toEqual(model);
    });
  });

  it("VersionMeta dump→load 语义一致", () => {
    withTempDir((dir) => {
      const versionsDir = join(dir, "versions");
      mkdirSync(versionsDir, { recursive: true });
      const path = join(versionsDir, "v3.5.yaml");
      const model = VersionMetaSchema.parse(MIN_VERSION_META) as VersionMeta;
      writeFileSync(path, dumpModel(model), "utf-8");
      expect(loadModel(path, VersionMetaSchema)).toEqual(model);
    });
  });

  it("ChangeRecord dump→load 语义一致", () => {
    withTempDir((dir) => {
      const path = join(dir, "chg-1000.yaml");
      const model = ChangeRecordSchema.parse(MIN_CHANGE_RECORD) as ChangeRecord;
      writeFileSync(path, dumpModel(model), "utf-8");
      expect(loadModel(path, ChangeRecordSchema)).toEqual(model);
    });
  });

  it("往返后未知字段仍被拒绝（严格模式在读侧保持）", () => {
    withTempDir((dir) => {
      const path = join(dir, "chunks-index.yaml");
      writeFileSync(path, `${dumpModel(MIN_BASELINE_INDEX)}__drift: 1\n`, "utf-8");
      expect(() => loadModel(path, BaselineIndexSchema)).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// schemas 历史形态归一
// ---------------------------------------------------------------------------

describe("schemas 历史形态归一", () => {
  // [:TEST 7] Python 早期形态（缺后期字段）归一后与 Python 默认值语义一致

  it("版本元数据缺 docs_commit/code_base/code_result/confirmed_plan/revert_anchor/recovery_journal/historical_anchor_repairs（Python v2.3 形态）", () => {
    // Python v2.3 dump：仅到 prd_locked/impl_locked，后期字段尚未引入
    const legacy = {
      version: "v2.3",
      created_at: "2026-06-27T07:17:25.748980+00:00",
      merged_at: "2026-06-27T07:21:06.544981+00:00",
      owner: "system",
      changes: ["chg-001"],
      dependencies: { based_on: null, conflicts_with: [], merge_after: [] },
      snapshot: "snapshots/v2.3/",
      phase: "merged",
      title: null,
      prd_locked: false,
      impl_locked: false,
    };

    const parsed = VersionMetaSchema.parse(legacy) as VersionMeta;
    expect(parsed.version).toBe("v2.3");
    expect(parsed.docs_commit).toBeNull();
    expect(parsed.code_base).toBeNull();
    expect(parsed.code_result).toBeNull();
    expect(parsed.confirmed_plan).toBeNull();
    expect(parsed.revert_anchor).toBeNull();
    expect(parsed.recovery_journal).toBeNull();
    expect(parsed.historical_anchor_repairs).toEqual([]);
    // 与"补齐 Python 默认值后的对象"整体一致
    expect(parsed).toEqual({
      ...legacy,
      docs_commit: null,
      code_base: null,
      code_result: null,
      confirmed_plan: null,
      revert_anchor: null,
      recovery_journal: null,
      historical_anchor_repairs: [],
      generation: null,
    });
  });

  it("版本元数据 recovery_journal 显式为 null（Python 当前形态的空值写法）", () => {
    const parsed = VersionMetaSchema.parse(MIN_VERSION_META) as VersionMeta;
    expect(parsed.recovery_journal).toBeNull();
    expect(parsed.confirmed_plan).not.toBeNull();
    expect(parsed.revert_anchor).not.toBeNull();
  });

  it("版本元数据字段级 null 与缺省等价（可空字段显式 null）", () => {
    const withNulls = VersionMetaSchema.parse({
      version: "v0.1",
      created_at: ISO,
      merged_at: null,
      snapshot: null,
      title: null,
      docs_commit: null,
      code_base: null,
      code_result: null,
      confirmed_plan: null,
      revert_anchor: null,
      recovery_journal: null,
    }) as VersionMeta;
    const withOmissions = VersionMetaSchema.parse({
      version: "v0.1",
      created_at: ISO,
    }) as VersionMeta;
    expect(withNulls).toEqual(withOmissions);
    expect(withNulls.owner).toBe("system");
    expect(withNulls.phase).toBe("empty");
    expect(withNulls.prd_locked).toBe(false);
    expect(withNulls.impl_locked).toBe(false);
    expect(withNulls.changes).toEqual([]);
    expect(withNulls.dependencies).toEqual({
      based_on: null,
      conflicts_with: [],
      merge_after: [],
    });
  });

  it("变更记录缺 discussion_usage（早期 Python 形态）补 null", () => {
    const legacy = {
      id: "chg-001",
      version: "v2.3",
      type: "MODIFY",
      target: "prd/[PRD]-ait#[PRD]-ait",
      author: "system",
      date: "2026-06-27T07:21:04.540179+00:00",
      message: "ait v2.3 baseline as-built",
      base_hash: null,
      base_content: "旧内容",
      new_content: "新内容",
    };

    const parsed = ChangeRecordSchema.parse(legacy) as ChangeRecord;
    expect(parsed.discussion_usage).toBeNull();
    expect(parsed).toEqual({ ...legacy, discussion_usage: null });
  });

  it("变更记录 type 旧取值写法归一为大写（modify/add/delete）", () => {
    const cases: Array<[string, string]> = [
      ["modify", "MODIFY"],
      ["Modify", "MODIFY"],
      ["add", "ADD"],
      ["delete", "DELETE"],
      ["DELETE", "DELETE"],
    ];
    for (const [input, expected] of cases) {
      const parsed = ChangeRecordSchema.parse({
        ...MIN_CHANGE_RECORD,
        type: input,
      }) as ChangeRecord;
      expect(parsed.type, `type=${input}`).toBe(expected);
    }
  });

  it("变更记录缺 author 补 Python 默认值 system", () => {
    const { author: _omitted, ...rest } = MIN_CHANGE_RECORD;
    const parsed = ChangeRecordSchema.parse(rest) as ChangeRecord;
    expect(parsed.author).toBe("system");
  });

  it("关系图节点 metadata: null 视同 {}，节点缺可选字段补默认值（早期 Python 形态）", () => {
    const legacySpec = {
      uri: "spec:fsd:baseline:[FSD]-ait-core",
      chunk_id: "[FSD]-ait-core",
      metadata: null,
    };
    const parsedSpec = SpecSchema.parse(legacySpec);
    expect(parsedSpec.metadata).toEqual({});
    expect(parsedSpec.title).toBe("");
    expect(parsedSpec.type).toBe("other");
    expect(parsedSpec.version).toBe("baseline");
    expect(parsedSpec.file).toBe("");
  });

  it("关系图边缺 weight 补 1.0；weight 为数字字符串归一为数字", () => {
    const noWeight = EdgeSchema.parse({ src: "a", dst: "b" });
    expect(noWeight.weight).toBe(1);
    expect(noWeight.rel).toBe("related");
    expect(noWeight.metadata).toEqual({});

    const legacyWeight = EdgeSchema.parse({ src: "a", dst: "b", weight: "2.5" });
    expect(legacyWeight.weight).toBe(2.5);
  });

  it("关系图整体缺 version/updated 补默认值，specs/edges 缺省为空数组", () => {
    const parsed = SpecGraphSchema.parse({});
    expect(parsed.version).toBe(1);
    expect(parsed.updated).toBeNull();
    expect(parsed.specs).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });

  it("基线索引缺 updated/summary/metadata 补默认值（早期 Python 形态）", () => {
    const legacy = {
      chunks: [
        { id: "[FSD]-ait-core", file: "fsd/[FSD]-ait-core", heading: "根", level: 2 },
      ],
    };
    const parsed = BaselineIndexSchema.parse(legacy) as BaselineIndex;
    expect(parsed.version).toBe(1);
    expect(parsed.scope).toBe("global");
    expect(parsed.updated).toBeNull();
    const entry = at(parsed.chunks, 0, "chunks");
    expect(entry.summary).toBeNull();
    expect(entry.metadata).toEqual({});
  });

  it("版本索引缺 based_on_hash/commits/stats 补默认值", () => {
    const legacy = { version_name: "v0.1", chunks: [] };
    const parsed = VersionIndexSchema.parse(legacy) as VersionIndex;
    expect(parsed.version).toBe(1);
    expect(parsed.scope).toBe("version");
    expect(parsed.based_on_hash).toBeNull();
    expect(parsed.status).toBe("developing");
    expect(parsed.commits).toEqual([]);
    expect(parsed.stats).toEqual({
      total_chunks: 0,
      by_action: {},
      by_state: {},
      tasks_summary: {},
    });
  });

  it("版本 chunk 条目缺可选字段（action=delete 形态）补默认值", () => {
    const legacy = {
      id: "[PRD]-ait-core",
      file: null,
      heading: null,
      level: null,
      action: "delete",
      state: "committed",
    };
    const parsed = VersionChunkEntrySchema.parse(legacy) as VersionChunkEntry;
    expect(parsed.commit_id).toBeNull();
    expect(parsed.overrides).toBeNull();
    expect(parsed.amends).toBeNull();
    expect(parsed.insert_after).toBeNull();
    expect(parsed.base_hash).toBeNull();
    expect(parsed.source_req).toBeNull();
    expect(parsed.discussion_usage).toBeNull();
    expect(parsed.summary).toBeNull();
    expect(parsed.metadata).toEqual({});
  });

  it("时间字段接受 YAML 的 Date 对象与 ISO 字符串，统一输出 ISO 字符串", () => {
    const fromDate = ChangeRecordSchema.parse({
      ...MIN_CHANGE_RECORD,
      date: new Date("2026-10-02T10:23:41.952Z"),
    }) as ChangeRecord;
    expect(typeof fromDate.date).toBe("string");
    expect(fromDate.date.startsWith("2026-10-02T10:23:41")).toBe(true);

    const fromString = ChangeRecordSchema.parse({
      ...MIN_CHANGE_RECORD,
      date: "2026-10-02T10:23:41.952192+00:00",
    }) as ChangeRecord;
    expect(fromString.date).toBe("2026-10-02T10:23:41.952192+00:00");
  });
});

// ---------------------------------------------------------------------------
// schemas 约束
// ---------------------------------------------------------------------------

describe("schemas 约束", () => {
  // [:TEST 6] summary 120 通过、121 拒绝
  it("summary 120 字通过（VersionChunkEntry / BaselineChunkEntry / ChangeRecord）", () => {
    const summary = "x".repeat(120);
    expect(
      VersionChunkEntrySchema.safeParse({
        ...at(MIN_VERSION_INDEX.chunks, 0, "chunks"),
        summary,
      }).success,
    ).toBe(true);
    expect(
      BaselineChunkEntrySchema.safeParse({
        ...at(MIN_BASELINE_INDEX.chunks, 0, "chunks"),
        summary,
      }).success,
    ).toBe(true);
  });

  it("summary 121 字拒绝", () => {
    const summary = "x".repeat(121);
    expect(
      VersionChunkEntrySchema.safeParse({
        ...at(MIN_VERSION_INDEX.chunks, 0, "chunks"),
        summary,
      }).success,
    ).toBe(false);
    expect(
      BaselineChunkEntrySchema.safeParse({
        ...at(MIN_BASELINE_INDEX.chunks, 0, "chunks"),
        summary,
      }).success,
    ).toBe(false);
  });

  it("DiscussionUsage：receipt 必带 sha256:<64hex> 摘要", () => {
    expect(DiscussionUsageSchema.safeParse({ mode: "receipt", receipt_digest: DIGEST }).success).toBe(true);
    // 缺摘要
    expect(DiscussionUsageSchema.safeParse({ mode: "receipt" }).success).toBe(false);
    // 摘要格式非法
    expect(
      DiscussionUsageSchema.safeParse({ mode: "receipt", receipt_digest: "sha256:zzzz" }).success,
    ).toBe(false);
    // 哈希长度不足
    expect(
      DiscussionUsageSchema.safeParse({
        mode: "receipt",
        receipt_digest: `sha256:${"a".repeat(63)}`,
      }).success,
    ).toBe(false);
    // 大写 hex 非法
    expect(
      DiscussionUsageSchema.safeParse({
        mode: "receipt",
        receipt_digest: `sha256:${"A".repeat(64)}`,
      }).success,
    ).toBe(false);
  });

  it("DiscussionUsage：skipped 不带摘要", () => {
    expect(DiscussionUsageSchema.safeParse({ mode: "skipped" }).success).toBe(true);
    expect(DiscussionUsageSchema.safeParse({ mode: "skipped", receipt_digest: null }).success).toBe(true);
    expect(
      DiscussionUsageSchema.safeParse({ mode: "skipped", receipt_digest: DIGEST }).success,
    ).toBe(false);
  });

  it("DiscussionUsage 经 ChangeRecord / VersionChunkEntry 内建生效", () => {
    expect(
      ChangeRecordSchema.safeParse({
        ...MIN_CHANGE_RECORD,
        discussion_usage: { mode: "skipped", receipt_digest: DIGEST },
      }).success,
    ).toBe(false);
    expect(
      VersionChunkEntrySchema.safeParse({
        ...at(MIN_VERSION_INDEX.chunks, 0, "chunks"),
        discussion_usage: { mode: "receipt" },
      }).success,
    ).toBe(false);
    expect(
      VersionChunkEntrySchema.safeParse({
        ...at(MIN_VERSION_INDEX.chunks, 0, "chunks"),
        discussion_usage: { mode: "receipt", receipt_digest: DIGEST },
      }).success,
    ).toBe(true);
  });

  it("ReconciliationOperation：file 必须为相对 posix 路径", () => {
    const base = {
      chunk_id: "[PRD]-ait-core",
      action: "modify",
      new_content: "内容",
    };
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "prd/[PRD]-ait-core" }).success).toBe(true);
    // 空路径
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "" }).success).toBe(false);
    // 反斜杠（Windows 分隔符）
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "prd\\[PRD]-ait-core" }).success).toBe(false);
    // 绝对路径
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "/prd/[PRD]-ait-core" }).success).toBe(false);
    // 含 .. 段
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "prd/../secret" }).success).toBe(false);
    // 含 . 段
    expect(ReconciliationOperationSchema.safeParse({ ...base, file: "prd/./a" }).success).toBe(false);
  });

  it("ReconciliationOperation：add/modify 必带非空 new_content，delete 可省", () => {
    const op = {
      file: "prd/[PRD]-ait-core",
      chunk_id: "[PRD]-ait-core",
    };
    expect(ReconciliationOperationSchema.safeParse({ ...op, action: "add", new_content: "内容" }).success).toBe(true);
    expect(ReconciliationOperationSchema.safeParse({ ...op, action: "modify", new_content: "内容" }).success).toBe(true);
    // add 缺 new_content
    expect(ReconciliationOperationSchema.safeParse({ ...op, action: "add" }).success).toBe(false);
    // modify 的 new_content 为空串
    expect(ReconciliationOperationSchema.safeParse({ ...op, action: "modify", new_content: "" }).success).toBe(false);
    // 违例 issue path 指向 new_content
    const result = ReconciliationOperationSchema.safeParse({ ...op, action: "add" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuePaths(result.error)).toContain("new_content");
    }
    // delete 无需 new_content
    expect(ReconciliationOperationSchema.safeParse({ ...op, action: "delete" }).success).toBe(true);
  });

  it("ReconciliationPlan：input_fingerprint 为 64 位小写 hex", () => {
    expect(
      ReconciliationPlanSchema.safeParse({
        operations: [],
        input_fingerprint: FINGERPRINT,
        conflict_policy: "abort",
      }).success,
    ).toBe(true);
    // 大写
    expect(
      ReconciliationPlanSchema.safeParse({
        input_fingerprint: FINGERPRINT.toUpperCase(),
        conflict_policy: "abort",
      }).success,
    ).toBe(false);
    // 位数不足
    expect(
      ReconciliationPlanSchema.safeParse({
        input_fingerprint: FINGERPRINT.slice(0, 63),
        conflict_policy: "abort",
      }).success,
    ).toBe(false);
    // 带前缀
    expect(
      ReconciliationPlanSchema.safeParse({
        input_fingerprint: `sha256:${FINGERPRINT}`,
        conflict_policy: "abort",
      }).success,
    ).toBe(false);
  });

  it("ReconciliationPlan：conflict_policy 取值受限", () => {
    for (const policy of ["abort", "use-version", "use-baseline"]) {
      expect(
        ReconciliationPlanSchema.safeParse({
          input_fingerprint: FINGERPRINT,
          conflict_policy: policy,
        }).success,
      ).toBe(true);
    }
    expect(
      ReconciliationPlanSchema.safeParse({
        input_fingerprint: FINGERPRINT,
        conflict_policy: "use-host",
      }).success,
    ).toBe(false);
  });

  it("RevertAnchor：docs_ref 以 refs/tags/ 开头", () => {
    expect(RevertAnchorSchema.safeParse({ docs_ref: "refs/tags/ait/v3.5" }).success).toBe(true);
    expect(RevertAnchorSchema.safeParse({ docs_ref: "ait/v3.5" }).success).toBe(false);
    expect(RevertAnchorSchema.safeParse({ docs_ref: "refs/heads/main" }).success).toBe(false);
    expect(RevertAnchorSchema.parse({ docs_ref: "refs/tags/v1" }).code_result).toBeNull();
  });

  it("RecoveryJournal：phase 取值受限且默认 prepared", () => {
    const minimal = RecoveryJournalSchema.parse({ docs_head: "a", docs_target: "b" });
    expect(minimal.phase).toBe("prepared");
    expect(minimal.host_head).toBeNull();
    expect(minimal.host_target).toBeNull();
    expect(minimal.later_versions).toEqual([]);
    expect(minimal.diagnostic).toBeNull();
    for (const phase of ["prepared", "applying", "compensating", "recovery_pending"]) {
      expect(
        RecoveryJournalSchema.safeParse({ docs_head: "a", docs_target: "b", phase }).success,
      ).toBe(true);
    }
    expect(
      RecoveryJournalSchema.safeParse({ docs_head: "a", docs_target: "b", phase: "done" }).success,
    ).toBe(false);
  });

  it("HistoricalAnchorRepair：verified 默认 true，docs_ref 受限", () => {
    const parsed = HistoricalAnchorRepairSchema.parse({
      version: "v3.0",
      source: "manual",
      docs_ref: "refs/tags/ait/v3.0",
      repaired_at: ISO,
    });
    expect(parsed.verified).toBe(true);
    expect(
      HistoricalAnchorRepairSchema.safeParse({
        version: "v3.0",
        source: "manual",
        docs_ref: "ait/v3.0",
        repaired_at: ISO,
      }).success,
    ).toBe(false);
  });

  it("全部 schema 运行期导出存在", () => {
    const schemas: Record<string, z.ZodType> = {
      ActionSchema,
      StateSchema,
      VersionPhaseSchema,
      ChangeTypeSchema,
      ArtifactScopeSchema,
      ProjectConfigSchema,
      LocalConfigSchema,
      BaselineChunkEntrySchema,
      BaselineIndexSchema,
      DiscussionUsageSchema,
      VersionChunkEntrySchema,
      CommitEntrySchema,
      VersionIndexStatsSchema,
      VersionIndexSchema,
      SpecSchema,
      EdgeSchema,
      SpecGraphSchema,
      GenerationArtifactStateSchema,
      StoredGenerationReceiptSchema,
      GenerationDeliveryRecordSchema,
      GenerationStateSchema,
      ReconciliationOperationSchema,
      ReconciliationPlanSchema,
      RevertAnchorSchema,
      RecoveryJournalSchema,
      HistoricalAnchorRepairSchema,
      VersionMetaSchema,
      ChangeRecordSchema,
      NextActionSchema,
      CoreResultSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(typeof schema.parse, name).toBe("function");
      expect(typeof schema.safeParse, name).toBe("function");
    }
    // 编译期同名类型存在性见证（运行期恒真）
    const typeWitness: [
      Action?,
      State?,
      VersionPhase?,
      ArtifactScope?,
      BaselineIndex?,
      VersionIndex?,
      VersionChunkEntry?,
      VersionMeta?,
      ChangeRecord?,
      SpecGraph?,
      ProjectConfig?,
      LocalConfig?,
      CoreResult?,
      NextAction?,
      GenerationArtifactState?,
      StoredGenerationReceipt?,
      GenerationReceipt?,
      GenerationDeliveryRecord?,
      GenerationState?,
      GenerationDeliveryInput?,
      GenerationVerification?,
    ] = [];
    expect(typeWitness).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// schemas 生成状态
// ---------------------------------------------------------------------------

describe("schemas 生成状态", () => {
  it.each([
    { name: "版本", state: MIN_GENERATION_STATE, file: "generation-version.yaml" },
    { name: "baseline", state: MIN_BASELINE_GENERATION_STATE, file: "generation-baseline.yaml" },
  ])("$name 交付与回执合法，dump→load 保留全部绑定字段", ({ state, file }) => {
    const parsed = GenerationStateSchema.parse(state);
    expect(parsed).toEqual(state);
    withTempDir((dir) => {
      const path = join(dir, file);
      writeFileSync(path, dumpModel(parsed), "utf-8");
      expect(loadModel(path, GenerationStateSchema)).toEqual(state);
    });
  });

  it("VersionMeta 携带 generation 往返不丢失交付、回执与生成前制品状态", () => {
    const parsed = VersionMetaSchema.parse(MIN_GENERATION_VERSION_META);
    expect(parsed.generation).toEqual(MIN_GENERATION_STATE);
    withTempDir((dir) => {
      const path = join(dir, "version.yaml");
      writeFileSync(path, dumpModel(parsed), "utf-8");
      expect(loadModel(path, VersionMetaSchema)).toEqual(parsed);
    });
  });

  it("无回执交付与空交付列表合法；epoch 必须由写入方提供", () => {
    const delivery = { ...MIN_GENERATION_DELIVERY, receipt: null };
    expect(GenerationDeliveryRecordSchema.parse(delivery)).toEqual(delivery);
    expect(GenerationStateSchema.parse({ epoch: "empty-epoch", deliveries: [] })).toEqual({
      epoch: "empty-epoch", deliveries: [],
    });
    const result = GenerationStateSchema.safeParse({ deliveries: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result.error)).toContain("epoch");
  });

  it("Python 历史 VersionMeta 缺 generation 或显式 null 时归一为无交付/回执", () => {
    // Python 历史形态没有 generation；显式 null 也表示未记录生成信息。
    const omitted = VersionMetaSchema.parse(MIN_VERSION_META);
    const explicitNull = VersionMetaSchema.parse({ ...MIN_VERSION_META, generation: null });
    expect(omitted.generation).toBeNull();
    expect(explicitNull).toEqual(omitted);
  });

  it.each([
    { state: "loaded", sha256: GENERATION_HASH },
    { state: "absent", sha256: null },
    { state: "unreadable", sha256: null },
  ])("生成前制品状态 $state 合法", (artifact) => {
    expect(GenerationArtifactStateSchema.parse(artifact)).toEqual(artifact);
    const input = {
      ...MIN_GENERATION_STATE,
      deliveries: [{ ...MIN_GENERATION_DELIVERY, before_artifact: artifact }],
    };
    expect(GenerationStateSchema.parse(input)).toEqual(input);
  });

  it.each([
    { state: "loaded", sha256: null, field: "sha256" },
    { state: "absent", sha256: GENERATION_HASH, field: "sha256" },
    { state: "unreadable", sha256: GENERATION_HASH, field: "sha256" },
    { state: "unknown", sha256: null, field: "state" },
    { state: "loaded", sha256: GENERATION_HASH.toUpperCase(), field: "sha256" },
  ])("非法制品状态 $state/$sha256 拒绝并报告 $field", ({ state, sha256, field }) => {
    const result = GenerationStateSchema.safeParse({
      ...MIN_GENERATION_STATE,
      deliveries: [{ ...MIN_GENERATION_DELIVERY, before_artifact: { state, sha256 } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result.error)).toContain(
      "deliveries.0.before_artifact." + field,
    );
  });

  it.each(["token_digest", "bundle_sha256", "spec_fingerprint"] as const)(
    "交付 %s 只接受 64 位小写 SHA-256，错误定位到该字段",
    (field) => {
      for (const hash of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), DIGEST]) {
        const result = GenerationStateSchema.safeParse({
          ...MIN_GENERATION_STATE,
          deliveries: [{ ...MIN_GENERATION_DELIVERY, [field]: hash, receipt: null }],
        });
        expect(result.success, field + "=" + hash).toBe(false);
        if (!result.success) expect(issuePaths(result.error)).toContain("deliveries.0." + field);
      }
    },
  );

  it.each(["bundle_sha256", "artifact_sha256"] as const)(
    "回执 %s 的非法 hash 拒绝并报告嵌套路径",
    (field) => {
      const result = GenerationStateSchema.safeParse({
        ...MIN_GENERATION_STATE,
        deliveries: [{
          ...MIN_GENERATION_DELIVERY,
          receipt: { ...MIN_GENERATION_RECEIPT, [field]: "not-a-sha256" },
        }],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(issuePaths(result.error)).toContain("deliveries.0.receipt." + field);
    },
  );

  it.each([
    { field: "version_created_at", path: "deliveries.0.version_created_at" },
    { field: "generated_at", path: "deliveries.0.receipt.generated_at" },
  ])("非法时间 $field 拒绝并报告字段路径", ({ field, path }) => {
    const delivery = field === "version_created_at"
      ? { ...MIN_GENERATION_DELIVERY, version_created_at: "not-a-date" }
      : { ...MIN_GENERATION_DELIVERY, receipt: { ...MIN_GENERATION_RECEIPT, generated_at: "not-a-date" } };
    const result = GenerationStateSchema.safeParse({
      ...MIN_GENERATION_STATE, deliveries: [delivery],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result.error)).toContain(path);
  });

  it.each([
    { field: "delivery_id", value: "delivery-other" },
    { field: "version", value: "v0.11" },
    { field: "version", value: null },
    { field: "tdd_root", value: "[TDD]-other" },
    { field: "target_file", value: "src/other.ts" },
    { field: "bundle_sha256", value: ARTIFACT_HASH },
  ])("回执 $field=$value 不匹配交付时拒绝并报告回执字段", ({ field, value }) => {
    const result = GenerationStateSchema.safeParse({
      ...MIN_GENERATION_STATE,
      deliveries: [{
        ...MIN_GENERATION_DELIVERY,
        receipt: { ...MIN_GENERATION_RECEIPT, [field]: value },
      }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(issuePaths(result.error)).toContain("deliveries.0.receipt." + field);
  });

  it.each(["tdd_root", "delivery_id", "token_digest"] as const)(
    "重复交付 %s 拒绝并定位第二条记录",
    (field) => {
      const other = {
        ...MIN_GENERATION_DELIVERY,
        delivery_id: "delivery-other",
        tdd_root: "[TDD]-other",
        token_digest: "d".repeat(64),
        receipt: null,
      };
      const distinct = { ...MIN_GENERATION_STATE, deliveries: [MIN_GENERATION_DELIVERY, other] };
      expect(GenerationStateSchema.safeParse(distinct).success).toBe(true);
      const result = GenerationStateSchema.safeParse({
        ...distinct,
        deliveries: [MIN_GENERATION_DELIVERY, { ...other, [field]: MIN_GENERATION_DELIVERY[field] }],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(issuePaths(result.error)).toContain("deliveries.1." + field);
    },
  );

  it.each([
    { name: "制品状态", schema: GenerationArtifactStateSchema, valid: MIN_GENERATION_DELIVERY.before_artifact },
    { name: "持久化回执", schema: StoredGenerationReceiptSchema, valid: MIN_GENERATION_RECEIPT },
    { name: "交付记录", schema: GenerationDeliveryRecordSchema, valid: MIN_GENERATION_DELIVERY },
    { name: "生成状态", schema: GenerationStateSchema, valid: MIN_GENERATION_STATE },
  ])("$name 保持严格校验，未知字段不被静默丢弃", ({ schema, valid }) => {
    expect(schema.parse(valid)).toEqual(valid);
    const result = schema.safeParse({ ...valid, __drift: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(unknownFieldPaths(result.error)).toContain("__drift");
  });

  it.each([
    { generation: "damaged", path: "generation" },
    { generation: { deliveries: [] }, path: "generation.epoch" },
    { generation: { ...MIN_GENERATION_STATE, __drift: true }, path: "generation.__drift" },
    {
      generation: {
        ...MIN_GENERATION_STATE,
        deliveries: [{ ...MIN_GENERATION_DELIVERY, token_digest: "bad-hash" }],
      },
      path: "generation.deliveries.0.token_digest",
    },
  ])("VersionMeta 损坏的新字段 $path 必须拒绝，不能归一成 null", ({ generation, path }) => {
    const result = VersionMetaSchema.safeParse({ ...MIN_VERSION_META, generation });
    expect(result.success).toBe(false);
    if (!result.success) expect(unknownFieldPaths(result.error)).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// schemas 配置
// ---------------------------------------------------------------------------

describe("schemas 配置", () => {
  for (const c of OPEN_CONFIG_CASES) {
    it(c.name + "：generation_receipts 缺省/report/block 合法且未知配置保留", () => {
      // 缺省策略由消费方归一为 report；schema 允许历史配置没有该键。
      const omitted = c.schema.parse(c.valid) as Record<string, unknown>;
      expect(omitted["generation_receipts"]).toBeUndefined();
      for (const enforcement of ["report", "block"]) {
        const parsed = c.schema.parse({
          ...(c.valid as Record<string, unknown>),
          generation_receipts: { enforcement },
          [c.extraKey]: c.extraValue,
        }) as Record<string, unknown>;
        expect(parsed["generation_receipts"]).toEqual({ enforcement });
        expect(parsed[c.extraKey]).toEqual(c.extraValue);
      }
    });

    it.each(["warn", "ignore", "", null, false])(
      c.name + "：非法 generation_receipts.enforcement=%s 拒绝，不当作缺省",
      (enforcement) => {
        const result = c.schema.safeParse({ generation_receipts: { enforcement } });
        expect(result.success).toBe(false);
        if (!result.success) expect(issuePaths(result.error)).toContain("generation_receipts.enforcement");
      },
    );
  }

  // [:TEST 4] 配置含未知键时读取成功且未知键保留
  for (const c of OPEN_CONFIG_CASES) {
    it(`${c.name}：已知键通过且未知键保留`, () => {
      const known = c.schema.safeParse(c.valid);
      expect(known.success).toBe(true);

      const withExtra = c.schema.parse({
        ...(c.valid as Record<string, unknown>),
        [c.extraKey]: c.extraValue,
      }) as Record<string, unknown>;
      expect(withExtra[c.extraKey]).toEqual(c.extraValue);
      // 已知键类型仍受约束
      expect(withExtra.id_prefix_separator ?? withExtra.skill_dir).toBeDefined();
    });
  }

  it("ProjectConfig：artifact_scopes 是以范围名为键的对象，ArtifactScope 内建校验", () => {
    const parsed = ProjectConfigSchema.parse(MIN_PROJECT_CONFIG) as ProjectConfig;
    expect(Object.keys(parsed.artifact_scopes)).toEqual(["tests/"]);
    const scope = parsed.artifact_scopes["tests/"];
    expect(scope?.parent_suffix).toBe(":TEST");
    expect(scope?.enforcement).toBe("block");

    // parent_suffix 必须以 ":" 开头
    expect(ArtifactScopeSchema.safeParse({ parent_suffix: "TEST" }).success).toBe(false);
    expect(ArtifactScopeSchema.safeParse({ parent_suffix: ":TEST" }).success).toBe(true);
    // enforcement 取值受限
    expect(
      ArtifactScopeSchema.safeParse({ parent_suffix: ":TEST", enforcement: "ignore" }).success,
    ).toBe(false);
    expect(
      ArtifactScopeSchema.safeParse({ parent_suffix: ":TEST", enforcement: "warn" }).success,
    ).toBe(true);
    // 缺省值
    const minimal = ArtifactScopeSchema.parse({ parent_suffix: ":TEST" });
    expect(minimal.enforcement).toBe("warn");
    expect(minimal.exempt_test_splits).toEqual([]);
    expect(minimal.exempt_paths).toEqual([]);
  });

  it("ProjectConfig：artifact_scopes 非法成员被拒（嵌套路径报错）", () => {
    const result = ProjectConfigSchema.safeParse({
      ...MIN_PROJECT_CONFIG,
      artifact_scopes: { "tests/": { parent_suffix: "TEST" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuePaths(result.error).some((p) => p.startsWith("artifact_scopes.tests/"))).toBe(true);
    }
  });

  it("ProjectConfig：已知键类型违例被拒", () => {
    expect(ProjectConfigSchema.safeParse({ auto_snapshot_on_merge: "yes" }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ custom_relations: "refines" }).success).toBe(false);
    expect(ProjectConfigSchema.safeParse({ initialized: "true" }).success).toBe(false);
  });

  it("LocalConfig：字段可空、可缺省，未知键保留", () => {
    expect(LocalConfigSchema.safeParse({}).success).toBe(true);
    const parsed = LocalConfigSchema.parse(MIN_LOCAL_CONFIG) as LocalConfig;
    expect(parsed.cli_path).toBeNull();
    expect(parsed.wrapper_path).toBe("project-docs/.ait/ait-cli.cmd");
    expect(LocalConfigSchema.safeParse({ skill_dir: 42 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// schemas CoreResult
// ---------------------------------------------------------------------------

describe("schemas CoreResult", () => {
  // [:TEST 5] 成功/失败/带 next_action 三形态判别联合通过；失败缺 error.code 拒绝
  it("成功形态 {ok:true,data} 通过", () => {
    expect(CoreResultSchema.safeParse({ ok: true, data: { next_action: null } }).success).toBe(true);
    const input = { ok: true, data: { value: 1, nested: { items: ["item"] }, next_action: null } };
    expect(CoreResultSchema.parse(input)).toEqual(input);
  });

  it("失败形态 {ok:false,error,code} 通过", () => {
    const input = { ok: false, error: "出错了", code: "SOME_ERROR" };
    expect(CoreResultSchema.parse(input)).toEqual(input);
  });

  it.each(VALID_NEXT_ACTIONS)("成功信封接受 $type 动作并保留业务数据", (action) => {
    const input = { ok: true, data: { next_action: action, passed: false, violations: ["待处理"] } };
    expect(CoreResultSchema.parse(input)).toEqual(input);
  });

  it.each([{}, { value: 1 }])("成功结果完全缺失 next_action 拒绝：%j", (data) => {
    const result = CoreResultSchema.safeParse({ ok: true, data });
    expect(result.success).toBe(false);
    if (!result.success) expect(unknownFieldPaths(result.error)).toContain("data.next_action");
  });

  it.each([
    { action: { type: "unknown", message: "m" }, field: "type" },
    { action: { type: "present_and_collect", required_next_call: "c" }, field: "instruction" },
    { action: { type: "present_and_collect", instruction: "i" }, field: "required_next_call" },
    { action: { type: "report" }, field: "message" },
    { action: { type: "continue", next_call: "n" }, field: "instruction" },
    { action: { type: "continue", instruction: "i" }, field: "next_call" },
  ])("成功结果非法或不完整动作 $action 定位到 $field", ({ action, field }) => {
    const result = CoreResultSchema.safeParse({ ok: true, data: { next_action: action } });
    expect(result.success).toBe(false);
    if (!result.success) expect(unknownFieldPaths(result.error)).toContain("data.next_action." + field);
  });

  it("失败缺 code 拒绝，issue path 指向 code", () => {
    const result = CoreResultSchema.safeParse({ ok: false, error: "出错了" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(unknownFieldPaths(result.error)).toContain("code");
    }
  });

  it("next_action 三形态通过、未知 type 拒绝", () => {
    expect(
      NextActionSchema.safeParse({
        type: "present_and_collect",
        instruction: "i",
        required_next_call: "c",
      }).success,
    ).toBe(true);
    expect(NextActionSchema.safeParse({ type: "report", message: "m" }).success).toBe(true);
    expect(
      NextActionSchema.safeParse({ type: "continue", instruction: "i", next_call: "n" }).success,
    ).toBe(true);
    expect(NextActionSchema.safeParse({ type: "unknown", message: "m" }).success).toBe(false);
    // 形态内必填字段缺失
    expect(NextActionSchema.safeParse({ type: "report" }).success).toBe(false);
    expect(NextActionSchema.safeParse({ type: "present_and_collect", instruction: "i" }).success).toBe(false);
  });

  it("判别联合的非法判别值被拒", () => {
    expect(CoreResultSchema.safeParse({ ok: "yes", data: { next_action: null } }).success).toBe(false);
    expect(CoreResultSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 真实语料
// ---------------------------------------------------------------------------

const REPO_PROJECT_DOCS_META = resolve(
  import.meta.dirname,
  "..",
  "project-docs",
  ".meta",
);

/** AIT_CORPUS_DIRS（";" 分隔的 .meta 目录列表）→ 存在的目录列表；缺省为 ait-core 自身。 */
function corpusDirs(): { configured: string[]; existing: string[] } {
  const raw = process.env["AIT_CORPUS_DIRS"];
  const configured =
    raw !== undefined && raw.trim() !== ""
      ? raw
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "")
          .map((item) => {
            const path = resolve(item);
            return basename(path) === ".meta" ? path : join(path, ".meta");
          })
      : [REPO_PROJECT_DOCS_META];
  const existing = configured.filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return { configured, existing };
}

interface CorpusTarget {
  /** 目录内匹配的文件名正则。 */
  pattern: RegExp;
  /** 参与匹配的目录名（相对 .meta 根）。 */
  subdir: string;
  schema: z.ZodType;
  /** 用 schema 校验文件后做语义归属断言（区分基线索引与版本索引）。 */
  label: string;
}

/** 语料文件类型 → schema 映射（文件名区分基线/版本索引）。 */
const CORPUS_TARGETS: CorpusTarget[] = [
  { pattern: /^chunks-index\.yaml$/, subdir: "", schema: BaselineIndexSchema, label: "基线索引" },
  { pattern: /^chunks-index-.+\.yaml$/, subdir: "", schema: VersionIndexSchema, label: "版本索引" },
  { pattern: /^specgraph(-.+)?\.yaml$/, subdir: "", schema: SpecGraphSchema, label: "关系图" },
  { pattern: /^config\.yaml$/, subdir: "", schema: ProjectConfigSchema, label: "共享配置" },
  { pattern: /^config\.local\.yaml$/, subdir: "", schema: LocalConfigSchema, label: "本地配置" },
  { pattern: /^generation-baseline\.yaml$/, subdir: "", schema: GenerationStateSchema, label: "基线生成状态" },
  { pattern: /^.+\.yaml$/, subdir: "versions", schema: VersionMetaSchema, label: "版本元数据" },
  { pattern: /^.+\.yaml$/, subdir: "changes", schema: ChangeRecordSchema, label: "变更记录" },
];

describe("真实语料", () => {
  // [:TEST 7] 用全部 schema 读取 Python 版 ait 真实仓库（含 ait-core 自身 project-docs）
  it("语料目录下全部 .meta 文件通过对应 schema", (ctx) => {
    const { configured, existing } = corpusDirs();

    if (existing.length === 0) {
      const reason =
        `AIT_CORPUS_DIRS 未指向任何存在的 .meta 目录，跳过真实语料校验。` +
        `配置值: [${configured.join(", ")}]`;
      console.warn(reason);
      ctx.skip();
      return;
    }

    const failures: string[] = [];
    const counts = new Map<string, number>();
    const bump = (label: string): void => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    };

    const checkFile = (filePath: string, target: CorpusTarget): void => {
      bump(target.label);
      let data: unknown;
      try {
        data = parseYaml(readFileSync(filePath, "utf-8"));
      } catch (err) {
        // YAML 非法计为失败并报文件路径（不 skip）
        failures.push(`[${target.label}] ${filePath}\n    YAML 解析失败: ${(err as Error).message}`);
        return;
      }
      const result = target.schema.safeParse(data);
      if (!result.success) {
        const detail = result.error.issues
          .slice(0, 6)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("\n      ");
        failures.push(`[${target.label}] ${filePath}\n      ${detail}`);
      }
    };

    for (const dir of existing) {
      for (const target of CORPUS_TARGETS) {
        const base = target.subdir === "" ? dir : join(dir, target.subdir);
        let entries: string[];
        try {
          entries = readdirSync(base);
        } catch {
          // 目录不存在（如某语料缺 changes/）→ 该类型无文件，不算失败
          continue;
        }
        for (const entry of entries) {
          if (!target.pattern.test(entry)) {
            continue;
          }
          const filePath = join(base, entry);
          if (!statSync(filePath).isFile()) {
            continue;
          }
          checkFile(filePath, target);
        }
      }
    }

    // 一次报出全部失败文件
    expect(
      failures,
      `真实语料校验失败 ${failures.length} 个文件（语料根: ${existing.join(" ; ")}）:\n` +
        failures.slice(0, 40).join("\n"),
    ).toEqual([]);

    // 语料非空自检：确认确实读到了文件（避免"零文件全绿"的假通过）
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total, `语料目录中未读到任何受校验文件: ${existing.join(" ; ")}`).toBeGreaterThan(0);
    // 基线索引与版本元数据必须存在（接管验收的关键制品）
    expect(counts.get("基线索引"), "缺少基线索引 chunks-index.yaml").toBeGreaterThan(0);
    expect(counts.get("版本元数据"), "缺少版本元数据 versions/*.yaml").toBeGreaterThan(0);
  });

  // [:TEST 7] 从真实语料中挑出 Python 早期形态样本，归一后与 Python 默认值语义一致
  it("语料中的早期形态样本归一后与 Python 默认值语义一致", (ctx) => {
    const { existing } = corpusDirs();
    if (existing.length === 0) {
      const reason = "AIT_CORPUS_DIRS 未指向任何存在的 .meta 目录，跳过早期形态样本校验。";
      console.warn(reason);
      ctx.skip();
      return;
    }

    let legacyVersionMetas = 0;
    let legacyChangeRecords = 0;
    let legacyGraphNodes = 0;
    let legacyGraphEdges = 0;

    for (const dir of existing) {
      // 版本元数据：缺后期字段（docs_commit/code_result/confirmed_plan/revert_anchor）
      const versionsDir = join(dir, "versions");
      let versionFiles: string[] = [];
      try {
        versionFiles = readdirSync(versionsDir).filter((f) => f.endsWith(".yaml"));
      } catch {
        versionFiles = [];
      }
      for (const file of versionFiles) {
        const raw = parseYaml(readFileSync(join(versionsDir, file), "utf-8")) as Record<string, unknown>;
        const legacy = !("docs_commit" in raw) || !("confirmed_plan" in raw) || raw["recovery_journal"] === null;
        if (!legacy) {
          continue;
        }
        legacyVersionMetas += 1;
        const parsed = VersionMetaSchema.parse(raw) as VersionMeta;
        // 缺省字段一律落到 Python 默认值
        expect(parsed.docs_commit === null || typeof parsed.docs_commit === "string").toBe(true);
        expect(parsed.code_result === null || typeof parsed.code_result === "string").toBe(true);
        expect(parsed.confirmed_plan === null || typeof parsed.confirmed_plan === "object").toBe(true);
        expect(parsed.revert_anchor === null || typeof parsed.revert_anchor === "object").toBe(true);
        expect(parsed.recovery_journal === null || typeof parsed.recovery_journal === "object").toBe(true);
        expect(Array.isArray(parsed.historical_anchor_repairs)).toBe(true);
        if (!("generation" in raw) || raw["generation"] === null) {
          expect(parsed.generation, join(versionsDir, file)).toBeNull();
        }
        expect(parsed.owner.length).toBeGreaterThan(0);
        expect(typeof parsed.phase).toBe("string");
      }

      // 变更记录：缺 discussion_usage（早期 Python 形态）
      const changesDir = join(dir, "changes");
      let changeFiles: string[] = [];
      try {
        changeFiles = readdirSync(changesDir).filter((f) => f.endsWith(".yaml"));
      } catch {
        changeFiles = [];
      }
      for (const file of changeFiles) {
        const raw = parseYaml(readFileSync(join(changesDir, file), "utf-8")) as Record<string, unknown>;
        if ("discussion_usage" in raw) {
          continue;
        }
        legacyChangeRecords += 1;
        const parsed = ChangeRecordSchema.parse(raw) as ChangeRecord;
        expect(parsed.discussion_usage).toBeNull();
        expect(["ADD", "MODIFY", "DELETE"]).toContain(parsed.type);
      }

      // 关系图：节点 metadata: null / 边缺 weight 的旧写法
      let graphFiles: string[] = [];
      try {
        graphFiles = readdirSync(dir).filter((f) => /^specgraph(-.+)?\.yaml$/.test(f));
      } catch {
        graphFiles = [];
      }
      for (const file of graphFiles) {
        const raw = parseYaml(readFileSync(join(dir, file), "utf-8")) as {
          specs?: Array<Record<string, unknown>>;
          edges?: Array<Record<string, unknown>>;
        };
        // 关系图历史写法：节点 metadata 为 null（视同 {}）、边缺 weight 或写数字字符串。
        // 归一后必须给出确定形态，不得残留 null/字符串。
        for (const spec of raw.specs ?? []) {
          const isLegacyShape = spec["metadata"] === null || !("title" in spec);
          if (!isLegacyShape) {
            continue;
          }
          legacyGraphNodes += 1;
          const parsed = SpecSchema.parse(spec);
          expect(parsed.metadata).toEqual({});
          expect(typeof parsed.title).toBe("string");
        }
        for (const edge of raw.edges ?? []) {
          const isLegacyShape = !("weight" in edge) || typeof edge["weight"] === "string";
          if (!isLegacyShape) {
            continue;
          }
          legacyGraphEdges += 1;
          const parsed = EdgeSchema.parse(edge);
          expect(typeof parsed.weight).toBe("number");
          expect(Number.isFinite(parsed.weight)).toBe(true);
        }
      }
    }

    // 早期形态样本的覆盖度：样本存在则上方断言已逐条核验；不存在不算失败。
    // ait-core 自身语料全部由 ait-core 写出（恒为当前形态），故只有 AIT-project 语料
    // 会提供"缺后期字段/缺 discussion_usage"的历史样本——用 AIT_CORPUS_DIRS 指向它时
    // 覆盖度自检才有下界。这里只要求"至少有一类历史样本被真实验证过"，避免整段空转。
    const legacySamples =
      legacyVersionMetas + legacyChangeRecords + legacyGraphNodes + legacyGraphEdges;
    expect(
      legacySamples,
      `语料中未发现任何 Python 历史形态样本（已扫描语料根: ${existing.join(" ; ")}），` +
        `该用例退化为空转——请确认 AIT_CORPUS_DIRS 是否包含 Python 版 ait 的历史语料`,
    ).toBeGreaterThan(0);
  });
});
