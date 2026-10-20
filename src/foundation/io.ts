/**
 * [TDD]-atomic_io — 原子写（文本/字节）与项目内路径守卫、posix 相对路径工具。
 *
 * 全部持久化落盘的唯一通道：临时文件 + fsync + fs.renameSync 原子替换。
 * 不做任何内容解析（不知道写入的是 YAML 还是 markdown）。
 * 本模块 import 零副作用；一切 IO 只发生在函数调用内。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** 目标路径越出项目根时抛出。 */
export class PathOutsideProjectError extends Error {
  readonly code = "PATH_OUTSIDE_PROJECT";

  constructor(projectRoot: string, target: string) {
    super(
      `Path outside project: root=${projectRoot} target=${target} resolves outside the project root`,
    );
    this.name = "PathOutsideProjectError";
  }
}

/**
 * 生成与目标同目录的临时文件路径：`.tmp-<pid>-<rand>`。
 * 同目录保证 rename 同卷；pid + 随机数保证并发写者临时名互不覆盖（单写者仍由调用方保证，最后 rename 者胜）。
 */
function tmpPathFor(target: string): string {
  const dir = path.dirname(target);
  const rand = crypto.randomBytes(8).toString("hex");
  return path.join(dir, `.tmp-${process.pid}-${rand}`);
}

/**
 * 原子落盘共用实现：同目录临时文件 → 写入并 fsync → renameSync 原子替换。
 *
 * rename 与临时文件同目录，故必然同卷，renameSync 为原子替换，不存在跨卷 EXDEV 情形（同卷前提）。
 * 目标目录不存在时 openSync 抛原始 ENOENT——不静默建目录（目录创建是调用方显式决策）。
 * 写入/同步/重命名任一步异常：尽力删除临时文件后重抛原始错误。
 */
function writeAtomic(target: string, data: Buffer | Uint8Array): void {
  const tmp = tmpPathFor(target);
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err;
  }
}

/**
 * 原子写文本：先把 `\r\n` 归一为 `\n`（杜绝平台换行转换使内容哈希与落盘字节不一致），
 * 再以 utf-8 编码落盘。
 */
export function atomicWriteText(target: string, content: string): void {
  const normalized = content.replace(/\r\n/g, "\n");
  writeAtomic(target, Buffer.from(normalized, "utf-8"));
}

/** 原子写字节。 */
export function atomicWriteBytes(target: string, data: Buffer | Uint8Array): void {
  writeAtomic(target, data);
}

/**
 * 路径越界守卫：`path.resolve(projectRoot, target)` 归一化后必须以归一化 root + 分隔符为前缀，
 * 否则抛 PathOutsideProjectError（消息含 root 与 target）；返回归一化绝对路径。
 */
export function ensureWithin(projectRoot: string, target: string): string {
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, target);
  if (!abs.startsWith(root + path.sep)) {
    throw new PathOutsideProjectError(projectRoot, target);
  }
  return abs;
}

/** 相对 root 的 posix 风格相对路径（`\` 全替换为 `/`）。 */
export function toPosixRel(root: string, p: string): string {
  return path.relative(root, p).replace(/\\/g, "/");
}

/** 去掉相对路径结尾的 `.md`（非 .md 结尾原样返回）。 */
export function stripMdExt(relPath: string): string {
  return relPath.endsWith(".md") ? relPath.slice(0, -".md".length) : relPath;
}
