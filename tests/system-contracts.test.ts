// [TDD]-system_contract_tests: installed contracts and Python-project takeover.
// The deterministic host generator verifies bytes and provenance, not LLM quality.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { resolveProjectRoot } from "../src/foundation/root.js";
import { issueGenerationToken } from "../src/orchestration/generation-receipts.js";

type Data = Record<string, any>;
type Entry = "dispatch" | "bin" | "wrapper";
type Snapshot = Map<string, Buffer>;
interface Run { status: number; stdout: string; stderr: string }
interface Envelope { ok: boolean; data?: Data; code?: string; error?: string; presentation?: Data }
interface Delivery {
  bundle_path: string; sha256: string; bytes: number; version: string;
  target_file: string; tdd_root: string; source_file: string; generation_token: string;
}
interface Feature { cwd: string; version: string; prd: string; fsd: string; entry?: Entry }
interface GitState { head: string; status: string; refs: string; tracked: string[] }
interface HistoricalAnchor { version: string; docs: string; host: string | null }
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A real project's configured acceptance can build and run its entire own suite.
const TIMEOUT = 3_600_000;
const TARGET = "system-contract-output.cjs";
const TDD = "[TDD]-system-contract";
const CHILD_FSD = "[FSD]-system-contract";
const PUBLIC_FUNCTIONS = ["createCoreApi", "dispatch"];
const CORPORA = (process.env.AIT_CORPUS_DIRS ?? "").split(";").map((item) => item.trim()).filter(Boolean);
let suiteDir: string;
let consumer: string;
let bin: string;
let apiRunner: string;
let fixture: string;
const deliveries = new Set<string>();
const sourceArtifacts: Map<string, Snapshot> = new Map();
const sourceDependencies: Map<string, Snapshot> = new Map();
const acceptanceProjects = new Set<string>();
const originalAcceptance = new Map<string, string | null>();

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function requireCurrentProductionBuild(repo: string): void {
  const sourceRoot = path.join(repo, "src");
  const sources: string[] = [];
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) sources.push(file);
    }
  }
  visit(sourceRoot);
  if (sources.length === 0) throw new Error("No TypeScript production sources found; run npm run build before the installed contract suite.");
  for (const source of sources) {
    const sourceStat = fs.statSync(source);
    const stem = path.relative(sourceRoot, source).slice(0, -3);
    for (const extension of [".js", ".d.ts"]) {
      const output = path.join(repo, "dist", "src", stem + extension);
      const built = fs.statSync(output, { throwIfNoEntry: false });
      const reason = built === undefined || !built.isFile() ? "missing"
        : built.size === 0 ? "empty"
          : built.mtimeMs < sourceStat.mtimeMs ? "older than its source" : null;
      if (reason !== null) {
        throw new Error(`Production build output is ${reason}: ${output} (source: ${source}). Run npm run build before the installed contract suite.`);
      }
    }
  }
}
function yaml(file: string): Data { return parse(fs.readFileSync(file, "utf8")) as Data; }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function projectDocs(cwd: string): string { return path.join(cwd, "project-docs"); }
function metaFile(cwd: string, version: string): string {
  return path.join(projectDocs(cwd), ".meta", "versions", `${version}.yaml`);
}
function snapshot(directory: string, allowLinks = false): Snapshot {
  const files: Snapshot = new Map();
  function visit(current: string): void {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (!allowLinks) throw new Error(`Refusing a fixture link: ${file}`);
        files.set(path.relative(directory, file).replace(/\\/g, "/"), Buffer.from(fs.readlinkSync(file)));
        continue;
      }
      if (entry.isDirectory()) visit(file);
      else files.set(path.relative(directory, file).replace(/\\/g, "/"), fs.readFileSync(file));
    }
  }
  visit(directory);
  return files;
}
function managed(cwd: string): Snapshot {
  const result: Snapshot = new Map();
  for (const name of ["docs", ".meta", "versions"]) {
    for (const [file, bytes] of snapshot(path.join(projectDocs(cwd), name))) result.set(`${name}/${file}`, bytes);
  }
  return result;
}
function expectPreserved(before: Snapshot, after: Snapshot): void {
  for (const [file, bytes] of before) expect(after.get(file)?.equals(bytes), `Changed bytes: ${file}`).toBe(true);
}
function expectSame(before: Snapshot, after: Snapshot): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  expectPreserved(before, after);
}
function baseline(cwd: string): Snapshot {
  return new Map([...managed(cwd)].filter(([file]) => file.startsWith("docs/") ||
    [".meta/chunks-index.yaml", ".meta/specgraph.yaml"].includes(file)));
}
function caseDir(): string { return fs.mkdtempSync(path.join(suiteDir, "case-")); }
function owned(file: string): string {
  const resolved = path.resolve(file);
  const relative = path.relative(fs.realpathSync(suiteDir), resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing an operation outside the test-owned copy: ${resolved}`);
  }
  return resolved;
}
function unlinkedPath(file: string): string {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing a fixture link: ${current}`);
  }
  return resolved;
}
function regularTree(directory: string, dependencies = false): void {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Refusing a fixture link: ${directory}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing a fixture link: ${file}`);
    if (entry.isDirectory()) {
      if (dependencies && [".git", "project-docs"].includes(entry.name)) {
        throw new Error(`Refusing an embedded workspace in acceptance dependencies: ${file}`);
      }
      regularTree(file, dependencies);
    }
    else if (!entry.isFile()) throw new Error(`Not a regular fixture file: ${file}`);
  }
}
function copyAcceptanceDependencies(source: string, cwd: string): void {
  const modules = path.join(source, "node_modules");
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as Data;
  const required = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  if (!fs.existsSync(modules)) {
    if (required.length > 0) throw new Error(`Original acceptance dependencies are missing: ${required.join(", ")} in ${modules}`);
    return;
  }
  unlinkedPath(modules);
  regularTree(modules, true);
  for (const name of required) {
    const dependency = path.resolve(modules, name);
    const relative = path.relative(modules, dependency);
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Acceptance dependency escapes node_modules: ${name}`);
    }
    if (!fs.existsSync(dependency)) throw new Error(`Original acceptance dependency is missing: ${name} at ${dependency}`);
    unlinkedPath(dependency);
  }
  const before = snapshot(modules);
  sourceDependencies.set(modules, before);
  const destination = path.join(owned(cwd), "node_modules");
  unlinkedPath(cwd);
  expect(fs.lstatSync(destination, { throwIfNoEntry: false }), "Acceptance dependencies must be an independent new copy").toBeUndefined();
  fs.cpSync(modules, destination, {
    recursive: true, dereference: false, force: false, errorOnExist: true,
    filter: (file) => {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Refusing a fixture link: ${file}`);
      if (stat.isDirectory() && [".git", "project-docs"].includes(path.basename(file))) {
        throw new Error(`Refusing an embedded workspace in acceptance dependencies: ${file}`);
      }
      return true;
    },
  });
  regularTree(destination, true);
  expectSame(before, snapshot(destination));
  expectSame(before, snapshot(modules));
  console.info(`[system-contracts] copied ${before.size} original dependency files with identical bytes into independent ${destination}; source=${modules}`);
}
function effectiveConfig(cwd: string): Data {
  const directory = path.join(projectDocs(cwd), ".meta");
  const local = path.join(directory, "config.local.yaml");
  return { ...yaml(path.join(directory, "config.yaml")), ...(fs.existsSync(local) ? yaml(local) : {}) };
}
function acceptanceCommand(cwd: string): string | null {
  for (const name of ["config.local.yaml", "config.yaml"]) {
    const file = path.join(projectDocs(cwd), ".meta", name);
    if (!fs.existsSync(file)) continue;
    const layer = yaml(file);
    for (const key of ["acceptance_command", "acceptanceCommand"]) {
      if (typeof layer[key] === "string" && layer[key].trim() !== "") return layer[key] as string;
    }
  }
  return null;
}
function cloneDocs(source: string): string {
  const cwd = caseDir();
  // Existing wrappers are copied as data, then refreshed before they can run.
  for (const name of ["docs", ".meta", "versions", ".ait"]) {
    const directory = path.join(source, name);
    snapshot(directory); // Reject links before copying or invoking any command.
    if (fs.existsSync(directory)) fs.cpSync(directory, path.join(projectDocs(cwd), name), { recursive: true });
  }
  for (const target of corpusTargets(source)) copyArtifact(path.dirname(source), cwd, target);
  return cwd;
}
function cloneFixture(): string { return cloneDocs(projectDocs(fixture)); }

function corpusTargets(sourceDocs: string): string[] {
  const index = yaml(path.join(sourceDocs, ".meta", "chunks-index.yaml"));
  const targets = new Set<string>();
  for (const entry of index.chunks as Data[]) {
    if (!String(entry.id).startsWith("[TDD]-")) continue;
    const file = path.join(sourceDocs, "docs", String(entry.file).replace(/\.md$/, "") + ".md");
    const declaration = /^\s*target_file:[^\r\n]*/m.exec(fs.readFileSync(file, "utf8"));
    expect(declaration, `Missing target_file in ${file}`).not.toBeNull();
    const value = parse(declaration![0]) as Data;
    expect(value.target_file).toBeTypeOf("string");
    targets.add(value.target_file as string);
  }
  return [...targets].sort();
}
function copyArtifact(source: string, destination: string, relative: string): boolean {
  const original = path.resolve(source, relative);
  const local = path.relative(source, original);
  expect(local !== ".." && !local.startsWith(`..${path.sep}`) && !path.isAbsolute(local), relative).toBe(true);
  if (!fs.existsSync(original)) return false; // Preserve real missing-file failures.
  let parent = original;
  while (parent !== source) {
    expect(fs.lstatSync(parent).isSymbolicLink(), `Refusing a fixture link: ${parent}`).toBe(false);
    parent = path.dirname(parent);
  }
  expect(fs.lstatSync(original).isFile(), `Fixture must be a regular file: ${original}`).toBe(true);
  const real = path.relative(fs.realpathSync(source), fs.realpathSync(original));
  expect(real !== ".." && !real.startsWith(`..${path.sep}`) && !path.isAbsolute(real), original).toBe(true);
  const copied = path.join(destination, local);
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.copyFileSync(original, copied);
  const originals = sourceArtifacts.get(source) ?? new Map<string, Buffer>();
  originals.set(local, fs.readFileSync(original));
  sourceArtifacts.set(source, originals);
  return true;
}
async function git(cwd: string, args: string[]): Promise<string> {
  if (["init", "add", "commit", "rm", "reset", "checkout", "restore", "clean", "tag"].includes(args.find((item) => !item.startsWith("--")) ?? "")) owned(cwd);
  const result = await run("git", ["-c", "core.fsmonitor=false", ...args], cwd);
  expect(result.status, `git ${args.join(" ")} in ${cwd}: ${result.stderr}`).toBe(0);
  return result.stdout;
}
async function tracking(cwd: string): Promise<string[]> {
  return (await git(cwd, ["ls-files", "-z", "--"])).split("\0").filter(Boolean).sort();
}
async function gitEvidence(cwd: string, label: string): Promise<GitState> {
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const status = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const eol = await run("git", ["config", "--get", "core.autocrlf"], cwd);
  expect([0, 1]).toContain(eol.status);
  console.info(`[system-contracts] ${label}: HEAD=${head}; clean=${status.trim() === ""}; core.autocrlf=${eol.stdout.trim() || "unset"}; status=${JSON.stringify(status)}`);
  return { head, status, refs: await git(cwd, ["show-ref", "--head"]), tracked: await tracking(cwd) };
}
async function seedGit(cwd: string, tracked: string[], copied: string[], host: boolean): Promise<void> {
  await git(cwd, ["init", "--quiet"]);
  // Avoid checkout newline conversion; historical assertions still compare exact bytes.
  await git(cwd, ["config", "core.autocrlf", "false"]);
  const index = new Set(tracked);
  const ignored = copied.filter((file) => !index.has(file))
    .map((file) => "/" + file.replace(/[\\*?\[\]#! ]/g, "\\$&"));
  ignored.push(...(host ? ["/project-docs/"] : ["/.ait/", "/.meta/config.local.yaml"]));
  write(path.join(cwd, ".git", "info", "exclude"), ignored.join("\n") + "\n");
  if (tracked.length > 0) {
    const list = path.join(caseDir(), "tracked-paths");
    fs.writeFileSync(list, tracked.join("\0") + "\0");
    await git(cwd, ["--literal-pathspecs", "add", "--force", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]);
  }
  await git(cwd, ["commit", "--quiet", "--allow-empty", "-m", "Copy corpus worktree and original tracking scope"]);
  expect(await tracking(cwd)).toEqual(tracked);
  expect((await gitEvidence(cwd, "copied repository")).status).toBe("");
}
async function copyRepository(source: string, destination: string): Promise<void> {
  owned(destination);
  const original = path.join(source, ".git");
  expect(fs.existsSync(original), `Real history is required: ${original}`).toBe(true);
  expect(fs.lstatSync(original).isDirectory() && !fs.lstatSync(original).isSymbolicLink(),
    `Linked worktrees and external gitdirs cannot be copied safely: ${original}`).toBe(true);
  regularTree(original);
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    const file = path.join(original, name);
    expect(!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() === "",
      `External Git storage must be isolated before takeover: ${file}`).toBe(true);
  }
  const config = await run("git", ["config", "--local", "--get-regexp", "^(core\\.worktree|include.*\\.path|extensions\\.worktreeconfig)$"], source);
  expect(config.status, `Unsafe Git worktree/include configuration in ${source}: ${config.stdout}${config.stderr}`).toBe(1);
  const sourceState = await gitEvidence(source, "original read-only repository");
  const objects = await git(source, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
  fs.cpSync(original, path.join(destination, ".git"), { recursive: true });
  // Disable copied hooks before any command runs in the copy. Do not change global Git configuration.
  const hooks = path.join(suiteDir, "disabled-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.appendFileSync(path.join(destination, ".git", "config"), `\n[core]\n\thooksPath = "${hooks.replace(/\\/g, "/")}"\n\tfsmonitor = false\n`);
  expect((await git(destination, ["config", "core.hooksPath"])).trim()).toBe(hooks.replace(/\\/g, "/"));
  const copiedState = await gitEvidence(destination, "copied original Git history");
  expect(copiedState.head).toBe(sourceState.head);
  expect(copiedState.refs).toBe(sourceState.refs);
  expect(copiedState.tracked).toEqual(sourceState.tracked);
  expect(await git(destination, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).toBe(objects);
}
async function cloneTakeover(sourceDocs: string): Promise<string> {
  const cwd = cloneDocs(sourceDocs);
  const source = path.dirname(sourceDocs);
  const hostTracked = await tracking(source);
  const docsTracked = await tracking(sourceDocs);
  for (const [from, to, tracked] of [[source, cwd, hostTracked], [sourceDocs, projectDocs(cwd), docsTracked]] as const) {
    for (const file of tracked) expect(copyArtifact(from, to, file), `Tracked source missing: ${from}/${file}`).toBe(true);
    await copyRepository(from, to);
  }
  acceptanceProjects.add(path.resolve(cwd));
  originalAcceptance.set(cwd, acceptanceCommand(cwd));
  return cwd;
}
function wrapperPath(cwd: string): string {
  return path.join(projectDocs(cwd), ".ait", process.platform === "win32" ? "ait-cli.cmd" : "ait-cli");
}
async function runWrapper(cwd: string, argv: string[]): Promise<Run> {
  const wrapper = wrapperPath(cwd);
  expect(fs.statSync(wrapper).isFile()).toBe(true);
  if (process.platform !== "win32") return run(wrapper, argv, cwd);
  // These tests use content files and an acceptance script, so no shell source is an argument.
  for (const value of [wrapper, ...argv]) expect(value).not.toMatch(/["\r\n%]/);
  const quoted = [wrapper, ...argv].map((value) => `"${value}"`).join(" ");
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], cwd, TIMEOUT, true);
}
async function refreshInstalledWrapper(cwd: string): Promise<void> {
  const before = managed(cwd);
  await ok(cwd, ["init", "--refresh-wrapper"], "bin");
  expectSame(before, managed(cwd));
  const wrapper = fs.readFileSync(wrapperPath(cwd));
  expect(wrapper.toString("utf8")).toContain(process.execPath);
  expect(wrapper.toString("utf8")).toContain(bin);
  await ok(cwd, ["--version"], "wrapper");
  await rejectWithoutWrites(cwd, ["unknown-command"], "USAGE_ERROR", "wrapper");
  await ok(cwd, ["init", "--refresh-wrapper"], "wrapper");
  expect(fs.readFileSync(wrapperPath(cwd)).equals(wrapper)).toBe(true);
  expectSame(before, managed(cwd));
  console.info(`[system-contracts] actual project wrapper: ${wrapperPath(cwd)}; installed bin=${bin}; single JSON and nonzero error verified; receipt registration uses codegen receipt`);
}

function run(executable: string, args: string[], cwd: string, timeout = TIMEOUT, verbatim = false): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0",
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      GIT_AUTHOR_NAME: "AIT contract tests", GIT_AUTHOR_EMAIL: "ait-tests@example.invalid",
      GIT_COMMITTER_NAME: "AIT contract tests", GIT_COMMITTER_EMAIL: "ait-tests@example.invalid" };
    for (const name of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)$/.test(name)) delete env[name];
    }
    // Only takeover children lose the corpus list. Their acceptance may invoke this
    // very suite, which must still run its built-in case without recursive takeover.
    if (acceptanceProjects.has(path.resolve(cwd))) {
      delete env.AIT_CORPUS_DIRS;
      const scripts = path.join(cwd, ".venv", process.platform === "win32" ? "Scripts" : "bin");
      if (fs.existsSync(scripts)) env.PATH = `${scripts}${path.delimiter}${env.PATH ?? ""}`;
    }
    const child = spawn(executable, args, {
      cwd, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { stdout += text; });
    child.stderr.on("data", (text: string) => { stderr += text; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${executable} ${args.join(" ")}\n${stderr}`)); }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status: status ?? -1, stdout, stderr }); });
  });
}
async function npm(args: string[], cwd: string): Promise<Run> {
  const cli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], cwd);
  if (process.platform === "win32") throw new Error("Run this suite through npm test so npm-cli.js can be located.");
  return run("npm", args, cwd);
}
function progressOnly(stderr: string): void {
  for (const line of stderr.trim().split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line) as Data;
    expect(Object.keys(event).sort()).toEqual(["operation", "operationId", "stage", "status"]);
    expect(event.operation).toBeTypeOf("string");
    expect(event.operationId).toBeTypeOf("string");
    expect(["read", "validate", "assemble", "write_bundle", "register_delivery", "acceptance", "git", "persist"]).toContain(event.stage);
    expect(["started", "completed", "failed"]).toContain(event.status);
    noAdvice(event);
  }
}
function oneJson(result: Run, allowProgress = false): Data {
  if (allowProgress) progressOnly(result.stderr);
  else expect(result.stderr, result.stdout).toBe("");
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines, result.stdout).toHaveLength(1);
  return JSON.parse(lines[0]!) as Data;
}
function noAdvice(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["next_action", "next_call", "required_next_call"], `Unexpected orchestration field: ${key}`).not.toContain(key);
    noAdvice(child);
  }
}
async function command(cwd: string, argv: string[], entry: Entry = "dispatch"): Promise<Envelope> {
  const result = entry === "wrapper" ? await runWrapper(cwd, argv) : entry === "bin"
    ? await run(process.execPath, [bin, ...argv], cwd)
    : await run(process.execPath, [apiRunner, "dispatch", JSON.stringify(argv)], cwd);
  const value = oneJson(result, entry !== "dispatch") as unknown as Envelope;
  if (entry === "dispatch") expect(result.stderr).toBe("");
  noAdvice(value);
  expect(result.status, `${argv.join(" ")}\n${result.stdout}`).toBe(value.ok ? 0 : 1);
  if (value.ok) {
    expect(Object.keys(value).sort()).toEqual(value.presentation === undefined ? ["data", "ok"] : ["data", "ok", "presentation"]);
  } else {
    expect(Object.keys(value).sort()).toEqual(["code", "error", "ok"]);
    expect(value.code).toBeTypeOf("string");
    expect(value.error).toBeTypeOf("string");
  }
  return value;
}
async function ok(cwd: string, argv: string[], entry: Entry = "dispatch"): Promise<Data> {
  const result = await command(cwd, argv, entry);
  expect(result.ok, `${argv.join(" ")}: ${JSON.stringify(result)}`).toBe(true);
  return result.data!;
}
async function coreCall(cwd: string, name: string, input: unknown = null): Promise<Data> {
  const result = await run(process.execPath, [apiRunner, name, JSON.stringify(input)], cwd);
  const value = oneJson(result);
  expect(result.stderr, result.stdout).toBe("");
  expect(result.status, result.stdout).toBe(value.ok ? 0 : 1);
  expect(Object.keys(value).sort()).toEqual(value.ok ? ["data", "ok"] : ["code", "error", "ok"]);
  noAdvice(value);
  return value;
}
async function coreOk(cwd: string, name: string, input: unknown = null): Promise<Data> {
  const result = await coreCall(cwd, name, input);
  expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
  return result.data as Data;
}
async function rejectWithoutWrites(cwd: string, argv: string[], code: string, entry: Entry): Promise<void> {
  const before = managed(cwd);
  expect(await command(cwd, argv, entry)).toMatchObject({ ok: false, code });
  expectSame(before, managed(cwd));
}
async function create(cwd: string, argv: string[], content: string, entry: Entry = "dispatch"): Promise<Data> {
  const before = managed(cwd);
  const discussion = await ok(cwd, argv, entry);
  expect(discussion.mode).toBe("discussion-context");
  expect(discussion.context_token).toMatch(/^ctx-v1\./);
  expect(discussion.background).toBeTypeOf("string");
  noAdvice(discussion);
  expectSame(before, managed(cwd));
  // File input keeps multiline content out of cmd.exe argument parsing.
  const contentFile = path.join(caseDir(), "content.md");
  if (entry === "wrapper") write(contentFile, content);
  const written = await ok(cwd, [...argv, entry === "wrapper" ? "--content-file" : "--content",
    entry === "wrapper" ? contentFile : content, "--context-token", discussion.context_token], entry);
  expect(written.mode).toBe("written");
  noAdvice(written);
  return written;
}
function chunk(id: string, body: string): string { return `<!-- @id:${id} -->\n## ${id}\n\n${body}\n`; }
function requirement(id: string): string {
  return chunk(id, "**用户故事:** 作为接管者，我希望验证生成的制品。\n\n### 验收标准\n1. 制品输出 SYSTEM_CONTRACT_VALUE=42，并记录 TDD 来源。");
}
function fsdSplit(id: string, prd: string): string {
  return chunk(id, `提供值 42 的可执行制品。\n\n\`\`\`yaml\nderives:\n  - '${prd}'\n\`\`\``);
}
function tddContent(id = TDD, target = TARGET): string {
  return chunk(id, `\`\`\`yaml\ntarget_file: ${target}\n\`\`\`\n\nSYSTEM_CONTRACT_VALUE=42\n生成 CommonJS 模块，导出 value=42 与 source=${id}。`);
}
async function startFeature(cwd: string, entry?: Entry): Promise<Feature> {
  const graph = await ok(cwd, ["specgraph", "export"], entry);
  const nodes = new Map<string, Data>((graph.specs as Data[]).map((node) => [node.uri as string, node]));
  const roots = (graph.specs as Data[]).filter((node) => node.type === "prd" && !node.chunk_id.includes(":"));
  expect(roots.length, "Python fixture must contain a PRD root").toBeGreaterThan(0);
  const prd = roots[0]!;
  const links = (graph.edges as Data[]).filter((edge) => edge.rel === "derives" && edge.src === prd.uri);
  expect(links, "The existing PRD must retain exactly one FSD root").toHaveLength(1);
  const fsd = nodes.get(links[0]!.dst)!;
  expect(fsd.type).toBe("fsd");
  expect(fsd.chunk_id).not.toContain(":");
  const versions = fs.readdirSync(path.join(projectDocs(cwd), ".meta", "versions"));
  const major = Math.max(0, ...versions.map((name) => Number(/^v(\d+)\./.exec(name)?.[1] ?? 0))) + 1;
  const version = `v${major}.0`;
  const created = await ok(cwd, ["version", "create", version], entry ?? "bin");
  expect(created.version).toBe(version);
  noAdvice(created);
  const feature: Feature = { cwd, version, prd: prd.chunk_id as string, fsd: fsd.chunk_id as string,
    ...(entry === undefined ? {} : { entry }) };
  await create(cwd, ["prd", "create", `${feature.prd}:system_contract`], requirement(`${feature.prd}:system_contract`), entry);
  await ok(cwd, ["prd", "confirm"], entry ?? "bin");
  return feature;
}
async function writeFeature(feature: Feature): Promise<void> {
  const { cwd, prd, fsd, entry } = feature;
  await create(cwd, ["fsd", "create", `${fsd}:system_contract`], fsdSplit(`${fsd}:system_contract`, `${prd}:system_contract`), entry ?? "bin");
  await create(cwd, ["fsd", "decompose", `${fsd}:system_contract`, CHILD_FSD],
    chunk(CHILD_FSD, "独立制品功能分区。") + "\n" + fsdSplit(`${CHILD_FSD}:implementation`, `${prd}:system_contract`), entry);
  await ok(cwd, ["fsd", "confirm"], entry ?? "bin");
}
async function prepare(cwd: string, entry?: Entry): Promise<Feature> {
  const feature = await startFeature(cwd, entry);
  await writeFeature(feature);
  await create(cwd, ["tdd", "create", TDD, "--parent", `${CHILD_FSD}:implementation`], tddContent(), entry ?? "bin");
  await ok(cwd, ["tdd", "confirm"], entry);
  return feature;
}
async function deliver(feature: Feature, entry: Entry = feature.entry ?? "dispatch", id = TDD): Promise<Delivery> {
  const pointer = await ok(feature.cwd, ["codegen", "prepare", id], entry) as unknown as Delivery;
  expect(pointer.version).toBe(feature.version);
  expect(pointer.tdd_root).toBe(id);
  noAdvice(pointer);
  expect(pointer).not.toHaveProperty("content");
  expect(path.isAbsolute(pointer.bundle_path)).toBe(true);
  const relative = path.relative(feature.cwd, pointer.bundle_path);
  expect(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true);
  deliveries.add(path.dirname(pointer.bundle_path));
  const bytes = fs.readFileSync(pointer.bundle_path);
  expect(bytes.length).toBe(pointer.bytes);
  expect(hash(bytes)).toBe(pointer.sha256);
  expect(bytes.toString("utf8")).toContain(tddContent(id, pointer.target_file).trim());
  expect(pointer.generation_token).toMatch(/^gen-v1\./);
  return pointer;
}
function generate(cwd: string, delivery: Delivery): void {
  const bytes = fs.readFileSync(delivery.bundle_path);
  expect(hash(bytes)).toBe(delivery.sha256);
  expect(bytes.length).toBe(delivery.bytes);
  const match = /SYSTEM_CONTRACT_VALUE=(\d+)/.exec(bytes.toString("utf8"));
  expect(match).not.toBeNull();
  // The host consumes the delivered requirement and writes an executable artifact.
  write(path.join(cwd, delivery.target_file), `module.exports = ${JSON.stringify({ value: Number(match![1]), source: delivery.tdd_root })};\n`);
}
async function receipt(cwd: string, delivery: Delivery, entry?: Entry): Promise<Data> {
  const value = entry === undefined
    ? await coreOk(cwd, "generation.registerReceipt", { generationToken: delivery.generation_token })
    : await ok(cwd, ["codegen", "receipt", "--generation-token", delivery.generation_token], entry);
  expect(value).toMatchObject({ version: delivery.version, tdd_root: delivery.tdd_root,
    target_file: delivery.target_file, bundle_sha256: delivery.sha256,
    artifact_sha256: hash(fs.readFileSync(path.join(cwd, delivery.target_file))) });
  expect(value.generated_at).toBeTypeOf("string");
  return value;
}
function policy(cwd: string, enforcement: "report" | "block"): void {
  const file = path.join(projectDocs(cwd), ".meta", "config.local.yaml");
  write(file, stringify({ ...(fs.existsSync(file) ? yaml(file) : {}), generation_receipts: { enforcement } }));
}
function expectAccepted(cwd: string, confirmed: Data): void {
  expect(confirmed).toMatchObject({ passed: true });
  expect(confirmed.acceptance).toEqual({ ran: true, passed: true, exitCode: 0 });
  const original = originalAcceptance.get(cwd);
  if (original != null) expect(acceptanceCommand(cwd)).toBe(original);
}
async function acceptance(cwd: string, entry?: Entry, options: { executeCommand?: boolean } = {}): Promise<void> {
  const script = `const a=require('node:assert/strict');const x=require(require('node:path').resolve('${TARGET}'));a.equal(x.value,42);a.equal(x.source,'${TDD}');`;
  if (acceptanceCommand(cwd) === null) {
    const harness = "system-contract-acceptance.cjs";
    if (entry === "wrapper") {
      expect(fs.existsSync(path.join(cwd, harness)), "Do not overwrite an existing project artifact").toBe(false);
      write(path.join(cwd, harness), script);
      if (fs.existsSync(path.join(cwd, ".git", "info"))) {
        fs.appendFileSync(path.join(owned(cwd), ".git", "info", "exclude"), `\n/${harness}\n`);
      }
    }
    await ok(cwd, ["acceptance", "set", entry === "wrapper" ? `node ${harness}` : `"${process.execPath}" -e "${script}"`], entry ?? "bin");
  }
  const original = originalAcceptance.get(cwd);
  if (original != null) expect(acceptanceCommand(cwd)).toBe(original);
  if (options.executeCommand !== false) {
    expect(await ok(cwd, ["acceptance", "run"], entry)).toMatchObject({ ran: true, passed: true, exitCode: 0 });
  }
  const probe = await run(process.execPath, ["-e", script], cwd);
  expect(probe.status, `Generated artifact probe failed: ${probe.stdout}${probe.stderr}`).toBe(0);
}
async function prepareAcceptance(cwd: string, source: string): Promise<void> {
  const configured = originalAcceptance.get(cwd);
  if (configured == null) return;
  const before = acceptanceCommand(cwd);
  if (fs.existsSync(path.join(cwd, "package.json"))) {
    const lockfile = path.join(cwd, "package-lock.json");
    const lock = fs.existsSync(lockfile) ? fs.readFileSync(lockfile) : null;
    copyAcceptanceDependencies(source, cwd);
    if (lock !== null) expect(fs.readFileSync(lockfile).equals(lock), "Dependency preparation must preserve the original lockfile bytes").toBe(true);
    else expect(fs.existsSync(lockfile)).toBe(false);
  } else if (fs.existsSync(path.join(cwd, "pyproject.toml")) && /(?:python|pytest|\.venv)/i.test(configured)) {
    const environment = path.join(owned(cwd), ".venv");
    const created = await run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", environment], cwd);
    expect(created.status, created.stdout + created.stderr).toBe(0);
    const python = path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const installed = await run(python, ["-m", "pip", "install", "-e", ".[dev]"], cwd);
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  }
  expect(acceptanceCommand(cwd)).toBe(before);
  console.info(`[system-contracts] original acceptance retained: ${configured}; copied project=${cwd}; AIT_CORPUS_DIRS removed only from its child environment`);
}

