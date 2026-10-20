// [TDD]-dogfood_tests — 真实 tarball 安装、升级与完整生成周期验收。
// 固定宿主生成器仅验证交付/制品/回执机制，不证明 LLM 的语义质量。
// 受管写入只经安装后的 bin/公开接口；测试只直接写临时 fixture 与制品。

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreResult } from "../src/doc-model/schemas.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const BIN_JS = path.join(PROJECT_ROOT, "dist", "src", "bin.js");
const BUILD_HINT =
	`构建产物不存在：${BIN_JS}。请先执行 npm run build 再跑本测试。`;
const TARGET_FILE = "src/core.cjs";
const LONG_TIMEOUT = 240_000;
const PUBLIC_FUNCTIONS = [
	"dispatch", "evaluateWriteGuard", "getSessionContext", "issueGenerationToken",
	"registerGenerationReceipt", "verifyGenerationReceipts",
].sort();

let tmpDirs: string[] = [];

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-dogfood-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.reverse()) {
		// 只删除本例新建的项目/安装目录及其 codegen 调用返回的独立临时目录。
		const resolved = path.resolve(dir);
		if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
			!/^ait-(dogfood|codegen)-/.test(path.basename(resolved))) {
			throw new Error(`拒绝清理未归本例所有的目录：${resolved}`);
		}
		fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
	}
	tmpDirs = [];
});

interface BinRun {
	status: number;
	stdout: string;
	stderr: string;
}

function runNode(
	exe: string,
	args: string[],
	cwd: string,
	timeoutMs = 60_000,
): Promise<BinRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, args, { cwd, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`子进程超时（${timeoutMs}ms）：${exe} ${args.join(" ")}\n${stderr}`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		// close 在 stdout/stderr 排空后发生，避免只读到半段 JSON。
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ status: code ?? -1, stdout, stderr });
		});
	});
}

async function runNpm(args: string[], cwd: string): Promise<BinRun> {
	// Windows 不直接 spawn npm.cmd：由 Node 执行同一 npm CLI，参数始终走 argv。
	const cli = process.env.npm_execpath ??
		path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (fs.existsSync(cli) && /\.[cm]?js$/i.test(cli)) {
		return runNode(process.execPath, [cli, ...args], cwd, LONG_TIMEOUT);
	}
	if (process.platform === "win32") {
		throw new Error("无法定位 npm.cmd 对应的 npm-cli.js；请通过 npm test 运行安装验收。");
	}
	return runNode("npm", args, cwd, LONG_TIMEOUT);
}

interface PackageManifest {
	name: string;
	version: string;
	main: string;
	types: string;
	bin: { ait: string };
	scripts: { prepack: string };
}

interface PackResult {
	filename: string;
	version: string;
	files: { path: string }[];
}

interface Installation {
	consumer: string;
	packageRoot: string;
	bin: string;
	manifest: PackageManifest;
	pack: PackResult;
	tarball: string;
}

function assertBuild(): void {
	expect(fs.existsSync(BIN_JS), BUILD_HINT).toBe(true);
	expect(fs.statSync(BIN_JS).isFile(), BUILD_HINT).toBe(true);
	expect(fs.statSync(BIN_JS).size).toBeGreaterThan(0);
}

async function packPackage(source: string, destination: string, builtCopy = false): Promise<PackResult> {
	const args = ["pack", "--json", "--pack-destination", destination];
	// 升级 staging 只有分发文件，复用已构建的 tarball 内容，不要求它含源码/tsconfig。
	if (builtCopy) args.push("--ignore-scripts");
	const result = await runNpm(args, source);
	expect(result.status, `npm pack 失败：${result.stderr}\n${result.stdout}`).toBe(0);
	const packs = JSON.parse(result.stdout) as PackResult[];
	expect(packs).toHaveLength(1);
	const pack = packs[0]!;
	const files = pack.files.map((file) => file.path.replace(/\\/g, "/"));
	expect(files).toEqual(expect.arrayContaining([
		"package.json", "README.md", "dist/src/index.js", "dist/src/index.d.ts", "dist/src/bin.js",
	]));
	for (const file of files) {
		expect(file, `不应进入 tarball：${file}`).toMatch(/^(?:dist\/src\/|package\.json$|README\.md$)/);
		expect(file).not.toMatch(/(?:^|\/)(?:project-docs|tests|tmp|\.claude)(?:\/|$)|session.*\.txt$/i);
	}
	expect(fs.statSync(path.join(destination, pack.filename)).size).toBeGreaterThan(0);
	return pack;
}

