/** Shared, read-only artifact and requirement-mapping governance. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { ProjectRoot } from "../foundation/root.js";
import { ConfigUnreadableError, loadConfig } from "../foundation/config.js";
import { ensureWithin } from "../foundation/io.js";
import { loadModel } from "../foundation/yaml.js";
import { VersionMetaSchema } from "../doc-model/schemas.js";
import {
  ChunkParseError, isLegalChunkId, parseFile, type Chunk, type ParsedFile,
} from "../doc-model/chunk-parser.js";
import { IndexManager } from "../indexing/index-manager.js";
import { combinedView } from "../specgraph/graph-model.js";
import { normalizeTargetFile } from "./validator.js";

export interface GovernanceFinding {
  code: string;
  message: string;
  chunkId?: string;
  file?: string;
  targetFile?: string;
  enforcement: "warn" | "block";
}

export interface GovernanceReport {
  violations: GovernanceFinding[];
  warnings: GovernanceFinding[];
  target_file_missing: GovernanceFinding[];
  derives_residue: GovernanceFinding[];
}

type Enforcement = GovernanceFinding["enforcement"];
interface ArtifactScope {
  enforcement: Enforcement;
  exempt_paths: string[];
  exempt_test_splits: string[];
  parent_suffix: string;
  prefix: string;
}
interface GovernancePolicy {
  artifact_scopes: ArtifactScope[];
  derives_residue: { enforcement: Enforcement };
  target_file_existence: { enforcement: Enforcement };
}

class GovernanceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? error.code : undefined;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function relativePath(value: string): string {
  if (!value.trim() || value.includes("\0")) {
    throw new GovernanceError("INVALID_TARGET_FILE", `非法项目相对路径：${value}`);
  }
  return normalizeTargetFile(value);
}

function loadPolicy(root: ProjectRoot): GovernancePolicy {
  const config = loadConfig(root.meta);
  const fail = (reason: string): never => {
    throw new ConfigUnreadableError(path.join(root.meta, "config.yaml"), reason);
  };
  const object = (value: unknown, key: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fail(`${key} 必须为对象`);
    }
    return value as Record<string, unknown>;
  };
  const enforcement = (value: unknown, key: string): Enforcement => {
    if (value === undefined || value === null) return "warn";
    if (value === "warn" || value === "block") return value;
    return fail(`${key}.enforcement 仅接受 warn 或 block`);
  };
  const strings = (value: unknown, key: string): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return fail(`${key} 必须为字符串数组`);
    }
    return [...new Set(value as string[])].sort(compare);
  };
  const configuredPath = (value: string, key: string): string => {
    try {
      return relativePath(value);
    } catch (error) {
      return fail(`${key} 必须为项目内相对路径：${String(error)}`);
    }
  };
  const scopes: ArtifactScope[] = [];
  for (const [prefix, raw] of Object.entries(object(config.artifact_scopes ?? {}, "artifact_scopes"))) {
    const key = `artifact_scopes.${prefix}`;
    const scope = object(raw, key);
    if (typeof scope.parent_suffix !== "string" || !/^:[^:\s]+$/.test(scope.parent_suffix)) {
      fail(`${key}.parent_suffix 必须为非空冒号后缀`);
    }
    scopes.push({
      enforcement: enforcement(scope.enforcement, key),
      exempt_paths: [...new Set(strings(scope.exempt_paths, `${key}.exempt_paths`)
        .map((entry) => configuredPath(entry, `${key}.exempt_paths`)))].sort(compare),
      exempt_test_splits: strings(scope.exempt_test_splits, `${key}.exempt_test_splits`),
      parent_suffix: scope.parent_suffix as string,
      prefix: configuredPath(prefix, key).replace(/\/+$/, ""),
    });
  }
  const uniqueScopes = [...new Map(scopes.map((scope) => [JSON.stringify(scope), scope])).values()];
  uniqueScopes.sort((a, b) => compare(a.prefix, b.prefix) || compare(JSON.stringify(a), JSON.stringify(b)));
  return {
    artifact_scopes: uniqueScopes,
    derives_residue: {
      enforcement: enforcement(object(config.derives_residue ?? {}, "derives_residue").enforcement, "derives_residue"),
    },
    target_file_existence: {
      enforcement: enforcement(object(config.target_file_existence ?? {}, "target_file_existence").enforcement, "target_file_existence"),
    },
  };
}

/** Read-only policy projection for the internal API read models. */
export function getEffectiveGovernancePolicy(root: ProjectRoot): GovernancePolicy & {
  generation_receipts: { enforcement: "report" | "block" };
} {
  const policy = loadPolicy(root);
  const receipts = loadConfig(root.meta).generation_receipts;
  // Match generation-receipts validation: only omitted values default to report.
  if (receipts === undefined) {
    return { ...policy, generation_receipts: { enforcement: "report" } };
  }
  if (receipts !== null && typeof receipts === "object" && !Array.isArray(receipts)) {
    const enforcement = (receipts as Record<string, unknown>).enforcement;
    if (enforcement === undefined || enforcement === "report" || enforcement === "block") {
      return { ...policy, generation_receipts: { enforcement: enforcement ?? "report" } };
    }
  }
  throw new ConfigUnreadableError(root.meta, "generation_receipts.enforcement 必须是 report 或 block");
}

