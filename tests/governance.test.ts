import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess, { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { dispatch } from "../src/cli/dispatcher.js";
import { VersionMetaSchema } from "../src/doc-model/schemas.js";
import { resolveProjectRoot, type ProjectRoot } from "../src/foundation/root.js";
import { loadModel } from "../src/foundation/yaml.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import { initProject } from "../src/init/init-manager.js";
import {
  checkArtifactScopeWrite, evaluateGovernance, governancePolicyFingerprint,
  type GovernanceFinding,
} from "../src/new-model/governance.js";
import { NewModelManager, type CreateOpts, type DocLayer } from "../src/new-model/model-manager.js";
import { combinedView, SpecGraphStore } from "../src/specgraph/graph-model.js";
import { versionMerge } from "../src/versioning/merge-engine.js";
import { VersionManager } from "../src/versioning/version-manager.js";

const PRD = "[PRD]-governance-fixture";
const FSD = "[FSD]-governance-fixture";
const REQUIREMENT = `${PRD}:behavior`;
const ALTERNATE = `${PRD}:alternate`;
const CORE = `${FSD}:core`;
const OTHER = `${FSD}:other`;
const TEST = `${FSD}:TEST`;
const CHECK = `${FSD}:CHECK`;
const IMPL = "[TDD]-implementation";
const TEST_TDD = "[TDD]-acceptance";
const temporaryRoots = new Set<string>();

type Policy = Record<string, unknown>;
type Snapshot = Record<string, string>;
interface Target { id: string; parent: string; file: string }
interface Fixture {
  cwd: string;
  root: ProjectRoot;
  model: NewModelManager;
  versions: VersionManager;
  version: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.name", "governance tests");
  git(cwd, "config", "user.email", "governance@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "tag.gpgsign", "false");
  git(cwd, "config", "core.autocrlf", "false");
  git(cwd, "config", "core.hooksPath", path.join(cwd, ".git", "no-hooks"));
}

function treeSnapshot(directory: string): Snapshot {
  const entries: Snapshot = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const relative = path.relative(directory, file).replace(/\\/g, "/");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) entries[relative] = `link:${fs.readlinkSync(file)}`;
      else if (stat.isDirectory()) {
        entries[`${relative}/`] = "directory";
        walk(file);
      } else entries[relative] = fs.readFileSync(file).toString("base64");
    }
  };
  walk(directory);
  return entries;
}

async function unchanged<T>(fixture: Fixture, action: () => T | Promise<T>): Promise<T> {
  const before = treeSnapshot(fixture.cwd);
  try {
    return await action();
  } finally {
    expect(treeSnapshot(fixture.cwd)).toEqual(before);
  }
}

async function failsUnchanged(fixture: Fixture, action: () => unknown | Promise<unknown>, code: string): Promise<Error> {
  const result = await unchanged(fixture, async () => {
    try {
      await action();
      return undefined;
    } catch (error) {
      return error;
    }
  });
  expect(result).toBeInstanceOf(Error);
  expect(result).toMatchObject({ code });
  return result as Error;
}

function writeFile(fixture: Fixture, relative: string, content = "export const value = 1;\n"): void {
  const filename = path.resolve(fixture.cwd, relative);
  const within = path.relative(fixture.cwd, filename);
  if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("fixture path escaped");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function policy(fixture: Fixture, value: Policy): void {
  fs.writeFileSync(path.join(fixture.root.meta, "config.yaml"), stringifyYaml(value));
}

function chunk(id: string, body: string): string {
  return `<!-- @id:${id} -->\n## ${id}\n\n${body}\n`;
}

function tdd(id: string, target: string): string {
  return chunk(id, `\`\`\`yaml\ntarget_file: ${JSON.stringify(target)}\n\`\`\`\n`);
}

function prd(): string {
  const requirement = (id: string) => chunk(id,
    "**用户故事:** 作为维护者，我希望真实规格门禁生效，以便发现治理缺陷。\n\n" +
    "#### 验收标准\n1. WHEN 检查制品 THEN 系统 SHALL 返回可定位的治理结果。\n");
  return chunk(PRD, "治理回归的产品范围。") + requirement(REQUIREMENT) + requirement(ALTERNATE);
}

function fsd(core = `实现 ${REQUIREMENT}。`, other = "独立的辅助功能。", acceptance = "验收入口。"): string {
  return chunk(FSD, `治理功能树；根正文可提及 ${ALTERNATE}。`) +
    chunk(CORE, `${core}\n\n\`\`\`yaml\nderives: [${JSON.stringify(REQUIREMENT)}]\n\`\`\`\n`) +
    chunk(OTHER, other) + chunk(TEST, acceptance) + chunk(CHECK, acceptance);
}

async function create(
  fixture: Fixture, layer: DocLayer, id: string, content: string,
  options: Omit<CreateOpts, "content" | "contextToken" | "skipContext"> = {},
): Promise<void> {
  const discussion = await unchanged(fixture, () => fixture.model.createDocument(layer, id, options));
  expect(discussion.mode).toBe("discussion-context");
  if (discussion.mode !== "discussion-context") throw new Error("discussion context missing");
  const written = await fixture.model.createDocument(layer, id, {
    ...options, content, contextToken: discussion.context_token,
  });
  expect(written.mode).toBe("written");
}

function emptyFixture(): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ait-governance-"));
  temporaryRoots.add(cwd);
  git(cwd, "init", "--quiet");
  configureGit(cwd);
  initProject(cwd, { name: "governance-fixture" });
  const root = resolveProjectRoot(cwd);
  configureGit(root.root);
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "fixture host baseline");
  git(root.root, "add", "-A");
  git(root.root, "commit", "--quiet", "-m", "fixture specification baseline");
  return { cwd, root, model: new NewModelManager(root), versions: new VersionManager(root), version: "v1.0" };
}

