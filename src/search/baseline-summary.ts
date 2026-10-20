import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFile } from "../doc-model/chunk-parser.js";
import type { ProjectRoot } from "../foundation/root.js";
import { IndexManager } from "../indexing/index-manager.js";
import { SpecGraphStore, type EdgeRel } from "../specgraph/graph-model.js";

export interface BaselineSummary {
  docs: { prd: number; fsd: number; tdd: number };
  chunks: number;
  edges: Record<EdgeRel, number>;
  versions: string[];
}

const LAYERS = ["prd", "fsd", "tdd"] as const;

const RELS: EdgeRel[] = ["derives", "decomposes", "details", "depends_on"];

export function baselineSummary(root: ProjectRoot): BaselineSummary {
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
