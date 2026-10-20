// [TDD]-indexing_tests — indexing 域制品（IndexManager）的集成验收。
// 覆盖 [FSD]-ait-core-indexing:TEST 第 1~5 条全部断言点。
// 约束：每个用例在 os.tmpdir() 下自建 project-docs 骨架（docs/{prd,fsd,tdd} + .meta/versions），
// 用例间零共享状态；路径断言经 toPosixRel 归一。
// 真实语料用例只读原目录——先整体拷贝到临时目录再操作；语料不存在时 skip 并打印原因。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

import { resolveProjectRoot } from "../src/foundation/root.js";
import { toPosixRel } from "../src/foundation/io.js";
import {
  IndexManager,
  IndexError,
  VersionIndexError,
  type VersionChunkEntry,
  type VersionIndex,
} from "../src/indexing/index-manager.js";

let tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-indexing-"));
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

/** 在 base 下搭建 project-docs 骨架（docs/{prd,fsd,tdd} + .meta/versions），返回 IndexManager 与骨架路径。 */
function setup(base: string): {
  im: IndexManager;
  docsRoot: string;
  metaRoot: string;
} {
  const root = path.join(base, "project-docs");
  const docsRoot = path.join(root, "docs");
  const metaRoot = path.join(root, ".meta");
  for (const layer of ["prd", "fsd", "tdd"]) {
    fs.mkdirSync(path.join(docsRoot, layer), { recursive: true });
  }
  fs.mkdirSync(path.join(metaRoot, "versions"), { recursive: true });
  const im = new IndexManager(resolveProjectRoot(base));
  return { im, docsRoot, metaRoot };
}

// ---------------------------------------------------------------------------
// fixture：三份文档，覆盖 prd/fsd/tdd 三层，共 4 个 chunk；均无 @summary 注释
// ---------------------------------------------------------------------------

const ALPHA_MD = `# Alpha 文档

<!-- @id:[PRD]-alpha -->
## Alpha 需求
alpha 正文第一行，非空且不是任何摘要。

<!-- @id:[PRD]-beta -->
## Beta 需求
beta 正文。
`;

const GAMMA_MD = `# Gamma 文档

<!-- @id:[FSD]-gamma -->
## Gamma 分解
gamma 正文。
`;

const DELTA_MD = `# Delta 文档

<!-- @id:[TDD]-delta -->
## Delta 设计
delta 正文。
`;

/** 写入含若干 chunk 的 prd/fsd/tdd 文件。 */
function writeDocs(docsRoot: string): void {
  fs.writeFileSync(path.join(docsRoot, "prd", "alpha.md"), ALPHA_MD, "utf8");
  fs.writeFileSync(path.join(docsRoot, "fsd", "gamma.md"), GAMMA_MD, "utf8");
  fs.writeFileSync(path.join(docsRoot, "tdd", "delta.md"), DELTA_MD, "utf8");
}

/** 取某 chunk 的正文区间（用于人工在文档里插 @summary 注释）。 */
const BETA_BLOCK = `<!-- @id:[PRD]-beta -->
## Beta 需求
beta 正文。`;

/** 把 alpha.md 里 beta chunk 的正文替换为给定块，返回写回的完整文本。 */
function alphaWithBetaBlock(block: string): string {
  return ALPHA_MD.replace(BETA_BLOCK, block);
}

/** 读基线索引文件为裸对象（用于人工注入既有摘要）。 */
function readBaselineModel(metaRoot: string): {
  chunks: { id: string; summary: string | null }[];
} {
  const text = fs.readFileSync(path.join(metaRoot, "chunks-index.yaml"), "utf8");
  return parseYaml(text) as { chunks: { id: string; summary: string | null }[] };
}

/** 把基线索引里某 id 的摘要改写为给定值（含 null），写回磁盘。 */
function patchBaselineSummary(
  metaRoot: string,
  chunkId: string,
  summary: string | null,
): void {
  const p = path.join(metaRoot, "chunks-index.yaml");
  const model = readBaselineModel(metaRoot);
  const entry = model.chunks.find((c) => c.id === chunkId);
  if (entry === undefined) {
    throw new Error(`基线索引缺少 chunk: ${chunkId}`);
  }
  entry.summary = summary;
  fs.writeFileSync(p, JSON.stringify(model, null, 2), "utf8");
}