async function fixture(options: { config?: Policy; targets?: Target[]; artifacts?: boolean; fsdContent?: string } = {}): Promise<Fixture> {
  const f = emptyFixture();
  policy(f, options.config ?? {});
  f.versions.versionCreate(f.version);
  await create(f, "prd", PRD, prd(), { action: "modify" });
  f.model.confirmLayer("prd");
  await create(f, "fsd", FSD, options.fsdContent ?? fsd(), { parent: PRD, action: "modify" });
  f.model.confirmLayer("fsd");
  const targets = options.targets ?? [{ id: IMPL, parent: CORE, file: "src/main.ts" }];
  for (const target of targets) {
    await create(f, "tdd", target.id, tdd(target.id, target.file), { parent: target.parent });
    if (options.artifacts !== false) {
      writeFile(f, target.file);
      git(f.cwd, "add", "--", target.file);
    }
  }
  if (targets.length > 0) f.model.confirmLayer("tdd");
  return f;
}

async function mergeBaseline(f: Fixture): Promise<void> {
  expect((await f.versions.versionConfirm(f.version)).passed).toBe(true);
  expect((await versionMerge(f.root, f.version)).git).toBe("committed");
}

async function nextVersion(f: Fixture, fsdContent = chunk(FSD, "只更新根说明，省略既有 split。")): Promise<void> {
  f.version = "v2.0";
  f.versions.versionCreate(f.version);
  await create(f, "prd", PRD, chunk(PRD, "只更新产品说明，省略既有需求。"), { action: "modify" });
  f.model.confirmLayer("prd");
  await create(f, "fsd", FSD, fsdContent, { action: "modify" });
  f.model.confirmLayer("fsd");
}

async function diagnostic(f: Fixture, explicit = true) {
  const previous = process.cwd();
  process.chdir(f.cwd);
  try {
    return await dispatch(["specgraph", "validate-new-model", ...(explicit ? ["--version", f.version] : [])]);
  } finally {
    process.chdir(previous);
  }
}

function meta(f: Fixture) {
  return loadModel(path.join(f.root.meta, "versions", `${f.version}.yaml`), VersionMetaSchema);
}

