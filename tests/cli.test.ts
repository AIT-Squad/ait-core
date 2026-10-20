// [TDD]-cli_tests — cli 域制品的集成验收，覆盖 [FSD]-ait-core-cli:TEST 第 1~11 条：
// 1. 双入口一致（dispatch() 返回值 vs bin 子进程 stdout JSON deep-equal，单段输出）
// 2. USAGE_ERROR 矩阵（未知命令/缺参数/非法 flag 值/未知 flag/布尔 flag 带值，exit 1，不进业务逻辑）
// 3. 校验类语义（违规 {ok:true,data:{passed:false,violations}} 且 exit 0）
// 4. --version 三场景（数值序最大 / unversioned / unversioned，只读零副作用）
// 5. 错误包装（带 code 透传；无 code 包 INTERNAL_ERROR 保留原始 message）
// 6. 参数形态（--content-file 与 --content 等价/同现互斥/不可读；--overrides 透传；
//    未知参数指明参数名）
// 7. state（markdown 只含 phase 与三态/ID；json 字段与 counts；--save 只写 state.md；
//    无活动版本 NO_VERSION）
// 8. backfill-tags（缺标签补齐、已存在幂等、非 git 仓 git=unavailable）
// 9. search --regexp（正则命中、非法正则 USAGE_ERROR、未给 --regexp 按字面量）
// 10. init 参数（--check 优先且零写入 / --refresh-wrapper 重写 / --new-model 空操作，
//     三者均不改动既有 .meta）
//
// 约束：每个用例在 os.tmpdir() 下自建最小 project-docs 骨架，用例间零共享。
// bin 入口使用实际构建的 dist/src/bin.js；运行本文件前先 npm run build。
// v0.10：成功信封显式 next_action，讨论保留写入意图，codegen 交付文件可校验，
// dispatch/runCli 返回后调用者继续运行；安装与包根导入由 dogfood/system tests 覆盖。

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dispatch } from "../src/cli/dispatcher.js";
import { CoreResultSchema, VersionIndexSchema, type CoreResult, type VersionIndex } from "../src/doc-model/schemas.js";
import { loadModel } from "../src/foundation/yaml.js";

// ---------------------------------------------------------------------------
// 常量与临时目录管理
// ---------------------------------------------------------------------------

const NODE_EXE = process.execPath;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(HERE, "../dist/src/bin.js");
const DISPATCHER_JS = path.resolve(HERE, "../dist/src/cli/dispatcher.js");

type SuccessData = Extract<CoreResult, { ok: true }>["data"];

let tmpDirs: string[] = [];

function mkTmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-cli-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch (err) {
			// 清理失败仅告警不 fail（Windows 文件锁容忍）。
			console.warn(`afterEach 清理失败（忽略）: ${dir}`, err);
		}
	}
	tmpDirs = [];
});

// ---------------------------------------------------------------------------
// 实际 bin 与库调用的子进程装置
// ---------------------------------------------------------------------------

beforeAll(() => {
	for (const file of [BIN_PATH, DISPATCHER_JS]) {
		expect(fs.existsSync(file), "缺少构建产物，请先运行 npm run build").toBe(true);
	}
});

interface BinRun {
	status: number;
	stdout: string;
	stderr: string;
}

/** close 发生在 stdout/stderr 排空后，避免截断最后一段 JSON。 */
function runNode(cwd: string, argv: string[]): Promise<BinRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(NODE_EXE, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolve({ status: code ?? -1, stdout, stderr }));
	});
}

function runBin(cwd: string, argv: string[]): Promise<BinRun> {
	return runNode(cwd, [BIN_PATH, ...argv]);
}

/** 校验原始信封，不用 schema 输出或删字段掩盖遗漏。 */
function expectEnvelope(result: unknown): asserts result is CoreResult {
	expect(CoreResultSchema.safeParse(result).success).toBe(true);
	if ((result as CoreResult).ok === false) {
		expect(Object.keys(result as object).sort()).toEqual(["code", "error", "ok"]);
	}
}

function successData(result: CoreResult): Extract<CoreResult, { ok: true }>["data"] {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.data;
}

/** stdout 必须恰为单行 JSON（“成功输出信封后无第二段输出”由单段性覆盖）。 */
function parseSingleJson(stdout: string): CoreResult {
	const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
	expect(lines.length).toBe(1);
	const result: unknown = JSON.parse(lines[0] as string);
	expectEnvelope(result);
	return result;
}

/** 进程内 dispatch：dispatcher 以 process.cwd() 解析项目根，调用期间临时 chdir。 */
async function dispatchIn(cwd: string, argv: string[]): Promise<CoreResult> {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		const result = await dispatch(argv);
	expect(process.cwd()).toBe(cwd);
	expectEnvelope(result);
	return result;
	} finally {
		process.chdir(prev);
	}
}

// ---------------------------------------------------------------------------
// 骨架与快照
// ---------------------------------------------------------------------------

/** 最小 project-docs 骨架：docs/{prd,fsd,tdd} + .meta/versions，返回宿主目录。 */
function makeSkeleton(): string {
	const dir = mkTmp();
	for (const d of [
		"project-docs/docs/prd",
		"project-docs/docs/fsd",
		"project-docs/docs/tdd",
		"project-docs/.meta/versions",
	]) {
		fs.mkdirSync(path.join(dir, d), { recursive: true });
	}
	return dir;
}

function writeBaselineGraph(dir: string, graph: unknown): void {
	fs.writeFileSync(
		path.join(dir, "project-docs", ".meta", "specgraph.yaml"),
		JSON.stringify(graph),
	);
}

/** 目录树快照（相对路径 → 文件内容），用于“零副作用 / 不进业务逻辑”断言。 */
function treeSnapshot(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (cur: string): void => {
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else {
				out.set(path.relative(dir, abs), fs.readFileSync(abs, "utf-8"));
			}
		}
	};
	walk(dir);
	return out;
}

/** 目录树字节摘要（相对路径 → 文件字节 sha256），用于"零落盘 / 字节不变"断言。 */
function digestTree(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (cur: string): void => {
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			const abs = path.join(cur, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git") continue;
				walk(abs);
			} else {
				const rel = path.relative(dir, abs).split(path.sep).join("/");
				out.set(rel, createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
			}
		}
	};
	walk(dir);
	return out;
}

/** `.meta/` 下全部文件的字节摘要（init 三参数"不改动既有 .meta"的核对面）。 */
function metaDigest(dir: string): Map<string, string> {
	const picked = new Map<string, string>();
	const all = digestTree(path.join(dir, "project-docs", ".meta"));
	for (const [rel, digest] of all) {
		picked.set(rel, digest);
	}
	return picked;
}

/** 规范化读取（CRLF→LF，换行不敏感）。 */
function readNorm(abs: string): string {
	return fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
}

/** 去除信封中唯一非确定字段（skip-context 审计时间戳），供两入口/两来源的 deep-equal。 */
function stripAuditTimestamp(result: CoreResult): unknown {
	const clone = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
	const data = clone.data as Record<string, unknown> | undefined;
	const audit = data?.audit as Record<string, unknown> | undefined;
	if (audit !== undefined) {
		delete audit.at;
	}
	return clone;
}

/** 毫秒级同步休眠（供 EBUSY 重试退避）。 */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 在指定目录执行 git 并返回 stdout（Windows 下 EBUSY 做有限次退避重试）。 */
function gitAt(cwd: string, args: string[]): string {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return execFileSync("git", args, {
				cwd,
				encoding: "utf-8",
				// stdin 必须 ignore：本环境下 stdin=pipe 的 spawn 会被拒（EBUSY）
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			lastErr = err;
			if ((err as NodeJS.ErrnoException).code !== "EBUSY") throw err;
			sleepSync(100 * (attempt + 1));
		}
	}
	throw lastErr;
}

