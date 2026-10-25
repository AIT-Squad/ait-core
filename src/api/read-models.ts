/** Read-only projections of version, confirmation, generation, and policy facts. */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  VersionMetaSchema,
  type VersionIndex,
  type VersionMeta,
} from "../doc-model/schemas.js";
import { ensureWithin } from "../foundation/io.js";
import type { ProjectRoot } from "../foundation/root.js";
import { loadModel } from "../foundation/yaml.js";
import { IndexManager } from "../indexing/index-manager.js";
import { CodegenError } from "../new-model/codegen.js";
import { getEffectiveGovernancePolicy } from "../new-model/governance.js";
import {
  generationVerificationCandidates,
  verifyGenerationReceipts,
} from "../orchestration/generation-receipts.js";
import {
  VersionManagerError,
  buildReconciliation,
  inputFingerprint,
} from "../versioning/version-manager.js";
import type {
  EffectiveGovernancePolicy,
  GenerationStatus,
  VersionInspection,
  VersionSummary,
} from "./types.js";

interface VersionContext {
  meta: VersionMeta;
  index: VersionIndex;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error
    ? error.code : undefined;
}

function isMerged(meta: VersionMeta): boolean {
  return meta.merged_at !== null || meta.phase === "merged";
}

function loadVersionMeta(root: ProjectRoot, version: string): VersionMeta {
  const file = ensureWithin(path.join(root.meta, "versions"), `${version}.yaml`);
  let meta: VersionMeta;
  try {
    meta = loadModel(file, VersionMetaSchema);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new VersionManagerError("VERSION_NOT_FOUND", `版本元数据不存在：${version}（${file}）`, { cause: error });
    }
    throw error;
  }
  if (meta.version !== version) {
    throw new VersionManagerError("SPEC_CONTENT_MISMATCH", `版本元数据名称不一致：${version}（${file}，记录为 ${meta.version}）`);
  }
  return meta;
}

function loadVersion(root: ProjectRoot, version: string): VersionContext {
  const meta = loadVersionMeta(root, version);
  const index = new IndexManager(root).loadVersionIndex(version);
  if (index.version_name !== version) {
    throw new VersionManagerError("SPEC_CONTENT_MISMATCH", `版本索引名称不一致：${version}（记录为 ${index.version_name}）`);
  }
  return { meta, index };
}

/** Keep IndexManager's existing numeric version ordering and schema defaults. */
export function listVersions(root: ProjectRoot): { versions: VersionSummary[] } {
  const metadata = new IndexManager(root).listVersions().map((version) => loadVersionMeta(root, version));
  const active = metadata.filter((meta) => !isMerged(meta));
  if (active.length > 1) {
    throw Object.assign(new Error(`存在多个活动版本：${active.map((meta) => meta.version).join(", ")}`), {
      code: "ACTIVE_VERSION_CONFLICT",
    });
  }
  return {
    versions: metadata.map((meta) => ({
      version: meta.version,
      title: meta.title,
      phase: meta.phase,
      merged: isMerged(meta),
      created_at: meta.created_at,
      merged_at: meta.merged_at,
      based_on: meta.dependencies.based_on,
    })),
  };
}

/**
 * Git's quiet verification distinguishes an unresolved object (exit 1, no
 * diagnostic) from a process, permissions, or repository-corruption failure.
 * Every command is read-only; no refresh, repair, or recovery is performed.
 */
function readGit(cwd: string, args: string[], probe: "repository" | "commit"): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
  });
  const diagnostic = result.stderr?.trim() ?? "";
  if (result.error === undefined && result.signal === null) {
    if (result.status === 0) return result.stdout.trim();
    if (probe === "commit" && result.status === 1 && (diagnostic === "" ||
        /^error: [^\r\n]+: expected commit type, but the object dereferences to (?:tree|blob|tag) type$/i.test(diagnostic))) {
      return null;
    }
    if (probe === "repository" && result.status === 128 &&
        /^fatal: not a git repository(?: \(or any of the parent directories\))?:[^\r\n]*$/i.test(diagnostic)) {
      return null;
    }
  }
  const detail = result.error?.message || diagnostic || `exit=${result.status ?? "?"}, signal=${result.signal ?? "none"}`;
  throw new VersionManagerError("GIT_FAILED", `只读 Git 锚点检查失败（${cwd}）：${detail}`, { cause: result.error });
}