function pythonFixture(cwd: string): void {
  write(path.join(cwd, "legacy.cjs"), "module.exports = { value: 42, source: '[TDD]-legacy' };\n");
  const stamp = "2025-01-01T00:00:00+00:00";
  const records = [
    { id: "[PRD]-legacy", file: "prd/[PRD]-legacy", content: chunk("[PRD]-legacy", "Python 管理的原有需求根。") },
    { id: "[PRD]-legacy:behavior", file: "prd/[PRD]-legacy", content: requirement("[PRD]-legacy:behavior") },
    { id: "[FSD]-legacy", file: "fsd/[FSD]-legacy", content: chunk("[FSD]-legacy", "Python 管理的唯一功能根。") },
    { id: "[FSD]-legacy:feature", file: "fsd/[FSD]-legacy", content: chunk("[FSD]-legacy:feature", "既有功能分区。") },
    { id: "[FSD]-legacy-feature", file: "fsd/[FSD]-legacy-feature", content: chunk("[FSD]-legacy-feature", "既有功能。") },
    { id: "[FSD]-legacy-feature:implementation", file: "fsd/[FSD]-legacy-feature", content: chunk("[FSD]-legacy-feature:implementation", "输出原有制品。") },
    { id: "[TDD]-legacy", file: "tdd/[TDD]-legacy", content: tddContent("[TDD]-legacy", "legacy.cjs") },
  ];
  const docs = projectDocs(cwd);
  for (const file of new Set(records.map((record) => record.file))) {
    const text = records.filter((record) => record.file === file).map((record) => record.content).join("\n");
    write(path.join(docs, "docs", `${file}.md`), text);
    write(path.join(docs, "versions", "v1.0", `${file}.md`), text);
  }
  const chunks = records.map((record) => ({ id: record.id, file: record.file, heading: record.id, level: 2, summary: null, metadata: {} }));
  const uri = (id: string, version = "baseline"): string => `spec:${id.slice(1, 4).toLowerCase()}:${version}:${id}`;
  const relations = [
    ["[PRD]-legacy", "[FSD]-legacy", "derives"],
    ["[PRD]-legacy:behavior", "[FSD]-legacy:feature", "derives"],
    ["[FSD]-legacy:feature", "[FSD]-legacy-feature", "decomposes"],
    ["[PRD]-legacy:behavior", "[FSD]-legacy-feature:implementation", "derives"],
    ["[FSD]-legacy-feature:implementation", "[TDD]-legacy", "details"],
  ];
  for (const version of ["baseline", "v1.0"]) {
    write(path.join(docs, ".meta", version === "baseline" ? "specgraph.yaml" : `specgraph-${version}.yaml`), stringify({
      version: 1, updated: stamp,
      specs: records.map((record) => ({ uri: uri(record.id, version), title: record.id,
        type: record.id.slice(1, 4).toLowerCase(), version, chunk_id: record.id, file: record.file, metadata: { source: version === "baseline" ? "baseline" : "version" } })).sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
      edges: relations.map(([src, dst, rel]) => ({ src: uri(src!, version), dst: uri(dst!, version), rel, weight: 1.0, metadata: { source: "new-model-cli" } })),
    }));
  }
  write(path.join(docs, ".meta", "config.yaml"), "initialized: true\nid_prefix_separator: '-'\nversion_format: '{major}.{minor}'\n");
  write(path.join(docs, ".meta", "chunks-index.yaml"), stringify({ version: 1, scope: "global", updated: stamp, chunks }));
  write(path.join(docs, ".meta", "chunks-index-v1.0.yaml"), stringify({
    version: 1, scope: "version", version_name: "v1.0", based_on_hash: null, status: "merged",
    chunks: chunks.map((value) => ({ ...value, action: "add", state: "committed", commit_id: "c1" })),
    commits: [{ id: "c1", timestamp: stamp, message: "Python historical commit", chunks: records.map((record) => record.id), req_id: null }],
    stats: { total_chunks: records.length, by_action: { add: records.length }, by_state: { committed: records.length }, tasks_summary: {} },
  }));
  // Python-shaped history intentionally has none of Node's generation fields.
  write(path.join(docs, ".meta", "versions", "v1.0.yaml"), stringify({
    version: "v1.0", created_at: stamp, merged_at: stamp, owner: "system", phase: "merged",
    changes: records.map((_record, index) => `chg-${index + 1}`),
    dependencies: { based_on: null, conflicts_with: [], merge_after: [] },
  }));
  records.forEach((record, index) => write(path.join(docs, ".meta", "changes", `chg-${index + 1}.yaml`), stringify({
    id: `chg-${index + 1}`, version: "v1.0", type: "ADD", target: `${record.file}#${record.id}`,
    author: "system", date: stamp, message: "Python historical commit", base_content: null, new_content: record.content.trim(),
  })));
}

