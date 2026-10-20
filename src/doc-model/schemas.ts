import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// 内部辅助（不导出）
// 持久化 schema 采用"读时归一 → 严格校验"管线：字段级 preprocess 把
// Python 历史形态归一为当前形态，对象级 .strict() 拒绝剩余未知字段。
// ─────────────────────────────────────────────────────────────

const strictObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** 开放字典：已知键约束类型，未知键原样保留（仅用于配置）。 */
const openObj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/** 缺失或 null → 默认值（对象/数组默认值每次克隆，避免共享引用）。 */
const opt = <S extends z.ZodTypeAny>(schema: S, dflt: z.input<S>) =>
  z.preprocess(
    (v) => (v === undefined || v === null ? structuredClone(dflt) : v),
    schema,
  );

/** 可空字段：缺失 → null。 */
const nullableOpt = <S extends z.ZodTypeAny>(schema: S) =>
  z.preprocess((v) => (v === undefined ? null : v), schema.nullable());

const summary120 = z.string().max(120, "summary must be <= 120 characters");

/** 时间字段：接受 YAML 解析出的 Date 或 ISO 字符串，统一输出 ISO 字符串。 */
const toIso = (v: unknown): unknown =>
  v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : v;
const datetime = z.preprocess(toIso, z.string());
const datetimeNullableOpt = z.preprocess(
  (v) => (v === undefined ? null : toIso(v)),
  z.string().nullable(),
);

const intSchema = z.number().int();
const metadataSchema = z.record(z.unknown());
const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 hex digest");
const generationEnforcementSchema = z.enum(["report", "block"]);
const docsRefSchema = z
  .string()
  .refine((v) => v.startsWith("refs/tags/"), "docs_ref must be a persistent git tag ref");

// ─────────────────────────────────────────────────────────────
// 类型别名
// ─────────────────────────────────────────────────────────────

export const ActionSchema = z.enum(["add", "modify", "delete"]);
export type Action = z.infer<typeof ActionSchema>;

export const StateSchema = z.enum(["working", "staged", "committed"]);
export type State = z.infer<typeof StateSchema>;

export const VersionPhaseSchema = z.enum([
  // legacy lifecycle
  "empty",
  "prd_locked",
  "impl_locked",
  "coding",
  // new-model layer flow
  "prd-creating",
  "prd-confirm",
  "fsd-creating",
  "fsd-confirm",
  "tdd-creating",
  "tdd-confirm",
  // terminal
  "merged",
]);
export type VersionPhase = z.infer<typeof VersionPhaseSchema>;

export const ChangeTypeSchema = z.enum(["ADD", "MODIFY", "DELETE"]);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

// ─────────────────────────────────────────────────────────────
// 配置（开放字典：已知键约束类型，未知键 passthrough）
// ─────────────────────────────────────────────────────────────

const generationReceiptPolicySchema = openObj({
  enforcement: generationEnforcementSchema,
});

export const ArtifactScopeSchema = openObj({
  parent_suffix: z
    .string()
    .refine((v) => v.startsWith(":"), "parent_suffix must start with ':' (e.g. ':TEST')"),
  enforcement: opt(z.enum(["warn", "block"]), "warn"),
  exempt_test_splits: opt(z.array(z.string()), []),
  exempt_paths: opt(z.array(z.string()), []),
});
export type ArtifactScope = z.infer<typeof ArtifactScopeSchema>;

