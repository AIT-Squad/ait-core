import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { ApiResult, CoreProgressEvent } from "./types.js";

interface OperationRequest {
  cwd: string;
  operation: string;
  input: unknown;
  operationId: string;
}

type Failure = Extract<ApiResult<object>, { ok: false }>;

function failure(error: unknown): Failure {
  let code = "INTERNAL_ERROR";
  let message = "Worker 执行失败";
  try {
    message = String(error);
  } catch {
    // Even an unprintable thrown value must produce a valid error envelope.
  }
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      const value: unknown = Reflect.get(error, "code");
      if (typeof value === "string" && value.length > 0) code = value;
    } catch {
      // Error accessors are not allowed to prevent reporting the failure.
    }
    try {
      const value: unknown = Reflect.get(error, "message");
      if (typeof value === "string") message = value;
    } catch {
      // Keep the best available printable representation.
    }
  }
  return { ok: false, code, error: message };
}

/** Check the transport envelope; business input validation belongs to operations. */
function request(value: unknown): OperationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker 请求须为对象");
  }
  const record = value as Record<string, unknown>;
  const fields = ["cwd", "operation", "input", "operationId"];
  if (Object.keys(record).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(record, key))) {
    throw new Error("Worker 请求字段非法");
  }
  if (typeof record.cwd !== "string" || record.cwd.trim().length === 0
    || typeof record.operation !== "string" || record.operation.trim().length === 0
    || typeof record.operationId !== "string" || record.operationId.trim().length === 0) {
    throw new Error("Worker 请求缺少有效的 cwd、operation 或 operationId");
  }
  return {
    cwd: record.cwd, operation: record.operation,
    input: record.input, operationId: record.operationId,
  };
}

async function run(port: MessagePort, input: unknown): Promise<void> {
  let completed = false;
  const finish = (result: ApiResult<object>): void => {
    if (completed) return;
    completed = true;
    try {
      try {
        port.postMessage({ kind: "result", result });
      } catch (error) {
        // A domain result that cannot be cloned is a transport failure. The
        // fallback contains only strings and booleans and is always cloneable.
        port.postMessage({ kind: "result", result: failure(error) });
      }
    } catch {
      // A closed parent port cannot receive a result; still release our handles.
    } finally {
      process.off("uncaughtException", onUnhandled);
      process.off("unhandledRejection", onUnhandled);
      port.close();
    }
  };
  const onUnhandled = (error: unknown): void => finish(failure(error));
  process.on("uncaughtException", onUnhandled);
  process.on("unhandledRejection", onUnhandled);

  try {
    const operation = request(input);
    // Loading failures are reported through the same envelope. Importing this
    // entry on the main thread never loads the domain graph or installs hooks.
    const [{ executeOperation }, { withProgress }] = await Promise.all([
      import("./operations.js"),
      import("../foundation/progress.js"),
    ]);
    const data = await withProgress((progress) => {
      if (completed) return;
      const event: CoreProgressEvent = {
        stage: progress.stage,
        status: progress.status,
        operation: operation.operation,
        operationId: operation.operationId,
      };
      try {
        port.postMessage({ kind: "progress", event });
      } catch {
        // Display delivery must never change or retry an executed operation.
      }
    }, () => executeOperation(operation.cwd, operation.operation, operation.input));
    finish({ ok: true, data });
  } catch (error) {
    finish(failure(error));
  }
}

// The entry has no filesystem, output or listener side effects when imported
// by the host. Only a worker's dedicated parent port activates execution.
if (!isMainThread && parentPort !== null) {
  void run(parentPort, workerData);
}