const TYPES_PROBE = String.raw`
import { createCoreApi, dispatch } from "ait-core";
import type * as T from "ait-core";
// @ts-expect-error Retired orchestration types are not public.
import type { NextAction } from "ait-core";
// @ts-expect-error Public clients do not require an internal project-root shape.
import type { ProjectRoot } from "ait-core";
// @ts-expect-error Callers cannot issue their own generation deliveries.
import type { GenerationDeliveryInput } from "ait-core";
type PublicContracts = [
  T.CoreApi, T.CoreApiOptions, T.CoreProgressEvent, T.ProgressStage, T.ProgressStatus,
  T.CliDispatchResult, T.CliPresentation, T.Direction, T.EdgeRel, T.LayerScope,
  T.SearchScope, T.StateFormat, T.GitAvailability, T.VersionPhase,
  T.InitInput, T.VersionInput, T.OptionalVersionInput, T.VersionRevertInput,
  T.DocumentInput, T.PrdInput, T.DecomposeInput, T.DeliveryPrepareInput,
  T.GraphQueryInput, T.GraphImpactInput, T.SearchInput, T.BaselineSummaryInput,
  T.StateSaveInput, T.AcceptanceSetInput, T.PushInput, T.GenerationReceiptInput,
  T.GenerationStatusInput, T.GuardEvaluateInput, T.DocumentVersionResult,
  T.InitResult, T.ProjectCheckResult, T.InitResponse, T.VersionCreateResult,
  T.VersionCommitResult, T.VersionStatus, T.VersionConfirmResult, T.VersionMergeResult,
  T.VersionRevertResult, T.BackfillTagsResult, T.DiscussionResult, T.DocumentWrittenResult,
  T.DocumentResult, T.DecomposeWrittenResult, T.DecomposeResult, T.LayerConfirmResult,
  T.LayerRevertResult, T.DeliveryMetadata, T.MemoryDelivery, T.DeliveryPointer,
  T.DepsResult, T.ViewEdge, T.ImpactResult, T.SpecGraph, T.BaselineIndex,
  T.ValidationReport, T.GovernanceFinding, T.EdgeRef, T.SearchHit, T.SearchResult,
  T.BaselineSummaryItem, T.BaselineSummary, T.BaselineStats, T.StatePanel,
  T.MarkdownState, T.StateSaveResult, T.AcceptanceConfigResult, T.AcceptanceResult,
  T.PushReport, T.PushResult, T.SessionContext, T.LayerCounts, T.VersionSummary,
  T.VersionListResult, T.VersionInspection, T.GenerationItemStatus, T.GenerationStatus,
  T.EffectiveGovernancePolicy, T.GuardDecision, T.GenerationReceipt, T.GenerationVerification,
  T.ProjectApi, T.VersionApi, T.PrdApi, T.FsdApi, T.TddApi, T.DeliveryApi, T.GraphApi,
  T.SearchApi, T.StateApi, T.IndexApi, T.AcceptanceApi, T.PublishApi, T.SessionApi,
  T.GenerationApi, T.GovernanceApi, T.GuardApi
];
const options: T.CoreApiOptions = { onProgress(event: T.CoreProgressEvent) { void event.operationId; } };
const core: T.CoreApi = createCoreApi(options);
const argvResult: Promise<T.CoreResult> = dispatch([]);
const cliResult: Promise<T.CliDispatchResult> = dispatch([], options);
const check = <U extends object>(result: T.R<U>): void => { void result; };
check<T.DocumentVersionResult>(core.project.documentVersion());
check<T.InitResponse>(core.project.init());
check<T.VersionCreateResult>(core.version.create({ version: "v2.0" }));
check<T.VersionCommitResult>(core.version.commit({ version: "v2.0" }));
check<T.VersionStatus>(core.version.status({ version: "v2.0" }));
check<T.VersionConfirmResult>(core.version.confirm({ version: "v2.0" }));
check<T.VersionMergeResult>(core.version.merge({ version: "v2.0" }));
check<T.VersionRevertResult>(core.version.revert({ version: "v2.0", confirm: true }));
check<T.BackfillTagsResult>(core.version.backfillTags());
check<T.VersionListResult>(core.version.list());
check<T.VersionInspection>(core.version.inspect({ version: "v2.0" }));
check<T.DocumentResult>(core.prd.create({ id: "[PRD]-demo", contextToken: "token" }));
check<T.LayerConfirmResult>(core.prd.confirm());
check<T.LayerRevertResult>(core.prd.revert());
check<T.DocumentResult>(core.fsd.create({ id: "[FSD]-demo", parent: "[PRD]-demo" }));
check<T.LayerConfirmResult>(core.fsd.confirm());
check<T.LayerRevertResult>(core.fsd.revert());
check<T.DecomposeResult>(core.fsd.decompose({ parentSplit: "[FSD]-demo:feature", childRootId: "[FSD]-demo-feature" }));
check<T.DocumentResult>(core.tdd.create({ id: "[TDD]-demo", parent: "[FSD]-demo:feature" }));
check<T.LayerConfirmResult>(core.tdd.confirm());
check<T.LayerRevertResult>(core.tdd.revert());
check<T.MemoryDelivery>(core.delivery.prepare({ tddRootId: "[TDD]-demo" }));
check<T.MemoryDelivery>(core.delivery.prepare({ tddRootId: "[TDD]-demo", output: "memory" }));
check<T.DeliveryPointer>(core.delivery.prepare({ tddRootId: "[TDD]-demo", output: "file" }));
declare const deliveryInput: T.DeliveryPrepareInput;
check<T.MemoryDelivery | T.DeliveryPointer>(core.delivery.prepare(deliveryInput));
check<T.DepsResult>(core.graph.query({ target: "[FSD]-demo", direction: "out", rels: ["details", "depends_on"], version: "baseline" }));
check<T.ImpactResult>(core.graph.impact({ target: "[FSD]-demo" }));
check<T.SpecGraph>(core.graph.sync());
check<T.SpecGraph>(core.graph.export());
check<T.ValidationReport>(core.graph.validateNewModel());
check<T.SearchResult>(core.search.query({ query: "demo", regexp: false, scope: "all" }));
check<T.BaselineSummary>(core.search.baselineSummary({ scope: "tdd" }));
check<T.BaselineStats>(core.search.baselineStats());
check<T.StatePanel>(core.state.get());
check<T.MarkdownState>(core.state.render());
check<T.StateSaveResult>(core.state.save({ format: "json" }));
check<T.BaselineIndex>(core.index.rebuild());
check<T.AcceptanceConfigResult>(core.acceptance.set({ command: "node acceptance.cjs" }));
check<T.AcceptanceConfigResult>(core.acceptance.show());
check<T.AcceptanceResult>(core.acceptance.run());
check<T.PushReport>(core.publish.push({ dryRun: true }));
check<T.SessionContext>(core.session.get());
check<T.GenerationReceipt>(core.generation.registerReceipt({ generationToken: "token" }));
check<T.GenerationVerification>(core.generation.verifyReceipts({ version: "v2.0" }));
check<T.GenerationStatus>(core.generation.status({ version: "v2.0", tddRootId: "[TDD]-demo" }));
check<T.EffectiveGovernancePolicy>(core.governance.getPolicy());
const guard: T.ApiResult<T.GuardDecision> = core.guard.evaluate({ toolName: "write", input: { path: "source.ts" } });
// @ts-expect-error Factory options do not expose cancellation.
createCoreApi({ signal: new AbortController().signal });
// @ts-expect-error A client is bound to its creation directory.
createCoreApi({ cwd: "." });
// @ts-expect-error I/O methods do not expose cancellation.
core.version.confirm({ version: "v2.0", cancel: true });
// @ts-expect-error Direction aliases have been removed.
core.graph.query({ target: "x", direction: "from" });
// @ts-expect-error CLI-only summary format is not a business input.
core.search.baselineSummary({ format: "json" });
// @ts-expect-error PRD input has no parent.
core.prd.create({ id: "[PRD]-demo", parent: "[PRD]-other" });
// @ts-expect-error Decompose identifies its child by childRootId.
core.fsd.decompose({ id: "x", parentSplit: "x", childRootId: "y" });
declare const memory: T.MemoryDelivery;
// @ts-expect-error Memory delivery has no intermediate file.
memory.bundle_path;
declare const pointer: T.DeliveryPointer;
// @ts-expect-error File delivery does not serialize content.
pointer.content;
declare const session: T.SessionContext;
// @ts-expect-error Session provides facts without next-action advice.
session.next_action;
declare const contracts: PublicContracts;
void [argvResult, cliResult, guard, contracts];
`;

