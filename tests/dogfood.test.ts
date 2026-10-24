// [TDD]-dogfood_tests — 真实 tarball 安装、升级与 CLI / Node 各自独立闭环验收。
// 固定宿主生成器仅验证交付/制品/回执机制，不证明 LLM 的语义质量。
// 受管写入只经安装后的公开入口；测试只直接写临时 fixture 与制品。

import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { CoreResult } from "../src/api/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const BUILD_HINT =
	"构建产物缺失、为空或陈旧。请先执行 npm run build 再跑本测试。";
const TARGET_FILE = "src/core.cjs";
const LONG_TIMEOUT = 240_000;
const PUBLIC_FUNCTIONS = ["createCoreApi", "dispatch"];

let tmpDirs: string[] = [];

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-dogfood-含空格 测试-"));
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
	options: { env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean } = {},
): Promise<BinRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, args, { cwd, windowsHide: true, ...options });
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
	scripts: { prepack: string; pretest: string };
	engines: { node: string };
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

function assertBuild(project = PROJECT_ROOT): void {
	const sourceRoot = path.join(project, "src");
	expect(fs.existsSync(sourceRoot), BUILD_HINT).toBe(true);
	const sources: string[] = [];
	const collect = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) collect(file);
			else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) sources.push(file);
		}
	};
	collect(sourceRoot);
	expect(sources.length, BUILD_HINT).toBeGreaterThan(0);
	for (const source of sources.sort()) {
		const modified = fs.statSync(source).mtimeMs;
		const relative = path.relative(sourceRoot, source).slice(0, -3);
		for (const extension of [".js", ".d.ts"]) {
			const artifact = path.join(project, "dist", "src", relative + extension);
			const diagnostic = `${BUILD_HINT}\n源码：${source}\n构建产物：${artifact}`;
			expect(fs.existsSync(artifact), diagnostic).toBe(true);
			const stat = fs.statSync(artifact);
			expect(stat.isFile(), diagnostic).toBe(true);
			expect(stat.size, diagnostic).toBeGreaterThan(0);
			expect(stat.mtimeMs, diagnostic).toBeGreaterThanOrEqual(modified);
		}
	}
}

