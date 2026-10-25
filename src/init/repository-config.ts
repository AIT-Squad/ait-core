/**
 * [TDD]-repository_config - shared host/docs repository metadata.
 *
 * Importing this module performs no IO. Reads and writes are explicit, reject
 * linked metadata paths, and writes use the foundation atomic-write primitive.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { atomicWriteText } from "../foundation/io.js";
import { dumpModel, loadYaml } from "../foundation/yaml.js";

export interface RepositoryReference {
  url: string;
  branch?: string;
}

export interface RepositoriesConfig {
  schema_version: 1;
  host: RepositoryReference;
  docs: RepositoryReference & { path: "project-docs" };
}

export interface SetRepositoriesInput {
  hostUrl: string;
  docsUrl: string;
  hostBranch?: string;
  docsBranch?: string;
}

export interface RepositoriesResult {
  path: string;
  repositories: RepositoriesConfig;
}

type RepositoriesErrorCode = "REPOSITORIES_NOT_FOUND" | "REPOSITORIES_INVALID";

class RepositoriesError extends Error {
  readonly code: RepositoriesErrorCode;

  constructor(code: RepositoriesErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepositoriesError";
    this.code = code;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
function invalid(message: string, cause?: unknown): RepositoriesError {
  return new RepositoriesError(
    "REPOSITORIES_INVALID",
    `仓库配置非法：${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function localAbsolutePath(value: string): string | undefined {
  if (path.isAbsolute(value)) return path.resolve(value);
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value);
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value);
  return undefined;
}

function fileUrlPath(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalid("file URL 无法解析", error);
  }
  if (parsed.protocol !== "file:") throw invalid("仅支持 file URL");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw invalid("file URL 不得包含凭据、查询参数或片段");
  }
  try {
    return fileURLToPath(parsed);
  } catch (error) {
    throw invalid("file URL 路径非法", error);
  }
}

/** Validate a clone-safe repository reference while preserving its spelling. */
export function validateRepositoryUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid("仓库地址必须是非空字符串");
  if (value.trim() !== value) throw invalid("仓库地址不得包含首尾空白");
  if (CONTROL.test(value)) throw invalid("仓库地址不得包含控制字符");
  if (value.startsWith("-")) throw invalid("仓库地址不得以 '-' 开头");
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) throw invalid("不支持 Git external remote helper 地址");

  if (localAbsolutePath(value) !== undefined) return value;
  if (/^[A-Za-z]:[^\\/]/.test(value)) throw invalid("不允许 Windows 盘符相对路径");
  if (/^file:/i.test(value)) {
    fileUrlPath(value);
    return value;
  }

  if (/^https:/i.test(value) || /^ssh:/i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw invalid("仓库 URL 无法解析", error);
    }
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "ssh:") throw invalid("仅支持 https、ssh、scp、file 或绝对本地路径");
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") throw invalid("仓库 URL 缺少主机或仓库路径");
    if (parsed.password || (protocol === "https:" && parsed.username)) throw invalid("仓库 URL 不得包含凭据");
    if (parsed.search || parsed.hash) throw invalid("仓库 URL 不得包含查询参数或片段");
    return value;
  }

  // SCP-like syntax: [user@]host:path. Deliberately require a non-empty
  // host/path and exclude slash-prefixed relative-path lookalikes.
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([^/:\s]+):(.+)$/.exec(value);
  if (scp !== null && scp[2] !== undefined && scp[3] !== undefined && !scp[3].startsWith("//")) {
    if (scp[3].startsWith("-") || CONTROL.test(scp[3])) throw invalid("scp 仓库路径非法");
    return value;
  }

  throw invalid("仅支持 https、ssh、scp、file URL 或绝对本地路径；相对路径不允许");
}

