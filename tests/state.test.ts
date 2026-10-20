// [TDD]-state_tests — 状态读模型、面板与保存的独立业务验收。
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadVersionState,
  renderMarkdown,
  renderState,
  saveState,
  type StatePanel,
} from "../src/cli/state.js";
import {
  BaselineIndexSchema,
  ChangeRecordSchema,
  SpecGraphSchema,
  VersionChunkEntrySchema,
  VersionIndexSchema,
  VersionMetaSchema,
  type Action,
  type State,
  type VersionChunkEntry,
  type VersionMeta,
} from "../src/doc-model/schemas.js";
import { resolveProjectRoot, type ProjectRoot } from "../src/foundation/root.js";
import { saveModel } from "../src/foundation/yaml.js";
import { IndexManager } from "../src/indexing/index-manager.js";

const VERSION = "v0.10";
const TIME = "2026-01-02T03:04:05.000Z";
const temporaryRoots = new Set<string>();

// 只清理由本用例登记且仍位于系统临时目录下的真实根目录。
afterEach(() => {
  const temp = fs.realpathSync(os.tmpdir());
  for (const owned of temporaryRoots) {
    const resolved = fs.realpathSync(owned);
    if (resolved !== owned || path.dirname(resolved) !== temp || !path.basename(resolved).startsWith("ait-state-")) {
      throw new Error(`Refusing to remove an unowned temporary root: ${owned}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function snapshot(root: string): Map<string, Buffer | null> {
  const result = new Map<string, Buffer | null>();
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        result.set(`${relative}/`, null);
        visit(absolute);
      } else {
        result.set(relative, fs.readFileSync(absolute));
      }
    }
  }
  visit(root);
  return result;
}

function readOnly<T>(root: ProjectRoot, operation: () => T): T {
  const before = snapshot(root.root);
  try {
    return operation();
  } finally {
    expect(snapshot(root.root)).toEqual(before);
  }
}

const graph = SpecGraphSchema.parse({
  updated: TIME,
  specs: [
    { uri: "spec:fsd:baseline:[FSD]-graph_only", chunk_id: "[FSD]-graph_only", title: "GRAPH_ONLY" },
    { uri: "spec:tdd:baseline:[TDD]-graph_only", chunk_id: "[TDD]-graph_only", title: "GRAPH_ONLY" },
  ],
  edges: [{ src: "spec:fsd:baseline:[FSD]-graph_only", dst: "spec:tdd:baseline:[TDD]-graph_only", rel: "details" }],
});

function fixture(): ProjectRoot {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ait-state-"));
  temporaryRoots.add(base);
  const managed = path.join(base, "project-docs");
  for (const dir of ["docs/prd", "docs/fsd", "docs/tdd", ".meta/versions", ".meta/changes", "versions"]) {
    fs.mkdirSync(path.join(managed, dir), { recursive: true });
  }
  const root = resolveProjectRoot(base);
  fs.writeFileSync(path.join(root.docs, "prd", "baseline.md"), "<!-- @id:[PRD]-baseline -->\r\n## BASELINE_ONLY\r\n原始基线字节。\r\n");
  saveModel(path.join(root.meta, "chunks-index.yaml"), BaselineIndexSchema.parse({
    updated: TIME,
    chunks: [{ id: "[PRD]-baseline", file: "prd/baseline", heading: "BASELINE_ONLY", level: 2 }],
  }));
  saveModel(path.join(root.meta, "specgraph.yaml"), graph);
  saveModel(path.join(root.meta, "changes", "chg-old.yaml"), ChangeRecordSchema.parse({
    id: "chg-old", version: "v0.9", type: "MODIFY", target: "prd/baseline#[PRD]-baseline",
    date: TIME, message: "HISTORY_ONLY", base_content: "旧内容", new_content: "新内容",
  }));
  return root;
}

function chunk(id: string, file: string | null, state: State, action: Action): VersionChunkEntry {
  return VersionChunkEntrySchema.parse({
    id, file, state, action,
    heading: file === null ? null : "HEADING_ONLY",
    level: file === null ? null : 2,
    summary: "SUMMARY_ONLY",
    commit_id: state === "committed" ? "commit-old" : null,
  });
}

function mixedChunks(): VersionChunkEntry[] {
  return [
    chunk("[TDD]-worker", "tdd/worker", "staged", "modify"),
    chunk("[PRD]-feature", "prd/feature", "working", "add"),
    chunk("[TDD]-contract", "tdd/contract", "committed", "add"),
    chunk("[FSD]-service:TEST", "fsd/service", "staged", "add"),
    chunk("[PRD]-legacy", "prd/legacy", "committed", "modify"),
    chunk("[TDD]-runner", "tdd/runner", "working", "modify"),
    chunk("[TDD]-obsolete", null, "working", "delete"),
  ];
}

function seedVersion(
  root: ProjectRoot,
  version = VERSION,
  meta: Partial<VersionMeta> = {},
  chunks = mixedChunks(),
): void {
  const model = VersionMetaSchema.parse({
    version, created_at: TIME, title: "TITLE_ONLY 独立状态验收", phase: "tdd-creating",
    prd_locked: true, impl_locked: false, changes: ["chg-old"], ...meta,
  });
  saveModel(path.join(root.meta, "versions", `${version}.yaml`), model);
  new IndexManager(root).saveVersionIndex(VersionIndexSchema.parse({
    version_name: version,
    status: model.phase === "merged" || model.merged_at !== null ? "merged" : "developing",
    chunks,
    commits: [{ id: "commit-old", timestamp: TIME, message: "HISTORY_ONLY", chunks: ["[PRD]-legacy"] }],
  }));
  saveModel(path.join(root.meta, `specgraph-${version}.yaml`), graph);
  for (const entry of chunks) {
    if (entry.file === null) continue;
    const target = path.join(root.root, "versions", version, `${entry.file}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `<!-- @id:${entry.id} -->\n## HEADING_ONLY\nDOCUMENT_ONLY 原始规格。\n`);
  }
}

const expectedMixed: StatePanel = {
  version: VERSION, title: "TITLE_ONLY 独立状态验收", phase: "tdd-creating",
  prd_locked: true, impl_locked: false, merged: false,
  working: ["[PRD]-feature", "[TDD]-runner", "[TDD]-obsolete"],
  staged: ["[TDD]-worker", "[FSD]-service:TEST"],
  committed: ["[TDD]-contract", "[PRD]-legacy"],
  by_action: { modify: 3, add: 3, delete: 1 },
  prd_chunks: ["[PRD]-feature", "[PRD]-legacy"],
  fsd_chunks: ["[FSD]-service:TEST"],
  tdd_chunks: ["[TDD]-worker", "[TDD]-contract", "[TDD]-runner", "[TDD]-obsolete"],
  counts: { working: 3, staged: 2, committed: 2, prd: 2, fsd: 1, tdd: 4 },
};

describe("state read model", () => {
  it("reads exact metadata, state/layer IDs, counts and actions without changing any bytes", () => {
    const root = fixture();
    seedVersion(root, "v0.9", { phase: "merged", merged_at: TIME });
    seedVersion(root);
    const first = readOnly(root, () => loadVersionState(root));
    expect(first).toEqual(expectedMixed);
    expect(readOnly(root, () => loadVersionState(root))).toEqual(first);
    expect(readOnly(root, () => loadVersionState(root, VERSION))).toEqual(first);
  });

  it.each(["no versions", "only merged versions"])("rejects implicit selection with NO_VERSION: %s", (scenario) => {
    const root = fixture();
    if (scenario === "only merged versions") seedVersion(root, "v0.9", { phase: "merged", merged_at: TIME });
    for (const operation of [
      () => loadVersionState(root),
      () => renderState(root, undefined, "json"),
      () => renderState(root, null, "markdown"),
      () => saveState(root),
    ]) {
      expect(() => readOnly(root, () => operation())).toThrowError(expect.objectContaining({ code: "NO_VERSION" }));
    }
  });

  it("rejects an explicit unknown version without falling back to the active version", () => {
    const root = fixture();
    seedVersion(root);
    for (const operation of [
      () => loadVersionState(root, "v9.99"),
      () => renderState(root, "v9.99", "json"),
      () => renderState(root, "v9.99", "markdown"),
      () => saveState(root, "v9.99"),
    ]) {
      expect(() => readOnly(root, () => operation())).toThrowError(expect.objectContaining({ code: "VERSION_NOT_FOUND" }));
    }
  });

  it.each([
    { phase: "merged" as const, merged_at: null },
    { phase: "coding" as const, merged_at: TIME },
  ])("explicitly reads a merged version ($phase, $merged_at) while another version is active", (meta) => {
    const root = fixture();
    seedVersion(root);
    seedVersion(root, "v0.9", { ...meta, title: "Archived", impl_locked: true }, [
      chunk("[PRD]-archived", "prd/archived", "committed", "add"),
    ]);
    const expected: StatePanel = {
      version: "v0.9", title: "Archived", phase: meta.phase, prd_locked: true, impl_locked: true, merged: true,
      working: [], staged: [], committed: ["[PRD]-archived"], by_action: { add: 1 },
      prd_chunks: ["[PRD]-archived"], fsd_chunks: [], tdd_chunks: [],
      counts: { working: 0, staged: 0, committed: 1, prd: 1, fsd: 0, tdd: 0 },
    };
    expect(readOnly(root, () => loadVersionState(root, "v0.9"))).toEqual(expected);
    expect(readOnly(root, () => renderState(root, "v0.9", "json"))).toEqual(expected);
    const markdown = readOnly(root, () => renderState(root, "v0.9", "markdown"));
    expect(markdown).toMatchObject({ version: "v0.9", format: "markdown", content: expect.stringContaining("[PRD]-archived") });
    expect(readOnly(root, () => loadVersionState(root))).toEqual(expectedMixed);
  });

  it("represents an empty version with null title, unlocked metadata and zero counts", () => {
    const root = fixture();
    seedVersion(root, VERSION, { phase: "empty", title: null, prd_locked: false }, []);
    const panel = readOnly(root, () => loadVersionState(root));
    expect(panel).toEqual({
      version: VERSION, title: null, phase: "empty", prd_locked: false, impl_locked: false, merged: false,
      working: [], staged: [], committed: [], by_action: {}, prd_chunks: [], fsd_chunks: [], tdd_chunks: [],
      counts: { working: 0, staged: 0, committed: 0, prd: 0, fsd: 0, tdd: 0 },
    });
    const markdown = readOnly(root, () => renderMarkdown(panel));
    expect(markdown.match(/^\| (?:working|staged|committed) \| 0 \| - \|$/gm)).toHaveLength(9);
    expect(markdown).not.toMatch(/\[(?:PRD|FSD|TDD)\]-/);
  });
});

describe("state rendering", () => {
  it("returns the actual structured panel for JSON and a Markdown wrapper for Markdown", () => {
    const root = fixture();
    seedVersion(root);
    expect(readOnly(root, () => renderState(root, VERSION, "json"))).toEqual(expectedMixed);
    const panel = readOnly(root, () => loadVersionState(root));
    const content = readOnly(root, () => renderMarkdown(panel));
    expect(readOnly(root, () => renderState(root, undefined, "markdown"))).toEqual({ version: VERSION, format: "markdown", content });
  });

  it("renders only phase and current-version layer/state tables, excluding history and graph data", () => {
    const root = fixture();
    seedVersion(root);
    seedVersion(root, "v0.9", { phase: "merged", merged_at: TIME }, [
      chunk("[PRD]-archived", "prd/archived", "committed", "add"),
    ]);
    const panel = readOnly(root, () => loadVersionState(root));
    const markdown = readOnly(root, () => renderMarkdown(panel));
    expect(markdown.match(/^#{1,3} .+$/gm)).toEqual([
      `# AIT State — ${VERSION}`, "## 当前执行阶段", "## 当前版本 Chunk", "### PRD", "### FSD", "### TDD",
    ]);
    expect(markdown.match(/^- .+$/gm)).toEqual(["- Phase: `tdd-creating`"]);
    const tables = markdown.split(/^### /m).slice(1).map((section) => ({
      layer: section.split("\n")[0],
      rows: section.split("\n").filter((line) => /^\| (working|staged|committed) \|/.test(line))
        .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim())),
    }));
    expect(tables).toEqual([
      { layer: "PRD", rows: [["working", "1", "`[PRD]-feature`"], ["staged", "0", "-"], ["committed", "1", "`[PRD]-legacy`"]] },
      { layer: "FSD", rows: [["working", "0", "-"], ["staged", "1", "`[FSD]-service:TEST`"], ["committed", "0", "-"]] },
      { layer: "TDD", rows: [["working", "2", "`[TDD]-runner`, `[TDD]-obsolete`"], ["staged", "1", "`[TDD]-worker`"], ["committed", "1", "`[TDD]-contract`"]] },
    ]);
    expect(markdown).not.toMatch(/TITLE_ONLY|HEADING_ONLY|SUMMARY_ONLY|DOCUMENT_ONLY|BASELINE_ONLY|HISTORY_ONLY|GRAPH_ONLY|chg-old|commit-old/);
    expect(markdown).not.toMatch(/\[PRD\]-baseline|\[PRD\]-archived|graph_only|spec:|specgraph|derives|details|depends_on|edges?|历史|孤立/i);
  });

  it("distinguishes a later valid phase and changed indexed chunks without using stale documents", () => {
    const root = fixture();
    seedVersion(root);
    const beforeJson = readOnly(root, () => renderState(root, VERSION, "json"));
    const beforeMarkdown = readOnly(root, () => renderState(root, VERSION, "markdown"));
    seedVersion(root, VERSION, { phase: "coding", impl_locked: true }, [
      chunk("[TDD]-worker", "tdd/worker", "committed", "modify"),
    ]);
    const panel = readOnly(root, () => renderState(root, VERSION, "json"));
    expect(panel).toEqual({
      version: VERSION, title: expectedMixed.title, phase: "coding", prd_locked: true, impl_locked: true, merged: false,
      working: [], staged: [], committed: ["[TDD]-worker"], by_action: { modify: 1 },
      prd_chunks: [], fsd_chunks: [], tdd_chunks: ["[TDD]-worker"],
      counts: { working: 0, staged: 0, committed: 1, prd: 0, fsd: 0, tdd: 1 },
    });
    const markdown = readOnly(root, () => renderState(root, VERSION, "markdown"));
    expect(panel).not.toEqual(beforeJson);
    expect(markdown).not.toEqual(beforeMarkdown);
    expect(markdown).toMatchObject({ content: expect.stringContaining("- Phase: `coding`") });
    if (!("content" in markdown)) throw new Error("Expected Markdown wrapper");
    expect(markdown.content).toContain("| committed | 1 | `[TDD]-worker` |");
    expect(markdown.content).not.toMatch(/\[PRD\]-feature|\[TDD\]-runner/);
  });
});

