import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  BaselineStats,
  BaselineSummary,
  BaselineSummaryInput,
} from "../api/types.js";
import { parseFile } from "../doc-model/chunk-parser.js";
import type { ProjectRoot } from "../foundation/root.js";
import { IndexManager } from "../indexing/index-manager.js";
import { SpecGraphStore, specType, type EdgeRel } from "../specgraph/graph-model.js";

export type { BaselineStats, BaselineSummary, BaselineSummaryInput } from "../api/types.js";

const LAYERS = ["prd", "fsd", "tdd"] as const;

const RELS: EdgeRel[] = ["derives", "decomposes", "details", "depends_on"];

/** 只读投影基线索引；保留索引顺序、空摘要及全量中的未知层级。 */
export function baselineSummary(
  root: ProjectRoot,
  input?: BaselineSummaryInput,
): BaselineSummary {
  const requestedScope = input?.scope;
  if (
    requestedScope !== undefined &&
    requestedScope !== "prd" &&
    requestedScope !== "fsd" &&
    requestedScope !== "tdd"
  ) {
    throw Object.assign(new Error("scope 必须为 prd、fsd 或 tdd；省略时返回全量摘要"), {
      code: "USAGE_ERROR",
    });
  }

  const scope = requestedScope ?? "all";
  const items = new IndexManager(root).loadBaseline().chunks
    .filter((entry) => {
      if (scope === "all") return true;
      const file = path.posix.normalize(entry.file.replace(/\\/g, "/"));
      return specType(entry.id, file) === scope;
    })
    .map(({ id, heading, summary }) => ({ id, heading, summary: summary ?? null }));

  return { scope, items };
}

export function baselineStats(root: ProjectRoot): BaselineStats {
  const docs = { prd: 0, fsd: 0, tdd: 0 };
  let chunks = 0;

  for (const layer of LAYERS) {
    const dir = path.join(root.docs, layer);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const parsed = parseFile(path.join(dir, name), root.docs);
      docs[layer] += 1;
      chunks += parsed.chunks.length;
    }
  }

  const edges: Record<EdgeRel, number> = {
    derives: 0,
    decomposes: 0,
    details: 0,
    depends_on: 0,
  };
  const graph = new SpecGraphStore(root).load("baseline");
  for (const edge of graph.edges) {
    const key = edge.rel as keyof typeof edges;
    if (key in edges && edges[key] !== undefined) {
      edges[key] = (edges[key] ?? 0) + 1;
    }
  }

  const versions = new IndexManager(root).listVersions();

  return { docs, chunks, edges, versions };
}