const API_RUNNER = String.raw`
import * as api from "ait-core";
const [name, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const cwd = process.cwd();
try {
  let result;
  if (name === "dispatch") {
    result = await api.dispatch(input);
  } else {
    const core = api.createCoreApi();
    const [group, method] = name.split(".");
    if (typeof core[group]?.[method] !== "function") throw new Error("Unknown test operation: " + name);
    result = input === null ? await core[group][method]() : await core[group][method](input);
  }
  if (process.cwd() !== cwd) throw new Error("API changed cwd");
  process.exitCode = result.ok ? 0 : 1;
  console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ thrown: true, code: error.code, message: error.message })); process.exitCode = 2; }
`;

const IMPORT_PROBE = String.raw`
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import cp from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const modules = path.join(process.cwd(), "node_modules") + path.sep;
const undo = [];
function patch(object, name, wrapper) {
  const original = object[name];
  if (typeof original !== "function") return;
  object[name] = wrapper(original);
  undo.push(() => { object[name] = original; });
}
const fail = (name) => () => { throw new Error("Import performed IO: " + name); };
for (const object of [fs, fsp]) {
  for (const name of ["readFile", "readFileSync", "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "existsSync", "realpath", "realpathSync", "readlink", "readlinkSync", "open", "openSync"]) {
    patch(object, name, (original) => function (...args) {
      const target = path.resolve(args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]));
      if (!target.startsWith(modules)) throw new Error("Import accessed project: " + target);
      if (name.startsWith("open") && args[1] !== undefined && !["r", "rs"].includes(args[1])) throw new Error("Import opened a file for writing");
      return original.apply(object, args);
    });
  }
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "copyFile", "copyFileSync", "createReadStream", "createWriteStream", "watch"]) patch(object, name, () => fail(name));
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(cp, name, () => fail(name));
for (const [object, names] of [[net, ["connect", "createConnection", "createServer"]], [http, ["request", "get"]], [https, ["request", "get"]]]) for (const name of names) patch(object, name, () => fail(name));
patch(globalThis, "fetch", () => fail("fetch"));
patch(process.stdout, "write", () => fail("stdout"));
patch(process.stderr, "write", () => fail("stderr"));
syncBuiltinESMExports();
let api, core;
try { api = await import("ait-core"); core = api.createCoreApi(); }
finally { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); }
const first = await core.project.documentVersion();
const second = await core.project.documentVersion();
console.log(JSON.stringify({ exports: Object.keys(api).sort(), functions: Object.values(api).every((value) => typeof value === "function"), first, second, alive: true }));
`;

// This installed consumer imports only the object API. The test runner starts
// its host process, but every AIT operation below is a direct Node method call.
const NODE_ONLY_FLOW = String.raw`
import { createCoreApi } from "ait-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const cwd = process.cwd();
const events = [];
let inAcceptance = false;
let acceptanceTicks = 0;
const core = createCoreApi({ onProgress(event) {
  events.push(event);
  if (event.stage === "acceptance") inAcceptance = event.status === "started";
  throw new Error("A display callback cannot alter the operation");
} });
function facts(value) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!["next_action", "next_call", "required_next_call"].includes(key));
    facts(child);
  }
}
async function ok(promise) {
  const result = await promise;
  facts(result);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ["data", "ok"]);
  return result.data;
}
const chunk = (id, body) => "<!-- @id:" + id + " -->\n## " + id + "\n\n" + body + "\n";
const fence = String.fromCharCode(96).repeat(3);
const yamlBlock = (body) => fence + "yaml\n" + body + "\n" + fence;
async function document(api, input, content) {
  const discussion = await ok(api.create(input));
  assert.equal(discussion.mode, "discussion-context");
  assert.match(discussion.context_token, /^ctx-v1\./);
  assert.equal((await ok(api.create({ ...input, content, contextToken: discussion.context_token }))).mode, "written");
}
// The same client continues to read its original project after the host moves.
process.chdir(path.dirname(cwd));
assert.equal((await ok(core.session.get())).project_root, cwd);
assert.equal(process.cwd(), path.dirname(cwd));
process.chdir(cwd);
assert.equal((await core.state.get()).code, "NO_VERSION");
const version = "v2.0", prd = "[PRD]-legacy:node_contract", fsd = "[FSD]-legacy:node_contract";
const childFsd = "[FSD]-node-contract", leaf = childFsd + ":implementation";
const tdd = "[TDD]-node-contract", target = "node-only-output.cjs";
await ok(core.version.create({ version }));
await document(core.prd, { id: prd }, chunk(prd,
  "**用户故事:** 作为接管者，我希望直接使用 Node API 生成制品。\n\n### 验收标准\n1. WHEN 执行制品 THEN 系统 SHALL 输出 42。"));
await ok(core.prd.confirm());
await document(core.fsd, { id: fsd }, chunk(fsd, "实现值 42。\n\n" + yamlBlock("derives:\n  - '" + prd + "'")));
const decomposition = { parentSplit: fsd, childRootId: childFsd };
const background = await ok(core.fsd.decompose(decomposition));
assert.equal(background.mode, "discussion-context");
assert.match(background.context_token, /^ctx-v1\./);
const childContent = chunk(childFsd, "Node 独立制品功能分区。") + "\n" +
  chunk(leaf, "实现值 42。\n\n" + yamlBlock("derives:\n  - '" + prd + "'"));
assert.equal((await ok(core.fsd.decompose({ ...decomposition, content: childContent, contextToken: background.context_token }))).mode, "written");
await ok(core.fsd.confirm());
const spec = chunk(tdd, yamlBlock("target_file: " + target) + "\n\nSYSTEM_CONTRACT_VALUE=42\n生成 CommonJS 模块，导出 value 与 source。");
await document(core.tdd, { id: tdd, parent: leaf }, spec);
await ok(core.tdd.confirm());
// A file occupying every temporary directory path makes an accidental bundle
// write fail. Metadata writes inside the copied project must still succeed.
const blockedTemp = path.join(cwd, "unusable-bundle-temp");
fs.writeFileSync(blockedTemp, "not a directory");
const oldTemp = new Map(["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]]));
const deliveryStart = events.length;
let delivery;
try {
  for (const key of oldTemp.keys()) process.env[key] = blockedTemp;
  delivery = await ok(core.delivery.prepare({ tddRootId: tdd }));
} finally {
  for (const [key, value] of oldTemp) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.unlinkSync(blockedTemp);
}
assert.equal(Object.hasOwn(delivery, "bundle_path"), false);
assert.equal(delivery.target_state, "absent");
assert.equal(delivery.version, version);
assert.equal(delivery.target_file, target);
assert(delivery.content.includes(spec.trim()));
const bytes = Buffer.from(delivery.content, "utf8");
assert.equal(bytes.length, delivery.bytes);
assert.equal(createHash("sha256").update(bytes).digest("hex"), delivery.sha256);
assert.equal(events.slice(deliveryStart).some((event) => event.stage === "write_bundle"), false);
// The deterministic host receives the complete in-memory context directly.
const match = /SYSTEM_CONTRACT_VALUE=(\d+)/.exec(delivery.content);
assert(match);
fs.writeFileSync(path.join(cwd, target), "module.exports = " + JSON.stringify({ value: Number(match[1]), source: tdd }) + ";\n");
const receipt = await ok(core.generation.registerReceipt({ generationToken: delivery.generation_token }));
assert.equal(receipt.bundle_sha256, delivery.sha256);
assert.equal(receipt.artifact_sha256, createHash("sha256").update(fs.readFileSync(path.join(cwd, target))).digest("hex"));
assert.deepEqual(await ok(core.generation.registerReceipt({ generationToken: delivery.generation_token })), receipt);
assert.deepEqual((await ok(core.generation.verifyReceipts({ version }))).findings, []);
const status = await ok(core.generation.status({ version, tddRootId: tdd }));
assert.equal(status.items[0].receipt_present, true);
assert.equal(status.items[0].artifact_state, "loaded");
assert.equal((await ok(core.version.inspect({ version }))).confirmation.state, "missing");
const acceptanceFile = "node-only-acceptance.cjs";
fs.writeFileSync(path.join(cwd, acceptanceFile),
  "const a=require('node:assert/strict');const value=require('./" + target + "');a.equal(value.value,42);a.equal(value.source,'" + tdd + "');setTimeout(()=>{},180);\n");
await ok(core.acceptance.set({ command: '"' + process.execPath + '" ' + acceptanceFile }));
const ticks = {};
for (const operation of ["acceptance.run", "version.confirm"]) {
  acceptanceTicks = 0;
  const start = events.length;
  const timer = setInterval(() => { if (inAcceptance) acceptanceTicks++; }, 5);
  let result;
  try { result = await ok(operation === "acceptance.run" ? core.acceptance.run() : core.version.confirm({ version })); }
  finally { clearInterval(timer); }
  assert.equal(result.passed, true);
  if (operation === "version.confirm") assert.equal(result.acceptance.passed, true);
  assert(acceptanceTicks > 0, operation + " blocked the host during actual acceptance");
  ticks[operation] = acceptanceTicks;
  const progress = events.slice(start);
  assert(progress.every((event) => event.operation === operation));
  assert.equal(new Set(progress.map((event) => event.operationId)).size, 1);
  const acceptance = progress.filter((event) => event.stage === "acceptance");
  assert.deepEqual(acceptance.map((event) => event.status), ["started", "completed"]);
}
assert.equal((await ok(core.version.inspect({ version }))).confirmation.state, "valid");
await ok(core.version.merge({ version }));
assert.equal((await ok(core.version.inspect({ version }))).confirmation.state, "not_applicable");
assert.equal((await ok(core.session.get())).active_version, null);
assert.equal((await ok(core.version.list())).versions.at(-1).merged, true);
assert.equal(process.cwd(), cwd);
console.log(JSON.stringify({ completed: true, version, target, memoryBytes: delivery.bytes, ticks }));
`;

