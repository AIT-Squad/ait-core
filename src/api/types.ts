/** Public, transport-independent contracts. All imports and exports are type-only. */
import type {
  BaselineIndex,
  GenerationReceipt,
  GenerationVerification,
  SpecGraph,
  VersionPhase,
} from "../doc-model/schemas.js";
import type { InitResult } from "../init/init-manager.js";
import type { GovernanceFinding } from "../new-model/governance.js";
import type {
  ConfirmResult as LayerConfirmResult,
  CreateResult as DocumentResult,
  DecomposeResult,
  RevertResult as LayerRevertResult,
} from "../new-model/model-manager.js";
import type { Violation } from "../new-model/validator.js";
import type { GuardDecision } from "../orchestration/guard-decisions.js";
import type { SessionContext } from "../orchestration/session-context.js";
import type { SearchHit } from "../search/keyword-search.js";
import type { EdgeRel, ViewEdge } from "../specgraph/graph-model.js";
import type { ImpactResult } from "../specgraph/queries.js";
import type { MergeResult as VersionMergeResult } from "../versioning/merge-engine.js";
import type { PushReport } from "../versioning/publish.js";
import type {
  AcceptanceOutcome as AcceptanceResult,
  BackfillRevertTagsResult as BackfillTagsResult,
  ConfirmResult as VersionConfirmResult,
  RevertResult as VersionRevertResult,
} from "../versioning/version-manager.js";

export type {
  BaselineChunkEntry,
  BaselineIndex,
  Edge as StoredEdge,
  GenerationReceipt,
  GenerationVerification,
  Spec,
  SpecGraph,
  VersionPhase,
} from "../doc-model/schemas.js";
export type { InitResult } from "../init/init-manager.js";
export type { GovernanceFinding } from "../new-model/governance.js";
export type {
  ConfirmResult as LayerConfirmResult,
  CreateResult as DocumentResult,
  DecomposeResult,
  DecomposeWritten as DecomposeWrittenResult,
  DiscussionContextResult as DiscussionResult,
  EdgeRef,
  RevertResult as LayerRevertResult,
  SkipContextAudit,
  WrittenResult as DocumentWrittenResult,
} from "../new-model/model-manager.js";
export type { Violation } from "../new-model/validator.js";
export type { GuardDecision } from "../orchestration/guard-decisions.js";
export type { LayerCounts, SessionContext } from "../orchestration/session-context.js";
export type { SearchHit } from "../search/keyword-search.js";
export type { EdgeRel, ViewEdge } from "../specgraph/graph-model.js";
export type { ImpactResult } from "../specgraph/queries.js";
export type { MergeResult as VersionMergeResult } from "../versioning/merge-engine.js";
export type { PushReport, PushResult } from "../versioning/publish.js";
export type {
  AcceptanceOutcome as AcceptanceResult,
  BackfillRevertTagsResult as BackfillTagsResult,
  BackfillSkip,
  BackfillSkipReason,
  ConfirmResult as VersionConfirmResult,
  RevertResult as VersionRevertResult,
} from "../versioning/version-manager.js";

export type ApiResult<T extends object> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string };

export type R<T extends object> = Promise<ApiResult<T>>;

/** Generic argv result; named API methods retain their precise business DTO. */
export type CoreResult = ApiResult<Record<string, unknown>>;

/** Only the CLI uses this projection; the API always returns the complete DTO. */
export interface CliPresentation {
  format: "yaml" | "json";
  projection: "baseline-items";
}

export type CliDispatchResult =
  | { ok: true; data: Record<string, unknown>; presentation?: CliPresentation }
  | { ok: false; code: string; error: string };

export type ProgressStage =
  | "read"
  | "validate"
  | "assemble"
  | "write_bundle"
  | "register_delivery"
  | "acceptance"
  | "git"
  | "persist";

export type ProgressStatus = "started" | "completed" | "failed";

export interface CoreProgressEvent {
  operationId: string;
  operation: string;
  stage: ProgressStage;
  status: ProgressStatus;
}

export interface CoreApiOptions {
  onProgress?: (event: CoreProgressEvent) => void;
}

export type Direction = "in" | "out" | "both";
export type LayerScope = "prd" | "fsd" | "tdd";
export type SearchScope = "baseline" | "all";
export type StateFormat = "markdown" | "json";
export type GitAvailability = "committed" | "unavailable";

export interface InitInput {
  name?: string;
  check?: boolean;
  refreshWrapper?: boolean;
}

export interface VersionInput {
  version: string;
}

export interface OptionalVersionInput {
  version?: string;
}

export interface VersionRevertInput extends VersionInput {
  confirm?: boolean;
}