async function installTarball(consumer: string, tarball: string, pack: PackResult): Promise<Installation> {
	expect(path.isAbsolute(tarball)).toBe(true);
	const result = await runNpm(["install", tarball, "--no-audit", "--no-fund"], consumer);
	expect(result.status,
		`真实 tarball 安装失败（含依赖下载等环境失败，不可 skip 或改用 link）：${result.stderr}\n${result.stdout}`,
	).toBe(0);
	const packageRoot = path.join(consumer, "node_modules", "ait-core");
	expect(fs.lstatSync(packageRoot).isSymbolicLink()).toBe(false);
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as PackageManifest;
	expect(manifest.name).toBe("ait-core");
	expect(manifest.version).toBe(pack.version);
	expect(manifest.scripts.prepack).toBe("npm run build");
	for (const entry of [manifest.main, manifest.types, manifest.bin.ait, "README.md"]) {
		const absolute = path.resolve(packageRoot, entry);
		expect(absolute.startsWith(packageRoot + path.sep)).toBe(true);
		expect(fs.statSync(absolute).isFile(), `安装包入口不存在：${entry}`).toBe(true);
		expect(fs.statSync(absolute).size).toBeGreaterThan(0);
	}
	return { consumer, packageRoot, manifest, pack, tarball, bin: path.resolve(packageRoot, manifest.bin.ait) };
}

async function makeInstallation(): Promise<Installation> {
	assertBuild();
	const tarballDir = mkTmp();
	const pack = await packPackage(PROJECT_ROOT, tarballDir);
	const consumer = mkTmp();
	fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
	return installTarball(consumer, path.join(tarballDir, pack.filename), pack);
}

function runBin(installation: Installation, cwd: string, argv: string[]): Promise<BinRun> {
	expect(installation.bin.startsWith(installation.packageRoot + path.sep)).toBe(true);
	return runNode(process.execPath, [installation.bin, ...argv], cwd);
}

/** 单 JSON、成功显式 next_action、失败保留原有三个字段。 */
function parseSingleJson(stdout: string): CoreResult {
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
	expect(lines).toHaveLength(1);
	const result = JSON.parse(lines[0]!) as CoreResult;
	if (result.ok) {
		expect(Object.hasOwn(result.data, "next_action")).toBe(true);
		if (result.data.next_action !== null) {
			expect(["present_and_collect", "report", "continue"]).toContain(result.data.next_action.type);
		}
	} else {
		expect(Object.keys(result).sort()).toEqual(["code", "error", "ok"]);
		expect(typeof result.error).toBe("string");
		expect(typeof result.code).toBe("string");
	}
	return result;
}

async function runOk(installation: Installation, cwd: string, argv: string[]): Promise<Record<string, unknown>> {
	const res = await runBin(installation, cwd, argv);
	expect(res.status, `argv=${argv.join(" ")}\n${res.stdout}\n${res.stderr}`).toBe(0);
	const result = parseSingleJson(res.stdout);
	if (!result.ok) throw new Error(`命令失败：${res.stdout}`);
	return result.data;
}

