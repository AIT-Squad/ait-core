// [TDD]-search_tests — search 域两个制品（keyword_search / baseline_summary）的集成验收。
// 覆盖 [FSD]-ait-core-search:TEST 第 1~4 条全部断言点。
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
import { baselineSummary } from "../src/search/baseline-summary.js";

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
	it("空基线返回全零结构（合法，不报错）", () => {
		const root = makeProject(() => {
			// docs/ 各层目录与 .meta/versions 均缺失。
		});

		expect(baselineSummary(root)).toEqual({
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

		expect(baselineSummary(root)).toEqual({
			docs: { prd: 1, fsd: 2, tdd: 1 },
			chunks: 5,
			edges: { derives: 1, decomposes: 1, details: 1, depends_on: 1 },
			versions: ["v9.2", "v9.10"],
		});
	});
});