function expectLocation(error: Error, findings: GovernanceFinding[]): void {
  for (const finding of findings) {
    for (const value of [finding.code, finding.chunkId, finding.file, finding.targetFile]) {
      if (value !== undefined) expect(error.message).toContain(value);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryRoots) {
    const resolved = fs.realpathSync(directory);
    const relative = path.relative(fs.realpathSync(os.tmpdir()), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(resolved).startsWith("ait-governance-")) {
      throw new Error(`refusing to remove a non-fixture directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    temporaryRoots.delete(directory);
  }
});

describe("target_file_existence against real effective specifications", () => {
  it.each([undefined, "warn", "block"] as const)("reports a missing artifact with enforcement %s", async (enforcement) => {
    const f = await fixture({ artifacts: false, config: enforcement === undefined ? {} : { target_file_existence: { enforcement } } });
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.target_file_missing).toEqual([expect.objectContaining({
      code: "TDD_TARGET_FILE_MISSING", chunkId: IMPL,
      file: `tdd/${IMPL}`, targetFile: "src/main.ts", enforcement: enforcement ?? "warn",
    })]);
    expect(report.violations).toEqual(enforcement === "block" ? report.target_file_missing : []);
    expect(report.warnings).toEqual(enforcement === "block" ? [] : report.target_file_missing);
    if (enforcement === "block") {
      const error = await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "INVARIANT_VIOLATION");
      expectLocation(error, report.violations);
    } else expect((await f.versions.versionConfirm(f.version)).warnings).toEqual(report.warnings);
  }, 30_000);

  it("treats directories and ENOTDIR targets as missing files with their TDD location", async () => {
    const f = await fixture({ artifacts: false, targets: [
      { id: IMPL, parent: CORE, file: "src/directory.ts" },
      { id: "[TDD]-nested", parent: OTHER, file: "src/plain/child.ts" },
    ] });
    fs.mkdirSync(path.join(f.cwd, "src", "directory.ts"), { recursive: true });
    writeFile(f, "src/plain", "not a directory");
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.target_file_missing.map((item) => [item.chunkId, item.targetFile])).toEqual([
      [IMPL, "src/directory.ts"], ["[TDD]-nested", "src/plain/child.ts"],
    ]);
    expect(report.target_file_missing.every((item) => item.file?.startsWith("tdd/") && item.enforcement === "warn")).toBe(true);
  });

  it("preserves spaces, Unicode, and the actual filesystem case of declared targets", async () => {
    const f = await fixture({ targets: [{ id: IMPL, parent: CORE, file: "src/MiXeD 资料.ts" }] });
    expect((await unchanged(f, () => evaluateGovernance(f.root, f.version))).target_file_missing).toEqual([]);
    const other = await fixture({ artifacts: false, targets: [{ id: IMPL, parent: CORE, file: "src/mixed 资料.ts" }] });
    writeFile(other, "src/MiXeD 资料.ts");
    const report = await unchanged(other, () => evaluateGovernance(other.root, other.version));
    expect(report.target_file_missing.map((item) => item.targetFile)).toEqual(process.platform === "win32" ? [] : ["src/mixed 资料.ts"]);
  }, 30_000);

  it("does not convert a real stat IO failure into a missing-file warning", async () => {
    const f = await fixture();
    const target = path.join(f.cwd, "src", "main.ts");
    const original = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((filename, ...args) => {
      if (String(filename) === target) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
      return Reflect.apply(original, fs, [filename, ...args]);
    }) as typeof fs.statSync);
    const error = await failsUnchanged(f, () => evaluateGovernance(f.root, f.version), "GOVERNANCE_IO_ERROR");
    expect(error.message).toContain("src/main.ts");
    expect(error.message).toContain("access denied");
  });

  it("checks an unchanged baseline TDD in a documentation-only version", async () => {
    const f = await fixture({ config: { target_file_existence: { enforcement: "block" } } });
    await mergeBaseline(f);
    await nextVersion(f);
    expect(new IndexManager(f.root).queryVersion(f.version, IMPL)).toBeNull();
    fs.unlinkSync(path.join(f.cwd, "src", "main.ts"));
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.violations).toEqual([expect.objectContaining({ code: "TDD_TARGET_FILE_MISSING", chunkId: IMPL, file: `tdd/${IMPL}`, targetFile: "src/main.ts", enforcement: "block" })]);
    expectLocation(await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "INVARIANT_VIOLATION"), report.violations);
  }, 30_000);

  it.each(["missing file", "missing chunk", "parse error"])("never falls back to baseline after a version %s", async (fault) => {
    const f = await fixture();
    await mergeBaseline(f);
    await nextVersion(f);
    await create(f, "tdd", IMPL, tdd(IMPL, "src/new.ts"), { action: "modify" });
    f.model.confirmLayer("tdd");
    writeFile(f, "src/new.ts");
    const source = path.join(f.root.root, "versions", f.version, "tdd", `${IMPL}.md`);
    expect(fs.existsSync(path.join(f.root.docs, "tdd", `${IMPL}.md`))).toBe(true);
    if (fault === "missing file") fs.unlinkSync(source);
    else if (fault === "missing chunk") fs.writeFileSync(source, tdd("[TDD]-different", "src/new.ts"));
    else fs.appendFileSync(source, `\n${tdd(IMPL, "src/new.ts")}`);
    const error = await failsUnchanged(f, () => evaluateGovernance(f.root, f.version), fault === "parse error" ? "CHUNK_PARSE_ERROR" : "GOVERNANCE_SOURCE_MISSING");
    expect(error.message).toContain(IMPL);
    if (fault === "parse error") {
      expect(error).toMatchObject({ file: `versions/${f.version}/tdd/${IMPL}.md`, line: expect.any(Number) });
      expect((error as Error & { line: number }).line).toBeGreaterThan(0);
    } else expect(error.message).toContain(f.version);
  }, 30_000);

  it("fails explicitly for an absent version and a missing version index", async () => {
    const f = await fixture();
    await failsUnchanged(f, () => evaluateGovernance(f.root, "v9.9"), "VERSION_NOT_FOUND");
    fs.unlinkSync(path.join(f.root.meta, `chunks-index-${f.version}.yaml`));
    await unchanged(f, () => expect(() => evaluateGovernance(f.root, f.version)).toThrow());
  });
});

describe("artifact_scopes use real tracked files and exact exemptions", () => {
  it("ignores untracked caches, honors exact normalized exemptions, and respects directory boundaries", async () => {
    const f = await fixture({
      config: { artifact_scopes: { "tests/": {
        parent_suffix: ":TEST", enforcement: "block", exempt_paths: ["./tests/nested/../exempt.ts"],
      } } },
      targets: [{ id: TEST_TDD, parent: TEST, file: "tests/owned.ts" }],
    });
    const tracked = ["tests/orphan.ts", "tests/exempt.ts", "tests/exempt.ts.backup", "tests-other/adjacent.ts", "tests/retired.ts"];
    for (const file of [...tracked, "tests/cache/untracked.ts"]) writeFile(f, file);
    git(f.cwd, "add", "--", ...tracked);
    fs.unlinkSync(path.join(f.cwd, "tests", "retired.ts"));
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.warnings).toEqual([]);
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "UNCOVERED_ARTIFACT", file: "tests/exempt.ts.backup", targetFile: "tests/exempt.ts.backup", enforcement: "block" }),
      expect.objectContaining({ code: "UNCOVERED_ARTIFACT", file: "tests/orphan.ts", targetFile: "tests/orphan.ts", enforcement: "block" }),
    ]);
  });

  it("reports configured acceptance suffixes with independent strengths and exact split exemptions", async () => {
    const f = await fixture({ targets: [], config: { artifact_scopes: {
      "tests/": { parent_suffix: ":TEST", exempt_test_splits: [`${TEST}_other`] },
      "checks/": { parent_suffix: ":CHECK", enforcement: "block", exempt_test_splits: [`${CHECK}_other`] },
    } } });
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.warnings).toEqual([expect.objectContaining({ code: "TEST_SPLIT_UNCOVERED", chunkId: TEST, file: `fsd/${FSD}`, enforcement: "warn" })]);
    expect(report.violations).toEqual([expect.objectContaining({ code: "TEST_SPLIT_UNCOVERED", chunkId: CHECK, file: `fsd/${FSD}`, enforcement: "block" })]);
    policy(f, { artifact_scopes: {
      "tests/": { parent_suffix: ":TEST", exempt_test_splits: [TEST] },
      "checks/": { parent_suffix: ":CHECK", enforcement: "block", exempt_test_splits: [CHECK] },
    } });
    expect(await unchanged(f, () => evaluateGovernance(f.root, f.version))).toEqual({ violations: [], warnings: [], target_file_missing: [], derives_residue: [] });
  });

  it("deduplicates the same uncovered acceptance split with block taking precedence", async () => {
    const f = await fixture({ targets: [], config: { artifact_scopes: {
      "tests/": { parent_suffix: ":TEST", enforcement: "warn" },
      "specs/": { parent_suffix: ":TEST", enforcement: "block" },
    } } });
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.warnings).toEqual([]);
    expect(report.violations).toEqual([expect.objectContaining({ code: "TEST_SPLIT_UNCOVERED", chunkId: TEST, enforcement: "block" })]);
  });

  it("fails when configured coverage cannot enumerate the host Git repository", async () => {
    const f = await fixture({ config: { artifact_scopes: { "tests/": { parent_suffix: ":TEST" } } } });
    fs.renameSync(path.join(f.cwd, ".git"), path.join(f.cwd, ".host-git-disabled"));
    const error = await failsUnchanged(f, () => evaluateGovernance(f.root, f.version), "GOVERNANCE_IO_ERROR");
    expect(error.message).toContain("Git");
  });

  it("requires no Git command when no scopes are configured", async () => {
    const f = await fixture();
    fs.renameSync(path.join(f.cwd, ".git"), path.join(f.cwd, ".host-git-disabled"));
    const spawn = vi.spyOn(childProcess, "spawnSync");
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails on tracked-artifact IO errors instead of treating the scope as empty", async () => {
    const f = await fixture({ config: { artifact_scopes: { "tests/": { parent_suffix: ":TEST", exempt_test_splits: [TEST] } } } });
    writeFile(f, "tests/unowned.ts");
    git(f.cwd, "add", "--", "tests/unowned.ts");
    const target = path.join(f.cwd, "tests", "unowned.ts");
    const original = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((filename, ...args) => {
      if (String(filename) === target) throw Object.assign(new Error("tracked IO failure"), { code: "EIO" });
      return Reflect.apply(original, fs, [filename, ...args]);
    }) as typeof fs.statSync);
    const error = await failsUnchanged(f, () => evaluateGovernance(f.root, f.version), "GOVERNANCE_IO_ERROR");
    expect(error.message).toContain("tests/unowned.ts");
  });
});

describe("the production TDD create path enforces both directions before writing", () => {
  it("creates an absent target under the right parent and defers existence blocking to confirm", async () => {
    const f = await fixture({ targets: [], config: {
      artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "block" } },
      target_file_existence: { enforcement: "block" },
    } });
    await unchanged(f, () => checkArtifactScopeWrite(f.root, TEST_TDD, "tests/new.ts", TEST));
    await create(f, "tdd", TEST_TDD, tdd(TEST_TDD, "tests/new.ts"), { parent: TEST });
    expect(fs.existsSync(path.join(f.cwd, "tests", "new.ts"))).toBe(false);
    expect(new IndexManager(f.root).queryVersion(f.version, TEST_TDD)).not.toBeNull();
    expect(combinedView(f.root, f.version).edgesTo(TEST_TDD, "details").map((edge) => edge.src)).toEqual([TEST]);
    f.model.confirmLayer("tdd");
    const error = await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "INVARIANT_VIOLATION");
    expect(error.message).toContain("TDD_TARGET_FILE_MISSING");
    expect(error.message).toContain("tests/new.ts");
  });

  it.each([
    ["tests/wrong.ts", CORE, "TEST_SCOPE_PARENT_MISMATCH"],
    ["src/reverse.ts", TEST, "TEST_SCOPE_PARENT_MISMATCH"],
    ["tests-other/neighbor.ts", TEST, "TEST_SCOPE_PARENT_MISMATCH"],
    ["tests/../src/escape.ts", TEST, "TARGET_FILE_SCOPE_ESCAPE"],
    ["tests\\..\\src\\escape.ts", TEST, "TARGET_FILE_SCOPE_ESCAPE"],
    ["tests/../../outside.ts", TEST, "TARGET_FILE_SCOPE_ESCAPE"],
  ])("rejects target %s with parent %s without changing any bytes", async (target, parent, code) => {
    const f = await fixture({ targets: [], config: { artifact_scopes: {
      "tests/": { parent_suffix: ":TEST", enforcement: "warn", exempt_paths: ["tests/wrong.ts"], exempt_test_splits: [TEST] },
    } } });
    const options = { parent: parent! };
    const context = await unchanged(f, () => f.model.createDocument("tdd", TEST_TDD, options));
    if (context.mode !== "discussion-context") throw new Error("context missing");
    await failsUnchanged(f, () => f.model.createDocument("tdd", TEST_TDD, {
      ...options, content: tdd(TEST_TDD, target!), contextToken: context.context_token,
    }), code!);
  });

  it("allows adjacent unmanaged directories under ordinary parents", async () => {
    const f = await fixture({ targets: [], config: { artifact_scopes: { "tests/": { parent_suffix: ":TEST" } } } });
    await create(f, "tdd", IMPL, tdd(IMPL, "tests-other/main.ts"), { parent: CORE });
    expect(new IndexManager(f.root).queryVersion(f.version, IMPL)).not.toBeNull();
  });

  it("uses the union of scopes sharing a suffix and supports a custom acceptance suffix", async () => {
    const f = await fixture({ targets: [], config: { artifact_scopes: {
      "tests/": { parent_suffix: ":TEST" },
      "specs/": { parent_suffix: ":TEST" },
      "checks/": { parent_suffix: ":CHECK" },
    } } });
    for (const [id, parent, target] of [
      ["[TDD]-first", TEST, "tests/./nested/../first.ts"],
      ["[TDD]-second", TEST, "specs/second.ts"],
      ["[TDD]-custom", CHECK, "checks/custom.ts"],
    ]) await create(f, "tdd", id!, tdd(id!, target!), { parent: parent! });
    f.model.confirmLayer("tdd");
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.violations).toEqual([]);
    expect(report.warnings.map((item) => item.code)).toEqual(["TDD_TARGET_FILE_MISSING", "TDD_TARGET_FILE_MISSING", "TDD_TARGET_FILE_MISSING"]);
  });

  it.each(["parent", "target"])("diagnoses an existing TDD whose %s was damaged outside the manager", async (damage) => {
    const f = await fixture();
    policy(f, { artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "warn" } } });
    if (damage === "parent") {
      const store = new SpecGraphStore(f.root);
      const graph = store.load(f.version);
      const edge = graph.edges.find((item) => item.rel === "details" && item.dst.endsWith(`:${IMPL}`));
      expect(edge).toBeDefined();
      edge!.src = edge!.src.replace(/:core$/, ":TEST");
      store.save(f.version, graph);
    } else fs.writeFileSync(path.join(f.root.root, "versions", f.version, "tdd", `${IMPL}.md`), tdd(IMPL, "tests/damaged.ts"));
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.violations).toEqual([expect.objectContaining({
      code: "TEST_SCOPE_PARENT_MISMATCH", chunkId: IMPL, file: `tdd/${IMPL}`,
      targetFile: damage === "parent" ? "src/main.ts" : "tests/damaged.ts", enforcement: "block",
    })]);
  });
});

describe("derives_residue scans effective functional split bodies", () => {
  it.each([undefined, "warn", "block"] as const)("keeps missing mappings and severity %s while ignoring roots and acceptance splits", async (enforcement) => {
    const f = await fixture({
      config: {
        artifact_scopes: { "checks/": { parent_suffix: ":CHECK", exempt_test_splits: [CHECK] } },
        ...(enforcement === undefined ? {} : { derives_residue: { enforcement } }),
      },
      fsdContent: fsd(`实现 ${REQUIREMENT}；同时声称 ${ALTERNATE} 和 ${ALTERNATE}。`, "普通辅助功能。", `验收 ${ALTERNATE}。`),
    });
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.derives_residue).toEqual([expect.objectContaining({ code: "DERIVES_RESIDUE", chunkId: CORE, file: `fsd/${FSD}`, enforcement: enforcement ?? "warn" })]);
    expect(report.derives_residue[0]!.message).toContain(ALTERNATE);
    expect(report.derives_residue[0]!.message).not.toContain(REQUIREMENT);
    expect(report.violations).toEqual(enforcement === "block" ? report.derives_residue : []);
    expect(report.warnings).toEqual(enforcement === "block" ? [] : report.derives_residue);
  });

  it("uses version replacements while inheriting omitted baseline splits", async () => {
    const f = await fixture({ fsdContent: fsd(`声称 ${ALTERNATE}。`, `也声称 ${ALTERNATE}。`) });
    await mergeBaseline(f);
    const baseline = await unchanged(f, () => evaluateGovernance(f.root));
    expect(baseline.derives_residue.map((item) => item.chunkId)).toEqual([CORE, OTHER]);
    await nextVersion(f, chunk(FSD, "更新根说明。") + chunk(CORE, "当前实现不再声称额外需求。"));
    const effective = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(effective.derives_residue.map((item) => item.chunkId)).toEqual([OTHER]);
    expect(await unchanged(f, () => evaluateGovernance(f.root, "v1.0"))).toEqual(baseline);
  }, 30_000);
});

describe("governance policy compatibility and deterministic read-only results", () => {
  it("keeps missing and null defaults compatible and generation_receipts report independent", async () => {
    const f = emptyFixture();
    const initial = await unchanged(f, () => governancePolicyFingerprint(f.root));
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    policy(f, { artifact_scopes: null, target_file_existence: null, derives_residue: null });
    expect(await unchanged(f, () => governancePolicyFingerprint(f.root))).toBe(initial);
    policy(f, { generation_receipts: { enforcement: "report" }, unrelated_future_key: [1, 2, 3] });
    expect(await unchanged(f, () => governancePolicyFingerprint(f.root))).toBe(initial);
    expect(await unchanged(f, () => evaluateGovernance(f.root))).toEqual({ violations: [], warnings: [], target_file_missing: [], derives_residue: [] });
  });

  const badPolicies: [string, Policy][] = [
    ["scope array", { artifact_scopes: [] }],
    ["scope number", { artifact_scopes: 2 }],
    ["scope null entry", { artifact_scopes: { tests: null } }],
    ["scope array entry", { artifact_scopes: { tests: [] } }],
    ["missing suffix", { artifact_scopes: { tests: {} } }],
    ["non-colon suffix", { artifact_scopes: { tests: { parent_suffix: "TEST" } } }],
    ["empty suffix", { artifact_scopes: { tests: { parent_suffix: ":" } } }],
    ["scope report strength", { artifact_scopes: { tests: { parent_suffix: ":TEST", enforcement: "report" } } }],
    ["scope boolean strength", { artifact_scopes: { tests: { parent_suffix: ":TEST", enforcement: true } } }],
    ["path exemption string", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_paths: "tests/a.ts" } } }],
    ["path exemption item", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_paths: [3] } } }],
    ["split exemption string", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_test_splits: TEST } } }],
    ["split exemption item", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_test_splits: [null] } } }],
    ["empty prefix", { artifact_scopes: { "": { parent_suffix: ":TEST" } } }],
    ["absolute prefix", { artifact_scopes: { "/outside": { parent_suffix: ":TEST" } } }],
    ["drive prefix", { artifact_scopes: { "C:\\outside": { parent_suffix: ":TEST" } } }],
    ["UNC prefix", { artifact_scopes: { "//server/share": { parent_suffix: ":TEST" } } }],
    ["escaping prefix", { artifact_scopes: { "../outside": { parent_suffix: ":TEST" } } }],
    ["escaping exemption", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_paths: ["../outside.ts"] } } }],
    ["absolute exemption", { artifact_scopes: { tests: { parent_suffix: ":TEST", exempt_paths: ["C:/outside.ts"] } } }],
    ["existence array", { target_file_existence: [] }],
    ["existence number", { target_file_existence: 1 }],
    ["existence report strength", { target_file_existence: { enforcement: "report" } }],
    ["residue array", { derives_residue: [] }],
    ["residue number", { derives_residue: 1 }],
    ["residue report strength", { derives_residue: { enforcement: "report" } }],
  ];
  it.each(badPolicies)("rejects %s as CONFIG_UNREADABLE without writing", async (_name, config) => {
    const f = emptyFixture();
    policy(f, config);
    await failsUnchanged(f, () => evaluateGovernance(f.root), "CONFIG_UNREADABLE");
    await failsUnchanged(f, () => governancePolicyFingerprint(f.root), "CONFIG_UNREADABLE");
    await failsUnchanged(f, () => checkArtifactScopeWrite(f.root, TEST_TDD, "tests/new.ts", TEST), "CONFIG_UNREADABLE");
  });

  it("rejects malformed YAML and invalid local policy overrides", async () => {
    const f = emptyFixture();
    fs.writeFileSync(path.join(f.root.meta, "config.yaml"), "artifact_scopes: [unterminated\n");
    await failsUnchanged(f, () => evaluateGovernance(f.root), "CONFIG_UNREADABLE");
    policy(f, { target_file_existence: { enforcement: "warn" } });
    fs.writeFileSync(path.join(f.root.meta, "config.local.yaml"), stringifyYaml({ target_file_existence: { enforcement: "report" } }));
    await failsUnchanged(f, () => evaluateGovernance(f.root), "CONFIG_UNREADABLE");
  });

  it("rejects invalid policy through real create and confirm entry points with zero writes", async () => {
    const f = await fixture({ targets: [] });
    const context = await unchanged(f, () => f.model.createDocument("tdd", IMPL, { parent: CORE }));
    if (context.mode !== "discussion-context") throw new Error("context missing");
    policy(f, { target_file_existence: { enforcement: "report" } });
    await failsUnchanged(f, () => f.model.createDocument("tdd", IMPL, {
      parent: CORE, content: tdd(IMPL, "src/main.ts"), contextToken: context.context_token,
    }), "CONFIG_UNREADABLE");
    await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "CONFIG_UNREADABLE");
  });

  it("normalizes policy order, path spelling, null defaults, and exemption sets deterministically", async () => {
    const f = emptyFixture();
    policy(f, { artifact_scopes: {
      "./tests/nested/../": { parent_suffix: ":TEST", enforcement: null, exempt_paths: ["tests/b.ts", "tests/./a.ts", "tests/a.ts"], exempt_test_splits: [TEST, CHECK, TEST] },
      checks: { parent_suffix: ":CHECK", enforcement: "block", exempt_paths: null, exempt_test_splits: null },
    }, target_file_existence: null, derives_residue: {} });
    const fingerprint = await unchanged(f, () => governancePolicyFingerprint(f.root));
    policy(f, { derives_residue: { enforcement: "warn" }, target_file_existence: { enforcement: "warn" }, artifact_scopes: {
      "checks/": { parent_suffix: ":CHECK", enforcement: "block", exempt_test_splits: [], exempt_paths: [] },
      "tests/": { parent_suffix: ":TEST", enforcement: "warn", exempt_test_splits: [CHECK, TEST], exempt_paths: ["tests/a.ts", "tests/b.ts"] },
    } });
    expect(await unchanged(f, () => governancePolicyFingerprint(f.root))).toBe(fingerprint);
    expect(await unchanged(f, () => governancePolicyFingerprint(f.root))).toBe(fingerprint);
  });
});

describe("diagnostic, confirm, and merge consume the same governance facts", () => {
  async function warningFixture(): Promise<Fixture> {
    const f = await fixture({
      artifacts: false,
      config: { artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "warn" } } },
      fsdContent: fsd(`声称 ${ALTERNATE}。`),
    });
    writeFile(f, "tests/unowned.ts");
    git(f.cwd, "add", "--", "tests/unowned.ts");
    return f;
  }

  it("returns matching warnings and locations from diagnostic with explicit and automatic versions", async () => {
    const f = await warningFixture();
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.warnings.map((item) => item.code)).toEqual([
      "DERIVES_RESIDUE", "TDD_TARGET_FILE_MISSING", "TEST_SPLIT_UNCOVERED", "UNCOVERED_ARTIFACT",
    ]);
    for (const explicit of [true, false]) {
      const result = await unchanged(f, () => diagnostic(f, explicit));
      expect(result).toMatchObject({ ok: true, data: {
        passed: true, violations: [], policy_violations: report.violations,
        warnings: report.warnings, target_file_missing: report.target_file_missing,
        derives_residue: report.derives_residue,
      } });
    }
  });

  it("returns matching warnings from successful confirm and merge", async () => {
    const f = await warningFixture();
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(await unchanged(f, () => evaluateGovernance(f.root, f.version))).toEqual(report);
    const keys = report.warnings.map((item) => [item.code, item.chunkId ?? "", item.file ?? "", item.targetFile ?? "", item.message].join("\0"));
    expect(keys).toEqual([...keys].sort());
    expect((await f.versions.versionConfirm(f.version)).warnings).toEqual(report.warnings);
    expect((await versionMerge(f.root, f.version)).warnings).toEqual(report.warnings);
  }, 30_000);

  it("keeps block diagnostic facts identical to the shared report without mutating the tree", async () => {
    const f = await fixture({ artifacts: false, config: {
      target_file_existence: { enforcement: "block" }, derives_residue: { enforcement: "block" },
      artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "block" } },
    }, fsdContent: fsd(`声称 ${ALTERNATE}。`) });
    writeFile(f, "tests/unowned.ts");
    git(f.cwd, "add", "--", "tests/unowned.ts");
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    const result = await unchanged(f, () => diagnostic(f));
    expect(result).toMatchObject({ ok: true, data: {
      passed: true, violations: [], policy_violations: report.violations,
      warnings: report.warnings, target_file_missing: report.target_file_missing,
      derives_residue: report.derives_residue,
    } });
  });

  it("blocks confirm before source commits, metadata changes, or acceptance execution", async () => {
    const f = await fixture({ artifacts: false, config: {
      target_file_existence: { enforcement: "block" }, derives_residue: { enforcement: "block" },
      artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "block" } },
      acceptance_command: `"${process.execPath}" ".acceptance-marker.cjs"`,
    }, fsdContent: fsd(`声称 ${ALTERNATE}。`) });
    writeFile(f, "tests/unowned.ts");
    writeFile(f, ".acceptance-marker.cjs", 'require("node:fs").writeFileSync("acceptance-ran", "unexpected");\n');
    git(f.cwd, "add", "--", "tests/unowned.ts");
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    const head = git(f.cwd, "rev-parse", "HEAD");
    expectLocation(await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "INVARIANT_VIOLATION"), report.violations);
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(head);
    expect(meta(f).confirmed_plan).toBeNull();
    expect(fs.existsSync(path.join(f.cwd, "acceptance-ran"))).toBe(false);
  });

  it.each(["missing artifact", "uncovered artifact"])("rechecks %s after confirmation and blocks confirm and merge without writes", async (change) => {
    const f = await fixture({ config: {
      target_file_existence: { enforcement: "block" },
      artifact_scopes: { "tests/": { parent_suffix: ":TEST", enforcement: "block", exempt_test_splits: [TEST] } },
    } });
    await f.versions.versionConfirm(f.version);
    if (change === "missing artifact") fs.unlinkSync(path.join(f.cwd, "src", "main.ts"));
    else {
      writeFile(f, "tests/late.ts");
      git(f.cwd, "add", "--", "tests/late.ts");
    }
    const report = await unchanged(f, () => evaluateGovernance(f.root, f.version));
    expect(report.violations.map((item) => item.code)).toEqual([change === "missing artifact" ? "TDD_TARGET_FILE_MISSING" : "UNCOVERED_ARTIFACT"]);
    expectLocation(await failsUnchanged(f, () => f.versions.versionConfirm(f.version), "INVARIANT_VIOLATION"), report.violations);
    expectLocation(await failsUnchanged(f, () => versionMerge(f.root, f.version), change === "missing artifact" ? "CONFIRMATION_STALE" : "INVARIANT_VIOLATION"), report.violations);
  }, 30_000);

  it("rechecks the artifact after a passing acceptance command removes it", async () => {
    const f = await fixture({ config: {
      target_file_existence: { enforcement: "block" },
      acceptance_command: `"${process.execPath}" ".acceptance-delete.cjs"`,
    } });
    writeFile(f, ".acceptance-delete.cjs", 'require("node:fs").unlinkSync("src/main.ts");\n');
    const before = treeSnapshot(f.cwd);
    const result = await f.versions.versionConfirm(f.version).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: "INVARIANT_VIOLATION" });
    expect((result as Error).message).toContain("TDD_TARGET_FILE_MISSING");
    expect(fs.existsSync(path.join(f.cwd, "src", "main.ts"))).toBe(false);
    delete before["src/main.ts"];
    expect(treeSnapshot(f.cwd)).toEqual(before);
    expect(meta(f).confirmed_plan).toBeNull();
    expect(meta(f).code_result).toBeNull();
  });

  it.each(["target policy", "derives policy", "path exemption", "split exemption"])("makes the plan stale when %s changes after confirm", async (change) => {
    const baseScope = { parent_suffix: ":TEST", enforcement: "warn", exempt_test_splits: [TEST], exempt_paths: [] as string[] };
    const f = await fixture({ config: { artifact_scopes: { tests: baseScope } } });
    await f.versions.versionConfirm(f.version);
    const next: Policy = { artifact_scopes: { tests: baseScope } };
    if (change === "target policy") next.target_file_existence = { enforcement: "block" };
    else if (change === "derives policy") next.derives_residue = { enforcement: "block" };
    else if (change === "path exemption") next.artifact_scopes = { tests: { ...baseScope, exempt_paths: ["tests/retired.ts"] } };
    else next.artifact_scopes = { tests: { ...baseScope, exempt_test_splits: [TEST, `${FSD}:another_TEST`] } };
    policy(f, next);
    await failsUnchanged(f, () => versionMerge(f.root, f.version), "CONFIRMATION_STALE");
  }, 30_000);
});