async function runError(installation: Installation, cwd: string, argv: string[], code = "USAGE_ERROR") {
	const res = await runBin(installation, cwd, argv);
	expect(res.status, `argv=${argv.join(" ")}\n${res.stdout}\n${res.stderr}`).toBe(1);
	const result = parseSingleJson(res.stdout);
	if (result.ok) throw new Error(`应失败的命令成功：${res.stdout}`);
	expect(result.code).toBe(code);
	return result;
}

function stringField(data: Record<string, unknown>, key: string): string {
	expect(typeof data[key], key).toBe("string");
	return data[key] as string;
}

/** 相对路径 → 原始字节，用于零落盘与安装升级不修改项目历史的断言。 */
function treeSnapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (cur: string): void => {
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			if (entry.isDirectory()) walk(abs);
			else out.set(path.relative(dir, abs), fs.readFileSync(abs).toString("base64"));
		}
	};
	walk(dir);
	return out;
}

const IMPORT_PROBE = String.raw`
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const modules = path.join(process.cwd(), "node_modules");
const cwd = process.cwd();
const restore = [];
function patch(object, name, replacement) {
  const original = object[name];
  if (typeof original !== "function") return;
  object[name] = replacement(original);
  restore.push(() => { object[name] = original; });
}
const forbidden = (name) => () => { throw new Error("import 时发生 IO：" + name); };
const reads = ["readFile", "readFileSync", "readdir", "readdirSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "existsSync", "realpath", "realpathSync", "readlink", "readlinkSync", "open", "openSync"];
for (const object of [fs, fsp]) {
  for (const name of reads) patch(object, name, (original) => function (...args) {
    const input = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
    const target = path.resolve(input);
    // Node 自身加载包文件必然读磁盘；项目/其它路径访问不属于模块加载。
    if (!target.startsWith(modules + path.sep)) throw new Error("import 访问项目：" + name + " " + target);
    if (name.startsWith("open") && args[1] !== undefined && !["r", "rs"].includes(args[1])) throw new Error("import 写入文件");
    return original.apply(object, args);
  });
  for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rm", "rmSync", "unlink", "unlinkSync", "rename", "renameSync", "copyFile", "copyFileSync", "createWriteStream", "createReadStream", "watch"])
    patch(object, name, () => forbidden(name));
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(childProcess, name, () => forbidden(name));
for (const [object, names] of [[net, ["connect", "createConnection"]], [http, ["request", "get"]], [https, ["request", "get"]]])
  for (const name of names) patch(object, name, () => forbidden(name));
patch(process.stdout, "write", () => forbidden("stdout"));
patch(process.stderr, "write", () => forbidden("stderr"));
syncBuiltinESMExports();
let api;
try { api = await import("ait-core"); }
finally { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); }
const first = await api.dispatch(["--version"]);
const second = await api.dispatch(["--version"]);
console.log(JSON.stringify({ names: Object.keys(api).sort(), functions: Object.values(api).every((value) => typeof value === "function"), first, second, alive: true, cwdUnchanged: process.cwd() === cwd }));
`;