export function governancePolicyFingerprint(root: ProjectRoot): string {
  return createHash("sha256").update(JSON.stringify(loadPolicy(root))).digest("hex");
}

function withinScope(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(`${prefix}/`);
}

function checkScope(
  policy: GovernancePolicy,
  tddRoot: string,
  targetFile: string,
  parentId: string | null | undefined,
): void {
  // Preserve '..' in the declaration to catch attempts to leave a named scope.
  const raw = targetFile.replace(/\\/g, "/").replace(/\/+/g, "/")
    .split("/").filter((part) => part !== ".").join("/");
  const declared = process.platform === "win32" ? raw.toLowerCase() : raw;
  const declaredScopes = policy.artifact_scopes.filter((scope) => withinScope(declared, scope.prefix));
  let target: string;
  try {
    target = relativePath(targetFile);
  } catch (error) {
    if (declaredScopes.length === 0) throw error;
    throw new GovernanceError("TARGET_FILE_SCOPE_ESCAPE", `TDD ${tddRoot} 的目标逃出受管范围：${targetFile}`);
  }
  if (declaredScopes.some((scope) => !withinScope(target, scope.prefix))) {
    throw new GovernanceError("TARGET_FILE_SCOPE_ESCAPE", `TDD ${tddRoot} 的目标逃出受管范围：${targetFile}`);
  }
  for (const scope of policy.artifact_scopes) {
    if (withinScope(target, scope.prefix) && !parentId?.endsWith(scope.parent_suffix)) {
      throw new GovernanceError("TEST_SCOPE_PARENT_MISMATCH", `TDD ${tddRoot} 的目标 ${targetFile} 必须归属 ${scope.parent_suffix} 父节点`);
    }
  }
  const parentScopes = policy.artifact_scopes.filter((scope) => parentId?.endsWith(scope.parent_suffix));
  if (parentScopes.length > 0 && !parentScopes.some((scope) => withinScope(target, scope.prefix))) {
    throw new GovernanceError("TEST_SCOPE_PARENT_MISMATCH", `TDD ${tddRoot} 的目标 ${targetFile} 不在父节点 ${parentId} 的受管范围内`);
  }
}

export function checkArtifactScopeWrite(
  root: ProjectRoot,
  tddRoot: string,
  targetFile: string,
  parentId: string | null | undefined,
): void {
  checkScope(loadPolicy(root), tddRoot, targetFile, parentId);
}

interface Source {
  file: string;
  directory: string;
}

function effectiveSources(root: ProjectRoot, requested: string | null | undefined): {
  version: string | null;
  sources: Map<string, Source>;
} {
  const index = new IndexManager(root);
  const sources = new Map(index.loadBaseline().chunks.map((entry) => [entry.id, {
    file: entry.file, directory: root.docs,
  }]));
  if (requested === undefined || requested === null || requested === "baseline") {
    return { version: null, sources };
  }
  const metaPath = ensureWithin(path.join(root.meta, "versions"), `${requested}.yaml`);
  let meta;
  try {
    meta = loadModel(metaPath, VersionMetaSchema);
  } catch (error) {
    if (missing(error)) {
      throw new GovernanceError("VERSION_NOT_FOUND", `版本元数据不存在：${requested}（${metaPath}）`);
    }
    throw error;
  }
  const versionIndex = index.loadVersionIndex(requested);
  if (meta.version !== requested || versionIndex.version_name !== requested) {
    throw new GovernanceError("GOVERNANCE_SOURCE_MISSING", `版本元数据与索引名称不一致：${requested}`);
  }
  if (meta.merged_at !== null || meta.phase === "merged" || versionIndex.status === "merged") {
    return { version: null, sources };
  }
  const latest = [...new Set(versionIndex.chunks.map((entry) => entry.id))]
    .map((id) => index.queryVersion(requested, id)!);
  const remove = (id: string): void => {
    for (const candidate of sources.keys()) {
      if (candidate === id || (!id.includes(":") && candidate.startsWith(`${id}:`))) {
        sources.delete(candidate);
      }
    }
  };
  for (const entry of latest) {
    if (entry.action === "delete") {
      remove(entry.id);
      remove(entry.overrides || entry.id);
    }
    if (entry.action === "modify" && entry.overrides && entry.overrides !== entry.id) {
      remove(entry.overrides);
    }
  }
  const directory = ensureWithin(path.join(root.root, "versions"), requested);
  for (const entry of latest) {
    if (entry.action === "delete") continue;
    if (entry.file === null || !entry.file.trim()) {
      throw new GovernanceError("GOVERNANCE_SOURCE_MISSING", `chunk ${entry.id} 的版本索引缺少来源文件`);
    }
    sources.set(entry.id, { file: entry.file, directory });
  }
  return { version: requested, sources };
}

