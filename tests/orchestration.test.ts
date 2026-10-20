import { afterEach, describe, expect, it, vi } from "vitest";

// Only external write failures and the temporary-directory boundary are injected.
const boundary = vi.hoisted(() => ({ bundleWrite: false, renameTarget: "", temporaryRoot: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (...args) => {
    if (boundary.bundleWrite && String(args[0]).endsWith("bundle.md")) {
      throw Object.assign(new Error("injected bundle write failure"), { code: "EIO" });
    }
    actual.writeFileSync(...args);
  };
  const renameSync: typeof actual.renameSync = (source, target) => {
    if (boundary.renameTarget && String(target) === boundary.renameTarget) {
      throw Object.assign(new Error("injected metadata replacement failure"), { code: "EIO" });
    }
    actual.renameSync(source, target);
  };
  return { ...actual, writeFileSync, renameSync, default: { ...actual, writeFileSync, renameSync } };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const tmpdir = () => boundary.temporaryRoot || actual.tmpdir();
  return { ...actual, tmpdir, default: { ...actual, tmpdir } };
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreResultSchema, NextActionSchema, VersionMetaSchema, type GenerationDeliveryInput } from "../src/doc-model/schemas.js";
import { writeLocalConfig } from "../src/foundation/config.js";
import type { ProjectRoot } from "../src/foundation/root.js";
import { loadModel, saveModel } from "../src/foundation/yaml.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import { NewModelManager, type CreateOpts, type DocLayer } from "../src/new-model/model-manager.js";
import { codegenPrepare } from "../src/new-model/codegen.js";
import { SpecGraphStore } from "../src/specgraph/graph-model.js";
import { VersionManager } from "../src/versioning/version-manager.js";
import { versionMerge } from "../src/versioning/merge-engine.js";
import { dispatch, runCli } from "../src/cli/dispatcher.js";
import { prepareDelivery, type DeliveryPointer } from "../src/orchestration/context-delivery.js";
import { issueGenerationToken, registerGenerationReceipt, verifyGenerationReceipts } from "../src/orchestration/generation-receipts.js";
import { buildNextAction, contractText } from "../src/orchestration/next-action.js";
import { evaluateWriteGuard, type GuardInput } from "../src/orchestration/guard-decisions.js";
import { getSessionContext } from "../src/orchestration/session-context.js";

const VERSION = "v0.10";
const PRD = "[PRD]-orchestration";
const FSD = "[FSD]-orchestration";
const TDD = "[TDD]-orchestration";
const TARGET = "src/生成 target.ts";
const originalCwd = process.cwd();
const temporaryRoot = path.resolve(os.tmpdir());
const ownedDirectories = new Set<string>();
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

function trackDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const relative = path.relative(temporaryRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !/^ait-(?:orchestration|codegen)-/.test(path.basename(absolute))) {
    throw new Error(`Refusing to own a directory outside this test's temporary roots: ${absolute}`);
  }
  ownedDirectories.add(absolute);
}

afterEach(() => {
  boundary.bundleWrite = false;
  boundary.renameTarget = "";
  boundary.temporaryRoot = "";
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const directory of ownedDirectories) {
    const relative = path.relative(temporaryRoot, path.resolve(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup target");
    fs.rmSync(directory, { recursive: true, force: true });
  }
  ownedDirectories.clear();
});

function makeRoot(): ProjectRoot {
  const cwd = fs.mkdtempSync(path.join(temporaryRoot, "ait-orchestration-"));
  trackDirectory(cwd);
  const root = path.join(cwd, "project-docs");
  const docs = path.join(root, "docs");
  const meta = path.join(root, ".meta");
  for (const directory of ["prd", "fsd", "tdd"]) fs.mkdirSync(path.join(docs, directory), { recursive: true });
  fs.mkdirSync(path.join(meta, "versions"), { recursive: true });
  const result = { cwd, root, docs, meta };
  new IndexManager(result).rebuildBaseline();
  new SpecGraphStore(result).sync();
  return result;
}

function treeSnapshot(root: ProjectRoot): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root.cwd, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        result[`${relative}/`] = "directory";
        visit(absolute);
      } else {
        result[relative] = fs.readFileSync(absolute).toString("base64");
      }
    }
  };
  visit(root.cwd);
  return result;
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

function rejectWithoutWrites(root: ProjectRoot, operation: () => unknown, code: string): void {
  const before = treeSnapshot(root);
  expectCode(operation, code);
  expect(treeSnapshot(root)).toEqual(before);
}

const prdText = [
  `<!-- @id:${PRD} -->`, "## 编排产品", "完整交付与可核验生成。",
  ...["generate", "dependency"].flatMap((name) => [
    "", `<!-- @id:${PRD}:${name} -->`, `## ${name}`,
    "**用户故事:** 作为开发者，我希望读取完整契约，以便可靠生成制品。",
    "#### 验收标准", "1. WHEN 交付完成 THEN 系统 SHALL 返回可验证结果。",
  ]),
].join("\n");
const fsdText = [
  `<!-- @id:${FSD} -->`, "## 编排功能根", "所有宿主共用同一份契约。",
  "", `<!-- @id:${FSD}:generate -->`, "## 生成能力", "```yaml",
  `derives: ["${PRD}:generate"]`, "depends_on: [dependency]", "```", "生成规格定义的唯一目标。",
  "", `<!-- @id:${FSD}:dependency -->`, "## 依赖契约", "```yaml",
  `derives: ["${PRD}:dependency"]`, "```", "依赖保留参数与 Unicode：雪、🧪、é。",
  "", `<!-- @id:${FSD}:TEST -->`, "## 接口验收", "```yaml", "depends_on: [dependency]", "```", "验收交付与实现。",
].join("\n");

function tddText(id = TDD, target = TARGET, body = "严格依据完整正文实现。雪 🧪 é。"): string {
  return [`<!-- @id:${id} -->`, "## 文件级实现", "```yaml", `target_file: ${JSON.stringify(target)}`, "```", "", body].join("\n");
}