export interface DocumentInput {
  id: string;
  parent?: string;
  content?: string;
  action?: "add" | "modify";
  overrides?: string;
  contextToken?: string;
  skipContext?: boolean;
  file?: string;
}

export type PrdInput = Omit<DocumentInput, "parent">;

export type DecomposeInput = Omit<DocumentInput, "id" | "parent"> & {
  parentSplit: string;
  childRootId: string;
};

export interface DeliveryPrepareInput {
  tddRootId: string;
  version?: string;
  output?: "memory" | "file";
}

export interface GraphQueryInput {
  target: string;
  direction?: Direction;
  rels?: EdgeRel[];
  version?: string;
}

export interface GraphImpactInput {
  target: string;
}

export interface SearchInput {
  query: string;
  scope?: SearchScope;
  regexp?: boolean;
}

export interface BaselineSummaryInput {
  scope?: LayerScope;
}

export interface StateSaveInput extends OptionalVersionInput {
  format?: StateFormat;
}

export interface AcceptanceSetInput {
  command: string;
}

export interface PushInput {
  dryRun?: boolean;
}

export interface GenerationReceiptInput {
  generationToken: string;
}

export interface GenerationStatusInput extends VersionInput {
  tddRootId?: string;
}

export interface GuardEvaluateInput {
  toolName: string;
  input: unknown;
}

export interface DocumentVersionResult {
  version: string;
}

export interface ProjectCheckResult {
  ok: boolean;
  missing: string[];
}

export type InitResponse = InitResult | ProjectCheckResult;

export interface VersionCreateResult {
  version: string;
  created_at: string;
  based_on: string | null;
}

export interface VersionCommitResult {
  committed: string[];
  changes: string[];
}

export interface VersionStatus {
  version: string;
  phase: VersionPhase;
  working: string[];
  staged: string[];
  committed: string[];
  by_action: Record<string, number>;
}

export interface DeliveryMetadata {
  sha256: string;
  bytes: number;
  version: string | null;
  target_file: string;
  tdd_root: string;
  source_file: string;
  generation_token: string;
}

export interface MemoryDelivery extends DeliveryMetadata {
  content: string;
  target_state: "loaded" | "absent" | "unreadable";
}

export interface DeliveryPointer extends DeliveryMetadata {
  bundle_path: string;
}

export interface DepsResult {
  found: boolean;
  target: string;
  direction: Direction;
  edges: ViewEdge[];
}

export interface ValidationReport {
  version: string;
  passed: boolean;
  violations: Violation[];
  policy_violations: GovernanceFinding[];
  warnings: GovernanceFinding[];
  target_file_missing: GovernanceFinding[];
  derives_residue: GovernanceFinding[];
}

export interface SearchResult {
  query: string;
  count: number;
  hits: SearchHit[];
}

export interface BaselineSummaryItem {
  id: string;
  heading: string;
  summary: string | null;
}

export interface BaselineSummary {
  scope: "all" | LayerScope;
  items: BaselineSummaryItem[];
}

export interface BaselineStats {
  docs: { prd: number; fsd: number; tdd: number };
  chunks: number;
  edges: Record<EdgeRel, number>;
  versions: string[];
}

export interface StatePanel {
  version: string;
  title: string | null;
  phase: string;
  prd_locked: boolean;
  impl_locked: boolean;
  merged: boolean;
  working: string[];
  staged: string[];
  committed: string[];
  by_action: Record<string, number>;
  prd_chunks: string[];
  fsd_chunks: string[];
  tdd_chunks: string[];
  counts: {
    working: number;
    staged: number;
    committed: number;
    prd: number;
    fsd: number;
    tdd: number;
  };
}

export interface MarkdownState {
  version: string;
  format: "markdown";
  content: string;
}

export type StateSaveResult = (StatePanel | MarkdownState) & { saved_to: string };

export interface AcceptanceConfigResult {
  command: string | null;
}

export interface VersionSummary {
  version: string;
  title: string | null;
  phase: VersionPhase;
  merged: boolean;
  created_at: string;
  merged_at: string | null;
  based_on: string | null;
}

export interface VersionListResult {
  versions: VersionSummary[];
}

export interface VersionInspection {
  version: string;
  phase: VersionPhase;
  based_on: string | null;
  confirmation: {
    state: "missing" | "valid" | "stale" | "not_applicable";
    plan_fingerprint: string | null;
    current_fingerprint: string | null;
    planned_operations: number;
  };
  bindings: {
    docs_ref: string | null;
    docs_commit: string | null;
    code_base: string | null;
    code_result: string | null;
    docs_anchor_resolvable: boolean | null;
    host_anchor_resolvable: boolean | null;
  };
  recovery: {
    state: "none" | "recorded";
    phase: "prepared" | "applying" | "compensating" | "recovery_pending" | null;
    diagnostic: string | null;
  };
}