function readSources(root: ProjectRoot, sources: Map<string, Source>): Map<string, Chunk> {
  const parsed = new Map<string, ParsedFile>();
  const chunks = new Map<string, Chunk>();
  for (const [id, source] of sources) {
    if (!source.file.trim()) {
      throw new GovernanceError("GOVERNANCE_SOURCE_MISSING", `chunk ${id} 的索引缺少来源文件`);
    }
    const relative = source.file.replace(/\\/g, "/");
    const filename = ensureWithin(source.directory, /\.md$/i.test(relative) ? relative : `${relative}.md`);
    let document = parsed.get(filename);
    if (document === undefined) {
      try {
        document = parseFile(filename, root.root);
      } catch (error) {
        if (error instanceof ChunkParseError) throw error;
        throw new GovernanceError(missing(error) ? "GOVERNANCE_SOURCE_MISSING" : "GOVERNANCE_IO_ERROR",
          `规格来源文件${missing(error) ? "不存在" : "读取失败"}：${filename}（${String(error)}）`);
      }
      parsed.set(filename, document);
    }
    const chunk = document.chunks.find((candidate) => candidate.id === id);
    if (chunk === undefined) {
      throw new GovernanceError("GOVERNANCE_SOURCE_MISSING", `规格来源文件 ${filename} 中缺少 chunk：${id}`);
    }
    chunks.set(id, chunk);
  }
  return chunks;
}

function targetFileOf(chunk: Chunk, file: string): string {
  const lines = chunk.content.split(/\r?\n/);
  let fence: { marker: string; length: number; line: number; yaml: boolean } | null = null;
  for (let line = 0; line < lines.length; line++) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[line]!);
    if (match === null) continue;
    const marker = match[1]!;
    if (fence === null) {
      fence = { marker: marker[0]!, length: marker.length, line, yaml: /^ya?ml\s*$/i.test(match[2]!.trim()) };
      continue;
    }
    if (marker[0] !== fence.marker || marker.length < fence.length || match[2]!.trim()) continue;
    if (fence.yaml) {
      let declaration: unknown;
      try {
        declaration = parseYaml(lines.slice(fence.line + 1, line).join("\n"));
      } catch (error) {
        const location = chunk.startLine + fence.line + 1;
        throw new ChunkParseError(file, location, `TDD YAML 解析失败（${file}:${location}）：${String(error)}`);
      }
      if (declaration !== null && typeof declaration === "object" && !Array.isArray(declaration) && "target_file" in declaration) {
        if (typeof declaration.target_file === "string" && declaration.target_file.trim()) {
          return declaration.target_file;
        }
        break;
      }
    }
    fence = null;
  }
  throw new GovernanceError("TDD_TARGET_FILE_REQUIRED", `TDD ${chunk.id} 缺少非空字符串 target_file（${file}）`);
}

function actualFile(root: ProjectRoot, filename: string): boolean {
  // Path identities may fold case on Windows; disk IO always uses the declaration.
  const absolute = ensureWithin(root.cwd, path.posix.normalize(filename.replace(/\\/g, "/")));
  try {
    return fs.statSync(absolute).isFile();
  } catch (error) {
    if (missing(error)) return false;
    throw new GovernanceError("GOVERNANCE_IO_ERROR", `制品路径检查失败：${filename}（${String(error)}）`);
  }
}

