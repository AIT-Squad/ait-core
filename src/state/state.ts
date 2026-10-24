/**
 * [TDD]-state_api — 当前版本执行进度面板：装配、两种渲染形态与 state.md 保存。
 *
 * 边界（硬约束）：
 * - 数据来源只有版本索引（IndexManager）与版本元数据（.meta/versions/<v>.yaml）；
 *   不读 specgraph、不解析 markdown、不计算任何关系信息；
 * - markdown 只渲染 phase 与当前版本 chunk 的三态/ID——绝不渲染变更历史、关系全图、
 *   边列表、孤立节点；json 形态为结构化对象；
 * - `--save` 只写 `versions/<v>/state.md`，不触碰其它任何文件；
 * - 无活动版本且未指定 `--version` 时抛 NO_VERSION（零写入）。
 *
 * 本模块 import 零副作用；一切 IO 只发生在函数调用内。
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteText, ensureWithin } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel } from "../foundation/yaml.js";
import {
  VersionMetaSchema,
  VersionIndexSchema,
  type VersionMeta,
  type VersionIndex,
} from "../doc-model/schemas.js";
import { IndexManager, VersionIndexError } from "../indexing/index-manager.js";

// ---------------------------------------------------------------------------
// 类型与错误
// ---------------------------------------------------------------------------

export interface StatePanel {
  version: string;
  title: string | null;
  phase: string;
  prd_locked: boolean;
  impl_locked: boolean;
  merged: boolean;
  working: string[];
  staged: string[];
  committed: string[];
  by_action: Record<string, number>;
  prd_chunks: string[];
  fsd_chunks: string[];
  tdd_chunks: string[];
  counts: {
    working: number;
    staged: number;
    committed: number;
    prd: number;
    fsd: number;
    tdd: number;
  };
}

/** 面板拒绝的结构化错误码：无活动版本 / 指定版本不存在。 */
export type StateErrorCode = "NO_VERSION" | "VERSION_NOT_FOUND";

export class StateError extends Error {
  readonly code: StateErrorCode;

