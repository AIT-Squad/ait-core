import { readFileSync } from "node:fs";
import { toPosixRel } from "../foundation/io.js";

export interface Chunk {
  id: string;
  heading: string;
  level: number;
  content: string;
  startLine: number;
  endLine: number;
  summary: string | null;
  noImpl: boolean;
}

export interface RefMarker {
  kind: "ref" | "extract";
  raw: string;
  line: number;
}

export interface ParsedFile {
  file: string;
  fileHeader: string;
  chunks: Chunk[];
  refs: RefMarker[];
}

export class ChunkParseError extends Error {
  readonly code: "CHUNK_PARSE_ERROR" = "CHUNK_PARSE_ERROR";
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, message: string) {
    super(message);
    this.name = "ChunkParseError";
    this.file = file;
    this.line = line;
  }
}

const ID_PATTERN = /^\[(PRD|FSD|TDD)\]-[a-z0-9_]+(-[a-z0-9_]+)*(:[A-Za-z0-9_]+)?$/;
const ID_COMMENT_PATTERN = /^\s*<!--\s*@id:([^\s>]+?)\s*-->\s*$/;
const REF_COMMENT_PATTERN = /^\s*<!--\s*@(ref|extract)\b[\s\S]*?-->\s*$/;
const FENCE_PATTERN = /^\s*```/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
/** 摘要只来自独占一行的元注释；`@summary:` 后为空则不构成该行形态。 */
const SUMMARY_PATTERN = /^<!--\s*@summary:\s*(.+?)\s*-->\s*$/;
/**
 * 元注释：`@prd-no-impl` 独占一行（标记名以 Python 版 `NO_IMPL_PATTERN` 原文为准）。
 * 裸 `@no-impl`（无 `prd-` 前缀）不属元注释：既保留在 content，也不置 `noImpl`。
 */
const NO_IMPL_PATTERN = /^<!--\s*@prd-no-impl\s*-->\s*$/;

interface ScannedLine {
  line: number;
  text: string;
  inFence: boolean;
}

/**
 * 带行号的围栏感知行迭代器。
 * 围栏定界行本身按围栏内处理（其中不可能出现合法的整行注释标记），
 * 未闭合的围栏按文本结束处理，不报错。
 */
function* scanLines(text: string): Generator<ScannedLine, void, undefined> {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] as string;
    if (FENCE_PATTERN.test(lineText)) {
      yield { line: i + 1, text: lineText, inFence: true };
      inFence = !inFence;
    } else {
      yield { line: i + 1, text: lineText, inFence };
    }
  }
}

/** 整行匹配 id 注释形态时返回其 id，否则 null（行尾多余文本即视为普通内容行）。 */
function parseIdComment(line: string): string | null {
  const m = ID_COMMENT_PATTERN.exec(line);
  return m === null ? null : (m[1] as string);
}

/**
 * 元注释行判定，剥离与取值共用同一套形态规则，避免"取值不认但剥离认"的不一致。
 * `@summary:` 后为空不构成该行形态（惰性组会回退吃掉 `--`，须同时排除空串）。
 */
function readMetaComment(line: string): { summary: string } | "prd-no-impl" | null {
  if (NO_IMPL_PATTERN.test(line)) {
    return "prd-no-impl";
  }
  const m = SUMMARY_PATTERN.exec(line);
  if (m === null) {
    return null;
  }
  const text = (m[1] as string).trim();
  return text === "" ? null : { summary: text };
}

/**
 * 剥掉 chunk 内的元注释行（`@summary` / `@prd-no-impl`）及其后紧邻的一个空行，
 * 镜像 Python `strip_meta_comments` 的 `skip_next_blank` 语义。
 * `masked` 为全文围栏掩码，`base` 为该区间起始行的全局下标（0 基）。
 */
function stripMetaComments(
  lines: string[],
  masked: boolean[],
  base: number,
): string[] {
  const kept: string[] = [];
  let skipNextBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!masked[base + i] && readMetaComment(line) !== null) {
      skipNextBlank = kept.length > 0 && (kept[kept.length - 1] as string).trim() === "";
      continue;
    }
    if (skipNextBlank && line.trim() === "") {
      skipNextBlank = false;
      continue;
    }
    skipNextBlank = false;
    kept.push(line);
  }
  return kept;
}

export function isLegalChunkId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function parseText(text: string, file: string): ParsedFile {
  const lines = text.split(/\r?\n/);
  const masked: boolean[] = [];
  for (const scanned of scanLines(text)) {
    masked.push(scanned.inFence);
  }

  const chunks: Chunk[] = [];
  const refs: RefMarker[] = [];
  const headerLines: string[] = [];
  const seenIds = new Map<string, number>();

  let current: { id: string; startLine: number } | null = null;

  const closeCurrent = (endLine: number): void => {
    if (current === null) {
      return;
    }
    // 行区间右端：基准为下一 @id 行前一行；尾部空行不计入。
    let endIdx = endLine - 1;
    const startIdx = current.startLine - 1;
    while (endIdx > startIdx && (lines[endIdx] as string).trim() === "") {
      endIdx -= 1;
    }

    // 正文区间＝[@id 行, 下一 @id 行前一行]，与 Python 版一致（@id 行留在 content 内，
    // 保证两版 chunk_hash 对同一 chunk 取到同一段文本）；
    // summary/@prd-no-impl 的匹配与剥离都在本区间内进行。
    const base = startIdx;
    const range = lines.slice(startIdx, endIdx + 1);

    // summary 只在元注释行上取值：一 chunk 内多条时取最后一条（覆盖式，不 break）。
    let summary: string | null = null;
    let noImpl = false;
    for (let i = 0; i < range.length; i++) {
      if (masked[base + i]) {
        continue;
      }
      const meta = readMetaComment(range[i] as string);
      if (meta === "prd-no-impl") {
        noImpl = true;
      } else if (meta !== null) {
        summary = meta.summary;
      }
    }

    const content = stripMetaComments(range, masked, base).join("\n").replace(/\s+$/, "");

    let heading = current.id;
    let level = 0;
    for (let i = 0; i < range.length; i++) {
      if (masked[base + i]) {
        continue;
      }
      const m = HEADING_PATTERN.exec(range[i] as string);
      if (m !== null) {
        level = (m[1] as string).length;
        heading = m[2] as string;
        break;
      }
    }

    chunks.push({
      id: current.id,
      heading,
      level,
      content,
      startLine: current.startLine,
      endLine: endIdx + 1,
      summary,
      noImpl,
    });
    current = null;
  };

  let lastLine = 0;
  for (const { line, text: lineText, inFence } of scanLines(text)) {
    lastLine = line;

    if (inFence) {
      // 围栏内一切注释跳过（行仍归属所在区间文本，正文按行区间统一取值）
      if (current === null) {
        headerLines.push(lineText);
      }
      continue;
    }

    const id = parseIdComment(lineText);
    if (id !== null) {
      if (!isLegalChunkId(id)) {
        throw new ChunkParseError(file, line, `非法 chunk id: ${id}`);
      }
      const firstLine = seenIds.get(id);
      if (firstLine !== undefined) {
        throw new ChunkParseError(
          file,
          line,
          `重复 chunk id: ${id}（首个出现于第 ${firstLine} 行）`,
        );
      }
      seenIds.set(id, line);
      closeCurrent(line - 1);
      current = { id, startLine: line };
      continue;
    }

    const refMatch = REF_COMMENT_PATTERN.exec(lineText);
    if (refMatch !== null) {
      refs.push({
        kind: refMatch[1] as "ref" | "extract",
        raw: lineText.trim(),
        line,
      });
    }

    if (current === null) {
      headerLines.push(lineText);
    }
  }
  closeCurrent(lastLine);

  const fileHeader = headerLines.join("\n").replace(/\s+$/, "");
  return { file, fileHeader, chunks, refs };
}

export function parseFile(path: string, baseDir: string): ParsedFile {
  const text = readFileSync(path, "utf-8");
  return parseText(text, toPosixRel(baseDir, path));
}