async function writeDocument(manager: NewModelManager, layer: DocLayer, id: string, content: string, opts: CreateOpts = {}): Promise<void> {
  const discussion = await manager.createDocument(layer, id, opts);
  expect(discussion.mode).toBe("discussion-context");
  if (discussion.mode !== "discussion-context") throw new Error("Expected a real discussion token");
  expect(discussion.context_token).toMatch(/^ctx-v1\./);
  const written = await manager.createDocument(layer, id, { ...opts, content, contextToken: discussion.context_token });
  expect(written.mode).toBe("written");
  expect(written).not.toHaveProperty("audit");
}

async function writeTree(root: ProjectRoot, opts: { confirmed?: boolean; rich?: boolean; body?: string; target?: string; action?: "add" | "modify" } = {}): Promise<NewModelManager> {
  const manager = new NewModelManager(root);
  const intent: CreateOpts = { action: opts.action ?? "add" };
  await writeDocument(manager, "prd", PRD, prdText, intent);
  manager.confirmLayer("prd");
  await writeDocument(manager, "fsd", FSD, fsdText, { ...intent, parent: PRD });
  manager.confirmLayer("fsd");
  if (opts.rich) {
    await writeDocument(manager, "tdd", "[TDD]-implementation", tddText("[TDD]-implementation", "src/implementation.ts"), { ...intent, parent: `${FSD}:generate` });
  }
  await writeDocument(manager, "tdd", TDD, tddText(TDD, opts.target ?? TARGET, opts.body), { ...intent, parent: `${FSD}:${opts.rich ? "TEST" : "generate"}` });
  if (opts.confirmed !== false) manager.confirmLayer("tdd");
  return manager;
}

async function fixture(opts: Parameters<typeof writeTree>[1] = {}): Promise<{ root: ProjectRoot; manager: NewModelManager }> {
  const root = makeRoot();
  new VersionManager(root).versionCreate(VERSION);
  return { root, manager: await writeTree(root, opts) };
}

function metadata(root: ProjectRoot, version = VERSION) {
  return loadModel(path.join(root.meta, "versions", `${version}.yaml`), VersionMetaSchema);
}

function deliver(root: ProjectRoot, version?: string | null): DeliveryPointer {
  const pointer = prepareDelivery(root, { tddRoot: TDD, ...(version === undefined ? {} : { version }) });
  trackDirectory(path.dirname(pointer.bundle_path));
  return pointer;
}

function artifact(root: ProjectRoot, content = "export const generated = '雪 🧪';\r\n", target = TARGET): Buffer {
  const absolute = path.join(root.cwd, target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return fs.readFileSync(absolute);
}

function deliveryInput(pointer: DeliveryPointer): GenerationDeliveryInput {
  return { version: pointer.version, tdd_root: pointer.tdd_root, target_file: pointer.target_file,
    bundle_path: pointer.bundle_path, bundle_sha256: pointer.sha256, bytes: pointer.bytes };
}

async function inProject<T>(root: ProjectRoot, operation: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root.cwd);
  try { return await operation(); } finally { process.chdir(previous); }
}

async function mergeFixture(root: ProjectRoot): Promise<void> {
  const confirmed = await new VersionManager(root).versionConfirm(VERSION);
  expect(confirmed.passed).toBe(true);
  expect((await versionMerge(root, VERSION)).version).toBe(VERSION);
}

