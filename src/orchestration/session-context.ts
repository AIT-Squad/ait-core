import path from "node:path";
import { VersionMetaSchema, type VersionPhase } from "../doc-model/schemas.js";
import { ensureWithin } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel } from "../foundation/yaml.js";
import { IndexManager } from "../indexing/index-manager.js";

export interface LayerCounts {
  working: number;
  staged: number;
  committed: number;
}

export interface SessionContext {
  project_root: string;
  active_version: string | null;
  phase: VersionPhase | null;
  layers: { prd: LayerCounts; fsd: LayerCounts; tdd: LayerCounts };
  baseline_empty: boolean;
  text: string;
}

class SessionContextError extends Error {
  readonly code = "ACTIVE_VERSION_CONFLICT" as const;

  constructor(versions: string[]) {
    super(`存在多个活动版本：${versions.join(", ")}`);
    this.name = "SessionContextError";
  }
}

/** 只读当前会话状态；元数据与索引错误直接上抛。 */
export function getSessionContext(root: ProjectRoot): SessionContext {
  const indexes = new IndexManager(root);
  const active = indexes.listVersions().sort().map((version) =>
    loadModel(
      ensureWithin(root.root, path.join(root.meta, "versions", `${version}.yaml`)),
      VersionMetaSchema,
    ),
  ).filter((meta) => meta.merged_at === null && meta.phase !== "merged");
  if (active.length > 1) {
    throw new SessionContextError(active.map((meta) => meta.version));
  }

  const current = active[0];
  const layers: SessionContext["layers"] = {
    prd: { working: 0, staged: 0, committed: 0 },
    fsd: { working: 0, staged: 0, committed: 0 },
    tdd: { working: 0, staged: 0, committed: 0 },
  };
  const documentLayers = ["prd", "fsd", "tdd"] as const;
  if (current !== undefined) {
    for (const chunk of indexes.loadVersionIndex(current.version).chunks) {
      for (const layer of documentLayers) {
        if (chunk.id.startsWith(`[${layer.toUpperCase()}]-`)) {
          layers[layer][chunk.state] += 1;
        }
      }
    }
  }

  const baselineEmpty = indexes.loadBaseline().chunks.length === 0;
  const activeVersion = current?.version ?? null;
  const phase = current?.phase ?? null;
  const text = [
    `项目：${root.cwd}`,
    `活动版本：${activeVersion ?? "无"}`,
    `阶段：${phase ?? "无"}`,
    ...documentLayers.map((layer) => {
      const counts = layers[layer];
      return `${layer.toUpperCase()}：working=${counts.working}, staged=${counts.staged}, committed=${counts.committed}`;
    }),
    `基线：${baselineEmpty ? "空" : "非空"}`,
  ].join("\n");
  return {
    project_root: root.cwd,
    active_version: activeVersion,
    phase,
    layers,
    baseline_empty: baselineEmpty,
    text,
  };
}
