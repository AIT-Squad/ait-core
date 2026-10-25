/** Generation delivery identity, receipt registration, and read-only verification. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GenerationDeliveryInputSchema,
  GenerationStateSchema,
  VersionMetaSchema,
  type GenerationArtifactState,
  type GenerationDeliveryInput,
  type GenerationDeliveryRecord,
  type GenerationReceipt,
  type GenerationState,
  type GenerationVerification,
  type VersionIndex,
  type VersionMeta,
} from "../doc-model/schemas.js";
import { ChunkParseError, parseText } from "../doc-model/chunk-parser.js";
import { ConfigUnreadableError, loadConfig } from "../foundation/config.js";
import { ensureWithin } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel, saveModel } from "../foundation/yaml.js";
import { IndexManager } from "../indexing/index-manager.js";
import { CodegenError, codegenPrepare, type CodegenBundle } from "../new-model/codegen.js";
import { normalizeTargetFile } from "../new-model/validator.js";
import { combinedView, specType } from "../specgraph/graph-model.js";

export type GenerationErrorCode =
  | "GENERATION_TOKEN_INVALID"
  | "GENERATION_TOKEN_STALE"
  | "GENERATION_SPEC_CHANGED"
  | "GENERATION_ARTIFACT_MISSING"
  | "GENERATION_ARTIFACT_UNREADABLE"
  | "GENERATION_ARTIFACT_CHANGED";

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;

  constructor(code: GenerationErrorCode, message: string) {
    super(message);
    this.name = "GenerationError";
    this.code = code;
  }
}

interface VersionContext {
  meta: VersionMeta;
  index: VersionIndex;
  file: string;
  merged: boolean;
}

interface GenerationStore {
  state: GenerationState | null;
  version: VersionContext | null;
}

export interface GenerationVerificationCandidate {
  tdd_root: string;
  target_file: string;
  artifact: GenerationArtifactState;
  bundle?: CodegenBundle;
  spec_error?: string;
  spec_error_code?: string;
}

type Candidate = GenerationVerificationCandidate;

const TOKEN_PATTERN = /^gen-v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Object key order in YAML must not affect a fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function loadVersion(root: ProjectRoot, version: string): VersionContext {
  const file = ensureWithin(path.join(root.meta, "versions"), `${version}.yaml`);
  const meta = loadModel(file, VersionMetaSchema);
  const index = new IndexManager(root).loadVersionIndex(version);
  if (meta.version !== version || index.version_name !== version) {
    throw new GenerationError("GENERATION_TOKEN_STALE", `版本元数据或索引身份不一致：${version}`);
  }
  return {
    meta,
    index,
    file,
    merged: meta.merged_at !== null || meta.phase === "merged" || index.status === "merged",
  };
}

function baselineFile(root: ProjectRoot): string {
  return ensureWithin(root.meta, "generation-baseline.yaml");
}

function loadBaseline(root: ProjectRoot): GenerationState | null {
  try {
    return loadModel(baselineFile(root), GenerationStateSchema);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function loadStore(root: ProjectRoot, version: string | null): GenerationStore {
  if (version === null) return { state: loadBaseline(root), version: null };
  const context = loadVersion(root, version);
  return { state: context.meta.generation, version: context };
}

function saveStore(root: ProjectRoot, store: GenerationStore, state: GenerationState): void {
  const validated = GenerationStateSchema.parse(state);
  if (store.version === null) {
    saveModel(baselineFile(root), validated);
  } else {
    saveModel(store.version.file, { ...store.version.meta, generation: validated });
  }
}

function readArtifact(root: ProjectRoot, target: string): GenerationArtifactState {
  const file = ensureWithin(root.cwd, normalizeTargetFile(target));
  try {
    return { state: "loaded", sha256: digest(fs.readFileSync(file)) };
  } catch (error) {
    return { state: errorCode(error) === "ENOENT" ? "absent" : "unreadable", sha256: null };
  }
}

function enforcement(root: ProjectRoot): "report" | "block" {
  const policy = loadConfig(root.meta).generation_receipts;
  if (policy === undefined) return "report";
  if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
    const value = (policy as Record<string, unknown>).enforcement;
    if (value === undefined) return "report";
    if (value === "report" || value === "block") return value;
  }
  throw new ConfigUnreadableError(root.meta, "generation_receipts.enforcement 必须是 report 或 block");
}

function sourcePath(root: ProjectRoot, index: IndexManager, version: string | null, id: string, file: string): string {
  const record = version === null ? null : index.queryVersion(version, id);
  const directory = record === null ? root.docs : ensureWithin(root.root, path.join("versions", version!));
  const markdown = file.replace(/\\/g, "/");
  return fs.realpathSync(ensureWithin(directory, markdown.endsWith(".md") ? markdown : `${markdown}.md`));
}

/** Excludes target bytes, clocks, receipts, and confirmed_plan; epoch binds the delivery lifetime. */
function specFingerprint(root: ProjectRoot, store: GenerationStore, bundle: CodegenBundle, epoch: string): string {
  const version = store.version?.meta.version ?? null;
  if (bundle.version !== version) {
    throw new GenerationError("GENERATION_TOKEN_STALE", "交付的版本已不再是可生成的当前版本");
  }
  const index = new IndexManager(root);
  const items = [...bundle.upstream, ...bundle.dependencies];
  const ids = new Set(items.map((item) => item.id));
  const view = version === null ? combinedView(root) : combinedView(root, version);
  const edges = new Map<string, { src: string; dst: string; rel: string }>();
  for (const id of ids) {
    for (const edge of [...view.edgesFrom(id), ...view.edgesTo(id)]) {
      const identity = { src: edge.src, dst: edge.dst, rel: edge.rel };
      edges.set(canonical(identity), identity);
    }
  }
  return digest(canonical({
    version,
    created_at: store.version?.meta.created_at ?? null,
    phase: store.version?.meta.phase ?? null,
    epoch,
    tdd_root: bundle.tddRoot,
    target_file: bundle.targetFile,
    source_file: fs.realpathSync(bundle.sourceFile),
    context: items.map((item) => ({
      ...item,
      source_file: sourcePath(root, index, version, item.id, item.file),
    })),
    edges: [...edges].sort(([a], [b]) => compare(a, b)).map(([, edge]) => edge),
  }));
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function readDeliveryFile(root: ProjectRoot, bundlePath: string): Buffer {
  if (!path.isAbsolute(bundlePath)) {
    throw new GenerationError("GENERATION_TOKEN_INVALID", "交付文件必须使用仓外绝对路径");
  }
  try {
    const realFile = fs.realpathSync(bundlePath);
    for (const directory of [root.cwd, root.root]) {
      if (isWithin(path.resolve(directory), path.resolve(bundlePath)) ||
          isWithin(fs.realpathSync(directory), realFile)) {
        throw new GenerationError("GENERATION_TOKEN_INVALID", "交付文件不能位于项目仓库内");
      }
    }
    return fs.readFileSync(realFile);
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    throw new GenerationError("GENERATION_TOKEN_INVALID", `交付文件不存在或不可读：${bundlePath}`);
  }
}

function validateDelivery(root: ProjectRoot, delivery: GenerationDeliveryInput, bundle: CodegenBundle): void {
  let bytes: Buffer;
  if ("content" in delivery && typeof delivery.content === "string") {
    bytes = Buffer.from(delivery.content, "utf8");
  } else if ("bundle_path" in delivery && typeof delivery.bundle_path === "string") {
    bytes = readDeliveryFile(root, delivery.bundle_path);
  } else {
    throw new GenerationError("GENERATION_TOKEN_INVALID", "交付必须提供完整内存内容或仓外文件");
  }
  // Both carriers must prove their actual bytes and current specification before replacing a delivery.
  if (bytes.length !== delivery.bytes || digest(bytes) !== delivery.bundle_sha256) {
    throw new GenerationError("GENERATION_TOKEN_INVALID", "交付内容的实际字节数或 SHA-256 与声明不一致");
  }
  const text = bytes.toString("utf8");
  for (const item of [...bundle.upstream, ...bundle.dependencies]) {
    if (!text.includes(item.content) || !text.includes(item.id) || !text.includes(item.file)) {
      throw new GenerationError("GENERATION_SPEC_CHANGED", `交付内容未包含当前规格的完整正文与来源：${item.id}`);
    }
  }
}

export function issueGenerationToken(root: ProjectRoot, delivery: GenerationDeliveryInput): string {
  delivery = GenerationDeliveryInputSchema.parse(delivery);
  const bundle = codegenPrepare(root, delivery.version, delivery.tdd_root);
  if (bundle.version !== delivery.version || bundle.tddRoot !== delivery.tdd_root ||
      bundle.targetFile !== normalizeTargetFile(delivery.target_file)) {
    throw new GenerationError("GENERATION_SPEC_CHANGED", "交付版本、TDD 或 target_file 与当前规格不一致");
  }
  const store = loadStore(root, bundle.version);
  if (store.version?.merged) throw new GenerationError("GENERATION_TOKEN_STALE", "已合入版本不能签发生成令牌");
  validateDelivery(root, delivery, bundle);
  const epoch = store.state?.epoch ?? crypto.randomUUID();
  const record: GenerationDeliveryRecord = {
    delivery_id: crypto.randomUUID(),
    token_digest: "",
    version: bundle.version,
    version_created_at: store.version?.meta.created_at ?? null,
    tdd_root: bundle.tddRoot,
    target_file: bundle.targetFile,
    bundle_sha256: delivery.bundle_sha256,
    spec_fingerprint: specFingerprint(root, store, bundle, epoch),
    before_artifact: readArtifact(root, bundle.targetFile),
    receipt: null,
  };
  const token = `gen-v1.${epoch}.${crypto.randomBytes(32).toString("hex")}`;
  record.token_digest = digest(token);
  const deliveries = (store.state?.deliveries ?? []).filter((entry) => entry.tdd_root !== record.tdd_root);
  deliveries.push(record);
  deliveries.sort((a, b) => compare(a.tdd_root, b.tdd_root));
  saveStore(root, store, { epoch, deliveries });
  return token;
}

function publicReceipt(receipt: NonNullable<GenerationDeliveryRecord["receipt"]>): GenerationReceipt {
  const { delivery_id: _deliveryId, ...result } = receipt;
  return result;
}

function assertCurrentRecord(store: GenerationStore, record: GenerationDeliveryRecord, epoch: string): void {
  if (store.state?.epoch !== epoch || store.version?.merged ||
      record.version !== (store.version?.meta.version ?? null) ||
      record.version_created_at !== (store.version?.meta.created_at ?? null)) {
    throw new GenerationError("GENERATION_TOKEN_STALE", "令牌的版本身份或交付周期已经失效");
  }
}

function currentBundle(root: ProjectRoot, record: GenerationDeliveryRecord): CodegenBundle {
  try {
    const bundle = codegenPrepare(root, record.version, record.tdd_root);
    if (bundle.version !== record.version) {
      throw new GenerationError("GENERATION_TOKEN_STALE", "令牌的活动版本或基线已失效");
    }
    if (bundle.targetFile !== record.target_file) {
      throw new GenerationError("GENERATION_SPEC_CHANGED", "TDD 的 target_file 已变化");
    }
    return bundle;
  } catch (error) {
    if (error instanceof CodegenError || errorCode(error) === "CHUNK_PARSE_ERROR" || errorCode(error) === "INVALID_TARGET_FILE") {
      throw new GenerationError("GENERATION_SPEC_CHANGED", error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

const YAML_FENCE_PATTERN = /```yaml[ \t]*\r?\n([\s\S]*?)```/g;

function historicalTarget(content: string, file: string): string {
  for (const fence of content.matchAll(YAML_FENCE_PATTERN)) {
    let value: unknown;
    try {
      value = parseYaml(fence[1] as string);
    } catch (error) {
      const line = content.slice(0, fence.index).split("\n").length + 1;
      throw new ChunkParseError(file, line, `target_file YAML 解析失败（${file}:${line}）：${String(error)}`);
    }
    if (value !== null && typeof value === "object" && "target_file" in value) {
      const target = (value as { target_file?: unknown }).target_file;
      if (typeof target !== "string" || target.trim() === "") {
        throw new CodegenError("TARGET_FILE_MISSING", `TDD 的 target_file 不是非空字符串：${file}`);
      }
      return normalizeTargetFile(target);
    }
  }
  throw new CodegenError("TARGET_FILE_MISSING", `TDD 缺少字符串 target_file 声明：${file}`);
}

/** Resolve a merged version from its retained TDD bytes, never from the later baseline. */
function mergedTarget(root: ProjectRoot, context: VersionContext, id: string): string {
  const latest = new IndexManager(root).queryVersion(context.meta.version, id);
  if (latest === null || latest.action === "delete" || latest.file === null) {
    throw new CodegenError("TDD_NOT_FOUND", `已合入版本 ${context.meta.version} 不保留 TDD：${id}`);
  }
  const relative = latest.file.replace(/\\/g, "/");
  const file = ensureWithin(
    ensureWithin(root.root, path.join("versions", context.meta.version)),
    relative.endsWith(".md") ? relative : `${relative}.md`,
  );
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new CodegenError("SPEC_CONTENT_MISMATCH", `已合入版本 TDD 来源缺失或不可读：${id}（${file}）：${String(error)}`);
  }
  const chunk = parseText(text, file).chunks.find((entry) => entry.id === id);
  if (chunk === undefined) {
    throw new CodegenError("SPEC_CONTENT_MISMATCH", `已合入版本 TDD 正文缺少索引声明的 chunk：${id}（${file}）`);
  }
  return historicalTarget(chunk.content, file);
}

export function registerGenerationReceipt(root: ProjectRoot, input: { generation_token: string }): GenerationReceipt {
  const token = input?.generation_token;
  const match = typeof token === "string" ? TOKEN_PATTERN.exec(token) : null;
  if (match === null) throw new GenerationError("GENERATION_TOKEN_INVALID", "生成令牌格式无效");
  const tokenDigest = digest(token);
  const stores: GenerationStore[] = [];
  for (const version of new IndexManager(root).listVersions()) {
    const context = loadVersion(root, version);
    stores.push({ state: context.meta.generation, version: context });
  }
  stores.push({ state: loadBaseline(root), version: null });
  const matches = stores.flatMap((store) => (store.state?.deliveries ?? [])
    .filter((record) => record.token_digest === tokenDigest).map((record) => ({ store, record })));
  if (matches.length === 0) {
    throw new GenerationError("GENERATION_TOKEN_STALE", "令牌不属于该项目当前保留的最新交付");
  }
  const found = matches[0];
  if (matches.length !== 1 || found === undefined) {
    throw new GenerationError("GENERATION_TOKEN_INVALID", "生成令牌未唯一绑定一项交付");
  }
  const { store, record } = found;
  const epoch = match[1]!;
  assertCurrentRecord(store, record, epoch);
  if (record.version === null && stores.some((entry) => entry.version !== null && !entry.version.merged)) {
    throw new GenerationError("GENERATION_TOKEN_STALE", "已有活动版本，基线生成令牌失效");
  }
  const bundle = currentBundle(root, record);
  if (specFingerprint(root, store, bundle, epoch) !== record.spec_fingerprint) {
    throw new GenerationError("GENERATION_SPEC_CHANGED", "交付之后规格正文、来源或关系已经变化");
  }
  const artifact = readArtifact(root, record.target_file);
  if (artifact.state === "absent") throw new GenerationError("GENERATION_ARTIFACT_MISSING", `制品不存在：${record.target_file}`);
  if (artifact.state === "unreadable") throw new GenerationError("GENERATION_ARTIFACT_UNREADABLE", `制品不可读：${record.target_file}`);
  if (record.receipt !== null) {
    if (record.receipt.artifact_sha256 !== artifact.sha256) {
      throw new GenerationError("GENERATION_ARTIFACT_CHANGED", "已登记制品发生变化，必须重新交付后再登记");
    }
    return publicReceipt(record.receipt);
  }
  const receipt = {
    version: record.version,
    tdd_root: record.tdd_root,
    target_file: record.target_file,
    bundle_sha256: record.bundle_sha256,
    artifact_sha256: artifact.sha256!,
    generated_at: new Date().toISOString(),
    delivery_id: record.delivery_id,
  };
  saveStore(root, store, {
    epoch,
    deliveries: store.state!.deliveries.map((entry) => entry.delivery_id === record.delivery_id ? { ...entry, receipt } : entry),
  });
  return publicReceipt(receipt);
}

export function generationVerificationCandidates(root: ProjectRoot, version: string): GenerationVerificationCandidate[] {
  const context = loadVersion(root, version);
  const index = new IndexManager(root);
  const result = new Map<string, Candidate>();
  const add = (candidate: Candidate) => result.set(`${candidate.tdd_root}\0${candidate.target_file}`, candidate);
  const ids = [...new Set(context.index.chunks.map((entry) => entry.id))].sort(compare);
  for (const id of ids) {
    const latest = index.queryVersion(context.meta.version, id);
    if (latest === null || latest.action === "delete" || id.includes(":") ||
        specType(id, latest.file ?? undefined) !== "tdd") continue;
    try {
      if (context.merged) {
        const target = mergedTarget(root, context, id);
        add({ tdd_root: id, target_file: target, artifact: readArtifact(root, target) });
      } else {
        const bundle = codegenPrepare(root, context.meta.version, id);
        add({ tdd_root: id, target_file: bundle.targetFile, artifact: readArtifact(root, bundle.targetFile), bundle });
      }
    } catch (error) {
      if (!(error instanceof CodegenError) && errorCode(error) !== "CHUNK_PARSE_ERROR" && errorCode(error) !== "INVALID_TARGET_FILE") throw error;
      const target = context.meta.generation?.deliveries.find((record) => record.tdd_root === id)?.target_file ?? "";
      add({
        tdd_root: id,
        target_file: target,
        artifact: target === "" ? { state: "absent", sha256: null } : readArtifact(root, target),
        spec_error: error instanceof Error ? error.message : String(error),
        spec_error_code: typeof errorCode(error) === "string" ? errorCode(error) as string : "SPEC_CONTENT_MISMATCH",
      });
    }
  }
  for (const record of context.meta.generation?.deliveries ?? []) {
    const artifact = readArtifact(root, record.target_file);
    if (artifact.state !== record.before_artifact.state || artifact.sha256 !== record.before_artifact.sha256) {
      const key = `${record.tdd_root}\0${record.target_file}`;
      if (!result.has(key)) add({ tdd_root: record.tdd_root, target_file: record.target_file, artifact });
    }
  }
  return [...result.values()].sort((a, b) => compare(a.tdd_root, b.tdd_root) || compare(a.target_file, b.target_file));
}

function candidateFinding(root: ProjectRoot, store: GenerationStore, candidate: Candidate): { code: string; message: string } | null {
  const record = store.state?.deliveries.find((entry) => entry.tdd_root === candidate.tdd_root);
  if (record === undefined || record.receipt === null) {
    return { code: "GENERATION_RECEIPT_MISSING", message: "缺少与最新交付绑定的生成回执" };
  }
  try {
    if (store.version?.merged) {
      if (record.version !== store.version.meta.version ||
          record.version_created_at !== store.version.meta.created_at) {
        throw new GenerationError("GENERATION_TOKEN_STALE", "历史交付的版本身份与保存元数据不一致");
      }
    } else {
      assertCurrentRecord(store, record, store.state!.epoch);
    }
    if (record.target_file !== candidate.target_file) {
      throw new GenerationError("GENERATION_SPEC_CHANGED", "最新交付的目标与版本声明的制品不一致");
    }
    if (candidate.spec_error !== undefined) throw new GenerationError("GENERATION_SPEC_CHANGED", candidate.spec_error);
    if (!store.version?.merged) {
      const bundle = candidate.bundle ?? currentBundle(root, record);
      if (specFingerprint(root, store, bundle, store.state!.epoch) !== record.spec_fingerprint) {
        throw new GenerationError("GENERATION_SPEC_CHANGED", "交付之后规格正文、来源或关系已经变化");
      }
    }
    if (candidate.artifact.state === "absent") throw new GenerationError("GENERATION_ARTIFACT_MISSING", "已登记制品不存在");
    if (candidate.artifact.state === "unreadable") throw new GenerationError("GENERATION_ARTIFACT_UNREADABLE", "已登记制品不可读");
    if (candidate.artifact.sha256 !== record.receipt.artifact_sha256) {
      throw new GenerationError("GENERATION_ARTIFACT_CHANGED", "当前制品 SHA-256 与已登记回执不一致");
    }
  } catch (error) {
    if (error instanceof GenerationError) return { code: error.code, message: error.message };
    throw error;
  }
  return null;
}

export function verifyGenerationReceipts(root: ProjectRoot, version: string): GenerationVerification {
  const policy = enforcement(root);
  const context = loadVersion(root, version);
  const store = { state: context.meta.generation, version: context };
  const findings: GenerationVerification["findings"] = [];
  for (const candidate of generationVerificationCandidates(root, version)) {
    const finding = candidateFinding(root, store, candidate);
    if (finding !== null) findings.push({ ...finding, tdd_root: candidate.tdd_root, target_file: candidate.target_file });
  }
  findings.sort((a, b) => compare(a.tdd_root, b.tdd_root) || compare(a.target_file, b.target_file) || compare(a.code, b.code));
  return { enforcement: policy, passed: policy === "report" || findings.length === 0, findings };
}

/** Internal confirm/merge binding; deliberately not part of the package root API. */
export function generationFingerprint(root: ProjectRoot, version: string): string {
  const policy = enforcement(root);
  const context = loadVersion(root, version);
  const store = { state: context.meta.generation, version: context };
  return digest(canonical({
    enforcement: policy,
    version,
    created_at: context.meta.created_at,
    phase: context.meta.phase,
    generation: context.meta.generation,
    candidates: generationVerificationCandidates(root, version).map((candidate) => ({
      tdd_root: candidate.tdd_root,
      target_file: candidate.target_file,
      artifact: candidate.artifact,
      finding: candidateFinding(root, store, candidate),
    })),
  }));
}

export function invalidateGeneration(root: ProjectRoot, version: string): void {
  const context = loadVersion(root, version);
  if (context.merged) throw new GenerationError("GENERATION_TOKEN_STALE", "已合入版本的生成记录只读");
  if (context.meta.generation !== null) saveModel(context.file, { ...context.meta, generation: null });
}