beforeAll(async () => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-system-contracts-"));
  consumer = path.join(suiteDir, "consumer");
  fs.mkdirSync(consumer);
  write(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const distribution = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as Data;
  expect(distribution.scripts).toMatchObject({ prepack: "npm run build", pretest: "npm run build" });
  requireCurrentProductionBuild(REPO);
  // pretest builds once before workers start. Packing must only consume those
  // validated files; rebuilding shared dist here races other suites' workers.
  const packed = await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", suiteDir], REPO);
  expect(packed.status, `npm pack failed:\n${packed.stderr}\n${packed.stdout}`).toBe(0);
  const packs = JSON.parse(packed.stdout) as Data[];
  expect(packs).toHaveLength(1);
  const tarball = path.join(suiteDir, packs[0]!.filename as string);
  const installed = await npm(["install", tarball, "--no-audit", "--no-fund"], consumer);
  expect(installed.status, `Real tarball install failed; do not skip or replace with a link:\n${installed.stderr}\n${installed.stdout}`).toBe(0);
  const packageRoot = path.join(consumer, "node_modules", "ait-core");
  expect(fs.lstatSync(packageRoot).isSymbolicLink()).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Data;
  expect(manifest.name).toBe("ait-core");
  expect(manifest.version).toBe("0.2.1");
  expect(manifest.version).toBe(packs[0]!.version);
  for (const file of ["README.md", "docs/node-api.md", "docs/cli.md", "dist/src/api/worker.js", "dist/src/index.d.ts"]) {
    expect(fs.statSync(path.join(packageRoot, file)).isFile(), `Missing installed contract: ${file}`).toBe(true);
    expect((packs[0]!.files as Data[]).some((item) => item.path === file), `Missing tarball entry: ${file}`).toBe(true);
  }
  bin = path.resolve(packageRoot, manifest.bin.ait as string);
  expect(fs.statSync(bin).isFile()).toBe(true);
  expect(fs.existsSync(path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "ait.cmd" : "ait"))).toBe(true);
  apiRunner = path.join(consumer, "public-api.mjs");
  write(apiRunner, API_RUNNER);
  fixture = path.join(suiteDir, "python-shape-source");
  pythonFixture(fixture);
  const fixtureDocs = [...managed(fixture).keys()].sort();
  await seedGit(projectDocs(fixture), fixtureDocs, fixtureDocs, false);
  await git(projectDocs(fixture), ["tag", "ait/v1.0"]);
  await seedGit(fixture, ["legacy.cjs"], ["legacy.cjs"], true);
  console.info(`[system-contracts] installed ait-core ${manifest.version} from ${tarball}; sha256=${hash(fs.readFileSync(tarball))}`);
  console.info(`[system-contracts] public API/bin, cross-domain gates and built-in Python-shaped fixture enabled`);
  console.info(CORPORA.length > 0
    ? `[system-contracts] real Python corpora: ${CORPORA.join("; ")}`
    : "[system-contracts] real Python takeover NOT EXECUTED: missing AIT_CORPUS_DIRS; built-in fixture still runs");
}, TIMEOUT);

