// [TDD]-specgraph_tests — specgraph 域两个制品（graph-model/queries）的集成验收。
// 覆盖 [FSD]-ait-core-specgraph:TEST 第 1~5 条全部断言点。
//
// v0.5 形态约束（与 Python 版 specgraph.py 一致）：
// - `specs` 是**数组**（按 uri 排序），节点身份是 uri，索引靠 `.find()`/位置而非字符串键；
// - 边为 `{src,dst,rel,weight,metadata}`，来源在 `metadata.source`（无顶层 `source`）；
// - 关系**不从命名或文档结构推断**：sync 只重建节点、保留显式边，一切边只由 addEdge 出生；
// - 视图专属字段 heading/summary/target_file 由 combinedView 随取随算，不落入图文件。
//
// 用例独立零共享：每个用例在 os.tmpdir() 下自建临时 project-docs（docs/{prd,fsd,tdd} + .meta），
// 内联文档文本一律用行数组 join，避免 ``` 围栏自嵌套。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import { resolveProjectRoot, type ProjectRoot } from "../src/foundation/root.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import {
  SpecGraphStore,
  SpecGraphError,
  combinedView,
  type EdgeRel,
  type SpecGraphErrorCode,
  type ViewEdge,
} from "../src/specgraph/graph-model.js";
import type { Direction } from "../src/api/types.js";
import type { Spec, SpecGraph } from "../src/doc-model/schemas.js";
import {
  queryDeps,
  analyzeImpact,
  detectCycle,
} from "../src/specgraph/queries.js";

let tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-specgraph-"));
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

/** 搭建合法 project-docs 骨架（docs/{prd,fsd,tdd} + .meta），返回 ProjectRoot。 */
function makeRoot(): ProjectRoot {
  const base = mkTmp();
  const pd = path.join(base, "project-docs");
  const docs = path.join(pd, "docs");
  const meta = path.join(pd, ".meta");
  for (const d of [
    docs,
    meta,
    path.join(docs, "prd"),
    path.join(docs, "fsd"),
    path.join(docs, "tdd"),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { cwd: base, root: pd, docs, meta };
}

/** 写一组 docs 文件：key 为相对 docs 的路径，value 为行数组。 */
function writeDocs(root: ProjectRoot, files: Record<string, string[]>): void {
  for (const [rel, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(root.docs, rel), lines.join("\n"), "utf-8");
  }
}

/** 重建基线索引（节点来源；sync 只从索引生成节点）。 */
function reindexBaseline(root: ProjectRoot): void {
  new IndexManager(root).rebuildBaseline();
}

/**
 * 标准三层 docs 树：PRD 根→FSD 根、split→子 FSD 根、split→TDD，
 * 且结构通道（根→内部 split）由 id 前缀天然成立。
 */
const ALPHA_TREE: Record<string, string[]> = {
  "prd/[PRD]-alpha.md": [
    "<!-- @id:[PRD]-alpha -->",
    "## alpha PRD 根",
    "alpha 根内容。",
  ],
  "fsd/[FSD]-alpha.md": [
    "<!-- @id:[FSD]-alpha -->",
    "## alpha FSD 根",
    "alpha FSD 内容。",
    "<!-- @id:[FSD]-alpha:beta -->",
    "## beta split",
    "beta split 内容。",
  ],
  "fsd/[FSD]-alpha-beta.md": [
    "<!-- @id:[FSD]-alpha-beta -->",
    "## alpha-beta FSD 根",
    "alpha-beta 内容。",
    "<!-- @id:[FSD]-alpha-beta:gamma -->",
    "## gamma split",
    "gamma split 内容。",
  ],
  "tdd/[TDD]-gamma.md": [
    "<!-- @id:[TDD]-gamma -->",
    "## gamma TDD",
    "gamma TDD 内容。",
  ],
};

/** alpha 树的全部 chunk id（节点集合的期望值）。 */
const ALPHA_IDS: string[] = [
  "[PRD]-alpha",
  "[FSD]-alpha",
  "[FSD]-alpha:beta",
  "[FSD]-alpha-beta",
  "[FSD]-alpha-beta:gamma",
  "[TDD]-gamma",
];

/** 无关子树（impact 不得触及）。 */
const OMEGA_TREE: Record<string, string[]> = {
  "prd/[PRD]-omega.md": [
    "<!-- @id:[PRD]-omega -->",
    "## omega PRD 根",
    "omega 根内容。",
  ],
  "fsd/[FSD]-omega.md": [
    "<!-- @id:[FSD]-omega -->",
    "## omega FSD 根",
    "omega FSD 内容。",
  ],
};

/** 孤立 TDD 节点对（无树边，用于手工构环）。 */
const ISOLATED_TDD_PAIR: Record<string, string[]> = {
  "tdd/[TDD]-m.md": ["<!-- @id:[TDD]-m -->", "## m TDD", "m 内容。"],
  "tdd/[TDD]-n.md": ["<!-- @id:[TDD]-n -->", "## n TDD", "n 内容。"],
};

/** baseline 节点 uri。 */
function bu(layer: string, chunkId: string): string {
  return `spec:${layer}:baseline:${chunkId}`;
}

function graphPathOf(root: ProjectRoot, version?: string): string {
  const name = version === undefined ? "specgraph.yaml" : `specgraph-${version}.yaml`;
  return path.join(root.meta, name);
}

function writeYaml(file: string, text: string): void {
  fs.writeFileSync(file, text, "utf-8");
}

function readBytes(root: ProjectRoot, version?: string): Buffer {
  return fs.readFileSync(graphPathOf(root, version));
}

/** 图规格的最小合法形态（specs 为数组、边带 weight + metadata）。 */
interface GraphFixtureSpec {
  uri: string;
  title: string;
  type: string;
  version: string;
  chunk_id: string;
  file: string;
  metadata: Record<string, unknown>;
}

interface GraphFixtureEdge {
  src: string;
  dst: string;
  rel: string;
  weight: number;
  metadata: Record<string, unknown>;
}

/** 以 Python 当前形态拼图文件文本（YAML 超集）。 */
function graphText(specs: GraphFixtureSpec[], edges: GraphFixtureEdge[]): string {
  const lines = ["version: 1", "updated: null", "specs:"];
  for (const s of specs) {
    lines.push(`  - uri: ${JSON.stringify(s.uri)}`);
    lines.push(`    title: ${JSON.stringify(s.title)}`);
    lines.push(`    type: ${s.type}`);
    lines.push(`    version: ${s.version}`);
    lines.push(`    chunk_id: ${JSON.stringify(s.chunk_id)}`);
    lines.push(`    file: ${JSON.stringify(s.file)}`);
    lines.push("    metadata:");
    for (const [k, v] of Object.entries(s.metadata)) {
      lines.push(`      ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (edges.length === 0) {
    lines.push("edges: []");
  } else {
    lines.push("edges:");
    for (const e of edges) {
      lines.push(`  - src: ${JSON.stringify(e.src)}`);
      lines.push(`    dst: ${JSON.stringify(e.dst)}`);
      lines.push(`    rel: ${e.rel}`);
      lines.push(`    weight: ${e.weight}`);
      lines.push("    metadata:");
      for (const [k, v] of Object.entries(e.metadata)) {
        lines.push(`      ${k}: ${JSON.stringify(v)}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function node(
  chunkId: string,
  version: string,
  file: string,
  title: string,
  type: string,
): GraphFixtureSpec {
  return {
    uri: `spec:${type}:${version}:${chunkId}`,
    title,
    type,
    version,
    chunk_id: chunkId,
    file,
    metadata: version === "baseline" ? { source: "baseline" } : { source: "version" },
  };
}

/** 图上全部边三元组（用于断言"某类边不存在"）。 */
function triplesOf(edges: Array<{ src: string; dst: string; rel: string }>): string[] {
  return edges.map((e) => `${e.src}\t${e.rel}\t${e.dst}`).sort();
}

function expectSpecGraphError(fn: () => void, code: SpecGraphErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SpecGraphError);
    expect((err as SpecGraphError).code).toBe(code);
    return;
  }
  expect.unreachable(`应抛出 SpecGraphError(${code})`);
}

/** 图文件里的节点（specs 是数组，只能按位置/`.find()` 取，不能用字符串键）。 */
function nodeById(
  graph: { specs: ReadonlyArray<Spec> },
  chunkId: string,
): Spec | undefined {
  return graph.specs.find((s) => s.chunk_id === chunkId);
}

/** 为图测试写入真实版本索引及可枚举的版本记录。 */
function writeGraphVersionIndex(
  root: ProjectRoot,
  version: string,
  specs: GraphFixtureSpec[],
  status: "developing" | "committed" | "merged" = "developing",
): void {
  writeYaml(path.join(root.meta, `chunks-index-${version}.yaml`), JSON.stringify({
    version: 1, scope: "version", version_name: version, status,
    chunks: specs.map((spec) => ({
      id: spec.chunk_id, file: spec.file, heading: spec.title, level: 2,
      action: "modify", state: status === "developing" ? "working" : "committed",
      commit_id: status === "developing" ? null : "c11",
    })),
  }));
  const versions = path.join(root.meta, "versions");
  fs.mkdirSync(versions, { recursive: true });
  writeYaml(path.join(versions, `${version}.yaml`), [
    `version: ${version}`, "created_at: '2026-01-01T00:00:00.000Z'",
  ].join("\n"));
}

/** 固定旧 mtime，确保同一毫秒内的意外重写也能被检测。 */
function snapshotFiles(files: string[]): Map<string, { bytes: Buffer; mtime: number }> {
  const oldTime = new Date("2000-01-01T00:00:00.000Z");
  return new Map(files.map((file) => {
    fs.utimesSync(file, oldTime, oldTime);
    return [file, { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }];
  }));
}

function expectFilesUnchanged(before: Map<string, { bytes: Buffer; mtime: number }>): void {
  for (const [file, snapshot] of before) {
    expect(fs.readFileSync(file).equals(snapshot.bytes), file).toBe(true);
    expect(fs.statSync(file).mtimeMs, file).toBe(snapshot.mtime);
  }
}

// ---------------------------------------------------------------------------
// :TEST 第 1 条 — sync
// ---------------------------------------------------------------------------

describe("sync", () => {
  it("只建节点不推断边：节点与基线索引一致、edges 为空", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);

    const store = new SpecGraphStore(root);
    const graph = store.sync();

    // 节点：身份为 uri，内容取自基线索引条目
    expect(graph.specs.map((s) => s.uri).sort()).toEqual(
      [
        bu("prd", "[PRD]-alpha"),
        bu("fsd", "[FSD]-alpha"),
        bu("fsd", "[FSD]-alpha:beta"),
        bu("fsd", "[FSD]-alpha-beta"),
        bu("fsd", "[FSD]-alpha-beta:gamma"),
        bu("tdd", "[TDD]-gamma"),
      ].sort(),
    );
    const alpha = nodeById(graph, "[FSD]-alpha");
    expect(alpha).toMatchObject({
      uri: bu("fsd", "[FSD]-alpha"),
      title: "alpha FSD 根",
      type: "fsd",
      version: "baseline",
      chunk_id: "[FSD]-alpha",
      file: "fsd/[FSD]-alpha",
    });
    expect((alpha as { metadata: Record<string, unknown> }).metadata["source"]).toBe(
      "baseline",
    );

    // 关系不从文档结构推断：无显式边时边集为空
    expect(graph.edges).toEqual([]);

    // 原子写回后可读回
    const loaded = store.load();
    expect(loaded.specs.map((s) => s.chunk_id).sort()).toEqual([...ALPHA_IDS].sort());
    expect(loaded.edges).toEqual([]);
    expect(loaded.specs.every((s) => s.version === "baseline")).toBe(true);
  });

  it("显式来源边跨 sync 存活（baseline 图与版本图各自保留）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    store.addEdge("baseline", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "manual");
    store.addEdge("v2", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "manual");

    // 再次重建：不生成任何树边，显式边须存活且不重复
    const graph = store.sync();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      src: bu("prd", "[PRD]-alpha"),
      dst: bu("tdd", "[TDD]-gamma"),
      rel: "depends_on",
      weight: 1,
      metadata: { source: "manual" },
    });
    expect(triplesOf(graph.edges)).toEqual(triplesOf(graph.edges));
    expect(nodeById(graph, "[FSD]-alpha")).toBeDefined();

    const vgraph = store.load("v2");
    expect(vgraph.edges).toHaveLength(1);
    expect(vgraph.edges[0]).toMatchObject({
      src: "spec:prd:v2:[PRD]-alpha",
      dst: "spec:tdd:v2:[TDD]-gamma",
      rel: "depends_on",
      metadata: { source: "manual" },
    });

    // 第三次 sync 幂等：显式边不因重建翻倍，且树边仍不出现
    const again = store.sync();
    expect(again.edges).toHaveLength(1);
    expect(store.load("v2").edges).toHaveLength(1);
  });

  it("非显式来源边不保留：手写 metadata.source=baseline 的边被丢弃", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);

    const a = bu("prd", "[PRD]-alpha");
    const b = bu("tdd", "[TDD]-gamma");
    writeYaml(
      graphPathOf(root),
      graphText(
        [
          node("[PRD]-alpha", "baseline", "prd/[PRD]-alpha", "alpha PRD 根", "prd"),
          node("[TDD]-gamma", "baseline", "tdd/[TDD]-gamma", "gamma TDD", "tdd"),
        ],
        [
          // 非显式来源（EXPLICIT_SOURCES = manual / new-model-cli / fsd-declaration）
          { src: a, dst: b, rel: "depends_on", weight: 1.0, metadata: { source: "baseline" } },
          { src: a, dst: b, rel: "derives", weight: 1.0, metadata: { source: "unknown-source" } },
          // 无 metadata.source 的边同样不属显式来源
          { src: a, dst: b, rel: "details", weight: 1.0, metadata: {} },
        ],
      ),
    );

    const graph = new SpecGraphStore(root).sync();
    expect(graph.edges).toEqual([]);
    // 节点仍以索引为准（手写文件里的节点不参与）
    expect(graph.specs.map((s) => s.chunk_id).sort()).toEqual([...ALPHA_IDS].sort());
    expect(graph.specs.every((s) => s.metadata["source"] === "baseline")).toBe(true);
  });

  it("显式来源边在 sync 期只按 source 存活：悬空端点由写侧校验负责、在视图中丢弃", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);

    const a = bu("prd", "[PRD]-alpha");
    const ghost = bu("tdd", "[TDD]-ghost");
    writeYaml(
      graphPathOf(root),
      graphText(
        [
          node("[PRD]-alpha", "baseline", "prd/[PRD]-alpha", "alpha PRD 根", "prd"),
          node("[TDD]-ghost", "baseline", "tdd/[TDD]-ghost", "幽灵 TDD", "tdd"),
        ],
        [
          { src: a, dst: ghost, rel: "depends_on", weight: 1.0, metadata: { source: "manual" } },
        ],
      ),
    );

    // sync 只按 metadata.source 判定存活，不判端点是否悬空
    const graph = new SpecGraphStore(root).sync();
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ src: a, dst: ghost, rel: "depends_on" });

    // 悬空端点在组合视图层被丢弃（写侧校验负责），且不报错
    const view = combinedView(root);
    expect(view.hasNode("[TDD]-ghost")).toBe(false);
    expect(view.edgesFrom("[PRD]-alpha")).toEqual([]);
    expect(view.edgesTo("[TDD]-ghost")).toEqual([]);
  });

  it("语义内容不变时不写盘（updated 与文件 mtime 不滚动）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);

    const first = store.sync();
    const file = graphPathOf(root);
    const updated = first.updated;
    const mtime = fs.statSync(file).mtimeMs;
    expect(updated).not.toBeNull();

    const second = store.sync();
    expect(second.updated).toBe(updated);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
});

