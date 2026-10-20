/**
 * [TDD]-codegen_prepare — 为叶 TDD 组装聚焦实现上下文
 * （目标 TDD 全文 + details/decomposes/derives 上溯全链 + 路径相关 depends_on
 * 能力契约 + target_file 当前内容三态）。
 *
 * 边界（硬约束）：
 * - 不写 bundle 落盘（交付形态归 orchestration 域）；不注入 LLM、不生成代码；
 * - 关系查询委托 specgraph CombinedView，chunk 解析委托 doc_model 域，
 *   版本侧文件定位委托 indexing 域；
 * - 不广播祖先 depends_on 全子树：只收路径 FSD split 的直接 depends_on 对端；
 * - import 零副作用；一切 IO 只发生在 codegenPrepare 调用内。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ChunkParseError,
  parseText,
  type Chunk,
  type ParsedFile,
} from "../doc-model/chunk-parser.js";
import { VersionMetaSchema } from "../doc-model/schemas.js";
import { ensureWithin, toPosixRel } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel } from "../foundation/yaml.js";
import { IndexManager } from "../indexing/index-manager.js";
import {
  combinedView,
  extractTargetFile as extractViewTargetFile,
  type CombinedView,
} from "../specgraph/graph-model.js";
import { normalizeTargetFile } from "./validator.js";

// ---------------------------------------------------------------------------
// 导出类型
// ---------------------------------------------------------------------------

export type ContextRole =
  | "实现规格"
  | "直接开发依据"
  | "依赖的对外接口"
  | "所属域约束"
  | "相关实现参考"
  | "产品意图"
  | "目标文件现状";

export interface ContextItem {
  id: string;
  file: string;
  heading: string;
  content: string;
  role: ContextRole;
  selectionReason: string;
}

export interface CodegenBundle {
  version: string | null;
  sourceFile: string;
  tddRoot: string;
  targetFile: string;
  targetState: "loaded" | "absent" | "unreadable";
  targetContent?: string;
  upstream: ContextItem[];
  dependencies: ContextItem[];
}

export type CodegenErrorCode =
  | "TDD_NOT_FOUND"
  | "TARGET_FILE_MISSING"
  | "VERSION_NOT_FOUND"
  | "MULTIPLE_ACTIVE_VERSIONS"
  | "TDD_NOT_CONFIRMED"
  | "CODEGEN_SOURCE_MISSING"
  | "CODEGEN_CHUNK_MISSING"
  | "SPEC_CONTENT_MISMATCH"
  | "MISSING_ENDPOINT"
  | "TRACE_BROKEN"
  | "TDD_MULTI_PARENT"
  | "SPEC_CYCLE";

export class CodegenError extends Error {
  readonly code: CodegenErrorCode;

  constructor(code: CodegenErrorCode, message: string) {
    super(message);
    this.name = "CodegenError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 内部辅助（不导出）
// ---------------------------------------------------------------------------

/** 上溯条目：chunk id + 角色 + 稳定选择理由（内容在组装阶段解析）。 */
interface UpstreamEntry {
  id: string;
  role: ContextRole;
  selectionReason: string;
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

const YAML_FENCE_PATTERN = /```yaml[ \t]*\r?\n([\s\S]*?)```/g;

/** target_file 是 YAML 字符串，合法引号与空格由 YAML 解析器处理。 */
function extractTargetFile(content: string, file: string): string | null {
  for (const fence of content.matchAll(YAML_FENCE_PATTERN)) {
    let value: unknown;
    try {
      value = parseYaml(fence[1] as string);
    } catch (err) {
      const line = content.slice(0, fence.index).split("\n").length + 1;
      throw new ChunkParseError(file, line, `target_file YAML 解析失败（${file}:${line}）：${String(err)}`);
    }
    if (value !== null && typeof value === "object" && "target_file" in value) {
      return typeof value.target_file === "string" && value.target_file.trim() !== ""
        ? value.target_file
        : null;
    }
  }
  return null;
}

/** 只读选择有效版本；不存在活动版本才使用 baseline。 */
function effectiveVersion(
  root: ProjectRoot,
  index: IndexManager,
  requested: string | null,
): string | null {
  const load = (version: string) => {
    const metaPath = ensureWithin(path.join(root.meta, "versions"), `${version}.yaml`);
    let meta;
    try {
      meta = loadModel(metaPath, VersionMetaSchema);
    } catch (err) {
      if (isEnoent(err)) {
        throw new CodegenError("VERSION_NOT_FOUND", `版本元数据不存在：${version}（${metaPath}）`);
      }
      throw err;
    }
    const records = index.loadVersionIndex(version);
    if (meta.version !== version || records.version_name !== version) {
      throw new CodegenError("SPEC_CONTENT_MISMATCH", `版本元数据或索引的版本名不一致：${version}`);
    }
    return {
      version,
      phase: meta.phase,
      merged: meta.merged_at !== null || meta.phase === "merged" || records.status === "merged",
    };
  };
  let selected;
  if (requested !== null) {
    selected = load(requested);
  } else {
    const active = index.listVersions().map(load).filter((entry) => !entry.merged);
    if (active.length > 1) {
      throw new CodegenError(
        "MULTIPLE_ACTIVE_VERSIONS",
        `存在多个活动版本：${active.map((entry) => entry.version).join(", ")}`,
      );
    }
    selected = active[0];
  }
  if (selected === undefined || selected.merged) return null;
  if (selected.phase !== "tdd-confirm") {
    throw new CodegenError("TDD_NOT_CONFIRMED", `版本 ${selected.version} 的 TDD 层尚未确认（${selected.phase}）`);
  }
  return selected.version;
}

/** 结构 root→split 与显式树边共同构成唯一上溯通道。 */
function upstreamParent(
  view: CombinedView,
  id: string,
): { id: string; rel: string } | null {
  if (!view.hasNode(id)) {
    throw new CodegenError("MISSING_ENDPOINT", `上溯节点不存在：${id}`);
  }
  if (id.startsWith("[PRD]-") && !id.includes(":")) return null;
  const rel = id.startsWith("[TDD]-") ? "details" : "decomposes";
  const parents = new Map(view.edgesTo(id, rel).map((edge) => [edge.src, rel as string]));
  if (id.includes(":")) {
    const structuralRoot = id.slice(0, id.indexOf(":"));
    if (!parents.has(structuralRoot)) parents.set(structuralRoot, "结构");
  } else if (id.startsWith("[FSD]-")) {
    for (const edge of view.edgesTo(id, "derives")) parents.set(edge.src, "derives");
  }
  if (parents.size !== 1) {
    throw new CodegenError(
      id.startsWith("[TDD]-") && parents.size > 1 ? "TDD_MULTI_PARENT" : "TRACE_BROKEN",
      `${id} 应有唯一上溯父节点，实际 ${parents.size}：${[...parents.keys()].sort().join(", ")}`,
    );
  }
  const [parent, relation] = [...parents.entries()][0]!;
  if (!view.hasNode(parent)) {
    throw new CodegenError("MISSING_ENDPOINT", `上溯父节点不存在：${id} → ${parent}`);
  }
  const valid = id.startsWith("[TDD]-")
    ? parent.startsWith("[FSD]-") && parent.includes(":")
    : id.includes(":")
      ? parent === id.slice(0, id.indexOf(":"))
      : (parent.startsWith("[FSD]-") && parent.includes(":")) ||
        (relation === "derives" && parent.startsWith("[PRD]-") && !parent.includes(":"));
  if (!valid) {
    throw new CodegenError("TRACE_BROKEN", `上溯父节点类型或层级非法：${id} → ${parent}`);
  }
  return { id: parent, rel: relation };
}

/** 按 details→结构父/decomposes→derives 完整上溯，保留自近及远的路径顺序。 */
function walkUpstream(
  view: CombinedView,
  tddId: string,
): { entries: UpstreamEntry[]; fsdPath: string[] } {
  const chain: UpstreamEntry[] = [];
  const fsdPath: string[] = [];
  const seen = new Set<string>([tddId]);
  let current = tddId;
  for (;;) {
    const parent = upstreamParent(view, current);
    if (parent === null) break;
    if (seen.has(parent.id)) {
      throw new CodegenError("SPEC_CYCLE", `上溯链存在环：${current} → ${parent.id}`);
    }
    seen.add(parent.id);
    if (parent.id.startsWith("[FSD]-")) {
      fsdPath.push(parent.id);
      chain.push({
        id: parent.id,
        role: parent.id.includes(":") ? "直接开发依据" : "所属域约束",
        selectionReason: `${current} 的 ${parent.rel} 父`,
      });
    }
    current = parent.id;
  }
  return {
    entries: [
      { id: tddId, role: "实现规格", selectionReason: "目标 TDD" },
      ...chain,
      ...collectRequirementSplits(view, fsdPath),
    ],
    fsdPath,
  };
}

/** 先收路径上的直接需求，再补齐需求的 PRD 根；多需求 derives 本身合法。 */
function collectRequirementSplits(
  view: CombinedView,
  fsdPath: readonly string[],
): UpstreamEntry[] {
  const out: UpstreamEntry[] = [];
  const seen = new Set<string>();
  for (const fsdId of fsdPath) {
    const sources = view.edgesTo(fsdId, "derives").map((edge) => edge.src).sort();
    for (const src of sources) {
      if (!src.startsWith("[PRD]-") || !view.hasNode(src)) {
        throw new CodegenError("TRACE_BROKEN", `${fsdId} 的 derives 上游不是有效 PRD：${src}`);
      }
      if (seen.has(src)) continue;
      seen.add(src);
      out.push({ id: src, role: "产品意图", selectionReason: `${fsdId} 的 derives 对端` });
    }
  }
  for (const entry of [...out]) {
    const parent = upstreamParent(view, entry.id);
    if (parent === null || seen.has(parent.id)) continue;
    seen.add(parent.id);
    out.push({
      id: parent.id,
      role: "产品意图",
      selectionReason: `${entry.id} 的 ${parent.rel} 父`,
    });
  }
  return out;
}

/** :TEST 的同父功能 sibling 由真实的同 root split 结构取得。 */
function collectTestSiblings(view: CombinedView, testSplit: string): string[] {
  const prefix = `${testSplit.slice(0, testSplit.indexOf(":"))}:`;
  return [...view.nodes.keys()]
    .filter((id) => id !== testSplit && id.startsWith(prefix))
    .sort();
}

/**
 * target_file 三态读取（互不混同）：读到内容 → loaded；ENOENT → absent
 * （新建场景正常交付）；存在但读失败（EACCES/EISDIR 等）→ unreadable。
 */
function readTargetFile(
  root: ProjectRoot,
  rel: string,
): { state: "loaded" | "absent" | "unreadable"; content?: string } {
  const abs = ensureWithin(root.cwd, rel);
  try {
    return { state: "loaded", content: fs.readFileSync(abs, "utf-8") };
  } catch (err) {
    if (isEnoent(err)) {
      return { state: "absent" };
    }
    return { state: "unreadable" };
  }
}

// ---------------------------------------------------------------------------
// codegenPrepare
// ---------------------------------------------------------------------------

/**
 * 为叶 TDD 组装聚焦实现上下文。
 * version=null 时自动选择唯一活动版本；没有活动版本时使用 baseline。
 */
export function codegenPrepare(
  root: ProjectRoot,
  version: string | null,
  tddRootId: string,
): CodegenBundle {
  const index = new IndexManager(root);
  version = effectiveVersion(root, index, version);
  const view = version === null ? combinedView(root) : combinedView(root, version);
  const tddNode = view.nodes.get(tddRootId);
  if (tddNode === undefined || tddNode.type !== "tdd" || tddRootId.includes(":")) {
    throw new CodegenError("TDD_NOT_FOUND", `TDD 根 chunk 不存在：${tddRootId}`);
  }
  const parseCache = new Map<string, ParsedFile>();
  const markdownFile = (file: string): string => {
    const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
    return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  };

  /** 有版本记录时该记录是唯一正文来源，缺失、删除或解析失败均不得回退。 */
  const resolveChunk = (id: string): { file: string; sourceFile: string; chunk: Chunk } => {
    const node = view.nodes.get(id);
    if (node === undefined) {
      throw new CodegenError("MISSING_ENDPOINT", `上下文节点不存在：${id}`);
    }
    const record = version === null ? null : index.queryVersion(version, id);
    if (record?.action === "delete") {
      throw new CodegenError("CODEGEN_CHUNK_MISSING", `版本 ${version} 已删除 chunk：${id}`);
    }
    const file = record === null ? (index.queryBaseline(id)?.file ?? node.file) : record.file;
    if (file === null || file.trim() === "") {
      throw new CodegenError("CODEGEN_SOURCE_MISSING", `chunk ${id} 的索引缺少来源文件`);
    }
    const sourceDir = record === null ? root.docs : path.join(root.root, "versions", version!);
    const sourceFile = ensureWithin(sourceDir, markdownFile(file));
    let parsed = parseCache.get(sourceFile);
    if (parsed === undefined) {
      try {
        const text = fs.readFileSync(sourceFile, "utf-8");
        parsed = parseText(text, toPosixRel(root.root, sourceFile));
        // 解析器负责校验与边界；交付正文直接取原文，保留换行和空白。
        const lines = text.split(/(?<=\n)/);
        for (const [position, chunk] of parsed.chunks.entries()) {
          const nextStart = parsed.chunks[position + 1]?.startLine;
          const end = nextStart === undefined ? lines.length : nextStart - 1;
          chunk.content = lines.slice(chunk.startLine - 1, end).join("");
        }
      } catch (err) {
        if (isEnoent(err)) {
          throw new CodegenError("CODEGEN_SOURCE_MISSING", `chunk ${id} 的来源文件不存在：${sourceFile}`);
        }
        throw err;
      }
      parseCache.set(sourceFile, parsed);
    }
    const chunk = parsed.chunks.find((candidate) => candidate.id === id);
    if (chunk === undefined) {
      throw new CodegenError("CODEGEN_CHUNK_MISSING", `来源文件中缺少 chunk ${id}：${sourceFile}`);
    }
    return { file, sourceFile, chunk };
  };

  // 1. 权威正文、目标路径与图中的属主声明必须一致。
  const tddResolved = resolveChunk(tddRootId);
  const declaredTarget = extractTargetFile(tddResolved.chunk.content, tddResolved.sourceFile);
  if (declaredTarget === null) {
    throw new CodegenError("TARGET_FILE_MISSING", `TDD ${tddRootId} 缺少字符串 target_file 声明`);
  }
  const targetFile = normalizeTargetFile(declaredTarget);
  ensureWithin(root.cwd, targetFile);
  let graphTarget: unknown;
  try {
    graphTarget = tddNode.target_file === undefined ? null : parseYaml(tddNode.target_file);
  } catch {
    graphTarget = null;
  }
  // 兼容旧视图的引号截断与重复 .md 定位；只允许从已校验的同一来源文件补全。
  const sameDeclaration = markdownFile(tddNode.file) === markdownFile(tddResolved.file) &&
    (tddNode.target_file === extractViewTargetFile(tddResolved.chunk.content) ||
      (tddNode.target_file === undefined && tddNode.file.endsWith(".md")));
  if (!sameDeclaration && (typeof graphTarget !== "string" || normalizeTargetFile(graphTarget) !== targetFile)) {
    throw new CodegenError(
      "SPEC_CONTENT_MISMATCH",
      `TDD ${tddRootId} 的 target_file 与图中属主不一致：正文 ${targetFile}，图 ${tddNode.target_file ?? "（缺失）"}`,
    );
  }

  // 2. 上溯全链（details→decomposes→derives）
  const { entries, fsdPath } = walkUpstream(view, tddRootId);

  // 4. :TEST TDD：同父功能 sibling + 其实现 TDD + sibling derives 的 PRD 需求 split
  const detailsParent = fsdPath[0];
  if (detailsParent !== undefined && detailsParent.endsWith(":TEST")) {
    const siblings = collectTestSiblings(view, detailsParent);
    for (const sibling of siblings) {
      entries.push({
        id: sibling,
        role: "相关实现参考",
        selectionReason: `:TEST split ${detailsParent} 的同父功能 sibling`,
      });
    }
    for (const sibling of siblings) {
      const implTdds = view
        .edgesFrom(sibling, "details")
        .map((e) => e.dst)
        .sort();
      for (const tddId of implTdds) {
        entries.push({
          id: tddId,
          role: "相关实现参考",
          selectionReason: `功能 sibling ${sibling} 的实现 TDD`,
        });
      }
    }
    entries.push(...collectRequirementSplits(view, siblings));
  }

  const toItem = (entry: UpstreamEntry): ContextItem => {
    const resolved = resolveChunk(entry.id);

    return {
      id: entry.id,
      file: resolved.file,
      heading: resolved.chunk.heading,
      content: resolved.chunk.content,
      role: entry.role,
      selectionReason: entry.selectionReason,
    };
  };

  // 6. upstream：按路径自近及远（收集序即路径序），按 id 去重保留首现
  const seenIds = new Set<string>();
  const upstream: ContextItem[] = [];
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      continue;
    }
    seenIds.add(entry.id);
    upstream.push(toItem(entry));
  }

  // 3. 路径 FSD split 的直接 depends_on 对端（不收无关子树）
  const depEntries = new Map<string, UpstreamEntry>();
  for (const fsdId of fsdPath) {
    if (!fsdId.includes(":")) {
      continue;
    }
    for (const e of view.edgesFrom(fsdId, "depends_on")) {
      if (depEntries.has(e.dst)) {
        continue;
      }
      depEntries.set(e.dst, {
        id: e.dst,
        role: "依赖的对外接口",
        selectionReason: `路径 split ${fsdId} 的 depends_on 对端`,
      });
    }
  }
  // 6. dependencies：按 chunkId 字典序
  const dependencies = [...depEntries.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toItem);

  // 5. target_file 三态
  const target = readTargetFile(root, targetFile);
  const bundle: CodegenBundle = {
    version,
    sourceFile: tddResolved.sourceFile,
    tddRoot: tddRootId,
    targetFile,
    targetState: target.state,
    upstream,
    dependencies,
  };
  if (target.content !== undefined) {
    bundle.targetContent = target.content;
  }
  return bundle;
}
