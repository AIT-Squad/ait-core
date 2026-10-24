import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import * as publicApi from "../src/index.js";
import type * as T from "../src/index.js";

// Every business call in this file enters through the public package surface.
// Raw fixture edits below are deliberate corruptions/historical data, never a
// substitute for the public PRD -> FSD -> TDD -> receipt -> merge workflow.
const { createCoreApi, dispatch } = publicApi;
const originalCwd = process.cwd();
const temporaryRoot = path.resolve(os.tmpdir());
const owned = new Set<string>();
const packageEntry = createRequire(import.meta.url).resolve("ait-core");
const packageUrl = pathToFileURL(packageEntry).href;
const VERSION = "v1.0";
const PRD = "[PRD]-public_api";
const FSD = "[FSD]-public_api";
const CHILD = "[FSD]-public_api-child";
const TDD = "[TDD]-public_api";
const TARGET = "src/generated.ts";
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function directory(): string {
  const result = fs.mkdtempSync(path.join(temporaryRoot, "ait-public-api-"));
  owned.add(path.resolve(result));
  return result;
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of owned) {
    const relative = path.relative(temporaryRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
        || !path.basename(root).startsWith("ait-public-api-")) {
      throw new Error(`Unsafe fixture cleanup: ${root}`);
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  owned.clear();
});

function noAdvice(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["next_action", "next_call", "required_next_call", "NextAction"]).not.toContain(key);
    noAdvice(child);
  }
}

function ok<Data extends object>(result: T.ApiResult<Data>): Data {
  noAdvice(result);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.data;
}

function error(result: T.ApiResult<object>, code?: string): void {
  noAdvice(result);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) throw new Error("Expected an error envelope");
  expect(Object.keys(result).sort()).toEqual(["code", "error", "ok"]);
  expect(result.error.length).toBeGreaterThan(0);
  expect(result.code.length).toBeGreaterThan(0);
  if (code !== undefined) expect(result.code).toBe(code);
}

function client(cwd: string, options?: T.CoreApiOptions): T.CoreApi {
  const previous = process.cwd();
  process.chdir(cwd);
  try { return createCoreApi(options); } finally { process.chdir(previous); }
}

function snapshot(cwd: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(cwd, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) { files[`${relative}/`] = "directory"; visit(absolute); }
      else files[relative] = `${fs.statSync(absolute).mtimeMs}:${digest(fs.readFileSync(absolute))}`;
    }
  };
  visit(cwd);
  return files;
}

