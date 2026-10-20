export { dispatch } from "./cli/dispatcher.js";
export { getSessionContext } from "./orchestration/session-context.js";
export { evaluateWriteGuard } from "./orchestration/guard-decisions.js";
export {
  issueGenerationToken,
  registerGenerationReceipt,
  verifyGenerationReceipts,
} from "./orchestration/generation-receipts.js";

export type {
  CoreResult,
  NextAction,
  GenerationDeliveryInput,
  GenerationReceipt,
  GenerationVerification,
} from "./doc-model/schemas.js";
export type { ProjectRoot } from "./foundation/root.js";
export type { SessionContext, LayerCounts } from "./orchestration/session-context.js";
export type { GuardInput, GuardDecision } from "./orchestration/guard-decisions.js";
