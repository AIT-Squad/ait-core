import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isProxy } from "node:util/types";
import { Worker } from "node:worker_threads";
import { evaluateWriteGuard } from "../orchestration/guard-decisions.js";
import type { ApiResult, CoreApi, CoreApiOptions, CoreProgressEvent } from "./types.js";

type IoGroup = Exclude<keyof CoreApi, "guard">;
type Operation = {
  [Group in IoGroup]: `${Group}.${keyof CoreApi[Group] & string}`;
}[IoGroup];
type Failure = Extract<ApiResult<object>, { ok: false }>;
type IoMethod = (...args: never[]) => Promise<ApiResult<object>>;

class UsageError extends Error {
  readonly code = "USAGE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Read data properties without invoking caller getters or losing symbols. */
function dataEntries(input: object): Array<[string, unknown]> {
  if (isProxy(input)) throw new UsageError("参数不能使用代理对象");
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") throw new UsageError("参数不能使用 symbol 字段");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new UsageError(`参数不能使用访问器：${key}`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function plainObject(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input) || isProxy(input)) return false;
  const prototype: unknown = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Snapshot transport data only; executeOperation owns all business schemas.
 * Retain unknown and non-enumerable string fields so worker validation sees
 * them, including undefined values. Never normalize a missing argument to {}.
 */
function snapshotArgument(args: unknown[]): unknown {
  if (args.length > 1) throw new UsageError("只接受一个参数对象");
  const seen = new WeakMap<object, object>();
  const copy = (value: unknown): unknown => {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new UsageError("参数包含无法传输的数据");
    }
    if (value === null || typeof value !== "object") return value;
    if (isProxy(value) || (!Array.isArray(value) && !plainObject(value))) {
      throw new UsageError("参数对象须为普通对象或数组");
    }
    const previous = seen.get(value);
    if (previous !== undefined) return previous;
    const snapshot: object = Array.isArray(value) ? new Array<unknown>(value.length) : {};
    seen.set(value, snapshot);
    for (const [key, item] of dataEntries(value)) {
      if (Array.isArray(value) && key === "length") continue;
      Object.defineProperty(snapshot, key, {
        value: copy(item), enumerable: true, writable: true, configurable: true,
      });
    }
    return snapshot;
  };
  try {
    return copy(args[0]);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError("无法建立参数快照");
  }
}

/** Factory options and the synchronous guard never cross the worker boundary. */
function localInput(args: unknown[], allowed: readonly string[], optional = false): Record<string, unknown> {
  if (args.length > 1) throw new UsageError("只接受一个参数对象");
  const input = args[0] === undefined && optional ? {} : args[0];
  if (!plainObject(input)) throw new UsageError("参数须为普通对象");
  const entries = dataEntries(input);
  for (const [key] of entries) {
    if (!allowed.includes(key)) throw new UsageError(`未知参数：${key}`);
  }
  return Object.fromEntries(entries);
}

const writeOperations = new Set<Operation>([
  "version.create", "version.commit", "version.confirm", "version.merge", "version.revert", "version.backfillTags",
  "prd.confirm", "prd.revert", "fsd.confirm", "fsd.revert", "tdd.confirm", "tdd.revert",
  "delivery.prepare", "graph.sync", "state.save", "index.rebuild",
  "acceptance.set", "acceptance.run", "generation.registerReceipt",
]);

/** Scheduling classification is independent of parameter validity. */
function isWrite(operation: Operation, input: unknown): boolean {
  if (operation === "project.init") return !isRecord(input) || input.check !== true;
  if (operation === "publish.push") return !isRecord(input) || input.dryRun !== true;
  if (operation === "prd.create" || operation === "fsd.create"
    || operation === "tdd.create" || operation === "fsd.decompose") {
    return isRecord(input) && input.content !== undefined;
  }
  return writeOperations.has(operation);
}

function failure(error: unknown): Failure {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  return {
    ok: false,
    code: typeof record?.code === "string" && record.code.length > 0 ? record.code : "INTERNAL_ERROR",
    error: typeof record?.message === "string" ? record.message : String(error),
  };
}

// All clients in this module share the queue and callback context. No project
// lookup, filesystem access or worker startup happens while creating a client.
const writes = new Map<string, Promise<void>>();
const progressContext = new AsyncLocalStorage<boolean>();

function serialize(cwd: string, work: () => Promise<ApiResult<object>>): Promise<ApiResult<object>> {
  const normalized = path.normalize(cwd);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const previous = writes.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const finished = result.then(() => undefined, () => undefined);
  writes.set(key, finished);
  void finished.then(() => {
    if (writes.get(key) === finished) writes.delete(key);
  });
  return result;
}

function workerUrl(): URL {
  // Source tests execute only this checkout's freshly built JavaScript worker.
  // Installed packages always use the adjacent compiled worker, never user cwd.
  return new URL(import.meta.url.endsWith(".ts") ? "../../dist/src/api/worker.js" : "./worker.js", import.meta.url);
}

const progressStages = new Set(["read", "validate", "assemble", "write_bundle", "register_delivery", "acceptance", "git", "persist"]);
const progressStatuses = new Set(["started", "completed", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResult(value: unknown): value is ApiResult<object> {
  return isRecord(value) && (value.ok === true
    ? isRecord(value.data)
    : value.ok === false && typeof value.code === "string" && value.code.length > 0 && typeof value.error === "string");
}

function isProgress(value: unknown, operation: string, operationId: string): value is CoreProgressEvent {
  return isRecord(value) && value.operation === operation && value.operationId === operationId
    && typeof value.stage === "string" && progressStages.has(value.stage)
    && typeof value.status === "string" && progressStatuses.has(value.status);
}

function notify(listener: CoreApiOptions["onProgress"], event: CoreProgressEvent): void {
  if (listener === undefined) return;
  progressContext.run(true, () => {
    try {
      // Void callbacks may still be async at runtime. Observe their rejection
      // without delaying the operation or letting presentation affect its result.
      const returned: unknown = listener(event);
      void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // Progress is an observation, not a transaction hook.
    }
  });
}

function runWorker(
  cwd: string,
  operation: Operation,
  input: unknown,
  listener: CoreApiOptions["onProgress"],
): Promise<ApiResult<object>> {
  return new Promise((resolve) => {
    let worker: Worker;
    const operationId = randomUUID();
    try {
      worker = new Worker(workerUrl(), {
        workerData: { cwd, operation, input, operationId },
        // The entry is compiled JS; host eval/TS-loader flags are not required.
        execArgv: [], stdout: true, stderr: true,
      });
    } catch (error) {
      resolve(failure(error));
      return;
    }
    let pending: ApiResult<object> | undefined;
    let settled = false;
    const finish = (result: ApiResult<object>): void => {
      if (settled) return;
      settled = true;
      worker.off("message", onMessage);
      worker.off("messageerror", onError);
      worker.off("error", onError);
      worker.off("exit", onExit);
      resolve(result);
    };
    const complete = (result: ApiResult<object>): void => {
      if (pending !== undefined || settled) return;
      pending = result;
      // A result is authoritative only after executeOperation completed. Stop
      // any remaining handles and await exit before releasing the write queue.
      try {
        void worker.terminate().then(
          () => finish(result),
          (error: unknown) => finish(failure(error)),
        );
      } catch (error) {
        finish(failure(error));
      }
    };
    const onError = (error: unknown): void => complete(failure(error));
    const onExit = (code: number): void => finish(pending ?? {
      ok: false, code: "INTERNAL_ERROR", error: `Worker 在返回结果前退出（exitCode=${code}）`,
    });
    const onMessage = (message: unknown): void => {
      if (pending !== undefined || settled) return;
      if (isRecord(message) && message.kind === "progress"
        && isProgress(message.event, operation, operationId)) {
        notify(listener, message.event);
      } else if (isRecord(message) && message.kind === "result" && isResult(message.result)) {
        complete(message.result);
      } else {
        complete({ ok: false, code: "INTERNAL_ERROR", error: "Worker 返回了无效消息" });
      }
    };
    worker.on("message", onMessage);
    worker.on("messageerror", onError);
    worker.on("error", onError);
    worker.once("exit", onExit);
    // Explicit streams keep incidental domain output off the host's stdout.
    worker.stdout?.resume();
    worker.stderr?.resume();
  });
}

/** Create an inert client bound to the caller's current working directory. */
export function createCoreApi(options?: CoreApiOptions): CoreApi {
  const settings = localInput(Array.from(arguments), ["onProgress"], true);
  if (settings.onProgress !== undefined && typeof settings.onProgress !== "function") {
    throw new UsageError("参数非法：onProgress");
  }
  const listener = settings.onProgress as CoreApiOptions["onProgress"];
  const cwd = process.cwd();

  const invoke = async (operation: Operation, args: unknown[]): Promise<ApiResult<object>> => {
    try {
      const input = snapshotArgument(args);
      const writing = isWrite(operation, input);
      if (writing && progressContext.getStore() === true) {
        throw new UsageError("进度回调不能重入写操作");
      }
      const work = (): Promise<ApiResult<object>> => runWorker(cwd, operation, input, listener);
      return await (writing ? serialize(cwd, work) : work());
    } catch (error) {
      return failure(error);
    }
  };
  // The public signatures (including delivery overloads) are supplied by
  // CoreApi. Only this private bridge crosses the structured-clone boundary.
  const method = <Method extends IoMethod>(operation: Operation): Method =>
    ((...args: unknown[]) => invoke(operation, args)) as unknown as Method;

  return {
    project: { documentVersion: method("project.documentVersion"), init: method("project.init") },
    version: {
      create: method("version.create"), commit: method("version.commit"), status: method("version.status"),
      confirm: method("version.confirm"), merge: method("version.merge"), revert: method("version.revert"),
      backfillTags: method("version.backfillTags"), list: method("version.list"), inspect: method("version.inspect"),
    },
    prd: { create: method("prd.create"), confirm: method("prd.confirm"), revert: method("prd.revert") },
    fsd: {
      create: method("fsd.create"), confirm: method("fsd.confirm"), revert: method("fsd.revert"),
      decompose: method("fsd.decompose"),
    },
    tdd: { create: method("tdd.create"), confirm: method("tdd.confirm"), revert: method("tdd.revert") },
    delivery: { prepare: method("delivery.prepare") },
    graph: {
      query: method("graph.query"), impact: method("graph.impact"), sync: method("graph.sync"),
      export: method("graph.export"), validateNewModel: method("graph.validateNewModel"),
    },
    search: {
      query: method("search.query"), baselineSummary: method("search.baselineSummary"),
      baselineStats: method("search.baselineStats"),
    },
    state: { get: method("state.get"), render: method("state.render"), save: method("state.save") },
    index: { rebuild: method("index.rebuild") },
    acceptance: { set: method("acceptance.set"), show: method("acceptance.show"), run: method("acceptance.run") },
    publish: { push: method("publish.push") },
    session: { get: method("session.get") },
    generation: {
      registerReceipt: method("generation.registerReceipt"), verifyReceipts: method("generation.verifyReceipts"),
      status: method("generation.status"),
    },
    governance: { getPolicy: method("governance.getPolicy") },
    guard: {
      evaluate(...args: unknown[]) {
        try {
          const input = localInput(args, ["toolName", "input"]);
          if (typeof input.toolName !== "string" || input.toolName.trim().length === 0) {
            throw new UsageError("参数非法：toolName");
          }
          if (!Object.hasOwn(input, "input")) throw new UsageError("缺参数：input");
          return {
            ok: true,
            data: evaluateWriteGuard({ projectRoot: cwd, cwd, toolName: input.toolName, input: input.input }),
          };
        } catch (error) {
          return failure(error);
        }
      },
    },
  };
}
