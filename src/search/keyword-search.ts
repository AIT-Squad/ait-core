/**
 * [TDD]-keyword_search — 跨 baseline 与版本工作区 chunk 的全文关键词检索。
 *
 * 精确子串匹配（大小写不敏感），不做语义扩展与相关性打分；不读 specgraph（纯文本检索）。
 * 只读域：不写任何文件；import 零副作用，一切 IO 只发生在函数调用内。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile } from "../doc-model/chunk-parser.js";
import { toPosixRel } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";

export interface SearchHit {
  chunkId: string;
  file: string;
  heading: string;
  version: string | null;
  matches: { line: number; text: string }[];
}

/** 检索拒绝的结构化错误码：空 query / 非法正则。 */
export type SearchErrorCode = "SEARCH_EMPTY_QUERY" | "INVALID_REGEXP";

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(message: string, code: SearchErrorCode = "SEARCH_EMPTY_QUERY") {
    super(message);
    this.name = "SearchError";
    this.code = code;
  }
}

type SearchScope = "baseline" | "all";

export interface SearchOptions {
  scope?: SearchScope;
  regexp?: boolean;
}

/** 一个待检索文件：相对 project-docs 根的 posix 路径 + 所属版本（baseline 为 null）。 */
interface SearchSpace {
  file: string;
  version: string | null;
}

const LAYERS = ["prd", "fsd", "tdd"] as const;

/** 枚举目录下一层 .md 文件（按文件名排序保证稳定）；目录不存在视为空。 */
function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** 版本号数值序比较："v9.9" < "v9.10"。 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 当前活动版本：versions/ 下数值序最大的版本工作区；无活动版本返回 null。 */
function activeVersion(root: ProjectRoot): string | null {
  const versionsDir = path.join(root.root, "versions");
  if (!fs.existsSync(versionsDir)) {
    return null;
  }
  const versions = fs
    .readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersions);
  const latest = versions[versions.length - 1];
  return latest === undefined ? null : latest;
}

/**
 * docs/ 与 versions/<v>/ 的文件枚举。
 * baseline=docs/{prd,fsd,tdd}；all 追加当前活动版本工作区（无活动版本时等同 baseline）。
 */
function collectSearchSpaces(root: ProjectRoot, scope: SearchScope): SearchSpace[] {
  const spaces: SearchSpace[] = [];
  for (const layer of LAYERS) {
    for (const abs of listMarkdownFiles(path.join(root.docs, layer))) {
      spaces.push({ file: toPosixRel(root.root, abs), version: null });
    }
  }
  if (scope === "all") {
    const version = activeVersion(root);
    if (version !== null) {
      const versionDir = path.join(root.root, "versions", version);
      for (const layer of LAYERS) {
        for (const abs of listMarkdownFiles(path.join(versionDir, layer))) {
          spaces.push({ file: toPosixRel(root.root, abs), version });
        }
      }
    }
  }
  return spaces;
}

/**
 * content 内逐行匹配，返回 content 相对行号（1-based）与原文行。
 * 默认做大小写不敏感子串匹配；regexp 为真时用带 `i` 标志的正则逐行 test
 * （正则已由调用方预校验，此处不吞错）。
 */
function matchLines(
  content: string,
  query: string,
  regexp: boolean,
): { line: number; text: string }[] {
  const matches: { line: number; text: string }[] = [];
  const lines = content.split(/\r?\n/);
  const pattern = regexp ? new RegExp(query, "i") : null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    const hit =
      pattern !== null ? pattern.test(text) : text.toLowerCase().includes(query);
    if (hit) {
      matches.push({ line: i + 1, text });
    }
  }
  return matches;
}

function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.chunkId !== b.chunkId) {
    return a.chunkId < b.chunkId ? -1 : 1;
  }
  return (a.matches[0] as { line: number }).line - (b.matches[0] as { line: number }).line;
}

/**
 * 跨 baseline 与版本工作区 chunk 的全文关键词检索。
 * 空/纯空白 query 抛 SearchError(SEARCH_EMPTY_QUERY)；`regexp:true` 时按正则
 * （大小写不敏感）匹配，正则非法抛 SearchError(INVALID_REGEXP) 且不返回部分结果；
 * 无命中返回空数组；结果按 (file, chunkId, 首个行号) 稳定排序。
 */
export function searchChunks(
  root: ProjectRoot,
  query: string,
  options?: SearchOptions,
): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new SearchError("query 为空或纯空白（SEARCH_EMPTY_QUERY）");
  }
  const regexp = options?.regexp === true;
  if (regexp) {
    try {
      new RegExp(trimmed, "i");
    } catch (err) {
      throw new SearchError(
        `query 不是合法正则（INVALID_REGEXP）：${err instanceof Error ? err.message : String(err)}`,
        "INVALID_REGEXP",
      );
    }
  }
  // 字面量匹配沿用大小写不敏感子串语义；正则模式保留原始大小写交给 `i` 标志
  const needle = regexp ? trimmed : trimmed.toLowerCase();
  const scope: SearchScope = options?.scope ?? "baseline";
  const hits: SearchHit[] = [];
  for (const space of collectSearchSpaces(root, scope)) {
    // 解析失败（含读取失败）直接上抛，错误自带路径，不跳过
    const parsed = parseFile(path.join(root.root, space.file), root.root);
    for (const chunk of parsed.chunks) {
      const matches = matchLines(chunk.content, needle, regexp);
      if (matches.length === 0) {
        continue;
      }
      hits.push({
        chunkId: chunk.id,
        file: parsed.file,
        heading: chunk.heading,
        version: space.version,
        matches: matches.map((m) => ({
          // content 含 @id 注释行本身，故 content 第 1 行就是文件第 startLine 行
          line: chunk.startLine + m.line - 1,
          text: m.text,
        })),
      });
    }
  }
  hits.sort(compareHits);
  return hits;
}