/** 构造版本记录（默认字段齐备，可覆写任意字段）。 */
function versionEntry(
  overrides: Partial<VersionChunkEntry> & { id: string },
): VersionChunkEntry {
  return {
    file: "prd/alpha",
    heading: "Alpha 需求",
    level: 2,
    action: "modify",
    state: "working",
    commit_id: null,
    overrides: null,
    amends: null,
    insert_after: null,
    base_hash: null,
    source_req: null,
    discussion_usage: null,
    summary: null,
    metadata: {},
    ...overrides,
  };
}

/** 构造版本索引；stats 故意填错以验证 save 时自动重算。 */
function makeVersionIndex(): VersionIndex {
  return {
    version: 1,
    scope: "version",
    version_name: "v9.9",
    based_on_hash: null,
    status: "developing",
    chunks: [
      // 同 id 三条：working、staged、committed——当前条目应取 committed 中 commit_id 最大者
      versionEntry({
        id: "[PRD]-alpha",
        action: "add",
        state: "working",
        heading: "Alpha 需求 v1",
        summary: "首次写入",
      }),
      versionEntry({
        id: "[PRD]-alpha",
        state: "staged",
        heading: "Alpha 需求 v2",
        summary: "二次写入",
      }),
      versionEntry({
        id: "[PRD]-alpha",
        state: "committed",
        commit_id: "c2",
        heading: "Alpha 需求 v3",
        summary: "三次写入",
      }),
      versionEntry({
        id: "[PRD]-alpha",
        state: "committed",
        commit_id: "c10",
        heading: "Alpha 需求 v4",
        summary: "四次写入",
      }),
      versionEntry({
        id: "[FSD]-gamma",
        file: "fsd/gamma",
        heading: "Gamma 分解",
        state: "committed",
        commit_id: "c1",
        summary: "gamma 修改",
      }),
      versionEntry({
        id: "[TDD]-delta",
        file: null,
        heading: null,
        level: null,
        action: "delete",
        state: "working",
      }),
    ],
    commits: [],
    stats: {
      total_chunks: 99,
      by_action: { add: 99, modify: 99 },
      by_state: { working: 99, staged: 99, committed: 99 },
      tasks_summary: {},
    },
  };
}

// ---------------------------------------------------------------------------

