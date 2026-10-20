import path from "node:path";
import fs from "node:fs";

const PROJECT_DOCS_DIR = "project-docs";

export interface ProjectRoot {
  cwd: string;
  root: string;
  docs: string;
  meta: string;
}

export type ProjectRootErrorCode =
  | "NOT_AT_PROJECT_ROOT"
  | "PROJECT_DOCS_MALFORMED"
  | "CWD_INSIDE_PROJECT_DOCS";

export class ProjectRootError extends Error {
  readonly code: ProjectRootErrorCode;

  constructor(code: ProjectRootErrorCode, message: string) {
    super(message);
    this.name = "ProjectRootError";
    this.code = code;
  }
}

function normalizeCwd(cwd: string): string {
  let resolved = path.resolve(cwd);
  const root = path.parse(resolved).root;
  while (resolved.length > root.length && /[\\/]$/.test(resolved)) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

function isInsideProjectDocs(cwd: string): boolean {
  return cwd.split(path.sep).includes(PROJECT_DOCS_DIR);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasLegalSkeleton(root: string): boolean {
  return (
    isDirectory(path.join(root, "docs")) &&
    isDirectory(path.join(root, ".meta"))
  );
}

export function resolveProjectRoot(cwd: string = process.cwd()): ProjectRoot {
  const normalizedCwd = normalizeCwd(cwd);

  if (isInsideProjectDocs(normalizedCwd)) {
    throw new ProjectRootError(
      "CWD_INSIDE_PROJECT_DOCS",
      `当前工作目录位于 ${PROJECT_DOCS_DIR} 内部：${normalizedCwd}`,
    );
  }

  const root = path.join(normalizedCwd, PROJECT_DOCS_DIR);
  if (!isDirectory(root)) {
    throw new ProjectRootError(
      "NOT_AT_PROJECT_ROOT",
      `当前目录下不存在 ${PROJECT_DOCS_DIR}/ 目录：${normalizedCwd}`,
    );
  }

  if (!hasLegalSkeleton(root)) {
    throw new ProjectRootError(
      "PROJECT_DOCS_MALFORMED",
      `${PROJECT_DOCS_DIR} 骨架非法：docs/ 或 .meta/ 缺失或不是目录（${root}）`,
    );
  }

  return {
    cwd: normalizedCwd,
    root,
    docs: path.join(root, "docs"),
    meta: path.join(root, ".meta"),
  };
}