async function assertPublicEntry(installation: Installation): Promise<void> {
	const probe = path.join(installation.consumer, "import-probe.mjs");
	fs.writeFileSync(probe, IMPORT_PROBE);
	const before = treeSnapshot(installation.consumer);
	const result = await runNode(process.execPath, [probe], installation.consumer);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stderr).toBe("");
	const lines = result.stdout.trim().split(/\r?\n/);
	expect(lines).toHaveLength(1);
	const report = JSON.parse(lines[0]!) as Record<string, unknown>;
	expect(report.names).toEqual(PUBLIC_FUNCTIONS);
	expect(report.functions).toBe(true);
	expect(report.alive).toBe(true);
	expect(report.cwdUnchanged).toBe(true);
	expect(report.first).toEqual(report.second);
	const bin = await runBin(installation, installation.consumer, ["--version"]);
	expect(bin.status).toBe(0);
	expect(parseSingleJson(bin.stdout)).toEqual(report.first);
	expect(treeSnapshot(installation.consumer)).toEqual(before);

	// 编译器仅充当开发工具；类型必须从 consumer 中安装的 .d.ts 解析。
	const types = path.join(installation.consumer, "public-types.mts");
	fs.writeFileSync(types, `
import { dispatch, getSessionContext, evaluateWriteGuard, issueGenerationToken, registerGenerationReceipt, verifyGenerationReceipts } from "ait-core";
import type { CoreResult, NextAction, ProjectRoot, SessionContext, LayerCounts, GuardInput, GuardDecision, GenerationDeliveryInput, GenerationReceipt, GenerationVerification } from "ait-core";
declare const root: ProjectRoot;
declare const input: GuardInput;
declare const delivery: GenerationDeliveryInput;
const result: Promise<CoreResult> = dispatch([]);
const session: SessionContext = getSessionContext(root);
const guard: GuardDecision = evaluateWriteGuard(input);
const token: string = issueGenerationToken(root, delivery);
const receipt: GenerationReceipt = registerGenerationReceipt(root, { generation_token: token });
const verification: GenerationVerification = verifyGenerationReceipts(root, "v0.1");
const counts: Record<string, LayerCounts> = {};
result.then(value => { if (value.ok) { const action: NextAction | null = value.data.next_action; void action; } });
void [session, guard, receipt, verification, counts];
`);
	const checked = await runNode(process.execPath, [
		path.join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc"),
		"--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
		"--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
		"--skipLibCheck", "--listFiles", types,
	], installation.consumer);
	expect(checked.status, checked.stdout + checked.stderr).toBe(0);
	const listed = checked.stdout.replace(/\\/g, "/");
	expect(listed).toContain(path.resolve(installation.packageRoot, installation.manifest.types).replace(/\\/g, "/"));
	expect(listed).not.toContain(path.join(PROJECT_ROOT, "src").replace(/\\/g, "/") + "/");
}

function prdContent(offset: number): string {
	return [
		"<!-- @id:[PRD]-demo -->", "# demo PRD", "", `本次偏移量：${offset}。`, "",
		"<!-- @id:[PRD]-demo:req1 -->", "## req1", "",
		"**用户故事:** 作为用户，我希望通过可执行制品计算偏移量，以便验证安装后生成周期。", "",
		"### 验收标准", "",
		`1. WHEN 输入数值 2 THEN 系统 SHALL 返回 ${2 + offset}。`,
		`2. WHEN 输入数值 -2 THEN 系统 SHALL 返回 ${-2 + offset}。`, "",
	].join("\n");
}

function fsdContent(offset: number): string {
	return [
		"<!-- @id:[FSD]-demo -->", "# demo 功能分解", "", `本次偏移量：${offset}。`, "",
		"<!-- @id:[FSD]-demo:core -->", "## core", "",
		"```yaml", 'derives: ["[PRD]-demo:req1"]', "```", "",
		"提供 addOffset(value)，按本次需求计算数值偏移。", "",
		"<!-- @id:[FSD]-demo:TEST -->", "## TEST", "",
		"执行生成制品内的数值断言；成功退出 0，错误预期退出 1。", "",
	].join("\n");
}

function tddContent(offset: number): string {
	return [
		"<!-- @id:[TDD]-core -->", "# core TDD", "",
		"```yaml", `target_file: ${TARGET_FILE}`, "```", "",
		`实现 addOffset(value)，返回 value + ${offset}。`,
		"使用 CommonJS JavaScript，导出 addOffset；直接执行时校验 2、-2、0 三个输入。",
		"可选 argv[2] 覆盖第一个断言的预期值；断言失败退出 1，成功静默退出 0。", "",
	].join("\n");
}

