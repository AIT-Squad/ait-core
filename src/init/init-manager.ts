/**
 * [TDD]-init_manager — 项目初始化：骨架、空基线引导、docs 独立 git 仓、
 * 首个 PRD/FSD 根文档与 derives 边、幂等重跑。
 *
 * 白板入口之一（不要求先有项目根；clone 为另一入口，故自建 ProjectRoot
 * 而非 resolveProjectRoot）；全程幂等：已存在内容字节不动、记入 skipped。
 * 原子写委托 foundation，基线索引重建委托 indexing，PRD 根→FSD 根
 * derives 边以显式边建立（`metadata.source: new-model-cli`），不依赖
 * 文档结构推断。持久化形态为 Python 当前形态：空基线索引无 stats、
 * 空图 specs 为空数组。另写项目本地 wrapper 转发到当前 ait-core bin，
 * 且**按当前平台只写对应形态**（Windows `.ait/ait-cli.cmd`，POSIX
 * `.ait/ait-cli`，不跨平台预写另一形态，与 Python 版一致）：`--refresh-wrapper`
 * 强制重写本平台 wrapper，`--check` 只校验本平台 wrapper（另一平台缺失
 * 不构成未就绪）。本文件不做版本语义（归 versioning 域），
 * 不写宿主仓代码（宿主 .gitignore 追加除外，规格授权）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicWriteBytes, atomicWriteText, toPosixRel } from "../foundation/io.js";
import { dumpModel, loadYaml } from "../foundation/yaml.js";
import type { ProjectRoot } from "../foundation/root.js";
import type { BaselineIndex, SpecGraph } from "../doc-model/schemas.js";
import { IndexManager } from "../indexing/index-manager.js";
import { SpecGraphStore } from "../specgraph/graph-model.js";

export interface InitResult {
  createdFiles: string[];
  chunks: number;
  specs: number;
  status: "fresh" | "existing";
  files: Record<string, string>;
  skipped: string[];
}

export interface InitOpts {
  name?: string;
  refreshWrapper?: boolean;
  check?: boolean;
}

/** bin 路径解析失败的稳定错误码（不写占位 wrapper 冒充成功）。 */
export class WrapperPathUnresolvedError extends Error {
  readonly code = "WRAPPER_PATH_UNRESOLVED" as const;

  constructor(reason: string) {
    super(`无法解析 ait-core bin 路径（WRAPPER_PATH_UNRESOLVED）：${reason}`);
    this.name = "WrapperPathUnresolvedError";
  }
}

/** project-docs 内两种 wrapper 形态的绝对路径（实际只使用本平台那一个）。 */
function wrapperPaths(cwd: string): { cmd: string; sh: string } {
  const dir = path.join(path.resolve(cwd), "project-docs", ".ait");
  return {
    cmd: path.join(dir, "ait-cli.cmd"),
    sh: path.join(dir, "ait-cli"),
  };
}

/** 本平台是否为 Windows（决定写/校验哪一种 wrapper 形态）。 */
function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * 本平台对应的 wrapper 绝对路径：Windows 取 `.cmd`，POSIX 取无扩展名脚本。
 * 另一平台形态既不写入也不参与就绪校验。
 */
function platformWrapperPath(cwd: string): string {
  const paths = wrapperPaths(cwd);
  return isWindows() ? paths.cmd : paths.sh;
}

/** 从 startDir 逐级上溯，返回第一个含 package.json 的目录。 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** 读 package.json 的 bin 字段，解析为绝对路径（字符串或 {ait: ...} 形态）。 */
function binFromPackage(pkgDir: string): string | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
  const bin = (pkg as { bin?: unknown } | null)?.bin;
  const rel =
    typeof bin === "string"
      ? bin
      : bin !== null && typeof bin === "object" && typeof (bin as Record<string, unknown>).ait === "string"
        ? ((bin as Record<string, unknown>).ait as string)
        : null;
  return rel === null ? null : path.resolve(pkgDir, rel);
}