function gitState(cwd: string): unknown[] {
  return [cwd, path.join(cwd, "project-docs")].map((root) => {
    const result = spawnSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root, encoding: "utf8", windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
}

async function unchanged(cwd: string, work: () => Promise<void>): Promise<void> {
  const git = gitState(cwd);
  const before = snapshot(cwd);
  await work();
  expect(snapshot(cwd)).toEqual(before);
  expect(gitState(cwd)).toEqual(git);
}

interface Fixture { cwd: string; core: T.CoreApi }
async function fixture(options?: T.CoreApiOptions): Promise<Fixture> {
  const cwd = directory();
  const core = client(cwd, options);
  ok(await core.project.init({ name: "seed" }));
  return { cwd, core };
}

const prdContent = [
  `<!-- @id:${PRD} -->`, "## 公共接口产品", "正文来源标记：雪 🧪 é。",
  `<!-- @id:${PRD}:generate -->`, "## 生成需求",
  "**用户故事:** 作为开发者，我希望通过公共接口生成制品，以便完成可核验交付。",
  "#### 验收标准", "1. WHEN 交付完成 THEN 系统 SHALL 返回完整规格和可核验回执。",
].join("\n");
const fsdContent = [
  `<!-- @id:${FSD} -->`, "## 公共接口功能", "功能根完整正文。",
  `<!-- @id:${FSD}:entry -->`, "## 文件交付", "```yaml",
  `derives: ["${PRD}:generate"]`, "depends_on: [dependency]", "```", "交付唯一文件。",
  `<!-- @id:${FSD}:dependency -->`, "## 依赖能力", "依赖完整契约：Unicode 雪 🧪 é。",
  `<!-- @id:${FSD}:branch -->`, "## 分解能力", "允许递归规格。",
  `<!-- @id:${FSD}:TEST -->`, "## 功能验收", "公共接口集成验收。",
].join("\n");
const childContent = [
  `<!-- @id:${CHILD} -->`, "## 子功能", "完整子树。",
  `<!-- @id:${CHILD}:leaf -->`, "## 子叶", "```yaml", "depends_on: [dependency]", "```", "子功能契约。",
  `<!-- @id:${CHILD}:dependency -->`, "## 子树依赖", "子树依赖契约。",
  `<!-- @id:${CHILD}:TEST -->`, "## 子树验收", "子树验收契约。",
].join("\n");
const tddContent = [
  `<!-- @id:${TDD} -->`, "## 文件级实现", "```yaml", `target_file: ${TARGET}`, "```",
  "实现 export const generated = '雪 🧪 é';，只写目标文件。", "完整规格结束标记。",
].join("\n");

async function writeDocument(core: T.CoreApi, layer: "prd" | "fsd" | "tdd", input: T.DocumentInput): Promise<void> {
  const { content, ...intent } = input;
  const discussion = ok(await core[layer].create(intent));
  expect(discussion.mode).toBe("discussion-context");
  if (discussion.mode !== "discussion-context") throw new Error("Expected discussion context");
  expect(discussion.background).toBeTypeOf("string");
  expect(discussion.context_token.length).toBeGreaterThan(0);
  expect(ok(await core[layer].create({ ...intent, content: content ?? "", contextToken: discussion.context_token })).mode).toBe("written");
}

async function specification(core: T.CoreApi, recursive = false): Promise<void> {
  ok(await core.version.create({ version: VERSION }));
  await writeDocument(core, "prd", { id: PRD, content: prdContent });
  expect(ok(await core.prd.confirm()).phase).toBe("prd-confirm");
  await writeDocument(core, "fsd", { id: FSD, parent: PRD, content: fsdContent });
  if (recursive) {
    const intent = { parentSplit: `${FSD}:branch`, childRootId: CHILD };
    const context = ok(await core.fsd.decompose(intent));
    if (context.mode !== "discussion-context") throw new Error("Expected decomposition context");
    const result = ok(await core.fsd.decompose({ ...intent, content: childContent, contextToken: context.context_token }));
    expect(result.mode).toBe("written");
  }
  expect(ok(await core.fsd.confirm()).phase).toBe("fsd-confirm");
  await writeDocument(core, "tdd", { id: TDD, parent: recursive ? `${CHILD}:leaf` : `${FSD}:entry`, content: tddContent });
  expect(ok(await core.tdd.confirm()).phase).toBe("tdd-confirm");
}

function generate(cwd: string, content = "export const generated = '雪 🧪 é';\n"): string {
  const target = path.join(cwd, TARGET);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return digest(fs.readFileSync(target));
}

async function delivered(f: Fixture): Promise<T.MemoryDelivery> {
  const delivery = ok(await f.core.delivery.prepare({ tddRootId: TDD }));
  expect(delivery.bytes).toBe(Buffer.byteLength(delivery.content, "utf8"));
  expect(delivery.sha256).toBe(digest(delivery.content));
  expect(delivery).not.toHaveProperty("bundle_path");
  const hash = generate(f.cwd);
  expect(ok(await f.core.generation.registerReceipt({ generationToken: delivery.generation_token })).artifact_sha256).toBe(hash);
  return delivery;
}

async function cli(cwd: string, argv: string[]): Promise<T.CliDispatchResult> {
  const previous = process.cwd();
  process.chdir(cwd);
  try { return await dispatch(argv); } finally { process.chdir(previous); }
}

function command(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_NAME: "API Test", GIT_AUTHOR_EMAIL: "api@example.invalid",
        GIT_COMMITTER_NAME: "API Test", GIT_COMMITTER_EMAIL: "api@example.invalid" } });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Node fixture timed out\n${stderr}`)); }, 90_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (failure) => { clearTimeout(timeout); reject(failure); });
    child.on("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
}

async function node(cwd: string, source: string): Promise<unknown> {
  const script = path.join(cwd, `driver-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.mjs`);
  fs.writeFileSync(script, [
    'import assert from "node:assert/strict";', 'import fs from "node:fs";', 'import path from "node:path";',
    'import { createHash } from "node:crypto";', `const entry = ${JSON.stringify(packageUrl)};`,
    source,
  ].join("\n"));
  const result = await command(cwd, [script]);
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stderr).toBe("");
  // Extra library/progress/subprocess output makes this parse fail.
  return JSON.parse(result.stdout) as unknown;
}

describe("named public API", () => {
  it("exports only the two runtime entries and retains precise public types", () => {
    expect(Object.keys(publicApi).sort()).toEqual(["createCoreApi", "dispatch"]);
    const core = client(directory());
    expectTypeOf(core).toEqualTypeOf<T.CoreApi>();
    expectTypeOf(core.project.documentVersion).returns.toEqualTypeOf<T.R<T.DocumentVersionResult>>();
    expectTypeOf(core.project.init).returns.toEqualTypeOf<T.R<T.InitResponse>>();
    expectTypeOf(core.version.create).returns.toEqualTypeOf<T.R<T.VersionCreateResult>>();
    expectTypeOf(core.version.commit).returns.toEqualTypeOf<T.R<T.VersionCommitResult>>();
    expectTypeOf(core.version.status).returns.toEqualTypeOf<T.R<T.VersionStatus>>();
    expectTypeOf(core.version.confirm).returns.toEqualTypeOf<T.R<T.VersionConfirmResult>>();
    expectTypeOf(core.version.merge).returns.toEqualTypeOf<T.R<T.VersionMergeResult>>();
    expectTypeOf(core.version.revert).returns.toEqualTypeOf<T.R<T.VersionRevertResult>>();
    expectTypeOf(core.version.backfillTags).returns.toEqualTypeOf<T.R<T.BackfillTagsResult>>();
    expectTypeOf(core.version.list).returns.toEqualTypeOf<T.R<T.VersionListResult>>();
    expectTypeOf(core.version.inspect).returns.toEqualTypeOf<T.R<T.VersionInspection>>();
    for (const layer of [core.prd, core.fsd, core.tdd]) {
      expectTypeOf(layer.create).returns.toEqualTypeOf<T.R<T.DocumentResult>>();
      expectTypeOf(layer.confirm).returns.toEqualTypeOf<T.R<T.LayerConfirmResult>>();
      expectTypeOf(layer.revert).returns.toEqualTypeOf<T.R<T.LayerRevertResult>>();
    }
    expectTypeOf(core.fsd.decompose).returns.toEqualTypeOf<T.R<T.DecomposeResult>>();
    expectTypeOf(core.graph.query).returns.toEqualTypeOf<T.R<T.DepsResult>>();
    expectTypeOf(core.graph.impact).returns.toEqualTypeOf<T.R<T.ImpactResult>>();
    expectTypeOf(core.graph.sync).returns.toEqualTypeOf<T.R<T.SpecGraph>>();
    expectTypeOf(core.graph.export).returns.toEqualTypeOf<T.R<T.SpecGraph>>();
    expectTypeOf(core.graph.validateNewModel).returns.toEqualTypeOf<T.R<T.ValidationReport>>();
    expectTypeOf(core.search.query).returns.toEqualTypeOf<T.R<T.SearchResult>>();
    expectTypeOf(core.search.baselineSummary).returns.toEqualTypeOf<T.R<T.BaselineSummary>>();
    expectTypeOf(core.search.baselineStats).returns.toEqualTypeOf<T.R<T.BaselineStats>>();
    expectTypeOf(core.state.get).returns.toEqualTypeOf<T.R<T.StatePanel>>();
    expectTypeOf(core.state.render).returns.toEqualTypeOf<T.R<T.MarkdownState>>();
    expectTypeOf(core.state.save).returns.toEqualTypeOf<T.R<T.StateSaveResult>>();
    expectTypeOf(core.index.rebuild).returns.toEqualTypeOf<T.R<T.BaselineIndex>>();
    expectTypeOf(core.acceptance.set).returns.toEqualTypeOf<T.R<T.AcceptanceConfigResult>>();
    expectTypeOf(core.acceptance.show).returns.toEqualTypeOf<T.R<T.AcceptanceConfigResult>>();
    expectTypeOf(core.acceptance.run).returns.toEqualTypeOf<T.R<T.AcceptanceResult>>();
    expectTypeOf(core.publish.push).returns.toEqualTypeOf<T.R<T.PushReport>>();
    expectTypeOf(core.session.get).returns.toEqualTypeOf<T.R<T.SessionContext>>();
    expectTypeOf(core.generation.registerReceipt).returns.toEqualTypeOf<T.R<T.GenerationReceipt>>();
    expectTypeOf(core.generation.verifyReceipts).returns.toEqualTypeOf<T.R<T.GenerationVerification>>();
    expectTypeOf(core.generation.status).returns.toEqualTypeOf<T.R<T.GenerationStatus>>();
    expectTypeOf(core.governance.getPolicy).returns.toEqualTypeOf<T.R<T.EffectiveGovernancePolicy>>();
    expectTypeOf(core.guard.evaluate).returns.toEqualTypeOf<T.ApiResult<T.GuardDecision>>();
    // Compile-only consumers also lock overload narrowing and forbidden inputs.
    const compileOnly = (): void => {
      expectTypeOf(core.delivery.prepare({ tddRootId: TDD })).toEqualTypeOf<T.R<T.MemoryDelivery>>();
      expectTypeOf(core.delivery.prepare({ tddRootId: TDD, output: "memory" })).toEqualTypeOf<T.R<T.MemoryDelivery>>();
      expectTypeOf(core.delivery.prepare({ tddRootId: TDD, output: "file" })).toEqualTypeOf<T.R<T.DeliveryPointer>>();
      // @ts-expect-error cwd is captured, never supplied as an option.
      createCoreApi({ cwd: "/another-project" });
      // @ts-expect-error Cancellation is not a public protocol.
      createCoreApi({ signal: new AbortController().signal });
      // @ts-expect-error Cancellation is not a method argument either.
      core.version.confirm({ version: VERSION, cancel: true });
      // @ts-expect-error Old directions have no compatibility alias.
      core.graph.query({ target: FSD, direction: "from" });
      // @ts-expect-error CLI presentation is not a summary API input.
      core.search.baselineSummary({ format: "yaml" });
      // @ts-expect-error PRD has no parent.
      core.prd.create({ id: PRD, parent: FSD });
      // @ts-expect-error Decomposition has exactly one child identity.
      core.fsd.decompose({ parentSplit: `${FSD}:branch`, childRootId: CHILD, id: CHILD });
      // @ts-expect-error Consumers cannot supply artifact hashes.
      core.generation.registerReceipt({ generationToken: "token", artifact_sha256: "fake" });
      // @ts-expect-error Internal token issuance is not public.
      core.generation.issueToken({});
      // @ts-expect-error Memory delivery does not require a second read API.
      core.delivery.read({});
    };
    expect(compileOnly).toBeTypeOf("function");
  });

  it("imports and constructs clients without filesystem or worker activity in an independent Node host", async () => {
    expect(await node(directory(), `
      const { default: threads } = await import("node:worker_threads");
      const { syncBuiltinESMExports } = await import("node:module");
      const calls = [];
      const saved = [];
      let loaderDepth = 0;
      for (const [object, keys] of [[fs, ["readFileSync", "writeFileSync", "existsSync", "statSync", "readdirSync", "mkdirSync", "openSync", "readFile", "writeFile", "stat", "readdir", "mkdir"]],
                                   [fs.promises, ["readFile", "writeFile", "stat", "readdir", "mkdir", "open"]]]) {
        for (const key of keys) {
          const original = object[key];
          saved.push([object, key, original]);
          object[key] = function (...args) {
            // Node must read module source to import it. Only that loader IO is
            // exempt; an API/module initializer's direct filesystem call fails.
            const caller = new Error().stack.split("\\n").slice(2)
              .find(line => !line.includes("node:fs:") && !line.includes("node:internal/fs/"));
            if (loaderDepth > 0 || caller?.includes("node:internal/modules/")) {
              loaderDepth++;
              try { return original.apply(this, args); } finally { loaderDepth--; }
            }
            calls.push(key); throw new Error("Unexpected import/client IO: " + key);
          };
        }
      }
      const OriginalWorker = threads.Worker;
      threads.Worker = class { constructor() { calls.push("Worker"); throw new Error("Unexpected worker startup"); } };
      syncBuiltinESMExports();
      try {
        const api = await import(entry);
        assert.deepEqual(Object.keys(api).sort(), ["createCoreApi", "dispatch"]);
        api.createCoreApi();
        api.createCoreApi({ onProgress() { throw new Error("must not be called"); } });
        assert.deepEqual(calls, []);
      } finally {
        for (const [object, key, value] of saved) object[key] = value;
        threads.Worker = OriginalWorker;
        syncBuiltinESMExports();
      }
      assert.equal(fs.existsSync("project-docs"), false);
      process.stdout.write(JSON.stringify({ calls }));
    `)).toEqual({ calls: [] });
  }, 30_000);

  it("binds cwd at construction, supports blank checks, and keeps the guard synchronous", async () => {
    const first = directory();
    const second = directory();
    const core = client(first);
    process.chdir(second);
    const before = snapshot(first);
    expect(ok(await core.project.documentVersion())).toEqual({ version: "unversioned" });
    expect(ok(await core.project.init({ check: true, refreshWrapper: true }))).toMatchObject({ ok: false });
    expect(snapshot(first)).toEqual(before);
    const guarded = core.guard.evaluate({ toolName: "write", input: { path: "project-docs/.meta/config.yaml" } });
    expect(guarded).not.toBeInstanceOf(Promise);
    expect(ok(guarded).decision).toBe("block");
    expect(ok(core.guard.evaluate({ toolName: "write", input: { path: "src/file.ts" } })).decision).toBe("allow");
    ok(await core.project.init({ name: "bound" }));
    expect(fs.existsSync(path.join(first, "project-docs"))).toBe(true);
    expect(fs.existsSync(path.join(second, "project-docs"))).toBe(false);
    expect(process.cwd()).toBe(second);
    expect(ok(await core.session.get())).toMatchObject({ project_root: first, active_version: null, phase: null });
    error(await core.state.get(), "NO_VERSION");
    expect(ok(await core.index.rebuild()).chunks.length).toBeGreaterThan(0);
    expect(ok(await core.graph.sync()).specs.length).toBeGreaterThan(0);
  }, 30_000);

  it("validates every grouped method at runtime and rejects cancellation before writes", async () => {
    const f = await fixture();
    await unchanged(f.cwd, async () => {
      for (const [groupName, group] of Object.entries(f.core)) {
        for (const [methodName, method] of Object.entries(group)) {
          expect(method, `${groupName}.${methodName}`).toBeTypeOf("function");
          const invoke = method as (input: unknown) => T.ApiResult<object> | T.R<object>;
          const result = invoke({ cancel: true });
          if (groupName !== "guard") expect(result).toBeInstanceOf(Promise);
          error(await result, "USAGE_ERROR");
        }
      }
      const invoke = f.core.graph.query as (input: unknown) => T.R<object>;
      for (const input of [null, [], "target", { target: FSD, direction: "from" }, { target: FSD, direction: "to" },
        { target: FSD, rels: ["implements"] }, { target: FSD, signal: null }, { target: FSD, abortSignal: null }]) {
        error(await invoke(input), "USAGE_ERROR");
      }
      error(await f.core.search.query({ query: "[", regexp: true }), "USAGE_ERROR");
      error(await cli(f.cwd, ["search", "[", "--regexp"]), "USAGE_ERROR");
      const create = createCoreApi as (input: unknown) => T.CoreApi;
      for (const input of [{ signal: null }, { cancel: true }, { cwd: f.cwd }, { onProgress: true }]) {
        expect(() => create(input)).toThrowError(expect.objectContaining({ code: "USAGE_ERROR" }));
      }
    });
  }, 60_000);

  it("completes a Node-only workflow with full memory delivery, real generation, receipts and readable history", async () => {
    const cwd = directory();
    const result = await node(cwd, `
      const { createCoreApi } = await import(entry);
      const core = createCoreApi();
      const value = (result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
      const text = ${JSON.stringify({ prd: prdContent, fsd: fsdContent, tdd: tddContent })};
      const ids = ${JSON.stringify({ prd: PRD, fsd: FSD, tdd: TDD })};
      const version = ${JSON.stringify(VERSION)};
      value(await core.project.init({ name: "seed" }));
      value(await core.version.create({ version }));
      for (const layer of ["prd", "fsd", "tdd"]) {
        const intent = { id: ids[layer], ...(layer === "fsd" ? { parent: ids.prd } : layer === "tdd" ? { parent: ids.fsd + ":entry" } : {}) };
        const discussion = value(await core[layer].create(intent));
        assert.equal(discussion.mode, "discussion-context");
        assert.equal(value(await core[layer].create({ ...intent, content: text[layer], contextToken: discussion.context_token })).mode, "written");
        value(await core[layer].confirm());
      }
      const blockedTemporaryDirectory = path.resolve("temporary-directory-is-a-file");
      fs.writeFileSync(blockedTemporaryDirectory, "not a directory");
      const temporaryEnvironment = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
      for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = blockedTemporaryDirectory;
      const delivery = value(await core.delivery.prepare({ tddRootId: ids.tdd }));
      for (const [key, previous] of Object.entries(temporaryEnvironment)) {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      }
      assert.equal(delivery.target_state, "absent");
      assert.equal(Object.hasOwn(delivery, "bundle_path"), false);
      assert.equal(delivery.bytes, Buffer.byteLength(delivery.content, "utf8"));
      assert.equal(delivery.sha256, createHash("sha256").update(delivery.content).digest("hex"));
      for (const fragment of ["完整规格结束标记。", "依赖完整契约：Unicode 雪 🧪 é。", "正文来源标记：雪 🧪 é。"])
        assert.ok(delivery.content.includes(fragment), fragment);
      assert.equal(delivery.target_file, ${JSON.stringify(TARGET)});
      // This is the host's stand-in generator, consuming the full returned text.
      const generateFromDelivery = (input) => {
        assert.ok(input.content.includes("export const generated"));
        const destination = path.resolve(input.target_file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, "export const generated = '雪 🧪 é';\\n");
      };
      generateFromDelivery(delivery);
      const receipt = value(await core.generation.registerReceipt({ generationToken: delivery.generation_token }));
      assert.equal(receipt.artifact_sha256, createHash("sha256").update(fs.readFileSync(delivery.target_file)).digest("hex"));
      assert.deepEqual(value(await core.generation.registerReceipt({ generationToken: delivery.generation_token })), receipt);
      assert.deepEqual(value(await core.generation.verifyReceipts({ version })).findings, []);
      const confirmed = value(await core.version.confirm({ version }));
      assert.equal(confirmed.passed, true);
      assert.equal(value(await core.version.inspect({ version })).confirmation.state, "valid");
      value(await core.version.merge({ version }));
      const inspection = value(await core.version.inspect({ version }));
      assert.equal(inspection.confirmation.state, "not_applicable");
      const history = value(await core.version.list()).versions;
      assert.deepEqual(history.map(item => item.version), [version]);
      assert.equal(history[0].merged, true);
      assert.equal(history[0].based_on, null);
      assert.equal(value(await core.session.get()).active_version, null);
      assert.equal(value(await core.state.get({ version })).merged, true);
      assert.ok(value(await core.search.baselineSummary({ scope: "tdd" })).items.some(item => item.id === ids.tdd));
      assert.ok(value(await core.search.query({ query: "完整规格结束标记" })).count > 0);
      const walk = (item) => {
        if (!item || typeof item !== "object") return;
        for (const [key, value] of Object.entries(item)) {
          assert.ok(!["next_action", "next_call", "required_next_call"].includes(key)); walk(value);
        }
      };
      walk({ delivery, receipt, confirmed, inspection, history });
      process.stdout.write(JSON.stringify({ merged: history[0].merged, target: delivery.target_file, mode: "memory" }));
    `);
    expect(result).toEqual({ merged: true, target: TARGET, mode: "memory" });
  }, 90_000);

  it("keeps phase and context gates, and exposes layer reverts and explicit version reverts", async () => {
    const { cwd, core } = await fixture();
    error(await core.prd.create({ id: PRD }), "NO_ACTIVE_VERSION");
    ok(await core.version.create({ version: VERSION }));
    await unchanged(cwd, async () => {
      error(await core.fsd.create({ id: FSD, parent: PRD }), "PRD_NOT_CONFIRMED");
      error(await core.prd.create({ id: PRD, content: prdContent }), "CONTEXT_TOKEN_INVALID");
      error(await core.version.create({ version: "v2.0" }), "ACTIVE_VERSION_EXISTS");
    });
    await writeDocument(core, "prd", { id: PRD, content: prdContent });
    const committed = ok(await core.version.commit({ version: VERSION }));
    expect(committed.committed).toContain(PRD);
    ok(await core.prd.confirm());
    ok(await core.prd.revert());
    expect(ok(await core.version.status({ version: VERSION })).phase).toBe("prd-creating");
    ok(await core.prd.confirm());
    await writeDocument(core, "fsd", { id: FSD, parent: PRD, content: fsdContent });
    ok(await core.fsd.confirm());
    ok(await core.fsd.revert());
    expect(ok(await core.version.status({ version: VERSION })).phase).toBe("fsd-creating");
    ok(await core.fsd.confirm());
    await writeDocument(core, "tdd", { id: TDD, parent: `${FSD}:entry`, content: tddContent });
    await unchanged(cwd, async () => {
      error(await core.delivery.prepare({ tddRootId: TDD }), "TDD_NOT_CONFIRMED");
      error(await core.generation.status({ version: VERSION, tddRootId: TDD }), "TDD_NOT_CONFIRMED");
    });
    ok(await core.tdd.confirm());
    const delivery = ok(await core.delivery.prepare({ tddRootId: TDD }));
    ok(await core.tdd.revert());
    expect(ok(await core.state.get()).phase).toBe("tdd-creating");
    await unchanged(cwd, async () => {
      error(await core.generation.registerReceipt({ generationToken: delivery.generation_token }));
      error(await core.version.revert({ version: VERSION }));
    });
    expect(ok(await core.version.revert({ version: VERSION, confirm: true })).reverted).toBe(true);
    expect(ok(await core.version.list()).versions).toEqual([]);
  }, 60_000);

  it("matches four relation filters, directions and explicit/default graph versions across API and argv", async () => {
    const { cwd, core } = await fixture();
    await specification(core, true);
    const leaf = `${CHILD}:leaf`;
    const dependency = `${CHILD}:dependency`;
    const cases: Array<{ rel: T.EdgeRel; target: string; src: string; dst: string }> = [
      { rel: "derives", target: PRD, src: PRD, dst: FSD },
      { rel: "decomposes", target: `${FSD}:branch`, src: `${FSD}:branch`, dst: CHILD },
      { rel: "details", target: leaf, src: leaf, dst: TDD },
      { rel: "depends_on", target: leaf, src: leaf, dst: dependency },
    ];
    await unchanged(cwd, async () => {
      for (const row of cases) {
        for (const direction of ["in", "out", "both"] as const) {
          const result = ok(await core.graph.query({ target: row.target, direction, rels: [row.rel] }));
          expect(result.direction).toBe(direction);
          expect(result.edges.map(({ src, dst, rel }) => ({ src, dst, rel })))
            .toEqual(direction === "in" ? [] : [{ src: row.src, dst: row.dst, rel: row.rel }]);
          expect(ok(await cli(cwd, ["specgraph", "query", row.target, "--direction", direction, `--${row.rel.replaceAll("_", "-")}`]))).toEqual(result);
          const incoming = ok(await core.graph.query({ target: row.dst, direction: "in", rels: [row.rel] }));
          expect(incoming.edges.some((edge) => edge.src === row.src && edge.dst === row.dst)).toBe(true);
        }
      }
      for (const direction of ["in", "out", "both"] as const) {
        const result = ok(await core.graph.query({ target: leaf, direction, rels: ["details", "depends_on"] }));
        expect(ok(await cli(cwd, ["specgraph", "query", leaf, "--details", "--depends-on", "--direction", direction]))).toEqual(result);
        expect(result.edges.every((edge) => edge.rel === "details" || edge.rel === "depends_on")).toBe(true);
      }
      const unfiltered = ok(await core.graph.query({ target: leaf }));
      expect(unfiltered.direction).toBe("both");
      expect(ok(await cli(cwd, ["deps", leaf]))).toEqual(unfiltered);
      expect(ok(await cli(cwd, ["specgraph", "query", leaf]))).toEqual(unfiltered);
      expect(ok(await core.graph.query({ target: leaf, rels: [] })).edges).toEqual([]);
      const once = ok(await core.graph.query({ target: leaf, rels: ["details"] }));
      expect(ok(await core.graph.query({ target: leaf, rels: ["details", "details"] }))).toEqual(once);
      for (const version of [VERSION, "baseline"]) {
        const result = ok(await core.graph.query({ target: leaf, version, rels: ["details"], direction: "out" }));
        expect(ok(await cli(cwd, ["specgraph", "query", leaf, "--version", version, "--details", "--direction", "out"]))).toEqual(result);
        expect(result.edges).toHaveLength(version === "baseline" ? 0 : 1);
      }
      expect(ok(await core.graph.query({ target: "[FSD]-unknown" }))).toMatchObject({ found: false, edges: [] });
      error(await core.graph.query({ target: FSD, version: "v99.0" }), "VERSION_NOT_FOUND");
      error(await cli(cwd, ["specgraph", "query", FSD, "--version", "v99.0"]), "VERSION_NOT_FOUND");
      for (const option of ["--deps", "--implements", "--unknown", "--version"]) {
        error(await cli(cwd, ["specgraph", "query", FSD, option]), "USAGE_ERROR");
      }
      for (const direction of ["from", "to"]) error(await cli(cwd, ["deps", FSD, "--direction", direction]), "USAGE_ERROR");
      expect(ok(await core.graph.export()).specs.some((spec) => spec.chunk_id === TDD)).toBe(false);
      expect(ok(await core.graph.export({ version: VERSION })).specs.some((spec) => spec.chunk_id === TDD)).toBe(true);
      expect(ok(await core.graph.impact({ target: `${FSD}:dependency` })).found).toBe(true);
      expect(ok(await core.graph.validateNewModel()).version).toBe(VERSION);
    });
    // Preserve a historical relation that is deliberately outside EdgeRel.
    const graph = ok(await core.graph.export({ version: VERSION }));
    const src = graph.specs.find((spec) => spec.chunk_id === leaf)!.uri;
    const dst = graph.specs.find((spec) => spec.chunk_id === dependency)!.uri;
    graph.edges.push({ src, dst, rel: "related", weight: 1, metadata: { source: "manual" } });
    fs.writeFileSync(path.join(cwd, "project-docs/.meta", `specgraph-${VERSION}.yaml`), stringify(graph));
    await unchanged(cwd, async () => {
      expect(ok(await core.graph.query({ target: leaf })).edges.some((edge) => edge.rel === "related")).toBe(true);
      const all = ok(await core.graph.query({ target: leaf, rels: ["derives", "decomposes", "details", "depends_on"] }));
      expect(all.edges.some((edge) => edge.rel === "related")).toBe(false);
      expect(ok(await cli(cwd, ["specgraph", "query", leaf, "--derives", "--decomposes", "--details", "--depends-on"]))).toEqual(all);
    });
  }, 90_000);

  it("projects baseline summaries in index order, separates statistics, and preserves CLI presentation", async () => {
    const { cwd, core } = await fixture();
    const entries = [
      { id: "[PRD]-summary", file: "prd/[PRD]-summary", heading: "产品", summary: null },
      { id: "[PRD]-summary:feature", file: "prd/[PRD]-summary", heading: "需求", summary: "真实摘要" },
      { id: "[FSD]-summary", file: "fsd/[FSD]-summary", heading: "功能", summary: "功能摘要" },
      { id: "[TDD]-summary", file: "tdd/[TDD]-summary", heading: "实现", summary: null },
      { id: "legacy", file: "archive/legacy", heading: "旧条目", summary: null },
    ].map((entry) => ({ ...entry, level: 2, metadata: {} }));
    const indexFile = path.join(cwd, "project-docs/.meta/chunks-index.yaml");
    fs.writeFileSync(indexFile, stringify({ version: 1, scope: "global", updated: null, chunks: entries }));
    ok(await core.version.create({ version: VERSION }));
    await writeDocument(core, "prd", { id: PRD, content: prdContent });
    await unchanged(cwd, async () => {
      const expected = entries.map(({ id, heading, summary }) => ({ id, heading, summary }));
      expect(ok(await core.search.baselineSummary())).toEqual({ scope: "all", items: expected });
      for (const scope of ["prd", "fsd", "tdd"] as const) {
        const items = expected.filter((entry) => entry.id.startsWith(`[${scope.toUpperCase()}]-`));
        expect(ok(await core.search.baselineSummary({ scope }))).toEqual({ scope, items });
      }
      const argvResult = await cli(cwd, ["baseline-summary", "--scope", "prd", "--format", "json"]);
      expect(ok(argvResult)).toEqual(ok(await core.search.baselineSummary({ scope: "prd" })));
      const bin = path.join(path.dirname(packageEntry), "bin.js");
      for (const argv of [[], ["--scope", "all"], ["--format", "yaml"], ["--format", "json"], ["--scope", "prd", "--format", "json"]]) {
        const result = await command(cwd, [bin, "baseline-summary", ...argv]);
        expect(result.status, result.stderr).toBe(0);
        const items = argv.includes("prd") ? expected.slice(0, 2) : expected;
        if (argv.includes("json")) expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: items });
        else expect(parse(result.stdout)).toEqual(items);
      }
      const stats = ok(await core.search.baselineStats());
      expect(Object.keys(stats).sort()).toEqual(["chunks", "docs", "edges", "versions"]);
      expect(stats).not.toHaveProperty("items");
      expect(stats.versions).toContain(VERSION);
    });
    fs.writeFileSync(indexFile, stringify({ chunks: entries.filter((entry) => entry.id.startsWith("[FSD]")) }));
    expect(ok(await core.search.baselineSummary({ scope: "prd" })).items).toEqual([]);
    expect(ok(await core.session.get()).baseline_empty).toBe(false);
    fs.writeFileSync(indexFile, stringify({ chunks: [] }));
    expect(ok(await core.search.baselineSummary())).toEqual({ scope: "all", items: [] });
    expect(ok(await core.session.get()).baseline_empty).toBe(true);
    fs.writeFileSync(indexFile, "chunks: [invalid");
    await unchanged(cwd, async () => {
      error(await core.search.baselineSummary(), "INDEX_UNREADABLE");
      error(await core.session.get(), "INDEX_UNREADABLE");
      const result = await command(cwd, [path.join(path.dirname(packageEntry), "bin.js"), "baseline-summary"]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "INDEX_UNREADABLE" });
    });
  }, 60_000);

  it("reports receipt existence separately from current artifacts, invalidates old deliveries, and never repairs on read", async () => {
    const f = await fixture();
    await specification(f.core);
    const input = { version: VERSION, tddRootId: TDD };
    await unchanged(f.cwd, async () => {
      expect(ok(await f.core.generation.status(input)).items).toMatchObject([{
        tdd_root: TDD, target_file: TARGET, delivery_present: false, receipt_present: false,
        artifact_state: "absent", artifact_sha256: null, receipt_artifact_sha256: null,
      }]);
      error(await f.core.generation.status({ ...input, tddRootId: "[TDD]-unknown" }), "TDD_NOT_FOUND");
      error(await f.core.generation.status({ version: "v99.0" }), "VERSION_NOT_FOUND");
    });
    const first = await delivered(f);
    const second = ok(await f.core.delivery.prepare({ tddRootId: TDD }));
    expect(second.target_state).toBe("loaded");
    await unchanged(f.cwd, async () => {
      error(await f.core.generation.registerReceipt({ generationToken: first.generation_token }), "GENERATION_TOKEN_STALE");
      expect(ok(await f.core.generation.status(input)).items[0]).toMatchObject({ delivery_present: true, receipt_present: false });
    });
    const receipt = ok(await f.core.generation.registerReceipt({ generationToken: second.generation_token }));
    const changedHash = generate(f.cwd, "export const generated = 'changed after receipt';\n");
    await unchanged(f.cwd, async () => {
      const status = ok(await f.core.generation.status(input));
      expect(status.enforcement).toBe("report");
      expect(status.items[0]).toMatchObject({ receipt_present: true, artifact_state: "loaded", artifact_sha256: changedHash,
        receipt_artifact_sha256: receipt.artifact_sha256 });
      expect(status.items[0]!.findings.map((finding) => finding.code)).toContain("GENERATION_ARTIFACT_CHANGED");
      expect(ok(await f.core.generation.verifyReceipts({ version: VERSION }))).toMatchObject({ passed: true, enforcement: "report" });
      error(await f.core.generation.registerReceipt({ generationToken: second.generation_token }), "GENERATION_ARTIFACT_CHANGED");
    });
    fs.unlinkSync(path.join(f.cwd, TARGET));
    await unchanged(f.cwd, async () => {
      expect(ok(await f.core.generation.status(input)).items[0]).toMatchObject({ receipt_present: true, artifact_state: "absent", artifact_sha256: null });
    });
    fs.mkdirSync(path.join(f.cwd, TARGET));
    await unchanged(f.cwd, async () => {
      expect(ok(await f.core.generation.status(input)).items[0]).toMatchObject({ receipt_present: true, artifact_state: "unreadable", artifact_sha256: null });
    });
    const localConfig = path.join(f.cwd, "project-docs/.meta/config.local.yaml");
    fs.writeFileSync(localConfig, stringify({ generation_receipts: { enforcement: "block" } }));
    await unchanged(f.cwd, async () => {
      const verification = ok(await f.core.generation.verifyReceipts({ version: VERSION }));
      expect(verification.passed).toBe(false);
      expect(verification.findings.length).toBeGreaterThan(0);
      error(await f.core.version.confirm({ version: VERSION }), "GENERATION_RECEIPTS_FAILED");
    });
  }, 60_000);

  it("uses identical memory/file contexts and retains the last delivery when file output fails", async () => {
    const f = await fixture();
    await specification(f.core);
    const bundleDirectory = directory();
    expect(await node(f.cwd, `
      const { createCoreApi } = await import(entry);
      const core = createCoreApi();
      const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
      const bundleDirectory = ${JSON.stringify(bundleDirectory)};
      for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = bundleDirectory;
      const memory = value(await core.delivery.prepare({ tddRootId: ${JSON.stringify(TDD)} }));
      assert.deepEqual(fs.readdirSync(bundleDirectory), []);
      const pointer = value(await core.delivery.prepare({ tddRootId: ${JSON.stringify(TDD)}, output: "file" }));
      assert.equal(Object.hasOwn(pointer, "content"), false);
      assert.equal(fs.readFileSync(pointer.bundle_path, "utf8"), memory.content);
      for (const key of ["sha256", "bytes", "version", "target_file", "tdd_root", "source_file"]) assert.equal(pointer[key], memory[key]);
      fs.mkdirSync(path.dirname(pointer.target_file), { recursive: true });
      fs.writeFileSync(pointer.target_file, "export const generated = 'same bytes';\\n");
      const receipt = value(await core.generation.registerReceipt({ generationToken: pointer.generation_token }));
      const metadataFile = path.resolve("project-docs/.meta/versions/${VERSION}.yaml");
      const before = fs.readFileSync(metadataFile);
      const blocked = path.join(bundleDirectory, "unwritable-temporary-directory");
      fs.writeFileSync(blocked, "file prevents creation of a child directory");
      for (const key of ["TMP", "TEMP", "TMPDIR"]) process.env[key] = blocked;
      const failure = await core.delivery.prepare({ tddRootId: ${JSON.stringify(TDD)}, output: "file" });
      assert.equal(failure.ok, false); assert.ok(failure.code); assert.ok(failure.error);
      assert.deepEqual(fs.readFileSync(metadataFile), before);
      assert.deepEqual(value(await core.generation.registerReceipt({ generationToken: pointer.generation_token })), receipt);
      assert.equal((await core.generation.registerReceipt({ generationToken: memory.generation_token })).code, "GENERATION_TOKEN_STALE");
      assert.deepEqual(value(await core.generation.verifyReceipts({ version: ${JSON.stringify(VERSION)} })).findings, []);
      process.stdout.write(JSON.stringify({ equalBytes: true, preservedReceipt: true }));
    `)).toEqual({ equalBytes: true, preservedReceipt: true });
  }, 60_000);

  it("preserves specification read errors instead of inventing an absent generation target", async () => {
    const { cwd, core } = await fixture();
    await specification(core);
    const folder = path.join(cwd, "project-docs/versions", VERSION, "tdd");
    const source = fs.readdirSync(folder).find((file) => file.includes(TDD));
    expect(source).toBeDefined();
    fs.unlinkSync(path.join(folder, source!));
    await unchanged(cwd, async () => {
      const result = await core.generation.status({ version: VERSION, tddRootId: TDD });
      error(result);
      if (!result.ok) {
        expect(result.code).not.toBe("GENERATION_ARTIFACT_MISSING");
        expect(result.error).toContain(TDD);
      }
    });
  }, 30_000);

  it("computes missing, valid, stale and historical confirmation states from current facts", async () => {
    const f = await fixture();
    await specification(f.core);
    await delivered(f);
    await unchanged(f.cwd, async () => {
      expect(ok(await f.core.version.inspect({ version: VERSION })).confirmation).toEqual({
        state: "missing", plan_fingerprint: null, current_fingerprint: null, planned_operations: 0,
      });
    });
    ok(await f.core.version.confirm({ version: VERSION }));
    await unchanged(f.cwd, async () => {
      const inspection = ok(await f.core.version.inspect({ version: VERSION }));
      expect(inspection.confirmation.state).toBe("valid");
      expect(inspection.confirmation.current_fingerprint).toBe(inspection.confirmation.plan_fingerprint);
      expect(inspection.confirmation.planned_operations).toBeGreaterThan(0);
      expect(inspection.bindings.host_anchor_resolvable).toBe(null);
      expect(inspection.recovery).toEqual({ state: "none", phase: null, diagnostic: null });
      const panel = ok(await f.core.state.get());
      expect(panel.tdd_chunks).toContain(TDD);
      expect(ok(await f.core.state.render()).content).toContain(VERSION);
      const session = ok(await f.core.session.get());
      expect(session).toMatchObject({ active_version: VERSION, phase: "tdd-confirm" });
      expect(session.text).not.toMatch(/next_action|next_call|required_next_call|codegen prepare|generation\.registerReceipt|下一步/);
    });
    generate(f.cwd, "export const generated = 'changed after confirm';\n");
    await unchanged(f.cwd, async () => {
      const inspection = ok(await f.core.version.inspect({ version: VERSION }));
      expect(inspection.confirmation.state).toBe("stale");
      expect(inspection.confirmation.current_fingerprint).not.toBe(inspection.confirmation.plan_fingerprint);
      error(await f.core.version.merge({ version: VERSION }), "CONFIRMATION_STALE");
    });
    await delivered(f);
    ok(await f.core.version.confirm({ version: VERSION }));
    ok(await f.core.version.merge({ version: VERSION }));
    await unchanged(f.cwd, async () => {
      const inspection = ok(await f.core.version.inspect({ version: VERSION }));
      expect(inspection.confirmation).toEqual({ state: "not_applicable", plan_fingerprint: null, current_fingerprint: null, planned_operations: 0 });
      expect(inspection.bindings.docs_anchor_resolvable).toBe(true);
      expect(inspection.bindings.docs_commit).toMatch(/^[0-9a-f]{40,64}$/);
      expect(ok(await f.core.version.list()).versions[0]).toMatchObject({ version: VERSION, phase: "merged", merged: true });
    });
    const saved = ok(await f.core.state.save({ version: VERSION, format: "json" }));
    expect(saved).toHaveProperty("merged", true);
    const absolute = path.isAbsolute(saved.saved_to) ? saved.saved_to : path.join(f.cwd, saved.saved_to);
    expect(fs.readFileSync(absolute, "utf8")).toContain(VERSION);
    ok(await f.core.version.backfillTags());
    const push = ok(await f.core.publish.push({ dryRun: true }));
    expect(push.host.status).toBe("not_applicable");
    expect(push.docs.status).toBeTypeOf("string");
  }, 60_000);

  it("reports governance overrides, corrupt metadata and recovery records without silent fallback", async () => {
    const { cwd, core } = await fixture();
    const metaRoot = path.join(cwd, "project-docs/.meta");
    expect(ok(await core.governance.getPolicy())).toMatchObject({ generation_receipts: { enforcement: "report" },
      target_file_existence: { enforcement: "warn" }, derives_residue: { enforcement: "warn" } });
    fs.writeFileSync(path.join(metaRoot, "config.local.yaml"), stringify({
      generation_receipts: { enforcement: "block" }, target_file_existence: { enforcement: "block" },
      artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "block",
        exempt_paths: ["tests/z.ts", "tests/a.ts", "tests/a.ts"], exempt_test_splits: ["[FSD]-z:TEST", "[FSD]-a:TEST", "[FSD]-a:TEST"] } },
      unrelated_machine_setting: "must not be exposed",
    }));
    await unchanged(cwd, async () => {
      const policy = ok(await core.governance.getPolicy());
      expect(Object.keys(policy).sort()).toEqual(["artifact_scopes", "derives_residue", "generation_receipts", "target_file_existence"]);
      expect(policy.generation_receipts.enforcement).toBe("block");
      expect(policy.artifact_scopes[0]).toMatchObject({ prefix: "tests", exempt_paths: ["tests/a.ts", "tests/z.ts"],
        exempt_test_splits: ["[FSD]-a:TEST", "[FSD]-z:TEST"] });
    });
    fs.writeFileSync(path.join(metaRoot, "config.local.yaml"), "generation_receipts: [broken");
    await unchanged(cwd, async () => { error(await core.governance.getPolicy(), "CONFIG_UNREADABLE"); });
    fs.unlinkSync(path.join(metaRoot, "config.local.yaml"));
    ok(await core.version.create({ version: VERSION }));
    const metaFile = path.join(metaRoot, "versions", `${VERSION}.yaml`);
    const initial = parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
    const missingAnchor = "a".repeat(40);
    fs.writeFileSync(metaFile, stringify({ ...initial, docs_commit: missingAnchor, code_result: missingAnchor,
      recovery_journal: { docs_head: missingAnchor, host_head: null, docs_target: missingAnchor, host_target: null,
        later_versions: [], phase: "recovery_pending", diagnostic: "人工恢复所需事实" } }));
    await unchanged(cwd, async () => {
      const inspection = ok(await core.version.inspect({ version: VERSION }));
      expect(inspection.bindings).toMatchObject({ docs_commit: missingAnchor, code_result: missingAnchor,
        docs_anchor_resolvable: false, host_anchor_resolvable: false });
      expect(inspection.recovery).toEqual({ state: "recorded", phase: "recovery_pending", diagnostic: "人工恢复所需事实" });
      expect(ok(await core.generation.status({ version: VERSION })).items).toEqual([]);
    });
    fs.writeFileSync(path.join(metaRoot, "versions/v2.0.yaml"), stringify({ ...initial, version: "v2.0" }));
    await unchanged(cwd, async () => {
      error(await core.session.get(), "ACTIVE_VERSION_CONFLICT");
      error(await core.version.list(), "ACTIVE_VERSION_CONFLICT");
      error(await core.graph.query({ target: FSD }), "ACTIVE_VERSION_CONFLICT");
      error(await cli(cwd, ["specgraph", "query", FSD]), "ACTIVE_VERSION_CONFLICT");
      expect(ok(await core.graph.query({ target: FSD, version: "baseline" })).found).toBe(false);
    });
    fs.unlinkSync(path.join(metaRoot, "versions/v2.0.yaml"));
    fs.writeFileSync(metaFile, "phase: [corrupt");
    await unchanged(cwd, async () => {
      error(await core.session.get()); error(await core.version.list());
      error(await core.version.inspect({ version: VERSION }));
      error(await core.generation.status({ version: VERSION }));
    });
  }, 60_000);

  it("keeps real acceptance and embedded confirm nonblocking, orders actual progress, and isolates callback failures", async () => {
    const f = await fixture();
    await specification(f.core);
    await delivered(f);
    const result = await node(f.cwd, `
      const { createCoreApi } = await import(entry);
      const events = [];
      const core = createCoreApi({ onProgress(event) { events.push({ ...event, observed: Date.now() }); } });
      const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
      const script = path.resolve("delayed-acceptance.cjs");
      fs.writeFileSync(script, [
        "const fs = require('node:fs');",
        "fs.writeFileSync('acceptance-started', 'yes');",
        "fs.appendFileSync('acceptance-count', 'run\\\\n');",
        "console.log('acceptance stdout must not leak');",
        "console.error('acceptance stderr must not leak');",
        "setTimeout(() => { fs.writeFileSync('acceptance-completed', 'yes'); process.exit(process.env.TEST_FAIL_ACCEPTANCE === 'yes' ? 7 : 0); }, 650);",
      ].join("\\n"));
      value(await core.acceptance.set({ command: JSON.stringify(process.execPath) + " " + JSON.stringify(script) }));
      assert.equal(value(await core.acceptance.show()).command.includes("delayed-acceptance"), true);
      const check = async (operation, run, shouldFail = false) => {
        for (const file of ["acceptance-started", "acceptance-completed"]) fs.rmSync(file, { force: true });
        events.length = 0;
        let duringAcceptance = 0;
        const timer = setInterval(() => {
          if (fs.existsSync("acceptance-started") && !fs.existsSync("acceptance-completed")) duringAcceptance++;
        }, 15);
        let result;
        try { result = await run(); } finally { clearInterval(timer); }
        assert.ok(duringAcceptance >= 5, "Host timer must run while acceptance is actually executing: " + duringAcceptance);
        assert.ok(events.length > 0);
        const ids = new Set(events.map(event => event.operationId));
        assert.equal(ids.size, 1);
        for (const event of events) {
          assert.equal(event.operation, operation);
          assert.ok(event.operationId.length > 0);
          assert.deepEqual(Object.keys(event).sort(), ["observed", "operation", "operationId", "stage", "status"]);
        }
        const stageEvents = events.filter(event => event.stage === "acceptance");
        assert.deepEqual(stageEvents.map(event => event.status), ["started", shouldFail ? "failed" : "completed"]);
        assert.ok(stageEvents[1].observed - stageEvents[0].observed >= 500);
        assert.equal(fs.existsSync("acceptance-completed"), true);
        const open = new Map();
        for (const event of events) {
          const count = open.get(event.stage) || 0;
          if (event.status === "started") open.set(event.stage, count + 1);
          else { assert.ok(count > 0, "Completion must follow a start: " + event.stage); open.set(event.stage, count - 1); }
        }
        assert.ok([...open.values()].every(count => count === 0));
        return result;
      };
      assert.deepEqual(value(await check("acceptance.run", () => core.acceptance.run())), { ran: true, passed: true, exitCode: 0 });
      assert.equal(value(await check("version.confirm", () => core.version.confirm({ version: ${JSON.stringify(VERSION)} }))).passed, true);
      process.env.TEST_FAIL_ACCEPTANCE = "yes";
      assert.deepEqual(value(await check("acceptance.run", () => core.acceptance.run(), true)), { ran: true, passed: false, exitCode: 7 });
      const failedConfirm = await check("version.confirm", () => core.version.confirm({ version: ${JSON.stringify(VERSION)} }), true);
      assert.equal(failedConfirm.ok, false); assert.equal(failedConfirm.code, "ACCEPTANCE_FAILED");
      delete process.env.TEST_FAIL_ACCEPTANCE;
      const before = fs.readFileSync("acceptance-count", "utf8");
      const throwing = createCoreApi({ onProgress() { throw new Error("display callback failure"); } });
      assert.equal(value(await throwing.acceptance.run()).passed, true);
      assert.equal(fs.readFileSync("acceptance-count", "utf8").length - before.length, "run\\n".length);
      const rejecting = createCoreApi({ onProgress: async () => { throw new Error("async display callback failure"); } });
      assert.equal(value(await rejecting.acceptance.run()).passed, true);
      process.stdout.write(JSON.stringify({ independent: true, embedded: true, failure: true, callbacks: true }));
    `);
    expect(result).toEqual({ independent: true, embedded: true, failure: true, callbacks: true });
  }, 90_000);

  it("returns stable worker startup failures and releases the write queue", async () => {
    expect(await node(directory(), `
      const { default: threads } = await import("node:worker_threads");
      const { syncBuiltinESMExports } = await import("node:module");
      let attempts = 0;
      threads.Worker = class { constructor() {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("startup unavailable"), { code: "WORKER_START_TEST" });
        throw new Error("startup failed without a code");
      } };
      syncBuiltinESMExports();
      const { createCoreApi } = await import(entry);
      const core = createCoreApi();
      const first = await core.project.init({ name: "test" });
      const second = await core.project.init({ name: "test" });
      assert.deepEqual(first, { ok: false, code: "WORKER_START_TEST", error: "startup unavailable" });
      assert.deepEqual(second, { ok: false, code: "INTERNAL_ERROR", error: "startup failed without a code" });
      assert.equal(attempts, 2);
      assert.equal(fs.existsSync("project-docs"), false);
      process.stdout.write(JSON.stringify({ attempts }));
    `)).toEqual({ attempts: 2 });
  }, 30_000);
});