async function writeDocument(
	installation: Installation, project: string, layer: string, id: string,
	content: string, parent?: string,
): Promise<void> {
	const argv = [layer, "create", id, ...(parent === undefined ? [] : ["--parent", parent])];
	const before = treeSnapshot(project);
	const background = await runOk(installation, project, argv);
	expect(background.mode).toBe("discussion-context");
	expect(treeSnapshot(project)).toEqual(before);
	const contentFile = path.join(mkTmp(), "content.md");
	fs.writeFileSync(contentFile, content);
	const written = await runOk(installation, project, [
		...argv, "--content-file", contentFile,
		"--context-token", stringField(background, "context_token"),
	]);
	expect(written.mode).toBe("written");
}

/** 固定 TDD 的测试宿主生成器：完整读/校验 bundle 后只写指向的制品。 */
function generateArtifact(project: string, pointer: Record<string, unknown>, offset: number): string {
	const bundlePath = stringField(pointer, "bundle_path");
	expect(path.isAbsolute(bundlePath)).toBe(true);
	expect(bundlePath.startsWith(project + path.sep)).toBe(false);
	const bundleDir = path.dirname(bundlePath);
	expect(path.dirname(bundleDir)).toBe(fs.realpathSync(os.tmpdir()));
	expect(path.basename(bundleDir)).toMatch(/^ait-codegen-/);
	tmpDirs.push(bundleDir);
	const bytes = fs.readFileSync(bundlePath);
	expect(bytes.length).toBe(pointer.bytes);
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(pointer.sha256);
	const text = bytes.toString("utf8");
	expect(text).toContain(tddContent(offset).trim());
	expect(text).toContain("[FSD]-demo:core");
	expect(text).toContain("[PRD]-demo:req1");
	expect(pointer.target_file).toBe(TARGET_FILE);
	expect(pointer.tdd_root).toBe("[TDD]-core");
	const match = /实现 addOffset\(value\)，返回 value \+ (\d+)。/.exec(text);
	expect(match).not.toBeNull();
	const actualOffset = Number(match![1]);
	expect(actualOffset).toBe(offset);
	const target = path.resolve(project, stringField(pointer, "target_file"));
	expect(target.startsWith(project + path.sep)).toBe(true);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, [
		'"use strict";', 'const assert = require("node:assert/strict");',
		`function addOffset(value) { return value + ${actualOffset}; }`,
		"module.exports = { addOffset };", "if (require.main === module) {",
		`  assert.equal(addOffset(2), Number(process.argv[2] ?? ${2 + actualOffset}));`,
		`  assert.equal(addOffset(-2), ${-2 + actualOffset});`,
		`  assert.equal(addOffset(0), ${actualOffset});`, "}", "",
	].join("\n"));
	return target;
}

async function registerReceipt(installation: Installation, project: string, pointer: Record<string, unknown>) {
	const script = path.join(installation.consumer, "receipt.mjs");
	fs.writeFileSync(script, `
import path from "node:path";
import { registerGenerationReceipt, verifyGenerationReceipts } from "ait-core";
const [cwd, generation_token, version] = process.argv.slice(2);
const root = { cwd, root: path.join(cwd, "project-docs"), docs: path.join(cwd, "project-docs", "docs"), meta: path.join(cwd, "project-docs", ".meta") };
const receipt = registerGenerationReceipt(root, { generation_token });
console.log(JSON.stringify({ receipt, verification: verifyGenerationReceipts(root, version) }));
`);
	const result = await runNode(process.execPath, [
		script, project, stringField(pointer, "generation_token"), stringField(pointer, "version"),
	], installation.consumer);
	expect(result.status, result.stderr).toBe(0);
	const lines = result.stdout.trim().split(/\r?\n/);
	expect(lines).toHaveLength(1);
	const report = JSON.parse(lines[0]!) as {
		receipt: { version: string; tdd_root: string; target_file: string; artifact_sha256: string; bundle_sha256: string };
		verification: { passed: boolean; findings: unknown[] };
	};
	expect(report.receipt.version).toBe(pointer.version);
	expect(report.receipt.tdd_root).toBe(pointer.tdd_root);
	expect(report.receipt.target_file).toBe(pointer.target_file);
	expect(report.receipt.bundle_sha256).toBe(pointer.sha256);
	expect(report.receipt.artifact_sha256).toBe(createHash("sha256")
		.update(fs.readFileSync(path.join(project, TARGET_FILE))).digest("hex"));
	expect(report.verification.passed).toBe(true);
	expect(report.verification.findings).toEqual([]);
}