describe("context delivery", () => {
  it("delivers a large Unicode body, explicit ordered roles, exact bytes and a small CLI pointer", async () => {
    const body = Array.from({ length: 5000 }, (_, index) => `${index}: 完整正文 雪 🧪 é <tag> & \\ path  `).join("\n") + "\n正文结束。";
    const { root } = await fixture({ rich: true, body });
    const oldArtifact = "// before generation 雪\r\nexport const before = 1;\r\n";
    artifact(root, oldArtifact);
    const expected = codegenPrepare(root, null, TDD);
    const beforeTarget = fs.readFileSync(path.join(root.cwd, TARGET));
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
    let exitCode: number;
    try { exitCode = await inProject(root, () => runCli(["codegen", "prepare", TDD])); } finally { stdout.mockRestore(); }
    expect(exitCode).toBe(0);
    expect(output.trim().split("\n")).toHaveLength(1);
    const result = CoreResultSchema.parse(JSON.parse(output));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const pointer = result.data as unknown as DeliveryPointer;
    trackDirectory(path.dirname(pointer.bundle_path));
    expect(path.isAbsolute(pointer.bundle_path)).toBe(true);
    const relative = path.relative(root.cwd, pointer.bundle_path);
    expect(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)).toBe(true);
    expect(pointer).toMatchObject({ version: VERSION, target_file: TARGET, tdd_root: TDD,
      source_file: path.join(root.root, "versions", VERSION, "tdd", `${TDD}.md`) });
    const bytes = fs.readFileSync(pointer.bundle_path);
    const text = bytes.toString("utf8");
    expect(bytes.length).toBeGreaterThan(200_000);
    expect(pointer.bytes).toBe(bytes.length);
    expect(pointer.sha256).toBe(sha256(bytes));
    expect(Buffer.byteLength(output)).toBeLessThan(10_000);
    expect(output).not.toContain("4999: 完整正文");
    expect(text).toContain(body);
    expect(text).toContain(oldArtifact);
    const roles = ["实现规格", "直接开发依据", "依赖的对外接口", "所属域约束", "相关实现参考", "产品意图", "目标文件现状"];
    const positions = roles.map((role, index) => text.indexOf(`## ${index + 1}. ${role}`));
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true);
    for (const item of [...expected.upstream, ...expected.dependencies]) {
      expect(text).toContain(item.content);
      expect(text).toContain(`id: ${JSON.stringify(item.id)}`);
      expect(text).toContain(`source_file: ${JSON.stringify(item.file)}`);
      expect(text).toContain(`selection_reason: ${JSON.stringify(item.selectionReason)}`);
    }
    expect(fs.readFileSync(path.join(root.cwd, TARGET))).toEqual(beforeTarget);
    expect(NextActionSchema.parse(pointer.next_action).type).toBe("continue");
    expect(pointer.next_action).toMatchObject({ instruction: expect.stringContaining(pointer.sha256), next_call: expect.stringContaining(pointer.generation_token) });
    const persisted = fs.readFileSync(path.join(root.meta, "versions", `${VERSION}.yaml`), "utf8");
    expect(persisted).not.toContain(pointer.generation_token);
    expect(metadata(root).generation?.deliveries[0]).toMatchObject({ token_digest: sha256(pointer.generation_token), before_artifact: { state: "loaded", sha256: sha256(beforeTarget) } });
  });

  it("preserves CRLF and trailing spaces from an existing confirmed source byte for byte", async () => {
    const { root } = await fixture();
    // This isolated compatibility case changes only source encoding, after the real confirmation flow.
    const source = path.join(root.root, "versions", VERSION, "tdd", `${TDD}.md`);
    const raw = fs.readFileSync(source, "utf8").replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "  \r\n");
    fs.writeFileSync(source, raw);
    const pointer = deliver(root);
    expect(fs.readFileSync(pointer.bundle_path, "utf8")).toContain(raw);
  });

  it.each(["absent", "unreadable"] as const)("keeps target state %s distinct and marks empty roles explicitly", async (state) => {
    const { root } = await fixture();
    if (state === "unreadable") fs.mkdirSync(path.join(root.cwd, TARGET), { recursive: true });
    const pointer = deliver(root);
    const text = fs.readFileSync(pointer.bundle_path, "utf8");
    expect(text).toContain(`target_state: ${state}`);
    expect(text).toMatch(/## 5\. 相关实现参考\s+（无）/);
    expect(metadata(root).generation?.deliveries[0]?.before_artifact).toEqual({ state, sha256: null });
    if (state === "unreadable") {
      expect(text).not.toContain("target_state: absent");
      expect(pointer.next_action).toMatchObject({ instruction: expect.stringContaining("unreadable") });
      expect(text).toContain("不得以空内容覆盖");
    }
  });

  it("rejects unconfirmed active TDD through both APIs without issuing a token", async () => {
    const { root } = await fixture({ confirmed: false });
    rejectWithoutWrites(root, () => prepareDelivery(root, { tddRoot: TDD }), "TDD_NOT_CONFIRMED");
    const before = treeSnapshot(root);
    const result = await inProject(root, () => dispatch(["codegen", "prepare", TDD]));
    expect(result).toMatchObject({ ok: false, code: "TDD_NOT_CONFIRMED" });
    expect(result).not.toHaveProperty("data");
    expect(treeSnapshot(root)).toEqual(before);
    expect(metadata(root).generation).toBeNull();
  });

  it.each([
    ["missing file", "CODEGEN_SOURCE_MISSING"],
    ["missing chunk", "CODEGEN_CHUNK_MISSING"],
    ["invalid chunk syntax", "CHUNK_PARSE_ERROR"],
  ])("rejects an active override with %s instead of falling back to baseline", async (failure, code) => {
    const { root } = await fixture();
    await mergeFixture(root);
    new VersionManager(root).versionCreate("v0.11");
    await writeTree(root, { action: "modify", body: "CURRENT_VERSION_BODY", target: "src/current.ts" });
    const pointer = deliver(root);
    expect(pointer).toMatchObject({ version: "v0.11", target_file: "src/current.ts" });
    expect(fs.readFileSync(pointer.bundle_path, "utf8")).toContain("CURRENT_VERSION_BODY");
    const baseline = fs.readFileSync(path.join(root.docs, "tdd", `${TDD}.md`));
    if (failure === "missing file") fs.unlinkSync(pointer.source_file);
    else if (failure === "missing chunk") fs.writeFileSync(pointer.source_file, "<!-- @id:[TDD]-other -->\n## Other\n");
    else fs.writeFileSync(pointer.source_file, "<!-- @id:[TDD]-INVALID -->\n## Invalid\n");
    const generation = metadata(root, "v0.11").generation;
    rejectWithoutWrites(root, () => prepareDelivery(root, { tddRoot: TDD }), code!);
    expect(metadata(root, "v0.11").generation).toEqual(generation);
    expect(fs.readFileSync(path.join(root.docs, "tdd", `${TDD}.md`))).toEqual(baseline);
  });

  it.each(["bundle", "metadata"] as const)("preserves the previous delivery and receipt when %s writing fails", async (failure) => {
    const { root } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    const receipt = registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    const oldBundle = fs.readFileSync(pointer.bundle_path);
    if (failure === "bundle") boundary.bundleWrite = true;
    else boundary.renameTarget = path.join(root.meta, "versions", `${VERSION}.yaml`);
    rejectWithoutWrites(root, () => prepareDelivery(root, { tddRoot: TDD }), "EIO");
    boundary.bundleWrite = false;
    boundary.renameTarget = "";
    expect(fs.readFileSync(pointer.bundle_path)).toEqual(oldBundle);
    expect(registerGenerationReceipt(root, { generation_token: pointer.generation_token })).toEqual(receipt);
  });

  it("rejects a system temporary directory inside the project without touching old delivery state", async () => {
    const { root } = await fixture();
    const pointer = deliver(root);
    boundary.temporaryRoot = root.cwd;
    rejectWithoutWrites(root, () => prepareDelivery(root, { tddRoot: TDD }), "DELIVERY_PATH_INVALID");
    expect(metadata(root).generation?.deliveries[0]?.token_digest).toBe(sha256(pointer.generation_token));
  });

  it("defaults to baseline only after there is no active version", async () => {
    const { root } = await fixture();
    await mergeFixture(root);
    const pointer = deliver(root);
    expect(pointer).toMatchObject({ version: null, source_file: path.join(root.docs, "tdd", `${TDD}.md`) });
    expect(fs.existsSync(path.join(root.meta, "generation-baseline.yaml"))).toBe(true);
    artifact(root);
    expect(registerGenerationReceipt(root, { generation_token: pointer.generation_token }).version).toBeNull();
    new VersionManager(root).versionCreate("v0.11");
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), "GENERATION_TOKEN_STALE");
  });
});