// ---------------------------------------------------------------------------
// v0.11 — 版本专用同步只更新当前未合入版本
// ---------------------------------------------------------------------------

describe("syncVersion", () => {
  it("仅更新指定版本，保留显式边和 marker；带生命周期残留的基线及其它版本逐字不变", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    store.addEdge("v11", "[PRD]-alpha", "[FSD]-alpha", "derives", "new-model-cli");
    store.addEdge("v11", "[FSD]-alpha:beta", "[TDD]-gamma", "depends_on", "fsd-declaration");
    store.addEdge("v11", "[FSD]-alpha", "[TDD]-gamma", "details", "manual");
    const current = store.load("v11");
    nodeById(current, "[FSD]-alpha")!.metadata["fsd_declaration_overrides"] = {};
    nodeById(current, "[FSD]-alpha:beta")!.metadata["fsd_declaration_overrides"] = { depends_on: true };
    store.save("v11", current);
    writeGraphVersionIndex(root, "v11", current.specs.map((spec) => ({
      ...spec, title: `${spec.title} 已提交`,
    })), "committed");

    const baseline = store.load();
    for (const spec of baseline.specs) {
      Object.assign(spec.metadata, {
        state: "committed", action: "modify", commit_id: "old-commit",
        fsd_declaration_overrides: {}, custom: { keep: spec.chunk_id },
      });
    }
    store.save("baseline", baseline);
    for (const version of ["v10", "v12"] as const) {
      const spec = node("[TDD]-gamma", version, "tdd/[TDD]-gamma", "原图标题", "tdd");
      writeYaml(graphPathOf(root, version), graphText([spec], []));
      writeGraphVersionIndex(root, version, [{ ...spec, title: "索引新标题" }],
        version === "v10" ? "merged" : "developing");
    }
    const files = fs.readdirSync(root.meta).sort();
    const protectedFiles = snapshotFiles([
      ...files.filter((file) => file !== "versions" && file !== "specgraph-v11.yaml")
        .map((file) => path.join(root.meta, file)),
      ...["v10", "v11", "v12"].map((version) => path.join(root.meta, "versions", `${version}.yaml`)),
      ...Object.keys(ALPHA_TREE).map((file) => path.join(root.docs, file)),
    ]);
    const currentBytes = readBytes(root, "v11");

    const synced = store.syncVersion("v11");

    expect(readBytes(root, "v11").equals(currentBytes)).toBe(false);
    expect(synced.specs.map((spec) => spec.chunk_id).sort())
      .toEqual(current.specs.map((spec) => spec.chunk_id).sort());
    expect(synced.edges).toEqual(current.edges);
    for (const spec of synced.specs) {
      expect(spec.title).toBe(`${nodeById(current, spec.chunk_id)!.title} 已提交`);
      expect(spec.metadata).toMatchObject({
        source: "version", state: "committed", action: "modify", commit_id: "c11",
      });
    }
    expect(nodeById(synced, "[FSD]-alpha")?.metadata)
      .toHaveProperty("fsd_declaration_overrides", {});
    expect(nodeById(synced, "[FSD]-alpha:beta")?.metadata)
      .toHaveProperty("fsd_declaration_overrides", { depends_on: true });
    expectFilesUnchanged(protectedFiles);
    expect(fs.readdirSync(root.meta).sort()).toEqual(files);
    const noChange = snapshotFiles([graphPathOf(root, "v11")]);
    store.syncVersion("v11");
    expectFilesUnchanged(noChange);
    expectFilesUnchanged(protectedFiles);
  });

  it("从真实索引首次建图，不读取损坏的基线或其它版本", () => {
    const root = makeRoot();
    const spec = node("[FSD]-alpha", "v11", "fsd/[FSD]-alpha", "alpha FSD 根", "fsd");
    writeGraphVersionIndex(root, "v11", [spec]);
    const unrelated = [graphPathOf(root), graphPathOf(root, "v10"),
      path.join(root.meta, "chunks-index.yaml"), path.join(root.meta, "chunks-index-v10.yaml")];
    for (const file of unrelated) writeYaml(file, "broken: [");
    const before = snapshotFiles([...unrelated, path.join(root.meta, "chunks-index-v11.yaml")]);
    const store = new SpecGraphStore(root);

    const graph = store.syncVersion("v11");

    expect(graph.specs).toHaveLength(1);
    expect(graph.specs[0]).toMatchObject({ ...spec, metadata: { source: "version", state: "working" } });
    expect(graph.edges).toEqual([]);
    expect(store.load("v11")).toEqual(graph);
    expectFilesUnchanged(before);
  });

  it("已 merged 版本返回原图，索引内容不同也不改图、updated 或 mtime", () => {
    const root = makeRoot();
    const spec = node("[TDD]-gamma", "v10", "tdd/[TDD]-gamma", "历史标题", "tdd");
    spec.metadata = { source: "version", state: "committed", action: "modify", commit_id: "c10" };
    writeYaml(graphPathOf(root, "v10"), graphText([spec], []));
    writeGraphVersionIndex(root, "v10", [{ ...spec, title: "不可覆盖历史图的索引标题" }], "merged");
    const store = new SpecGraphStore(root);
    const graph = store.load("v10");
    const before = snapshotFiles([graphPathOf(root, "v10"), path.join(root.meta, "chunks-index-v10.yaml")]);

    expect(store.syncVersion("v10")).toEqual(graph);
    expectFilesUnchanged(before);
    expect(fs.existsSync(graphPathOf(root))).toBe(false);
  });

  it.each([
    { label: "索引缺失", text: null, code: "VERSION_NOT_FOUND" },
    { label: "索引 YAML 损坏", text: "chunks: [", code: "INDEX_UNREADABLE" },
    { label: "索引 schema 非法", text: "version_name: v11\nchunks: invalid", code: "INDEX_UNREADABLE" },
  ])("$label 时真实报错，已有图不被空索引覆盖", ({ text, code }) => {
    const root = makeRoot();
    const spec = node("[FSD]-alpha", "v11", "fsd/[FSD]-alpha", "alpha", "fsd");
    writeYaml(graphPathOf(root, "v11"), graphText([spec], []));
    const indexPath = path.join(root.meta, "chunks-index-v11.yaml");
    if (text !== null) writeYaml(indexPath, text);
    const files = fs.readdirSync(root.meta).sort();
    const before = snapshotFiles(files.map((file) => path.join(root.meta, file)));

    expect(() => new SpecGraphStore(root).syncVersion("v11")).toThrowError(expect.objectContaining({
      code, message: expect.stringContaining(text === null ? "v11" : indexPath),
    }));
    expectFilesUnchanged(before);
    expect(fs.readdirSync(root.meta).sort()).toEqual(files);
  });

  it.each([
    { status: "developing", text: "specs: [" },
    { status: "developing", text: "specs: []\nedges: []\nbogus: true" },
    { status: "merged", text: "specs: [" },
  ] as const)("$status 的损坏版本图报 GRAPH_UNREADABLE 且零写入：$text", ({ status, text }) => {
    const root = makeRoot();
    writeGraphVersionIndex(root, "v11", [], status);
    const file = graphPathOf(root, "v11");
    writeYaml(file, text);
    const before = snapshotFiles([file, path.join(root.meta, "chunks-index-v11.yaml")]);

    expect(() => new SpecGraphStore(root).syncVersion("v11")).toThrowError(expect.objectContaining({
      code: "GRAPH_UNREADABLE", message: expect.stringContaining(file),
    }));
    expectFilesUnchanged(before);
    expect(fs.existsSync(graphPathOf(root))).toBe(false);
  });
});