/**
 * 解析 ait-core bin 路径：当前可执行入口所在包的 bin（dist/src/init →
 * 上溯到 ait-core/package.json 的 bin.ait），其次 `.meta/config.yaml`
 * 的 `cliPath`/`cli_path`。两者皆无 → WrapperPathUnresolvedError。
 */
function resolveCliBin(cwd: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const modulePkg = findPackageRoot(moduleDir);
  if (modulePkg !== null) {
    const fromPkg = binFromPackage(modulePkg);
    if (fromPkg !== null) {
      return fromPkg;
    }
  }

  const configFile = path.join(path.resolve(cwd), "project-docs", ".meta", "config.yaml");
  if (fs.existsSync(configFile)) {
    let raw: unknown = null;
    try {
      raw = loadYaml(configFile);
    } catch {
      // 配置损坏不在此处降级表态：继续走 WRAPPER_PATH_UNRESOLVED
      raw = null;
    }
    if (raw !== null && typeof raw === "object") {
      const cfg = raw as Record<string, unknown>;
      for (const key of ["cliPath", "cli_path"]) {
        const value = cfg[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return path.resolve(path.resolve(cwd), value);
        }
      }
    }
  }

  throw new WrapperPathUnresolvedError(
    `当前模块所在包无 bin 字段，且 ${toPosixRel(path.resolve(cwd), configFile)} 未记录 cliPath`,
  );
}

/** POSIX wrapper 内容：显式 exec 当前 Node 与 bin，两个路径分别按 shell 字面引用。 */
function posixWrapperContent(bin: string): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  return `#!/bin/sh\n# ait-core 项目本地 wrapper（由 ait init 生成，--refresh-wrapper 可重写）\nexec ${quote(process.execPath)} ${quote(bin)} "$@"\n`;
}