describe("generation receipts", () => {
  it("records actual artifact bytes after generation and makes unchanged registration idempotent", async () => {
    const { root } = await fixture();
    const before = artifact(root, "// before\r\n");
    const pointer = deliver(root);
    expect(metadata(root).generation?.deliveries[0]?.before_artifact).toEqual({ state: "loaded", sha256: sha256(before) });
    const generated = artifact(root, "export const result = '完整 🧪';\r\n");
    const receipt = registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    expect(receipt).toEqual({ version: VERSION, tdd_root: TDD, target_file: TARGET,
      bundle_sha256: pointer.sha256, artifact_sha256: sha256(generated), generated_at: expect.any(String) });
    expect(Number.isNaN(Date.parse(receipt.generated_at))).toBe(false);
    expect(receipt.artifact_sha256).not.toBe(sha256(before));
    const snapshot = treeSnapshot(root);
    expect(registerGenerationReceipt(root, { generation_token: pointer.generation_token })).toEqual(receipt);
    expect(verifyGenerationReceipts(root, VERSION)).toEqual({ enforcement: "report", passed: true, findings: [] });
    expect(treeSnapshot(root)).toEqual(snapshot);
  });

  it("rejects a forged token and a valid token from another project without any partial record", async () => {
    const { root } = await fixture();
    const other = await fixture();
    const pointer = deliver(root);
    artifact(root);
    artifact(other.root);
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: "fabricated-token" }), "GENERATION_TOKEN_INVALID");
    rejectWithoutWrites(other.root, () => registerGenerationReceipt(other.root, { generation_token: pointer.generation_token }), "GENERATION_TOKEN_STALE");
    expect(metadata(other.root).generation).toBeNull();
    expect(metadata(root).generation?.deliveries[0]?.receipt).toBeNull();
  });

  it("invalidates an old token and receipt even when redelivery has the identical bundle hash", async () => {
    const { root } = await fixture();
    artifact(root);
    const first = deliver(root);
    registerGenerationReceipt(root, { generation_token: first.generation_token });
    const oldRecord = metadata(root).generation?.deliveries[0];
    const second = deliver(root);
    expect(second.sha256).toBe(first.sha256);
    expect(second.generation_token).not.toBe(first.generation_token);
    expect(metadata(root).generation?.deliveries).toHaveLength(1);
    expect(metadata(root).generation?.deliveries[0]?.delivery_id).not.toBe(oldRecord?.delivery_id);
    expect(metadata(root).generation?.deliveries[0]?.receipt).toBeNull();
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: first.generation_token }), "GENERATION_TOKEN_STALE");
    expect(verifyGenerationReceipts(root, VERSION).findings).toEqual([
      expect.objectContaining({ code: "GENERATION_RECEIPT_MISSING", tdd_root: TDD, target_file: TARGET }),
    ]);
    expect(registerGenerationReceipt(root, { generation_token: second.generation_token }).bundle_sha256).toBe(second.sha256);
  });

  it("rejects changed specifications, then invalidates the old identity on different-content redelivery", async () => {
    const { root } = await fixture();
    const first = deliver(root);
    artifact(root);
    registerGenerationReceipt(root, { generation_token: first.generation_token });
    fs.appendFileSync(first.source_file, "\n规格发生外部变化。\n");
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: first.generation_token }), "GENERATION_SPEC_CHANGED");
    expect(verifyGenerationReceipts(root, VERSION).findings).toEqual([
      expect.objectContaining({ code: "GENERATION_SPEC_CHANGED", tdd_root: TDD }),
    ]);
    const second = deliver(root);
    expect(second.sha256).not.toBe(first.sha256);
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: first.generation_token }), "GENERATION_TOKEN_STALE");
  });

  it("invalidates the old token through the real TDD revert and reconfirm flow", async () => {
    const { root, manager } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    manager.revertLayer("tdd");
    await writeDocument(manager, "tdd", TDD, tddText(TDD, TARGET, "返工后的规格。"), { parent: `${FSD}:generate`, action: "add" });
    manager.confirmLayer("tdd");
    expect(metadata(root).generation).toBeNull();
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), "GENERATION_TOKEN_STALE");
    expect(verifyGenerationReceipts(root, VERSION).findings[0]?.code).toBe("GENERATION_RECEIPT_MISSING");
  });

  it("does not revive a token after deleting and recreating the same version", async () => {
    const { root } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    const versions = new VersionManager(root);
    expect((await versions.versionRevert(VERSION, { confirm: true })).mode).toBe("unmerged");
    versions.versionCreate(VERSION);
    await writeTree(root);
    expect(metadata(root).generation).toBeNull();
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), "GENERATION_TOKEN_STALE");
  });

  it("rejects a changed target declaration without registering against either path", async () => {
    const { root } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    artifact(root, "// other target\n", "src/other.ts");
    fs.writeFileSync(pointer.source_file, tddText(TDD, "src/other.ts"));
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), "GENERATION_SPEC_CHANGED");
    expect(metadata(root).generation?.deliveries[0]?.receipt).toBeNull();
  });

  it.each([
    ["absent", "GENERATION_ARTIFACT_MISSING"],
    ["unreadable", "GENERATION_ARTIFACT_UNREADABLE"],
  ])("rejects an %s artifact without creating a receipt", async (state, code) => {
    const { root } = await fixture();
    const pointer = deliver(root);
    if (state === "unreadable") fs.mkdirSync(path.join(root.cwd, TARGET), { recursive: true });
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), code!);
    expect(metadata(root).generation?.deliveries[0]?.receipt).toBeNull();
  });

  it.each([
    ["changed", "GENERATION_ARTIFACT_CHANGED"],
    ["missing", "GENERATION_ARTIFACT_MISSING"],
    ["unreadable", "GENERATION_ARTIFACT_UNREADABLE"],
  ])("detects a registered artifact becoming %s and cannot wash the change through registration", async (state, code) => {
    const { root } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    const receipt = registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    if (state === "changed") artifact(root, "// tampered bytes\n");
    else {
      fs.unlinkSync(path.join(root.cwd, TARGET));
      if (state === "unreadable") fs.mkdirSync(path.join(root.cwd, TARGET));
    }
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), code!);
    const before = treeSnapshot(root);
    expect(verifyGenerationReceipts(root, VERSION).findings).toEqual([
      expect.objectContaining({ code, tdd_root: TDD, target_file: TARGET }),
    ]);
    expect(treeSnapshot(root)).toEqual(before);
    expect(metadata(root).generation?.deliveries[0]?.receipt).toMatchObject(receipt);
  });

  it("preserves a pending delivery when atomic receipt persistence fails", async () => {
    const { root } = await fixture();
    const pointer = deliver(root);
    artifact(root);
    boundary.renameTarget = path.join(root.meta, "versions", `${VERSION}.yaml`);
    rejectWithoutWrites(root, () => registerGenerationReceipt(root, { generation_token: pointer.generation_token }), "EIO");
    boundary.renameTarget = "";
    expect(metadata(root).generation?.deliveries[0]?.receipt).toBeNull();
    expect(registerGenerationReceipt(root, { generation_token: pointer.generation_token }).artifact_sha256).toBe(sha256(fs.readFileSync(path.join(root.cwd, TARGET))));
  });

  it.each(["bytes", "hash", "target", "version", "inside-project", "relative-path"] as const)("validates %s before issuing any replacement token", async (field) => {
    const { root } = await fixture();
    const pointer = deliver(root);
    const input = deliveryInput(pointer);
    if (field === "bytes") input.bytes += 1;
    if (field === "hash") input.bundle_sha256 = "0".repeat(64);
    if (field === "target") input.target_file = "src/other.ts";
    if (field === "version") input.version = null;
    if (field === "inside-project") {
      input.bundle_path = path.join(root.cwd, "copied-bundle.md");
      fs.copyFileSync(pointer.bundle_path, input.bundle_path);
    }
    if (field === "relative-path") input.bundle_path = "bundle.md";
    rejectWithoutWrites(root, () => issueGenerationToken(root, input), field === "target" || field === "version" ? "GENERATION_SPEC_CHANGED" : "GENERATION_TOKEN_INVALID");
    expect(metadata(root).generation?.deliveries[0]?.token_digest).toBe(sha256(pointer.generation_token));
  });
});