async function assertMerged(installation: Installation, project: string, version: string, offset: number) {
	const status = await runOk(installation, project, ["version", "status", version]);
	expect(status.phase).toBe("merged");
	expect(status.working).toEqual([]);
	expect(status.staged).toEqual([]);
	const validated = await runOk(installation, project, ["specgraph", "validate-new-model"]);
	expect(validated.passed).toBe(true);
	expect(validated.violations).toEqual([]);
	const docs = path.join(project, "project-docs", "docs");
	const prd = fs.readFileSync(path.join(docs, "prd", "[PRD]-demo.md"), "utf8");
	const fsd = fs.readFileSync(path.join(docs, "fsd", "[FSD]-demo.md"), "utf8");
	expect(prd).toContain(`本次偏移量：${offset}。`);
	expect(prd).toContain(`系统 SHALL 返回 ${2 + offset}。`);
	expect(fsd).toContain(`本次偏移量：${offset}。`);
	expect(fsd).not.toContain("derives:");
	expect(fs.readFileSync(path.join(docs, "tdd", "[TDD]-core.md"), "utf8"))
		.toContain(tddContent(offset).trim());
	const graph = await runOk(installation, project, ["specgraph", "export"]);
	const specs = graph.specs as { uri: string; chunk_id: string; file: string }[];
	const edges = graph.edges as { src: string; dst: string; rel: string }[];
	expect(specs.map((spec) => spec.chunk_id).sort()).toEqual([
		"[FSD]-demo", "[FSD]-demo:TEST", "[FSD]-demo:core", "[PRD]-demo", "[PRD]-demo:req1", "[TDD]-core",
	]);
	const byUri = new Map(specs.map((spec) => [spec.uri, spec.chunk_id]));
	const links = edges.map((edge) => ({ src: byUri.get(edge.src), dst: byUri.get(edge.dst), rel: edge.rel }));
	for (const link of links) {
		expect(link.src).toBeDefined();
		expect(link.dst).toBeDefined();
	}
	expect(links).toEqual(expect.arrayContaining([
		{ src: "[PRD]-demo", dst: "[FSD]-demo", rel: "derives" },
		{ src: "[PRD]-demo:req1", dst: "[FSD]-demo:core", rel: "derives" },
		{ src: "[FSD]-demo:core", dst: "[TDD]-core", rel: "details" },
	]));
	const targets: string[] = [];
	for (const tdd of specs.filter((spec) => spec.chunk_id.startsWith("[TDD]-"))) {
		const file = tdd.file.endsWith(".md") ? tdd.file : tdd.file + ".md";
		const content = fs.readFileSync(path.join(docs, file), "utf8");
		const target = /^target_file: (.+)$/m.exec(content)?.[1];
		expect(target).toBeDefined();
		targets.push(target!);
		expect(fs.statSync(path.join(project, target!)).isFile()).toBe(true);
		expect(links.filter((link) => link.rel === "details" && link.dst === tdd.chunk_id)).toHaveLength(1);
	}
	expect(targets).toEqual([TARGET_FILE]);
	expect(new Set(targets).size).toBe(targets.length);
	const artifact = await runNode(process.execPath, [path.join(project, TARGET_FILE), String(2 + offset)], project);
	expect(artifact.status, artifact.stderr).toBe(0);
	expect((await runOk(installation, project, ["--version"])).version).toBe(version);
}

