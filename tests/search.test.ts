// [TDD]-search_tests — search 域两个制品（keyword_search / baseline_summary）的集成验收。
// 覆盖 [FSD]-ait-core-search:TEST 的全文检索、摘要投影与独立统计契约。
// 约束：每个用例在 os.tmpdir() 下自建临时 project-docs 工作区（含 docs 与 versions/<v>/），
// afterEach 清理；用例间零共享状态；路径断言统一为 posix 相对路径。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectRoot } from "../src/foundation/root.js";
import {
	searchChunks,
	SearchError,
	type SearchHit,
} from "../src/search/keyword-search.js";
import { IndexError } from "../src/indexing/index-manager.js";
import { baselineStats, baselineSummary } from "../src/search/baseline-summary.js";

let tmpDirs: string[] = [];

function mkTmp(): string {
	// 临时目录创建失败时用例自然 fail 并带 OS 错误（不重试）。
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-search-"));
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

/** 写文件（自动建父目录）。 */
function writeFile(abs: string, content: string): void {
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, "utf-8");
}

/**
 * 在临时目录搭建 project-docs 骨架（docs/ 与 .meta/），setup 回调填充具体内容，
 * 返回手工构造的 ProjectRoot（不经过 resolveProjectRoot 的骨架校验）。
 */
function makeProject(setup: (projDocs: string) => void): ProjectRoot {
	const cwd = mkTmp();
	const projDocs = path.join(cwd, "project-docs");
	fs.mkdirSync(path.join(projDocs, "docs"), { recursive: true });
	fs.mkdirSync(path.join(projDocs, ".meta"), { recursive: true });
	setup(projDocs);
	return {
		cwd,
		root: projDocs,
		docs: path.join(projDocs, "docs"),
		meta: path.join(projDocs, ".meta"),
	};
}

/** 按给定顺序写入真实索引；省略 summary 用于覆盖历史索引的缺省值。 */
function writeBaselineIndex(
	projDocs: string,
	chunks: Array<{ id: string; file: string; heading: string; summary?: string | null }>,
): void {
	writeFile(
		path.join(projDocs, ".meta", "chunks-index.yaml"),
		JSON.stringify({
			version: 1,
			scope: "global",
			updated: "2026-10-24T00:00:00Z",
			chunks: chunks.map((entry) => ({ level: 2, metadata: {}, ...entry })),
		}),
	);
}

/** 同时记录目录、文件字节与修改时间，防止摘要读取隐式重建或改写。 */
function snapshotTree(root: string): Record<string, { content: string | null; mtimeMs: number }> {
	const entries: Record<string, { content: string | null; mtimeMs: number }> = {};
	function visit(dir: string): void {
		for (const name of fs.readdirSync(dir).sort()) {
			const abs = path.join(dir, name);
			const stat = fs.statSync(abs);
			entries[path.relative(root, abs).replace(/\\/g, "/")] = {
				content: stat.isDirectory() ? null : fs.readFileSync(abs).toString("base64"),
				mtimeMs: stat.mtimeMs,
			};
			if (stat.isDirectory()) visit(abs);
		}
	}
	visit(root);
	return entries;
}

describe("keyword_search 命中", () => {
	it("多 chunk 命中，含 chunkId/file/heading/匹配行，按 (file, chunkId, 行号) 稳定排序", () => {
		const root = makeProject((projDocs) => {
			// beta 物理位置在 alpha 之前，但排序应按 chunkId：alpha 先于 beta。
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				[
					"# FSD A",
					"<!-- @id:[FSD]-beta -->",
					"## Beta heading",
					"beta has a portal.",
					"<!-- @id:[FSD]-alpha -->",
					"## Alpha heading",
					"The PORTAL opens here.",
					"nothing here.",
					"portal closes too.",
				].join("\n"),
			);
			writeFile(
				path.join(projDocs, "docs", "prd", "p.md"),
				[
					"# PRD",
					"<!-- @id:[PRD]-alpha -->",
					"## PRD Alpha",
					"A portal requirement.",
				].join("\n"),
			);
		});

		const hits = searchChunks(root, "portal");

		const expected: SearchHit[] = [
			{
				chunkId: "[FSD]-alpha",
				file: "docs/fsd/a.md",
				heading: "Alpha heading",
				version: null,
				matches: [
					{ line: 7, text: "The PORTAL opens here." },
					{ line: 9, text: "portal closes too." },
				],
			},
			{
				chunkId: "[FSD]-beta",
				file: "docs/fsd/a.md",
				heading: "Beta heading",
				version: null,
				matches: [{ line: 4, text: "beta has a portal." }],
			},
			{
				chunkId: "[PRD]-alpha",
				file: "docs/prd/p.md",
				heading: "PRD Alpha",
				version: null,
				matches: [{ line: 4, text: "A portal requirement." }],
			},
		];
		expect(hits).toEqual(expected);
	});

	it("大小写不敏感：大小写变体 query 命中相同集合", () => {
		const root = makeProject((projDocs) => {
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				[
					"<!-- @id:[FSD]-alpha -->",
					"## Alpha heading",
					"The PORTAL opens here.",
				].join("\n"),
			);
		});

		const lower = searchChunks(root, "portal");
		const mixed = searchChunks(root, "PoRtAl");
		expect(mixed).toEqual(lower);
		expect(lower).toHaveLength(1);
		expect(lower[0]?.matches).toEqual([
			{ line: 3, text: "The PORTAL opens here." },
		]);
	});
});