function anchorResolvable(cwd: string, candidates: Array<string | null | undefined>): boolean | null {
  const refs = [...new Set(candidates.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== ""))];
  if (refs.length === 0) return null;
  if (readGit(cwd, ["rev-parse", "--git-dir"], "repository") === null) return false;
  for (const ref of refs) {
    // Peeling to commit also rejects refs pointing only to trees or blobs.
    const commit = readGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], "commit");
    if (commit !== null && commit !== "") return true;
  }
  return false;
}

export function inspectVersion(root: ProjectRoot, version: string): VersionInspection {
  const { meta } = loadVersion(root, version);
  const merged = isMerged(meta);
  const saved = meta.confirmed_plan;
  let confirmation: VersionInspection["confirmation"] = {
    state: merged ? "not_applicable" : "missing",
    plan_fingerprint: null,
    current_fingerprint: null,
    planned_operations: 0,
  };
  if (!merged && saved !== null) {
    const { plan } = buildReconciliation(root, version, saved.conflict_policy);
    const current = inputFingerprint(root, version, plan.operations, saved.conflict_policy);
    confirmation = {
      state: current === saved.input_fingerprint ? "valid" : "stale",
      plan_fingerprint: saved.input_fingerprint,
      current_fingerprint: current,
      planned_operations: saved.operations.length,
    };
  }

  // A merged version can retain only the conventional tag. Unmerged versions
  // without docs bindings have no applicable docs anchor to resolve.
  const docsApplicable = merged || meta.revert_anchor !== null || meta.docs_commit !== null;
  const docsCandidates = docsApplicable
    ? [meta.revert_anchor?.docs_ref, `refs/tags/ait/${version}`, meta.docs_commit]
    : [];
  const hostCandidates = [meta.revert_anchor?.code_result, meta.code_result, meta.code_base];
  const journal = meta.recovery_journal;
  return {
    version: meta.version,
    phase: meta.phase,
    based_on: meta.dependencies.based_on,
    confirmation,
    bindings: {
      docs_ref: meta.revert_anchor?.docs_ref ?? null,
      docs_commit: meta.docs_commit,
      code_base: meta.code_base,
      code_result: meta.code_result,
      docs_anchor_resolvable: anchorResolvable(root.root, docsCandidates),
      host_anchor_resolvable: anchorResolvable(root.cwd, hostCandidates),
    },
    recovery: {
      state: journal === null ? "none" : "recorded",
      phase: journal?.phase ?? null,
      diagnostic: journal?.diagnostic ?? null,
    },
  };
}

/** Project the receipt verifier's candidate set without manufacturing absent targets. */
function generationCandidates(root: ProjectRoot, version: string, tddRootId?: string) {
  return generationVerificationCandidates(root, version)
    .filter((candidate) => tddRootId === undefined || candidate.tdd_root === tddRootId)
    .map((candidate) => {
      if (candidate.target_file === "" && candidate.spec_error !== undefined) {
        throw Object.assign(new Error(candidate.spec_error), { code: candidate.spec_error_code ?? "SPEC_CONTENT_MISMATCH" });
      }
      return candidate;
    });
}

export function generationStatus(root: ProjectRoot, input: { version: string; tddRootId?: string }): GenerationStatus {
  const context = loadVersion(root, input.version);
  const candidates = generationCandidates(root, input.version, input.tddRootId);
  if (input.tddRootId !== undefined && candidates.length === 0) {
    throw new CodegenError("TDD_NOT_FOUND", `版本 ${input.version} 的生成候选中不存在 TDD：${input.tddRootId}`);
  }
  const verification = verifyGenerationReceipts(root, input.version);
  const deliveries = context.meta.generation?.deliveries ?? [];
  return {
    version: input.version,
    enforcement: verification.enforcement,
    items: candidates.map((candidate) => {
      const record = deliveries.find((delivery) => delivery.tdd_root === candidate.tdd_root);
      return {
        tdd_root: candidate.tdd_root,
        target_file: candidate.target_file,
        delivery_present: record !== undefined,
        receipt_present: record?.receipt !== undefined && record.receipt !== null,
        artifact_state: candidate.artifact.state,
        artifact_sha256: candidate.artifact.sha256,
        receipt_artifact_sha256: record?.receipt?.artifact_sha256 ?? null,
        findings: verification.findings
          .filter((finding) => finding.tdd_root === candidate.tdd_root && finding.target_file === candidate.target_file)
          .map(({ code, message }) => ({ code, message })),
      };
    }),
  };
}

export function getPolicy(root: ProjectRoot): EffectiveGovernancePolicy {
  return getEffectiveGovernancePolicy(root);
}
