import { AsyncLocalStorage } from "node:async_hooks";

export type ProgressStage =
  | "read"
  | "validate"
  | "assemble"
  | "write_bundle"
  | "register_delivery"
  | "acceptance"
  | "git"
  | "persist";

type ProgressStatus = "started" | "completed" | "failed";
type ProgressListener = (event: {
  stage: ProgressStage;
  status: ProgressStatus;
}) => void;

const listeners = new AsyncLocalStorage<ProgressListener>();

/** Observe work and its asynchronous descendants without changing its return value. */
export function withProgress<T>(listener: ProgressListener, work: () => T): T {
  return listeners.run(listener, work);
}

/** Report an actual operation stage to the listener in the current async context. */
export function reportProgress(stage: ProgressStage, status: ProgressStatus): void {
  const listener = listeners.getStore();
  if (listener === undefined) return;

  try {
    listener({ stage, status });
  } catch {
    // Observation must never retry, roll back, or interrupt the business operation.
  }
}