afterAll(() => {
  for (const directory of [...deliveries, ...(suiteDir === undefined ? [] : [suiteDir])]) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !/^ait-(system-contracts|codegen)-/.test(path.basename(resolved))) {
      throw new Error(`Refusing to remove a directory not owned by this suite: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});
describe("installed public contracts", () => {
  it("exports only public functions, imports without IO, preserves the caller, and exposes usable types", async () => {
    const probe = path.join(consumer, "import-probe.mjs");
    write(probe, IMPORT_PROBE);
    const before = snapshot(consumer, true);
    const result = await run(process.execPath, [probe], consumer);
    expect(result.status, result.stderr).toBe(0);
    const data = oneJson(result);
    expect(data).toMatchObject({ exports: PUBLIC_FUNCTIONS, functions: true, alive: true });
    expect(data.first).toEqual(data.second);
    expect(result.stderr).toBe("");
    expect(data.first).toMatchObject({ ok: true, data: { version: "unversioned" } });
    noAdvice(data);
    expectSame(before, snapshot(consumer, true));
    const types = path.join(consumer, "public-types.mts");
    write(types, TYPES_PROBE);
    const checked = await run(process.execPath, [path.join(REPO, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--typeRoots", path.join(REPO, "node_modules", "@types"), types], consumer);
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  }, TIMEOUT);

  it("matches deterministic bin/dispatch semantics and returns stable API error envelopes", async () => {
    const cwd = cloneFixture();
    const before = managed(cwd);
    for (const argv of [["--version"], ["version", "status", "v1.0"], ["specgraph", "query", "[PRD]-legacy"], ["specgraph", "validate-new-model"]]) {
      expect(await command(cwd, argv, "bin")).toEqual(await command(cwd, argv));
    }
    expect(await coreOk(cwd, "session.get")).toMatchObject({ project_root: cwd, active_version: null, phase: null, baseline_empty: false });
    for (const entry of ["dispatch", "bin"] as const) await rejectWithoutWrites(cwd, ["unknown-command"], "USAGE_ERROR", entry);
    expect(await coreCall(cwd, "generation.registerReceipt", { generationToken: "invalid" })).toMatchObject({ ok: false, code: "GENERATION_TOKEN_INVALID" });
    expect(await coreCall(cwd, "generation.registerReceipt", { generationToken: `gen-v1.00000000-0000-0000-0000-000000000000.${"0".repeat(64)}` })).toMatchObject({ ok: false, code: "GENERATION_TOKEN_STALE" });
    expectSame(before, managed(cwd));
  }, TIMEOUT);

  it("validates each delivery's own pointer and token without orchestration advice", async () => {
    const feature = await prepare(cloneFixture());
    const first = await deliver(feature);
    generate(feature.cwd, first);
    await receipt(feature.cwd, first);
    const second = await deliver(feature, "bin");
    expect({ version: first.version, target: first.target_file, tdd: first.tdd_root, source: first.source_file })
      .toEqual({ version: second.version, target: second.target_file, tdd: second.tdd_root, source: second.source_file });
    expect(second.generation_token).not.toBe(first.generation_token);
    expect(second.bundle_path).not.toBe(first.bundle_path);
    const before = managed(feature.cwd);
    expect(await coreCall(feature.cwd, "generation.registerReceipt", { generationToken: first.generation_token })).toMatchObject({ ok: false, code: "GENERATION_TOKEN_STALE" });
    // Preserve the domain's malformed-delivery negative case without a public issue-token export.
    expect(() => issueGenerationToken(resolveProjectRoot(feature.cwd), { version: second.version, tdd_root: second.tdd_root,
      target_file: second.target_file, bundle_path: second.bundle_path, bundle_sha256: second.sha256, bytes: second.bytes + 1 }))
      .toThrowError(expect.objectContaining({ code: "GENERATION_TOKEN_INVALID" }));
    expectSame(before, managed(feature.cwd));
    generate(feature.cwd, second);
    const registered = await receipt(feature.cwd, second);
    expect(await receipt(feature.cwd, second)).toEqual(registered);
    expect(await coreOk(feature.cwd, "generation.verifyReceipts", { version: feature.version })).toMatchObject({ enforcement: "report", passed: true, findings: [] });
  }, TIMEOUT);

  it("completes the installed Node-only workflow with memory delivery and responsive acceptance workers", async () => {
    const cwd = cloneFixture();
    const history = new Map([...managed(cwd)].filter(([file]) => file.includes("v1.0") || file.startsWith(".meta/changes/")));
    const script = path.join(consumer, "node-only-flow.mjs");
    write(script, NODE_ONLY_FLOW);
    const result = await run(process.execPath, [script], cwd);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(oneJson(result)).toMatchObject({ completed: true, version: "v2.0", target: "node-only-output.cjs" });
    expectPreserved(history, managed(cwd));
  }, TIMEOUT);

  it("completes the installed CLI-only workflow through file delivery, receipt, verification, and merge", async () => {
    const cwd = cloneFixture();
    const history = new Map([...managed(cwd)].filter(([file]) => file.includes("v1.0") || file.startsWith(".meta/changes/")));
    await refreshInstalledWrapper(cwd);
    const feature = await prepare(cwd, "wrapper");
    policy(cwd, "block");
    const delivery = await deliver(feature, "wrapper");
    generate(cwd, delivery);
    await receipt(cwd, delivery, "wrapper");
    expect(await ok(cwd, ["codegen", "verify", "--version", feature.version], "wrapper"))
      .toMatchObject({ enforcement: "block", passed: true, findings: [] });
    await acceptance(cwd, "wrapper");
    expectAccepted(cwd, await ok(cwd, ["version", "confirm", feature.version], "wrapper"));
    expect(await ok(cwd, ["version", "merge", feature.version], "wrapper"))
      .toMatchObject({ version: feature.version, merged_chunks: expect.arrayContaining([TDD]) });
    expectPreserved(history, managed(cwd));
  }, TIMEOUT);

  it("returns identical complete memory and file contexts and invalidates the previous carrier's token", async () => {
    const feature = await prepare(cloneFixture());
    const memory = await coreOk(feature.cwd, "delivery.prepare", { tddRootId: TDD });
    expect(memory).not.toHaveProperty("bundle_path");
    expect(memory.target_state).toBe("absent");
    expect(memory.content).toContain(tddContent().trim());
    const pointer = await deliver(feature, "bin");
    const bytes = fs.readFileSync(pointer.bundle_path);
    expect(Buffer.from(memory.content, "utf8").equals(bytes)).toBe(true);
    for (const field of ["sha256", "bytes", "version", "target_file", "tdd_root", "source_file"] as const) {
      expect(memory[field]).toEqual(pointer[field]);
    }
    const before = managed(feature.cwd);
    expect(await coreCall(feature.cwd, "generation.registerReceipt", { generationToken: memory.generation_token }))
      .toMatchObject({ ok: false, code: "GENERATION_TOKEN_STALE" });
    expectSame(before, managed(feature.cwd));
    generate(feature.cwd, pointer);
    await receipt(feature.cwd, pointer, "bin");
    expect(await coreOk(feature.cwd, "generation.verifyReceipts", { version: feature.version })).toMatchObject({ passed: true, findings: [] });
  }, TIMEOUT);

  it("shares graph direction, relationship, and version selection across installed entry points without writes", async () => {
    const feature = await prepare(cloneFixture());
    const { cwd, version } = feature;
    const graphFile = path.join(projectDocs(cwd), ".meta", "specgraph.yaml");
    const graph = yaml(graphFile);
    const target = "[FSD]-legacy:feature";
    const uri = (id: string): string => (graph.specs as Data[]).find((item) => item.chunk_id === id)!.uri as string;
    for (const [other, rel] of [["[TDD]-legacy", "details"], ["[FSD]-legacy-feature:implementation", "depends_on"], ["[PRD]-legacy", "historical_relation"]]) {
      graph.edges.push({ src: uri(target), dst: uri(other!), rel, weight: 1, metadata: {} });
    }
    write(graphFile, stringify(graph));
    const before = managed(cwd);
    const selections = [["derives"], ["decomposes"], ["details"], ["depends_on"], ["details", "depends_on"],
      ["derives", "decomposes", "details", "depends_on"]];
    for (const direction of ["in", "out", "both"]) {
      for (const rels of selections) {
        const input = { target, direction, rels, version: "baseline" };
        const expected = await coreOk(cwd, "graph.query", input);
        const actual = await ok(cwd, ["specgraph", "query", target, "--direction", direction,
          "--version", "baseline", ...rels.map((rel) => `--${rel.replace(/_/g, "-")}`)], "bin");
        expect(actual).toEqual(expected);
        expect(actual.direction).toBe(direction);
        expect((actual.edges as Data[]).every((edge) => rels.includes(edge.rel as string))).toBe(true);
        expect((actual.edges as Data[]).every((edge) => direction === "both" || edge[direction === "out" ? "src" : "dst"] === target)).toBe(true);
      }
    }
    const all = await coreOk(cwd, "graph.query", { target, version: "baseline" });
    expect(all.edges).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "historical_relation" })]));
    expect(await ok(cwd, ["specgraph", "query", target, "--version", "baseline"], "bin")).toEqual(all);
    expect((await coreOk(cwd, "graph.query", { target, rels: [], version: "baseline" })).edges).toEqual([]);
    expect(await coreOk(cwd, "graph.query", { target, rels: ["details", "details"], version: "baseline" }))
      .toEqual(await coreOk(cwd, "graph.query", { target, rels: ["details"], version: "baseline" }));
    const activeTarget = `${CHILD_FSD}:implementation`;
    const active = await coreOk(cwd, "graph.query", { target: activeTarget });
    expect(active.found).toBe(true);
    expect(active.edges).toEqual(expect.arrayContaining([expect.objectContaining({ rel: "details", dst: TDD })]));
    expect(await ok(cwd, ["deps", activeTarget], "bin")).toEqual(active);
    expect(await ok(cwd, ["specgraph", "query", activeTarget, "--version", version], "bin"))
      .toEqual(await coreOk(cwd, "graph.query", { target: activeTarget, version }));
    expect(await coreOk(cwd, "graph.query", { target: activeTarget, version: "baseline" })).toMatchObject({ found: false, edges: [] });
    expect(await coreOk(cwd, "graph.query", { target: "missing" })).toMatchObject({ found: false, edges: [] });
    for (const direction of ["from", "to"]) {
      expect(await coreCall(cwd, "graph.query", { target, direction })).toMatchObject({ ok: false, code: "USAGE_ERROR" });
      for (const prefix of [["deps"], ["specgraph", "query"]]) {
        await rejectWithoutWrites(cwd, [...prefix, target, "--direction", direction], "USAGE_ERROR", "bin");
      }
    }
    for (const flag of ["--deps", "--implements", "--unknown"]) {
      await rejectWithoutWrites(cwd, ["specgraph", "query", target, flag], "USAGE_ERROR", "bin");
    }
    await rejectWithoutWrites(cwd, ["specgraph", "query", target, "--version"], "USAGE_ERROR", "bin");
    await rejectWithoutWrites(cwd, ["specgraph", "query", target, "--version", "v9999.0"], "VERSION_NOT_FOUND", "bin");
    expect(await coreCall(cwd, "graph.query", { target, rels: ["implements"] })).toMatchObject({ ok: false, code: "USAGE_ERROR" });
    expectSame(before, managed(cwd));
  }, TIMEOUT);

  it("projects baseline summary items to JSON/YAML while exposing statistics through their own API", async () => {
    const cwd = cloneFixture();
    const before = managed(cwd);
    const all = await coreOk(cwd, "search.baselineSummary");
    expect(all.scope).toBe("all");
    expect(all.items).toHaveLength(7);
    const stats = await coreOk(cwd, "search.baselineStats");
    expect(stats).toMatchObject({ docs: { prd: 1, fsd: 2, tdd: 1 }, chunks: 7, versions: ["v1.0"] });
    expect(stats).not.toHaveProperty("items");
    for (const argv of [["baseline-summary"], ["baseline-summary", "--scope", "all"], ["baseline-summary", "--format", "yaml"]]) {
      const result = await run(process.execPath, [bin, ...argv], cwd);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      progressOnly(result.stderr);
      expect(parse(result.stdout)).toEqual(all.items);
    }
    for (const scope of ["prd", "fsd", "tdd"]) {
      const summary = await coreOk(cwd, "search.baselineSummary", { scope });
      expect(summary.scope).toBe(scope);
      expect((summary.items as Data[]).every((item) => String(item.id).startsWith(`[${scope.toUpperCase()}]-`))).toBe(true);
    }
    const prd = await coreOk(cwd, "search.baselineSummary", { scope: "prd" });
    expect(prd.items).toEqual([
      { id: "[PRD]-legacy", heading: "[PRD]-legacy", summary: null },
      { id: "[PRD]-legacy:behavior", heading: "[PRD]-legacy:behavior", summary: null },
    ]);
    expect((await command(cwd, ["baseline-summary", "--format", "json"], "bin")).data).toEqual(all.items);
    expect((await command(cwd, ["baseline-summary", "--scope", "prd", "--format", "json"], "bin")).data).toEqual(prd.items);
    const dispatched = await command(cwd, ["baseline-summary", "--scope", "prd", "--format", "json"]);
    expect(dispatched).toEqual({ ok: true, data: prd, presentation: { format: "json", projection: "baseline-items" } });
    expectSame(before, managed(cwd));
    for (const [operation, input] of [["search.baselineSummary", { format: "json" }], ["session.get", { cancel: true }],
      ["delivery.prepare", { tddRootId: TDD, signal: {} }], ["generation.registerReceipt", { generationToken: "invalid", artifact_sha256: "forged" }]] as const) {
      expect(await coreCall(cwd, operation, input)).toMatchObject({ ok: false, code: "USAGE_ERROR" });
      expectSame(before, managed(cwd));
    }
    const index = path.join(projectDocs(cwd), ".meta", "chunks-index.yaml");
    write(index, "chunks: [\n");
    const damaged = managed(cwd);
    expect(await coreCall(cwd, "search.baselineSummary")).toMatchObject({ ok: false, code: "INDEX_UNREADABLE" });
    await rejectWithoutWrites(cwd, ["baseline-summary"], "INDEX_UNREADABLE", "bin");
    expectSame(damaged, managed(cwd));
  }, TIMEOUT);
});

describe("cross-domain write and version gates", () => {
  it.each(["dispatch", "bin"] as const)("%s rejects malformed FSD declarations and unknown endpoints before writing", async (entry) => {
    const feature = await startFeature(cloneFixture());
    const id = `${feature.fsd}:system_contract`;
    const argv = ["fsd", "create", id];
    for (const [body, code] of [["derives: [", "FSD_DECLARATION_INVALID"], ["derives:\n  - '[PRD]-missing:requirement'", "MISSING_ENDPOINT"]]) {
      const context = await ok(feature.cwd, argv, entry);
      await rejectWithoutWrites(feature.cwd, [...argv, "--context-token", context.context_token,
        "--content", chunk(id, `\`\`\`yaml\n${body}\n\`\`\``)], code!, entry);
    }
    const secondRoot = ["fsd", "create", "[FSD]-second-root", "--parent", feature.prd];
    const context = await ok(feature.cwd, secondRoot, entry);
    await rejectWithoutWrites(feature.cwd, [...secondRoot, "--context-token", context.context_token,
      "--content", chunk("[FSD]-second-root", "非法第二根。")], "PRD_FSD_LINK_NOT_UNIQUE", entry);
  }, TIMEOUT);

  it("does not fall back to baseline or publish a pointer when an active TDD source disappears", async () => {
    const cwd = cloneFixture();
    const feature = await startFeature(cwd);
    await writeFeature(feature);
    await create(cwd, ["tdd", "create", "[TDD]-legacy", "--parent", "[FSD]-legacy-feature:implementation", "--action", "modify"],
      tddContent("[TDD]-legacy", "legacy.cjs"));
    await ok(cwd, ["tdd", "confirm"]);
    const delivered = await deliver(feature, "dispatch", "[TDD]-legacy");
    const originalBundle = fs.readFileSync(delivered.bundle_path);
    const source = path.join(projectDocs(cwd), "versions", feature.version, "tdd", "[TDD]-legacy.md");
    expect(fs.existsSync(path.join(projectDocs(cwd), "docs", "tdd", "[TDD]-legacy.md"))).toBe(true);
    fs.unlinkSync(source); // Deliberate host bypass, confined to this copied fixture.
    const metadata = fs.readFileSync(metaFile(cwd, feature.version));
    for (const entry of ["dispatch", "bin"] as const) {
      await rejectWithoutWrites(cwd, ["codegen", "prepare", "[TDD]-legacy"], "CODEGEN_SOURCE_MISSING", entry);
      expect(fs.readFileSync(metaFile(cwd, feature.version)).equals(metadata)).toBe(true);
      expect(fs.readFileSync(delivered.bundle_path).equals(originalBundle)).toBe(true);
    }
  }, TIMEOUT);

  it("keeps core confirmation gates effective when the host ignores a write-guard block", async () => {
    const feature = await prepare(cloneFixture());
    const source = path.join(projectDocs(feature.cwd), "versions", feature.version, "tdd", `${TDD}.md`);
    const beforeGuard = managed(feature.cwd);
    expect(await coreOk(feature.cwd, "guard.evaluate", {
      toolName: "write", input: { path: source },
    })).toMatchObject({ decision: "block" });
    expectSame(beforeGuard, managed(feature.cwd));
    fs.appendFileSync(source, "\n<!-- @ref:[PRD]-legacy -->\n");
    for (const entry of ["dispatch", "bin"] as const) {
      await rejectWithoutWrites(feature.cwd, ["version", "confirm", feature.version], "MARKDOWN_CONTAINS_RELATION", entry);
    }
  }, TIMEOUT);

  it("reports missing receipts by default, blocks when configured, and fails closed on damaged policy", async () => {
    const feature = await prepare(cloneFixture());
    write(path.join(feature.cwd, TARGET), `module.exports = { value: 42, source: '${TDD}' };\n`);
    const reported = await coreOk(feature.cwd, "generation.verifyReceipts", { version: feature.version });
    expect(reported).toMatchObject({ enforcement: "report", passed: true });
    expect(reported.findings).toEqual([expect.objectContaining({ code: "GENERATION_RECEIPT_MISSING", tdd_root: TDD, target_file: TARGET })]);
    const confirmed = await ok(feature.cwd, ["version", "confirm", feature.version]);
    expect(confirmed.generation_receipts).toEqual(reported);
    policy(feature.cwd, "block");
    expect(await coreOk(feature.cwd, "generation.verifyReceipts", { version: feature.version })).toMatchObject({ enforcement: "block", passed: false });
    for (const entry of ["dispatch", "bin"] as const) {
      await rejectWithoutWrites(feature.cwd, ["version", "confirm", feature.version], "GENERATION_RECEIPTS_FAILED", entry);
    }
    write(path.join(projectDocs(feature.cwd), ".meta", "config.local.yaml"), "generation_receipts: [\n");
    const before = managed(feature.cwd);
    expect(await coreCall(feature.cwd, "generation.verifyReceipts", { version: feature.version })).toMatchObject({ ok: false, code: "CONFIG_UNREADABLE" });
    await rejectWithoutWrites(feature.cwd, ["version", "confirm", feature.version], "CONFIG_UNREADABLE", "bin");
    expectSame(before, managed(feature.cwd));
  }, TIMEOUT);

  it.each(["artifact", "receipt", "policy"] as const)("rejects a confirmed merge plan after %s changes without modifying managed bytes", async (mutation) => {
    const feature = await prepare(cloneFixture());
    policy(feature.cwd, "block");
    const delivery = await deliver(feature);
    generate(feature.cwd, delivery);
    await receipt(feature.cwd, delivery);
    await acceptance(feature.cwd);
    const confirmed = await ok(feature.cwd, ["version", "confirm", feature.version], "bin");
    expect(confirmed).toMatchObject({ passed: true, acceptance: { ran: true, passed: true }, generation_receipts: { passed: true, findings: [] } });
    if (mutation === "artifact") fs.appendFileSync(path.join(feature.cwd, TARGET), "module.exports.value = 99;\n");
    else if (mutation === "receipt") await receipt(feature.cwd, await deliver(feature, "bin"));
    else policy(feature.cwd, "report");
    for (const entry of ["dispatch", "bin"] as const) {
      await rejectWithoutWrites(feature.cwd, ["version", "merge", feature.version], "CONFIRMATION_STALE", entry);
    }
  }, TIMEOUT);
});