// ---------------------------------------------------------------------------
// 版本骨架装置（活动版本元数据 + 版本索引 + 基线文档）
// ---------------------------------------------------------------------------

const VERSION = "v0.4";

/**
 * 写版本元数据 `.meta/versions/<v>.yaml`（Python 当前形态；summary 外的字段
 * 按 VersionMetaSchema 给全，缺失即有默认值）。
 */
function writeVersionMeta(
	dir: string,
	version: string,
	overrides: Record<string, unknown> = {},
): void {
	const meta = {
		version,
		created_at: "2026-01-01T00:00:00+00:00",
		merged_at: null,
		owner: "system",
		changes: [],
		dependencies: {},
		snapshot: null,
		phase: "empty",
		title: null,
		prd_locked: false,
		impl_locked: false,
		docs_commit: null,
		code_base: null,
		code_result: null,
		confirmed_plan: null,
		revert_anchor: null,
		recovery_journal: null,
		historical_anchor_repairs: [],
		...overrides,
	};
	fs.writeFileSync(
		path.join(dir, "project-docs", ".meta", "versions", `${version}.yaml`),
		JSON.stringify(meta),
	);
}

/** 写版本索引 `.meta/chunks-index-<v>.yaml`（chunks 条目形状按 Python 当前形态）。 */
function writeVersionIndex(
	dir: string,
	version: string,
	chunks: Array<Record<string, unknown>>,
): void {
	const index = {
		version: 1,
		scope: "version",
		version_name: version,
		based_on_hash: null,
		status: "developing",
		chunks,
		commits: [],
		stats: {},
	};
	fs.writeFileSync(
		path.join(dir, "project-docs", ".meta", `chunks-index-${version}.yaml`),
		JSON.stringify(index),
	);
}

/** 版本索引 chunk 条目的最小合法形态（VersionChunkEntrySchema）。 */
function idxEntry(
	id: string,
	state: "working" | "staged" | "committed",
	action: "add" | "modify" | "delete" = "add",
): Record<string, unknown> {
	return {
		id,
		file: id.includes(":") ? id.slice(0, id.indexOf(":")) : id,
		heading: `${id} heading`,
		level: 2,
		action,
		state,
		commit_id: null,
		overrides: null,
		amends: null,
		insert_after: null,
		base_hash: null,
		source_req: null,
		discussion_usage: null,
		summary: null,
		metadata: {},
	};
}

/** 写 baseline 文档：key 为相对 docs 的路径，value 为全文。 */
function writeDoc(dir: string, rel: string, text: string): void {
	const abs = path.join(dir, "project-docs", "docs", rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, `${text}\n`);
}

/** 最小合法 PRD 根文档（根 chunk 无 :split，故不触发 PRD 内容契约）。 */
function prdDoc(id: string): string {
	return [`<!-- @id:${id} -->`, `## ${id} 产品 PRD`, "", "### 功能描述", "demo。", ""].join(
		"\n",
	);
}

/** 读版本索引的落盘形态（落盘为 YAML，经项目 schema 校验读取）。 */
function readVersionIndex(dir: string, version: string): VersionIndex {
	return loadModel(
		path.join(dir, "project-docs", ".meta", `chunks-index-${version}.yaml`),
		VersionIndexSchema,
	);
}

/** 带活动版本与空基线的骨架（prd/fsd/tdd 目录、.meta/versions 已就位）。 */
function makeVersionSkeleton(phase = "empty"): string {
	const dir = makeSkeleton();
	writeVersionMeta(dir, VERSION, { phase });
	return dir;
}

const FSD_BODY = [
	"<!-- @id:[FSD]-demo -->", "## demo FSD", "", "### 功能描述", "演示功能。", "",
	"<!-- @id:[FSD]-demo:feature -->", "### feature", "", "实现演示功能。", "",
].join("\n");

function tddDoc(body = "按规格生成演示制品。"): string {
	return [
		"<!-- @id:[TDD]-demo -->", "## demo TDD", "", "```yaml",
		"target_file: src/demo.ts", "```", "", body, "",
	].join("\n");
}

/** 完整基线链；图与索引均使用 Python 当前持久化形态。 */
function makeBaselineSkeleton(tddBody?: string): string {
	const dir = makeSkeleton();
	writeDoc(dir, "prd/[PRD]-demo.md", prdDoc("[PRD]-demo"));
	writeDoc(dir, "fsd/[FSD]-demo.md", FSD_BODY);
	writeDoc(dir, "tdd/[TDD]-demo.md", tddDoc(tddBody));
	const rows = [
		["[PRD]-demo", "prd", "prd/[PRD]-demo"],
		["[FSD]-demo", "fsd", "fsd/[FSD]-demo"],
		["[FSD]-demo:feature", "fsd", "fsd/[FSD]-demo"],
		["[TDD]-demo", "tdd", "tdd/[TDD]-demo"],
	] as const;
	const specs = rows.map(([id, type, file]) => ({
		uri: "spec:" + type + ":baseline:" + id, title: id, type, version: "baseline",
		chunk_id: id, file, metadata: { source: "baseline" },
	}));
	writeBaselineGraph(dir, {
		version: 1, updated: "2026-01-01T00:00:00+00:00", specs,
		edges: [
			{ src: specs[0]!.uri, dst: specs[1]!.uri, rel: "derives", weight: 1, metadata: { source: "new-model-cli" } },
			{ src: specs[2]!.uri, dst: specs[3]!.uri, rel: "details", weight: 1, metadata: { source: "new-model-cli" } },
		],
	});
	fs.writeFileSync(path.join(dir, "project-docs/.meta/chunks-index.yaml"), JSON.stringify({
		version: 1, scope: "global", updated: "2026-01-01T00:00:00+00:00",
		chunks: rows.map(([id, , file]) => ({ id, file, heading: id, level: 2, summary: null, metadata: {} })),
	}));
	return dir;
}

// ---------------------------------------------------------------------------
// :TEST 1 — 双入口一致
// ---------------------------------------------------------------------------