describe("rebuildBaseline", () => {
  it("全部 chunk 入索引且 id/file/heading/level/summary/metadata 字段齐备、无 hash（:TEST 第 1 条）", () => {
    const { im, metaRoot } = setup(mkTmp());
    writeDocs(path.join(path.dirname(metaRoot), "docs"));

    const index = im.rebuildBaseline();

    // 四个 chunk 全部入索引，按 id 排序
    expect(index.chunks.map((r) => r.id)).toEqual([
      "[FSD]-gamma",
      "[PRD]-alpha",
      "[PRD]-beta",
      "[TDD]-delta",
    ]);

    const alpha = index.chunks.find((r) => r.id === "[PRD]-alpha");
    expect(alpha).toBeDefined();
    // 字段齐备且取值正确
    expect(Object.keys(alpha ?? {}).sort()).toEqual([
      "file",
      "heading",
      "id",
      "level",
      "metadata",
      "summary",
    ]);
    expect(alpha?.file).toBe("prd/alpha");
    expect(alpha?.heading).toBe("Alpha 需求");
    expect(alpha?.level).toBe(2);
    expect(alpha?.metadata).toEqual({});
    // 索引不存内容哈希
    expect(alpha).not.toHaveProperty("hash");

    // file 字段为去 .md 的 posix 相对路径（经 toPosixRel 归一断言）
    const gamma = index.chunks.find((r) => r.id === "[FSD]-gamma");
    expect(toPosixRel("", gamma?.file ?? "")).toBe("fsd/gamma");
    const delta = index.chunks.find((r) => r.id === "[TDD]-delta");
    expect(delta?.level).toBe(2);
    expect(delta?.heading).toBe("Delta 设计");

    // baseline 索引不含统计字段（统计只属版本索引）
    expect(index).not.toHaveProperty("stats");

    // 索引已原子落盘
    expect(fs.existsSync(path.join(metaRoot, "chunks-index.yaml"))).toBe(true);
  });

  it("重复重建结果一致（幂等）", () => {
    const { im, docsRoot } = setup(mkTmp());
    writeDocs(docsRoot);

    const first = im.rebuildBaseline();
    const second = im.rebuildBaseline();

    expect(second.chunks).toEqual(first.chunks);
    expect(second.version).toEqual(first.version);
    expect(second.scope).toEqual(first.scope);
    // updated 字段是有效的 ISO 时间戳
    expect(second.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("docs/ 下三层目录外的 markdown 不参与基线（只扫 prd/fsd/tdd）", () => {
    const { im, docsRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    fs.writeFileSync(
      path.join(docsRoot, "loose.md"),
      "<!-- @id:[PRD]-loose -->\n## Loose\n正文。\n",
      "utf8",
    );

    const index = im.rebuildBaseline();
    expect(index.chunks.map((r) => r.id)).not.toContain("[PRD]-loose");
  });
});

describe("摘要沿用", () => {
  it("无 @summary 而旧索引该 id 有摘要 → 沿用旧值（既不清空也不派生首行）", () => {
    const { im, docsRoot, metaRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    im.rebuildBaseline();
    // 解析所得摘要为 null（文档无 @summary 注释），先手工把该 id 的摘要改为人工值
    expect(readBaselineModel(metaRoot).chunks.find((c) => c.id === "[PRD]-alpha")?.summary).toBeNull();
    patchBaselineSummary(metaRoot, "[PRD]-alpha", "人工摘要");

    const rebuilt = im.rebuildBaseline();

    // 沿用而非清空，也未被首行/标题覆盖
    expect(rebuilt.chunks.find((r) => r.id === "[PRD]-alpha")?.summary).toBe("人工摘要");
    expect(readBaselineModel(metaRoot).chunks.find((c) => c.id === "[PRD]-alpha")?.summary).toBe(
      "人工摘要",
    );
  });

  it("文档 chunk 带 @summary → 用解析值覆盖旧值", () => {
    const { im, docsRoot, metaRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    im.rebuildBaseline();
    patchBaselineSummary(metaRoot, "[PRD]-beta", "旧摘要");

    // 给 beta chunk 加 @summary 元注释后重建
    fs.writeFileSync(
      path.join(docsRoot, "prd", "alpha.md"),
      alphaWithBetaBlock(
        `<!-- @id:[PRD]-beta -->
<!-- @summary: 新摘要 -->
## Beta 需求
beta 正文。`,
      ),
      "utf8",
    );

    const rebuilt = im.rebuildBaseline();

    expect(rebuilt.chunks.find((r) => r.id === "[PRD]-beta")?.summary).toBe("新摘要");
    // 未受影响的 chunk 摘要仍沿用
    expect(rebuilt.chunks.find((r) => r.id === "[PRD]-alpha")?.summary).toBeNull();
  });

  it("旧索引该 id 摘要为 null → 重建后仍为 null（绝不派生首行）", () => {
    const { im, docsRoot, metaRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    im.rebuildBaseline();
    // 该 chunk 无 @summary 注释、正文首行非空——若实现派生首行，此处必非 null
    patchBaselineSummary(metaRoot, "[PRD]-alpha", null);

    const rebuilt = im.rebuildBaseline();

    const alpha = rebuilt.chunks.find((r) => r.id === "[PRD]-alpha");
    expect(alpha?.summary).toBeNull();
    expect(alpha?.summary).not.toBe("## Alpha 需求");
    expect(alpha?.summary).not.toBe("Alpha 需求");
  });

  it("旧索引不存在（首次重建）→ 无 @summary 的 chunk 摘要为 null", () => {
    const { im, docsRoot, metaRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    expect(fs.existsSync(path.join(metaRoot, "chunks-index.yaml"))).toBe(false);

    const index = im.rebuildBaseline();

    for (const entry of index.chunks) {
      expect(entry.summary).toBeNull();
    }
  });
});

describe("saveVersionIndex+stats", () => {
  it("save 时 stats 的 total_chunks/by_action/by_state 自动重算并与实际 chunks 一致（:TEST 第 2 条）", () => {
    const { im } = setup(mkTmp());
    const index = makeVersionIndex();

    im.saveVersionIndex(index);

    const loaded = im.loadVersionIndex("v9.9");

    // 传入的错误 stats 被覆盖重算
    expect(loaded.stats).toEqual({
      total_chunks: 6,
      by_state: { working: 2, staged: 1, committed: 3 },
      by_action: { add: 1, modify: 4, delete: 1 },
      tasks_summary: {},
    });
    // stats 三键与实际 chunks 一致
    expect(loaded.stats.total_chunks).toBe(loaded.chunks.length);
    expect(loaded.stats.by_state["working"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.state === "working").length,
    );
    expect(loaded.stats.by_state["staged"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.state === "staged").length,
    );
    expect(loaded.stats.by_state["committed"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.state === "committed").length,
    );
    expect(loaded.stats.by_action["add"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.action === "add").length,
    );
    expect(loaded.stats.by_action["modify"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.action === "modify").length,
    );
    expect(loaded.stats.by_action["delete"] ?? 0).toBe(
      loaded.chunks.filter((r) => r.action === "delete").length,
    );
    // chunks 内容原样保留
    expect(loaded.chunks).toEqual(index.chunks);
  });

  it("写已合入版本（status=merged）的索引 → INDEX_READONLY 且文件字节不变", () => {
    const { im, metaRoot } = setup(mkTmp());
    // 手工写入 merged 版本索引
    const mergedPath = path.join(metaRoot, "chunks-index-v1.0.yaml");
    const mergedYaml = [
      "version: 1",
      "scope: version",
      "version_name: v1.0",
      "based_on_hash: null",
      "status: merged",
      "chunks:",
      "- id: '[PRD]-alpha'",
      "  file: prd/alpha",
      "  heading: Alpha 需求",
      "  level: 2",
      "  action: modify",
      "  state: committed",
      "  commit_id: c1",
      "  overrides: null",
      "  amends: null",
      "  insert_after: null",
      "  base_hash: null",
      "  source_req: null",
      "  discussion_usage: null",
      "  summary: null",
      "  metadata: {}",
      "commits: []",
      "stats:",
      "  total_chunks: 1",
      "  by_action:",
      "    modify: 1",
      "  by_state:",
      "    committed: 1",
      "  tasks_summary: {}",
      "",
    ].join("\n");
    fs.writeFileSync(mergedPath, mergedYaml, "utf8");
    const before = fs.readFileSync(mergedPath);

    const attempt: VersionIndex = {
      ...makeVersionIndex(),
      version_name: "v1.0",
      status: "merged",
    };
    let caught: unknown = null;
    try {
      im.saveVersionIndex(attempt);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IndexError);
    expect((caught as IndexError).code).toBe("INDEX_READONLY");
    // 零写入：文件字节完全未变
    expect(fs.readFileSync(mergedPath).equals(before)).toBe(true);
    expect(fs.readFileSync(mergedPath, "utf8")).toBe(mergedYaml);
  });

  it("开放版本（developing）可写；二次 save 仍重算 stats（不被上一轮 stats 污染）", () => {
    const { im } = setup(mkTmp());
    const first = makeVersionIndex();
    im.saveVersionIndex(first);

    const second: VersionIndex = {
      ...makeVersionIndex(),
      chunks: [versionEntry({ id: "[PRD]-alpha", state: "staged" })],
    };
    im.saveVersionIndex(second);

    const loaded = im.loadVersionIndex("v9.9");
    expect(loaded.stats).toEqual({
      total_chunks: 1,
      by_action: { modify: 1 },
      by_state: { staged: 1 },
      tasks_summary: {},
    });
  });
});

describe("query", () => {
  it("查询存在的 chunk 返回条目；不存在返回 null（:TEST 第 3 条）", () => {
    const { im, metaRoot } = setup(mkTmp());
    writeDocs(path.join(path.dirname(metaRoot), "docs"));
    im.rebuildBaseline();

    const hit = im.queryBaseline("[TDD]-delta");
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("[TDD]-delta");
    expect(hit?.file).toBe("tdd/delta");
    expect(hit?.heading).toBe("Delta 设计");

    expect(im.queryBaseline("[PRD]-ghost")).toBeNull();
  });

  it("queryVersion 存在返回条目；不存在返回 null", () => {
    const { im } = setup(mkTmp());
    im.saveVersionIndex(makeVersionIndex());

    const hit = im.queryVersion("v9.9", "[FSD]-gamma");
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("[FSD]-gamma");

    expect(im.queryVersion("v9.9", "[TDD]-ghost")).toBeNull();
  });

  it("同 chunk 多条版本记录：allVersionRecords 按序返回，queryVersion 取最新（:TEST 第 3 条）", () => {
    const { im } = setup(mkTmp());
    im.saveVersionIndex(makeVersionIndex());

    const all = im.allVersionRecords("v9.9", "[PRD]-alpha");
    expect(all).toHaveLength(4);
    // 按写入序
    expect(all.map((r) => r.heading)).toEqual([
      "Alpha 需求 v1",
      "Alpha 需求 v2",
      "Alpha 需求 v3",
      "Alpha 需求 v4",
    ]);
    expect(all.map((r) => r.state)).toEqual([
      "working",
      "staged",
      "committed",
      "committed",
    ]);

    // 当前条目：committed 中 commit_id 数值最大者（c10 > c2，非字典序），
    // 优先于 staged 与 working
    const current = im.queryVersion("v9.9", "[PRD]-alpha");
    expect(current?.heading).toBe("Alpha 需求 v4");
    expect(current?.commit_id).toBe("c10");
    expect(current?.state).toBe("committed");

    // 无同名记录返回空数组
    expect(im.allVersionRecords("v9.9", "[PRD]-beta")).toEqual([]);
  });

  it("同 id 多条但无 committed：staged 优先于 working", () => {
    const { im } = setup(mkTmp());
    im.saveVersionIndex({
      ...makeVersionIndex(),
      chunks: [
        versionEntry({ id: "[PRD]-alpha", state: "working", heading: "working 条" }),
        versionEntry({ id: "[PRD]-alpha", state: "staged", heading: "staged 条" }),
      ],
    });

    expect(im.queryVersion("v9.9", "[PRD]-alpha")?.heading).toBe("staged 条");
  });
});

describe("listVersions", () => {
  it("按数值 (major, minor) 排序：v2.10 在 v2.9 之后，非字典序（:TEST 第 4 条）", () => {
    const { im, metaRoot } = setup(mkTmp());
    const versionsDir = path.join(metaRoot, "versions");
    for (const v of ["v2.10", "v1.0", "v2.9", "v10.1"]) {
      fs.writeFileSync(path.join(versionsDir, `${v}.yaml`), "version: x\n");
    }
    // 非 v*.yaml 文件不参与枚举
    fs.writeFileSync(path.join(versionsDir, "notes.txt"), "x");
    fs.writeFileSync(path.join(versionsDir, "other.yaml"), "x");

    expect(im.listVersions()).toEqual(["v1.0", "v2.9", "v2.10", "v10.1"]);
  });

  it("空目录与目录缺失均返回空数组", () => {
    const { im, metaRoot } = setup(mkTmp());
    expect(im.listVersions()).toEqual([]);

    fs.rmSync(path.join(metaRoot, "versions"), { recursive: true });
    expect(im.listVersions()).toEqual([]);
  });
});

describe("错误边界", () => {
  it("baseline 索引文件缺失 → 返回空索引（chunks: []），查询返回 null", () => {
    const { im } = setup(mkTmp());
    const index = im.loadBaseline();
    expect(index.chunks).toEqual([]);
    expect(index.scope).toBe("global");
    // 空索引上查询返回 null
    expect(im.queryBaseline("[PRD]-alpha")).toBeNull();
  });

  it("版本索引文件缺失 → VersionIndexError(VERSION_NOT_FOUND)", () => {
    const { im } = setup(mkTmp());
    try {
      im.loadVersionIndex("v0.0");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionIndexError);
      expect((err as VersionIndexError).code).toBe("VERSION_NOT_FOUND");
    }
    // 查询与列举缺失版本同样抛 VERSION_NOT_FOUND（而非返回 null）
    expect(() => im.queryVersion("v0.0", "[PRD]-alpha")).toThrowError(
      VersionIndexError,
    );
    expect(() => im.allVersionRecords("v0.0", "[PRD]-alpha")).toThrowError(
      VersionIndexError,
    );
  });

  it("索引文件损坏 → IndexError(INDEX_UNREADABLE)，fail closed", () => {
    const { im, metaRoot } = setup(mkTmp());

    // baseline：非法 YAML
    const baselinePath = path.join(metaRoot, "chunks-index.yaml");
    fs.writeFileSync(baselinePath, "ok: 1\nbad: [unclosed\n", "utf8");
    try {
      im.loadBaseline();
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(IndexError);
      expect((err as IndexError).code).toBe("INDEX_UNREADABLE");
    }
    fs.rmSync(baselinePath);

    // 版本索引：合法 YAML 但 schema 不符（fail closed，不放行）
    const versionPath = path.join(metaRoot, "chunks-index-v1.0.yaml");
    fs.writeFileSync(versionPath, "version: v1.0\nrecords: not-a-list\n", "utf8");
    try {
      im.loadVersionIndex("v1.0");
      expect.unreachable("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(IndexError);
      expect((err as IndexError).code).toBe("INDEX_UNREADABLE");
    }

    // 损坏的 merged 版本索引：save 拒绝读取而非照写，零写入
    const mergedPath = path.join(metaRoot, "chunks-index-v2.0.yaml");
    fs.writeFileSync(mergedPath, "status: [unclosed\n", "utf8");
    const before = fs.readFileSync(mergedPath);
    expect(() =>
      im.saveVersionIndex({ ...makeVersionIndex(), version_name: "v2.0" }),
    ).toThrowError(IndexError);
    expect(fs.readFileSync(mergedPath).equals(before)).toBe(true);
  });

  it("baseline 索引损坏时重建 fail closed（不静默丢历史摘要）", () => {
    const { im, docsRoot, metaRoot } = setup(mkTmp());
    writeDocs(docsRoot);
    fs.writeFileSync(path.join(metaRoot, "chunks-index.yaml"), "bad: [unclosed\n", "utf8");

    let caught: unknown = null;
    try {
      im.rebuildBaseline();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexError);
    expect((caught as IndexError).code).toBe("INDEX_UNREADABLE");
  });
});

// ---------------------------------------------------------------------------
// 真实语料（:TEST 第 5 条）——AIT-project 的 project-docs 副本与 ait-core 自身
// ---------------------------------------------------------------------------

const REPO_PROJECT_DOCS = path.resolve(import.meta.dirname, "..", "project-docs");

/** AIT_CORPUS_DIRS（";" 分隔）→ 存在的 project-docs 目录列表；缺省为 ait-core 自身。 */
function corpusProjectDocs(): { configured: string[]; existing: string[] } {
  const raw = process.env["AIT_CORPUS_DIRS"];
  const configured =
    raw !== undefined && raw.trim() !== ""
      ? raw
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : [REPO_PROJECT_DOCS];
  // 容忍两种给法：project-docs 目录本身，或它的 .meta 目录
  return {
    configured,
    existing: configured
      .map((item) =>
        path.basename(item) === ".meta" ? path.dirname(item) : item,
      )
      .filter(
        (dir) =>
          fs.existsSync(path.join(dir, "docs")) &&
          fs.existsSync(path.join(dir, ".meta")),
      ),
  };
}

/** 整体拷贝 project-docs 到临时目录（跳过 .git，避免无谓的体积与文件锁）。 */
function copyProjectDocs(src: string, base: string): string {
  const dst = path.join(base, "project-docs");
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !p.split(path.sep).includes(".git"),
  });
  return dst;
}

/** 递归收集 .md 文件（用于核对 chunk 数）。 */
function listMd(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMd(p));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 版本索引文件的字节指纹（重建后应逐文件不变）。 */
function versionIndexDigests(metaRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of fs.readdirSync(metaRoot)) {
    if (!name.startsWith("chunks-index-v") || !name.endsWith(".yaml")) continue;
    const bytes = fs.readFileSync(path.join(metaRoot, name));
    out.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return out;
}

/** 文件中 chunks 列表长度（与 loadVersionIndex 结果的 chunk 数核对）。 */
function rawChunkCount(p: string): number {
  const model = parseYaml(fs.readFileSync(p, "utf8")) as { chunks?: unknown[] };
  return Array.isArray(model.chunks) ? model.chunks.length : 0;
}

/** 独占一行的 `<!-- @id:... -->` 定界行数（代码围栏内不计），即 chunk-parser 的识别口径。 */
function countIdDirectives(text: string): number {
  const WHOLE_LINE_ID = /^\s*<!--\s*@id:[^\s>]+?\s*-->\s*$/;
  const FENCE = /^\s*```/;
  let inFence = false;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      // 围栏定界行本身按围栏内处理
      inFence = !inFence;
      continue;
    }
    if (!inFence && WHOLE_LINE_ID.test(line)) count += 1;
  }
  return count;
}

describe("真实语料", () => {
  const corpus = corpusProjectDocs();
  const skipped = corpus.existing.length === 0;
  if (skipped) {
    console.warn(
      `真实语料用例 skip：AIT_CORPUS_DIRS 未指向任何含 docs/ 与 .meta/ 的 project-docs 目录；` +
        `配置值 = ${JSON.stringify(corpus.configured)}`,
    );
  } else {
    console.info(
      `真实语料用例启用：${corpus.existing.map((d) => path.basename(path.dirname(d)) + "/" + path.basename(d)).join(", ")}`,
    );
  }

  for (const src of corpus.existing) {
    it(`加载 ${src} 的基线与全部版本索引，重建后查询结果逐字段不变`, () => {
      const base = mkTmp();
      const root = copyProjectDocs(src, base);
      const docsRoot = path.join(root, "docs");
      const metaRoot = path.join(root, ".meta");
      const im = new IndexManager(resolveProjectRoot(base));

      // 1) 基线加载成功，chunk 数与文档中的 @id 定界一致。
      //    计数口径与 chunk-parser 相同：独占一行的 `<!-- @id:... -->` 注释，
      //    代码围栏内不计、正文内联提及（如 `` `<!-- @id:xxx -->` ``）不计。
      const baseline = im.loadBaseline();
      let parsedChunkCount = 0;
      for (const layer of ["prd", "fsd", "tdd"]) {
        for (const file of listMd(path.join(docsRoot, layer))) {
          parsedChunkCount += countIdDirectives(fs.readFileSync(file, "utf8"));
        }
      }
      expect(baseline.chunks.length).toBe(parsedChunkCount);
      expect(baseline.chunks.length).toBeGreaterThan(0);

      // 2) 每个版本索引加载成功，chunk 数等于文件中 chunks 列表长度
      const versions = im.listVersions();
      for (const v of versions) {
        const loaded = im.loadVersionIndex(v);
        expect(loaded.chunks.length).toBe(
          rawChunkCount(path.join(metaRoot, `chunks-index-${v}.yaml`)),
        );
      }
      // 版本号数值序（真实语料含 v2.9/v2.10 这类跨越位数的版本）
      const pairs = versions.map((v) => v.slice(1).split(".").map(Number));
      for (let i = 1; i < pairs.length; i++) {
        const prev = pairs[i - 1] as number[];
        const cur = pairs[i] as number[];
        expect((prev[0] as number) * 1e6 + (prev[1] as number)).toBeLessThanOrEqual(
          (cur[0] as number) * 1e6 + (cur[1] as number),
        );
      }

      // 3) 记录重建前每个 id 的条目
      const before = baseline.chunks.map((r) => ({
        id: r.id,
        file: r.file,
        heading: r.heading,
        level: r.level,
        summary: r.summary,
      }));
      const versionDigestsBefore = versionIndexDigests(metaRoot);

      // 4) 重建基线
      const rebuilt = im.rebuildBaseline();
      expect(rebuilt.chunks.length).toBe(before.length);

      // 5) 重建后逐 id 逐字段相等（真实语料绝大多数 chunk 无 @summary，
      //    摘要只可能来自沿用——派生首行会在此处立刻暴露）
      for (const entry of before) {
        const after = im.queryBaseline(entry.id);
        expect(after).not.toBeNull();
        expect({
          id: after?.id,
          file: after?.file,
          heading: after?.heading,
          level: after?.level,
          summary: after?.summary,
        }).toEqual(entry);
      }

      // 6) 全部 chunks-index-v*.yaml 字节未变（历史版本只读）
      expect(versionIndexDigests(metaRoot)).toEqual(versionDigestsBefore);
    });
  }
});