async function governanceResult(feature: Feature, code: string, enforcement: string, details: Data = {},
  options: { deferWarningConfirmation?: boolean } = {}): Promise<void> {
  const before = managed(feature.cwd);
  const blocked = enforcement === "block";
  for (const argv of [["specgraph", "validate-new-model"], ["specgraph", "validate-new-model", "--version", feature.version]]) {
    const diagnostic = await ok(feature.cwd, argv, "wrapper");
    expect(diagnostic).toMatchObject({ passed: true, violations: [] });
    const finding = expect.objectContaining({ code, ...details });
    expect(diagnostic[blocked ? "policy_violations" : "warnings"]).toEqual(expect.arrayContaining([finding]));
    expect(diagnostic[blocked ? "warnings" : "policy_violations"]).not.toEqual(expect.arrayContaining([finding]));
    if (code === "TDD_TARGET_FILE_MISSING") expect(diagnostic.target_file_missing).toEqual(expect.arrayContaining([finding]));
    if (code === "DERIVES_RESIDUE") expect(diagnostic.derives_residue).toEqual(expect.arrayContaining([finding]));
    expectSame(before, managed(feature.cwd));
  }
  if (!blocked && options.deferWarningConfirmation === true) {
    console.info(`[system-contracts] ${code}: ${enforcement}; warning verified with zero managed writes; original acceptance will run after target restoration`);
    return;
  }
  const result = await command(feature.cwd, ["version", "confirm", feature.version], "wrapper");
  if (blocked) {
    expect(result).toMatchObject({ ok: false, code: "INVARIANT_VIOLATION" });
    expect(result.error).toContain(code);
    expectSame(before, managed(feature.cwd));
  } else {
    expect(result).toMatchObject({ ok: true, data: { passed: true } });
    expectAccepted(feature.cwd, result.data!);
  }
  console.info(`[system-contracts] ${code}: ${enforcement}; ${blocked ? "confirmation blocked with zero managed writes" : "warning reported; confirmation allowed"}`);
}
async function missingTargetGovernance(feature: Feature, target: string, enforcement: string): Promise<string | null> {
  const { cwd } = feature;
  const artifact = path.join(cwd, target);
  const held = path.join(caseDir(), "held-artifact");
  const targetBytes = fs.readFileSync(artifact);
  const restoreBeforeConfirmation = enforcement !== "block" && originalAcceptance.get(cwd) != null;
  fs.renameSync(artifact, held);
  try {
    await governanceResult(feature, "TDD_TARGET_FILE_MISSING", enforcement, { targetFile: target },
      { deferWarningConfirmation: restoreBeforeConfirmation });
  }
  finally { fs.renameSync(held, artifact); }
  expect(fs.readFileSync(artifact).equals(targetBytes)).toBe(true);
  if (restoreBeforeConfirmation) {
    const restored = managed(cwd);
    const diagnostic = await ok(cwd, ["specgraph", "validate-new-model", "--version", feature.version], "wrapper");
    expect(diagnostic.target_file_missing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TDD_TARGET_FILE_MISSING", targetFile: target }),
    ]));
    expectSame(restored, managed(cwd));
    expect(acceptanceCommand(cwd)).toBe(originalAcceptance.get(cwd));
    console.info(`[system-contracts] ${target} restored byte-for-byte with zero diagnostic writes; original acceptance continuation will be checked at the next normal TDD version confirmation`);
    return target;
  }
  return null;
}
async function realPythonGovernance(feature: Feature, originalFsd: string): Promise<string | null> {
  const { cwd } = feature;
  expect(yaml(metaFile(cwd, feature.version)).phase).toBe("fsd-confirm");
  const shared = path.join(projectDocs(cwd), ".meta", "config.yaml");
  const local = path.join(projectDocs(cwd), ".meta", "config.local.yaml");
  const config = effectiveConfig(cwd);
  const existence = config.target_file_existence?.enforcement ?? "warn";
  const derives = config.derives_residue?.enforcement ?? "warn";
  const scopes = Object.entries((config.artifact_scopes ?? {}) as Data);
  // Use the actual declaration, retaining its case; normalized graph keys are not filesystem paths.
  const target = corpusTargets(projectDocs(cwd)).find((file) => file !== TARGET && fs.existsSync(path.join(cwd, file)))!;
  expect(target).toBeTypeOf("string");
  const restoredTarget = await missingTargetGovernance(feature, target, existence);

  if (scopes.length === 0) console.info("[system-contracts] no configured artifact_scopes; scope and scope-exemption faults are not applicable");
  for (const [prefix, scope] of scopes) {
    const enforcement = scope.enforcement ?? "warn";
    const unowned = path.posix.join(prefix, "__ait_system_contract_unowned__.cjs");
    expect(fs.existsSync(path.join(cwd, unowned))).toBe(false);
    write(path.join(cwd, unowned), "module.exports = 1;\n");
    await git(cwd, ["--literal-pathspecs", "add", "--force", "--", unowned]);
    try { await governanceResult(feature, "UNCOVERED_ARTIFACT", enforcement, { targetFile: unowned }); }
    finally {
      await git(cwd, ["--literal-pathspecs", "rm", "--cached", "--", unowned]);
      fs.unlinkSync(path.join(cwd, unowned));
    }
    const policyFile = fs.existsSync(local) && yaml(local).artifact_scopes !== undefined ? local : shared;
    const policyBytes = fs.readFileSync(policyFile);
    // Removing an existing exemption strengthens the copied policy; restore its exact original bytes.
    for (const [field, code] of [["exempt_paths", "UNCOVERED_ARTIFACT"], ["exempt_test_splits", "TEST_SPLIT_UNCOVERED"]] as const) {
      const values = (scope[field] ?? []) as string[];
      if (values.length === 0) console.info(`[system-contracts] ${prefix} has no ${field}; only that exemption fault is not applicable`);
      for (const value of values) {
        const tightened = yaml(policyFile);
        tightened.artifact_scopes[prefix][field] = values.filter((item) => item !== value);
        write(policyFile, stringify(tightened));
        try {
          await governanceResult(feature, code, enforcement,
            field === "exempt_paths" ? { targetFile: value } : { chunkId: value });
        } finally { fs.writeFileSync(policyFile, policyBytes); }
      }
    }
  }

  const graph = await ok(cwd, ["specgraph", "export"], "wrapper");
  const requirementId = (graph.specs as Data[]).find((node) => node.type === "prd" && node.chunk_id.includes(":") && node.chunk_id !== feature.prd + ":system_contract")!.chunk_id as string;
  const implementation = CHILD_FSD + ":implementation";
  const reworkFsd = async (content: string): Promise<void> => {
    await ok(cwd, ["fsd", "revert"], "wrapper");
    await create(cwd, ["fsd", "create", implementation, "--action", "modify"], content, "wrapper");
    await ok(cwd, ["fsd", "confirm"], "wrapper");
  };
  await reworkFsd(originalFsd + "\nUnmapped requirement reference: " + requirementId + "\n");
  try { await governanceResult(feature, "DERIVES_RESIDUE", derives, { chunkId: implementation }); }
  finally { await reworkFsd(originalFsd); }

  const declaredFsdFiles = new Set((yaml(path.join(projectDocs(cwd), ".meta", `chunks-index-${feature.version}.yaml`)).chunks as Data[])
    .filter((entry) => String(entry.id).startsWith("[FSD]-"))
    .map((entry) => String(entry.file).replace(/\.md$/, "")));
  const exemptIds = scopes.flatMap(([, scope]) => (scope.exempt_test_splits ?? []) as string[]);
  const exempt = (yaml(path.join(projectDocs(cwd), ".meta", "chunks-index.yaml")).chunks as Data[])
    .find((entry) => String(entry.id).startsWith("[FSD]-") && String(entry.id).endsWith(":TEST") &&
      exemptIds.includes(entry.id as string) && !declaredFsdFiles.has(String(entry.file).replace(/\.md$/, "")));
  if (exempt === undefined) {
    console.info("[system-contracts] no configured exempt baseline TEST outside declared FSD files; only the acceptance-node exemption fault is not applicable");
    return restoredTarget;
  }
  const exemptId = exempt.id as string;
  const exemptFile = path.join(projectDocs(cwd), "docs", String(exempt.file).replace(/\.md$/, "") + ".md");
  const exemptBytes = fs.readFileSync(exemptFile);
  const content = exemptBytes.toString("utf8");
  const marker = "<!-- @id:" + exemptId + " -->";
  const start = content.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = content.indexOf("<!-- @id:", start + marker.length);
  const at = next < 0 ? content.length : next;
  write(exemptFile, content.slice(0, at) + "\nAcceptance-only reference: " + requirementId + "\n\n" + content.slice(at));
  try {
    const diagnostic = await ok(cwd, ["specgraph", "validate-new-model", "--version", feature.version], "wrapper");
    expect(diagnostic).toMatchObject({ policy_violations: [], warnings: [], target_file_missing: [], derives_residue: [] });
    expectAccepted(cwd, await ok(cwd, ["version", "confirm", feature.version], "wrapper"));
  } finally { fs.writeFileSync(exemptFile, exemptBytes); }
  console.info("[system-contracts] configured path/TEST exemptions verified and restored byte-for-byte");
  return restoredTarget;
}
function baselineHasNoVersionFields(cwd: string): void {
  const index = yaml(path.join(projectDocs(cwd), ".meta", "chunks-index.yaml"));
  expect(Object.keys(index).sort()).toEqual(["chunks", "scope", "updated", "version"]);
  for (const entry of index.chunks as Data[]) {
    expect(Object.keys(entry).sort()).toEqual(["file", "heading", "id", "level", "metadata", "summary"]);
  }
  const graph = yaml(path.join(projectDocs(cwd), ".meta", "specgraph.yaml"));
  for (const node of graph.specs as Data[]) {
    expect(node.version).toBe("baseline");
    expect(node.uri).toContain(":baseline:");
  }
}
async function secondIteration(first: Feature, history: Snapshot, real: boolean): Promise<void> {
  const { cwd, prd } = first;
  const stable = baseline(cwd);
  const check = (): void => { expectSame(stable, baseline(cwd)); expectPreserved(history, managed(cwd)); };
  const version = first.version.replace(/\.0$/, ".1");
  const feature: Feature = { ...first, version, entry: "wrapper" };
  await ok(cwd, ["version", "create", version], "wrapper"); check();
  await create(cwd, ["prd", "create", prd + ":system_contract", "--action", "modify"], requirement(prd + ":system_contract") + "\nSecond iteration.\n", "wrapper"); check();
  await ok(cwd, ["prd", "confirm"], "wrapper"); check();
  const fsdContent = fsdSplit(CHILD_FSD + ":implementation", prd + ":system_contract") + "\nSecond iteration.\n";
  await create(cwd, ["fsd", "create", CHILD_FSD + ":implementation", "--action", "modify"], fsdContent, "wrapper"); check();
  await ok(cwd, ["fsd", "confirm"], "wrapper"); check();
  const restoredTarget = await realPythonGovernance(feature, fsdContent); check();
  for (const note of ["Second iteration", "Reworked iteration"]) {
    await create(cwd, ["tdd", "create", TDD, "--parent", CHILD_FSD + ":implementation", "--action", "modify"], tddContent() + "\n" + note + ".\n", "wrapper"); check();
    await ok(cwd, ["tdd", "confirm"], "wrapper"); check();
    const pointer = await deliver(feature);
    generate(cwd, pointer);
    await receipt(cwd, pointer, "wrapper");
    await acceptance(cwd, "wrapper", { executeCommand: false });
    expectAccepted(cwd, await ok(cwd, ["version", "confirm", version], "wrapper")); check();
    if (note === "Second iteration" && restoredTarget !== null) {
      expect(fs.existsSync(path.join(cwd, restoredTarget))).toBe(true);
      console.info(`[system-contracts] ${restoredTarget}: next normal TDD version confirmation ran the unchanged original acceptance successfully after restoring the warned missing target`);
    }
    if (note === "Second iteration") {
      expect(await ok(cwd, ["tdd", "revert"], "wrapper")).toMatchObject({ reverted: [TDD], phase: "tdd-creating" }); check();
    }
  }
  expect(await ok(cwd, ["version", "revert", version, "--confirm"], "wrapper")).toMatchObject({ reverted: true, mode: "unmerged" }); check();
  expect(fs.existsSync(metaFile(cwd, version))).toBe(false);
  baselineHasNoVersionFields(cwd);
  for (const repo of [cwd, projectDocs(cwd)]) expect((await gitEvidence(repo, "after second iteration/rework/revert")).status).toBe("");
  console.info("[system-contracts] " + version + ": " + (real ? "real corpus" : "built-in fixture") + " baseline and merged history preserved byte-for-byte through opening, layer confirmation, version confirmation, TDD rework and cancellation");
}

async function historicalAnchors(cwd: string, merged: Data[]): Promise<HistoricalAnchor[]> {
  const ordered = [...merged].sort((left, right) => String(right.version).localeCompare(String(left.version), "en", { numeric: true }));
  const anchors: HistoricalAnchor[] = [];
  const hostRef = (meta: Data): string | null => (meta.revert_anchor?.code_result ?? meta.code_result ?? meta.code_base ?? null) as string | null;
  const candidates = [ordered, ordered.filter((meta) => hostRef(meta) === null)];
  for (const group of candidates) {
    for (const meta of group) {
      const reference = meta.revert_anchor?.docs_ref ?? `refs/tags/ait/${meta.version}`;
      const docs = await run("git", ["rev-parse", "--verify", `${reference}^{commit}`], projectDocs(cwd));
      if (docs.status !== 0) {
        console.info(`[system-contracts] ${meta.version}: historical rollback NOT VERIFIED; original docs anchor ${reference} is missing`);
        continue;
      }
      const host = hostRef(meta);
      if (host !== null) {
        const object = await run("git", ["cat-file", "-e", `${host}^{commit}`], cwd);
        expect(object.status, `Original host anchor is not available: ${meta.version} ${host}: ${object.stderr}`).toBe(0);
      }
      const anchored = await git(projectDocs(cwd), ["show", `${docs.stdout.trim()}:.meta/versions/${meta.version}.yaml`]);
      const anchoredMeta = parse(anchored) as Data;
      expect(anchoredMeta).toMatchObject({ version: meta.version });
      expect(anchoredMeta.merged_at != null || anchoredMeta.phase === "merged", `Original anchor is not merged: ${meta.version}`).toBe(true);
      if (!anchors.some((anchor) => anchor.version === meta.version)) anchors.push({ version: meta.version as string, docs: docs.stdout.trim(), host });
      break;
    }
  }
  expect(anchors.length, "No verifiable original merged-version anchor; refusing to fabricate rollback history").toBeGreaterThan(0);
  if (!anchors.some((anchor) => anchor.host === null)) {
    console.info("[system-contracts] this corpus has no verifiable host-unbound historical anchor; that case remains covered by the built-in Python-shaped fixture");
  }
  return anchors;
}
async function rollbackHistory(cwd: string, anchors: HistoricalAnchor[], history: Snapshot): Promise<void> {
  for (const anchor of anchors) {
    owned(cwd); owned(projectDocs(cwd));
    const hostBefore = await gitEvidence(cwd, "before original-history rollback host");
    const hostFiles: Snapshot = new Map();
    for (const file of hostBefore.tracked) {
      if (fs.existsSync(path.join(cwd, file))) hostFiles.set(file, fs.readFileSync(path.join(cwd, file)));
    }
    expect(await ok(cwd, ["version", "revert", anchor.version, "--confirm"], "wrapper")).toMatchObject({ reverted: true });
    const docs = await gitEvidence(projectDocs(cwd), `after rollback to original ${anchor.version} docs`);
    expect(docs.head).toBe(anchor.docs);
    expect(docs.status).toBe("");
    const host = await gitEvidence(cwd, `after rollback to original ${anchor.version} host`);
    if (anchor.host === null) {
      expect(host).toEqual(hostBefore);
      for (const [file, bytes] of hostFiles) expect(fs.readFileSync(path.join(cwd, file)).equals(bytes), `Host-unbound rollback changed ${file}`).toBe(true);
    } else {
      expect(host.head).toBe(anchor.host);
      expect(host.status).toBe("");
    }
    // A historical checkout may use core.autocrlf. Verify the original Git blobs
    // and clean checkout instead of treating legitimate CRLF conversion as a rewrite.
    const present = new Set(docs.tracked);
    const tree = new Map((await git(projectDocs(cwd), ["ls-tree", "-r", "-z", anchor.docs])).split("\0").filter(Boolean).map((entry) => {
      const match = /^\d+ \S+ ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)!;
      return [match[2]!, match[1]!];
    }));
    const index = new Map((await git(projectDocs(cwd), ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean).map((entry) => {
      const match = /^\d+ ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry)!;
      return [match[2]!, match[1]!];
    }));
    let checked = 0;
    let converted = 0;
    for (const [file, bytes] of history) {
      if (!present.has(file)) continue;
      expect(index.get(file), `Historical Git content changed: ${file}`).toBe(tree.get(file));
      if (!fs.readFileSync(path.join(projectDocs(cwd), file)).equals(bytes)) converted++;
      checked++;
    }
    expect(checked, "Rollback must verify actual original historical records").toBeGreaterThan(0);
    console.info(`[system-contracts] original ${anchor.version} restored: docs=${anchor.docs}; host=${anchor.host ?? "unbound, unchanged"}; ${checked} historical blobs verified; ${converted} checkout byte differences evaluated with Git filters and clean status`);
  }
}