export function evaluateGovernance(root: ProjectRoot, version?: string | null): GovernanceReport {
  const policy = loadPolicy(root);
  const effective = effectiveSources(root, version);
  const chunks = readSources(root, effective.sources);
  const view = combinedView(root, effective.version ?? undefined);
  const findings = new Map<string, GovernanceFinding>();
  const add = (finding: GovernanceFinding): void => {
    const key = JSON.stringify([finding.code, finding.chunkId, finding.file, finding.targetFile, finding.message]);
    if (!findings.has(key) || finding.enforcement === "block") findings.set(key, finding);
  };
  const owners = new Set<string>();
  for (const [id, chunk] of chunks) {
    if (!id.startsWith("[TDD]-")) continue;
    const file = effective.sources.get(id)!.file;
    const targetFile = targetFileOf(chunk, file);
    owners.add(relativePath(targetFile));
    const parents = [...new Set(view.edgesTo(id, "details").map((edge) => edge.src))];
    for (const parent of parents.length > 0 ? parents : [null]) {
      try {
        checkScope(policy, id, targetFile, parent);
      } catch (error) {
        if (!(error instanceof GovernanceError) ||
          !["TEST_SCOPE_PARENT_MISMATCH", "TARGET_FILE_SCOPE_ESCAPE"].includes(error.code)) throw error;
        add({ code: error.code, message: error.message, chunkId: id, file, targetFile, enforcement: "block" });
      }
    }
    if (!actualFile(root, targetFile)) {
      add({ code: "TDD_TARGET_FILE_MISSING", message: `TDD ${id} 的目标文件不存在或不是文件：${targetFile}`,
        chunkId: id, file, targetFile, enforcement: policy.target_file_existence.enforcement });
    }
  }
  if (policy.artifact_scopes.length > 0) {
    const tracked = spawnSync("git", ["ls-files", "-z", "--"], {
      cwd: root.cwd, encoding: "utf8", windowsHide: true,
    });
    if (tracked.error || tracked.status !== 0 || typeof tracked.stdout !== "string") {
      throw new GovernanceError("GOVERNANCE_IO_ERROR", `Git 跟踪文件枚举失败：${String(tracked.error ?? tracked.stderr)}`);
    }
    for (const file of new Set(tracked.stdout.split("\0").filter(Boolean))) {
      let identity: string;
      try {
        identity = relativePath(file);
      } catch (error) {
        throw new GovernanceError("GOVERNANCE_IO_ERROR", `Git 跟踪路径非法：${file}（${String(error)}）`);
      }
      const scopes = policy.artifact_scopes.filter((scope) => withinScope(identity, scope.prefix));
      if (scopes.length === 0 || !actualFile(root, file)) continue;
      for (const scope of scopes) {
        if (owners.has(identity) || scope.exempt_paths.includes(identity)) continue;
        add({ code: "UNCOVERED_ARTIFACT", message: `制品没有 TDD 属主：${file}`,
          file, targetFile: file, enforcement: scope.enforcement });
      }
    }
  }
  const acceptanceSuffixes = new Set([":TEST", ...policy.artifact_scopes.map((scope) => scope.parent_suffix)]);
  for (const node of view.nodes.values()) {
    if (node.type !== "fsd" || !isLegalChunkId(node.chunk_id) || !node.chunk_id.includes(":")) continue;
    const chunk = chunks.get(node.chunk_id);
    if (chunk === undefined) continue; // Deleted/replaced roots and splits are not effective sources.
    const file = effective.sources.get(node.chunk_id)!.file;
    for (const scope of policy.artifact_scopes) {
      if (!node.chunk_id.endsWith(scope.parent_suffix) || scope.exempt_test_splits.includes(node.chunk_id)) continue;
      if (view.edgesFrom(node.chunk_id, "details").some((edge) =>
        chunks.has(edge.dst) && view.nodes.get(edge.dst)?.type === "tdd")) continue;
      add({ code: "TEST_SPLIT_UNCOVERED", message: `验收节点没有 details 子 TDD：${node.chunk_id}`,
        chunkId: node.chunk_id, file, enforcement: scope.enforcement });
    }
    if ([...acceptanceSuffixes].some((suffix) => node.chunk_id.endsWith(suffix))) continue;
    const mapped = new Set(view.edgesTo(node.chunk_id, "derives").map((edge) => edge.src));
    for (const [requirement] of chunk.content.matchAll(/\[PRD\]-[A-Za-z0-9_:-]+/g)) {
      if (!requirement.includes(":") || !isLegalChunkId(requirement) || mapped.has(requirement)) continue;
      add({ code: "DERIVES_RESIDUE", message: `FSD ${node.chunk_id} 提及 ${requirement}，但缺少对应 derives 边`,
        chunkId: node.chunk_id, file, enforcement: policy.derives_residue.enforcement });
    }
  }
  const ordered = [...findings.values()].sort((a, b) => {
    for (const key of ["code", "chunkId", "file", "targetFile", "message"] as const) {
      const result = compare(a[key] ?? "", b[key] ?? "");
      if (result !== 0) return result;
    }
    return 0;
  });
  return {
    violations: ordered.filter((finding) => finding.enforcement === "block"),
    warnings: ordered.filter((finding) => finding.enforcement === "warn"),
    target_file_missing: ordered.filter((finding) => finding.code === "TDD_TARGET_FILE_MISSING"),
    derives_residue: ordered.filter((finding) => finding.code === "DERIVES_RESIDUE"),
  };
}