describe("双入口一致", () => {
	it("search 空命中：dispatch() 与 bin stdout deep-equal，成功输出单段", async () => {
		const dir = makeSkeleton();
		const argv = ["search", "不存在的关键词-zqx"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch).toEqual({
			ok: true,
			data: { query: "不存在的关键词-zqx", count: 0, hits: [], next_action: null },
		});
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("specgraph export：dispatch() 与 bin stdout deep-equal，成功输出单段", async () => {
		const dir = makeSkeleton();
		// v0.5：specs 为按 uri 排序的数组，节点带 uri/type/version/title/metadata
		const graph = {
			version: 1,
			updated: new Date().toISOString(),
			specs: [
				{
					uri: "spec:prd:baseline:[PRD]-demo",
					title: "demo",
					type: "prd",
					version: "baseline",
					chunk_id: "[PRD]-demo",
					file: "prd/[PRD]-demo",
					metadata: { source: "baseline" },
				},
			],
			edges: [],
		};
		writeBaselineGraph(dir, graph);
		const argv = ["specgraph", "export"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});
	for (const argv of [
		["version", "status", VERSION], ["baseline-summary"],
		["deps", "[FSD]-demo:feature"], ["impact", "[PRD]-demo"],
		["specgraph", "query", "[FSD]-demo:feature"],
		["acceptance", "show"], ["acceptance", "run"],
	]) {
		it(argv.join(" ") + "：确定性只读查询双入口一致且 next_action 为 null", async () => {
			const dir = makeBaselineSkeleton();
			writeVersionMeta(dir, VERSION);
			const before = digestTree(dir);
			const viaDispatch = await dispatchIn(dir, argv);
			expect(successData(viaDispatch).next_action).toBe(null);
			const viaBin = await runBin(dir, argv);
			expect(viaBin.status, viaBin.stderr || viaBin.stdout).toBe(0);
			expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
			expect(digestTree(dir)).toEqual(before);
		});
	}

});


// ---------------------------------------------------------------------------
// v0.10 — 接续动作按实际写入意图生成，成功/失败信封覆盖两入口
// ---------------------------------------------------------------------------

describe("讨论 next_action", () => {
	const cases: Array<{ name: string; phase: string; argv: string[] }> = [
		{ name: "PRD", phase: "empty", argv: ["prd", "create", "[PRD]-renamed", "--action", "modify", "--file", "prd/renamed", "--overrides", "[PRD]-demo"] },
		{ name: "FSD", phase: "prd-confirm", argv: ["fsd", "create", "[FSD]-renamed", "--parent", "[PRD]-demo", "--action", "modify", "--file", "fsd/renamed", "--overrides", "[FSD]-demo"] },
		{ name: "TDD", phase: "fsd-confirm", argv: ["tdd", "create", "[TDD]-renamed", "--parent", "[FSD]-demo:feature", "--action", "modify", "--file", "tdd/renamed", "--overrides", "[TDD]-demo"] },
		{ name: "FSD decompose", phase: "prd-confirm", argv: ["fsd", "decompose", "[FSD]-demo:feature", "[FSD]-child", "--action", "add", "--file", "fsd/child"] },
	];

	for (const { name, phase, argv } of cases) {
		it(name + "：接续调用保留 parent/action/file/overrides/context_token 且零写入", async () => {
			const dir = makeBaselineSkeleton();
			writeVersionMeta(dir, VERSION, { phase });
			const before = digestTree(dir);
			const viaDispatch = await dispatchIn(dir, argv);
			const viaBin = await runBin(dir, argv);
			expect(viaBin.status).toBe(0);
			for (const result of [viaDispatch, parseSingleJson(viaBin.stdout)]) {
				const data = successData(result);
				expect(data.mode).toBe("discussion-context");
				expect(data.version).toBe(VERSION);
				expect(data.context_token).toEqual(expect.any(String));
				const action = data.next_action;
				expect(action?.type).toBe("present_and_collect");
				if (action?.type !== "present_and_collect") throw new Error("缺少讨论接续动作");
				expect(action.instruction.length).toBeGreaterThan(0);
				expect(action.required_next_call).toContain(VERSION);
				const match = /await dispatch\((\[[\s\S]*\])\)$/.exec(action.required_next_call);
				expect(match).not.toBeNull();
				const nextArgv: unknown = JSON.parse(match![1]!);
				expect(nextArgv).toEqual([
					...argv, "--context-token", data.context_token,
					"--content", "<讨论后确定的完整正文>",
				]);
			}
			expect(digestTree(dir)).toEqual(before);
		});
	}
});

describe("写入、confirm/revert 的成功信封", () => {
	for (const entry of ["dispatch", "bin"] as const) {
		it(entry + "：版本与三层规格的接续动作和落盘状态一致", async () => {
			const dir = makeSkeleton();
			const run = async (argv: string[]): Promise<CoreResult> => {
				if (entry === "dispatch") return dispatchIn(dir, argv);
				const result = await runBin(dir, argv);
				expect(result.status, result.stderr).toBe(0);
				return parseSingleJson(result.stdout);
			};
			const created = successData(await run(["version", "create", VERSION]));
			expect(created.version).toBe(VERSION);
			expect(created.next_action).toEqual({ type: "report", message: '已创建版本 "' + VERSION + '"。' });
			const layers = [
				{ layer: "prd", id: "[PRD]-demo", body: prdDoc("[PRD]-demo"), parent: [], chunks: ["[PRD]-demo"] },
				{ layer: "fsd", id: "[FSD]-demo", body: FSD_BODY, parent: ["--parent", "[PRD]-demo"], chunks: ["[FSD]-demo", "[FSD]-demo:feature"] },
				{ layer: "tdd", id: "[TDD]-demo", body: tddDoc(), parent: ["--parent", "[FSD]-demo:feature"], chunks: ["[TDD]-demo"] },
			];
			for (const { layer, id, body, parent, chunks } of layers) {
				const written = successData(await run([layer, "create", id, ...parent, "--content", body, "--skip-context"]));
				expect(written).toMatchObject({ mode: "written", id, phase: layer + "-creating", next_action: null });
				expect(readNorm(path.join(dir, "project-docs", "versions", VERSION, layer, id + ".md"))).toContain(body.trim());
				const confirmed = successData(await run([layer, "confirm"]));
				expect(confirmed).toEqual({
					version: VERSION, confirmed: chunks, phase: layer + "-confirm",
					next_action: { type: "report", message: '版本 "' + VERSION + '" 的 ' + layer.toUpperCase() + ' 层已确认，包含 ' + chunks.length + ' 个 chunk；当前阶段为 "' + layer + '-confirm"。' },
				});
				const reverted = successData(await run([layer, "revert"]));
				expect(reverted).toEqual({ version: VERSION, reverted: chunks, phase: layer + "-creating", next_action: null });
				expect(readVersionIndex(dir, VERSION).chunks.filter((chunk) => chunks.includes(chunk.id)).every((chunk) => chunk.state === "working")).toBe(true);
				expect(successData(await run([layer, "confirm"])).next_action?.type).toBe("report");
			}
			const confirmedVersion = successData(await run(["version", "confirm", VERSION]));
			expect(confirmedVersion).toMatchObject({ version: VERSION, passed: true, next_action: { type: "report", message: '版本 "' + VERSION + '" 的确认检查已通过。' } });
			const revertedVersion = successData(await run(["version", "revert", VERSION, "--confirm"]));
			expect(revertedVersion).toMatchObject({ version: VERSION, next_action: null });
			expect(fs.existsSync(path.join(dir, "project-docs", "versions", VERSION))).toBe(false);
		}, 20_000);
	}
});


describe("codegen 文件交付", () => {
	for (const mode of ["baseline", "活动版本默认", "显式版本"] as const) {
		it(mode + "：两入口只返回小指针，各自交付的全文、字节数与 SHA256 可核验", async () => {
			const marker = "CODEGEN_完整规格正文_不得出现在stdout。".repeat(400);
			const dir = makeBaselineSkeleton(marker);
			if (mode !== "baseline") {
				writeVersionMeta(dir, VERSION, { phase: "tdd-confirm" });
				writeVersionIndex(dir, VERSION, []);
			}
			const target = path.join(dir, "src/demo.ts");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, 'export const existingArtifact = "target-source-sentinel";\n');
			const argv = ["codegen", "prepare", "[TDD]-demo", ...(mode === "显式版本" ? ["--version", VERSION] : [])];
			const viaDispatch = await dispatchIn(dir, argv);
			const viaBin = await runBin(dir, argv);
			expect(viaBin.status, viaBin.stderr || viaBin.stdout).toBe(0);
			const results = [viaDispatch, parseSingleJson(viaBin.stdout)];
			for (const result of results) {
				const data = successData(result);
				expect(Object.keys(data).sort()).toEqual([
					"bundle_path", "bytes", "generation_token", "next_action", "sha256",
					"source_file", "target_file", "tdd_root", "version",
				]);
				expect(data).toMatchObject({
					version: mode === "baseline" ? null : VERSION,
					target_file: "src/demo.ts", tdd_root: "[TDD]-demo",
					source_file: path.join(dir, "project-docs/docs/tdd/[TDD]-demo.md"),
					generation_token: expect.any(String),
				});
				expect(String(data.generation_token).length).toBeGreaterThan(0);
				expect(typeof data.bundle_path).toBe("string");
				const bundlePath = data.bundle_path as string;
				expect(path.isAbsolute(bundlePath)).toBe(true);
				const deliveryDir = path.dirname(bundlePath);
				// 仅接管本次交付在系统 temp 创建的目录，供 afterEach 安全清理。
				expect(path.dirname(deliveryDir)).toBe(fs.realpathSync(os.tmpdir()));
				expect(path.basename(deliveryDir)).toMatch(/^ait-codegen-/);
				expect(path.relative(dir, bundlePath).startsWith(".." + path.sep)).toBe(true);
				tmpDirs.push(deliveryDir);
				const bytes = fs.readFileSync(bundlePath);
				expect(bytes.length).toBe(data.bytes);
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(data.sha256);
				const text = bytes.toString("utf8");
				for (const content of [marker, "target-source-sentinel", "[TDD]-demo", "[FSD]-demo:feature", "[PRD]-demo"]) {
					expect(text).toContain(content);
				}
				const action = data.next_action;
				expect(action?.type).toBe("continue");
				if (action?.type !== "continue") throw new Error("缺少生成接续动作");
				for (const key of ["bundle_path", "sha256", "bytes", "target_file", "tdd_root", "source_file"] as const) {
					const value = data[key];
					expect(action.instruction).toContain(typeof value === "string" ? JSON.stringify(value) : String(value));
				}
				expect(action.next_call).toBe("registerGenerationReceipt(root, { generation_token: " + JSON.stringify(data.generation_token) + " })");
				const envelope = JSON.stringify(result);
				expect(Buffer.byteLength(envelope)).toBeLessThan(bytes.length);
				expect(envelope).not.toContain("CODEGEN_完整规格正文_");
				expect(envelope).not.toContain("target-source-sentinel");
			}
			expect(successData(results[0]!).generation_token).not.toBe(successData(results[1]!).generation_token);
			expect(readNorm(target)).toBe('export const existingArtifact = "target-source-sentinel";\n');
		});
	}
});

describe("库调用存活与零导入副作用", () => {
	const moduleUrl = JSON.stringify(pathToFileURL(DISPATCHER_JS).href);

	it("非项目目录 import dispatcher 不输出或写盘", async () => {
		const dir = mkTmp();
		const before = digestTree(dir);
		const child = await runNode(dir, ["--input-type=module", "--eval", "await import(" + moduleUrl + ");"]);
		expect(child).toEqual({ status: 0, stdout: "", stderr: "" });
		expect(digestTree(dir)).toEqual(before);
	});

	it("dispatch 成功与失败都返回，第二条调用及后续语句继续执行且不写 stdout", async () => {
		const dir = mkTmp();
		const script = [
			"const { dispatch } = await import(" + moduleUrl + ");",
			"const before = process.cwd();",
			'const first = await dispatch(["--version"]);',
			'const second = await dispatch(["no-such-command"]);',
			"process.stdout.write(JSON.stringify({ first, second, continued: true, sameCwd: before === process.cwd() }) + '\\n');",
		].join("\n");
		const child = await runNode(dir, ["--input-type=module", "--eval", script]);
		expect(child.status, child.stderr).toBe(0);
		expect(child.stderr).toBe("");
		expect(child.stdout.trim().split(/\r?\n/)).toHaveLength(1);
		const result = JSON.parse(child.stdout) as { first: CoreResult; second: CoreResult; continued: boolean; sameCwd: boolean };
		expect(result.first).toEqual({ ok: true, data: { version: "unversioned", next_action: null } });
		expectEnvelope(result.second);
		expect(result.second).toMatchObject({ ok: false, code: "USAGE_ERROR" });
		expect(result.continued).toBe(true);
		expect(result.sameCwd).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	for (const [argv, expectedCode] of [[["--version"], 0], [["no-such-command"], 1]] as const) {
		it("runCli 返回 " + expectedCode + "，只输出一个信封且不终止调用者", async () => {
			const dir = mkTmp();
			const script = [
				"const { runCli } = await import(" + moduleUrl + ");",
				"const code = await runCli(" + JSON.stringify(argv) + ");",
				"process.stdout.write(JSON.stringify({ code, continued: true }) + '\\n');",
			].join("\n");
			const child = await runNode(dir, ["--input-type=module", "--eval", script]);
			expect(child.status, child.stderr).toBe(0);
			expect(child.stderr).toBe("");
			const lines = child.stdout.trim().split(/\r?\n/);
			expect(lines).toHaveLength(2);
			const envelope = parseSingleJson(lines[0]!);
			expect(envelope.ok).toBe(expectedCode === 0);
			expect(JSON.parse(lines[1]!)).toEqual({ code: expectedCode, continued: true });
			expect(fs.readdirSync(dir)).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// :TEST 2 — USAGE_ERROR 矩阵
// ---------------------------------------------------------------------------

describe("USAGE_ERROR", () => {
	const matrix: Array<[string, string[]]> = [
		["未知命令", ["frobnicate"]],
		["回执登记不提供 CLI", ["registerGenerationReceipt", "token"]],
		["缺参数", ["search"]],
		["非法 flag 值（enum 外）", ["search", "x", "--scope", "bogus"]],
		["未知 flag", ["search", "x", "--bogus"]],
		["布尔 flag 带值", ["version", "revert", "v1", "--confirm=yes"]],
	];

	for (const [name, argv] of matrix) {
		it(`${name}：code=USAGE_ERROR、exit 1、不进业务逻辑（骨架零副作用）`, async () => {
			const dir = makeSkeleton();
			const before = treeSnapshot(dir);

			const viaDispatch = await dispatchIn(dir, argv);
			expect(viaDispatch.ok).toBe(false);
			if (viaDispatch.ok === false) {
				expect(viaDispatch.code).toBe("USAGE_ERROR");
				expect(viaDispatch.error.length).toBeGreaterThan(0);
			}

			const viaBin = await runBin(dir, argv);
			expect(viaBin.status).toBe(1);
			expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);

			// 解析/匹配阶段即拒，骨架字节级不动（未进任何业务逻辑）。
			expect(treeSnapshot(dir)).toEqual(before);
		});
	}
});

// ---------------------------------------------------------------------------
// :TEST 3 — 校验类语义
// ---------------------------------------------------------------------------

describe("校验类语义", () => {
	it("违规时 {ok:true,data:{passed:false,violations}} 且 exit 0", async () => {
		const dir = makeSkeleton();
		// 孤立 TDD 节点：无 details 父、无 target_file、不可达 PRD → 必然违规。
		writeBaselineGraph(dir, {
			version: 1,
			updated: new Date().toISOString(),
			specs: [
				{
					uri: "spec:tdd:baseline:[TDD]-lone",
					title: "lone",
					type: "tdd",
					version: "baseline",
					chunk_id: "[TDD]-lone",
					file: "tdd/[TDD]-lone",
					metadata: { source: "baseline" },
				},
			],
			edges: [],
		});
		const argv = ["specgraph", "validate-new-model"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const data = viaDispatch.data as SuccessData & {
				passed: unknown;
				violations: Array<{ code: unknown; message: unknown }>;
			};
			expect(data.passed).toBe(false);
			expect(Array.isArray(data.violations)).toBe(true);
			expect(data.violations.length).toBeGreaterThan(0);
			for (const v of data.violations) {
				expect(typeof v.code).toBe("string");
				expect(typeof v.message).toBe("string");
			}
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0); // 校验违规不是进程失败：退出码仍 0
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("无违规时 passed:true 且 exit 0", async () => {
		const dir = makeSkeleton();
		writeBaselineGraph(dir, { version: 1, updated: new Date().toISOString(), specs: [], edges: [] });
		const argv = ["specgraph", "validate-new-model"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch).toEqual({
			ok: true,
			data: { passed: true, violations: [], next_action: null },
		});
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});
});

// ---------------------------------------------------------------------------
// :TEST 4 — --version 三场景
// ---------------------------------------------------------------------------

describe("--version", () => {
	it("有版本记录：显示数值序最大版本号（v0.10 > v0.9），只读零副作用", async () => {
		const dir = makeSkeleton();
		const versionsDir = path.join(dir, "project-docs", ".meta", "versions");
		for (const name of ["v0.1.yaml", "v0.9.yaml", "v0.10.yaml"]) {
			fs.writeFileSync(path.join(versionsDir, name), "");
		}
		const before = treeSnapshot(dir);

		const viaDispatch = await dispatchIn(dir, ["--version"]);
		expect(viaDispatch).toEqual({ ok: true, data: { version: "v0.10", next_action: null } });
		const viaBin = await runBin(dir, ["--version"]);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);

		expect(treeSnapshot(dir)).toEqual(before); // 只读
	});

	it("无版本记录：unversioned", async () => {
		const dir = makeSkeleton();
		const viaDispatch = await dispatchIn(dir, ["--version"]);
		expect(viaDispatch).toEqual({ ok: true, data: { version: "unversioned", next_action: null } });
		const viaBin = await runBin(dir, ["--version"]);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("非项目根：unversioned 且目录保持为空", async () => {
		const dir = mkTmp(); // 无 project-docs
		const viaDispatch = await dispatchIn(dir, ["--version"]);
		expect(viaDispatch).toEqual({ ok: true, data: { version: "unversioned", next_action: null } });
		const viaBin = await runBin(dir, ["--version"]);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
		expect(fs.readdirSync(dir)).toEqual([]); // 零副作用
	});
});

// ---------------------------------------------------------------------------
// :TEST 5 — 错误包装
// ---------------------------------------------------------------------------

describe("错误包装", () => {
	it("域抛带 code 错误原样透传（VERSION_NOT_FOUND），exit 1", async () => {
		const dir = makeSkeleton();
		const argv = ["version", "status", "v9.9"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("VERSION_NOT_FOUND");
			expect(viaDispatch.error).toContain("v9.9");
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("codegen 缺失父节点时透传 MISSING_ENDPOINT，exit 1", async () => {
		const dir = makeSkeleton();
		// 图中有 details 父节点但其文档缺失：正式交付校验返回带 code 的错误。
		writeBaselineGraph(dir, {
			version: 1,
			updated: new Date().toISOString(),
			specs: [
				{
					uri: "spec:fsd:baseline:[FSD]-ghost:split",
					title: "split",
					type: "fsd",
					version: "baseline",
					chunk_id: "[FSD]-ghost:split",
					file: "fsd/[FSD]-ghost",
					metadata: { source: "baseline" },
				},
				{
					uri: "spec:tdd:baseline:[TDD]-ghost",
					title: "ghost",
					type: "tdd",
					version: "baseline",
					chunk_id: "[TDD]-ghost",
					file: "tdd/[TDD]-ghost",
					metadata: { source: "baseline" },
				},
			],
			edges: [
				{
					src: "spec:fsd:baseline:[FSD]-ghost:split",
					dst: "spec:tdd:baseline:[TDD]-ghost",
					rel: "details",
					weight: 1.0,
					metadata: { source: "test-setup" },
				},
			],
		});
		// TDD 文档在场且带 target_file（内联文本用行数组 join，避免围栏自嵌套）。
		fs.writeFileSync(
			path.join(dir, "project-docs", "docs", "tdd", "[TDD]-ghost.md"),
			[
				"<!-- @id:[TDD]-ghost -->",
				"## ghost TDD",
				"",
				"```yaml",
				"target_file: src/ghost.ts",
				"```",
				"",
			].join("\n"),
		);
		// docs/fsd/ 刻意留空，父 chunk 内容缺失。

		const argv = ["codegen", "prepare", "[TDD]-ghost"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("MISSING_ENDPOINT");
			expect(viaDispatch.error).toContain("[FSD]-ghost:split");
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("无 code 的 git 初始化异常包装为 INTERNAL_ERROR 并保留 message", async () => {
		const dir = mkTmp();
		const config = path.join(mkTmp(), "broken.gitconfig");
		fs.writeFileSync(config, "[broken\n");
		const previous = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = config;
		try {
			const argv = ["init", "--name", "demo"];
			const viaDispatch = await dispatchIn(dir, argv);
			expect(viaDispatch.ok).toBe(false);
			if (!viaDispatch.ok) {
				expect(viaDispatch.code).toBe("INTERNAL_ERROR");
				expect(viaDispatch.error).toContain("docs 仓 git init 失败：");
				expect(viaDispatch.error).toContain("bad config line 1");
				expect(viaDispatch.error).toContain("broken.gitconfig");
			}
			expect(fs.existsSync(path.join(dir, "project-docs/.git"))).toBe(false);
			const viaBin = await runBin(dir, argv);
			expect(viaBin.status).toBe(1);
			expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
		} finally {
			if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = previous;
		}
	});
});

// ---------------------------------------------------------------------------
// :TEST 6 — 参数形态（FSD 7 / FSD cli_dispatcher 6）
// ---------------------------------------------------------------------------

describe("参数形态", () => {
	const BODY = [
		"<!-- @id:[PRD]-demo -->",
		"## demo PRD",
		"",
		"### 功能描述",
		"正文来自 --content 与 --content-file 时必须逐字节一致。",
		"",
	].join("\n");

	it("--content 与 --content-file 语义等价：落盘字节一致", async () => {
		// 骨架 A：--content 内联正文
		const dirA = makeVersionSkeleton();
		const viaContent = await dispatchIn(dirA, [
			"prd",
			"create",
			"[PRD]-demo",
			"--content",
			BODY,
			"--skip-context",
		]);
		expect(viaContent.ok).toBe(true);
		expect(successData(viaContent).next_action).toBe(null);

		// 骨架 B：--content-file 指向同字节文件
		const dirB = makeVersionSkeleton();
		const contentFile = path.join(dirB, "body.md");
		fs.writeFileSync(contentFile, BODY);
		const viaFile = await dispatchIn(dirB, [
			"prd",
			"create",
			"[PRD]-demo",
			"--content-file",
			contentFile,
			"--skip-context",
		]);
		expect(viaFile.ok).toBe(true);
		expect(successData(viaFile).next_action).toBe(null);

		// 结果信封同形（skip-context 审计的时间戳是唯一非确定字段，比较前归一）
		expect(stripAuditTimestamp(viaFile)).toEqual(stripAuditTimestamp(viaContent));

		const rel = path.join("project-docs", "versions", VERSION, "prd", "[PRD]-demo.md");
		expect(readNorm(path.join(dirB, rel))).toBe(readNorm(path.join(dirA, rel)));

		// 双入口：--content-file 经 bin 调用与 dispatch 一致
		const viaBin = await runBin(dirB, [
			"prd",
			"create",
			"[PRD]-demo",
			"--content-file",
			contentFile,
			"--skip-context",
		]);
		expect(viaBin.status).toBe(0);
		expect(stripAuditTimestamp(parseSingleJson(viaBin.stdout))).toEqual(
			stripAuditTimestamp(viaFile),
		);
	});

	it("--content 与 --content-file 同现：USAGE_ERROR 且零落盘", async () => {
		const dir = makeVersionSkeleton();
		const contentFile = path.join(dir, "body.md");
		fs.writeFileSync(contentFile, BODY);
		const before = digestTree(dir);
		const argv = [
			"prd",
			"create",
			"[PRD]-demo",
			"--content",
			BODY,
			"--content-file",
			contentFile,
			"--skip-context",
		];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("USAGE_ERROR");
			expect(viaDispatch.error).toContain("互斥");
		}
		expect(digestTree(dir)).toEqual(before);

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("--content-file 指向不可读文件：USAGE_ERROR 且零落盘（不落成 INTERNAL_ERROR）", async () => {
		const dir = makeVersionSkeleton();
		const missing = path.join(dir, "no-such-body.md");
		const before = digestTree(dir);
		const argv = [
			"prd",
			"create",
			"[PRD]-demo",
			"--content-file",
			missing,
			"--skip-context",
		];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			// 文件读取失败属参数形态错误，不是内部异常
			expect(viaDispatch.code).toBe("USAGE_ERROR");
			expect(viaDispatch.error).toContain("--content-file");
		}
		expect(digestTree(dir)).toEqual(before);

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("--overrides 透传给 new_model 域：版本索引条目记录旧 id", async () => {
		const dir = makeVersionSkeleton();
		// 基线已有根 chunk [PRD]-old（改名源）
		writeDoc(dir, path.join("prd", "[PRD]-old.md"), prdDoc("[PRD]-old"));
		const newBody = [
			"<!-- @id:[PRD]-renamed -->",
			"## renamed PRD",
			"",
			"### 功能描述",
			"根 chunk 改名。",
			"",
		].join("\n");
		const argv = [
			"prd",
			"create",
			"[PRD]-renamed",
			"--content",
			newBody,
			"--skip-context",
			"--overrides",
			"[PRD]-old",
		];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);

		const index = readVersionIndex(dir, VERSION);
		const entry = index.chunks.find((c) => c.id === "[PRD]-renamed");
		expect(entry).toBeDefined();
		expect(entry?.overrides).toBe("[PRD]-old");

		// 双入口：同一骨架二次写入由域自行判定（幂等/冲突），两入口结论必须一致。
		// 审计时间戳每次不同，比较前归一；其余字段（ok/code/data）必须逐字相同。
		const viaBin = await runBin(dir, argv);
		const viaBinParsed = parseSingleJson(viaBin.stdout);
		expect(viaBin.status).toBe(viaBinParsed.ok ? 0 : 1);
		expect(stripAuditTimestamp(viaBinParsed)).toEqual(
			stripAuditTimestamp(await dispatchIn(dir, argv)),
		);
		// override 只更新版本工作区记录，基线文件不动（改名由合并期语义承接）
		expect(
			fs.existsSync(path.join(dir, "project-docs", "docs", "prd", "[PRD]-old.md")),
		).toBe(true);
	});

	it("--overrides 冲突场景：create 原样透传成功，版本索引条目记录旧 id（拦截归 version confirm）", async () => {
		const dir = makeVersionSkeleton();
		writeDoc(dir, path.join("prd", "[PRD]-old.md"), prdDoc("[PRD]-old"));
		// 目标 id [PRD]-new 已作为基线 chunk 存在：改名冲突的判定时机在 version confirm
		// 门禁（与 Python 版同构），create 阶段原样透传并在版本索引条目留下旧 id。
		writeDoc(dir, path.join("prd", "[PRD]-new.md"), prdDoc("[PRD]-new"));
		const argv = [
			"prd",
			"create",
			"[PRD]-new",
			"--content",
			prdDoc("[PRD]-new"),
			"--skip-context",
			"--overrides",
			"[PRD]-old",
		];
		const viaDispatch = await dispatchIn(dir, argv);
		// create 不拦截冲突：原样写入工作区，冲突留给 version confirm 门禁。
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);

		const index = readVersionIndex(dir, VERSION);
		const entry = index.chunks.find((c) => c.id === "[PRD]-new");
		expect(entry).toBeDefined();
		expect(entry?.overrides).toBe("[PRD]-old");
		// 基线文件不动（改名由合并期语义承接）
		expect(
			fs.existsSync(path.join(dir, "project-docs", "docs", "prd", "[PRD]-old.md")),
		).toBe(true);

		// 双入口一致：审计时间戳每次不同，比较前归一。
		const viaBin = await runBin(dir, argv);
		const viaBinParsed = parseSingleJson(viaBin.stdout);
		expect(viaBin.status).toBe(0);
		expect(stripAuditTimestamp(viaBinParsed)).toEqual(
			stripAuditTimestamp(await dispatchIn(dir, argv)),
		);
	});

	it("未知参数报 USAGE_ERROR 并指明参数名（不静默忽略）", async () => {
		const dir = makeVersionSkeleton();
		const before = digestTree(dir);
		for (const argv of [
			["search", "x", "--nope"],
			["state", "--nope"],
			["init", "--nope"],
			["prd", "create", "[PRD]-demo", "--nope", "1"],
		]) {
			const viaDispatch = await dispatchIn(dir, argv);
			expect(viaDispatch.ok).toBe(false);
			if (viaDispatch.ok === false) {
				expect(viaDispatch.code).toBe("USAGE_ERROR");
				expect(viaDispatch.error).toContain("--nope");
			}
			const viaBin = await runBin(dir, argv);
			expect(viaBin.status).toBe(1);
			expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
		}
		expect(digestTree(dir)).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// :TEST 7 — state 三形态（FSD 6）
// ---------------------------------------------------------------------------

describe("state", () => {
	/** 含三态 chunk 的活动版本：PRD 1 working、FSD 1 staged、TDD 1 committed。 */
	function makeStateSkeleton(): string {
		const dir = makeVersionSkeleton("prd-confirm");
		writeVersionMeta(dir, VERSION, {
			phase: "prd-confirm",
			title: "demo 版本",
			prd_locked: true,
		});
		writeVersionIndex(dir, VERSION, [
			idxEntry("[PRD]-demo", "working", "add"),
			idxEntry("[FSD]-demo", "staged", "add"),
			idxEntry("[TDD]-demo", "committed", "modify"),
		]);
		return dir;
	}

	it("--format json：字段与 counts 结构化", async () => {
		const dir = makeStateSkeleton();
		const argv = ["state", "--format", "json"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const panel = viaDispatch.data as Record<string, unknown>;
			expect(panel.version).toBe(VERSION);
			expect(panel.title).toBe("demo 版本");
			expect(panel.phase).toBe("prd-confirm");
			expect(panel.prd_locked).toBe(true);
			expect(panel.impl_locked).toBe(false);
			expect(panel.merged).toBe(false);
			expect(panel.working).toEqual(["[PRD]-demo"]);
			expect(panel.staged).toEqual(["[FSD]-demo"]);
			expect(panel.committed).toEqual(["[TDD]-demo"]);
			expect(panel.by_action).toEqual({ add: 2, modify: 1 });
			expect(panel.prd_chunks).toEqual(["[PRD]-demo"]);
			expect(panel.fsd_chunks).toEqual(["[FSD]-demo"]);
			expect(panel.tdd_chunks).toEqual(["[TDD]-demo"]);
			expect(panel.counts).toEqual({
				working: 1,
				staged: 1,
				committed: 1,
				prd: 1,
				fsd: 1,
				tdd: 1,
			});
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("默认 markdown：只含 phase 与当前版本 chunk 三态/ID（无历史/全图/边列表）", async () => {
		const dir = makeStateSkeleton();
		// 图与边在场：markdown 仍不得渲染任何关系/历史内容
		writeBaselineGraph(dir, {
			version: 1,
			updated: new Date().toISOString(),
			specs: [],
			edges: [
				{
					src: "spec:prd:baseline:[PRD]-demo",
					dst: "spec:fsd:baseline:[FSD]-demo",
					rel: "derives",
					weight: 1.0,
					metadata: { source: "test-setup" },
				},
			],
		});
		const viaDispatch = await dispatchIn(dir, ["state"]);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const data = viaDispatch.data as SuccessData & { version: string; format: string; content: string };
			expect(data.version).toBe(VERSION);
			expect(data.format).toBe("markdown");
			const md = data.content;
			expect(md).toContain(`# AIT State — ${VERSION}`);
			expect(md).toContain("## 当前执行阶段");
			expect(md).toContain("prd-confirm");
			expect(md).toContain("## 当前版本 Chunk");
			for (const state of ["working", "staged", "committed"]) {
				expect(md).toContain(`| ${state} |`);
			}
			for (const layer of ["PRD", "FSD", "TDD"]) {
				expect(md).toContain(`### ${layer}`);
			}
			expect(md).toContain("[PRD]-demo");
			expect(md).toContain("[FSD]-demo");
			expect(md).toContain("[TDD]-demo");
			// 不含变更历史 / 关系全图 / 边列表
			expect(md).not.toContain("derives");
			expect(md).not.toContain("spec:prd:");
			expect(md).not.toContain("变更历史");
			expect(md).not.toContain("edge");
		}
		const viaBin = await runBin(dir, ["state"]);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("--save 写出 versions/<v>/state.md 且其它文件字节不变", async () => {
		const dir = makeStateSkeleton();
		const before = digestTree(dir);
		const stateFile = path.join(dir, "project-docs", "versions", VERSION, "state.md");
		expect(fs.existsSync(stateFile)).toBe(false);

		const viaDispatch = await dispatchIn(dir, ["state", "--save"]);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const data = viaDispatch.data as SuccessData & { saved_to?: string };
			expect(data.saved_to).toBe(stateFile);
		}
		expect(fs.existsSync(stateFile)).toBe(true);
		const saved = readNorm(stateFile);
		expect(saved).toContain(`# AIT State — ${VERSION}`);
		expect(saved).toContain("prd-confirm");

		// 除 state.md 外一切字节不动
		const after = digestTree(dir);
		const allowed = path.relative(dir, stateFile).split(path.sep).join("/");
		for (const [rel, digest] of before) {
			expect(after.get(rel)).toBe(digest);
		}
		for (const rel of after.keys()) {
			if (rel !== allowed) {
				expect(before.has(rel)).toBe(true);
			}
		}
		expect(after.has(allowed)).toBe(true);
	});

	it("--format 非 markdown/json：USAGE_ERROR 零写入", async () => {
		const dir = makeStateSkeleton();
		const before = digestTree(dir);
		const viaDispatch = await dispatchIn(dir, ["state", "--format", "yaml"]);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("USAGE_ERROR");
		}
		expect(digestTree(dir)).toEqual(before);
	});

	it("无活动版本（未给 --version）：NO_VERSION", async () => {
		const dir = makeSkeleton(); // .meta/versions 为空
		const before = digestTree(dir);
		const viaDispatch = await dispatchIn(dir, ["state"]);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("NO_VERSION");
		}
		expect(digestTree(dir)).toEqual(before);

		const viaBin = await runBin(dir, ["state"]);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});
	it("显式指定已 merged 版本：json 保持只读且显式 next_action 为 null", async () => {
		const dir = makeStateSkeleton();
		writeVersionMeta(dir, VERSION, { phase: "merged", merged_at: "2026-01-02T00:00:00+00:00" });
		const before = digestTree(dir);
		const argv = ["state", "--version", VERSION, "--format", "json"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch).toMatchObject({ ok: true, data: { version: VERSION, merged: true, next_action: null } });
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
		expect(digestTree(dir)).toEqual(before);
	});

});

// ---------------------------------------------------------------------------
// :TEST 8 — version backfill-tags（FSD 8）
// ---------------------------------------------------------------------------

describe("backfill-tags", () => {
	const MERGED = "v0.1";

	/** 已合入版本的元数据：锚点指向 refs/tags/ait/<v>，docs_commit 指向基线提交。 */
	function writeMergedVersion(dir: string, docsCommit: string): void {
		writeVersionMeta(dir, MERGED, {
			merged_at: "2026-01-02T00:00:00+00:00",
			phase: "merged",
			docs_commit: docsCommit,
			revert_anchor: { docs_ref: `refs/tags/ait/${MERGED}`, code_result: null },
		});
	}

	/** project-docs 独立 git 仓 + 一次基线提交，返回 HEAD。 */
	function initDocsRepo(dir: string): string {
		const repo = path.join(dir, "project-docs");
		gitAt(repo, ["init"]);
		gitAt(repo, ["add", "-A"]);
		gitAt(repo, [
			"-c",
			"user.name=ait",
			"-c",
			"user.email=ait@localhost",
			"commit",
			"--allow-empty",
			"-m",
			"baseline",
		]);
		return gitAt(repo, ["rev-parse", "HEAD"]).trim();
	}

	it("缺标签补齐（已合入版本）；再跑一次幂等 skipped=tag_present", async () => {
		const dir = makeSkeleton();
		const head = initDocsRepo(dir);
		writeMergedVersion(dir, head);
		// 模拟历史版本丢失标签
		expect(() =>
			gitAt(path.join(dir, "project-docs"), ["rev-parse", `refs/tags/ait/${MERGED}^{commit}`]),
		).toThrow();

		const argv = ["version", "backfill-tags"];
		const first = await dispatchIn(dir, argv);
		expect(first).toEqual({
			ok: true,
			data: { backfilled: [MERGED], skipped: [], git: "committed", next_action: null },
		});
		// 标签确实指向 docs_commit
		expect(
			gitAt(path.join(dir, "project-docs"), [
				"rev-parse",
				`refs/tags/ait/${MERGED}^{commit}`,
			]).trim(),
		).toBe(head);

		const second = await dispatchIn(dir, argv);
		expect(second).toEqual({
			ok: true,
			data: {
				backfilled: [],
				skipped: [{ version: MERGED, reason: "tag_present" }],
				git: "committed",
				next_action: null,
			},
		});

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(second);
	});

	it("非 git 仓：git=unavailable，不报错且零写入", async () => {
		const dir = makeSkeleton();
		writeMergedVersion(dir, "deadbeef");
		const before = digestTree(dir);
		const argv = ["version", "backfill-tags"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch).toEqual({
			ok: true,
			data: { backfilled: [], skipped: [], git: "unavailable", next_action: null },
		});
		expect(digestTree(dir)).toEqual(before);

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("零位置参数：多余版本号报 USAGE_ERROR", async () => {
		const dir = makeSkeleton();
		const viaDispatch = await dispatchIn(dir, ["version", "backfill-tags", MERGED]);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("USAGE_ERROR");
		}
	});
});

// ---------------------------------------------------------------------------
// :TEST 9 — search --regexp（FSD 8）
// ---------------------------------------------------------------------------

describe("search --regexp", () => {
	/** 基线两篇文档：一行含 "a.c"，一行含 "abc"（正则 a.c 才能命中后者）。 */
	function makeSearchSkeleton(): string {
		const dir = makeSkeleton();
		writeDoc(
			dir,
			path.join("prd", "[PRD]-literal.md"),
			["<!-- @id:[PRD]-literal -->", "## literal", "", "字面量 a.c 在此行。", ""].join("\n"),
		);
		writeDoc(
			dir,
			path.join("prd", "[PRD]-regexp.md"),
			["<!-- @id:[PRD]-regexp -->", "## regexp", "", "正则 abc 在此行。", ""].join("\n"),
		);
		return dir;
	}

	it("未给 --regexp 时按字面量：a.c 只命中字面量行", async () => {
		const dir = makeSearchSkeleton();
		const argv = ["search", "a.c"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const data = viaDispatch.data as SuccessData & { count: number; hits: Array<{ chunkId: string }> };
			expect(data.count).toBe(1);
			expect(data.hits.map((h) => h.chunkId)).toEqual(["[PRD]-literal"]);
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("显式 --regexp：a.c 同时命中 abc（命中集与字面量不同）", async () => {
		const dir = makeSearchSkeleton();
		const literal = await dispatchIn(dir, ["search", "a.c"]);
		const argv = ["search", "a.c", "--regexp"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true && literal.ok === true) {
			const regexpData = viaDispatch.data as SuccessData & {
				count: number;
				hits: Array<{ chunkId: string }>;
			};
			const literalData = literal.data as SuccessData & { count: number };
			expect(regexpData.count).toBe(2);
			expect(regexpData.hits.map((h) => h.chunkId).sort()).toEqual([
				"[PRD]-literal",
				"[PRD]-regexp",
			]);
			expect(regexpData.count).not.toBe(literalData.count);
		}
		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("非法正则：USAGE_ERROR 零副作用", async () => {
		const dir = makeSearchSkeleton();
		const before = digestTree(dir);
		const argv = ["search", "[unclosed", "--regexp"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("USAGE_ERROR");
			expect(viaDispatch.error).toContain("--regexp");
		}
		expect(digestTree(dir)).toEqual(before);

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(1);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("非项目根：非法正则仍在项目根解析前被拦为 USAGE_ERROR", async () => {
		const dir = mkTmp(); // 无 project-docs
		const viaDispatch = await dispatchIn(dir, ["search", "(", "--regexp"]);
		expect(viaDispatch.ok).toBe(false);
		if (viaDispatch.ok === false) {
			expect(viaDispatch.code).toBe("USAGE_ERROR");
		}
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// :TEST 10 — init 参数（FSD 10）
// ---------------------------------------------------------------------------

describe("init 参数", () => {
	// wrapper 按当前平台只写一种形态：Windows 为 `.cmd`，POSIX 为无扩展名脚本。
	// 另一平台形态既不写入也不参与就绪校验，故不参与任何存在性断言。
	const IS_WINDOWS = process.platform === "win32";
	const PLATFORM_WRAPPER_REL = `project-docs/.ait/${IS_WINDOWS ? "ait-cli.cmd" : "ait-cli"}`;
	const OTHER_WRAPPER_REL = `project-docs/.ait/${IS_WINDOWS ? "ait-cli" : "ait-cli.cmd"}`;

	it("init 建立完整骨架与本平台 wrapper（另一平台 wrapper 不落盘）", async () => {
		const dir = mkTmp();
		const viaDispatch = await dispatchIn(dir, ["init", "--name", "demo"]);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		for (const rel of [
			PLATFORM_WRAPPER_REL,
			"project-docs/.meta/chunks-index.yaml",
			"project-docs/.meta/specgraph.yaml",
			"project-docs/docs/prd/[PRD]-demo.md",
			"project-docs/docs/fsd/[FSD]-demo.md",
		]) {
			expect(fs.existsSync(path.join(dir, rel))).toBe(true);
		}
		expect(fs.existsSync(path.join(dir, OTHER_WRAPPER_REL))).toBe(false);
	});

	it("--check：只读报告缺失项（missing 只含本平台 wrapper），不重建、不改 .meta", async () => {
		const dir = mkTmp();
		const seeded = await dispatchIn(dir, ["init", "--name", "demo"]);
		expect(seeded.ok).toBe(true);
		const wrapper = path.join(dir, PLATFORM_WRAPPER_REL);
		fs.rmSync(wrapper, { force: true });
		const before = digestTree(dir);
		const meta = metaDigest(dir);

		const argv = ["init", "--check"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			// --check 路由到 init 域 checkProject：{ok, missing}，zero-write
			const data = viaDispatch.data as SuccessData & { ok: boolean; missing: string[] };
			expect(data.ok).toBe(false);
			expect(data.missing).toContain(PLATFORM_WRAPPER_REL);
			// 另一平台 wrapper 缺失不构成未就绪：missing 中不得出现它
			expect(data.missing).not.toContain(OTHER_WRAPPER_REL);
			const wrapperEntries = data.missing.filter((p) => p.includes(".ait/"));
			expect(wrapperEntries).toEqual([PLATFORM_WRAPPER_REL]);
		}
		// 零写入：缺失的 wrapper 没有被重建，整树字节不动
		expect(fs.existsSync(wrapper)).toBe(false);
		expect(digestTree(dir)).toEqual(before);
		expect(metaDigest(dir)).toEqual(meta);

		const viaBin = await runBin(dir, argv);
		expect(viaBin.status).toBe(0);
		expect(parseSingleJson(viaBin.stdout)).toEqual(viaDispatch);
	});

	it("--check 优先于 --refresh-wrapper：同给时零写入", async () => {
		const dir = mkTmp();
		await dispatchIn(dir, ["init", "--name", "demo"]);
		const wrapper = path.join(dir, PLATFORM_WRAPPER_REL);
		fs.rmSync(wrapper, { force: true });
		const before = digestTree(dir);
		const meta = metaDigest(dir);

		const argv = ["init", "--check", "--refresh-wrapper"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			// --check 优先：仍是只读的 checkProject 形态（不出现 createdFiles 重建结果）
			const data = viaDispatch.data as SuccessData & { ok: boolean; missing: string[] };
			expect(data.ok).toBe(false);
			expect(data.missing).toContain(PLATFORM_WRAPPER_REL);
			expect(data.missing).not.toContain(OTHER_WRAPPER_REL);
		}
		// --check 优先：wrapper 未被重写
		expect(fs.existsSync(wrapper)).toBe(false);
		expect(digestTree(dir)).toEqual(before);
		expect(metaDigest(dir)).toEqual(meta);
	});

	it("--refresh-wrapper：只重写本平台 wrapper，其余文件与 .meta 不动", async () => {
		const dir = mkTmp();
		await dispatchIn(dir, ["init", "--name", "demo"]);
		const wrapper = path.join(dir, PLATFORM_WRAPPER_REL);
		fs.rmSync(wrapper, { force: true });
		const before = digestTree(dir);
		const meta = metaDigest(dir);

		const argv = ["init", "--refresh-wrapper"];
		const viaDispatch = await dispatchIn(dir, argv);
		expect(viaDispatch.ok).toBe(true);
		expect(successData(viaDispatch).next_action).toBe(null);
		if (viaDispatch.ok === true) {
			const data = viaDispatch.data as SuccessData & { createdFiles: string[] };
			const written = data.createdFiles.map((p) => p.split(path.sep).join("/"));
			// 只写本平台形态，不跨平台预写另一形态
			expect(written).toEqual([PLATFORM_WRAPPER_REL]);
		}
		// wrapper 被重写且内容为对应平台的转发形态
		expect(fs.existsSync(wrapper)).toBe(true);
		const content = readNorm(wrapper);
		if (IS_WINDOWS) {
			expect(content.startsWith("@echo off")).toBe(true);
			expect(content).toContain("%*");
		} else {
			expect(content.startsWith("#!/bin/sh")).toBe(true);
			expect(content).toContain('exec "');
		}
		expect(fs.existsSync(path.join(dir, OTHER_WRAPPER_REL))).toBe(false);

		// 除本平台 wrapper 外字节不动；.meta 零改动
		const after = digestTree(dir);
		for (const [rel, digest] of before) {
			if (rel !== PLATFORM_WRAPPER_REL) {
				expect(after.get(rel)).toBe(digest);
			}
		}
		expect(metaDigest(dir)).toEqual(meta);
	});

	it("--new-model 为空操作：与不带该参数结果一致，且不改 .meta", async () => {
		const dirA = mkTmp();
		await dispatchIn(dirA, ["init", "--name", "demo"]);
		const dirB = mkTmp();
		await dispatchIn(dirB, ["init", "--name", "demo"]);
		const metaA = metaDigest(dirA);
		const metaB = metaDigest(dirB);

		const plain = await dispatchIn(dirA, ["init", "--name", "demo"]);
		const withFlag = await dispatchIn(dirB, ["init", "--name", "demo", "--new-model"]);
		expect(withFlag).toEqual(plain);

		// 指定与否行为相同：新建文档与 wrapper 的字节一致（.meta 含时间戳，按"重跑前后不动"核验）
		expect(metaDigest(dirA)).toEqual(metaA);
		expect(metaDigest(dirB)).toEqual(metaB);
		const docsOf = (dir: string): Map<string, string> => {
			const out = new Map<string, string>();
			const all = digestTree(path.join(dir, "project-docs"));
			for (const [rel, digest] of all) {
				if (rel.startsWith("docs/") || rel.startsWith(".ait/") || rel === ".gitignore") {
					out.set(rel, digest);
				}
			}
			return out;
		};
		expect(docsOf(dirB)).toEqual(docsOf(dirA));
		// 幂等重跑本身也不新增/改写任何文件
		expect(plain).toMatchObject({ ok: true, data: { status: "existing", next_action: null } });
		expect(plain.ok === true && (plain.data as SuccessData & { createdFiles: string[] }).createdFiles).toEqual(
			[],
		);
	});
});