export const ProjectConfigSchema = openObj({
  id_prefix_separator: opt(z.string(), "-"),
  version_format: opt(z.string(), "{major}.{minor}"),
  auto_snapshot_on_merge: opt(z.boolean(), false),
  custom_relations: opt(z.array(z.string()), []),
  id_prefixes: opt(z.record(z.string()), {}),
  mvp_scope_tags: opt(z.array(z.string()), []),
  artifact_scopes: opt(z.record(ArtifactScopeSchema), {}),
  initialized: z.boolean().optional(),
  generation_receipts: generationReceiptPolicySchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const LocalConfigSchema = openObj({
  skill_dir: z.string().nullable().optional(),
  cli_path: z.string().nullable().optional(),
  wrapper_path: z.string().nullable().optional(),
  acceptance_command: z.string().nullable().optional(),
  generation_receipts: generationReceiptPolicySchema.optional(),
});
export type LocalConfig = z.infer<typeof LocalConfigSchema>;

// ─────────────────────────────────────────────────────────────
// 索引
// ─────────────────────────────────────────────────────────────

export const BaselineChunkEntrySchema = strictObj({
  id: z.string(),
  file: z.string(),
  heading: z.string(),
  level: intSchema,
  summary: nullableOpt(summary120),
  metadata: opt(metadataSchema, {}),
});
export type BaselineChunkEntry = z.infer<typeof BaselineChunkEntrySchema>;

export const BaselineIndexSchema = strictObj({
  version: opt(intSchema, 1),
  scope: opt(z.literal("global"), "global"),
  updated: datetimeNullableOpt,
  chunks: opt(z.array(BaselineChunkEntrySchema), []),
});
export type BaselineIndex = z.infer<typeof BaselineIndexSchema>;

export const DiscussionUsageSchema = strictObj({
  mode: z.enum(["receipt", "skipped"]),
  receipt_digest: nullableOpt(z.string()),
}).superRefine((v, ctx) => {
  if (v.mode === "receipt") {
    if (v.receipt_digest === null || !/^sha256:[0-9a-f]{64}$/.test(v.receipt_digest)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt_digest"],
        message: "receipt discussion usage requires a sha256 digest",
      });
    }
  } else if (v.receipt_digest !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receipt_digest"],
      message: "skipped discussion usage must not include a receipt digest",
    });
  }
});
export type DiscussionUsage = z.infer<typeof DiscussionUsageSchema>;

export const VersionChunkEntrySchema = strictObj({
  id: z.string(),
  file: z.string().nullable(), // null when action=delete
  heading: z.string().nullable(), // null when action=delete
  level: intSchema.nullable(), // null when action=delete
  action: ActionSchema,
  state: StateSchema,
  commit_id: nullableOpt(z.string()),
  overrides: nullableOpt(z.string()),
  amends: nullableOpt(z.string()),
  insert_after: nullableOpt(z.string()),
  base_hash: nullableOpt(z.string()),
  source_req: nullableOpt(z.string()),
  discussion_usage: nullableOpt(DiscussionUsageSchema),
  summary: nullableOpt(summary120),
  metadata: opt(metadataSchema, {}),
});
export type VersionChunkEntry = z.infer<typeof VersionChunkEntrySchema>;

export const CommitEntrySchema = strictObj({
  id: z.string(),
  timestamp: datetime,
  message: z.string(),
  chunks: z.array(z.string()),
  req_id: nullableOpt(z.string()),
});
export type CommitEntry = z.infer<typeof CommitEntrySchema>;

export const VersionIndexStatsSchema = strictObj({
  total_chunks: opt(intSchema, 0),
  by_action: opt(z.record(intSchema), {}),
  by_state: opt(z.record(intSchema), {}),
  tasks_summary: opt(z.record(intSchema), {}),
});
export type VersionIndexStats = z.infer<typeof VersionIndexStatsSchema>;

export const VersionIndexSchema = strictObj({
  version: opt(intSchema, 1),
  scope: opt(z.literal("version"), "version"),
  version_name: z.string(),
  based_on_hash: nullableOpt(z.string()),
  status: opt(z.enum(["developing", "committed", "merged"]), "developing"),
  chunks: opt(z.array(VersionChunkEntrySchema), []),
  commits: opt(z.array(CommitEntrySchema), []),
  stats: opt(VersionIndexStatsSchema, {}),
});
export type VersionIndex = z.infer<typeof VersionIndexSchema>;

// ─────────────────────────────────────────────────────────────
// 关系图（specs 为按 uri 排序的数组；节点身份为 uri）
// ─────────────────────────────────────────────────────────────

export const SpecSchema = strictObj({
  uri: z.string(),
  title: opt(z.string(), ""),
  type: opt(z.string(), "other"),
  version: opt(z.string(), "baseline"),
  chunk_id: z.string(),
  file: opt(z.string(), ""),
  metadata: opt(metadataSchema, {}),
});
export type Spec = z.infer<typeof SpecSchema>;

