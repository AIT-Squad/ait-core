/** Shared business assembly for the public API. The CLI is only a caller. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VersionMetaSchema, type VersionMeta } from "../doc-model/schemas.js";
import { ensureWithin } from "../foundation/io.js";
import { reportProgress } from "../foundation/progress.js";
import { resolveProjectRoot, type ProjectRoot } from "../foundation/root.js";
import { loadModel } from "../foundation/yaml.js";
import { IndexManager } from "../indexing/index-manager.js";
import type { CreateOpts, DocLayer } from "../new-model/model-manager.js";

class UsageError extends Error {
  readonly code = "USAGE_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const nonemptyString = z.string().refine((value) => value.trim().length > 0, "字符串不能为空");
const versionName = nonemptyString.refine(
  (value) => !/[\\/\0]/.test(value) && value !== "." && value !== "..",
  "版本名不能包含路径分隔符、空字符或相对目录",
);
const noInput = z.object({}).strict();
const versionInput = z.object({ version: versionName }).strict();
const optionalVersionInput = z.object({ version: versionName.optional() }).strict();
const initInput = z.object({
  name: z.string().optional(),
  check: z.boolean().optional(),
  refreshWrapper: z.boolean().optional(),
}).strict();
const revertInput = versionInput.extend({ confirm: z.boolean().optional() });
const documentFields = {
  content: z.string().optional(),
  action: z.enum(["add", "modify"]).optional(),
  overrides: nonemptyString.optional(),
  contextToken: nonemptyString.optional(),
  skipContext: z.boolean().optional(),
  file: nonemptyString.optional(),
};
const prdInput = z.object({ id: nonemptyString, ...documentFields }).strict();
const documentInput = prdInput.extend({ parent: nonemptyString.optional() });
const decomposeInput = z.object({
  parentSplit: nonemptyString,
  childRootId: nonemptyString,
  ...documentFields,
}).strict();
const prepareInput = z.object({
  tddRootId: nonemptyString,
  version: versionName.optional(),
  output: z.enum(["memory", "file"]).optional(),
}).strict();
const graphInput = z.object({
  target: nonemptyString,
  version: versionName.optional(),
  direction: z.enum(["in", "out", "both"]).optional(),
  rels: z.array(z.enum(["derives", "decomposes", "details", "depends_on"])).optional(),
}).strict();
const targetInput = z.object({ target: nonemptyString }).strict();
const searchInput = z.object({
  query: z.string(),
  scope: z.enum(["baseline", "all"]).optional(),
  regexp: z.boolean().optional(),
}).strict();
const summaryInput = z.object({ scope: z.enum(["prd", "fsd", "tdd"]).optional() }).strict();
const saveInput = optionalVersionInput.extend({ format: z.enum(["markdown", "json"]).optional() });
const commandInput = z.object({ command: z.string() }).strict();
const pushInput = z.object({ dryRun: z.boolean().optional() }).strict();
const receiptInput = z.object({ generationToken: nonemptyString }).strict();
const generationInput = versionInput.extend({ tddRootId: nonemptyString.optional() });
const guardInput = z.object({ toolName: nonemptyString, input: z.unknown() }).strict();

/** Validate before resolving a project or invoking any domain operation. */
function parseInput<S extends z.AnyZodObject>(schema: S, input: unknown, optional = false): z.output<S> {
  reportProgress("validate", "started");
  try {
    const value = input === undefined && optional ? {} : input;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new UsageError("参数须为对象");
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UsageError("参数须为普通对象");
    }
    // Zod's strict objects reject enumerable unknown keys. Include symbols and
    // non-enumerable keys so unsupported options cannot disappear silently.
    const allowed = new Set(Object.keys(schema.shape));
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) {
        throw new UsageError(`未知参数：${String(key)}`);
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property?.get !== undefined || property?.set !== undefined) {
        throw new UsageError(`参数不能使用访问器：${key}`);
      }
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      const details = result.error.issues.map((issue) =>
        `${issue.path.join(".") || "input"}: ${issue.message}`,
      ).join("；");
      throw new UsageError(`参数非法：${details}`);
    }
    reportProgress("validate", "completed");
    return result.data;
  } catch (error) {
    reportProgress("validate", "failed");
    throw error;
  }
}