describe("combinedView", () => {
  it("版本覆盖同 id baseline 节点，其余 baseline 节点仍在", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    new SpecGraphStore(root).sync();

    writeYaml(
      graphPathOf(root, "v1"),
      graphText(
        [
          node("[FSD]-alpha:beta", "v1", "fsd/[FSD]-alpha", "版本侧 beta 标题", "fsd"),
          node("[TDD]-gamma", "v1", "tdd/[TDD]-gamma", "gamma TDD", "tdd"),
        ],
        [],
      ),
    );

    const view = combinedView(root, "v1");
    expect(view.hasNode("[FSD]-alpha:beta")).toBe(true);
    const beta = view.nodes.get("[FSD]-alpha:beta");
    expect(beta).toMatchObject({
      chunk_id: "[FSD]-alpha:beta",
      title: "版本侧 beta 标题",
      heading: "版本侧 beta 标题",
      version: "v1",
      type: "fsd",
      file: "fsd/[FSD]-alpha",
    });
    // baseline 其余节点仍在（未覆盖的保持 baseline 身份）
    expect(view.hasNode("[PRD]-alpha")).toBe(true);
    expect(view.nodes.get("[FSD]-alpha")?.heading).toBe("alpha FSD 根");
    expect(view.nodes.get("[FSD]-alpha")?.version).toBe("baseline");
    expect(view.nodes.get("[TDD]-gamma")?.version).toBe("v1");
  });

  it("边端点坍缩到 chunk_id 并去重（同 src/dst/rel 只留一条，先到者保留）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    // 版本侧与 baseline 同 chunk 三元组各一条（src/dst 为不同 uri）
    store.addEdge("baseline", "[FSD]-alpha", "[FSD]-alpha:beta", "decomposes", "manual");
    store.addEdge("v1", "[FSD]-alpha", "[FSD]-alpha:beta", "decomposes", "manual");

    const view = combinedView(root, "v1");
    const edges = view.edgesFrom("[FSD]-alpha", "decomposes");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      src: "[FSD]-alpha",
      dst: "[FSD]-alpha:beta",
      rel: "decomposes",
      metadata: { source: "manual" },
    });
    // 端点已坍缩：视图里不存在 uri 形态的端点
    for (const e of [...view.edgesFrom("[FSD]-alpha"), ...view.edgesTo("[FSD]-alpha")]) {
      expect(e.src.startsWith("spec:")).toBe(false);
      expect(e.dst.startsWith("spec:")).toBe(false);
    }
  });

  it("depends_on 按 owned-scope 覆盖：owned 根 split 的 baseline depends_on 被版本侧取代", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    // baseline 显式 depends_on：owned 根 split 上的那条 + 跨文件对
    store.addEdge("baseline", "[FSD]-alpha:beta", "[TDD]-gamma", "depends_on", "manual");
    store.addEdge("baseline", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "fsd-declaration");
    store.sync();

    // 版本图出现 [FSD]-alpha 这个 owned 根（其 split 的 baseline depends_on 应被版本侧取代），
    // 并在其 split 上给出自己的 depends_on
    store.addEdge("v1", "[FSD]-alpha", "[FSD]-alpha:beta", "decomposes", "new-model-cli");
    store.addEdge("v1", "[FSD]-alpha:beta", "[PRD]-alpha", "depends_on", "new-model-cli");

    const view = combinedView(root, "v1");
    // owned-scope 内被取代：baseline 的 [FSD]-alpha:beta -[depends_on]-> [TDD]-gamma 消失
    const beta = view.edgesFrom("[FSD]-alpha:beta", "depends_on");
    expect(beta).toHaveLength(1);
    expect(beta[0]).toMatchObject({
      src: "[FSD]-alpha:beta",
      dst: "[PRD]-alpha",
      metadata: { source: "new-model-cli" },
    });
    expect(view.edgesTo("[TDD]-gamma", "depends_on").map((e) => e.src)).toEqual([
      "[PRD]-alpha",
    ]);
    // 版本侧其它关系存活
    expect(view.edgesFrom("[FSD]-alpha", "decomposes")).toHaveLength(1);
    // 跨文件对（src 不是 owned 根）原样保留
    const cross = view.edgesFrom("[PRD]-alpha", "depends_on");
    expect(cross).toHaveLength(1);
    expect(cross[0]).toMatchObject({
      dst: "[TDD]-gamma",
      metadata: { source: "fsd-declaration" },
    });
  });

  it("rename 式 modify：baseline 端点重定向到替换后的 id", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    // baseline 侧边指向被改名的 [FSD]-alpha-beta
    store.addEdge("baseline", "[PRD]-alpha", "[FSD]-alpha-beta", "derives", "manual");
    store.sync();

    // 版本侧：改名后出现新 id（entry.id 为新 id，overrides 指向被替换的旧 id）
    writeYaml(
      graphPathOf(root, "v3"),
      graphText(
        [
          node(
            "[FSD]-alpha-beta-renamed",
            "v3",
            "fsd/[FSD]-alpha-beta",
            "alpha-beta FSD 根（改名）",
            "fsd",
          ),
        ],
        [],
      ),
    );
    writeYaml(
      path.join(root.meta, "chunks-index-v3.yaml"),
      [
        "version: 1",
        "scope: version",
        "version_name: v3",
        "status: developing",
        "chunks:",
        '  - id: "[FSD]-alpha-beta-renamed"',
        '    file: "fsd/[FSD]-alpha-beta"',
        '    heading: "alpha-beta FSD 根（改名）"',
        "    level: 2",
        "    action: modify",
        "    state: working",
        '    overrides: "[FSD]-alpha-beta"',
      ].join("\n") + "\n",
    );

    const view = combinedView(root, "v3");
    // 被改名替换的 baseline 身份被移出视图
    expect(view.hasNode("[FSD]-alpha-beta")).toBe(false);
    expect(view.hasNode("[FSD]-alpha-beta-renamed")).toBe(true);
    expect(view.nodes.get("[FSD]-alpha-beta-renamed")?.heading).toBe(
      "alpha-beta FSD 根（改名）",
    );
    // baseline 边的端点重定向到替换后的 id
    const edges = view.edgesFrom("[PRD]-alpha", "derives");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      src: "[PRD]-alpha",
      dst: "[FSD]-alpha-beta-renamed",
      rel: "derives",
    });
  });

  it("悬空边在视图中丢弃（不报错）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    new SpecGraphStore(root).sync();

    // 版本图里没有对应节点的端点（悬空：端点在 baseline∪version 节点集中均不存在）
    const ghost = "spec:tdd:v4:[TDD]-ghost";
    writeYaml(
      graphPathOf(root, "v4"),
      graphText(
        [],
        [
          { src: bu("prd", "[PRD]-alpha"), dst: ghost, rel: "derives", weight: 1.0, metadata: { source: "version" } },
          { src: ghost, dst: bu("tdd", "[TDD]-gamma"), rel: "depends_on", weight: 1.0, metadata: { source: "version" } },
          // 非 spec: 形态的端点无法解析为 chunk_id，同样丢弃
          { src: "urn:not-a-spec", dst: bu("tdd", "[TDD]-gamma"), rel: "derives", weight: 1.0, metadata: { source: "version" } },
        ],
      ),
    );

    const view = combinedView(root, "v4");
    // baseline 视图正常；幽灵端点未被抬升为视图节点
    expect(view.hasNode("[PRD]-alpha")).toBe(true);
    expect(view.hasNode("[TDD]-gamma")).toBe(true);
    expect(view.hasNode("[TDD]-ghost")).toBe(false);
    // 悬空端点的边全部不可见（任一端不在视图节点中即丢弃，不报错）
    expect(view.edgesFrom("[PRD]-alpha")).toEqual([]);
    expect(view.edgesTo("[TDD]-gamma")).toEqual([]);
    expect(view.edgesFrom("[TDD]-ghost")).toEqual([]);
    expect(detectCycle(view)).toEqual([]);
    expect(analyzeImpact(view, "[PRD]-alpha").impacted).toEqual([]);
  });

  it("TDD 视图节点携带 target_file（从文档 yaml 声明取得），非 TDD 节点不携带", () => {
    const root = makeRoot();
    writeDocs(root, {
      ...ALPHA_TREE,
      "tdd/[TDD]-gamma.md": [
        "<!-- @id:[TDD]-gamma -->",
        "## gamma TDD",
        "",
        "```yaml",
        "target_file: src/gamma.ts",
        "```",
        "",
        "gamma 正文。",
      ],
    });
    reindexBaseline(root);
    new SpecGraphStore(root).sync();

    const view = combinedView(root);
    expect(view.nodes.get("[TDD]-gamma")?.target_file).toBe("src/gamma.ts");
    expect(view.nodes.get("[FSD]-alpha")?.target_file).toBeUndefined();
    // target_file 只是视图字段，不落图文件
    const raw = fs.readFileSync(graphPathOf(root), "utf-8");
    expect(raw).not.toContain("target_file");
    expect(raw).not.toContain("gamma.ts");
  });
});