  constructor(code: StateErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StateError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 内部辅助（不导出）
// ---------------------------------------------------------------------------

const LAYERS = [
  { label: "PRD", prefix: "[PRD]-" },
  { label: "FSD", prefix: "[FSD]-" },
  { label: "TDD", prefix: "[TDD]-" },
] as const;

const STATES = ["working", "staged", "committed"] as const;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** 版本元数据路径：`.meta/versions/<v>.yaml`（经项目根越界守卫）。 */
function versionMetaPath(root: ProjectRoot, version: string): string {
  return ensureWithin(root.root, path.join(root.meta, "versions", `${version}.yaml`));
}

/** 读版本元数据；文件不存在抛 StateError(VERSION_NOT_FOUND)，损坏原样上抛。 */
function loadVersionMeta(root: ProjectRoot, version: string): VersionMeta {
  const p = versionMetaPath(root, version);
  try {
    return loadModel(p, VersionMetaSchema);
  } catch (err) {
    if (isEnoent(err)) {
      throw new StateError(
        "VERSION_NOT_FOUND",
        `版本元数据不存在：${version}（${p}）`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** 已合入判定与 versioning 域一致：merged_at 非空或 phase=merged。 */
function isMerged(meta: VersionMeta): boolean {
  return meta.merged_at !== null || meta.phase === "merged";
}

/**
 * 解析目标版本：显式 `--version` 直接采用（即使已 merged，用于历史查看）；
 * 否则取数值序第一个未合入的活动版本；皆无抛 NO_VERSION。
 */
function resolveVersion(root: ProjectRoot, version?: string | null): string {
  const index = new IndexManager(root);
  if (version !== undefined && version !== null && version !== "") {
    // 存在性以元数据为准；路径越界同样视为不存在，绝不落到根外读取。
    loadVersionMeta(root, version);
    return version;
  }
  for (const candidate of index.listVersions()) {
    if (!isMerged(loadVersionMeta(root, candidate))) {
      return candidate;
    }
  }
  throw new StateError(
    "NO_VERSION",
    `无活动版本且未指定 --version（${path.join(root.meta, "versions")}）`,
  );
}

/** 读版本索引；文件不存在按空索引起步（空版本：三节均为 `-`，counts 全 0）。 */
function loadVersionIndex(root: ProjectRoot, version: string): VersionIndex {
  try {
    return new IndexManager(root).loadVersionIndex(version);
  } catch (err) {
    if (err instanceof VersionIndexError) {
      return VersionIndexSchema.parse({
        version: 1,
        scope: "version",
        version_name: version,
        based_on_hash: null,
        status: "developing",
        chunks: [],
        commits: [],
        stats: {},
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

/** 装配当前（或指定）版本的进度面板（只读）。 */
export function loadVersionState(
  root: ProjectRoot,
  version?: string | null,
): StatePanel {
  const versionName = resolveVersion(root, version);
  const meta = loadVersionMeta(root, versionName);
  const index = loadVersionIndex(root, versionName);

  const working: string[] = [];
  const staged: string[] = [];
  const committed: string[] = [];
  const byAction: Record<string, number> = {};
  const prdChunks: string[] = [];
  const fsdChunks: string[] = [];
  const tddChunks: string[] = [];

  for (const entry of index.chunks) {
    if (entry.state === "working") working.push(entry.id);
    else if (entry.state === "staged") staged.push(entry.id);
    else committed.push(entry.id);

    byAction[entry.action] = (byAction[entry.action] ?? 0) + 1;

    if (entry.id.startsWith("[PRD]-")) prdChunks.push(entry.id);
    else if (entry.id.startsWith("[FSD]-")) fsdChunks.push(entry.id);
    else if (entry.id.startsWith("[TDD]-")) tddChunks.push(entry.id);
  }

  return {
    version: versionName,
    title: meta.title,
    phase: meta.phase,
    prd_locked: meta.prd_locked,
    impl_locked: meta.impl_locked,
    merged: isMerged(meta),
    working,
    staged,
    committed,
    by_action: byAction,
    prd_chunks: prdChunks,
    fsd_chunks: fsdChunks,
    tdd_chunks: tddChunks,
    counts: {
      working: working.length,
      staged: staged.length,
      committed: committed.length,
      prd: prdChunks.length,
      fsd: fsdChunks.length,
      tdd: tddChunks.length,
    },
  };
}

/** 渲染 markdown：只含 phase 与三节（PRD/FSD/TDD）三态计数与 ID，不含任何其它内容。 */
export function renderMarkdown(panel: StatePanel): string {
  const lines: string[] = [
    `# AIT State — ${panel.version}`,
    "",
    "## 当前执行阶段",
    "",
    `- Phase: \`${panel.phase}\``,
    "",
    "## 当前版本 Chunk",
    "",
  ];

  const byState: Record<(typeof STATES)[number], string[]> = {
    working: panel.working,
    staged: panel.staged,
    committed: panel.committed,
  };

  for (const { label, prefix } of LAYERS) {
    lines.push(`### ${label}`, "", "| State | Count | Chunk IDs |", "|---|---:|---|");
    for (const state of STATES) {
      const filtered = byState[state].filter((id) => id.startsWith(prefix));
      const ids = filtered.length > 0 ? filtered.map((id) => `\`${id}\``).join(", ") : "-";
      lines.push(`| ${state} | ${filtered.length} | ${ids} |`);
    }
    lines.push("");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 渲染 markdown 并原子写 `versions/<v>/state.md`（目标目录不存在则创建），返回绝对路径。
 * 传入已读取的 panel 时直接保存同一快照，不再读取版本元数据或索引。
 */
export function saveState(
  root: ProjectRoot,
  version?: string | null,
  panel?: StatePanel,
): string {
  if (
    panel !== undefined &&
    version !== undefined &&
    version !== null &&
    version !== "" &&
    panel.version !== version
  ) {
    throw new TypeError(`状态面板版本 ${panel.version} 与指定版本 ${version} 不一致`);
  }
  const snapshot = panel ?? loadVersionState(root, version);
  const dir = ensureWithin(root.root, path.join(root.root, "versions", snapshot.version));
  fs.mkdirSync(dir, { recursive: true });
  const target = ensureWithin(root.root, path.join(dir, "state.md"));
  atomicWriteText(target, renderMarkdown(snapshot));
  return target;
}

/** 统一渲染入口：json → 结构化面板对象；markdown → {version, format, content}。 */
export function renderState(
  root: ProjectRoot,
  version: string | null | undefined,
  fmt: "markdown" | "json",
):
  | { version: string; format: "markdown"; content: string }
  | StatePanel {
  const panel = loadVersionState(root, version);
  if (fmt === "json") {
    return panel;
  }
  return {
    version: panel.version,
    format: "markdown",
    content: renderMarkdown(panel),
  };
}