export const EdgeSchema = strictObj({
  src: z.string(),
  dst: z.string(),
  rel: opt(z.string(), "related"),
  weight: opt(
    z.preprocess(
      (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
      z.number().finite(),
    ),
    1.0,
  ),
  metadata: opt(metadataSchema, {}),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const SpecGraphSchema = strictObj({
  version: opt(intSchema, 1),
  updated: datetimeNullableOpt,
  specs: opt(z.array(SpecSchema), []),
  edges: opt(z.array(EdgeSchema), []),
});
export type SpecGraph = z.infer<typeof SpecGraphSchema>;

// ─────────────────────────────────────────────────────────────
// 生成交付与回执
// ─────────────────────────────────────────────────────────────

const generationDatetime = z.preprocess(toIso, z.string().datetime({ offset: true, local: true }));

export const GenerationArtifactStateSchema = strictObj({
  state: z.enum(["loaded", "absent", "unreadable"]),
  sha256: sha256Schema.nullable(),
}).superRefine((v, ctx) => {
  if ((v.state === "loaded") !== (v.sha256 !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sha256"],
      message: "loaded artifacts require a SHA-256 digest; absent/unreadable artifacts require null",
    });
  }
});
export type GenerationArtifactState = z.infer<typeof GenerationArtifactStateSchema>;

export const StoredGenerationReceiptSchema = strictObj({
  version: z.string().nullable(),
  tdd_root: z.string(),
  target_file: z.string(),
  bundle_sha256: sha256Schema,
  artifact_sha256: sha256Schema,
  generated_at: generationDatetime,
  delivery_id: z.string(),
});
export type StoredGenerationReceipt = z.infer<typeof StoredGenerationReceiptSchema>;
export type GenerationReceipt = Omit<StoredGenerationReceipt, "delivery_id">;

export const GenerationDeliveryRecordSchema = strictObj({
  delivery_id: z.string(),
  token_digest: sha256Schema,
  version: z.string().nullable(),
  version_created_at: generationDatetime.nullable(),
  tdd_root: z.string(),
  target_file: z.string(),
  bundle_sha256: sha256Schema,
  spec_fingerprint: sha256Schema,
  before_artifact: GenerationArtifactStateSchema,
  receipt: StoredGenerationReceiptSchema.nullable(),
}).superRefine((v, ctx) => {
  if (v.receipt === null) return;
  for (const field of ["delivery_id", "version", "tdd_root", "target_file", "bundle_sha256"] as const) {
    if (v.receipt[field] !== v[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", field],
        message: `receipt ${field} must match its delivery record`,
      });
    }
  }
});
export type GenerationDeliveryRecord = z.infer<typeof GenerationDeliveryRecordSchema>;

export const GenerationStateSchema = strictObj({
  epoch: z.string(),
  deliveries: z.array(GenerationDeliveryRecordSchema),
}).superRefine((v, ctx) => {
  for (const field of ["tdd_root", "delivery_id", "token_digest"] as const) {
    const seen = new Set<string>();
    v.deliveries.forEach((delivery, index) => {
      if (seen.has(delivery[field])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliveries", index, field],
          message: `generation deliveries must have unique ${field}`,
        });
      }
      seen.add(delivery[field]);
    });
  }
});
export type GenerationState = z.infer<typeof GenerationStateSchema>;

export const GenerationDeliveryInputSchema = strictObj({
  version: z.string().nullable(),
  tdd_root: z.string(),
  target_file: z.string(),
  bundle_path: z.string(),
  bundle_sha256: sha256Schema,
  bytes: intSchema.nonnegative(),
});
export type GenerationDeliveryInput = z.infer<typeof GenerationDeliveryInputSchema>;

export const GenerationVerificationSchema = strictObj({
  enforcement: generationEnforcementSchema,
  passed: z.boolean(),
  findings: z.array(strictObj({
    code: z.string(),
    tdd_root: z.string(),
    target_file: z.string(),
    message: z.string(),
  })),
});
export type GenerationVerification = z.infer<typeof GenerationVerificationSchema>;

// ─────────────────────────────────────────────────────────────
// 版本元数据
// ─────────────────────────────────────────────────────────────

export const VersionDependenciesSchema = strictObj({
  based_on: nullableOpt(z.string()),
  conflicts_with: opt(z.array(z.string()), []),
  merge_after: opt(z.array(z.string()), []),
});
export type VersionDependencies = z.infer<typeof VersionDependenciesSchema>;

/** 相对 posix 路径：非空、无 `\`、非绝对、无 `.`/`..` 段。 */
const isRelativeDocsPath = (value: string): boolean =>
  value.length > 0 &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !value.split("/").some((part) => part === "." || part === "..");

export const ReconciliationOperationSchema = strictObj({
  file: z
    .string()
    .refine(isRelativeDocsPath, "reconciliation operation file must be a relative docs path"),
  chunk_id: z.string(),
  action: ActionSchema,
  target_id: nullableOpt(z.string()),
  insert_after: nullableOpt(z.string()),
  base_hash: nullableOpt(z.string()),
  new_content: nullableOpt(z.string()),
}).superRefine((v, ctx) => {
  if ((v.action === "add" || v.action === "modify") && !v.new_content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["new_content"],
      message: "add/modify reconciliation operations require new_content",
    });
  }
});
export type ReconciliationOperation = z.infer<typeof ReconciliationOperationSchema>;