async function runFullCycle(installation: Installation, project: string, version: string, offset: number) {
	await runOk(installation, project, ["version", "create", version]);
	await writeDocument(installation, project, "prd", "[PRD]-demo", prdContent(offset));
	await runOk(installation, project, ["prd", "confirm"]);
	await writeDocument(installation, project, "fsd", "[FSD]-demo", fsdContent(offset), "[PRD]-demo");
	await runOk(installation, project, ["fsd", "confirm"]);
	await writeDocument(installation, project, "tdd", "[TDD]-core", tddContent(offset), "[FSD]-demo:core");
	await runOk(installation, project, ["tdd", "confirm"]);
	// 未传 --version，必须选择当前活动版本，升级后的第二周期也不能回落基线。
	const pointer = await runOk(installation, project, ["codegen", "prepare", "[TDD]-core"]);
	expect(pointer.version).toBe(version);
	const target = generateArtifact(project, pointer, offset);
	const generated = await runNode(process.execPath, [target], project);
	expect(generated.status, generated.stderr).toBe(0);
	await registerReceipt(installation, project, pointer);

	await runOk(installation, project, ["acceptance", "set", "node src/core.cjs 999"]);
	const failed = await runOk(installation, project, ["acceptance", "run"]);
	expect(failed).toMatchObject({ ran: true, passed: false, exitCode: 1 });
	await runError(installation, project, ["version", "confirm", version], "ACCEPTANCE_FAILED");
	await runOk(installation, project, ["acceptance", "set", "node src/core.cjs"]);
	expect(await runOk(installation, project, ["acceptance", "run"]))
		.toMatchObject({ ran: true, passed: true, exitCode: 0 });
	await runOk(installation, project, ["version", "confirm", version]);
	await runOk(installation, project, ["version", "merge", version]);
	await assertMerged(installation, project, version, offset);
}

async function makeProjectWithVersion(installation: Installation): Promise<string> {
	const dir = mkTmp();
	await runOk(installation, dir, ["init", "--name", "demo"]);
	await runOk(installation, dir, ["version", "create", "v0.1"]);
	return dir;
}

async function prdTokenOf(installation: Installation, dir: string): Promise<string> {
	const bg = await runOk(installation, dir, ["prd", "create", "[PRD]-demo"]);
	expect(bg.mode).toBe("discussion-context");
	return stringField(bg, "context_token");
}

function prdWorkspaceFile(dir: string): string {
	return path.join(dir, "project-docs", "versions", "v0.1", "prd", "[PRD]-demo.md");
}

