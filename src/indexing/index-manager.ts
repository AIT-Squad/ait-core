/**
 * [TDD]-index_manager — chunks-index 的全生命周期管理（重建/查询/读写/版本枚举/统计重算）。
 *
 * 边界（硬约束）：
 * - 不校验索引内容的业务合法性（孤儿/幽灵归 new_model 域）；
 * - 不读 specgraph（块间关系归 specgraph 域）；
 * - 不解析 markdown（委托 doc_model 域的 chunk-parser）；
 * - 不做非原子写（一切落盘经 foundation 的 saveModel → 原子写）。
 *
 * baseline 与 per-version 索引分文件：
 *   `.meta/chunks-index.yaml` 与 `.meta/chunks-index-<version>.yaml`。
 * save 时 stats 从 chunks 全量重算（调用方不得手工维护）；
 * 版本号比较按数值 (major, minor)，禁止字典序；索引不存内容哈希；
 * 已合入版本（status=merged）的版本索引只读，saveVersionIndex 对其拒绝。
 * 本模块 import 零副作用；一切 IO 只发生在方法调用内。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ensureWithin, stripMdExt } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel, saveModel } from "../foundation/yaml.js";
import { parseFile, type Chunk } from "../doc-model/chunk-parser.js";
import {
  BaselineIndexSchema,
  VersionIndexSchema,
  type BaselineChunkEntry,
  type BaselineIndex,
  type VersionChunkEntry,
  type VersionIndex,
  type VersionIndexStats,
} from "../doc-model/schemas.js";

// ---------------------------------------------------------------------------
// 类型（索引数据模型以 doc-model/schemas 为单一权威，此处仅 re-export）
// ---------------------------------------------------------------------------

export type {
  BaselineChunkEntry,
  BaselineIndex,
  VersionChunkEntry,
  VersionIndex,
  VersionIndexStats,
};

/** 版本索引统计（{total_chunks, by_action, by_state, tasks_summary}）的兼容别名。 */
export type IndexStats = VersionIndexStats;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type IndexErrorCode = "INDEX_UNREADABLE" | "INDEX_READONLY";

/**
 * 索引错误：
 * - INDEX_UNREADABLE：索引文件损坏（YAML 语法/schema 校验失败等），fail closed，拒绝读取；
 * - INDEX_READONLY：试图写已合入版本（status=merged）的版本索引，零写入。
 */
export class IndexError extends Error {
  readonly code: IndexErrorCode;

  constructor(code: IndexErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IndexError";
    this.code = code;
  }
}

/** 版本索引文件不存在。 */
export class VersionIndexError extends Error {
  readonly code = "VERSION_NOT_FOUND" as const;

  constructor(version: string) {
    super(`版本索引不存在: ${version}`);
    this.name = "VersionIndexError";
  }
}

// ---------------------------------------------------------------------------
// 内部辅助（不导出）
// ---------------------------------------------------------------------------

/** save 时从 chunks 全量重算 stats（4 键；tasks_summary 保留 {}）。 */
function computeStats(chunks: readonly VersionChunkEntry[]): VersionIndexStats {
  const byAction: Record<string, number> = {};
  const byState: Record<string, number> = {};
  for (const chunk of chunks) {
    byAction[chunk.action] = (byAction[chunk.action] ?? 0) + 1;
    byState[chunk.state] = (byState[chunk.state] ?? 0) + 1;
  }
  return {
    total_chunks: chunks.length,
    by_action: byAction,
    by_state: byState,
    tasks_summary: {},
  };
}

/**
 * 重建基线时的摘要取值链（与 Python `build_baseline` 的
 * `chunk.summary or previous_summaries.get(id)` 保持一致）：
 * 解析所得摘要（`""` 按 falsy 处理，等价于 Python 的 `or`）→ 重建前同名 id 的旧摘要 → null。
 * 本域只做**沿用**，绝不从正文/标题派生摘要；`??` 而非 `||` 逐级兜底。
 */
function carriedSummary(
  parsed: string | null,
  previous: string | undefined,
): string | null {
  return (parsed === "" ? null : parsed) ?? previous ?? null;
}