describe("keyword_search scope", () => {
	const withVersionWorkspace = (projDocs: string): void => {
		writeFile(
			path.join(projDocs, "docs", "fsd", "a.md"),
			[
				"<!-- @id:[FSD]-alpha -->",
				"## Alpha heading",
				"portal baseline.",
			].join("\n"),
		);
		writeFile(
			path.join(projDocs, "versions", "v9.9", "fsd", "a.md"),
			[
				"<!-- @id:[FSD]-alpha -->",
				"## Alpha heading v2",
				"portal version edit.",
			].join("\n"),
		);
	};

	it("scope=baseline（含缺省）只查 docs/，不含版本命中", () => {
		const root = makeProject(withVersionWorkspace);

		const explicit = searchChunks(root, "portal", { scope: "baseline" });
		const implicit = searchChunks(root, "portal");
		expect(implicit).toEqual(explicit);
		expect(explicit).toEqual([
			{
				chunkId: "[FSD]-alpha",
				file: "docs/fsd/a.md",
				heading: "Alpha heading",
				version: null,
				matches: [{ line: 3, text: "portal baseline." }],
			},
		]);
	});

	it("scope=all 追加版本工作区命中并标注 version 来源", () => {
		const root = makeProject(withVersionWorkspace);

		const hits = searchChunks(root, "portal", { scope: "all" });
		expect(hits).toEqual([
			{
				chunkId: "[FSD]-alpha",
				file: "docs/fsd/a.md",
				heading: "Alpha heading",
				version: null,
				matches: [{ line: 3, text: "portal baseline." }],
			},
			{
				chunkId: "[FSD]-alpha",
				file: "versions/v9.9/fsd/a.md",
				heading: "Alpha heading v2",
				version: "v9.9",
				matches: [{ line: 3, text: "portal version edit." }],
			},
		]);
	});
});

describe("keyword_search 边界", () => {
	it("空/纯空白 query 结构化拒绝（SearchError, SEARCH_EMPTY_QUERY）", () => {
		const root = makeProject((projDocs) => {
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				["<!-- @id:[FSD]-alpha -->", "## Alpha heading", "portal."].join("\n"),
			);
		});

		for (const query of ["", "   ", "\t\n "]) {
			let err: unknown = null;
			try {
				searchChunks(root, query);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("SEARCH_EMPTY_QUERY");
		}
	});

	it("无命中返回空数组（不报错）", () => {
		const root = makeProject((projDocs) => {
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				["<!-- @id:[FSD]-alpha -->", "## Alpha heading", "portal."].join("\n"),
			);
		});

		expect(searchChunks(root, "no-such-keyword")).toEqual([]);
	});

	it("无活动版本时 scope=all 等同 baseline（不报错）", () => {
		const root = makeProject((projDocs) => {
			// 不创建 versions/ 目录。
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				["<!-- @id:[FSD]-alpha -->", "## Alpha heading", "portal."].join("\n"),
			);
		});

		const all = searchChunks(root, "portal", { scope: "all" });
		expect(all).toEqual(searchChunks(root, "portal", { scope: "baseline" }));
		expect(all.every((h) => h.version === null)).toBe(true);
	});
});

