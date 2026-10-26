/**
 * [TDD]-clone_manager — docs-first, in-place restoration of the two AIT
 * repositories.  Recovery authority lives only in the docs repository's Git
 * directory; shared repository metadata is never treated as permission to
 * reuse or overwrite an existing directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteText } from "../foundation/io.js";
import { reportProgress } from "../foundation/progress.js";
import type { ProjectRoot } from "../foundation/root.js";
import { IndexManager } from "../indexing/index-manager.js";
import { combinedView, SpecGraphStore } from "../specgraph/graph-model.js";
import { validateInvariants } from "../new-model/validator.js";
import { checkProject, refreshWrapper } from "./init-manager.js";
import {
  canonicalRepositoryUrl,
  readRepositories,
  validateBranchName,
  validateRepositoryUrl,
} from "./repository-config.js";

export interface CloneInput {
  docsUrl: string;
  hostUrl?: string;
  branch?: string;
  docsBranch?: string;
}

export interface ClonedRepository {
  path: string;
  url: string;
  branch: string;
  commit: string;
}

export interface CloneResult {
  directory: string;
  resumed: boolean;
  host: ClonedRepository;
  docs: ClonedRepository;
  wrapper: string;
  warnings: string[];
}

export type CloneErrorCode =
  | "CLONE_DIRECTORY_NOT_EMPTY"
  | "CLONE_REPOSITORY_MISMATCH"
  | "CLONE_PATH_CONFLICT"
  | "CLONE_GIT_FAILED"
  | "CLONE_BRANCH_NOT_FOUND"
  | "CLONE_STATE_INVALID"
  | "CLONE_PROJECT_INVALID";

export class CloneError extends Error {
  readonly code: CloneErrorCode;

  constructor(code: CloneErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloneError";
    this.code = code;
  }
}

type ClonePhase =
  | "docs-cloned"
  | "config-read"
  | "host-initialized"
  | "host-fetched"
  | "host-checked-out"
  | "complete";

interface CloneState {
  schemaVersion: 1;
  signature: string;
  directory: string;
  phase: ClonePhase;
  docsUrl: string;
  requestedDocsBranch: string | null;
  docsBranch: string;
  docsCommit: string;
  requestedHostUrl: string | null;
  requestedHostBranch: string | null;
  hostUrl: string | null;
  hostBranch: string | null;
  hostGitCreated: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

const STATE_FILE = "ait-clone-state.json";
const PHASES: readonly ClonePhase[] = [
  "docs-cloned",
  "config-read",
  "host-initialized",
  "host-fetched",
  "host-checked-out",
  "complete",
];

function cloneError(code: CloneErrorCode, phase: string, detail: string, cause?: unknown): CloneError {
  const labels: Readonly<Record<string, string>> = {
    "resolve docs branch": "文档仓分支查询",
    "clone docs": "文档仓克隆",
    "resolve default branch": "代码仓默认分支查询",
    "fetch host": "代码仓拉取",
    "checkout host": "代码仓检出",
    "add host origin": "代码仓 origin 配置",
    "init host": "代码仓初始化",
  };
  const label = labels[phase];
  return new CloneError(code, `${label === undefined ? `${phase} ` : label}失败：${detail}`, cause === undefined ? undefined : { cause });
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const redirecting = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
  ]);
  for (const key of Object.keys(env)) {
    if (redirecting.has(key.toUpperCase()) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function redactGitText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]+)([^\s]*)/gi, (_match, scheme: string, authority: string, rest: string) => {
      const protocol = scheme.slice(0, -3).toLowerCase();
      const at = authority.lastIndexOf("@");
      let safeAuthority = authority;
      if (at >= 0) {
        const userinfo = authority.slice(0, at);
        const host = authority.slice(at + 1);
        if (protocol === "http" || protocol === "https" || userinfo.includes(":")) {
          safeAuthority = `<credentials>@${host}`;
        }
      }
      const query = rest.search(/[?#]/);
      if (query < 0) return `${scheme}${safeAuthority}${rest}`;
      const pathPart = rest.slice(0, query);
      const suffix = rest.slice(query);
      const hasQuery = suffix.startsWith("?");
      const hasFragment = suffix.includes("#");
      return `${scheme}${safeAuthority}${pathPart}${hasQuery ? "?<redacted>" : ""}${hasFragment ? "#<redacted>" : ""}`;
    })
    .trim();
}

function operationRepository(cwd: string, args: readonly string[], repositoryUrls: readonly string[]): string | undefined {
  const explicit = repositoryUrls.find((url) => args.includes(url));
  if (explicit !== undefined) return explicit;
  return path.basename(cwd).toLowerCase() === "project-docs" ? repositoryUrls[0] : repositoryUrls.at(-1);
}

function git(
  cwd: string,
  args: readonly string[],
  phase: string,
  repositoryUrls: readonly string[],
  options: { allowFailure?: boolean } = {},
): GitResult {
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync("git", ["-c", `core.hooksPath=${hooksPath}`, "-c", "submodule.recurse=false", ...args], {
    cwd,
    env: sanitizedEnvironment(),
    encoding: "utf8",
    input: "",
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const status = result.status ?? -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error !== undefined && !options.allowFailure) {
    reportProgress("git", "failed");
    const target = operationRepository(cwd, args, repositoryUrls);
    const context = `工作目录：${cwd}${target === undefined ? "" : `；仓库：${redactGitText(target)}`}`;
    throw cloneError("CLONE_GIT_FAILED", phase, `${redactGitText(result.error.message)}；${context}`, result.error);
  }
  if (status !== 0 && !options.allowFailure) {
    reportProgress("git", "failed");
    const target = operationRepository(cwd, args, repositoryUrls);
    const detail = redactGitText(stderr || stdout || `git 退出码 ${status}`);
    const context = `工作目录：${cwd}${target === undefined ? "" : `；仓库：${redactGitText(target)}`}`;
    throw cloneError("CLONE_GIT_FAILED", phase, `${detail}；${context}`);
  }
  return { stdout, stderr, status };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertSafeDestination(directory: string): void {
  const parsedRoot = path.parse(directory).root;
  if (samePath(directory, parsedRoot) || samePath(directory, os.homedir())) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate", `拒绝在卷根或用户根执行：${directory}`);
  }
  let real: string;
  try {
    real = fs.realpathSync.native(directory);
  } catch (error) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate", `当前目录不可解析：${directory}`, error);
  }
  if (!samePath(real, directory)) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate", `当前目录包含符号链接或重解析路径：${directory}`);
  }
}

function assertNotLink(target: string, label: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 不得是符号链接：${target}`);
    }
  } catch (error) {
    if (error instanceof CloneError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 无法检查：${target}`, error);
  }
}

function assertDirectoryOrAbsent(target: string, label: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 必须是真实目录：${target}`);
    }
  } catch (error) {
    if (error instanceof CloneError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 无法检查：${target}`, error);
    }
  }
}

function assertRegularFileOrAbsent(target: string, label: string): void {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 必须是真实文件：${target}`);
    }
  } catch (error) {
    if (error instanceof CloneError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 无法检查：${target}`, error);
    }
  }
}

function assertManagedPaths(directory: string, requireGitDirectories: boolean): void {
  const docs = path.join(directory, "project-docs");
  const docsGit = path.join(docs, ".git");
  const hostGit = path.join(directory, ".git");
  for (const [target, label] of [
    [docs, "project-docs"],
    [path.join(docs, ".meta"), "project-docs/.meta"],
    [path.join(docs, ".meta", "versions"), "project-docs/.meta/versions"],
    [path.join(docs, "docs"), "project-docs/docs"],
    [path.join(docs, "docs", "prd"), "project-docs/docs/prd"],
    [path.join(docs, "docs", "fsd"), "project-docs/docs/fsd"],
    [path.join(docs, "docs", "tdd"), "project-docs/docs/tdd"],
    [path.join(docs, ".ait"), "project-docs/.ait"],
    [path.join(docsGit, "info"), "docs .git/info"],
    [path.join(hostGit, "info"), "host .git/info"],
  ] as const) assertDirectoryOrAbsent(target, label);
  for (const [target, label] of [
    [statePath(docs), "clone state"],
    [path.join(docsGit, "info", "exclude"), "docs info/exclude"],
    [path.join(hostGit, "info", "exclude"), "host info/exclude"],
    [wrapperPath(directory), "project wrapper"],
  ] as const) assertRegularFileOrAbsent(target, label);
  if (requireGitDirectories) {
    for (const [target, label] of [[docsGit, "docs .git"], [hostGit, "host .git"]] as const) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 必须是真实目录（不支持 gitfile/worktree）：${target}`);
      }
    }
  } else {
    assertDirectoryOrAbsent(docsGit, "docs .git");
    assertDirectoryOrAbsent(hostGit, "host .git");
  }
}

function assertRealGitDirectory(target: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 缺失或无法检查：${target}`, error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate", `${label} 必须是真实目录（不支持 gitfile/worktree）：${target}`);
  }
}

function assertPreCheckoutRootContents(directory: string, allowHostGit: boolean): void {
  const allowed = new Set(["project-docs", ...(allowHostGit ? [".git"] : [])]);
  const unexpected = fs.readdirSync(directory).filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw cloneError(
      "CLONE_DIRECTORY_NOT_EMPTY",
      "resume",
      `检出代码前目标根出现未知内容：${unexpected.join(", ")}`,
    );
  }
}

function statePath(docsDirectory: string): string {
  return path.join(docsDirectory, ".git", STATE_FILE);
}

function writeState(docsDirectory: string, state: CloneState): void {
  reportProgress("persist", "started");
  try {
    atomicWriteText(statePath(docsDirectory), `${JSON.stringify(state, null, 2)}\n`);
    reportProgress("persist", "completed");
  } catch (error) {
    reportProgress("persist", "failed");
    throw error;
  }
}

function readState(docsDirectory: string): CloneState {
  const file = statePath(docsDirectory);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw cloneError("CLONE_STATE_INVALID", "resume", `恢复记录缺失或损坏：${file}`, error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw cloneError("CLONE_STATE_INVALID", "resume", `恢复记录不是对象：${file}`);
  }
  const state = value as Partial<CloneState>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.signature !== "string" || state.signature.length < 16 ||
    typeof state.directory !== "string" ||
    !PHASES.includes(state.phase as ClonePhase) ||
    typeof state.docsUrl !== "string" ||
    !(state.requestedDocsBranch === null || typeof state.requestedDocsBranch === "string") ||
    typeof state.docsBranch !== "string" ||
    typeof state.docsCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(state.docsCommit) ||
    !(state.requestedHostUrl === null || typeof state.requestedHostUrl === "string") ||
    !(state.requestedHostBranch === null || typeof state.requestedHostBranch === "string") ||
    !(state.hostUrl === null || typeof state.hostUrl === "string") ||
    !(state.hostBranch === null || typeof state.hostBranch === "string") ||
    typeof state.hostGitCreated !== "boolean"
  ) {
    throw cloneError("CLONE_STATE_INVALID", "resume", `恢复记录字段非法：${file}`);
  }
  if ((phaseAtLeast(state as CloneState, "host-initialized") && !state.hostGitCreated)
    || (phaseAtLeast(state as CloneState, "config-read") && state.hostUrl === null)
    || (phaseAtLeast(state as CloneState, "host-fetched") && state.hostBranch === null)) {
    throw cloneError("CLONE_STATE_INVALID", "resume", `恢复阶段与仓库身份不一致：${file}`);
  }
  return state as CloneState;
}

function currentBranch(cwd: string, urls: readonly string[]): string {
  const result = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], "inspect branch", urls, { allowFailure: true });
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `仓库未处于本地分支：${cwd}`);
  }
  return result.stdout.trim();
}

function commitOf(cwd: string, ref: string, urls: readonly string[]): string {
  const result = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], "inspect commit", urls, { allowFailure: true });
  if (result.status !== 0) {
    throw cloneError("CLONE_BRANCH_NOT_FOUND", "resolve branch", `分支不存在或未指向提交：${ref}`);
  }
  return result.stdout.trim();
}

function originOf(cwd: string, urls: readonly string[]): string {
  const result = git(cwd, ["config", "--local", "--get-all", "remote.origin.url"], "inspect origin", urls, { allowFailure: true });
  const values = result.stdout.split(/\r?\n/).filter((value) => value.length > 0);
  if (result.status !== 0 || values.length === 0) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `仓库缺少 origin：${cwd}`);
  }
  if (values.length !== 1) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `仓库 origin 必须恰有一个本地配置值：${cwd}`);
  }
  try {
    return validateRepositoryUrl(values[0]!);
  } catch (error) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `仓库 origin 本地配置值非法：${cwd}`, error);
  }
}

function assertRepositoryRoot(cwd: string, urls: readonly string[]): void {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], "inspect root", urls, { allowFailure: true });
  if (result.status !== 0 || !samePath(result.stdout.trim(), cwd)) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `Git 根不是预期目录：${cwd}`);
  }
}

function assertClean(cwd: string, label: string, urls: readonly string[]): void {
  const status = git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], `inspect ${label}`, urls);
  if (status.stdout.length !== 0) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", `${label} 工作区存在修改，拒绝覆盖：${cwd}`);
  }
}

function assertOrigin(cwd: string, expected: string, urls: readonly string[]): void {
  const actual = originOf(cwd, urls);
  if (canonicalRepositoryUrl(actual) !== canonicalRepositoryUrl(expected)) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", `origin 与恢复记录不一致：${cwd}`);
  }
}

function appendInfoExclude(gitDirectory: string, rule: string): void {
  const file = path.join(gitDirectory, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
  if (existing.split("\n").includes(rule)) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  atomicWriteText(file, `${prefix}${rule}\n`);
}

function defaultRemoteBranch(cwd: string, urls: readonly string[]): string {
  const result = git(cwd, ["ls-remote", "--symref", "origin", "HEAD"], "resolve default branch", urls);
  const match = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(result.stdout);
  if (match?.[1] === undefined) {
    throw cloneError("CLONE_BRANCH_NOT_FOUND", "resolve default branch", "远端 HEAD 未声明默认分支");
  }
  return validateBranchName(match[1]);
}

function assertNoDocsPathInHost(cwd: string, remoteRef: string, urls: readonly string[]): void {
  const tree = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", remoteRef], "inspect host tree", urls);
  for (const record of tree.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const repositoryPath = record.slice(tab + 1);
    const first = repositoryPath.split("/")[0];
    if (first?.toLowerCase() === "project-docs") {
      throw cloneError("CLONE_PATH_CONFLICT", "inspect host tree", `代码仓分支包含冲突路径：${repositoryPath}`);
    }
  }
}

function assertUpstream(cwd: string, branch: string, urls: readonly string[]): void {
  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], "inspect upstream", urls, { allowFailure: true });
  if (upstream.status !== 0 || upstream.stdout.trim() !== `origin/${branch}`) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "inspect", `分支 ${branch} 未跟踪 origin/${branch}`);
  }
}

function checkoutHostBranch(cwd: string, branch: string, urls: readonly string[]): void {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const remoteCommit = commitOf(cwd, remoteRef, urls);
  assertNoDocsPathInHost(cwd, remoteRef, urls);
  const existing = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], "inspect local branch", urls, { allowFailure: true });
  if (existing.status === 0) {
    const localCommit = commitOf(cwd, `refs/heads/${branch}`, urls);
    if (localCommit !== remoteCommit) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "checkout host", `既有本地分支 ${branch} 与远端提交不一致`);
    }
    const checkout = git(cwd, ["checkout", "--no-overwrite-ignore", branch], "checkout host", urls, { allowFailure: true });
    if (checkout.status !== 0) {
      const target = operationRepository(cwd, [], urls);
      throw cloneError(
        "CLONE_GIT_FAILED",
        "checkout host",
        `${redactGitText(checkout.stderr || checkout.stdout)}；工作目录：${cwd}${target === undefined ? "" : `；仓库：${redactGitText(target)}`}`,
      );
    }
  } else {
    git(cwd, ["checkout", "--no-overwrite-ignore", "--track", "-b", branch, `origin/${branch}`], "checkout host", urls);
  }
  assertUpstream(cwd, branch, urls);
  if (commitOf(cwd, "HEAD", urls) !== remoteCommit) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "checkout host", `检出后的 HEAD 与 origin/${branch} 不一致`);
  }
}

function ensureCloneSkeleton(directory: string): void {
  for (const relative of [
    "project-docs/.meta/versions",
    "project-docs/docs/prd",
    "project-docs/docs/fsd",
    "project-docs/docs/tdd",
  ]) {
    fs.mkdirSync(path.join(directory, relative), { recursive: true });
  }
}

function validateProject(directory: string): void {
  const root: ProjectRoot = {
    cwd: directory,
    root: path.join(directory, "project-docs"),
    docs: path.join(directory, "project-docs", "docs"),
    meta: path.join(directory, "project-docs", ".meta"),
  };
  try {
    for (const file of [path.join(root.meta, "chunks-index.yaml"), path.join(root.meta, "specgraph.yaml")]) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`不是普通文件：${file}`);
    }
    new IndexManager(root).loadBaseline();
    new SpecGraphStore(root).load();
    const violations = validateInvariants(combinedView(root));
    if (violations.length > 0) {
      throw new Error(violations.map((item) => `${item.code}: ${item.message}`).join("；"));
    }
  } catch (error) {
    throw cloneError("CLONE_PROJECT_INVALID", "validate project", `基线索引或规格图不可解析：${String(error)}`, error);
  }
}

function assertLocalWrapper(cwd: string, urls: readonly string[]): void {
  const tracked = git(cwd, ["ls-files", "-z", "--", ".ait"], "inspect local wrapper", urls);
  if (tracked.stdout.length > 0) {
    throw cloneError("CLONE_PATH_CONFLICT", "validate project", "文档仓跟踪了 .ait 路径，不能用本机入口覆盖共享文件");
  }
}

function wrapperPath(directory: string): string {
  return path.join(directory, "project-docs", ".ait", process.platform === "win32" ? "ait-cli.cmd" : "ait-cli");
}

function phaseAtLeast(state: CloneState, phase: ClonePhase): boolean {
  return PHASES.indexOf(state.phase) >= PHASES.indexOf(phase);
}

/** Restore the docs and host repositories into an empty final project root. */
export function cloneProject(cwd: string, input: CloneInput): CloneResult {
  reportProgress("validate", "started");
  const directory = path.resolve(cwd);
  const docsDirectory = path.join(directory, "project-docs");
  const hostGitDirectory = path.join(directory, ".git");
  const docsGitDirectory = path.join(docsDirectory, ".git");
  assertSafeDestination(directory);
  assertNotLink(docsDirectory, "project-docs");
  assertNotLink(hostGitDirectory, "宿主 .git");

  const docsUrl = validateRepositoryUrl(input.docsUrl);
  const hostOverride = input.hostUrl === undefined ? null : validateRepositoryUrl(input.hostUrl);
  const requestedHostBranch = input.branch === undefined ? null : validateBranchName(input.branch);
  const requestedDocsBranch = input.docsBranch === undefined ? null : validateBranchName(input.docsBranch);
  const knownUrls = [docsUrl, ...(hostOverride === null ? [] : [hostOverride])];
  const warnings: string[] = [];
  reportProgress("validate", "completed");
  reportProgress("git", "started");

  const entries = fs.readdirSync(directory);
  const isFresh = entries.length === 0;
  let resumed = false;
  let state: CloneState;

  if (isFresh) {
    const ancestor = git(directory, ["rev-parse", "--show-toplevel"], "inspect ancestor", knownUrls, { allowFailure: true });
    if (ancestor.status === 0) {
      throw cloneError("CLONE_PATH_CONFLICT", "validate", `目标位于既有 Git 工作树内：${ancestor.stdout.trim()}`);
    }
    if (requestedDocsBranch !== null) {
      const branchProbe = git(
        directory,
        ["ls-remote", "--exit-code", "--heads", "--", docsUrl, `refs/heads/${requestedDocsBranch}`],
        "resolve docs branch",
        knownUrls,
        { allowFailure: true },
      );
      if (branchProbe.status === 2) {
        throw cloneError("CLONE_BRANCH_NOT_FOUND", "resolve docs branch", `文档分支不存在：${requestedDocsBranch}`);
      }
      if (branchProbe.status !== 0) {
        throw cloneError(
          "CLONE_GIT_FAILED",
          "resolve docs branch",
          `${redactGitText(branchProbe.stderr || branchProbe.stdout || `git 退出码 ${branchProbe.status}`)}；工作目录：${directory}；仓库：${redactGitText(docsUrl)}`,
        );
      }
    }
    fs.mkdirSync(docsDirectory);
    try {
      const args = ["clone", "--no-recurse-submodules"];
      if (requestedDocsBranch !== null) args.push("--branch", requestedDocsBranch);
      args.push("--", docsUrl, ".");
      git(docsDirectory, args, "clone docs", knownUrls);
    } catch (error) {
      // This exact directory was created by this invocation and has no valid
      // recovery record, so removing the partial clone cannot touch user data.
      assertDirectoryOrAbsent(docsDirectory, "本次创建的文档目录");
      if (fs.existsSync(docsDirectory)) {
        if (!samePath(fs.realpathSync(docsDirectory), path.join(directory, "project-docs"))) {
          throw cloneError("CLONE_PATH_CONFLICT", "cleanup docs", "失败目录已改变，保留现场而不递归清理");
        }
        fs.rmSync(docsDirectory, { recursive: true, force: true });
      }
      throw error;
    }
    assertNotLink(docsGitDirectory, "docs .git");
    assertManagedPaths(directory, false);
    assertRealGitDirectory(docsGitDirectory, "docs .git");
    assertRepositoryRoot(docsDirectory, knownUrls);
    assertOrigin(docsDirectory, docsUrl, knownUrls);
    const docsBranch = currentBranch(docsDirectory, knownUrls);
    if (requestedDocsBranch !== null && docsBranch !== requestedDocsBranch) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "clone docs", `实际文档分支 ${docsBranch} 与请求不一致`);
    }
    assertUpstream(docsDirectory, docsBranch, knownUrls);
    assertClean(docsDirectory, "文档仓", knownUrls);
    state = {
      schemaVersion: 1,
      signature: `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2)}`,
      directory,
      phase: "docs-cloned",
      docsUrl: canonicalRepositoryUrl(docsUrl),
      requestedDocsBranch,
      docsBranch,
      docsCommit: commitOf(docsDirectory, "HEAD", knownUrls),
      requestedHostUrl: hostOverride === null ? null : canonicalRepositoryUrl(hostOverride),
      requestedHostBranch,
      hostUrl: null,
      hostBranch: null,
      hostGitCreated: false,
    };
    writeState(docsDirectory, state);
  } else {
    resumed = true;
    if (!entries.includes("project-docs")) {
      throw cloneError("CLONE_DIRECTORY_NOT_EMPTY", "validate", `目标目录非空：${directory}`);
    }
    assertNotLink(docsGitDirectory, "docs .git");
    assertManagedPaths(directory, false);
    assertRealGitDirectory(docsGitDirectory, "docs .git");
    state = readState(docsDirectory);
    if (!samePath(state.directory, directory)) {
      throw cloneError("CLONE_STATE_INVALID", "resume", `恢复记录属于其它目录：${state.directory}`);
    }
    if (
      state.docsUrl !== canonicalRepositoryUrl(docsUrl) ||
      state.requestedDocsBranch !== requestedDocsBranch ||
      state.requestedHostUrl !== (hostOverride === null ? null : canonicalRepositoryUrl(hostOverride)) ||
      state.requestedHostBranch !== requestedHostBranch
    ) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", "本次参数与恢复记录不一致");
    }
    assertRepositoryRoot(docsDirectory, knownUrls);
    assertOrigin(docsDirectory, docsUrl, knownUrls);
    if (currentBranch(docsDirectory, knownUrls) !== state.docsBranch || commitOf(docsDirectory, "HEAD", knownUrls) !== state.docsCommit) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", "文档仓分支或提交已变化");
    }
    assertUpstream(docsDirectory, state.docsBranch, knownUrls);
    assertClean(docsDirectory, "文档仓", knownUrls);
    if (!phaseAtLeast(state, "host-checked-out")) {
      assertPreCheckoutRootContents(directory, state.hostGitCreated);
    }
  }

  reportProgress("read", "started");
  let repositories;
  try {
    repositories = readRepositories(directory).repositories;
  } catch (error) {
    reportProgress("read", "failed");
    // Preserve repository-config's stable REPOSITORIES_* code.
    throw error;
  }
  reportProgress("read", "completed");
  if (repositories.docs.branch !== undefined && repositories.docs.branch !== state.docsBranch) {
    warnings.push(
      `共享配置记录的文档分支 ${repositories.docs.branch} 与本次实际文档分支 ${state.docsBranch} 不同；本次未切换分支`,
    );
  }
  const hostUrl = hostOverride ?? repositories.host.url;
  const hostBranch = requestedHostBranch ?? repositories.host.branch ?? null;
  knownUrls.push(hostUrl);
  const canonicalHost = canonicalRepositoryUrl(hostUrl);
  const wasComplete = state.phase === "complete";
  if (state.hostUrl !== null && state.hostUrl !== canonicalHost) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", "代码仓地址与恢复记录不一致");
  }
  if (state.hostBranch !== null && hostBranch !== null && state.hostBranch !== hostBranch) {
    throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", "代码仓分支与恢复记录不一致");
  }
  if (!phaseAtLeast(state, "config-read")) {
    state.hostUrl = canonicalHost;
    state.hostBranch = hostBranch;
    state.phase = "config-read";
    writeState(docsDirectory, state);
  }

  if (!phaseAtLeast(state, "host-initialized")) {
    assertPreCheckoutRootContents(directory, state.hostGitCreated);
    if (fs.existsSync(hostGitDirectory) && !state.hostGitCreated) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "init host", `存在未获恢复记录授权的 .git：${hostGitDirectory}`);
    }
    if (!fs.existsSync(hostGitDirectory)) {
      git(directory, ["init"], "init host", knownUrls);
      state.hostGitCreated = true;
      writeState(docsDirectory, state);
    }
    assertRepositoryRoot(directory, knownUrls);
    try {
      const existingOrigin = git(directory, ["config", "--local", "--get-all", "remote.origin.url"], "inspect host origin", knownUrls, { allowFailure: true });
      if (existingOrigin.status === 0) {
        if (canonicalRepositoryUrl(originOf(directory, knownUrls)) !== canonicalHost) {
          throw cloneError("CLONE_REPOSITORY_MISMATCH", "init host", "既有 origin 与恢复记录不一致");
        }
      } else {
        git(directory, ["remote", "add", "origin", hostUrl], "add host origin", knownUrls);
      }
      appendInfoExclude(hostGitDirectory, "/project-docs/");
      appendInfoExclude(docsGitDirectory, "/.ait/");
      state.phase = "host-initialized";
      writeState(docsDirectory, state);
    } catch (error) {
      // Keep the newly created repository and recovery record for a safe retry.
      writeState(docsDirectory, state);
      throw error;
    }
  }

  assertManagedPaths(directory, true);
  assertRepositoryRoot(directory, knownUrls);
  assertOrigin(directory, hostUrl, knownUrls);
  if (resumed) assertClean(directory, "代码仓", knownUrls);
  if (!wasComplete) {
    appendInfoExclude(hostGitDirectory, "/project-docs/");
    appendInfoExclude(docsGitDirectory, "/.ait/");
  }

  let selectedHostBranch = state.hostBranch ?? hostBranch;
  if (!phaseAtLeast(state, "host-fetched")) {
    if (selectedHostBranch === null) selectedHostBranch = defaultRemoteBranch(directory, knownUrls);
    state.hostBranch = selectedHostBranch;
    writeState(docsDirectory, state);
    git(
      directory,
      ["fetch", "--no-recurse-submodules", "origin", "refs/heads/*:refs/remotes/origin/*", "--tags"],
      "fetch host",
      knownUrls,
    );
    commitOf(directory, `refs/remotes/origin/${selectedHostBranch}`, knownUrls);
    state.phase = "host-fetched";
    writeState(docsDirectory, state);
  }
  if (selectedHostBranch === null) {
    throw cloneError("CLONE_STATE_INVALID", "resume", "恢复记录缺少代码仓分支");
  }

  if (!phaseAtLeast(state, "host-checked-out")) {
    checkoutHostBranch(directory, selectedHostBranch, knownUrls);
    state.phase = "host-checked-out";
    writeState(docsDirectory, state);
  } else {
    if (currentBranch(directory, knownUrls) !== selectedHostBranch) {
      throw cloneError("CLONE_REPOSITORY_MISMATCH", "resume", "代码仓当前分支与恢复记录不一致");
    }
    assertUpstream(directory, selectedHostBranch, knownUrls);
  }

  reportProgress("git", "completed");
  reportProgress("persist", "started");

  assertManagedPaths(directory, true);
  assertLocalWrapper(docsDirectory, knownUrls);
  if (!wasComplete) ensureCloneSkeleton(directory);
  validateProject(directory);
  if (!wasComplete) refreshWrapper(directory);
  const checked = checkProject(directory);
  if (!checked.ok) {
    throw cloneError("CLONE_PROJECT_INVALID", "validate project", `项目检查未通过：${checked.missing.join(", ")}`);
  }
  assertClean(docsDirectory, "文档仓", knownUrls);
  assertClean(directory, "代码仓", knownUrls);

  if (!wasComplete) {
    state.phase = "complete";
    writeState(docsDirectory, state);
  }
  reportProgress("persist", "completed");
  const docsBranch = currentBranch(docsDirectory, knownUrls);
  const finalHostBranch = currentBranch(directory, knownUrls);
  return {
    directory,
    resumed,
    host: {
      path: directory,
      url: originOf(directory, knownUrls),
      branch: finalHostBranch,
      commit: commitOf(directory, "HEAD", knownUrls),
    },
    docs: {
      path: docsDirectory,
      url: originOf(docsDirectory, knownUrls),
      branch: docsBranch,
      commit: commitOf(docsDirectory, "HEAD", knownUrls),
    },
    wrapper: wrapperPath(directory),
    warnings,
  };
}