export interface GenerationItemStatus {
  tdd_root: string;
  target_file: string;
  delivery_present: boolean;
  receipt_present: boolean;
  artifact_state: "loaded" | "absent" | "unreadable";
  artifact_sha256: string | null;
  receipt_artifact_sha256: string | null;
  findings: Array<{ code: string; message: string }>;
}

export interface GenerationStatus {
  version: string;
  enforcement: "report" | "block";
  items: GenerationItemStatus[];
}

export interface EffectiveGovernancePolicy {
  generation_receipts: { enforcement: "report" | "block" };
  target_file_existence: { enforcement: "warn" | "block" };
  derives_residue: { enforcement: "warn" | "block" };
  artifact_scopes: Array<{
    prefix: string;
    parent_suffix: string;
    enforcement: "warn" | "block";
    exempt_paths: string[];
    exempt_test_splits: string[];
  }>;
}

export interface ProjectApi {
  documentVersion(): R<DocumentVersionResult>;
  init(input?: InitInput): R<InitResponse>;
}

export interface VersionApi {
  create(input: VersionInput): R<VersionCreateResult>;
  commit(input: VersionInput): R<VersionCommitResult>;
  status(input: VersionInput): R<VersionStatus>;
  confirm(input: VersionInput): R<VersionConfirmResult>;
  merge(input: VersionInput): R<VersionMergeResult>;
  revert(input: VersionRevertInput): R<VersionRevertResult>;
  backfillTags(): R<BackfillTagsResult>;
  list(): R<VersionListResult>;
  inspect(input: VersionInput): R<VersionInspection>;
}

export interface PrdApi {
  create(input: PrdInput): R<DocumentResult>;
  confirm(): R<LayerConfirmResult>;
  revert(): R<LayerRevertResult>;
}

export interface FsdApi {
  create(input: DocumentInput): R<DocumentResult>;
  confirm(): R<LayerConfirmResult>;
  revert(): R<LayerRevertResult>;
  decompose(input: DecomposeInput): R<DecomposeResult>;
}

export interface TddApi {
  create(input: DocumentInput): R<DocumentResult>;
  confirm(): R<LayerConfirmResult>;
  revert(): R<LayerRevertResult>;
}

export interface DeliveryApi {
  prepare(input: DeliveryPrepareInput & { output: "file" }): R<DeliveryPointer>;
  prepare(input: DeliveryPrepareInput & { output?: "memory" }): R<MemoryDelivery>;
  prepare(input: DeliveryPrepareInput): R<MemoryDelivery | DeliveryPointer>;
}

export interface GraphApi {
  query(input: GraphQueryInput): R<DepsResult>;
  impact(input: GraphImpactInput): R<ImpactResult>;
  sync(): R<SpecGraph>;
  export(input?: OptionalVersionInput): R<SpecGraph>;
  validateNewModel(input?: OptionalVersionInput): R<ValidationReport>;
}

export interface SearchApi {
  query(input: SearchInput): R<SearchResult>;
  baselineSummary(input?: BaselineSummaryInput): R<BaselineSummary>;
  baselineStats(): R<BaselineStats>;
}

export interface StateApi {
  get(input?: OptionalVersionInput): R<StatePanel>;
  render(input?: OptionalVersionInput): R<MarkdownState>;
  save(input?: StateSaveInput): R<StateSaveResult>;
}

export interface IndexApi {
  rebuild(): R<BaselineIndex>;
}

export interface AcceptanceApi {
  set(input: AcceptanceSetInput): R<AcceptanceConfigResult>;
  show(): R<AcceptanceConfigResult>;
  run(): R<AcceptanceResult>;
}

export interface PublishApi {
  push(input?: PushInput): R<PushReport>;
}

export interface SessionApi {
  get(): R<SessionContext>;
}

export interface GenerationApi {
  registerReceipt(input: GenerationReceiptInput): R<GenerationReceipt>;
  verifyReceipts(input: VersionInput): R<GenerationVerification>;
  status(input: GenerationStatusInput): R<GenerationStatus>;
}

export interface GovernanceApi {
  getPolicy(): R<EffectiveGovernancePolicy>;
}

export interface GuardApi {
  evaluate(input: GuardEvaluateInput): ApiResult<GuardDecision>;
}

export interface CoreApi {
  project: ProjectApi;
  version: VersionApi;
  prd: PrdApi;
  fsd: FsdApi;
  tdd: TddApi;
  delivery: DeliveryApi;
  graph: GraphApi;
  search: SearchApi;
  state: StateApi;
  index: IndexApi;
  acceptance: AcceptanceApi;
  publish: PublishApi;
  session: SessionApi;
  generation: GenerationApi;
  governance: GovernanceApi;
  guard: GuardApi;
}