function documentOptions(input: z.output<typeof documentInput> | z.output<typeof decomposeInput>): CreateOpts {
  if (input.contextToken !== undefined && input.skipContext === true) {
    throw new UsageError("contextToken 与 skipContext 互斥，不可同时给出");
  }
  const options: CreateOpts = {};
  if ("parent" in input && input.parent !== undefined) options.parent = input.parent;
  if (input.content !== undefined) options.content = input.content;
  if (input.action !== undefined) options.action = input.action;
  if (input.overrides !== undefined) options.overrides = input.overrides;
  if (input.contextToken !== undefined) options.contextToken = input.contextToken;
  if (input.skipContext !== undefined) options.skipContext = input.skipContext;
  if (input.file !== undefined) options.file = input.file;
  return options;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readVersion(root: ProjectRoot, version: string): VersionMeta {
  const file = ensureWithin(path.join(root.meta, "versions"), `${version}.yaml`);
  try {
    return loadModel(file, VersionMetaSchema);
  } catch (error) {
    if (isMissing(error)) {
      throw Object.assign(new Error(`版本元数据不存在：${version}（${file}）`), { code: "VERSION_NOT_FOUND" });
    }
    throw error;
  }
}

function merged(meta: VersionMeta): boolean {
  return meta.merged_at !== null || meta.phase === "merged";
}

/** A missing active version is normal; ambiguity and corrupt metadata are not. */
function activeVersion(root: ProjectRoot): string | undefined {
  const active = new IndexManager(root).listVersions().filter((version) => !merged(readVersion(root, version)));
  if (active.length > 1) {
    throw Object.assign(new Error(`存在多个活动版本：${active.join(", ")}`), { code: "ACTIVE_VERSION_CONFLICT" });
  }
  return active[0];
}

function documentVersion(root: ProjectRoot): void {
  if (activeVersion(root) === undefined) {
    throw Object.assign(new Error("无活动版本"), { code: "NO_ACTIVE_VERSION" });
  }
}

function graphVersion(root: ProjectRoot, requested: string | undefined): string | undefined {
  if (requested === "baseline") return undefined;
  if (requested !== undefined) {
    readVersion(root, requested);
    return requested;
  }
  return activeVersion(root);
}

/** Preserve the old document-version display's deliberately permissive fallback. */
function latestDocumentVersion(cwd: string): string {
  try {
    const root = resolveProjectRoot(cwd);
    const versions = fs.readdirSync(path.join(root.meta, "versions"))
      .filter((name) => /^v\d+(?:\.\d+)*\.yaml$/.test(name))
      .map((name) => name.slice(0, -".yaml".length));
    versions.sort((left, right) => {
      const a = left.slice(1).split(".").map(Number);
      const b = right.slice(1).split(".").map(Number);
      for (let position = 0; position < Math.max(a.length, b.length); position += 1) {
        const difference = (b[position] ?? 0) - (a[position] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
    return versions[0] ?? "unversioned";
  } catch {
    return "unversioned";
  }
}

function compileRegexp(pattern: string): void {
  try {
    new RegExp(pattern, "i");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`参数非法：--regexp 正则非法（${pattern}）：${reason}`);
  }
}

async function runOperation(cwd: string, operation: string, input: unknown): Promise<object> {
  let resolved: ProjectRoot | undefined;
  const project = (): ProjectRoot => {
    resolved ??= resolveProjectRoot(cwd);
    return resolved;
  };

  switch (operation) {
    case "project.documentVersion":
      parseInput(noInput, input, true);
      return { version: latestDocumentVersion(cwd) };
    case "project.init": {
      const value = parseInput(initInput, input, true);
      const { initProject, checkProject, refreshWrapper } = await import("../init/init-manager.js");
      if (value.check === true) return checkProject(cwd);
      if (value.refreshWrapper === true) return refreshWrapper(cwd);
      return initProject(cwd, { name: value.name ?? "" });
    }
    case "version.create":
    case "version.commit":
    case "version.status":
    case "version.confirm": {
      const { version } = parseInput(versionInput, input);
      const root = project();
      const { VersionManager } = await import("../versioning/version-manager.js");
      const manager = new VersionManager(root);
      if (operation === "version.create") {
        activeVersion(root);
        return manager.versionCreate(version);
      }
      if (operation === "version.commit") return manager.versionCommit(version);
      if (operation === "version.status") return manager.versionStatus(version);
      return manager.versionConfirm(version);
    }
    case "version.merge": {
      const { version } = parseInput(versionInput, input);
      const root = project();
      const { versionMerge } = await import("../versioning/merge-engine.js");
      return versionMerge(root, version);
    }
    case "version.revert": {
      const value = parseInput(revertInput, input);
      const root = project();
      const { VersionManager } = await import("../versioning/version-manager.js");
      return new VersionManager(root).versionRevert(value.version, { confirm: value.confirm === true });
    }
    case "version.backfillTags": {
      parseInput(noInput, input, true);
      const root = project();
      const { VersionManager } = await import("../versioning/version-manager.js");
      return new VersionManager(root).backfillRevertTags();
    }
    case "version.list": {
      parseInput(noInput, input, true);
      const root = project();
      const { listVersions } = await import("./read-models.js");
      return listVersions(root);
    }
    case "version.inspect": {
      const { version } = parseInput(versionInput, input);
      const root = project();
      const { inspectVersion } = await import("./read-models.js");
      return inspectVersion(root, version);
    }
    case "prd.create":
    case "fsd.create":
    case "tdd.create": {
      const layer: DocLayer = operation === "prd.create" ? "prd" : operation === "fsd.create" ? "fsd" : "tdd";
      const value = layer === "prd" ? parseInput(prdInput, input) : parseInput(documentInput, input);
      const options = documentOptions(value);
      const root = project();
      documentVersion(root);
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return new NewModelManager(root).createDocument(layer, value.id, options);
    }
    case "prd.confirm":
    case "fsd.confirm":
    case "tdd.confirm":
    case "prd.revert":
    case "fsd.revert":
    case "tdd.revert": {
      parseInput(noInput, input, true);
      const root = project();
      documentVersion(root);
      const layer: DocLayer = operation.startsWith("prd.") ? "prd" : operation.startsWith("fsd.") ? "fsd" : "tdd";
      const { NewModelManager } = await import("../new-model/model-manager.js");
      const manager = new NewModelManager(root);
      return operation.endsWith(".confirm") ? manager.confirmLayer(layer) : manager.revertLayer(layer);
    }
    case "fsd.decompose": {
      const value = parseInput(decomposeInput, input);
      const options = documentOptions(value);
      const root = project();
      documentVersion(root);
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return new NewModelManager(root).decompose(value.parentSplit, value.childRootId, options);
    }
    case "delivery.prepare": {
      const value = parseInput(prepareInput, input);
      const root = project();
      const version = value.version ?? activeVersion(root);
      const { prepareDelivery } = await import("../orchestration/context-delivery.js");
      return prepareDelivery(root, {
        tddRoot: value.tddRootId,
        ...(version === undefined ? {} : { version }),
        ...(value.output === undefined ? {} : { output: value.output }),
      });
    }
    case "graph.query": {
      const value = parseInput(graphInput, input);
      const root = project();
      const version = graphVersion(root, value.version);
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { queryDeps } = await import("../specgraph/queries.js");
      return queryDeps(combinedView(root, version), value.target, value.direction ?? "both", value.rels);
    }
    case "graph.impact": {
      const value = parseInput(targetInput, input);
      const root = project();
      const version = activeVersion(root);
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { analyzeImpact } = await import("../specgraph/queries.js");
      return analyzeImpact(combinedView(root, version), value.target);
    }
    case "graph.sync": {
      parseInput(noInput, input, true);
      const root = project();
      const { SpecGraphStore } = await import("../specgraph/graph-model.js");
      return new SpecGraphStore(root).sync();
    }
    case "graph.export": {
      const value = parseInput(optionalVersionInput, input, true);
      const root = project();
      const { SpecGraphStore } = await import("../specgraph/graph-model.js");
      return new SpecGraphStore(root).load(value.version);
    }
    case "graph.validateNewModel": {
      const value = parseInput(optionalVersionInput, input, true);
      const root = project();
      // Historical merged versions keep the previous baseline diagnostic
      // semantics; this is intentionally different from graph.query's overlay.
      const version = value.version === undefined
        ? activeVersion(root)
        : merged(readVersion(root, value.version)) ? undefined : value.version;
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { validateInvariants } = await import("../new-model/validator.js");
      const { evaluateGovernance } = await import("../new-model/governance.js");
      const violations = validateInvariants(combinedView(root, version));
      const report = evaluateGovernance(root, version);
      return {
        version: version ?? "baseline",
        passed: violations.length === 0,
        violations,
        policy_violations: report.violations,
        warnings: report.warnings,
        target_file_missing: report.target_file_missing,
        derives_residue: report.derives_residue,
      };
    }
    case "search.query": {
      const value = parseInput(searchInput, input);
      if (value.regexp === true) compileRegexp(value.query);
      const root = project();
      const { searchChunks } = await import("../search/keyword-search.js");
      const hits = searchChunks(root, value.query, {
        ...(value.scope === undefined ? {} : { scope: value.scope }),
        ...(value.regexp === undefined ? {} : { regexp: value.regexp }),
      });
      return { query: value.query, count: hits.length, hits };
    }
    case "search.baselineSummary": {
      const value = parseInput(summaryInput, input, true);
      const root = project();
      const { baselineSummary } = await import("../search/baseline-summary.js");
      return baselineSummary(root, value.scope === undefined ? {} : { scope: value.scope });
    }
    case "search.baselineStats": {
      parseInput(noInput, input, true);
      const root = project();
      const { baselineStats } = await import("../search/baseline-summary.js");
      return baselineStats(root);
    }
    case "state.get":
    case "state.render":
    case "state.save": {
      const value = operation === "state.save"
        ? parseInput(saveInput, input, true)
        : parseInput(optionalVersionInput, input, true);
      const root = project();
      const version = value.version ?? activeVersion(root);
      const { loadVersionState, renderMarkdown, saveState } = await import("../state/state.js");
      const panel = loadVersionState(root, version);
      if (operation === "state.get") return panel;
      const markdown = { version: panel.version, format: "markdown", content: renderMarkdown(panel) };
      if (operation === "state.render") return markdown;
      const savedTo = saveState(root, panel.version, panel);
      return "format" in value && value.format === "json"
        ? { ...panel, saved_to: savedTo }
        : { ...markdown, saved_to: savedTo };
    }
    case "index.rebuild": {
      parseInput(noInput, input, true);
      return new IndexManager(project()).rebuildBaseline();
    }
    case "acceptance.set": {
      const { command } = parseInput(commandInput, input);
      const root = project();
      const { acceptanceSet } = await import("../versioning/publish.js");
      acceptanceSet(root, command);
      return { command };
    }
    case "acceptance.show": {
      parseInput(noInput, input, true);
      const root = project();
      const { acceptanceShow } = await import("../versioning/publish.js");
      return { command: acceptanceShow(root) };
    }
    case "acceptance.run": {
      parseInput(noInput, input, true);
      const root = project();
      const { runAcceptance } = await import("../versioning/publish.js");
      return runAcceptance(root);
    }
    case "publish.push": {
      const value = parseInput(pushInput, input, true);
      const root = project();
      const { push } = await import("../versioning/publish.js");
      return push(root, value.dryRun === undefined ? {} : { dryRun: value.dryRun });
    }
    case "session.get": {
      parseInput(noInput, input, true);
      const root = project();
      const { getSessionContext } = await import("../orchestration/session-context.js");
      return getSessionContext(root);
    }
    case "generation.registerReceipt": {
      const value = parseInput(receiptInput, input);
      const root = project();
      const { registerGenerationReceipt } = await import("../orchestration/generation-receipts.js");
      return registerGenerationReceipt(root, { generation_token: value.generationToken });
    }
    case "generation.verifyReceipts": {
      const { version } = parseInput(versionInput, input);
      const root = project();
      const { verifyGenerationReceipts } = await import("../orchestration/generation-receipts.js");
      return verifyGenerationReceipts(root, version);
    }
    case "generation.status": {
      const value = parseInput(generationInput, input);
      const root = project();
      const { generationStatus } = await import("./read-models.js");
      return generationStatus(root, {
        version: value.version,
        ...(value.tddRootId === undefined ? {} : { tddRootId: value.tddRootId }),
      });
    }
    case "governance.getPolicy": {
      parseInput(noInput, input, true);
      const root = project();
      const { getPolicy } = await import("./read-models.js");
      return getPolicy(root);
    }
    case "guard.evaluate": {
      const value = parseInput(guardInput, input);
      if (!Object.hasOwn(value, "input")) throw new UsageError("缺参数：input");
      const { evaluateWriteGuard } = await import("../orchestration/guard-decisions.js");
      return evaluateWriteGuard({ projectRoot: cwd, cwd, toolName: value.toolName, input: value.input });
    }
    default:
      throw new UsageError(`未知操作：${operation}`);
  }
}

/** Return domain data and let the worker supply the transport's error envelope. */
export async function executeOperation(cwd: string, operation: string, input: unknown): Promise<object> {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof operation !== "string") {
    throw new UsageError("cwd 与 operation 须为有效字符串");
  }
  const data = await runOperation(cwd, operation, input);
  // Advice belonged to the old transport contract, never to persisted user
  // metadata. Only remove former result fields; preserve nested domain facts.
  return Object.fromEntries(Object.entries(data).filter(([key]) =>
    key !== "next_action" && key !== "next_call" && key !== "required_next_call",
  ));
}