export const ReconciliationPlanSchema = strictObj({
  operations: opt(z.array(ReconciliationOperationSchema), []),
  input_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "input_fingerprint must be a lowercase SHA-256 hex digest"),
  conflict_policy: z.enum(["abort", "use-version", "use-baseline"]),
});
export type ReconciliationPlan = z.infer<typeof ReconciliationPlanSchema>;

export const RevertAnchorSchema = strictObj({
  docs_ref: docsRefSchema,
  code_result: nullableOpt(z.string()),
});
export type RevertAnchor = z.infer<typeof RevertAnchorSchema>;

export const RecoveryJournalSchema = strictObj({
  docs_head: z.string(),
  host_head: nullableOpt(z.string()),
  docs_target: z.string(),
  host_target: nullableOpt(z.string()),
  later_versions: opt(z.array(z.string()), []),
  phase: opt(z.enum(["prepared", "applying", "compensating", "recovery_pending"]), "prepared"),
  diagnostic: nullableOpt(z.string()),
});
export type RecoveryJournal = z.infer<typeof RecoveryJournalSchema>;

export const HistoricalAnchorRepairSchema = strictObj({
  version: z.string(),
  source: z.string(),
  docs_ref: docsRefSchema,
  verified: opt(z.boolean(), true),
  // Python 缺省为 datetime.now；schema 不含运行时行为，故此处必填
  repaired_at: datetime,
});
export type HistoricalAnchorRepair = z.infer<typeof HistoricalAnchorRepairSchema>;

export const VersionMetaSchema = strictObj({
  version: z.string(),
  created_at: datetime,
  merged_at: datetimeNullableOpt,
  owner: opt(z.string(), "system"),
  changes: opt(z.array(z.string()), []),
  dependencies: opt(VersionDependenciesSchema, {}),
  snapshot: nullableOpt(z.string()),
  phase: opt(VersionPhaseSchema, "empty"),
  title: nullableOpt(z.string()),
  prd_locked: opt(z.boolean(), false),
  impl_locked: opt(z.boolean(), false),
  docs_commit: nullableOpt(z.string()),
  code_base: nullableOpt(z.string()),
  code_result: nullableOpt(z.string()),
  confirmed_plan: nullableOpt(ReconciliationPlanSchema),
  revert_anchor: nullableOpt(RevertAnchorSchema),
  recovery_journal: nullableOpt(RecoveryJournalSchema),
  historical_anchor_repairs: opt(z.array(HistoricalAnchorRepairSchema), []),
  generation: nullableOpt(GenerationStateSchema),
});
export type VersionMeta = z.infer<typeof VersionMetaSchema>;

// ─────────────────────────────────────────────────────────────
// 变更记录（.meta/changes/chg-NNN.yaml 单文件单记录）
// ─────────────────────────────────────────────────────────────

export const ChangeRecordSchema = strictObj({
  id: z.string(),
  version: z.string(),
  // 大小写不敏感：add/Modify/DELETE → 大写
  type: z.preprocess((v) => (typeof v === "string" ? v.toUpperCase() : v), ChangeTypeSchema),
  target: z.string(), // "<file>#<chunk_id>"
  author: opt(z.string(), "system"),
  date: datetime,
  message: z.string(),
  base_hash: nullableOpt(z.string()),
  discussion_usage: nullableOpt(DiscussionUsageSchema),
  base_content: nullableOpt(z.string()),
  new_content: nullableOpt(z.string()),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

// ─────────────────────────────────────────────────────────────
// 输出契约
// ─────────────────────────────────────────────────────────────

// next_action 三形态
const PresentAndCollectSchema = strictObj({
  type: z.literal("present_and_collect"),
  instruction: z.string(),
  required_next_call: z.string(),
});
const ReportSchema = strictObj({
  type: z.literal("report"),
  message: z.string(),
});
const ContinueSchema = strictObj({
  type: z.literal("continue"),
  instruction: z.string(),
  next_call: z.string(),
});

export const NextActionSchema = z.discriminatedUnion("type", [
  PresentAndCollectSchema,
  ReportSchema,
  ContinueSchema,
]);
export type NextAction = z.infer<typeof NextActionSchema>;

// CoreResult 输出契约：{ok:true,data} / {ok:false,error,code}
const OkResult = strictObj({
  ok: z.literal(true),
  data: z.object({
    next_action: NextActionSchema.nullable(),
  }).passthrough(),
});
const ErrResult = strictObj({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
});

export const CoreResultSchema = z.union([OkResult, ErrResult]);
export type CoreResult = z.infer<typeof CoreResultSchema>;