describe("keyword_search regexp", () => {
	/**
	 * 语料：同一文件内既含大小写变体的普通词，也含形如版本号的文本，
	 * 使"字面量无命中、正则有命中"与"大小写不敏感"两态可在同一 fixture 上对照。
	 */
	const withRegexpCorpus = (projDocs: string): void => {
		writeFile(
			path.join(projDocs, "docs", "fsd", "a.md"),
			[
				"<!-- @id:[FSD]-alpha -->",
				"## Alpha heading",
				"THE PORTAL opens here.",
				"portal closes too.",
				"version v9.9 shipped.",
				"UPGRADE V10.1 now.",
			].join("\n"),
		);
	};

	it("同一 query 下正则命中与字面量命中不同", () => {
		const root = makeProject(withRegexpCorpus);

		// 字面量：语料中不存在 "v\d+\.\d+" 这段字符序列，故无命中。
		expect(searchChunks(root, "v\\d+\\.\\d+")).toEqual([]);

		// 正则：同一 query 解释为模式后命中两行版本号文本。
		expect(searchChunks(root, "v\\d+\\.\\d+", { regexp: true })).toEqual([
			{
				chunkId: "[FSD]-alpha",
				file: "docs/fsd/a.md",
				heading: "Alpha heading",
				version: null,
				matches: [
					{ line: 5, text: "version v9.9 shipped." },
					{ line: 6, text: "UPGRADE V10.1 now." },
				],
			},
		]);

		// 反向对照：不含元字符的 query 两态一致，差异只来自正则解释。
		expect(searchChunks(root, "portal", { regexp: true })).toEqual(
			searchChunks(root, "portal"),
		);
	});

	it("regexp 模式仍大小写不敏感", () => {
		const root = makeProject(withRegexpCorpus);

		const upper = searchChunks(root, "PORTAL", { regexp: true });
		const lower = searchChunks(root, "portal", { regexp: true });
		expect(lower).toEqual(upper);
		expect(upper).toHaveLength(1);
		expect(upper[0]?.matches).toEqual([
			{ line: 3, text: "THE PORTAL opens here." },
			{ line: 4, text: "portal closes too." },
		]);

		// 模式内部大小写变体同样不敏感：小写模式命中全大写文本。
		const versionHits = searchChunks(root, "v\\d+\\.\\d+", { regexp: true });
		expect(versionHits[0]?.matches.map((m) => m.line)).toEqual([5, 6]);
	});

	it("非法正则抛 SearchError(INVALID_REGEXP)，不返回部分结果", () => {
		const root = makeProject(withRegexpCorpus);

		for (const query of ["(", "*portal", "[unclosed"]) {
			let err: unknown = null;
			try {
				searchChunks(root, query, { regexp: true });
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(SearchError);
			expect((err as SearchError).code).toBe("INVALID_REGEXP");
			// 未抛错时 err 保持 null，上面两条断言即失败，不会误判为通过。
			expect(err).not.toBeNull();
		}
	});

	it("空/纯空白 query 在 regexp 模式下仍优先报 SEARCH_EMPTY_QUERY", () => {
		const root = makeProject(withRegexpCorpus);

		for (const query of ["", "   ", "\t\n "]) {
			let err: unknown = null;
			try {
				searchChunks(root, query, { regexp: true });
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(SearchError);
			// 空白被视为空 query 而非非法正则。
			expect((err as SearchError).code).toBe("SEARCH_EMPTY_QUERY");
			expect(err).not.toBeNull();
		}
	});
});

describe("baseline_summary", () => {
	const withSummaryIndex = (projDocs: string): void => {
		writeBaselineIndex(projDocs, [
			{
				id: "[FSD]-zeta",
				file: ".\\PRD\\nested\\..\\overview",
				heading: "以文件层级归入 PRD",
				summary: "  索引中的摘要\n保留换行与空格  ",
			},
			{
				id: "[PRD]-portal:entry",
				file: "archive/portal",
				heading: "入口需求",
				summary: null,
			},
			{
				id: "[PRD]-portal",
				file: "archive/portal",
				heading: "门户需求根",
			},
			{
				id: "legacy-prd",
				file: "prd/legacy",
				heading: "旧 ID 的 PRD",
				summary: "保留旧条目",
			},
			{
				id: "[PRD]-moved",
				file: "fsd/./moved",
				heading: "以文件层级归入 FSD",
				summary: "文件层级优先于 ID",
			},
			{
				id: "[FSD]-fallback",
				file: "archive/feature",
				heading: "FSD 前缀回退",
				summary: "功能摘要",
			},
			{
				id: "[TDD]-fallback",
				file: "archive/design",
				heading: "TDD 前缀回退",
				summary: "",
			},
			{
				id: "[FSD]-moved",
				file: "tdd\\moved",
				heading: "以文件层级归入 TDD",
				summary: "技术摘要",
			},
			{
				id: "prd-legacy_unknown",
				file: "archive/legacy",
				heading: "无法归层的历史条目",
				summary: "全量保留",
			},
		]);
	};

	it("缺省和空参数返回全量 scope/items，保留索引顺序、真实摘要及空值", () => {
		const root = makeProject(withSummaryIndex);
		const before = snapshotTree(root.root);
		const expected = {
			scope: "all",
			items: [
				{ id: "[FSD]-zeta", heading: "以文件层级归入 PRD", summary: "  索引中的摘要\n保留换行与空格  " },
				{ id: "[PRD]-portal:entry", heading: "入口需求", summary: null },
				{ id: "[PRD]-portal", heading: "门户需求根", summary: null },
				{ id: "legacy-prd", heading: "旧 ID 的 PRD", summary: "保留旧条目" },
				{ id: "[PRD]-moved", heading: "以文件层级归入 FSD", summary: "文件层级优先于 ID" },
				{ id: "[FSD]-fallback", heading: "FSD 前缀回退", summary: "功能摘要" },
				{ id: "[TDD]-fallback", heading: "TDD 前缀回退", summary: "" },
				{ id: "[FSD]-moved", heading: "以文件层级归入 TDD", summary: "技术摘要" },
				{ id: "prd-legacy_unknown", heading: "无法归层的历史条目", summary: "全量保留" },
			],
		};

		expect(baselineSummary(root)).toEqual(expected);
		expect(baselineSummary(root, {})).toEqual(expected);
		expect(snapshotTree(root.root)).toEqual(before);
	});

	it.each([
		["prd", ["[FSD]-zeta", "[PRD]-portal:entry", "[PRD]-portal", "legacy-prd"]],
		["fsd", ["[PRD]-moved", "[FSD]-fallback"]],
		["tdd", ["[TDD]-fallback", "[FSD]-moved"]],
	] as const)("scope=%s 按规范化文件层级优先、ID 前缀回退筛选并保留顺序", (scope, ids) => {
		const root = makeProject(withSummaryIndex);
		const before = snapshotTree(root.root);
		const result = baselineSummary(root, { scope });

		expect(result.scope).toBe(scope);
		expect(result.items.map((item) => item.id)).toEqual(ids);
		if (scope === "prd") {
			expect(result.items.slice(1, 3)).toEqual([
				{ id: "[PRD]-portal:entry", heading: "入口需求", summary: null },
				{ id: "[PRD]-portal", heading: "门户需求根", summary: null },
			]);
		}
		expect(snapshotTree(root.root)).toEqual(before);
	});

	it.each(["missing", "empty"] as const)("%s 基线索引返回空摘要，读取不创建或重建索引", (state) => {
		const root = makeProject((projDocs) => {
			// 磁盘存在文档也不能取代空/缺失索引的事实。
			writeFile(path.join(projDocs, "docs", "prd", "unindexed.md"),
				"<!-- @id:[PRD]-unindexed -->\n## 尚未建索引\n正文不是摘要。\n");
			if (state === "empty") writeBaselineIndex(projDocs, []);
		});
		const before = snapshotTree(root.root);

		expect(baselineSummary(root)).toEqual({ scope: "all", items: [] });
		for (const scope of ["prd", "fsd", "tdd"] as const) {
			expect(baselineSummary(root, { scope })).toEqual({ scope, items: [] });
		}
		expect(snapshotTree(root.root)).toEqual(before);
	});

	it("指定层无条目返回空数组，不影响其他层的摘要", () => {
		const root = makeProject((projDocs) => {
			writeBaselineIndex(projDocs, [
				{ id: "[FSD]-only", file: "fsd/only", heading: "仅功能设计", summary: null },
			]);
		});

		expect(baselineSummary(root, { scope: "prd" })).toEqual({ scope: "prd", items: [] });
		expect(baselineSummary(root, { scope: "tdd" })).toEqual({ scope: "tdd", items: [] });
		expect(baselineSummary(root)).toEqual({
			scope: "all",
			items: [{ id: "[FSD]-only", heading: "仅功能设计", summary: null }],
		});
	});

	it("只投影基线索引，不扫描正文、不混入活动版本或改写任何文件", () => {
		const root = makeProject((projDocs) => {
			writeBaselineIndex(projDocs, [
				{ id: "[PRD]-portal", file: "prd/portal", heading: "索引标题", summary: "基线摘要" },
			]);
			writeFile(path.join(projDocs, "docs", "prd", "portal.md"), [
				"<!-- @id:[PRD]-portal -->", "## 磁盘标题", "<!-- @summary:正文摘要 -->",
				"<!-- @id:[PRD]-unindexed -->", "## 不在索引中", "不得自动重建。",
			].join("\n"));
			writeFile(path.join(projDocs, "versions", "v9.9", "prd", "portal.md"), [
				"<!-- @id:[PRD]-portal -->", "## 版本标题", "<!-- @summary:版本摘要 -->",
				"<!-- @id:[PRD]-version_only -->", "## 版本新增", "仅存在版本中。",
			].join("\n"));
			writeFile(path.join(projDocs, ".meta", "versions", "v9.9.yaml"),
				"version: v9.9\ncreated_at: '2026-10-24T00:00:00Z'\nphase: prd-creating\n");
			writeFile(path.join(projDocs, ".meta", "chunks-index-v9.9.yaml"), JSON.stringify({
				version: 1,
				version_name: "v9.9",
				chunks: [
					{ id: "[PRD]-portal", file: "prd/portal", heading: "版本标题", level: 2, summary: "版本摘要", action: "modify", state: "working" },
					{ id: "[PRD]-version_only", file: "prd/portal", heading: "版本新增", level: 2, summary: "仅版本摘要", action: "add", state: "working" },
				],
			}));
		});
		const before = snapshotTree(root.root);
		const items = [{ id: "[PRD]-portal", heading: "索引标题", summary: "基线摘要" }];

		expect(baselineSummary(root)).toEqual({ scope: "all", items });
		expect(baselineSummary(root, { scope: "prd" })).toEqual({ scope: "prd", items });
		expect(snapshotTree(root.root)).toEqual(before);
	});

	it.each([
		["非法 YAML", "chunks: [unclosed\n"],
		["字段类型损坏", JSON.stringify({ chunks: [
			{ id: "[PRD]-valid", file: "prd/valid", heading: "可读条目", level: 2, summary: "不可返回部分结果" },
			{ id: "[FSD]-broken", file: "fsd/broken", heading: 123, level: 2 },
		] })],
	])("%s 透传 INDEX_UNREADABLE，scope 过滤不能隐藏损坏", (_label, content) => {
		const root = makeProject((projDocs) => {
			writeFile(path.join(projDocs, ".meta", "chunks-index.yaml"), content);
		});
		const before = snapshotTree(root.root);
		for (const scope of [undefined, "prd", "fsd", "tdd"] as const) {
			let err: unknown;
			try {
				baselineSummary(root, scope === undefined ? undefined : { scope });
			} catch (caught) {
				err = caught;
			}
			expect(err).toBeInstanceOf(IndexError);
			expect(err).toMatchObject({ code: "INDEX_UNREADABLE" });
			expect((err as Error).message).toContain(path.join(root.meta, "chunks-index.yaml"));
		}
		expect(snapshotTree(root.root)).toEqual(before);
	});

	it.each(["all", "baseline", "PRD", "", null, 123])("非法 scope=%s 返回 USAGE_ERROR，零写入", (scope) => {
		const root = makeProject(withSummaryIndex);
		const before = snapshotTree(root.root);
		// 模拟 JavaScript 调用者绕过静态类型，检查领域运行时输入约束。
		expect(() => Reflect.apply(baselineSummary, undefined, [root, { scope }])).toThrowError(
			expect.objectContaining({ code: "USAGE_ERROR" }),
		);
		expect(snapshotTree(root.root)).toEqual(before);
	});
});

describe("baseline_stats", () => {
	it("空基线返回全零结构（合法，不报错）", () => {
		const root = makeProject(() => {
			// docs/ 各层目录与 .meta/versions 均缺失。
		});

		expect(baselineStats(root)).toEqual({
			docs: { prd: 0, fsd: 0, tdd: 0 },
			chunks: 0,
			edges: { derives: 0, decomposes: 0, details: 0, depends_on: 0 },
			versions: [],
		});
	});

	it("非空基线 docs/chunks/edges/versions 计数正确，版本按数值序", () => {
		const root = makeProject((projDocs) => {
			writeFile(
				path.join(projDocs, "docs", "prd", "p.md"),
				["<!-- @id:[PRD]-alpha -->", "## PRD Alpha", "body."].join("\n"),
			);
			writeFile(
				path.join(projDocs, "docs", "fsd", "a.md"),
				[
					"<!-- @id:[FSD]-alpha -->",
					"## FSD Alpha",
					"body.",
					"<!-- @id:[FSD]-beta -->",
					"## FSD Beta",
					"body.",
				].join("\n"),
			);
			writeFile(
				path.join(projDocs, "docs", "fsd", "b.md"),
				["<!-- @id:[FSD]-gamma -->", "## FSD Gamma", "body."].join("\n"),
			);
			writeFile(
				path.join(projDocs, "docs", "tdd", "t.md"),
				["<!-- @id:[TDD]-delta -->", "## TDD Delta", "body."].join("\n"),
			);
			// 基线图：specs 为节点数组（与 Python 当前形态一致）、四种 rel 各一条边。
			// 节点 uri = spec:<type>:<version>:<chunk_id>，file 为去扩展名的 docs 相对路径。
			const nodes: [string, string, string][] = [
				["[PRD]-alpha", "prd", "prd/p"],
				["[FSD]-alpha", "fsd", "fsd/a"],
				["[FSD]-beta", "fsd", "fsd/a"],
				["[FSD]-gamma", "fsd", "fsd/b"],
				["[TDD]-delta", "tdd", "tdd/t"],
			];
			const edges: [string, string, string][] = [
				["spec:prd:baseline:[PRD]-alpha", "spec:fsd:baseline:[FSD]-alpha", "derives"],
				["spec:fsd:baseline:[FSD]-alpha", "spec:fsd:baseline:[FSD]-beta", "decomposes"],
				["spec:fsd:baseline:[FSD]-beta", "spec:tdd:baseline:[TDD]-delta", "details"],
				["spec:fsd:baseline:[FSD]-alpha", "spec:fsd:baseline:[FSD]-gamma", "depends_on"],
			];
			writeFile(
				path.join(projDocs, ".meta", "specgraph.yaml"),
				[
					"version: 1",
					`updated: "${new Date().toISOString()}"`,
					"specs:",
					...nodes.flatMap(([chunkId, type, file]) => [
						`- uri: "spec:${type}:baseline:${chunkId}"`,
						`  title: "${chunkId} 标题"`,
						`  type: ${type}`,
						"  version: baseline",
						`  chunk_id: "${chunkId}"`,
						`  file: ${file}`,
						"  metadata:",
						"    source: baseline",
					]),
					"edges:",
					...edges.flatMap(([src, dst, rel]) => [
						`- src: "${src}"`,
						`  dst: "${dst}"`,
						`  rel: ${rel}`,
						"  weight: 1.0",
						"  metadata:",
						"    source: baseline",
					]),
				].join("\n"),
			);
			// 字典序 v9.10 < v9.2，数值序应 v9.2 在前。
			// 版本元数据按 Python 当前形态：version/created_at 必填，其余取缺省。
			for (const v of ["v9.10", "v9.2"]) {
				writeFile(
					path.join(projDocs, ".meta", "versions", `${v}.yaml`),
					[
						`version: ${v}`,
						`created_at: "${new Date().toISOString()}"`,
						"owner: system",
						"changes: []",
						"snapshot: null",
						"phase: empty",
						"title: null",
						"prd_locked: false",
						"impl_locked: false",
					].join("\n"),
				);
			}
		});

		expect(baselineStats(root)).toEqual({
			docs: { prd: 1, fsd: 2, tdd: 1 },
			chunks: 5,
			edges: { derives: 1, decomposes: 1, details: 1, depends_on: 1 },
			versions: ["v9.2", "v9.10"],
		});
	});
});