describe("state persistence", () => {
  it.each([
    { label: "implicit active version, new file", selected: undefined, existing: false },
    { label: "explicit active version, old file", selected: VERSION, existing: true },
    { label: "explicit merged version, old file", selected: "v0.9", existing: true },
  ])("saves only state.md, returns its path and is byte-stable: $label", ({ selected, existing }) => {
    const root = fixture();
    seedVersion(root);
    seedVersion(root, "v0.9", { phase: "merged", merged_at: TIME }, [
      chunk("[PRD]-archived", "prd/archived", "committed", "add"),
    ]);
    const version = selected ?? VERSION;
    const relative = `versions/${version}/state.md`;
    const target = path.join(root.root, relative);
    if (existing) fs.writeFileSync(target, "# Stale state\r\n");
    const panel = readOnly(root, () => loadVersionState(root, selected));
    const content = readOnly(root, () => renderMarkdown(panel));
    const expected = snapshot(root.root);
    expected.set(relative, Buffer.from(content, "utf8"));
    expect(saveState(root, selected)).toBe(target);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
    expect(snapshot(root.root)).toEqual(expected);
    expect(saveState(root, selected)).toBe(target);
    expect(snapshot(root.root)).toEqual(expected);
  });

  it("creates the missing version directory for an empty version without changing metadata or indexes", () => {
    const root = fixture();
    seedVersion(root, VERSION, { phase: "empty", title: null, prd_locked: false }, []);
    const directory = path.join(root.root, "versions", VERSION);
    expect(fs.existsSync(directory)).toBe(false);
    const panel = readOnly(root, () => loadVersionState(root));
    const content = readOnly(root, () => renderMarkdown(panel));
    const expected = snapshot(root.root);
    expected.set(`versions/${VERSION}/`, null);
    expected.set(`versions/${VERSION}/state.md`, Buffer.from(content, "utf8"));
    expect(saveState(root)).toBe(path.join(directory, "state.md"));
    expect(snapshot(root.root)).toEqual(expected);
  });
});