/** Validate a branch name before it can be passed to Git as an argument. */
export function validateBranchName(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid("分支名必须是非空字符串");
  if (value.trim() !== value || /\s/.test(value) || CONTROL.test(value)) throw invalid("分支名不得包含空白或控制字符");
  if (value.startsWith("-") || value.startsWith("@{-")) throw invalid("分支名不得被 Git 解释为选项或历史表达式");
  if (
    value === "@" || value === "HEAD" || value.startsWith("/") || value.endsWith("/") ||
    value.endsWith(".") || value.includes("..") || value.includes("@{") || value.includes("//") ||
    /[~^:?*\[\\]/.test(value)
  ) {
    throw invalid("分支名不符合 Git ref 规则");
  }
  for (const component of value.split("/")) {
    if (component.length === 0 || component.startsWith(".") || component.endsWith(".lock")) {
      throw invalid("分支名不符合 Git ref 规则");
    }
  }
  return value;
}

/** Canonical comparison form; the original value is always retained in config. */
export function canonicalRepositoryUrl(value: string): string {
  const valid = validateRepositoryUrl(value);
  let local = localAbsolutePath(valid);
  if (/^file:/i.test(valid)) local = fileUrlPath(valid);
  if (local !== undefined) {
    let absolute = path.resolve(local);
    if (process.platform === "win32") absolute = absolute.toLowerCase();
    return pathToFileURL(absolute).href;
  }

  if (/^https:/i.test(valid) || /^ssh:/i.test(valid)) {
    const parsed = new URL(valid);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.href.replace(/\/$/, "");
  }

  const scp = /^(?:([A-Za-z0-9._-]+)@)?([^/:\s]+):(.+)$/.exec(valid)!;
  const user = scp[1] === undefined ? "" : `${scp[1]}@`;
  return `${user}${scp[2]!.toLowerCase()}:${scp[3]}`;
}

const repositoryReferenceSchema = z.object({
  url: z.string().transform(validateRepositoryUrl),
  branch: z.string().transform(validateBranchName).optional(),
}).strict();

const repositoriesSchema = z.object({
  schema_version: z.literal(1),
  host: repositoryReferenceSchema,
  docs: repositoryReferenceSchema.extend({ path: z.literal("project-docs") }).strict(),
}).strict();

function pathsFor(cwd: string): { docs: string; meta: string; file: string } {
  const root = path.resolve(cwd);
  const docs = path.join(root, "project-docs");
  const meta = path.join(docs, ".meta");
  return { docs, meta, file: path.join(meta, "repositories.yaml") };
}

function assertUnlinkedPaths(cwd: string, requireFile: boolean): string {
  const { docs, meta, file } = pathsFor(cwd);
  try {
    const docsStat = fs.lstatSync(docs);
    const metaStat = fs.lstatSync(meta);
    if (!docsStat.isDirectory() || docsStat.isSymbolicLink()) throw invalid(`project-docs 不是真实目录：${docs}`);
    if (!metaStat.isDirectory() || metaStat.isSymbolicLink()) throw invalid(`.meta 不是真实目录：${meta}`);

    const realDocs = fs.realpathSync(docs);
    const realMeta = fs.realpathSync(meta);
    if (path.dirname(realMeta) !== realDocs) throw invalid(`.meta 路径越界：${meta}`);

    try {
      const fileStat = fs.lstatSync(file);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw invalid(`repositories.yaml 不是普通文件：${file}`);
      const realFile = fs.realpathSync(file);
      if (path.dirname(realFile) !== realMeta) throw invalid(`repositories.yaml 路径越界：${file}`);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      if (requireFile) throw new RepositoriesError("REPOSITORIES_NOT_FOUND", `仓库配置不存在：${file}`);
    }
    return file;
  } catch (error) {
    if (error instanceof RepositoriesError) throw error;
    if (isEnoent(error)) throw invalid(`仓库配置目录不存在：${meta}`, error);
    throw invalid(`无法安全访问仓库配置路径：${file}`, error);
  }
}

function parseRepositories(file: string): RepositoriesConfig {
  let raw: unknown;
  try {
    raw = loadYaml(file);
    return repositoriesSchema.parse(raw) as RepositoriesConfig;
  } catch (error) {
    if (error instanceof RepositoriesError) throw error;
    // YAML/parser diagnostics can echo source snippets. Keep the public error
    // useful without reflecting rejected repository values or credentials.
    throw invalid(`${file} 内容无效`);
  }
}

export function readRepositories(cwd: string): RepositoriesResult {
  const file = assertUnlinkedPaths(cwd, true);
  return { path: file, repositories: parseRepositories(file) };
}

export function writeRepositories(cwd: string, input: SetRepositoriesInput): RepositoriesResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw invalid("写入参数必须是对象");
  const keys = Object.keys(input as object);
  const allowed = new Set(["hostUrl", "docsUrl", "hostBranch", "docsBranch"]);
  if (keys.some((key) => !allowed.has(key))) throw invalid("写入参数包含未知字段");

  // Construct and fully validate before any filesystem mutation.
  const candidate: RepositoriesConfig = {
    schema_version: 1,
    host: {
      url: validateRepositoryUrl(input.hostUrl),
      ...(input.hostBranch === undefined ? {} : { branch: validateBranchName(input.hostBranch) }),
    },
    docs: {
      url: validateRepositoryUrl(input.docsUrl),
      ...(input.docsBranch === undefined ? {} : { branch: validateBranchName(input.docsBranch) }),
      path: "project-docs",
    },
  };
  repositoriesSchema.parse(candidate);

  const file = assertUnlinkedPaths(cwd, false);
  try {
    atomicWriteText(file, dumpModel(candidate));
  } catch (error) {
    throw invalid(`无法写入 ${file}：${error instanceof Error ? error.message : String(error)}`, error);
  }
  return { path: file, repositories: candidate };
}