async function takeover(sourceDocs: string, label: string, real = false): Promise<void> {
  const originalCwd = path.dirname(sourceDocs);
  const sourceBefore = managed(originalCwd);
  const sourceWrappers = snapshot(path.join(sourceDocs, ".ait"));
  const localFile = path.join(sourceDocs, ".meta", "config.local.yaml");
  const localConfig = fs.existsSync(localFile) ? yaml(localFile) : {};
  const pythonDirectory = typeof localConfig.skill_dir === "string" && fs.existsSync(localConfig.skill_dir) ? localConfig.skill_dir as string : null;
  const pythonBefore = pythonDirectory === null ? null : snapshot(pythonDirectory, true);
  const sourceGit = new Map<string, GitState>();
  for (const repository of [originalCwd, sourceDocs]) sourceGit.set(repository, await gitEvidence(repository, "source before takeover"));
  expect(sourceBefore.size, `Empty Python corpus: ${sourceDocs}`).toBeGreaterThan(0);
  try {
    const cwd = await cloneTakeover(sourceDocs);
    const copied = managed(cwd);
    expectSame(sourceBefore, copied);
    const metas = fs.readdirSync(path.join(projectDocs(cwd), ".meta", "versions")).filter((name) => name.endsWith(".yaml"))
      .map((name) => yaml(path.join(projectDocs(cwd), ".meta", "versions", name)));
    const merged = metas.filter((meta) => meta.merged_at != null || meta.phase === "merged");
    expect(merged.length, `${label}: merged Python history is required`).toBeGreaterThan(0);
    const historical = new Set<string>();
    for (const meta of merged) {
      historical.add(`.meta/versions/${meta.version}.yaml`);
      historical.add(`.meta/chunks-index-${meta.version}.yaml`);
      historical.add(`.meta/specgraph-${meta.version}.yaml`);
      for (const change of meta.changes ?? []) historical.add(`.meta/changes/${change}.yaml`);
    }
    const oldHistory = new Map([...copied].filter(([file]) => historical.has(file) || merged.some((meta) => file.startsWith(`versions/${meta.version}/`))));
    const originalBaseline = baseline(cwd);
    await refreshInstalledWrapper(cwd);
    const statusArgs = ["version", "status", merged.at(-1)!.version as string];
    expect(await command(cwd, statusArgs)).toEqual(await command(cwd, statusArgs, "wrapper"));
    expect(await command(cwd, ["specgraph", "export"])).toEqual(await command(cwd, ["specgraph", "export"], "wrapper"));
    const session = await coreOk(cwd, "session.get");
    expectSame(copied, managed(cwd));
    if (session.active_version !== null) {
      await ok(cwd, ["version", "revert", session.active_version as string, "--confirm"], "wrapper");
      console.info(`[system-contracts] cancelled copied active ${String(session.active_version)} through version revert; no claim of cross-implementation continuation of an active version`);
    }
    expectSame(originalBaseline, baseline(cwd));
    expectPreserved(oldHistory, managed(cwd));
    const anchors = await historicalAnchors(cwd, merged);
    await prepareAcceptance(cwd, originalCwd);
    expect(await ok(cwd, ["specgraph", "validate-new-model"], "wrapper"), `${label}: historical invariant violation`).toMatchObject({ passed: true, violations: [] });
    const feature = await prepare(cwd, "wrapper");
    policy(cwd, "block");
    const pointer = await deliver(feature);
    expect(fs.existsSync(path.join(cwd, TARGET))).toBe(false);
    generate(cwd, pointer);
    await receipt(cwd, pointer, "wrapper");
    await acceptance(cwd, "wrapper", { executeCommand: false });
    const confirmed = await ok(cwd, ["version", "confirm", feature.version], "wrapper");
    expectAccepted(cwd, confirmed);
    expect(confirmed).toMatchObject({ passed: true, generation_receipts: { enforcement: "block", passed: true, findings: [] } });
    expectSame(originalBaseline, baseline(cwd));
    const plan = yaml(metaFile(cwd, feature.version)).confirmed_plan as Data;
    const declaredFiles = new Set<string>((plan.operations as Data[]).map((operation) =>
      `docs/${String(operation.file).replace(/\.md$/, "")}.md`));
    const mergedResult = await ok(cwd, ["version", "merge", feature.version], "wrapper");
    expect(mergedResult.merged_chunks).toContain(TDD);
    expect(yaml(metaFile(cwd, feature.version))).toMatchObject({ phase: "merged" });
    expectPreserved(oldHistory, managed(cwd));
    const after = baseline(cwd);
    const changed = [...new Set([...originalBaseline.keys(), ...after.keys()])].filter((file) =>
      file.startsWith("docs/") && !originalBaseline.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)));
    expect(new Set(changed)).toEqual(declaredFiles);
    for (const [file, bytes] of originalBaseline) {
      if (!file.startsWith("docs/")) continue;
      if (declaredFiles.has(file)) expect(after.get(file)!.toString("utf8")).toContain(bytes.toString("utf8").trim());
      else expect(after.get(file)?.equals(bytes), file).toBe(true);
    }
    expect(fs.readFileSync(path.join(cwd, TARGET), "utf8")).toContain('"value":42');
    await acceptance(cwd, "wrapper", { executeCommand: false });
    baselineHasNoVersionFields(cwd);
    const mergedMeta = yaml(metaFile(cwd, feature.version));
    expect(mergedMeta.code_result).toBe((await gitEvidence(cwd, "after first merge host")).head);
    expect((await gitEvidence(projectDocs(cwd), "after first merge docs")).status).toBe("");
    expect((await git(projectDocs(cwd), ["rev-parse", mergedMeta.revert_anchor.docs_ref as string])).trim()).toBe((await git(projectDocs(cwd), ["rev-parse", "HEAD"])).trim());
    const firstHistory = new Map([...managed(cwd)].filter(([file]) => historical.has(file) ||
      merged.some((meta) => file.startsWith(`versions/${meta.version}/`)) ||
      file.startsWith(`versions/${feature.version}/`) ||
      [`.meta/versions/${feature.version}.yaml`, `.meta/chunks-index-${feature.version}.yaml`, `.meta/specgraph-${feature.version}.yaml`,
        ...(mergedMeta.changes as string[]).map((change) => `.meta/changes/${change}.yaml`)].includes(file)));
    await secondIteration(feature, firstHistory, real);
    expect(await coreOk(cwd, "session.get")).toMatchObject({ active_version: null, phase: null, baseline_empty: false });
    await rollbackHistory(cwd, anchors, oldHistory);
    const configuredAcceptance = originalAcceptance.get(cwd);
    if (configuredAcceptance !== null) expect(acceptanceCommand(cwd)).toBe(configuredAcceptance);
    console.info(`[system-contracts] ${label}: CLI takeover with public API read parity completed; ${merged.length} historical versions preserved; ${feature.version} merged; artifact ${TARGET} executed; original historical anchors restored; this is not manual takeover or LLM-quality evidence`);
  } finally {
    expectSame(sourceBefore, managed(originalCwd));
    expectSame(sourceWrappers, snapshot(path.join(sourceDocs, ".ait")));
    if (pythonDirectory !== null) expectSame(pythonBefore!, snapshot(pythonDirectory, true));
    const modules = path.join(originalCwd, "node_modules");
    const dependencies = sourceDependencies.get(modules);
    if (dependencies !== undefined) {
      regularTree(modules, true);
      expectSame(dependencies, snapshot(modules));
    }
    for (const source of [originalCwd, sourceDocs]) {
      for (const [file, bytes] of sourceArtifacts.get(source) ?? []) {
        expect(fs.readFileSync(path.join(source, file)).equals(bytes), `Source artifact changed: ${source}/${file}`).toBe(true);
      }
      expect(await gitEvidence(source, "source after takeover")).toEqual(sourceGit.get(source));
    }
  }
}

describe("Python-project takeover", () => {
  it("retains original acceptance with independent dependency bytes and restores a warned missing target before running it", async () => {
    const source = caseDir();
    pythonFixture(source);
    const configured = "node original-acceptance.cjs";
    write(path.join(projectDocs(source), ".meta", "config.local.yaml"), stringify({ acceptance_command: configured }));
    write(path.join(source, "package.json"), JSON.stringify({ private: true, dependencies: { "original-acceptance-dependency": "1.0.0" } }));
    const lock = '{"lockfileVersion":3,"packages":{}}\n';
    write(path.join(source, "package-lock.json"), lock);
    const dependency = path.join("node_modules", "original-acceptance-dependency", "index.cjs");
    write(path.join(source, dependency), "module.exports = 42;\n");
    write(path.join(source, "original-acceptance.cjs"),
      "const fs=require('node:fs');const a=require('node:assert/strict');a.equal(require('./legacy.cjs').value,42);" +
      "a.equal(require('./node_modules/original-acceptance-dependency/index.cjs'),42);fs.writeFileSync('original-acceptance-ran','passed');\n");
    const before = snapshot(source);
    const cwd = cloneDocs(projectDocs(source));
    for (const file of ["package.json", "package-lock.json", "original-acceptance.cjs"]) copyArtifact(source, cwd, file);
    originalAcceptance.set(cwd, configured);
    acceptanceProjects.add(path.resolve(cwd));
    await prepareAcceptance(cwd, source);
    await refreshInstalledWrapper(cwd);
    const feature = await startFeature(cwd, "wrapper");
    await writeFeature(feature);
    expect(fs.existsSync(path.join(cwd, "original-acceptance-ran"))).toBe(false);
    expect(await missingTargetGovernance(feature, "legacy.cjs", "warn")).toBe("legacy.cjs");
    expect(fs.existsSync(path.join(cwd, "original-acceptance-ran"))).toBe(false);
    await create(cwd, ["tdd", "create", TDD, "--parent", CHILD_FSD + ":implementation"], tddContent(), "wrapper");
    await ok(cwd, ["tdd", "confirm"], "wrapper");
    const pointer = await deliver(feature);
    generate(cwd, pointer);
    await receipt(cwd, pointer, "wrapper");
    await acceptance(cwd, "wrapper", { executeCommand: false });
    expectAccepted(cwd, await ok(cwd, ["version", "confirm", feature.version], "wrapper"));
    expect(fs.readFileSync(path.join(cwd, "original-acceptance-ran"), "utf8")).toBe("passed");
    expect(acceptanceCommand(cwd)).toBe(configured);
    expect(fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8")).toBe(lock);
    write(path.join(cwd, dependency), "module.exports = 0;\n");
    expect(await ok(cwd, ["acceptance", "run"], "wrapper")).toMatchObject({ ran: true, passed: false, exitCode: 1 });
    expectSame(before, snapshot(source));
  }, TIMEOUT);
  it("always continues a built-in Python-shaped merged project through actual generation and merge", async () => {
    await takeover(projectDocs(fixture), "built-in Python-shaped fixture (not evidence of real Python takeover)");
  }, TIMEOUT);
  if (CORPORA.length === 0) {
    it.skip("real Python takeover NOT EXECUTED: missing AIT_CORPUS_DIRS");
  } else {
    it.each(CORPORA)("continues the real Python corpus %s without rewriting its original or historical data", async (configured) => {
      const absolute = path.resolve(configured);
      const sourceDocs = path.basename(absolute) === ".meta" ? path.dirname(absolute)
        : fs.existsSync(path.join(absolute, "project-docs", ".meta")) ? path.join(absolute, "project-docs") : absolute;
      expect(path.basename(sourceDocs), "AIT_CORPUS_DIRS must identify project-docs, its .meta directory, or the project root").toBe("project-docs");
      expect(fs.statSync(path.join(sourceDocs, ".meta")).isDirectory()).toBe(true);
      await takeover(sourceDocs, `real Python corpus ${sourceDocs}`, true);
    }, TIMEOUT);
  }
});