describe("read-only receipt verification", () => {
  it.each(["report", "block"] as const)("includes a declared TDD never prepared under %s policy", async (policy) => {
    const { root } = await fixture();
    artifact(root);
    if (policy === "block") writeLocalConfig(root.meta, { generation_receipts: { enforcement: policy } });
    const before = treeSnapshot(root);
    const result = verifyGenerationReceipts(root, VERSION);
    expect(result).toEqual({ enforcement: policy, passed: policy === "report", findings: [
      { code: "GENERATION_RECEIPT_MISSING", tdd_root: TDD, target_file: TARGET, message: expect.any(String) },
    ] });
    expect(verifyGenerationReceipts(root, VERSION)).toEqual(result);
    expect(treeSnapshot(root)).toEqual(before);
    expect(metadata(root).generation).toBeNull();
  });

  it("does not assign unrelated artifacts to a pure documentation version", async () => {
    const root = makeRoot();
    new VersionManager(root).versionCreate(VERSION);
    const manager = new NewModelManager(root);
    await writeDocument(manager, "prd", PRD, prdText);
    manager.confirmLayer("prd");
    await writeDocument(manager, "fsd", FSD, fsdText, { parent: PRD });
    manager.confirmLayer("fsd");
    artifact(root, "// unrelated repository artifact\n");
    writeLocalConfig(root.meta, { generation_receipts: { enforcement: "block" } });
    const before = treeSnapshot(root);
    expect(verifyGenerationReceipts(root, VERSION)).toEqual({ enforcement: "block", passed: true, findings: [] });
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("returns findings in stable order and never creates a state panel", async () => {
    const { root } = await fixture({ rich: true });
    const before = treeSnapshot(root);
    const result = verifyGenerationReceipts(root, VERSION);
    expect(result.findings.map((finding) => finding.tdd_root)).toEqual(["[TDD]-implementation", TDD]);
    expect(verifyGenerationReceipts(root, VERSION)).toEqual(result);
    expect(treeSnapshot(root)).toEqual(before);
    expect(Object.keys(before).some((name) => name.endsWith("/state.md"))).toBe(false);
  });

  it.each([
    ["invalid policy", "CONFIG_UNREADABLE"],
    ["invalid config YAML", "CONFIG_UNREADABLE"],
    ["invalid generation storage", "SCHEMA_VALIDATION_ERROR"],
    ["invalid version YAML", "YAML_PARSE_ERROR"],
    ["invalid index", "INDEX_UNREADABLE"],
  ])("fails closed on %s without writing", async (failure, code) => {
    const { root } = await fixture();
    if (failure === "invalid policy") writeLocalConfig(root.meta, { generation_receipts: { enforcement: "ignore" } });
    if (failure === "invalid config YAML") fs.writeFileSync(path.join(root.meta, "config.yaml"), "[broken");
    if (failure === "invalid generation storage") saveModel(path.join(root.meta, "versions", `${VERSION}.yaml`), { ...metadata(root), generation: { epoch: 7, deliveries: [] } });
    if (failure === "invalid version YAML") fs.writeFileSync(path.join(root.meta, "versions", `${VERSION}.yaml`), "[broken");
    if (failure === "invalid index") fs.writeFileSync(path.join(root.meta, `chunks-index-${VERSION}.yaml`), "chunks: invalid\n");
    rejectWithoutWrites(root, () => verifyGenerationReceipts(root, VERSION), code!);
  });

  it("shares report/block semantics with version confirm and still runs independent acceptance", async () => {
    const { root } = await fixture();
    const versions = new VersionManager(root);
    expect((await versions.versionConfirm(VERSION)).generation_receipts).toMatchObject({ enforcement: "report", passed: true, findings: [expect.objectContaining({ code: "GENERATION_RECEIPT_MISSING" })] });
    writeLocalConfig(root.meta, { generation_receipts: { enforcement: "block" } });
    const before = treeSnapshot(root);
    await expect(versions.versionConfirm(VERSION)).rejects.toMatchObject({ code: "GENERATION_RECEIPTS_FAILED" });
    expect(treeSnapshot(root)).toEqual(before);
    const pointer = deliver(root);
    artifact(root);
    registerGenerationReceipt(root, { generation_token: pointer.generation_token });
    writeLocalConfig(root.meta, { acceptance_command: `"${process.execPath}" -e "process.exit(7)"` });
    const beforeAcceptance = treeSnapshot(root);
    await expect(versions.versionConfirm(VERSION)).rejects.toMatchObject({ code: "ACCEPTANCE_FAILED" });
    expect(treeSnapshot(root)).toEqual(beforeAcceptance);
  });
});

describe("next actions and shared contract", () => {
  it("round-trips real discussion arguments and token through a host following required_next_call", async () => {
    const root = makeRoot();
    new VersionManager(root).versionCreate(VERSION);
    const before = treeSnapshot(root);
    const result = await inProject(root, () => dispatch(["prd", "create", PRD, "--action", "add", "--file", "中文 file.md"]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const action = NextActionSchema.parse(result.data.next_action);
    expect(action.type).toBe("present_and_collect");
    if (action.type !== "present_and_collect") throw new Error("Expected discussion action");
    expect(treeSnapshot(root)).toEqual(before);
    expect(action.instruction).toContain(contractText());
    expect(action.required_next_call).toContain(JSON.stringify(VERSION));
    const match = /await dispatch\((\[.*\])\)/.exec(action.required_next_call);
    expect(match).not.toBeNull();
    const argv = JSON.parse(match![1]!) as string[];
    expect(argv).toEqual(["prd", "create", PRD, "--action", "add", "--file", "中文 file.md", "--context-token", result.data.context_token, "--content", "<讨论后确定的完整正文>"]);
    argv[argv.length - 1] = prdText;
    const written = await inProject(root, () => dispatch(argv));
    expect(written).toMatchObject({ ok: true, data: { mode: "written", next_action: null } });
    expect(fs.readFileSync(path.join(root.root, "versions", VERSION, "prd", "中文 file.md"), "utf8")).toContain("完整交付与可核验生成。");
  });

  it("preserves explicit parent/action/file/override intent and safely escapes Unicode and quotes", async () => {
    const { root, manager } = await fixture({ confirmed: false });
    const discussion = await manager.createDocument("tdd", TDD, { parent: `${FSD}:generate`, action: "add" });
    if (discussion.mode !== "discussion-context") throw new Error("Expected discussion");
    const file = '中文 "file" \\ slash\u2028line.md';
    const data = { ...discussion, target: { id: TDD }, anchor: { id: `${FSD}:generate` }, action: "modify", file, overrides: "[TDD]-previous" };
    const before = treeSnapshot(root);
    const action = buildNextAction("tdd create", data);
    expect(action?.type).toBe("present_and_collect");
    if (action?.type !== "present_and_collect") throw new Error("Expected discussion action");
    const argv = JSON.parse(/await dispatch\((\[.*\])\)/.exec(action.required_next_call)![1]!) as string[];
    expect(argv).toEqual(["tdd", "create", TDD, "--parent", `${FSD}:generate`, "--action", "modify", "--file", file, "--overrides", "[TDD]-previous", "--context-token", discussion.context_token, "--content", "<讨论后确定的完整正文>"]);
    expect(buildNextAction("tdd create", data)).toEqual(action);
    expect(treeSnapshot(root)).toEqual(before);
    for (const missing of ["layer", "version", "target", "context_token", "anchor"]) {
      const incomplete: Record<string, unknown> = { ...data };
      delete incomplete[missing];
      if (missing === "target") delete incomplete.id;
      if (missing === "anchor") delete incomplete.parent;
      expect(buildNextAction("tdd create", incomplete)).toBeNull();
    }
  });

  it("uses the actual generation token and public receipt signature for the continue action", async () => {
    const { root } = await fixture();
    const pointer = deliver(root);
    const action = NextActionSchema.parse(pointer.next_action);
    expect(action.type).toBe("continue");
    if (action.type !== "continue") throw new Error("Expected generation action");
    expect(action.instruction).toContain(contractText());
    expect(action.instruction).toContain(String(pointer.bytes));
    expect(action.instruction).toContain(JSON.stringify(pointer.bundle_path));
    expect(action.instruction).toContain(JSON.stringify(TARGET));
    const tokenMatch = /^registerGenerationReceipt\(root, \{ generation_token: (".*") \}\)$/.exec(action.next_call);
    expect(tokenMatch).not.toBeNull();
    const token = JSON.parse(tokenMatch![1]!) as string;
    expect(token).toBe(pointer.generation_token);
    artifact(root);
    expect(registerGenerationReceipt(root, { generation_token: token }).bundle_sha256).toBe(pointer.sha256);
    const before = treeSnapshot(root);
    const data: Record<string, unknown> = { ...pointer };
    for (const field of ["bundle_path", "sha256", "bytes", "version", "target_file", "tdd_root", "source_file", "generation_token"]) {
      const incomplete = { ...data };
      delete incomplete[field];
      expect(buildNextAction("codegen prepare", incomplete)).toBeNull();
    }
    for (const bytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(buildNextAction("codegen prepare", { ...data, bytes })).toBeNull();
    expect(buildNextAction("codegen prepare", { ...data, sha256: "not-a-digest" })).toBeNull();
    expect(buildNextAction("codegen prepare", { ...data, target_state: "unreadable" })).toMatchObject({ instruction: expect.stringContaining("暂停覆盖") });
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("validates report and null forms without inventing progress or executing suggested calls", async () => {
    const { root, manager } = await fixture();
    manager.revertLayer("tdd");
    const confirmed = manager.confirmLayer("tdd");
    const before = treeSnapshot(root);
    const action = buildNextAction("tdd confirm", { ...confirmed });
    expect(NextActionSchema.parse(action)).toMatchObject({ type: "report", message: expect.stringContaining(VERSION) });
    expect(NextActionSchema.nullable().parse(buildNextAction("unknown operation", {}))).toBeNull();
    expect(buildNextAction("version create", {})).toBeNull();
    expect(buildNextAction("version confirm", { version: VERSION })).toBeNull();
    expect(buildNextAction("tdd confirm", { version: VERSION, phase: "tdd-creating", confirmed: [] })).toBeNull();
    expect(buildNextAction("version confirm", { version: VERSION, passed: false })).toMatchObject({ type: "report", message: expect.stringContaining("未通过") });
    expect(buildNextAction("version confirm", { version: VERSION, passed: true, ok: false })).toBeNull();
    const contract = contractText();
    expect(contractText()).toBe(contract);
    expect(contract).toContain("core 不调用 LLM");
    expect(contract).toContain("回执不证明语义正确");
    const session = getSessionContext(root);
    expect(session.text.split(contract)).toHaveLength(2);
    expect(treeSnapshot(root)).toEqual(before);
  });
});

type GuardCase = { name: string; request: GuardInput; decision: "allow" | "block" };
const posixRoot = "/work/项目 space";
const windowsRoot = "C:\\Work\\项目 space";
function guardCase(name: string, toolName: string, input: unknown, decision: "allow" | "block", windows = false, cwd?: string): GuardCase {
  const projectRoot = windows ? windowsRoot : posixRoot;
  return { name, request: { projectRoot, cwd: cwd ?? (windows ? `${projectRoot}\\src` : `${projectRoot}/src`), toolName, input }, decision };
}
const guardCases: GuardCase[] = [
  ...["write", "edit"].flatMap((tool) => [
    ...["path", "file_path", "target_file"].flatMap((field) => [
      guardCase(`${tool}/${field} POSIX relative`, tool, { [field]: "../project-docs/docs/a.md" }, "block"),
      guardCase(`${tool}/${field} Windows separators/case`, tool, { [field]: "../PROJECT-DOCS\\Docs\\a.md" }, "block", true),
    ]),
    ...["docs", "versions", ".meta"].flatMap((directory) => [
      guardCase(`${tool} POSIX protected directory ${directory}`, tool, { path: `${posixRoot}/project-docs/${directory}` }, "block"),
      guardCase(`${tool} Windows protected directory ${directory}`, tool, { path: `c:/WORK/项目 space/project-docs/${directory}` }, "block", true),
    ]),
    guardCase(`${tool} resolves POSIX dot segments`, tool, { path: "./../project-docs/docs/sub/../a.md" }, "block"),
    guardCase(`${tool} resolves Windows dot segments`, tool, { path: "..\\project-docs\\docs\\sub\\..\\a.md" }, "block", true),
    guardCase(`${tool} cwd inside protected directory`, tool, { path: "./a.md" }, "block", false, `${posixRoot}/project-docs/.meta`),
    guardCase(`${tool} checks every recognized path field`, tool, { path: "safe.ts", file_path: "../project-docs/docs/a.md" }, "block"),
    guardCase(`${tool} similar directory`, tool, { path: "../project-docs/docs-old/a.md" }, "allow"),
    guardCase(`${tool} similar root`, tool, { path: "../project-docs-old/docs/a.md" }, "allow"),
    guardCase(`${tool} sibling project`, tool, { path: "/work/another/project-docs/docs/a.md" }, "allow"),
    guardCase(`${tool} POSIX case differs`, tool, { path: "../project-docs/DOCS/a.md" }, "allow"),
    guardCase(`${tool} escapes protected directory`, tool, { path: "../project-docs/docs/../../scratch.md" }, "allow"),
    guardCase(`${tool} Windows nearby directory`, tool, { path: "..\\project-docs\\versions-old\\a.md" }, "allow", true),
    guardCase(`${tool} another Windows drive`, tool, { path: "D:\\Work\\项目 space\\project-docs\\docs\\a.md" }, "allow", true),
    guardCase(`${tool} unknown drive-relative path`, tool, { path: "D:project-docs\\docs\\a.md" }, "allow", true),
  ]),
  guardCase("shell adjacent output redirect", "shell", { command: "echo x>../project-docs/docs/a.md" }, "block"),
  guardCase("shell quoted append target", "shell", { cmd: "echo x >> '../project-docs/.meta/a b.yaml'" }, "block"),
  guardCase("shell absolute target with spaces", "shell", { command: `echo x > "${posixRoot}/project-docs/versions/v1/a.md"` }, "block"),
  guardCase("shell Windows quoted path", "shell", { command: 'echo x>"..\\PROJECT-DOCS\\DOCS\\a b.md"' }, "block", true),
  guardCase("shell Windows single quotes and dot segments", "shell", { cmd: "echo x >> '..\\project-docs\\versions\\v1\\..\\a.md'" }, "block", true),
  guardCase("shell checks later redirect", "shell", { command: "echo x > safe.txt; echo y > ../project-docs/docs/a.md" }, "block"),
  guardCase("AIT command is not a redirect whitelist", "shell", { command: "ait state > ../project-docs/docs/state.md" }, "block"),
  guardCase("shell stderr redirect", "shell", { command: "command 2>../project-docs/.meta/errors.log" }, "block"),
  guardCase("shell read-only input redirect", "shell", { command: "cat < ../project-docs/docs/a.md" }, "allow"),
  guardCase("shell ordinary read", "shell", { command: "cat ../project-docs/docs/a.md" }, "allow"),
  guardCase("shell quoted redirect text", "shell", { command: "echo 'text > ../project-docs/docs/a.md'" }, "allow"),
  guardCase("shell escaped redirect operator", "shell", { command: "echo x \\> ../project-docs/docs/a.md" }, "allow"),
  guardCase("shell escaped space in static target", "shell", { command: "echo x > ../project-docs/docs/a\\ b.md" }, "block"),
  guardCase("shell variable target", "shell", { command: 'echo x > "$ROOT/project-docs/docs/a.md"' }, "allow"),
  guardCase("shell command substitution target", "shell", { command: 'echo x > "$(pwd)/../project-docs/docs/a.md"' }, "allow"),
  guardCase("shell glob target is unknown", "shell", { command: "echo x > ../project-docs/docs/*.md" }, "allow"),
  guardCase("shell Windows environment variable", "shell", { command: 'echo x>"%ROOT%\\project-docs\\docs\\a.md"' }, "allow", true),
  guardCase("shell Windows delayed expansion", "shell", { command: 'echo x>"!ROOT!\\project-docs\\docs\\a.md"' }, "allow", true),
  guardCase("shell descriptor duplication", "shell", { command: "command 2>&1" }, "allow"),
  guardCase("shell comments are not redirections", "shell", { command: "echo ok # > ../project-docs/docs/a.md" }, "allow"),
  guardCase("heredoc body is opaque", "shell", { command: "cat <<EOF\n> ../project-docs/docs/a.md\nEOF" }, "allow"),
  guardCase("shell near directory", "shell", { command: "echo x > ../project-docs/.meta-old/a.yaml" }, "allow"),
  guardCase("read tool", "read", { path: "../project-docs/docs/a.md" }, "allow"),
  guardCase("unknown tool", "custom-tool", { path: "../project-docs/docs/a.md" }, "allow"),
  ...[null, undefined, [], "../project-docs/docs/a.md", 7, {}, { path: 7 }, { path: "" }, { unknown: "../project-docs/docs/a.md" }]
    .map((input, index) => guardCase(`incomplete input ${index}`, "write", input, "allow")),
];

describe("pure write guard", () => {
  it.each(guardCases)("$name", ({ request, decision }) => {
    const before = JSON.stringify(request);
    const first = evaluateWriteGuard(request);
    expect(first.decision).toBe(decision);
    if (decision === "block") expect(first.reason).toMatch(/AIT/);
    else expect(first.reason).toBeNull();
    expect(evaluateWriteGuard(request)).toEqual(first);
    expect(JSON.stringify(request)).toBe(before);
  });

  it("has no filesystem or process dependency and does not need paths to exist", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("../src/orchestration/guard-decisions.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:)?(?:fs(?:\/promises)?|child_process)["']/);
    const root = makeRoot();
    const before = treeSnapshot(root);
    expect(evaluateWriteGuard({ projectRoot: root.cwd, cwd: root.cwd, toolName: "write", input: { path: "project-docs/docs/not-created.md" } }).decision).toBe("block");
    expect(treeSnapshot(root)).toEqual(before);
  });
});

const emptyLayers = () => ({
  prd: { working: 0, staged: 0, committed: 0 },
  fsd: { working: 0, staged: 0, committed: 0 },
  tdd: { working: 0, staged: 0, committed: 0 },
});

function readSessionWithoutWrites(root: ProjectRoot) {
  const before = treeSnapshot(root);
  const first = getSessionContext(root);
  expect(getSessionContext(root)).toEqual(first);
  expect(first.project_root).toBe(root.cwd);
  expect(first.text).toContain(contractText());
  expect(treeSnapshot(root)).toEqual(before);
  expect(Object.keys(before).some((name) => name.endsWith("/state.md"))).toBe(false);
  return first;
}

describe("session context", () => {
  it("distinguishes empty baseline and no active version without changing state command behavior", async () => {
    const root = makeRoot();
    expect(readSessionWithoutWrites(root)).toMatchObject({ active_version: null, phase: null, baseline_empty: true, layers: emptyLayers() });
    const before = treeSnapshot(root);
    expect(await inProject(root, () => dispatch(["state"]))).toMatchObject({ ok: false, code: "NO_VERSION" });
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("counts real records at every current PRD/FSD/TDD phase deterministically", async () => {
    const root = makeRoot();
    new VersionManager(root).versionCreate(VERSION);
    const manager = new NewModelManager(root);
    const layers = emptyLayers();
    const check = (phase: string): void => {
      expect(readSessionWithoutWrites(root)).toMatchObject({ active_version: VERSION, phase, baseline_empty: true, layers });
    };
    check("empty");
    await writeDocument(manager, "prd", PRD, prdText);
    layers.prd.working = 3;
    check("prd-creating");
    manager.confirmLayer("prd");
    layers.prd = { working: 0, staged: 0, committed: 3 };
    check("prd-confirm");
    await writeDocument(manager, "fsd", FSD, fsdText, { parent: PRD });
    layers.fsd.working = 4;
    check("fsd-creating");
    manager.confirmLayer("fsd");
    layers.fsd = { working: 0, staged: 0, committed: 4 };
    check("fsd-confirm");
    await writeDocument(manager, "tdd", TDD, tddText(), { parent: `${FSD}:generate` });
    layers.tdd.working = 1;
    check("tdd-creating");
    manager.confirmLayer("tdd");
    layers.tdd = { working: 0, staged: 0, committed: 1 };
    check("tdd-confirm");
  });

  it("counts staged, working and committed records from the persisted index", async () => {
    const { root } = await fixture();
    // This isolated historical-state case changes existing records through the index domain API.
    const indexes = new IndexManager(root);
    const index = indexes.loadVersionIndex(VERSION);
    const states = ["working", "staged", "committed"] as const;
    for (const layer of ["PRD", "FSD", "TDD"]) {
      index.chunks.filter((entry) => entry.id.startsWith(`[${layer}]-`)).forEach((entry, position) => {
        entry.state = states[position % states.length]!;
      });
    }
    indexes.saveVersionIndex(index);
    expect(readSessionWithoutWrites(root).layers).toEqual({
      prd: { working: 1, staged: 1, committed: 1 },
      fsd: { working: 2, staged: 1, committed: 1 },
      tdd: { working: 1, staged: 0, committed: 0 },
    });
  });

  it("returns zero current counts with a nonempty baseline after a real merge", async () => {
    const { root } = await fixture();
    await mergeFixture(root);
    expect(readSessionWithoutWrites(root)).toMatchObject({ active_version: null, phase: null, baseline_empty: false, layers: emptyLayers() });
  });

  it.each([
    ["metadata YAML", "YAML_PARSE_ERROR"],
    ["metadata schema", "SCHEMA_VALIDATION_ERROR"],
    ["missing active index", "VERSION_NOT_FOUND"],
    ["damaged active index", "INDEX_UNREADABLE"],
    ["damaged baseline index", "INDEX_UNREADABLE"],
  ])("reports %s corruption instead of an empty project", async (failure, code) => {
    const { root } = await fixture();
    const metaFile = path.join(root.meta, "versions", `${VERSION}.yaml`);
    if (failure === "metadata YAML") fs.writeFileSync(metaFile, "[broken");
    if (failure === "metadata schema") saveModel(metaFile, { ...metadata(root), phase: "invented-phase" });
    if (failure === "missing active index") fs.unlinkSync(path.join(root.meta, `chunks-index-${VERSION}.yaml`));
    if (failure === "damaged active index") fs.writeFileSync(path.join(root.meta, `chunks-index-${VERSION}.yaml`), "[broken");
    if (failure === "damaged baseline index") fs.writeFileSync(path.join(root.meta, "chunks-index.yaml"), "chunks: invalid\n");
    rejectWithoutWrites(root, () => getSessionContext(root), code!);
  });

  it("fails explicitly on multiple active versions without arbitrarily selecting one", async () => {
    const { root } = await fixture();
    // Production creation rejects this state; only this corruption fixture writes a second metadata record.
    saveModel(path.join(root.meta, "versions", "v0.11.yaml"), { ...metadata(root), version: "v0.11" });
    rejectWithoutWrites(root, () => getSessionContext(root), "ACTIVE_VERSION_CONFLICT");
  });
});