/** Windows wrapper 内容：显式调用 Node，保留参数、工作目录与真实退出码。 */
function cmdWrapperContent(bin: string): string {
  const quote = (value: string): string => `"${value.replace(/%/g, "%%")}"`;
  const lines = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    "chcp 65001 >nul",
    "rem ait-core project-local wrapper (generated by ait init; --refresh-wrapper rewrites)",
    `${quote(process.execPath)} ${quote(bin)} %*`,
    "exit /b %errorlevel%",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * wrapperTargets：**本平台** wrapper 的目标路径与内容（bin 解析失败的异常
 * 在此上抛）。init 与 --refresh-wrapper 共用，保证两条路径写出的字节一致。
 * Windows 只产出 `.cmd`，POSIX 只产出可执行 sh 脚本——不跨平台预写另一形态。
 */
function wrapperTargets(cwd: string): { abs: string; content: string; mode?: number }[] {
  const bin = resolveCliBin(path.resolve(cwd));
  const paths = wrapperPaths(cwd);
  if (isWindows()) {
    return [{ abs: paths.cmd, content: cmdWrapperContent(bin) }];
  }
  return [{ abs: paths.sh, content: posixWrapperContent(bin), mode: 0o755 }];
}

/** 内容一致判定：换行归一后逐字节比较（wrapper 跳过的幂等依据）。 */
function sameContent(abs: string, content: string): boolean {
  try {
    const existing = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");
    return existing === content.replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
}

export function initProject(cwd: string, opts?: InitOpts): InitResult {
  const hostCwd = path.resolve(cwd);

  // --check：只读校验，零写入（不得先建骨架再检查）。
  // 返回 InitResult 形状以维持单命令信封稳定；missing 逐项记入 skipped。
  if (opts?.check === true) {
    const { ok, missing } = checkProject(hostCwd);
    let chunks = 0;
    let specs = 0;
    const indexFile = path.join(hostCwd, "project-docs", ".meta", "chunks-index.yaml");
    const graphFile = path.join(hostCwd, "project-docs", ".meta", "specgraph.yaml");
    if (ok && fs.existsSync(indexFile) && fs.existsSync(graphFile)) {
      const probe: ProjectRoot = {
        cwd: hostCwd,
        root: path.join(hostCwd, "project-docs"),
        docs: path.join(hostCwd, "project-docs", "docs"),
        meta: path.join(hostCwd, "project-docs", ".meta"),
      };
      chunks = new IndexManager(probe).loadBaseline().chunks.length;
      specs = new SpecGraphStore(probe).load().specs.length;
    }
    return {
      createdFiles: [],
      chunks,
      specs,
      status: "existing",
      files: {},
      skipped: missing.map((m) => `check: ${m}`),
    };
  }

  const root: ProjectRoot = {
    cwd: hostCwd,
    root: path.join(hostCwd, "project-docs"),
    docs: path.join(hostCwd, "project-docs", "docs"),
    meta: path.join(hostCwd, "project-docs", ".meta"),
  };
  const rel = (p: string): string => toPosixRel(hostCwd, p);

  const status: InitResult["status"] = fs.existsSync(root.root)
    ? "existing"
    : "fresh";
  const createdFiles: string[] = [];
  const skipped: string[] = [];
  const files: Record<string, string> = {};

  /** 幂等写：已存在记 skipped 且字节不动；否则原子写并记 created/files。 */
  const writeOnce = (abs: string, content: string): boolean => {
    if (fs.existsSync(abs)) {
      skipped.push(rel(abs));
      return false;
    }
    atomicWriteText(abs, content);
    createdFiles.push(rel(abs));
    files[rel(abs)] = content.replace(/\r\n/g, "\n");
    return true;
  };

  /**
   * writeProjectWrapper：只写**本平台**形态的 wrapper（Windows
   * `project-docs/.ait/ait-cli.cmd`，POSIX `.ait/ait-cli`），不跨平台预写
   * 另一形态。已存在且内容一致则跳过并计入 skipped；force=true
   * （--refresh-wrapper）无条件重写。bin 无法解析时 resolveCliBin 抛
   * WRAPPER_PATH_UNRESOLVED，不落任何占位成功文件。
   */
  const writeProjectWrapper = (force: boolean): void => {
    // 原子写不隐式建目录：.ait/ 由本函数显式创建（幂等）
    fs.mkdirSync(path.dirname(wrapperPaths(hostCwd).cmd), { recursive: true });
    for (const target of wrapperTargets(hostCwd)) {
      if (!force && sameContent(target.abs, target.content)) {
        skipped.push(rel(target.abs));
        continue;
      }
      atomicWriteBytes(target.abs, Buffer.from(target.content, "utf-8"));
      if (target.mode !== undefined) {
        try {
          fs.chmodSync(target.abs, target.mode);
        } catch {
          // chmod 失败不掩盖已落盘事实（Windows 无 POSIX 权限位语义）
        }
      }
      createdFiles.push(rel(target.abs));
      files[rel(target.abs)] = target.content.replace(/\r\n/g, "\n");
    }
  };

  /** ensureSkeleton：建 project-docs/{docs/{prd,fsd,tdd}, .meta/{versions}}（已存在跳过）。 */
  const ensureSkeleton = (): void => {
    for (const dir of [
      root.docs,
      path.join(root.docs, "prd"),
      path.join(root.docs, "fsd"),
      path.join(root.docs, "tdd"),
      root.meta,
      path.join(root.meta, "versions"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  };

  const indexFile = path.join(root.meta, "chunks-index.yaml");
  const graphFile = path.join(root.meta, "specgraph.yaml");

  /**
   * bootstrapEmptyBaseline：空索引（chunks: []，Python 当前形态无 stats）
   * 与空图（specs: []，数组而非对象）经原子写落盘。
   */
  const bootstrapEmptyBaseline = (): { index: boolean; graph: boolean } => {
    const emptyIndex: BaselineIndex = {
      version: 1,
      scope: "global",
      updated: new Date().toISOString(),
      chunks: [],
    };
    const emptyGraph: SpecGraph = {
      version: 1,
      updated: new Date().toISOString(),
      specs: [],
      edges: [],
    };
    return {
      index: writeOnce(indexFile, dumpModel(emptyIndex)),
      graph: writeOnce(graphFile, dumpModel(emptyGraph)),
    };
  };

  const gitOrThrow = (args: string[], what: string): void => {
    try {
      execFileSync("git", args, {
        cwd: root.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // git init/commit 失败：错误上抛（含 stderr），不静默降级为无仓状态
      const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
      const detail =
        stderr === undefined ? String(err) : String(stderr).trim();
      throw new Error(`docs 仓 ${what} 失败：${detail}`, { cause: err });
    }
  };

  /**
   * initDocsRepo：docs 仓 git init + 基线提交；仓内 .gitignore 隔离
   * 版本状态文件、快照/宿主状态/机器特定配置字段。
   */
  const initDocsRepo = (): void => {
    writeOnce(
      path.join(root.root, ".gitignore"),
      "versions/*/state.md\n.meta/snapshots/\n.ait/\n.meta/config.local.yaml\n",
    );
    if (fs.existsSync(path.join(root.root, ".git"))) {
      skipped.push(rel(path.join(root.root, ".git")));
      return;
    }
    gitOrThrow(["init"], "git init");
    gitOrThrow(["add", "-A"], "git add");
    // 白板入口不依赖宿主全局 git 身份配置：基线提交使用仓内临时身份
    gitOrThrow(
      [
        "-c",
        "user.name=ait",
        "-c",
        "user.email=ait@localhost",
        "commit",
        "-m",
        "initial baseline",
      ],
      "git commit",
    );
  };

  /** writeRootDocs：首个 PRD/FSD 根骨架（含 @id 根 chunk）。 */
  const writeRootDocs = (
    name: string,
  ): { wrote: boolean; prdId: string; fsdId: string } => {
    const prdId = `[PRD]-${name}`;
    const fsdId = `[FSD]-${name}`;
    const prd = writeOnce(
      path.join(root.docs, "prd", `${prdId}.md`),
      `<!-- @id:${prdId} -->\n## ${name} 产品 PRD\n\n（根骨架：产品需求待补。）\n`,
    );
    const fsd = writeOnce(
      path.join(root.docs, "fsd", `${fsdId}.md`),
      `<!-- @id:${fsdId} -->\n## ${name} 功能分解根\n\n（根骨架：功能分解待补。）\n`,
    );
    return { wrote: prd || fsd, prdId, fsdId };
  };

  /**
   * refreshBaseline：本次新写了根文档或空基线时执行——重建基线索引 →
   * specgraph.sync → 两根节点存在且尚无该 derives 边时，以显式边
   * `{src: PRD 根 uri, dst: FSD 根 uri, rel: "derives", weight: 1,
   * metadata: {source: "new-model-cli"}}` 建边并写回。这一切已存在时
   * 不调用（既有字节不动）。
   */
  const refreshBaseline = (
    prdId: string,
    fsdId: string,
  ): { chunks: number; specs: number } => {
    const index = new IndexManager(root).rebuildBaseline();
    const store = new SpecGraphStore(root);
    let graph = store.sync();

    const uriOf = (id: string): string | undefined =>
      graph.specs.find((s) => s.chunk_id === id)?.uri;
    const prdUri = uriOf(prdId);
    const fsdUri = uriOf(fsdId);
    const hasEdge =
      prdUri !== undefined &&
      fsdUri !== undefined &&
      graph.edges.some(
        (e) => e.rel === "derives" && e.src === prdUri && e.dst === fsdUri,
      );
    if (prdUri !== undefined && fsdUri !== undefined && !hasEdge) {
      // 显式边出生（new-model-cli 属显式来源集合，跨 sync 存活）；
      // addEdge 对重复边抛 DUPLICATE_EDGE，故先判存在再建。
      store.addEdge("baseline", prdId, fsdId, "derives", "new-model-cli");
      graph = store.load();
    }

    files[rel(indexFile)] = dumpModel(index);
    files[rel(graphFile)] = dumpModel(graph);
    return { chunks: index.chunks.length, specs: graph.specs.length };
  };

  /** writeGitignores：宿主为 git 仓时追加 project-docs/ 到宿主 .gitignore（非 git 仓跳过并标注）。 */
  const writeGitignores = (): void => {
    const entry = "project-docs/";
    if (!fs.existsSync(path.join(hostCwd, ".git"))) {
      skipped.push(".gitignore (宿主非 git 仓，跳过追加 project-docs/)");
      return;
    }
    const hostIgnore = path.join(hostCwd, ".gitignore");
    if (!fs.existsSync(hostIgnore)) {
      writeOnce(hostIgnore, `${entry}\n`);
      return;
    }
    const existing = fs.readFileSync(hostIgnore, "utf-8");
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) {
      skipped.push(rel(hostIgnore));
      return;
    }
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const next = `${existing}${sep}${entry}\n`;
    atomicWriteText(hostIgnore, next);
    files[rel(hostIgnore)] = next.replace(/\r\n/g, "\n");
  };

  /** deriveName：name 未提供时以目录名派生；非法字符归一为合法 chunk id 片段。 */
  const deriveName = (dir: string, provided?: string): string => {
    const raw =
      provided !== undefined && provided.trim().length > 0
        ? provided
        : path.basename(dir);
    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    return normalized.length > 0 ? normalized : "project";
  };

  ensureSkeleton();
  const bootstrapped = bootstrapEmptyBaseline();
  initDocsRepo();
  const { wrote, prdId, fsdId } = writeRootDocs(deriveName(hostCwd, opts?.name));
  writeGitignores();
  writeProjectWrapper(opts?.refreshWrapper === true);

  let chunks: number;
  let specs: number;
  if (wrote || bootstrapped.index || bootstrapped.graph) {
    ({ chunks, specs } = refreshBaseline(prdId, fsdId));
  } else {
    // 幂等重跑：一切已存在，不落盘，返回现状摘要
    chunks = new IndexManager(root).loadBaseline().chunks.length;
    specs = new SpecGraphStore(root).load().specs.length;
  }

  return { createdFiles, chunks, specs, status, files, skipped };
}

/**
 * checkProject（--check）：只读校验骨架目录、基线索引/图、根文档与本平台
 * wrapper 是否齐备，返回 {ok, missing}；另一平台 wrapper 不计入 missing。
 * 零写入（不做 mkdir、不写任何文件）。
 */
export function checkProject(cwd: string): { ok: boolean; missing: string[] } {
  const hostCwd = path.resolve(cwd);
  const root = path.join(hostCwd, "project-docs");
  const docs = path.join(root, "docs");
  const meta = path.join(root, ".meta");
  const missing: string[] = [];
  const rel = (p: string): string => toPosixRel(hostCwd, p);

  for (const dir of [
    root,
    docs,
    path.join(docs, "prd"),
    path.join(docs, "fsd"),
    path.join(docs, "tdd"),
    meta,
    path.join(meta, "versions"),
  ]) {
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      missing.push(rel(dir));
    }
  }

  for (const file of [
    path.join(meta, "chunks-index.yaml"),
    path.join(meta, "specgraph.yaml"),
  ]) {
    if (!fs.existsSync(file)) {
      missing.push(rel(file));
    }
  }

  /** 根文档按层目录扫描：存在任一 <layer>-*.md 即视为就位（name 未知时也可校验）。 */
  const hasRootDoc = (dir: string, prefix: string): boolean => {
    try {
      return fs
        .readdirSync(dir)
        .some((name) => name.startsWith(prefix) && name.endsWith(".md"));
    } catch {
      return false;
    }
  };
  if (!hasRootDoc(path.join(docs, "prd"), "[PRD]-")) {
    missing.push(toPosixRel(hostCwd, path.join(docs, "prd", "[PRD]-<name>.md")));
  }
  if (!hasRootDoc(path.join(docs, "fsd"), "[FSD]-")) {
    missing.push(toPosixRel(hostCwd, path.join(docs, "fsd", "[FSD]-<name>.md")));
  }

  // 只校验本平台形态：Windows 断 `.cmd`，POSIX 断无扩展名脚本。
  // 另一平台 wrapper 缺失不构成未就绪（Python 版同样按平台只写一个）。
  const wrapperFile = platformWrapperPath(hostCwd);
  const isUsableFile = (file: string, executable: boolean): boolean => {
    try {
      if (!fs.statSync(file).isFile()) {
        return false;
      }
      fs.accessSync(
        file,
        fs.constants.R_OK | (executable && !isWindows() ? fs.constants.X_OK : 0),
      );
      return true;
    } catch {
      return false;
    }
  };

  let wrapperReady = isUsableFile(wrapperFile, true);
  try {
    const bin = resolveCliBin(hostCwd);
    const expected = isWindows() ? cmdWrapperContent(bin) : posixWrapperContent(bin);
    if (wrapperReady && !sameContent(wrapperFile, expected)) {
      wrapperReady = false;
    }
    for (const [file, executable] of [
      [process.execPath, true],
      [bin, false],
    ] as const) {
      if (!isUsableFile(file, executable)) {
        missing.push(rel(file));
        wrapperReady = false;
      }
    }
  } catch (err) {
    if (!(err instanceof WrapperPathUnresolvedError)) {
      throw err;
    }
    missing.push(err.message);
    wrapperReady = false;
  }
  if (!wrapperReady) {
    missing.push(rel(wrapperFile));
  }

  return { ok: missing.length === 0, missing };
}

/**
 * refreshWrapper（--refresh-wrapper）：强制重写**本平台** wrapper 文件，
 * 其余初始化产物不动。返回结构同 initProject；bin 无法解析时抛
 * WRAPPER_PATH_UNRESOLVED。
 */
export function refreshWrapper(cwd: string): InitResult {
  const hostCwd = path.resolve(cwd);
  const root = path.join(hostCwd, "project-docs");
  const meta = path.join(root, ".meta");
  const rel = (p: string): string => toPosixRel(hostCwd, p);

  if (!fs.existsSync(root)) {
    // 白板未初始化：没有任何既有产物可刷新，先建骨架再写 wrapper
    return initProject(hostCwd, { refreshWrapper: true });
  }

  const files: Record<string, string> = {};
  const createdFiles: string[] = [];
  fs.mkdirSync(path.dirname(wrapperPaths(hostCwd).cmd), { recursive: true });
  for (const target of wrapperTargets(hostCwd)) {
    atomicWriteBytes(target.abs, Buffer.from(target.content, "utf-8"));
    if (target.mode !== undefined) {
      try {
        fs.chmodSync(target.abs, target.mode);
      } catch {
        // chmod 失败不掩盖已落盘事实
      }
    }
    createdFiles.push(rel(target.abs));
    files[rel(target.abs)] = target.content.replace(/\r\n/g, "\n");
  }

  const indexFile = path.join(meta, "chunks-index.yaml");
  const graphFile = path.join(meta, "specgraph.yaml");
  let chunks = 0;
  let specs = 0;
  if (fs.existsSync(indexFile) && fs.existsSync(graphFile)) {
    const projectRoot: ProjectRoot = {
      cwd: hostCwd,
      root,
      docs: path.join(root, "docs"),
      meta,
    };
    chunks = new IndexManager(projectRoot).loadBaseline().chunks.length;
    specs = new SpecGraphStore(projectRoot).load().specs.length;
  }

  return {
    createdFiles,
    chunks,
    specs,
    status: "existing",
    files,
    skipped: [],
  };
}