/** 解析 "v<major>.<minor>" 为数值对；非法格式按 (0, 0) 处理（枚举源已限定 v*.yaml）。 */
function parseVersionPair(v: string): [number, number] {
  const m = /^v?(\d+)\.(\d+)$/.exec(v);
  return m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
}

/** 版本号比较：数值 (major, minor) 依次比较，禁止字典序（v2.10 > v2.9）。 */
function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor] = parseVersionPair(a);
  const [bMajor, bMinor] = parseVersionPair(b);
  return aMajor - bMajor || aMinor - bMinor;
}

/** commit_id 的数值序（如 "c12" → 12）；无数字返回 -1。 */
function commitOrdinal(commitId: string | null): number {
  if (commitId === null) return -1;
  const m = /(\d+)(?!.*\d)/.exec(commitId);
  return m === null ? -1 : Number(m[1]);
}

/**
 * 同 id 多条版本记录取最新：committed（commit_id 数值最大）> staged（写入序最后）
 * > working（写入序最后）；matches 非空。
 */
function latestRecord(matches: readonly VersionChunkEntry[]): VersionChunkEntry {
  let best: VersionChunkEntry | null = null;
  for (const c of matches) {
    if (c.state !== "committed") continue;
    if (best === null || commitOrdinal(c.commit_id) > commitOrdinal(best.commit_id)) {
      best = c;
    }
  }
  if (best !== null) return best;
  const staged = matches.filter((c) => c.state === "staged");
  if (staged.length > 0) return staged[staged.length - 1] as VersionChunkEntry;
  const working = matches.filter((c) => c.state === "working");
  if (working.length > 0) return working[working.length - 1] as VersionChunkEntry;
  return matches[matches.length - 1] as VersionChunkEntry;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 包装为 IndexError(INDEX_UNREADABLE)：消息含索引文件路径与（schema 错误时）字段路径。 */
function unreadable(p: string, err: unknown): IndexError {
  return new IndexError(
    "INDEX_UNREADABLE",
    `索引文件损坏，拒绝读取（fail closed）: ${p}: ${errorMessage(err)}`,
    { cause: err },
  );
}

/** 递归收集目录下全部 .md 文件绝对路径；目录不存在返回空。 */
function listMarkdownFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// IndexManager
// ---------------------------------------------------------------------------

export class IndexManager {
  private readonly root: ProjectRoot;

  constructor(root: ProjectRoot) {
    this.root = root;
  }

  /**
   * 从 docs/ 全量重建基线索引并原子写 `.meta/chunks-index.yaml`。
   *
   * 摘要沿用顺序（硬约束）：先读**重建前**的 `.meta/chunks-index.yaml` 取 id→summary 映射，
   * 再逐 chunk 用 `carriedSummary` 兜底——既有摘要不得因重建而丢失或改写；
   * 本方法不调用任何首行/标题截断逻辑，`chunk.summary` 直接取自解析器。
   * 索引不存内容哈希。
   */
  rebuildBaseline(): BaselineIndex {
    const previous = this.previousSummaries();
    const scanned = this.scanDocsChunks();
    const chunks: BaselineChunkEntry[] = scanned.map(({ file, chunk }) => ({
      id: chunk.id,
      file: stripMdExt(file),
      heading: chunk.heading,
      level: chunk.level,
      summary: carriedSummary(chunk.summary, previous.get(chunk.id)),
      metadata: {},
    }));
    chunks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const index: BaselineIndex = {
      version: 1,
      scope: "global",
      updated: new Date().toISOString(),
      chunks,
    };
    saveModel(this.indexPath(), index);
    return index;
  }

  /** 按 chunkId 精确匹配 baseline 记录；不存在返回 null。 */
  queryBaseline(chunkId: string): BaselineChunkEntry | null {
    return this.loadBaseline().chunks.find((r) => r.id === chunkId) ?? null;
  }

  /**
   * 按 chunkId 精确匹配版本记录；同 id 多条时取最新
   * （committed 中 commit_id 数值最大 > staged > working）；不存在返回 null。
   */
  queryVersion(version: string, chunkId: string): VersionChunkEntry | null {
    const matches = this.allVersionRecords(version, chunkId);
    return matches.length === 0 ? null : latestRecord(matches);
  }

  /** 按写入序返回版本索引中全部同名记录。 */
  allVersionRecords(version: string, chunkId: string): VersionChunkEntry[] {
    return this.loadVersionIndex(version).chunks.filter((r) => r.id === chunkId);
  }

  /** 加载基线索引；文件不存在返回空索引（chunks: []），损坏抛 IndexError(INDEX_UNREADABLE)。 */
  loadBaseline(): BaselineIndex {
    const p = this.indexPath();
    try {
      return loadModel(p, BaselineIndexSchema);
    } catch (err) {
      if (isEnoent(err)) {
        return { version: 1, scope: "global", updated: null, chunks: [] };
      }
      throw unreadable(p, err);
    }
  }

  /** 加载版本索引；文件不存在抛 VersionIndexError(VERSION_NOT_FOUND)，损坏抛 IndexError(INDEX_UNREADABLE)。 */
  loadVersionIndex(version: string): VersionIndex {
    const p = this.indexPath(version);
    try {
      return loadModel(p, VersionIndexSchema);
    } catch (err) {
      if (isEnoent(err)) {
        throw new VersionIndexError(version);
      }
      throw unreadable(p, err);
    }
  }

  /**
   * 保存版本索引：磁盘上已存在且 status=merged 的索引拒绝写（INDEX_READONLY，零写入）；
   * 否则 computeStats 覆盖 index.stats 后原子写。
   */
  saveVersionIndex(index: VersionIndex): void {
    const p = this.indexPath(index.version_name);
    let onDisk: VersionIndex | null = null;
    try {
      onDisk = loadModel(p, VersionIndexSchema);
    } catch (err) {
      if (!isEnoent(err)) throw unreadable(p, err);
    }
    if (onDisk !== null && onDisk.status === "merged") {
      throw new IndexError(
        "INDEX_READONLY",
        `版本 ${index.version_name} 已合入，版本索引只读: ${p}`,
      );
    }
    index.stats = computeStats(index.chunks);
    saveModel(p, index);
  }

  /** 枚举 `.meta/versions/v*.yaml` 的版本号，按数值 (major, minor) 排序。 */
  listVersions(): string[] {
    const dir = path.join(this.root.meta, "versions");
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return names
      .filter((n) => n.startsWith("v") && n.endsWith(".yaml"))
      .map((n) => n.slice(0, n.length - ".yaml".length))
      .sort(compareVersions);
  }

  // -------------------------------------------------------------------------
  // 内部辅助（不导出）
  // -------------------------------------------------------------------------

  /** 索引文件绝对路径；version 缺省为 baseline，派生路径经越界守卫。 */
  private indexPath(version?: string): string {
    const name =
      version === undefined
        ? "chunks-index.yaml"
        : `chunks-index-${version}.yaml`;
    return ensureWithin(this.root.root, path.join(this.root.meta, name));
  }

  /**
   * 读**重建前**的基线索引，取「非 null 摘要」的 id→summary 映射。
   * 文件不存在返回空映射（合法，非错误）；文件损坏经 `loadBaseline` 抛
   * IndexError(INDEX_UNREADABLE)，fail closed 不静默降级为空映射——
   * 否则一次读损坏就会把全部历史摘要清空。
   */
  private previousSummaries(): Map<string, string> {
    const previous = new Map<string, string>();
    for (const entry of this.loadBaseline().chunks) {
      if (entry.summary !== null) {
        previous.set(entry.id, entry.summary);
      }
    }
    return previous;
  }

  /**
   * 遍历 docs/{prd,fsd,tdd} 逐文件 parseFile，返回 (file, chunk) 对。
   * 解析错误（ChunkParseError，含文件与行号）直接上抛，不跳过。
   */
  private scanDocsChunks(): { file: string; chunk: Chunk }[] {
    const out: { file: string; chunk: Chunk }[] = [];
    for (const layer of ["prd", "fsd", "tdd"]) {
      const dir = path.join(this.root.docs, layer);
      for (const abs of listMarkdownFiles(dir)) {
        const parsed = parseFile(abs, this.root.docs);
        for (const chunk of parsed.chunks) {
          out.push({ file: parsed.file, chunk });
        }
      }
    }
    return out;
  }
}
