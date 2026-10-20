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

type Data = Record<string, any>;
type Entry = "dispatch" | "bin";
type Snapshot = Map<string, Buffer>;
interface Run { status: number; stdout: string; stderr: string }
interface Envelope { ok: boolean; data?: Data; code?: string; error?: string }
interface Delivery {
  bundle_path: string; sha256: string; bytes: number; version: string;
  target_file: string; tdd_root: string; source_file: string; generation_token: string;
  next_action: Data;
}
interface Feature { cwd: string; version: string; prd: string; fsd: string }
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 240_000;
const TARGET = "system-contract-output.cjs";
const TDD = "[TDD]-system-contract";
const CHILD_FSD = "[FSD]-system-contract";
const PUBLIC_FUNCTIONS = [
  "dispatch", "evaluateWriteGuard", "getSessionContext", "issueGenerationToken",
  "registerGenerationReceipt", "verifyGenerationReceipts",
].sort();
const CORPORA = (process.env.AIT_CORPUS_DIRS ?? "").split(";").map((item) => item.trim()).filter(Boolean);
let suiteDir: string;
let consumer: string;
let bin: string;
let apiRunner: string;
let fixture: string;
const deliveries = new Set<string>();

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
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
function cloneDocs(source: string): string {
  const cwd = caseDir();
  // Copy only managed data; no source git/worktree link or wrapper is executed.
  for (const name of ["docs", ".meta", "versions"]) {
    const directory = path.join(source, name);
    snapshot(directory); // Reject links before copying or invoking any command.
    if (fs.existsSync(directory)) fs.cpSync(directory, path.join(projectDocs(cwd), name), { recursive: true });
  }
  return cwd;
}
function cloneFixture(): string { return cloneDocs(projectDocs(fixture)); }
function run(executable: string, args: string[], cwd: string, timeout = TIMEOUT): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_NAME: "AIT contract tests", GIT_AUTHOR_EMAIL: "ait-tests@example.invalid",
        GIT_COMMITTER_NAME: "AIT contract tests", GIT_COMMITTER_EMAIL: "ait-tests@example.invalid" },
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
function oneJson(result: Run): Data {
  expect(result.stderr, result.stdout).toBe("");
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines, result.stdout).toHaveLength(1);
  return JSON.parse(lines[0]!) as Data;
}
function nextAction(action: unknown): void {
  if (action === null) return;
  expect(action).toBeTypeOf("object");
  const value = action as Data;
  if (value.type === "present_and_collect") {
    expect(Object.keys(value).sort()).toEqual(["instruction", "required_next_call", "type"]);
    expect(value.instruction).toBeTypeOf("string");
    expect(value.required_next_call).toContain("dispatch(");
  } else if (value.type === "continue") {
    expect(Object.keys(value).sort()).toEqual(["instruction", "next_call", "type"]);
    expect(value.instruction).toBeTypeOf("string");
    expect(value.next_call).toContain("registerGenerationReceipt");
  } else {
    expect(value.type).toBe("report");
    expect(Object.keys(value).sort()).toEqual(["message", "type"]);
    expect(value.message).toBeTypeOf("string");
  }
}
async function command(cwd: string, argv: string[], entry: Entry = "dispatch"): Promise<Envelope> {
  const result = entry === "bin"
    ? await run(process.execPath, [bin, ...argv], cwd)
    : await run(process.execPath, [apiRunner, "dispatch", JSON.stringify(argv)], cwd);
  const value = oneJson(result) as unknown as Envelope;
  expect(result.status, `${argv.join(" ")}\n${result.stdout}`).toBe(value.ok ? 0 : 1);
  if (value.ok) {
    expect(Object.keys(value).sort()).toEqual(["data", "ok"]);
    expect(value.data).toHaveProperty("next_action");
    nextAction(value.data!.next_action);
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
async function named(cwd: string, name: string, input: unknown = null): Promise<Data> {
  const result = await run(process.execPath, [apiRunner, name, JSON.stringify(input)], cwd);
  expect(result.status, result.stderr).toBe(0);
  return oneJson(result);
}
async function namedOk(cwd: string, name: string, input: unknown = null): Promise<any> {
  const result = await named(cwd, name, input);
  expect(result.thrown, `${name}: ${JSON.stringify(result)}`).toBeUndefined();
  expect(result).toHaveProperty("value");
  return result.value;
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
  expect(discussion.next_action.type).toBe("present_and_collect");
  expect(discussion.next_action.required_next_call).toContain(discussion.context_token);
  expectSame(before, managed(cwd));
  const written = await ok(cwd, [...argv, "--content", content, "--context-token", discussion.context_token], entry);
  expect(written.mode).toBe("written");
  expect(written.next_action).toBeNull();
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
async function startFeature(cwd: string): Promise<Feature> {
  const graph = await ok(cwd, ["specgraph", "export"]);
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
  const created = await ok(cwd, ["version", "create", version], "bin");
  expect(created.next_action.type).toBe("report");
  const feature = { cwd, version, prd: prd.chunk_id as string, fsd: fsd.chunk_id as string };
  await create(cwd, ["prd", "create", `${feature.prd}:system_contract`], requirement(`${feature.prd}:system_contract`));
  await ok(cwd, ["prd", "confirm"], "bin");
  return feature;
}
async function writeFeature(feature: Feature): Promise<void> {
  const { cwd, prd, fsd } = feature;
  await create(cwd, ["fsd", "create", `${fsd}:system_contract`], fsdSplit(`${fsd}:system_contract`, `${prd}:system_contract`), "bin");
  await create(cwd, ["fsd", "decompose", `${fsd}:system_contract`, CHILD_FSD],
    chunk(CHILD_FSD, "独立制品功能分区。") + "\n" + fsdSplit(`${CHILD_FSD}:implementation`, `${prd}:system_contract`));
  await ok(cwd, ["fsd", "confirm"], "bin");
}
async function prepare(cwd: string): Promise<Feature> {
  const feature = await startFeature(cwd);
  await writeFeature(feature);
  await create(cwd, ["tdd", "create", TDD, "--parent", `${CHILD_FSD}:implementation`], tddContent(), "bin");
  await ok(cwd, ["tdd", "confirm"]);
  return feature;
}
async function deliver(feature: Feature, entry: Entry = "dispatch", id = TDD): Promise<Delivery> {
  const pointer = await ok(feature.cwd, ["codegen", "prepare", id], entry) as unknown as Delivery;
  expect(pointer.version).toBe(feature.version);
  expect(pointer.tdd_root).toBe(id);
  expect(pointer.next_action.type).toBe("continue");
  expect(path.isAbsolute(pointer.bundle_path)).toBe(true);
  const relative = path.relative(feature.cwd, pointer.bundle_path);
  expect(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true);
  deliveries.add(path.dirname(pointer.bundle_path));
  const bytes = fs.readFileSync(pointer.bundle_path);
  expect(bytes.length).toBe(pointer.bytes);
  expect(hash(bytes)).toBe(pointer.sha256);
  expect(bytes.toString("utf8")).toContain(tddContent(id, pointer.target_file).trim());
  expect(pointer.generation_token).toMatch(/^gen-v1\./);
  expect(pointer.next_action.instruction).toContain(JSON.stringify(pointer.bundle_path));
  expect(pointer.next_action.next_call).toContain(pointer.generation_token);
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
async function receipt(cwd: string, delivery: Delivery): Promise<Data> {
  const value = await namedOk(cwd, "registerGenerationReceipt", { generation_token: delivery.generation_token }) as Data;
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
async function acceptance(cwd: string): Promise<void> {
  const script = `const a=require('node:assert/strict');const x=require('./${TARGET}');a.equal(x.value,42);a.equal(x.source,'${TDD}');`;
  await ok(cwd, ["acceptance", "set", `"${process.execPath}" -e "${script}"`], "bin");
  expect(await ok(cwd, ["acceptance", "run"])).toMatchObject({ ran: true, passed: true, exitCode: 0 });
}

function pythonFixture(cwd: string): void {
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

const API_RUNNER = String.raw`
import * as api from "ait-core";
import path from "node:path";
const [name, raw] = process.argv.slice(2);
const input = JSON.parse(raw);
const cwd = process.cwd();
const root = { cwd, root: path.join(cwd, "project-docs"), docs: path.join(cwd, "project-docs", "docs"), meta: path.join(cwd, "project-docs", ".meta") };
try {
  let result;
  if (name === "dispatch") {
    result = await api.dispatch(input);
    if (process.cwd() !== cwd) throw new Error("dispatch changed cwd");
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const value = name === "getSessionContext" ? api.getSessionContext(root)
      : name === "evaluateWriteGuard" ? api.evaluateWriteGuard(input)
      : name === "verifyGenerationReceipts" ? api.verifyGenerationReceipts(root, input)
      : name === "issueGenerationToken" ? api.issueGenerationToken(root, input)
      : name === "registerGenerationReceipt" ? api.registerGenerationReceipt(root, input)
      : (() => { throw new Error("Unknown test operation: " + name); })();
    result = { value: await value };
  }
  console.log(JSON.stringify(result));
} catch (error) { console.log(JSON.stringify({ thrown: true, code: error.code, message: error.message })); }
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
let api;
try { api = await import("ait-core"); }
finally { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); }
const first = await api.dispatch(["--version"]);
const second = await api.dispatch(["--version"]);
console.log(JSON.stringify({ exports: Object.keys(api).sort(), functions: Object.values(api).every((value) => typeof value === "function"), first, second, alive: true }));
`;

beforeAll(async () => {
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-system-contracts-"));
  consumer = path.join(suiteDir, "consumer");
  fs.mkdirSync(consumer);
  write(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  expect(fs.existsSync(path.join(REPO, "dist", "src", "index.js")), "Run npm run build before the installed contract suite").toBe(true);
  const packed = await npm(["pack", "--json", "--pack-destination", suiteDir], REPO);
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
  expect(manifest.version).toBe(packs[0]!.version);
  bin = path.resolve(packageRoot, manifest.bin.ait as string);
  expect(fs.statSync(bin).isFile()).toBe(true);
  expect(fs.existsSync(path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "ait.cmd" : "ait"))).toBe(true);
  apiRunner = path.join(consumer, "public-api.mjs");
  write(apiRunner, API_RUNNER);
  fixture = path.join(suiteDir, "python-shape-source");
  pythonFixture(fixture);
  console.info(`[system-contracts] installed ait-core ${manifest.version} from ${tarball}`);
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
    expect(data.first).toMatchObject({ ok: true, data: { next_action: null } });
    expectSame(before, snapshot(consumer, true));
    const types = path.join(consumer, "public-types.mts");
    write(types, `import { dispatch, getSessionContext, evaluateWriteGuard, issueGenerationToken, registerGenerationReceipt, verifyGenerationReceipts } from 'ait-core';\nimport type { CoreResult, NextAction, ProjectRoot, SessionContext, LayerCounts, GuardInput, GuardDecision, GenerationDeliveryInput, GenerationReceipt, GenerationVerification } from 'ait-core';\nconst actions: (NextAction | null)[] = [{ type: 'report', message: 'done' }, { type: 'present_and_collect', instruction: 'read', required_next_call: 'call' }, { type: 'continue', instruction: 'generate', next_call: 'receipt' }, null];\nconst result: Promise<CoreResult> = dispatch([]);\nconst session: (root: ProjectRoot) => SessionContext = getSessionContext;\nconst guard: (input: GuardInput) => GuardDecision = evaluateWriteGuard;\nconst token: (root: ProjectRoot, input: GenerationDeliveryInput) => string = issueGenerationToken;\nconst receipt: (root: ProjectRoot, input: { generation_token: string }) => GenerationReceipt = registerGenerationReceipt;\nconst verify: (root: ProjectRoot, version: string) => GenerationVerification = verifyGenerationReceipts;\nconst counts: LayerCounts = { working: 0, staged: 0, committed: 0 };\nvoid [actions, result, session, guard, token, receipt, verify, counts];\n`);
    const checked = await run(process.execPath, [path.join(REPO, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--typeRoots", path.join(REPO, "node_modules", "@types"), types], consumer);
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  }, TIMEOUT);

  it("matches deterministic bin/dispatch semantics and returns stable named-function errors", async () => {
    const cwd = cloneFixture();
    const before = managed(cwd);
    for (const argv of [["--version"], ["version", "status", "v1.0"], ["specgraph", "query", "[PRD]-legacy"], ["specgraph", "validate-new-model"]]) {
      expect(await command(cwd, argv, "bin")).toEqual(await command(cwd, argv));
    }
    expect(await namedOk(cwd, "getSessionContext")).toMatchObject({ project_root: cwd, active_version: null, phase: null, baseline_empty: false });
    for (const entry of ["dispatch", "bin"] as const) await rejectWithoutWrites(cwd, ["unknown-command"], "USAGE_ERROR", entry);
    expect(await named(cwd, "registerGenerationReceipt", { generation_token: "invalid" })).toMatchObject({ thrown: true, code: "GENERATION_TOKEN_INVALID" });
    expect(await named(cwd, "registerGenerationReceipt", { generation_token: `gen-v1.00000000-0000-0000-0000-000000000000.${"0".repeat(64)}` })).toMatchObject({ thrown: true, code: "GENERATION_TOKEN_STALE" });
    expectSame(before, managed(cwd));
  }, TIMEOUT);

  it("validates each delivery's own pointer and token and locks all three NextAction forms plus null", async () => {
    const feature = await prepare(cloneFixture());
    const first = await deliver(feature);
    generate(feature.cwd, first);
    await receipt(feature.cwd, first);
    const second = await deliver(feature, "bin");
    expect({ version: first.version, target: first.target_file, tdd: first.tdd_root, source: first.source_file, action: first.next_action.type })
      .toEqual({ version: second.version, target: second.target_file, tdd: second.tdd_root, source: second.source_file, action: second.next_action.type });
    expect(second.generation_token).not.toBe(first.generation_token);
    expect(second.bundle_path).not.toBe(first.bundle_path);
    const before = managed(feature.cwd);
    expect(await named(feature.cwd, "registerGenerationReceipt", { generation_token: first.generation_token })).toMatchObject({ thrown: true, code: "GENERATION_TOKEN_STALE" });
    expect(await named(feature.cwd, "issueGenerationToken", { version: second.version, tdd_root: second.tdd_root,
      target_file: second.target_file, bundle_path: second.bundle_path, bundle_sha256: second.sha256, bytes: second.bytes + 1 }))
      .toMatchObject({ thrown: true, code: "GENERATION_TOKEN_INVALID" });
    expectSame(before, managed(feature.cwd));
    generate(feature.cwd, second);
    const registered = await receipt(feature.cwd, second);
    expect(await receipt(feature.cwd, second)).toEqual(registered);
    expect(await namedOk(feature.cwd, "verifyGenerationReceipts", feature.version)).toMatchObject({ enforcement: "report", passed: true, findings: [] });
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
    expect(await namedOk(feature.cwd, "evaluateWriteGuard", {
      projectRoot: feature.cwd, cwd: feature.cwd, toolName: "write", input: { path: source },
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
    const reported = await namedOk(feature.cwd, "verifyGenerationReceipts", feature.version) as Data;
    expect(reported).toMatchObject({ enforcement: "report", passed: true });
    expect(reported.findings).toEqual([expect.objectContaining({ code: "GENERATION_RECEIPT_MISSING", tdd_root: TDD, target_file: TARGET })]);
    const confirmed = await ok(feature.cwd, ["version", "confirm", feature.version]);
    expect(confirmed.generation_receipts).toEqual(reported);
    policy(feature.cwd, "block");
    expect(await namedOk(feature.cwd, "verifyGenerationReceipts", feature.version)).toMatchObject({ enforcement: "block", passed: false });
    for (const entry of ["dispatch", "bin"] as const) {
      await rejectWithoutWrites(feature.cwd, ["version", "confirm", feature.version], "GENERATION_RECEIPTS_FAILED", entry);
    }
    write(path.join(projectDocs(feature.cwd), ".meta", "config.local.yaml"), "generation_receipts: [\n");
    const before = managed(feature.cwd);
    expect(await named(feature.cwd, "verifyGenerationReceipts", feature.version)).toMatchObject({ thrown: true, code: "CONFIG_UNREADABLE" });
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

async function takeover(sourceDocs: string, label: string): Promise<void> {
  const originalCwd = path.dirname(sourceDocs);
  const sourceBefore = managed(originalCwd);
  expect(sourceBefore.size, `Empty Python corpus: ${sourceDocs}`).toBeGreaterThan(0);
  try {
    const cwd = cloneDocs(sourceDocs);
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
    const statusArgs = ["version", "status", merged.at(-1)!.version as string];
    expect(await command(cwd, statusArgs)).toEqual(await command(cwd, statusArgs, "bin"));
    expect(await command(cwd, ["specgraph", "export"])).toEqual(await command(cwd, ["specgraph", "export"], "bin"));
    const session = await namedOk(cwd, "getSessionContext") as Data;
    expectSame(copied, managed(cwd));
    if (session.active_version !== null) {
      await ok(cwd, ["version", "revert", session.active_version as string, "--confirm"], "bin");
    }
    expectSame(originalBaseline, baseline(cwd));
    expectPreserved(oldHistory, managed(cwd));
    expect(await ok(cwd, ["specgraph", "validate-new-model"], "bin"), `${label}: historical invariant violation`).toMatchObject({ passed: true, violations: [] });
    const feature = await prepare(cwd);
    policy(cwd, "block");
    const pointer = await deliver(feature, "bin");
    expect(fs.existsSync(path.join(cwd, TARGET))).toBe(false);
    generate(cwd, pointer);
    await receipt(cwd, pointer);
    await acceptance(cwd);
    const confirmed = await ok(cwd, ["version", "confirm", feature.version]);
    expect(confirmed).toMatchObject({ passed: true, generation_receipts: { enforcement: "block", passed: true, findings: [] } });
    expectSame(originalBaseline, baseline(cwd));
    const plan = yaml(metaFile(cwd, feature.version)).confirmed_plan as Data;
    const declaredFiles = new Set<string>((plan.operations as Data[]).map((operation) =>
      `docs/${String(operation.file).replace(/\.md$/, "")}.md`));
    const mergedResult = await ok(cwd, ["version", "merge", feature.version], "bin");
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
    await acceptance(cwd);
    expect(await namedOk(cwd, "getSessionContext")).toMatchObject({ active_version: null, phase: null, baseline_empty: false });
    console.info(`[system-contracts] ${label}: takeover completed; ${merged.length} historical versions preserved; ${feature.version} merged; artifact ${TARGET} executed`);
  } finally {
    expectSame(sourceBefore, managed(originalCwd));
  }
}

describe("Python-project takeover", () => {
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
      await takeover(sourceDocs, `real Python corpus ${sourceDocs}`);
    }, TIMEOUT);
  }
});