async function packPackage(source: string, destination: string, builtCopy = false): Promise<PackResult> {
	// pretest 已构建全仓；测试中的 prepack 不能重写其它测试正在加载的共享 worker。
	// 升级 staging 仅复用此前通过校验的 tarball 分发文件，不含源码/tsconfig。
	if (!builtCopy) assertBuild(source);
	const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", destination];
	const result = await runNpm(args, source);
	expect(result.status, `npm pack 失败：${result.stderr}\n${result.stdout}`).toBe(0);
	const packs = JSON.parse(result.stdout) as PackResult[];
	expect(packs).toHaveLength(1);
	const pack = packs[0]!;
	const files = pack.files.map((file) => file.path.replace(/\\/g, "/"));
	expect(files).toEqual(expect.arrayContaining([
		"package.json", "README.md", "dist/src/index.js", "dist/src/index.d.ts", "dist/src/bin.js",
		"dist/src/api/worker.js", "dist/src/api/types.d.ts", "docs/node-api.md", "docs/cli.md",
	]));
	for (const file of files) {
		expect(file, `不应进入 tarball：${file}`).toMatch(/^(?:dist\/src\/|package\.json$|README\.md$|docs\/(?:node-api|cli)\.md$)/);
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
	expect(manifest.scripts.pretest).toBe("npm run build");
	expect(manifest.engines.node).toBe(">=22");
	for (const entry of [manifest.main, manifest.types, manifest.bin.ait, "README.md", "docs/node-api.md", "docs/cli.md"]) {
		const absolute = path.resolve(packageRoot, entry);
		expect(absolute.startsWith(packageRoot + path.sep)).toBe(true);
		expect(fs.statSync(absolute).isFile(), `安装包入口不存在：${entry}`).toBe(true);
		expect(fs.statSync(absolute).size).toBeGreaterThan(0);
	}
	const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
	for (const document of ["docs/node-api.md", "docs/cli.md"]) expect(readme).toContain(document);
	return { consumer, packageRoot, manifest, pack, tarball, bin: path.resolve(packageRoot, manifest.bin.ait) };
}

async function makeInstallation(): Promise<Installation> {
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

function runWrapper(installation: Installation, cwd: string, argv: string[]): Promise<BinRun> {
	const wrapper = path.join(cwd, "project-docs", ".ait",
		process.platform === "win32" ? "ait-cli.cmd" : "ait-cli");
	expect(fs.statSync(wrapper).isFile(), `项目 wrapper 不存在：${wrapper}`).toBe(true);
	const content = fs.readFileSync(wrapper, "utf8");
	expect(content).toContain(installation.bin);
	expect(content).toContain(process.execPath);
	if (process.platform !== "win32") return runNode(wrapper, argv, cwd);

	// cmd 的命令文本只含固定环境变量名；正文/路径不插入 shell 字符串。
	// 延迟展开避免调用 shell 提前解释参数，wrapper 自身仍负责原样转发。
	const env = { ...process.env };
	const parameters = [wrapper, ...argv].map((arg, index) => {
		expect(arg, "Windows wrapper fixture 参数不得含双引号或 NUL；正文可用 --content-file")
			.not.toMatch(/["\0]/);
		const name = `AIT_DOGFOOD_ARG_${index}`;
		env[name] = arg.replace(/(\\+)$/, "$1$1");
		return `"!${name}!"`;
	});
	return runNode(process.env.ComSpec ?? "cmd.exe", [
		"/d", "/s", "/v:on", "/c", `"${parameters.join(" ")}"`,
	], cwd, 60_000, { env, windowsVerbatimArguments: true });
}

/** 只允许业务事实；字段值为 null 也不是已移除。 */
function assertNoAdvice(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		expect(["next_action", "next_call", "required_next_call"]).not.toContain(key);
		assertNoAdvice(child);
	}
}

/** 单 JSON、无流程建议；失败保留原有三个字段。 */
function parseSingleJson(run: BinRun): CoreResult {
	const diagnostic = `exit=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
	const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
	expect(lines, diagnostic).toHaveLength(1);
	let result: CoreResult;
	try {
		result = JSON.parse(lines[0]!) as CoreResult;
	} catch {
		throw new Error(`入口未输出合法 JSON：${diagnostic}`);
	}
	assertNoAdvice(result);
	if (result.ok) {
		expect(Object.keys(result).sort()).toEqual(["data", "ok"]);
		expect(result.data).not.toBeNull();
		expect(typeof result.data).toBe("object");
	} else {
		expect(Object.keys(result).sort()).toEqual(["code", "error", "ok"]);
		expect(typeof result.error).toBe("string");
		expect(typeof result.code).toBe("string");
	}
	return result;
}

async function runOk(
	installation: Installation, cwd: string, argv: string[], entry: "wrapper" | "bin" = "wrapper",
): Promise<Record<string, unknown>> {
	const res = await (entry === "bin" ? runBin : runWrapper)(installation, cwd, argv);
	expect(res.status, `entry=${entry} argv=${JSON.stringify(argv)}\n${res.stdout}\n${res.stderr}`).toBe(0);
	const result = parseSingleJson(res);
	if (!result.ok) throw new Error(`命令失败：${res.stdout}`);
	return result.data;
}

async function runError(
	installation: Installation, cwd: string, argv: string[], code = "USAGE_ERROR",
	entry: "wrapper" | "bin" = "wrapper",
) {
	const res = await (entry === "bin" ? runBin : runWrapper)(installation, cwd, argv);
	expect(res.status, `entry=${entry} argv=${JSON.stringify(argv)}\n${res.stdout}\n${res.stderr}`).toBe(1);
	const result = parseSingleJson(res);
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
let api, core;
try { api = await import("ait-core"); core = api.createCoreApi(); }
finally { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); }
const first = await api.dispatch(["--version"]);
const second = await api.dispatch(["--version"]);
const named = await core.project.documentVersion();
let privateImport;
try { await import("ait-core/dist/src/api/core.js"); } catch (error) { privateImport = error.code; }
console.log(JSON.stringify({ names: Object.keys(api).sort(), functions: Object.values(api).every((value) => typeof value === "function"), first, second, named, privateImport, alive: true, cwdUnchanged: process.cwd() === cwd }));
`;

// 在真实 consumer 中编译；具名方法的 DTO、交付重载和旧接口移除均从安装包声明验证。
const PUBLIC_TYPES = String.raw`
import { createCoreApi, dispatch } from "ait-core";
import type * as T from "ait-core";
// @ts-expect-error 旧包根函数已移除
import { getSessionContext, evaluateWriteGuard, issueGenerationToken, registerGenerationReceipt, verifyGenerationReceipts } from "ait-core";
// @ts-expect-error 内部项目路径不再公开
import type { ProjectRoot } from "ait-core";
// @ts-expect-error 操作建议类型已移除
import type { NextAction } from "ait-core";
// @ts-expect-error 旧交付输入不再公开
import type { GenerationDeliveryInput } from "ait-core";
// @ts-expect-error 旧守卫内部输入不再公开
import type { GuardInput } from "ait-core";
// @ts-expect-error 分发文件也不能绕过包根 exports
import { executeOperation } from "ait-core/dist/src/api/operations.js";
const events: T.CoreProgressEvent[] = [];
const options: T.CoreApiOptions = { onProgress: event => events.push(event) };
const core: T.CoreApi = createCoreApi(options);
const version: T.VersionInput = { version: "v0.1" };
const optionalVersion: T.OptionalVersionInput = {};
const init: T.InitInput = { name: "demo", check: false, refreshWrapper: false };
const revert: T.VersionRevertInput = { ...version, confirm: true };
const prd: T.PrdInput = { id: "[PRD]-demo", content: "text", contextToken: "token", action: "add", file: "[PRD]-demo" };
const document: T.DocumentInput = { id: "[TDD]-core", parent: "[FSD]-demo:core", content: "text", skipContext: true, overrides: "[TDD]-old" };
const decompose: T.DecomposeInput = { parentSplit: "[FSD]-demo:core", childRootId: "[FSD]-child", content: "text" };
const delivery: T.DeliveryPrepareInput = { tddRootId: "[TDD]-core", output: Math.random() > .5 ? "file" : "memory" };
const graph: T.GraphQueryInput = { target: "[TDD]-core", direction: "in", rels: ["derives", "decomposes", "details", "depends_on"], version: "baseline" };
const impact: T.GraphImpactInput = { target: "[TDD]-core" };
const search: T.SearchInput = { query: "core", scope: "all", regexp: false };
const summary: T.BaselineSummaryInput = { scope: "prd" };
const save: T.StateSaveInput = { ...version, format: "json" };
const acceptance: T.AcceptanceSetInput = { command: "node src/core.cjs" };
const push: T.PushInput = { dryRun: true };
const receipt: T.GenerationReceiptInput = { generationToken: "token" };
const generation: T.GenerationStatusInput = { ...version, tddRootId: "[TDD]-core" };
const guard: T.GuardEvaluateInput = { toolName: "write", input: { path: "src/core.cjs" } };
const argv: Promise<T.CoreResult> = dispatch(["--version"]);
const presented: Promise<T.CliDispatchResult> = dispatch(["baseline-summary"], options);
const projectVersion: T.R<T.DocumentVersionResult> = core.project.documentVersion();
const initialized: T.R<T.InitResponse> = core.project.init(init);
const created: T.R<T.VersionCreateResult> = core.version.create(version);
const committed: T.R<T.VersionCommitResult> = core.version.commit(version);
const status: T.R<T.VersionStatus> = core.version.status(version);
const confirmed: T.R<T.VersionConfirmResult> = core.version.confirm(version);
const merged: T.R<T.VersionMergeResult> = core.version.merge(version);
const reverted: T.R<T.VersionRevertResult> = core.version.revert(revert);
const tags: T.R<T.BackfillTagsResult> = core.version.backfillTags();
const history: T.R<T.VersionListResult> = core.version.list();
const inspection: T.R<T.VersionInspection> = core.version.inspect(version);
const prdWritten: T.R<T.DocumentResult> = core.prd.create(prd);
const prdConfirmed: T.R<T.LayerConfirmResult> = core.prd.confirm();
const prdReverted: T.R<T.LayerRevertResult> = core.prd.revert();
const fsdWritten: T.R<T.DocumentResult> = core.fsd.create(document);
const fsdConfirmed: T.R<T.LayerConfirmResult> = core.fsd.confirm();
const fsdReverted: T.R<T.LayerRevertResult> = core.fsd.revert();
const decomposed: T.R<T.DecomposeResult> = core.fsd.decompose(decompose);
const tddWritten: T.R<T.DocumentResult> = core.tdd.create(document);
const tddConfirmed: T.R<T.LayerConfirmResult> = core.tdd.confirm();
const tddReverted: T.R<T.LayerRevertResult> = core.tdd.revert();
const memory: T.R<T.MemoryDelivery> = core.delivery.prepare({ tddRootId: "[TDD]-core" });
const explicitMemory: T.R<T.MemoryDelivery> = core.delivery.prepare({ tddRootId: "[TDD]-core", output: "memory" });
const file: T.R<T.DeliveryPointer> = core.delivery.prepare({ tddRootId: "[TDD]-core", output: "file" });
const either: T.R<T.MemoryDelivery | T.DeliveryPointer> = core.delivery.prepare(delivery);
const queried: T.R<T.DepsResult> = core.graph.query(graph);
const impacted: T.R<T.ImpactResult> = core.graph.impact(impact);
const synced: T.R<T.SpecGraph> = core.graph.sync();
const exported: T.R<T.SpecGraph> = core.graph.export(optionalVersion);
const validated: T.R<T.ValidationReport> = core.graph.validateNewModel();
const found: T.R<T.SearchResult> = core.search.query(search);
const summarized: T.R<T.BaselineSummary> = core.search.baselineSummary(summary);
const stats: T.R<T.BaselineStats> = core.search.baselineStats();
const panel: T.R<T.StatePanel> = core.state.get();
const markdown: T.R<T.MarkdownState> = core.state.render(optionalVersion);
const saved: T.R<T.StateSaveResult> = core.state.save(save);
const indexed: T.R<T.BaselineIndex> = core.index.rebuild();
const set: T.R<T.AcceptanceConfigResult> = core.acceptance.set(acceptance);
const shown: T.R<T.AcceptanceConfigResult> = core.acceptance.show();
const ran: T.R<T.AcceptanceResult> = core.acceptance.run();
const pushed: T.R<T.PushReport> = core.publish.push(push);
const session: T.R<T.SessionContext> = core.session.get();
const registered: T.R<T.GenerationReceipt> = core.generation.registerReceipt(receipt);
const verified: T.R<T.GenerationVerification> = core.generation.verifyReceipts(version);
const generationStatus: T.R<T.GenerationStatus> = core.generation.status(generation);
const policy: T.R<T.EffectiveGovernancePolicy> = core.governance.getPolicy();
const decision: T.ApiResult<T.GuardDecision> = core.guard.evaluate(guard);
void [core.project.init(), core.graph.export(), core.graph.validateNewModel(optionalVersion),
  core.search.baselineSummary(), core.state.get(optionalVersion), core.state.render(),
  core.state.save(), core.publish.push()];
type Groups = [T.ProjectApi, T.VersionApi, T.PrdApi, T.FsdApi, T.TddApi, T.DeliveryApi, T.GraphApi,
  T.SearchApi, T.StateApi, T.IndexApi, T.AcceptanceApi, T.PublishApi, T.SessionApi, T.GenerationApi, T.GovernanceApi, T.GuardApi];
type SupportingTypes = [T.CliPresentation, T.ProgressStage, T.ProgressStatus, T.Direction, T.LayerScope,
  T.SearchScope, T.StateFormat, T.GitAvailability, T.InitResult, T.ProjectCheckResult, T.VersionPhase,
  T.GovernanceFinding, T.DiscussionResult, T.DocumentWrittenResult, T.DecomposeWrittenResult,
  T.EdgeRef, T.SkipContextAudit, T.DeliveryMetadata, T.ViewEdge, T.Spec, T.StoredEdge, T.BaselineChunkEntry,
  T.Violation, T.SearchHit, T.BaselineSummaryItem, T.PushResult, T.LayerCounts, T.VersionSummary,
  T.GenerationItemStatus, T.BackfillSkip, T.BackfillSkipReason];
memory.then(result => { if (result.ok) {
  const content: string = result.data.content;
  const state: "loaded" | "absent" | "unreadable" = result.data.target_state;
  // @ts-expect-error 默认内存交付没有文件指针
  result.data.bundle_path;
  // @ts-expect-error 具名结果没有流程建议
  result.data.next_action;
  void [content, state];
} });
file.then(result => { if (result.ok) {
  const pointer: string = result.data.bundle_path;
  // @ts-expect-error 文件交付不展开正文
  result.data.content;
  void pointer;
} });
// @ts-expect-error guard 保持同步
const asyncGuard: T.R<T.GuardDecision> = core.guard.evaluate(guard);
// @ts-expect-error 不接受自定义项目目录
createCoreApi({ cwd: "/tmp/project" });
// @ts-expect-error 不支持取消
createCoreApi({ signal: new AbortController().signal });
// @ts-expect-error 方法输入也不支持取消
core.acceptance.run({ cancel: true });
// @ts-expect-error PRD 不接受 parent
core.prd.create({ id: "[PRD]-demo", parent: "parent" });
// @ts-expect-error decompose 不接受多余 id
core.fsd.decompose({ ...decompose, id: "extra" });
// @ts-expect-error 旧方向不保留别名
core.graph.query({ target: "id", direction: "from" });
// @ts-expect-error 非法关系不能成为公开类型
core.graph.query({ target: "id", rels: ["implements"] });
// @ts-expect-error all 仅属 CLI 输入
core.search.baselineSummary({ scope: "all" });
// @ts-expect-error format 仅属 CLI 展示
core.search.baselineSummary({ format: "yaml" });
// @ts-expect-error Node 令牌输入使用 camelCase
core.generation.registerReceipt({ generation_token: "token" });
// @ts-expect-error 不提供独立签发接口
core.generation.issueToken({});
// @ts-expect-error 不提供二次读取交付接口
core.delivery.read({});
// @ts-expect-error exactOptionalPropertyTypes 不接受显式 undefined
core.project.init({ name: undefined });
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
	expect(report.first).toEqual(report.named);
	expect(report.privateImport).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
	assertNoAdvice(report);
	const bin = await runBin(installation, installation.consumer, ["--version"]);
	expect(bin.status).toBe(0);
	expect(parseSingleJson(bin)).toEqual(report.first);
	expect(treeSnapshot(installation.consumer)).toEqual(before);

	// 编译器仅充当开发工具；类型必须从 consumer 中安装的 .d.ts 解析。
	const types = path.join(installation.consumer, "public-types.mts");
	fs.writeFileSync(types, PUBLIC_TYPES);
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
	expect(Object.hasOwn(pointer, "content")).toBe(false);
	expect(Object.hasOwn(pointer, "target_state")).toBe(false);
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

async function registerReceipt(
	installation: Installation, project: string, pointer: Record<string, unknown>, entry: "node" | "cli",
) {
	let report: { receipt: Record<string, unknown>; verification: Record<string, unknown> };
	if (entry === "cli") {
		const args = ["codegen", "receipt", "--generation-token", stringField(pointer, "generation_token")];
		const receipt = await runOk(installation, project, args);
		expect(await runOk(installation, project, args)).toEqual(receipt);
		report = { receipt, verification: await runOk(installation, project, [
			"codegen", "verify", "--version", stringField(pointer, "version"),
		]) };
	} else {
		const script = path.join(installation.consumer, "receipt.mjs");
		fs.writeFileSync(script, `
import { createCoreApi } from "ait-core";
const [generationToken, version] = process.argv.slice(2);
const core = createCoreApi();
const receipt = await core.generation.registerReceipt({ generationToken });
const verification = await core.generation.verifyReceipts({ version });
console.log(JSON.stringify({ receipt, verification }));
`);
		const result = await runNode(process.execPath, [
			script, stringField(pointer, "generation_token"), stringField(pointer, "version"),
		], project);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		const lines = result.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(1);
		const envelopes = JSON.parse(lines[0]!) as { receipt: CoreResult; verification: CoreResult };
		assertNoAdvice(envelopes);
		expect(envelopes.receipt.ok).toBe(true);
		expect(envelopes.verification.ok).toBe(true);
		if (!envelopes.receipt.ok || !envelopes.verification.ok) throw new Error(result.stdout);
		report = { receipt: envelopes.receipt.data, verification: envelopes.verification.data };
	}
	assertNoAdvice(report);
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

async function runFullCycle(
	installation: Installation, project: string, version: string, offset: number, receiptEntry: "node" | "cli" = "node",
) {
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
	await registerReceipt(installation, project, pointer, receiptEntry);

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

// 此脚本只 import 包根 createCoreApi。全流程在同一 Node 宿主内消费 memory，
// 不调用 dispatch、argv 适配或 AIT 子进程，也不把交付正文经 stdout 传回测试。
const NODE_CYCLE = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createCoreApi } from "ait-core";
const project = process.cwd();
const events = [];
const core = createCoreApi({ onProgress: event => {
  events.push(event);
  throw new Error("展示回调失败不应改变业务结果");
} });
function noAdvice(value) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["next_action", "next_call", "required_next_call"].includes(key), key);
    noAdvice(child);
  }
}
function value(result) {
  noAdvice(result);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ["data", "ok"]);
  return result.data;
}
function error(result, code) {
  noAdvice(result);
  assert.deepEqual(Object.keys(result).sort(), ["code", "error", "ok"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(typeof result.error, "string");
}
function snapshot(directory) {
  const files = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else files[path.relative(directory, target)] = fs.readFileSync(target).toString("base64");
    }
  };
  walk(directory);
  return files;
}
// 工厂必须惰性且绑定创建时目录；后续调用不能偷偷 chdir。
assert.deepEqual(fs.readdirSync(project), []);
process.chdir(fixture.unbound);
assert.equal(value(await core.project.init({ name: "demo" })).status, "fresh");
assert.deepEqual(fs.readdirSync(fixture.unbound), []);
assert.equal(process.cwd(), fixture.unbound);
const version = fixture.version;
const initial = snapshot(project);
const session = value(await core.session.get());
assert.equal(session.project_root, project);
assert.equal(session.active_version, null);
const initializedSummary = value(await core.search.baselineSummary());
assert.equal(initializedSummary.scope, "all");
assert.deepEqual(initializedSummary.items.map(({ id, heading }) => ({ id, heading }))
  .sort((left, right) => left.id.localeCompare(right.id)), [
  { id: "[FSD]-demo", heading: "demo 功能分解根" },
  { id: "[PRD]-demo", heading: "demo 产品 PRD" },
]);
assert.equal(session.baseline_empty, false);
assert.doesNotMatch(session.text, /next_action|next_call|required_next_call|下一步|codegen prepare/);
error(await core.state.get(), "NO_VERSION");
error(await core.acceptance.run({ cancel: true }), "USAGE_ERROR");
error(await core.graph.query({ target: "x", direction: "from" }), "USAGE_ERROR");
error(await core.graph.query({ target: "x", direction: "to" }), "USAGE_ERROR");
assert.deepEqual(snapshot(project), initial);
assert.equal(value(await core.guard.evaluate({ toolName: "write", input: { path: "src/core.cjs" } })).decision, "allow");
value(await core.version.create({ version }));
const beforeGate = snapshot(project);
error(await core.fsd.create({ id: "[FSD]-demo", parent: "[PRD]-demo" }), "PRD_NOT_CONFIRMED");
error(await core.prd.create({ id: "[PRD]-demo", content: fixture.prd }), "CONTEXT_TOKEN_INVALID");
assert.deepEqual(snapshot(project), beforeGate);
for (const layer of ["prd", "fsd", "tdd"]) {
  const intent = layer === "prd" ? { id: "[PRD]-demo" }
    : layer === "fsd" ? { id: "[FSD]-demo", parent: "[PRD]-demo" }
    : { id: "[TDD]-core", parent: "[FSD]-demo:core" };
  const before = snapshot(project);
  const discussion = value(await core[layer].create(intent));
  assert.equal(discussion.mode, "discussion-context");
  assert.deepEqual(snapshot(project), before);
  const written = value(await core[layer].create({ ...intent, content: fixture[layer], contextToken: discussion.context_token }));
  assert.equal(written.mode, "written");
  if (layer === "tdd") error(await core.delivery.prepare({ tddRootId: intent.id }), "TDD_NOT_CONFIRMED");
  value(await core[layer].confirm());
}
const temporaryFile = path.join(fixture.transferTemp, "not-a-directory");
fs.writeFileSync(temporaryFile, "memory delivery must not use this path");
const oldEnvironment = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map(key => [key, process.env[key]]));
let delivery;
try {
  for (const key of Object.keys(oldEnvironment)) process.env[key] = temporaryFile;
  delivery = value(await core.delivery.prepare({ tddRootId: "[TDD]-core" }));
} finally {
  for (const [key, oldValue] of Object.entries(oldEnvironment)) {
    if (oldValue === undefined) delete process.env[key]; else process.env[key] = oldValue;
  }
}
assert.deepEqual(fs.readdirSync(fixture.transferTemp), ["not-a-directory"]);
assert.equal(fs.readFileSync(temporaryFile, "utf8"), "memory delivery must not use this path");
assert.equal(Object.hasOwn(delivery, "bundle_path"), false);
assert.equal(delivery.target_state, "absent");
assert.equal(delivery.version, version);
assert.equal(delivery.target_file, fixture.target);
assert.equal(delivery.tdd_root, "[TDD]-core");
assert.equal(delivery.bytes, Buffer.byteLength(delivery.content, "utf8"));
assert.equal(delivery.sha256, createHash("sha256").update(delivery.content, "utf8").digest("hex"));
for (const text of [fixture.tdd.trim(), "[FSD]-demo:core", "[PRD]-demo:req1"])
  assert.ok(delivery.content.includes(text), text);
assert.doesNotMatch(delivery.content, /next_action|next_call|required_next_call/);
const offset = Number(/实现 addOffset\(value\)，返回 value \+ (\d+)。/.exec(delivery.content)?.[1]);
assert.equal(offset, fixture.offset);
const target = path.resolve(project, delivery.target_file);
assert.ok(target.startsWith(project + path.sep));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, [
  '"use strict";', 'const assert = require("node:assert/strict");',
  "function addOffset(value) { return value + " + offset + "; }",
  "module.exports = { addOffset };", "if (require.main === module) {",
  "assert.equal(addOffset(2), Number(process.argv[2] ?? " + (2 + offset) + "));",
  "assert.equal(addOffset(-2), " + (-2 + offset) + ");",
  "assert.equal(addOffset(0), " + offset + ");", "}", "",
].join("\n"));
const artifact = createRequire(import.meta.url)(target);
for (const input of [2, -2, 0]) assert.equal(artifact.addOffset(input), input + offset);
const receipt = value(await core.generation.registerReceipt({ generationToken: delivery.generation_token }));
assert.equal(receipt.bundle_sha256, delivery.sha256);
assert.equal(receipt.artifact_sha256, createHash("sha256").update(fs.readFileSync(target)).digest("hex"));
assert.deepEqual(value(await core.generation.registerReceipt({ generationToken: delivery.generation_token })), receipt);
const verification = value(await core.generation.verifyReceipts({ version }));
assert.equal(verification.passed, true);
assert.deepEqual(verification.findings, []);
value(await core.acceptance.set({ command: "node src/core.cjs 999" }));
assert.deepEqual(value(await core.acceptance.run()), { ran: true, passed: false, exitCode: 1 });
error(await core.version.confirm({ version }), "ACCEPTANCE_FAILED");
value(await core.acceptance.set({ command: "node src/core.cjs" }));
assert.deepEqual(value(await core.acceptance.run()), { ran: true, passed: true, exitCode: 0 });
assert.equal(value(await core.version.confirm({ version })).passed, true);
assert.equal(value(await core.version.inspect({ version })).confirmation.state, "valid");
value(await core.version.merge({ version }));
const mergedSnapshot = snapshot(project);
const status = value(await core.version.status({ version }));
assert.equal(status.phase, "merged");
assert.deepEqual(status.working, []);
assert.deepEqual(status.staged, []);
assert.equal(value(await core.version.inspect({ version })).confirmation.state, "not_applicable");
const history = value(await core.version.list()).versions;
assert.deepEqual(history.map(item => item.version), [version]);
assert.equal(history[0].merged, true);
assert.equal(value(await core.session.get()).active_version, null);
assert.equal(value(await core.session.get()).baseline_empty, false);
assert.equal(value(await core.state.get({ version })).merged, true);
assert.equal(value(await core.graph.validateNewModel()).passed, true);
const query = value(await core.graph.query({ target: "[FSD]-demo:core", direction: "out", rels: ["details"] }));
assert.equal(query.direction, "out");
assert.deepEqual(query.edges.map(({ src, dst, rel }) => ({ src, dst, rel })), [
  { src: "[FSD]-demo:core", dst: "[TDD]-core", rel: "details" },
]);
const summary = value(await core.search.baselineSummary());
assert.equal(summary.scope, "all");
assert.equal(summary.items.length, 6);
const prdSummary = value(await core.search.baselineSummary({ scope: "prd" }));
assert.deepEqual(prdSummary.items.map(item => item.id).sort(), ["[PRD]-demo", "[PRD]-demo:req1"]);
const stats = value(await core.search.baselineStats());
assert.deepEqual(stats.docs, { prd: 1, fsd: 1, tdd: 1 });
assert.equal(stats.chunks, 6);
assert.deepEqual(stats.versions, [version]);
assert.equal(Object.hasOwn(stats, "items"), false);
assert.equal(value(await core.project.documentVersion()).version, version);
assert.deepEqual(snapshot(project), mergedSnapshot);
assert.equal(process.cwd(), fixture.unbound);
assert.deepEqual(fs.readdirSync(fixture.unbound), []);
const deliveryEvents = events.filter(event => event.operation === "delivery.prepare");
assert.ok(deliveryEvents.some(event => event.stage === "assemble" && event.status === "completed"));
assert.ok(deliveryEvents.some(event => event.stage === "register_delivery" && event.status === "completed"));
assert.ok(deliveryEvents.every(event => event.stage !== "write_bundle"));
for (const event of events) {
  assert.equal(typeof event.operationId, "string");
  assert.ok(event.operationId.length > 0);
  assert.ok(["started", "completed", "failed"].includes(event.status));
}
console.log(JSON.stringify({ ok: true, data: { phase: status.phase, version, mode: "memory", target: delivery.target_file, summary, prdSummary, stats, query } }));
`;

async function makeProjectWithVersion(installation: Installation): Promise<string> {
	const dir = mkTmp();
	await runOk(installation, dir, ["init", "--name", "demo"], "bin");
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

describe("安装后的混合入口闭环（CLI + Node）", () => {
	it("缺 build 时明确失败并提示 npm run build", () => { assertBuild(); });

	it("真实 tarball 安装 → 项目 wrapper + Node 混合入口生成/回执/验收/合入 → 升级并刷新 wrapper → 下一混合入口闭环", async () => {
		const sourcePackage = fs.readFileSync(path.join(PROJECT_ROOT, "package.json"));
		const sourceLock = fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"));
		const installed = await makeInstallation();
		await assertPublicEntry(installed);
		const project = mkTmp();
		await runOk(installed, project, ["init", "--name", "demo"], "bin");
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
		const refreshed = await runOk(upgraded, project, ["init", "--refresh-wrapper"], "bin");
		expect(refreshed.createdFiles).toContain(
			`project-docs/.ait/ait-cli${process.platform === "win32" ? ".cmd" : ""}`,
		);
		expect((await runOk(upgraded, project, ["--version"])).version).toBe("v0.1");
		expect(treeSnapshot(project)).toEqual(history);
		expect(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"))).toEqual(sourcePackage);
		expect(fs.readFileSync(path.join(PROJECT_ROOT, "package-lock.json"))).toEqual(sourceLock);
		// 此相邻测试版本只验证安装替换机制，不冒充真实历史发布兼容性。
		await runFullCycle(upgraded, project, "v0.2", 2);
	}, 600_000);

	it("安装 bin 与项目 wrapper 的单 JSON/退出码和未知命令、未知参数零落盘回归", async () => {
		const installation = await makeInstallation();
		const empty = mkTmp();
		expect((await runOk(installation, empty, ["--version"], "bin")).version).toBe("unversioned");
		const unknown = await runError(installation, empty, ["frobnicate"], "USAGE_ERROR", "bin");
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

describe("正式安装后的独立入口闭环", () => {
	it("CLI-only：项目 wrapper 完成生成、回执、核验、失败验收门禁与合入，无 Node bridge", async () => {
		const installation = await makeInstallation();
		const project = mkTmp();
		await runOk(installation, project, ["init", "--name", "demo"], "bin");
		await runFullCycle(installation, project, "v0.1", 3, "cli");
		expect(fs.existsSync(path.join(installation.consumer, "receipt.mjs"))).toBe(false);
		const before = treeSnapshot(project);
		await runError(installation, project, ["codegen", "receipt"]);
		await runError(installation, project, ["codegen", "verify"]);
		await runError(installation, project, ["codegen", "receipt", "--generation-token", "invalid"], "GENERATION_TOKEN_INVALID");
		// verify 保留既有领域读取的 ENOENT；新版 generation.status 才统一 VERSION_NOT_FOUND。
		const missingVersion = "v9.9";
		const missing = await runError(installation, project, ["codegen", "verify", "--version", missingVersion], "ENOENT");
		expect(missing.error).toContain(missingVersion);
		expect(missing.error.replace(/\\/g, "/")).toContain(
			path.join(project, "project-docs", ".meta", "versions", `${missingVersion}.yaml`).replace(/\\/g, "/"),
		);
		expect(treeSnapshot(project)).toEqual(before);
		for (const direction of ["from", "to"]) {
			await runError(installation, project, ["deps", "[TDD]-core", "--direction", direction]);
			await runError(installation, project, ["specgraph", "query", "[TDD]-core", "--direction", direction]);
		}
		for (const flag of ["--deps", "--implements"]) {
			await runError(installation, project, ["specgraph", "query", "[TDD]-core", flag]);
		}
		expect(treeSnapshot(project)).toEqual(before);
	}, 600_000);

	it("Node-only：包根对象接口完成内存交付与合入；安装 CLI 图/摘要展示与 API 事实一致", async () => {
		const installation = await makeInstallation();
		const project = mkTmp();
		const script = path.join(installation.consumer, "node-cycle.mjs");
		const fixture = {
			version: "v0.1", target: TARGET_FILE, offset: 5,
			prd: prdContent(5), fsd: fsdContent(5), tdd: tddContent(5),
			unbound: mkTmp(), transferTemp: mkTmp(),
		};
		fs.writeFileSync(script, `const fixture = ${JSON.stringify(fixture)};\n${NODE_CYCLE}`);
		const run = await runNode(process.execPath, [script], project, LONG_TIMEOUT);
		expect(run.status, run.stdout + run.stderr).toBe(0);
		expect(run.stderr).toBe("");
		const result = parseSingleJson(run);
		if (!result.ok) throw new Error(run.stdout);
		expect(result.data).toMatchObject({ phase: "merged", version: "v0.1", mode: "memory", target: TARGET_FILE });
		// 独立 Node 闭环已结束；下面仅以只读 CLI 检查允许的展示投影。
		const before = treeSnapshot(project);
		const summary = result.data.summary as { scope: string; items: unknown[] };
		const prdSummary = result.data.prdSummary as { scope: string; items: unknown[] };
		for (const args of [[], ["--scope", "all"], ["--format", "yaml"]]) {
			const yaml = await runWrapper(installation, project, ["baseline-summary", ...args]);
			expect(yaml.status, yaml.stderr).toBe(0);
			expect(parseYaml(yaml.stdout)).toEqual(summary.items);
		}
		const prdYaml = await runWrapper(installation, project, ["baseline-summary", "--scope", "prd"]);
		expect(prdYaml.status, prdYaml.stderr).toBe(0);
		expect(parseYaml(prdYaml.stdout)).toEqual(prdSummary.items);
		for (const [scope, items] of [["all", summary.items], ["prd", prdSummary.items]] as const) {
			const json = await runWrapper(installation, project, ["baseline-summary", "--scope", scope, "--format", "json"]);
			expect(json.status, json.stderr).toBe(0);
			expect(parseSingleJson(json)).toEqual({ ok: true, data: items });
		}
		expect(await runOk(installation, project, [
			"specgraph", "query", "[FSD]-demo:core", "--details", "--direction", "out", "--version", "baseline",
		])).toEqual(result.data.query);
		await runError(installation, project, ["baseline-summary", "--scope", "fsd"]);
		expect(treeSnapshot(project)).toEqual(before);
	}, 600_000);
});

describe("--content-file", () => {
	it("已安装原生 Node bin 的 --content-file/--content 参数契约：独立令牌、落盘字节相同", async () => {
		const installation = await makeInstallation();
		const dirA = await makeProjectWithVersion(installation);
		const dirB = await makeProjectWithVersion(installation);
		const tokenA = await prdTokenOf(installation, dirA);
		const tokenB = await prdTokenOf(installation, dirB);
		// Windows 的 Python/Node .cmd 都会截断多行 --content；本例仅验证安装 bin 的参数契约。
		// 两侧正文显式走原生 Node bin；wrapper 完整闭环继续用 --content-file，不据此宣称多行内联成功。
		const content = prdContent(1);
		await runOk(installation, dirA, [
			"prd", "create", "[PRD]-demo", "--content", content, "--context-token", tokenA,
		], "bin");
		const bodyFile = path.join(mkTmp(), "body.md");
		fs.writeFileSync(bodyFile, content, "utf8");
		await runOk(installation, dirB, [
			"prd", "create", "[PRD]-demo", "--content-file", bodyFile, "--context-token", tokenB,
		], "bin");
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