// ---------------------------------------------------------------------------
// v0.10 — Node FSD 声明键所有权（旧 Python owned-scope 用例保留在上方）
// ---------------------------------------------------------------------------

describe("FSD 声明键所有权", () => {
  const version = "v10";
  const owner = "[FSD]-alpha:beta";
  const oldDerives = `[PRD]-alpha:old\tderives\t${owner}\tfsd-declaration`;
  const oldDependency = `${owner}\tdepends_on\t[TDD]-gamma\tfsd-declaration`;

  function fixture(marker?: Record<string, true>) {
    const root = makeRoot();
    writeDocs(root, {
      ...ALPHA_TREE,
      ...OMEGA_TREE,
      ...ISOLATED_TDD_PAIR,
      "prd/[PRD]-alpha.md": [
        "<!-- @id:[PRD]-alpha -->", "## alpha PRD 根",
        "<!-- @id:[PRD]-alpha:old -->", "## old 需求",
        "<!-- @id:[PRD]-alpha:new -->", "## new 需求",
      ],
      "fsd/[FSD]-alpha.md": [
        "<!-- @id:[FSD]-alpha -->", "## alpha FSD 根",
        `<!-- @id:${owner} -->`, "## beta split",
        "<!-- @id:[FSD]-alpha:sibling -->", "## sibling split",
      ],
    });
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    for (const dst of [owner, "[FSD]-alpha:sibling", "[FSD]-alpha-beta:gamma"]) {
      store.addEdge("baseline", "[PRD]-alpha:old", dst, "derives", "fsd-declaration");
    }
    store.addEdge("baseline", owner, "[TDD]-gamma", "depends_on", "fsd-declaration");
    // 同文件与跨文件的入边不归 dst 的 depends_on marker 所有。
    for (const src of ["[FSD]-alpha:sibling", "[FSD]-alpha-beta:gamma"]) {
      store.addEdge("baseline", src, owner, "depends_on", "fsd-declaration");
    }
    store.addEdge("baseline", "[PRD]-alpha", owner, "derives", "new-model-cli");
    store.addEdge("baseline", "[PRD]-omega", owner, "derives", "manual");
    store.addEdge("baseline", owner, "[FSD]-alpha-beta:gamma", "depends_on", "new-model-cli");
    store.addEdge("baseline", owner, "[TDD]-m", "depends_on", "manual");
    store.addEdge("baseline", "[PRD]-alpha", "[FSD]-alpha", "derives", "new-model-cli");

    const rootNode = node("[FSD]-alpha", version, "fsd/[FSD]-alpha", "alpha FSD 根", "fsd");
    rootNode.metadata["fsd_declaration_overrides"] = {};
    const splitNode = node(owner, version, "fsd/[FSD]-alpha", "beta split", "fsd");
    if (marker !== undefined) splitNode.metadata["fsd_declaration_overrides"] = marker;
    const graph = store.load(version);
    graph.specs = [rootNode, splitNode];
    store.save(version, graph);
    return { root, store };
  }

  function edgeRecords(root: ProjectRoot, selectedVersion?: string): string[] {
    const view = combinedView(root, selectedVersion);
    return [...view.nodes.keys()].flatMap((id) => view.edgesFrom(id))
      .map((edge) => `${edge.src}\t${edge.rel}\t${edge.dst}\t${edge.metadata["source"]}`)
      .sort();
  }

  function writeVersionIndex(root: ProjectRoot, store: SpecGraphStore): IndexManager {
    const versions = path.join(root.meta, "versions");
    fs.mkdirSync(versions, { recursive: true });
    writeYaml(path.join(versions, `${version}.yaml`), [
      `version: ${version}`, "created_at: '2026-01-01T00:00:00.000Z'",
    ].join("\n"));
    writeYaml(path.join(root.meta, `chunks-index-${version}.yaml`), JSON.stringify({
      version: 1, scope: "version", version_name: version, status: "developing",
      chunks: store.load(version).specs.map((spec) => ({
        id: spec.chunk_id, file: spec.file, heading: spec.title, level: 2,
        action: "modify", state: "working",
      })),
    }));
    return new IndexManager(root);
  }

  it.each([
    { label: "root={} 保留全部未声明键", rel: null, replace: false },
    { label: "depends_on 覆盖", rel: "depends_on", replace: true },
    { label: "depends_on 清空", rel: "depends_on", replace: false },
    { label: "derives 覆盖", rel: "derives", replace: true },
    { label: "derives 清空", rel: "derives", replace: false },
  ] as const)("$label：省略键、其它 split 与命令边保留，sync→merge 一致", ({ rel, replace }) => {
    const marker = rel === null ? undefined : { [rel]: true as const };
    const { root, store } = fixture(marker);
    let expected = edgeRecords(root);
    if (rel !== null) {
      const removed = rel === "derives" ? oldDerives : oldDependency;
      expected = expected.filter((edge) => edge !== removed);
      if (replace) {
        const src = rel === "derives" ? "[PRD]-alpha:new" : owner;
        const dst = rel === "derives" ? owner : "[TDD]-n";
        store.addEdge(version, src, dst, rel, "fsd-declaration");
        expected.push(`${src}\t${rel}\t${dst}\tfsd-declaration`);
      }
    }
    expected.sort();
    expect(edgeRecords(root, version)).toEqual(expected);

    // 版本索引不带 marker；sync 必须保留图上同 chunk 的键及空对象。
    writeVersionIndex(root, store);
    store.sync();
    const synced = store.load(version);
    expect(nodeById(synced, "[FSD]-alpha")?.metadata)
      .toHaveProperty("fsd_declaration_overrides", {});
    expect(nodeById(synced, owner)?.metadata["fsd_declaration_overrides"]).toEqual(marker);
    expect(edgeRecords(root, version)).toEqual(expected);
    const versionBytes = readBytes(root, version);

    store.mergeIntoBaseline(version);
    expect(edgeRecords(root)).toEqual(expected);
    for (const spec of store.load().specs) {
      expect(spec.version).toBe("baseline");
      expect(spec.metadata).not.toHaveProperty("fsd_declaration_overrides");
    }
    expect(readBytes(root, version).equals(versionBytes)).toBe(true);
  });

  it.each([{}, { derives: true }] as Array<Record<string, true>>)(
    "sync 优先使用索引的新 marker %j（包括空对象），不合并旧删除意图",
    (indexMarker) => {
      const { root, store } = fixture({ derives: true, depends_on: true });
      const indexes = writeVersionIndex(root, store);
      const index = indexes.loadVersionIndex(version);
      const entry = index.chunks.find((chunk) => chunk.id === owner)!;
      entry.metadata["fsd_declaration_overrides"] = indexMarker;
      indexes.saveVersionIndex(index);
      const expected = edgeRecords(root).filter(
        (edge) => indexMarker["derives"] !== true || edge !== oldDerives,
      );

      store.sync();
      expect(nodeById(store.load(version), owner)?.metadata["fsd_declaration_overrides"])
        .toEqual(indexMarker);
      expect(nodeById(store.load(version), "[FSD]-alpha")?.metadata)
        .toHaveProperty("fsd_declaration_overrides", {});
      expect(edgeRecords(root, version)).toEqual(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// mergeIntoBaseline — FSD:graph_model 契约
// ---------------------------------------------------------------------------

describe("mergeIntoBaseline", () => {
  it("合并当次清除所有基线节点的四个版本字段，保留自定义 metadata；后续全图 sync 不再改写", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    store.addEdge("baseline", "[PRD]-alpha", "[FSD]-alpha", "derives", "new-model-cli");
    store.addEdge("v11", "[FSD]-alpha", "[FSD]-alpha:beta", "decomposes", "new-model-cli");
    const baseline = store.load();
    const version = store.load("v11");
    for (const [graph, origin] of [[baseline, "retained"], [version, "promoted"]] as const) {
      for (const spec of graph.specs) {
        Object.assign(spec.metadata, {
          state: "committed", action: "modify", commit_id: `${origin}-commit`,
          fsd_declaration_overrides: {}, custom: { origin, owner: spec.chunk_id }, note: "保留",
        });
      }
    }
    store.save("baseline", baseline);
    store.save("v11", version);
    writeGraphVersionIndex(root, "v11", version.specs, "committed");
    const historical = node("[TDD]-gamma", "v10", "tdd/[TDD]-gamma", "历史图", "tdd");
    historical.metadata = { source: "version", state: "committed", action: "modify", commit_id: "c10" };
    writeYaml(graphPathOf(root, "v10"), graphText([historical], []));
    writeGraphVersionIndex(root, "v10", [historical], "merged");

    // 模拟调用方已提升的基线索引，故意留下生命周期字段；图模块不得改写索引。
    const indexes = new IndexManager(root);
    const baselineIndex = indexes.loadBaseline();
    for (const entry of baselineIndex.chunks) {
      entry.metadata = { ...(nodeById(version, entry.id) ?? nodeById(baseline, entry.id))!.metadata };
    }
    const indexFile = path.join(root.meta, "chunks-index.yaml");
    writeYaml(indexFile, JSON.stringify(baselineIndex));
    const before = snapshotFiles([
      indexFile, graphPathOf(root, "v11"), graphPathOf(root, "v10"),
      path.join(root.meta, "chunks-index-v11.yaml"), path.join(root.meta, "chunks-index-v10.yaml"),
    ]);

    store.mergeIntoBaseline("v11");

    // 必须在任何 sync 之前检查落盘结果，不能让下一次重建替 merge 清理。
    const merged = store.load();
    expect(merged.specs.map((spec) => spec.chunk_id).sort()).toEqual([...ALPHA_IDS].sort());
    for (const spec of merged.specs) {
      const original = nodeById(version, spec.chunk_id) ?? nodeById(baseline, spec.chunk_id)!;
      expect(spec.version).toBe("baseline");
      expect(spec.uri).toBe(bu(spec.type, spec.chunk_id));
      expect(spec.metadata).toEqual({ source: "baseline", custom: original.metadata["custom"], note: "保留" });
      for (const field of ["state", "action", "commit_id", "fsd_declaration_overrides"]) {
        expect(spec.metadata).not.toHaveProperty(field);
      }
    }
    expect(merged.edges).toHaveLength(2);
    expectFilesUnchanged(before);
    expect(nodeById(store.load("v11"), "[FSD]-alpha")?.metadata).toMatchObject({
      state: "committed", action: "modify", commit_id: "promoted-commit", fsd_declaration_overrides: {},
    });

    // 版本生命周期由调用方完成；全图 sync 必须跳过已合入图，并过滤索引中的旧字段。
    const versionIndex = indexes.loadVersionIndex("v11");
    versionIndex.status = "merged";
    indexes.saveVersionIndex(versionIndex);
    const stable = snapshotFiles([
      graphPathOf(root), indexFile, graphPathOf(root, "v11"), graphPathOf(root, "v10"),
      path.join(root.meta, "chunks-index-v11.yaml"), path.join(root.meta, "chunks-index-v10.yaml"),
    ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      store.sync();
      expectFilesUnchanged(stable);
    }
  });

  it("版本节点改写为 baseline、边并入、被取代的 depends_on 删除、版本图文件不变", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    // baseline 侧两条：owned 根 split 的 depends_on（合入时被版本侧取代）+ 一条普通边
    store.addEdge("baseline", "[FSD]-alpha:beta", "[TDD]-gamma", "depends_on", "manual");
    store.addEdge("baseline", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "fsd-declaration");
    store.sync();

    // 版本侧：owned 根 [FSD]-alpha 入图（使其 split 的 baseline depends_on 被取代）+ 自己的边
    store.addEdge("v5", "[FSD]-alpha", "[FSD]-alpha:beta", "decomposes", "new-model-cli");
    store.addEdge("v5", "[TDD]-gamma", "[PRD]-alpha", "depends_on", "new-model-cli");
    const vpath = graphPathOf(root, "v5");
    const vbytes = fs.readFileSync(vpath);

    store.mergeIntoBaseline("v5");

    const merged = store.load();
    const gamma = nodeById(merged, "[TDD]-gamma");
    expect(gamma).toMatchObject({
      uri: bu("tdd", "[TDD]-gamma"),
      version: "baseline",
      file: "tdd/[TDD]-gamma",
    });
    expect((gamma as { metadata: Record<string, unknown> }).metadata["source"]).toBe(
      "baseline",
    );
    expect(merged.specs.every((s) => s.uri.startsWith("spec:"))).toBe(true);
    expect(merged.specs.every((s) => !s.uri.includes(":v5:"))).toBe(true);

    // 无"版本身份"节点残留
    expect(merged.specs.map((s) => s.chunk_id).sort()).toEqual([...ALPHA_IDS].sort());

    // 版本侧边并入（端点改写为 baseline uri）
    const triples = triplesOf(merged.edges);
    expect(triples).toContain(
      `${bu("tdd", "[TDD]-gamma")}\tdepends_on\t${bu("prd", "[PRD]-alpha")}`,
    );
    expect(triples).toContain(
      `${bu("fsd", "[FSD]-alpha")}\tdecomposes\t${bu("fsd", "[FSD]-alpha:beta")}`,
    );
    // owned-scope 内被取代的 baseline depends_on 删除
    expect(triples).not.toContain(
      `${bu("fsd", "[FSD]-alpha:beta")}\tdepends_on\t${bu("tdd", "[TDD]-gamma")}`,
    );
    // 其它 baseline 边原样保留
    expect(triples).toContain(
      `${bu("prd", "[PRD]-alpha")}\tdepends_on\t${bu("tdd", "[TDD]-gamma")}`,
    );
    expect(merged.edges).toHaveLength(3);

    // 版本图文件保留不改
    expect(fs.readFileSync(vpath).equals(vbytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addEdge — FSD:graph_model 契约
// ---------------------------------------------------------------------------

describe("addEdge", () => {
  it("幽灵端点拒绝 MISSING_ENDPOINT 且零写入", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    expectSpecGraphError(
      () => store.addEdge("v1", "[PRD]-ghost", "[TDD]-gamma", "depends_on", "manual"),
      "MISSING_ENDPOINT",
    );
    expectSpecGraphError(
      () => store.addEdge("v1", "[PRD]-alpha", "[TDD]-ghost", "depends_on", "manual"),
      "MISSING_ENDPOINT",
    );
    // 零写入：版本图文件不存在
    expect(fs.existsSync(graphPathOf(root, "v1"))).toBe(false);
  });

  it("重复边拒绝 DUPLICATE_EDGE 且零写入（同端点同关系）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    store.addEdge("v1", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "manual");
    const bytes = readBytes(root, "v1");

    expectSpecGraphError(
      () => store.addEdge("v1", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "new-model-cli"),
      "DUPLICATE_EDGE",
    );
    // 零写入：字节未变，且仍只有首次那条边
    expect(readBytes(root, "v1").equals(bytes)).toBe(true);
    const vgraph = store.load("v1");
    expect(
      vgraph.edges.filter(
        (e) =>
          e.src === "spec:prd:v1:[PRD]-alpha" &&
          e.dst === "spec:tdd:v1:[TDD]-gamma" &&
          e.rel === "depends_on",
      ),
    ).toHaveLength(1);
    expect(vgraph.edges[0]?.metadata["source"]).toBe("manual");
  });

  it("持久化形态含 weight=1 与 metadata.source，端点自 baseline 物化进版本图", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    store.addEdge("v1", "[PRD]-alpha", "[TDD]-gamma", "depends_on", "new-model-cli");

    const vgraph = new SpecGraphStore(root).load("v1");
    expect(vgraph.edges).toHaveLength(1);
    expect(vgraph.edges[0]).toMatchObject({
      src: "spec:prd:v1:[PRD]-alpha",
      dst: "spec:tdd:v1:[TDD]-gamma",
      rel: "depends_on",
      weight: 1.0,
      metadata: { source: "new-model-cli" },
    });
    // 端点自 baseline 物化进版本图，uri 版本段为 v1；版本图只含被物化的端点
    const alpha = nodeById(vgraph, "[PRD]-alpha");
    const gamma = nodeById(vgraph, "[TDD]-gamma");
    expect(alpha).toMatchObject({ uri: "spec:prd:v1:[PRD]-alpha", version: "v1" });
    expect(gamma).toMatchObject({ uri: "spec:tdd:v1:[TDD]-gamma", version: "v1" });
    expect(vgraph.specs.map((s) => s.chunk_id).sort()).toEqual(
      ["[PRD]-alpha", "[TDD]-gamma"].sort(),
    );

    // 磁盘形态：weight 与 metadata.source 落在文件里
    const raw = fs.readFileSync(graphPathOf(root, "v1"), "utf-8");
    expect(raw).toContain("weight: 1");
    expect(raw).toContain("source: new-model-cli");
  });
});

// ---------------------------------------------------------------------------
// v0.10 — save 候选图的真实持久化入口
// ---------------------------------------------------------------------------

describe("save", () => {
  it("保存候选图并稳定排序；重复保存相同语义不改 updated、字节和 mtime", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    store.addEdge("v10", "[PRD]-alpha", "[FSD]-alpha:beta", "derives", "fsd-declaration");
    const candidate = store.load("v10");
    candidate.specs.reverse();
    candidate.updated = "2000-01-01T00:00:00.000Z";
    nodeById(candidate, "[FSD]-alpha:beta")!.metadata["fsd_declaration_overrides"] = { derives: true };

    store.save("v10", candidate);
    const saved = new SpecGraphStore(root).load("v10");
    expect(saved.specs.map((spec) => spec.uri)).toEqual(candidate.specs.map((spec) => spec.uri).sort());
    expect(saved.updated).not.toBeNull();
    expect(saved.updated).not.toBe(candidate.updated);
    expect(nodeById(saved, "[FSD]-alpha:beta")?.metadata)
      .toHaveProperty("fsd_declaration_overrides", { derives: true });
    const file = graphPathOf(root, "v10");
    // 固定旧 mtime，让错误的重复写盘即使发生于同一毫秒也可被检出。
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    fs.utimesSync(file, oldTime, oldTime);
    const bytes = readBytes(root, "v10");
    const mtime = fs.statSync(file).mtimeMs;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      new SpecGraphStore(root).save("v10", {
        ...saved,
        updated: "2001-01-01T00:00:00.000Z",
        specs: [...saved.specs].reverse(),
      });
      expect(store.load("v10").updated).toBe(saved.updated);
      expect(readBytes(root, "v10").equals(bytes)).toBe(true);
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
    }
  });

  it.each(["未知字段", "非法 chunk_id", "非法 weight"])(
    "%s 在 save 前被 schema 拒绝：既有文件不变、新路径无残留",
    (invalidCase) => {
      const root = makeRoot();
      writeDocs(root, ALPHA_TREE);
      reindexBaseline(root);
      const store = new SpecGraphStore(root);
      store.sync();
      store.addEdge("v10", "[PRD]-alpha", "[FSD]-alpha:beta", "derives", "fsd-declaration");
      const graph = store.load("v10");
      const invalid = invalidCase === "未知字段"
        ? { ...graph, unexpected: true }
        : invalidCase === "非法 chunk_id"
          ? { ...graph, specs: [{ ...graph.specs[0], chunk_id: 42 }] }
          : { ...graph, edges: [{ ...graph.edges[0], weight: "invalid" }] };
      const bytes = readBytes(root, "v10");
      const baselineBytes = readBytes(root);
      const files = fs.readdirSync(root.meta).sort();

      for (const version of ["v10", "v-new"]) {
        expectSpecGraphError(
          () => store.save(version, invalid as unknown as SpecGraph),
          "GRAPH_UNREADABLE",
        );
      }
      expect(readBytes(root, "v10").equals(bytes)).toBe(true);
      expect(readBytes(root).equals(baselineBytes)).toBe(true);
      expect(fs.existsSync(graphPathOf(root, "v-new"))).toBe(false);
      expect(fs.readdirSync(root.meta).sort()).toEqual(files);
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 第 3~4 条 — queries
// ---------------------------------------------------------------------------

describe("queries", () => {
  it("三向单跳（in/out/both）分别返回邻接边，默认 both", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    // 单跳只取已存在的边：显式建一条 split→子 FSD 的 decomposes
    store.addEdge("baseline", "[FSD]-alpha:beta", "[FSD]-alpha-beta", "decomposes", "manual");

    const view = combinedView(root);
    const target = "[FSD]-alpha:beta";

    const outgoing = queryDeps(view, target, "out");
    expect(outgoing.found).toBe(true);
    expect(outgoing.target).toBe(target);
    expect(outgoing.direction).toBe("out");
    expect(outgoing.edges).toHaveLength(1);
    expect(outgoing.edges[0]).toMatchObject({
      src: target,
      dst: "[FSD]-alpha-beta",
      rel: "decomposes",
    });

    // in：id 结构通道不在单跳里（只沿已存边），显式建反向边
    store.addEdge("baseline", "[FSD]-alpha", target, "decomposes", "manual");
    const view2 = combinedView(root);

    const incoming = queryDeps(view2, target, "in");
    expect(incoming.found).toBe(true);
    expect(incoming.direction).toBe("in");
    expect(incoming.edges).toHaveLength(1);
    expect(incoming.edges[0]).toMatchObject({
      src: "[FSD]-alpha",
      dst: target,
      rel: "decomposes",
    });

    const both = queryDeps(view2, target, "both");
    expect(both.found).toBe(true);
    expect(both.direction).toBe("both");
    expect(both.edges).toHaveLength(2);

    // 默认 direction 为 both
    const dflt = queryDeps(view2, target);
    expect(dflt).toEqual(both);
  });

  const relations: EdgeRel[] = ["derives", "decomposes", "details", "depends_on"];
  const directions: Direction[] = ["in", "out", "both"];

  /** 直接读取存量边；查询不承担新模型关系合法性校验或关系迁移。 */
  function relationFixture() {
    const root = makeRoot();
    const docs = { ...ALPHA_TREE, ...ISOLATED_TDD_PAIR };
    writeDocs(root, docs);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    const graph = store.sync();
    const target = "[FSD]-alpha:beta";
    const incoming: ViewEdge[] = relations.map((rel) => ({
      src: "[PRD]-alpha", dst: target, rel, metadata: { source: "manual", note: `入边 ${rel}` },
    }));
    const outgoing: ViewEdge[] = relations.map((rel) => ({
      src: target, dst: "[TDD]-gamma", rel, metadata: { source: "manual", note: `出边 ${rel}` },
    }));
    const legacyIncoming: ViewEdge = {
      src: "[TDD]-m", dst: target, rel: "implements", metadata: { source: "manual", historical: true },
    };
    const legacyOutgoing: ViewEdge = {
      src: target, dst: "[TDD]-n", rel: "implements", metadata: { source: "manual", historical: true },
    };
    const edges: ViewEdge[] = [
      ...incoming, ...outgoing, legacyIncoming, legacyOutgoing,
      // 第二跳与不相邻边不得出现在任何关系过滤结果中。
      { src: "[TDD]-gamma", dst: "[TDD]-m", rel: "details", metadata: { source: "manual" } },
      { src: "[TDD]-m", dst: "[TDD]-n", rel: "depends_on", metadata: { source: "manual" } },
    ];
    store.save("baseline", {
      ...graph,
      edges: edges.map((edge) => ({
        ...edge,
        src: nodeById(graph, edge.src)!.uri,
        dst: nodeById(graph, edge.dst)!.uri,
        weight: 1,
      })),
    });
    const files = fs.readdirSync(root.meta).sort();
    const before = snapshotFiles([
      ...files.map((file) => path.join(root.meta, file)),
      ...Object.keys(docs).map((file) => path.join(root.docs, file)),
    ]);
    return {
      root, target, incoming, outgoing, legacyIncoming, legacyOutgoing,
      view: combinedView(root),
      expectUnchanged() {
        expectFilesUnchanged(before);
        expect(fs.readdirSync(root.meta).sort()).toEqual(files);
      },
    };
  }

  it.each(relations)("单关系 %s 与 in/out/both 相交，关系选择不改变默认 both", (rel) => {
    const fixture = relationFixture();
    const { view, target, incoming, outgoing } = fixture;
    const expectedIncoming = incoming.filter((edge) => edge.rel === rel);
    const expectedOutgoing = outgoing.filter((edge) => edge.rel === rel);
    const both = queryDeps(view, target, undefined, [rel]);
    expect(both).toEqual({
      found: true, target, direction: "both",
      edges: expect.arrayContaining([...expectedIncoming, ...expectedOutgoing]),
    });
    expect(both.edges).toHaveLength(2);
    expect(queryDeps(view, target, "both", [rel])).toEqual(both);
    expect(queryDeps(view, target, "in", [rel])).toEqual({
      found: true, target, direction: "in", edges: expectedIncoming,
    });
    expect(queryDeps(view, target, "out", [rel])).toEqual({
      found: true, target, direction: "out", edges: expectedOutgoing,
    });
    fixture.expectUnchanged();
  });

  it.each(directions)("多关系并集再与 %s 相交，不递归、不同关系同端点不合并", (direction) => {
    const fixture = relationFixture();
    const { view, target, incoming, outgoing } = fixture;
    const selected: EdgeRel[] = ["details", "depends_on"];
    const expected = [
      ...(direction === "out" ? [] : incoming),
      ...(direction === "in" ? [] : outgoing),
    ].filter((edge) => selected.includes(edge.rel as EdgeRel));
    const result = queryDeps(view, target, direction, selected);
    expect(result).toEqual({ found: true, target, direction, edges: expect.arrayContaining(expected) });
    expect(result.edges).toHaveLength(expected.length);
    expect(triplesOf(result.edges)).toEqual(triplesOf(expected));
    // 重复关系既不增加边，也不改变查询顺序或调用方参数。
    const repeated: EdgeRel[] = ["details", "depends_on", "details", "depends_on"];
    const original = [...repeated];
    expect(queryDeps(view, target, direction, repeated)).toEqual(result);
    expect(repeated).toEqual(original);
    fixture.expectUnchanged();
  });

  it.each(directions)("%s 的缺省关系保留历史边，全选四关系排除历史边，空数组只清空结果", (direction) => {
    const fixture = relationFixture();
    const { view, target, incoming, outgoing, legacyIncoming, legacyOutgoing } = fixture;
    const selected = [
      ...(direction === "out" ? [] : incoming),
      ...(direction === "in" ? [] : outgoing),
    ];
    const all = [
      ...selected,
      ...(direction === "out" ? [] : [legacyIncoming]),
      ...(direction === "in" ? [] : [legacyOutgoing]),
    ];
    const unfiltered = queryDeps(view, target, direction);
    expect(unfiltered).toEqual({ found: true, target, direction, edges: expect.arrayContaining(all) });
    expect(unfiltered.edges).toHaveLength(all.length);
    expect(queryDeps(view, target, direction, undefined)).toEqual(unfiltered);
    const filtered = queryDeps(view, target, direction, relations);
    expect(filtered.edges).toHaveLength(selected.length);
    expect(triplesOf(filtered.edges)).toEqual(triplesOf(selected));
    expect(queryDeps(view, target, direction, [])).toEqual({ found: true, target, direction, edges: [] });
    // 空过滤不修改视图；随后不过滤仍取得同一组边及原 metadata。
    expect(queryDeps(view, target, direction)).toEqual(unfiltered);
    fixture.expectUnchanged();
  });

  it("自环经 both 的出入两路只返回一次，重复 rels 不增殖", () => {
    const root = makeRoot();
    writeDocs(root, ISOLATED_TDD_PAIR);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    const target = "[TDD]-m";
    store.addEdge("baseline", target, target, "depends_on", "manual");
    const before = snapshotFiles([graphPathOf(root), path.join(root.meta, "chunks-index.yaml")]);
    const view = combinedView(root);
    for (const direction of directions) {
      const expected = {
        found: true, target, direction,
        edges: [{ src: target, dst: target, rel: "depends_on", metadata: { source: "manual" } }],
      };
      expect(queryDeps(view, target, direction)).toEqual(expected);
      expect(queryDeps(view, target, direction, ["depends_on", "depends_on"])).toEqual(expected);
    }
    expectFilesUnchanged(before);
  });

  it.each(["from", "to", "IN", "", null, 42])("非法方向 %j 明确拒绝 USAGE_ERROR，已有或未知目标均零写入", (direction) => {
    const fixture = relationFixture();
    for (const target of [fixture.target, "[TDD]-nope"]) {
      expect(() => queryDeps(fixture.view, target, direction as Direction)).toThrowError(
        expect.objectContaining({ code: "USAGE_ERROR", message: expect.stringContaining("direction") }),
      );
    }
    fixture.expectUnchanged();
  });

  it.each([
    { label: "历史关系只能读、不能作为筛选值", rels: ["implements"] },
    { label: "未知关系不能被忽略", rels: ["details", "unknown"] },
    { label: "CLI 拼写不是领域关系名", rels: ["depends-on"] },
    { label: "关系须为字符串", rels: [42] },
    { label: "关系项不能为 null", rels: [null] },
    { label: "关系项不能缺失", rels: new Array(1) },
    { label: "关系须为数组", rels: "details" },
    { label: "null 不等于缺省", rels: null },
    { label: "对象不是关系数组", rels: { details: true } },
  ])("$label：USAGE_ERROR 且零写入", ({ rels }) => {
    const fixture = relationFixture();
    for (const target of [fixture.target, "[TDD]-nope"]) {
      expect(() => queryDeps(fixture.view, target, "both", rels as EdgeRel[])).toThrowError(
        expect.objectContaining({ code: "USAGE_ERROR", message: expect.stringContaining("rels") }),
      );
    }
    fixture.expectUnchanged();
  });

  it.each(directions)("%s 查询未知或孤立目标时保留 found 区别及方向，不推导结构边", (direction) => {
    const fixture = relationFixture();
    const { view } = fixture;
    for (const rels of [undefined, [], ["details"]] as Array<EdgeRel[] | undefined>) {
      expect(queryDeps(view, "[TDD]-nope", direction, rels)).toEqual({
        found: false, target: "[TDD]-nope", direction, edges: [],
      });
      // 根存在带冒号的子 split，但无存储边；邻接查询不生成结构边。
      expect(queryDeps(view, "[FSD]-alpha", direction, rels)).toEqual({
        found: true, target: "[FSD]-alpha", direction, edges: [],
      });
    }
    fixture.expectUnchanged();
  });

  it("不存在目标返回 found=false（不抛错）", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    new SpecGraphStore(root).sync();
    const view = combinedView(root);

    const res = queryDeps(view, "[TDD]-nope");
    expect(res.found).toBe(false);
    expect(res.target).toBe("[TDD]-nope");
    expect(res.edges).toEqual([]);

    const impact = analyzeImpact(view, "[TDD]-nope");
    expect(impact).toEqual({ found: false, impacted: [], count: 0 });
  });

  it("impact 沿五类通道传播且不含无关节点", () => {
    const root = makeRoot();
    writeDocs(root, {
      ...ALPHA_TREE,
      ...OMEGA_TREE,
      "tdd/[TDD]-solo.md": [
        "<!-- @id:[TDD]-solo -->",
        "## solo TDD",
        "solo 内容。",
      ],
    });
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();

    // 五类通道的边一律显式建：
    // 正向 derives / decomposes / details、id 结构子、反向 depends_on
    store.addEdge("baseline", "[PRD]-alpha", "[FSD]-alpha", "derives", "manual");
    store.addEdge("baseline", "[FSD]-alpha", "[FSD]-alpha-beta", "decomposes", "manual");
    store.addEdge("baseline", "[FSD]-alpha-beta", "[TDD]-gamma", "details", "manual");
    store.addEdge("baseline", "[TDD]-solo", "[FSD]-alpha", "depends_on", "manual");
    store.sync();

    const view = combinedView(root);
    const res = analyzeImpact(view, "[PRD]-alpha");
    expect(res.found).toBe(true);
    // derives + decomposes + details + id 结构子([FSD]-alpha:beta / [FSD]-alpha-beta:gamma)
    // + 反向 depends_on（solo 依赖 [FSD]-alpha）
    expect(res.impacted).toEqual(
      [
        "[FSD]-alpha",
        "[FSD]-alpha-beta",
        "[FSD]-alpha-beta:gamma",
        "[FSD]-alpha:beta",
        "[TDD]-gamma",
        "[TDD]-solo",
      ].sort(),
    );
    expect(res.count).toBe(res.impacted.length);
    // 不含自身与无关子树
    expect(res.impacted).not.toContain("[PRD]-alpha");
    expect(res.impacted).not.toContain("[PRD]-omega");
    expect(res.impacted).not.toContain("[FSD]-omega");
  });

  it("成环图经 detectCycle 报出环节点组", () => {
    const root = makeRoot();
    writeDocs(root, ISOLATED_TDD_PAIR);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    // 手工构环：m → n → m（树关系 decomposes）
    store.addEdge("vc", "[TDD]-m", "[TDD]-n", "decomposes", "manual");
    store.addEdge("vc", "[TDD]-n", "[TDD]-m", "decomposes", "manual");

    const view = combinedView(root, "vc");
    expect(detectCycle(view)).toEqual([["[TDD]-m", "[TDD]-n"]]);
    // analyzeImpact 在环上经 visited 终止
    const res = analyzeImpact(view, "[TDD]-m");
    expect(res.found).toBe(true);
    expect(res.impacted).toEqual(["[TDD]-n"]);
  });

  it("无环图 detectCycle 返回空", () => {
    const root = makeRoot();
    writeDocs(root, ALPHA_TREE);
    reindexBaseline(root);
    new SpecGraphStore(root).sync();
    expect(detectCycle(combinedView(root))).toEqual([]);
  });

  it("depends_on 环不触发 detectCycle，analyzeImpact 经 visited 终止", () => {
    const root = makeRoot();
    writeDocs(root, ISOLATED_TDD_PAIR);
    reindexBaseline(root);
    const store = new SpecGraphStore(root);
    store.sync();
    store.addEdge("vd", "[TDD]-m", "[TDD]-n", "depends_on", "manual");
    store.addEdge("vd", "[TDD]-n", "[TDD]-m", "depends_on", "manual");

    const view = combinedView(root, "vd");
    // depends_on 不参与判环（设计如此）
    expect(detectCycle(view)).toEqual([]);
    const res = analyzeImpact(view, "[TDD]-m");
    expect(res.found).toBe(true);
    expect(res.impacted).toEqual(["[TDD]-n"]);
    expect(res.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

describe("边界", () => {
  it("空图合法（图文件不存在 → 空图，查询全空）", () => {
    const root = makeRoot(); // 无 docs 文件、无图文件
    const store = new SpecGraphStore(root);

    const baselineGraph = store.load();
    expect(baselineGraph.specs).toEqual([]);
    expect(baselineGraph.edges).toEqual([]);

    const versionGraph = store.load("v-absent");
    expect(versionGraph.specs).toEqual([]);
    expect(versionGraph.edges).toEqual([]);

    const view = combinedView(root);
    expect(view.nodes.size).toBe(0);
    expect(view.hasNode("[PRD]-alpha")).toBe(false);
    expect(view.edgesFrom("[PRD]-alpha")).toEqual([]);
    expect(queryDeps(view, "[PRD]-alpha").found).toBe(false);
    expect(analyzeImpact(view, "[PRD]-alpha")).toEqual({
      found: false,
      impacted: [],
      count: 0,
    });
    expect(detectCycle(view)).toEqual([]);

    // 空图合法：sync 写出的也是空图
    const synced = store.sync();
    expect(synced.specs).toEqual([]);
    expect(synced.edges).toEqual([]);
  });

  it("损坏图 GRAPH_UNREADABLE（含路径，fail closed）", () => {
    const root = makeRoot();
    const file = graphPathOf(root);
    const store = new SpecGraphStore(root);

    // YAML 语法损坏
    writeYaml(file, "[1, 2");
    try {
      store.load();
      expect.unreachable("应抛出 SpecGraphError(GRAPH_UNREADABLE)");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecGraphError);
      expect((err as SpecGraphError).code).toBe("GRAPH_UNREADABLE");
      expect((err as Error).message).toContain(file);
    }

    // schema 校验失败同样 GRAPH_UNREADABLE（Python 历史形态：specs 曾是对象映射，
    // 当前形态要求数组，读时不再宽容该形态）
    writeYaml(
      file,
      [
        "version: 1",
        "updated: null",
        "specs:",
        '  "spec:prd:baseline:[PRD]-alpha":',
        "    chunk_id: '[PRD]-alpha'",
        "edges: []",
      ].join("\n"),
    );
    expectSpecGraphError(() => store.load(), "GRAPH_UNREADABLE");

    // 节点缺必填 chunk_id 同样拒绝
    writeYaml(
      file,
      [
        "version: 1",
        "updated: null",
        "specs:",
        "  - uri: spec:prd:baseline:[PRD]-alpha",
        "    title: alpha",
        "edges: []",
      ].join("\n"),
    );
    expectSpecGraphError(() => store.load(), "GRAPH_UNREADABLE");

    // 未知字段被 strict schema 拒绝
    writeYaml(file, ["version: 1", "updated: null", "specs: []", "edges: []", "bogus: 1"].join("\n"));
    expectSpecGraphError(() => store.load(), "GRAPH_UNREADABLE");

    // 版本图损坏同样 fail closed
    writeYaml(graphPathOf(root, "v9"), "specs: [");
    expectSpecGraphError(() => store.load("v9"), "GRAPH_UNREADABLE");
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 5 条 — 真实语料（AIT-project 的 project-docs 副本与 ait-core 自身）
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
      .map((item) => (path.basename(item) === ".meta" ? path.dirname(item) : item))
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

/** 文档里 ```yaml 声明的 target_file（与视图节点应对应）。 */
function declaredTargetFile(content: string): string | undefined {
  return /```yaml\s*\ntarget_file:\s*([^ \t\r\n]+)/.exec(content)?.[1];
}

/** 图文件里 specs / edges 列表的原始长度（fail closed：形态不符返回 -1）。 */
function rawListLength(file: string, key: "specs" | "edges"): number {
  if (!fs.existsSync(file)) return -1;
  const model = parseYaml(fs.readFileSync(file, "utf-8")) as Record<string, unknown> | null;
  const list = model?.[key];
  return Array.isArray(list) ? list.length : -1;
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
      `真实语料用例启用：${corpus.existing
        .map((d) => path.basename(path.dirname(d)) + "/" + path.basename(d))
        .join(", ")}`,
    );
  }

  for (const src of corpus.existing) {
    const label = path.basename(path.dirname(src)) + "/" + path.basename(src);

    it(`加载 ${label} 的基线图与全部版本图，边数与文件一致`, () => {
      const base = mkTmp();
      const pd = copyProjectDocs(src, base);
      const graphRoot = resolveProjectRoot(base);
      const store = new SpecGraphStore(graphRoot);
      const indexes = new IndexManager(graphRoot);

      // 基线图：节点与基线索引逐 id 一致；边数等于文件 edges 长度
      const baseline = store.load();
      const expected = new Set(indexes.loadBaseline().chunks.map((c) => c.id));
      expect(baseline.specs.length).toBe(expected.size);
      expect(new Set(baseline.specs.map((s) => s.chunk_id))).toEqual(expected);
      expect(baseline.specs.length).toBe(rawListLength(graphPathOf(graphRoot), "specs"));
      expect(baseline.edges.length).toBe(rawListLength(graphPathOf(graphRoot), "edges"));
      expect(baseline.edges.length).toBeGreaterThan(0);

      // 每个版本图加载成功，边数等于文件中 edges 长度、节点数等于版本索引条目数
      const versions = indexes.listVersions();
      for (const v of versions) {
        const graph = store.load(v);
        expect(graph.specs.length).toBe(indexes.loadVersionIndex(v).chunks.length);
        expect(graph.specs.length).toBe(rawListLength(graphPathOf(graphRoot, v), "specs"));
        expect(graph.edges.length).toBe(rawListLength(graphPathOf(graphRoot, v), "edges"));
        expect(graph.specs.every((s) => s.version === v)).toBe(true);
      }
      expect(versions.length).toBeGreaterThan(0);
    });

    it(`在 ${label} 的最新版本上建组合视图：deps/impact/export 全成功，TDD target_file 与文档声明一致`, () => {
      const base = mkTmp();
      copyProjectDocs(src, base);
      const graphRoot = resolveProjectRoot(base);
      const indexes = new IndexManager(graphRoot);
      const store = new SpecGraphStore(graphRoot);

      const versions = indexes.listVersions();
      expect(versions.length).toBeGreaterThan(0);
      const latest = versions[versions.length - 1] as string;
      const view = combinedView(graphRoot, latest);

      // baseline∪version 坍缩：视图节点数不小于最新版本图节点数
      expect(view.nodes.size).toBeGreaterThanOrEqual(store.load(latest).specs.length);

      // TDD 视图节点的 target_file 与文档 yaml 声明一致
      let tddChecked = 0;
      for (const node of view.nodes.values()) {
        if (node.type !== "tdd") continue;
        expect(node.target_file).toBeDefined();
        expect(node.summary).toBeDefined();
        const doc = path.join(graphRoot.docs, `${node.file}.md`);
        const vdoc = path.join(graphRoot.root, "versions", node.version, `${node.file}.md`);
        const content = fs.existsSync(vdoc)
          ? fs.readFileSync(vdoc, "utf-8")
          : fs.readFileSync(doc, "utf-8");
        const marker = `<!-- @id:${node.chunk_id} -->`;
        const start = content.indexOf(marker);
        expect(start).toBeGreaterThanOrEqual(0);
        const next = content.indexOf("<!-- @id:", start + marker.length);
        const body = content.slice(start, next === -1 ? undefined : next);
        expect(node.target_file).toBe(declaredTargetFile(body));
        tddChecked += 1;
      }
      expect(tddChecked).toBeGreaterThan(0);

      // deps / impact 对若干 chunk 成功（不抛错；found 与视图节点齐平）
      const ids = [...view.nodes.keys()];
      for (const dir of ["in", "out", "both"] as const) {
        for (const id of ids.slice(0, 10)) {
          const res = queryDeps(view, id, dir);
          expect(res.found).toBe(true);
          expect(res.direction).toBe(dir);
          expect(res.edges.every((e) => e.src === id || e.dst === id)).toBe(true);
          if (dir === "in") expect(res.edges.every((e) => e.dst === id)).toBe(true);
          if (dir === "out") expect(res.edges.every((e) => e.src === id)).toBe(true);
        }
      }
      for (const id of ids.slice(0, 10)) {
        const res = analyzeImpact(view, id);
        expect(res.found).toBe(true);
        expect(res.count).toBe(res.impacted.length);
        expect(res.impacted).not.toContain(id);
      }
    });

    it(`对 ${label} 副本执行 sync 后，已合入版本的图文件字节不变`, () => {
      const base = mkTmp();
      copyProjectDocs(src, base);
      const graphRoot = resolveProjectRoot(base);
      const indexes = new IndexManager(graphRoot);
      const store = new SpecGraphStore(graphRoot);

      // 已合入版本：其版本图属只读，sync 不读不写
      const merged = indexes
        .listVersions()
        .filter((v) => indexes.loadVersionIndex(v).status === "merged");
      expect(merged.length).toBeGreaterThan(0);
      const before = new Map<string, Buffer>(
        merged.map((v) => [v, fs.readFileSync(graphPathOf(graphRoot, v))]),
      );
      const baselineTriples = triplesOf(store.load().edges);
      const baselineBytes = fs.readFileSync(graphPathOf(graphRoot));

      store.sync();

      for (const v of merged) {
        expect(fs.readFileSync(graphPathOf(graphRoot, v)).equals(before.get(v) as Buffer)).toBe(
          true,
        );
      }
      // 基线图重建后显式边三元组不变（真实语料边全部带 metadata.source）
      const rebuilt = store.load();
      expect(rebuilt.edges.length).toBeGreaterThan(0);
      expect(triplesOf(rebuilt.edges)).toEqual(baselineTriples);
      // 重建是语义幂等的：再 sync 一次基线图字节不变
      store.sync();
      expect(fs.readFileSync(graphPathOf(graphRoot)).equals(baselineBytes)).toBe(true);
    });
  }
});