describe("安装后的完整自举", () => {
	it("缺 build 时明确失败并提示 npm run build", () => { assertBuild(); });

	it("真实 tarball 安装 → 生成/回执/验收/合入 → 隔离副本升级 → 下一完整周期", async () => {
		const sourcePackage = fs.readFileSync(path.join(PROJECT_ROOT, "package.json"));
		const sourceLock = fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"));
		const installed = await makeInstallation();
		await assertPublicEntry(installed);
		const project = mkTmp();
		await runOk(installed, project, ["init", "--name", "demo"]);
		await runFullCycle(installed, project, "v0.1", 1);
		const history = treeSnapshot(project);

		// 复制实际 tarball 已展开的分发文件，只在独立副本提高测试包版本。
		const staging = mkTmp();
		for (const file of installed.pack.files) {
			const destination = path.join(staging, file.path);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.copyFileSync(path.join(installed.packageRoot, file.path), destination);
		}
		const manifestFile = path.join(staging, "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as PackageManifest;
		const [major, minor, patch] = manifest.version.split(".");
		manifest.version = `${major}.${minor}.${Number(patch) + 1}-dogfood`;
		fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
		const upgradedTarballs = mkTmp();
		const nextPack = await packPackage(staging, upgradedTarballs, true);
		const upgraded = await installTarball(installed.consumer, path.join(upgradedTarballs, nextPack.filename), nextPack);
		expect(upgraded.manifest.version).toBe(manifest.version);
		expect(upgraded.manifest.version).not.toBe(installed.manifest.version);
		expect(upgraded.tarball).not.toBe(installed.tarball);
		await assertPublicEntry(upgraded);
		expect((await runOk(upgraded, project, ["--version"])).version).toBe("v0.1");
		expect(treeSnapshot(project)).toEqual(history);
		expect(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"))).toEqual(sourcePackage);
		expect(fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"))).toEqual(sourceLock);
		// 此相邻测试版本只验证安装替换机制，不冒充真实历史发布兼容性。
		await runFullCycle(upgraded, project, "v0.2", 2);
	}, 600_000);

	it("安装 bin 的单 JSON/退出码与未知命令、未知参数零落盘回归", async () => {
		const installation = await makeInstallation();
		const empty = mkTmp();
		expect((await runOk(installation, empty, ["--version"])).version).toBe("unversioned");
		const unknown = await runError(installation, empty, ["frobnicate"]);
		expect(unknown.error.length).toBeGreaterThan(0);
		expect(fs.readdirSync(empty)).toEqual([]);
		const dir = await makeProjectWithVersion(installation);
		const before = treeSnapshot(dir);
		const error = await runError(installation, dir, ["prd", "create", "[PRD]-x", "--nope"]);
		expect(error.error).toContain("--nope");
		for (const flag of ["--nope", "--bogus-flag"]) {
			const result = await runError(installation, dir, ["version", "create", "v9.9", flag]);
			expect(result.error).toContain(flag);
		}
		expect(treeSnapshot(dir)).toEqual(before);
	}, LONG_TIMEOUT);
});

describe("--content-file", () => {
	it("与 --content 等价：独立项目各取令牌，落盘字节相同", async () => {
		const installation = await makeInstallation();
		const dirA = await makeProjectWithVersion(installation);
		const dirB = await makeProjectWithVersion(installation);
		const tokenA = await prdTokenOf(installation, dirA);
		const tokenB = await prdTokenOf(installation, dirB);
		const content = prdContent(1);
		await runOk(installation, dirA, [
			"prd", "create", "[PRD]-demo", "--content", content, "--context-token", tokenA,
		]);
		const bodyFile = path.join(mkTmp(), "body.md");
		fs.writeFileSync(bodyFile, content, "utf8");
		await runOk(installation, dirB, [
			"prd", "create", "[PRD]-demo", "--content-file", bodyFile, "--context-token", tokenB,
		]);
		const a = fs.readFileSync(prdWorkspaceFile(dirA));
		const b = fs.readFileSync(prdWorkspaceFile(dirB));
		expect(a.length).toBeGreaterThan(0);
		expect(a.equals(b)).toBe(true);
	}, LONG_TIMEOUT);

	it("与 --content 同现报 USAGE_ERROR 且零落盘", async () => {
		const installation = await makeInstallation();
		const dir = await makeProjectWithVersion(installation);
		const bodyFile = path.join(mkTmp(), "body.md");
		fs.writeFileSync(bodyFile, prdContent(1), "utf8");
		const before = treeSnapshot(dir);
		const err = await runError(installation, dir, [
			"prd", "create", "[PRD]-demo", "--content", "hello", "--content-file", bodyFile,
		]);
		expect(err.error).toContain("--content-file");
		expect(treeSnapshot(dir)).toEqual(before);
	}, LONG_TIMEOUT);

	it("文件不可读报 USAGE_ERROR 且零落盘", async () => {
		const installation = await makeInstallation();
		const dir = await makeProjectWithVersion(installation);
		const before = treeSnapshot(dir);
		const err = await runError(installation, dir, [
			"prd", "create", "[PRD]-demo", "--content-file", path.join(dir, "does-not-exist.md"),
		]);
		expect(err.error).toContain("--content-file");
		expect(treeSnapshot(dir)).toEqual(before);
	}, LONG_TIMEOUT);
});