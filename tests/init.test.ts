// [TDD]-init_tests — init 域制品（initProject）的集成验收。
// 覆盖 [FSD]-ait-core-init:TEST 第 1~4 条全部断言点：
//   1. 空目录 init 全就位（骨架/空基线/docs git 仓/首文档/derives 边）
//   2. 重跑幂等（既有内容字节不变，status=existing，skipped 记录已存在项）
//   3. .gitignore 规则齐备（宿主隔离 + docs 仓内快照/.ait/机器字段）
//   4. 宿主非 git 仓时 init 正常完成并标注跳过（不报错）
// 附白板推进冒烟：init 后无需手工建目录即可 version create→prd 写入→merge。
// 约束：每个用例在 os.tmpdir() 下从零 mkdtemp，用例间零共享；
// 文件内容断言经规范化读取（换行不敏感）。

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { CoreProgressEvent } from "../src/api/types.js";
import {
  initProject,
  refreshWrapper,
  checkProject,
} from "../src/init/init-manager.js";
import { resolveProjectRoot } from "../src/foundation/root.js";
import { loadYaml } from "../src/foundation/yaml.js";
import {
  BaselineIndexSchema,
  SpecGraphSchema,
} from "../src/doc-model/schemas.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import { SpecGraphStore } from "../src/specgraph/graph-model.js";
import { NewModelManager } from "../src/new-model/model-manager.js";
import { VersionManager } from "../src/versioning/version-manager.js";
import { versionMerge } from "../src/versioning/merge-engine.js";

let tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-init-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // 清理失败仅告警不 fail（Windows 文件锁容忍）。
      console.warn(`afterEach 清理失败（忽略）: ${dir}`, err);
    }
  }
  tmpDirs = [];
});

/** 规范化读取：CRLF→LF，换行不敏感。 */
function readNorm(p: string): string {
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
}

/** 毫秒级同步休眠（供 EBUSY 重试退避）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 在指定目录执行 git 并返回 stdout。
 * Windows 下 spawnSync 偶发 EBUSY（杀软/文件锁瞬时占用），做有限次退避重试。
 */
function gitAt(cwd: string, args: string[]): string {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      // stdin 必须 ignore：本环境下 stdin=pipe 的 spawn 会被拒（EBUSY）
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== "EBUSY") throw err;
      sleepSync(100 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** 递归快照 dir 下全部文件（排除 .git）的字节哈希，返回 rel→sha256。 */
function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (cur: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(dir, abs).split(path.sep).join("/");
        out.set(
          rel,
          createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
        );
      }
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// :TEST 第 1 条 — 空目录 init 全就位
// ---------------------------------------------------------------------------

describe("空目录 init", () => {
  it("骨架/空基线/docs git 仓/首文档/derives 边全部就位（:TEST 第 1 条）", () => {
    const base = mkTmp();
    const result = initProject(base, { name: "demo" });
    const root = resolveProjectRoot(base);

    // InitResult 契约：fresh、双根 chunk/spec、关键落盘文件入 createdFiles
    expect(result.status).toBe("fresh");
    expect(result.chunks).toBe(2);
    expect(result.specs).toBe(2);
    for (const rel of [
      "project-docs/.meta/chunks-index.yaml",
      "project-docs/.meta/specgraph.yaml",
      "project-docs/.gitignore",
      "project-docs/docs/prd/[PRD]-demo.md",
      "project-docs/docs/fsd/[FSD]-demo.md",
    ]) {
      expect(result.createdFiles).toContain(rel);
    }

    // 骨架目录齐备
    for (const dir of [
      root.docs,
      path.join(root.docs, "prd"),
      path.join(root.docs, "fsd"),
      path.join(root.docs, "tdd"),
      root.meta,
      path.join(root.meta, "versions"),
    ]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }

    // 空基线引导落盘并被基线提交捕获：HEAD 上索引为空（chunks: []）
    const headIndex = gitAt(root.root, [
      "show",
      "HEAD:.meta/chunks-index.yaml",
    ]);
    expect(headIndex).toMatch(/chunks:\s*\[\]/);

    // 基线刷新后：双根 chunk 入索引（committed），derives 边入图
    const index = new IndexManager(root).loadBaseline();
    expect(index.chunks.map((r) => r.id).sort()).toEqual([
      "[FSD]-demo",
      "[PRD]-demo",
    ]);
    // v0.5：基线索引无 stats（统计只在版本索引上），故此处只断言条目本身
    expect(index.chunks).toHaveLength(2);
    const graph = new SpecGraphStore(root).load();
    const derives = graph.edges.filter((e) => e.rel === "derives");
    expect(derives).toHaveLength(1);
    expect(derives[0]).toMatchObject({
      src: "spec:prd:baseline:[PRD]-demo",
      dst: "spec:fsd:baseline:[FSD]-demo",
      rel: "derives",
    });

    // 落盘的基线索引与关系图经 doc_model 域 schema 校验（Python 当前形态）
    const indexOnDisk = BaselineIndexSchema.parse(
      loadYaml(path.join(root.meta, "chunks-index.yaml")),
    );
    expect(indexOnDisk.chunks).toHaveLength(2);
    const graphOnDisk = SpecGraphSchema.parse(
      loadYaml(path.join(root.meta, "specgraph.yaml")),
    );
    // 图中 specs 为数组（不是 Python 早期形态的对象映射）
    expect(Array.isArray(graphOnDisk.specs)).toBe(true);
    expect(graphOnDisk.specs).toHaveLength(2);
    const diskDerives = graphOnDisk.edges.filter((e) => e.rel === "derives");
    expect(diskDerives).toHaveLength(1);
    expect(diskDerives[0]?.metadata?.["source"]).toBe("new-model-cli");

    // docs 仓独立 git：.git 存在且有基线提交
    expect(fs.statSync(path.join(root.root, ".git")).isDirectory()).toBe(
      true,
    );
    const log = gitAt(root.root, ["log", "--format=%s"]);
    expect(log).toContain("initial baseline");

    // 首个 PRD/FSD 根文档含 @id 根 chunk
    const prdText = readNorm(path.join(root.docs, "prd", "[PRD]-demo.md"));
    const fsdText = readNorm(path.join(root.docs, "fsd", "[FSD]-demo.md"));
    expect(prdText).toContain("<!-- @id:[PRD]-demo -->");
    expect(fsdText).toContain("<!-- @id:[FSD]-demo -->");
    // InitResult.files 记录规范化内容
    expect(result.files["project-docs/docs/prd/[PRD]-demo.md"]).toContain(
      "<!-- @id:[PRD]-demo -->",
    );
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 2 条 — 幂等重跑
// ---------------------------------------------------------------------------

describe("幂等重跑", () => {
  it("既有文件字节不变，status=existing，skipped 记录已存在项（:TEST 第 2 条）", () => {
    const base = mkTmp();
    const first = initProject(base, { name: "demo" });
    expect(first.status).toBe("fresh");

    const before = hashTree(path.join(base, "project-docs"));
    const second = initProject(base, { name: "demo" });
    const after = hashTree(path.join(base, "project-docs"));

    // 幂等：既有内容字节不变（哈希集合与逐项哈希全等）
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, hash] of before) {
      expect(after.get(rel), `字节已变：${rel}`).toBe(hash);
    }

    // 重跑返回现状摘要：status=existing、零新建、skipped 记录已存在项
    expect(second.status).toBe("existing");
    expect(second.createdFiles).toEqual([]);
    expect(second.skipped).toContain("project-docs/.meta/chunks-index.yaml");
    expect(second.skipped).toContain("project-docs/.meta/specgraph.yaml");
    expect(second.skipped).toContain(
      "project-docs/docs/prd/[PRD]-demo.md",
    );
    expect(second.skipped).toContain(
      "project-docs/docs/fsd/[FSD]-demo.md",
    );
    expect(second.chunks).toBe(2);
    expect(second.specs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 3 条 — gitignore 规则
// ---------------------------------------------------------------------------

describe("gitignore 规则", () => {
  it("宿主 .gitignore 含 project-docs/；docs 仓内忽略 snapshots/.ait/机器字段（:TEST 第 3 条）", () => {
    const base = mkTmp();
    // 宿主为 git 仓：触发宿主 .gitignore 追加
    gitAt(base, ["init"]);
    const result = initProject(base, { name: "demo" });
    const root = resolveProjectRoot(base);

    // 宿主隔离：project-docs/ 独立成行写入宿主 .gitignore
    const hostIgnore = readNorm(path.join(base, ".gitignore"));
    expect(hostIgnore.split("\n").map((l) => l.trim())).toContain(
      "project-docs/",
    );
    expect(result.files[".gitignore"]).toContain("project-docs/");

    // docs 仓内规则：快照 / .ait / 机器特定配置字段齐备
    const docsIgnore = readNorm(path.join(root.root, ".gitignore"));
    const lines = docsIgnore.split("\n").map((l) => l.trim());
    expect(lines).toContain(".meta/snapshots/");
    expect(lines).toContain(".ait/");
    expect(lines).toContain(".meta/config.local.yaml");
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 4 条 — 宿主非 git 仓
// ---------------------------------------------------------------------------

describe("宿主非 git 仓", () => {
  it("init 正常完成并标注宿主隔离跳过，不报错（:TEST 第 4 条）", () => {
    const base = mkTmp(); // 不做 git init：宿主非 git 仓

    const result = initProject(base, { name: "demo" });

    // 正常完成：fresh 且骨架落盘
    expect(result.status).toBe("fresh");
    expect(fs.existsSync(path.join(base, "project-docs", "docs"))).toBe(
      true,
    );
    // 标注跳过：skipped 记录宿主隔离跳过原因
    expect(
      result.skipped.some((s) => s.includes("宿主非 git 仓")),
    ).toBe(true);
    // init 只建立文档仓，不初始化宿主源码仓。
    expect(fs.existsSync(path.join(base, ".git"))).toBe(false);
    // 不创建宿主 .gitignore
    expect(fs.existsSync(path.join(base, ".gitignore"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 白板推进冒烟 — init 后无需手工建目录推进 version→prd→merge
// ---------------------------------------------------------------------------

describe("白板推进", () => {
  it("init 后直接 version create→简单 prd 写入→merge，全程无需手工建目录（冒烟级）", async () => {
    const base = mkTmp();
    initProject(base, { name: "demo" });
    const root = resolveProjectRoot(base);
    // merge 的 docs 仓提交使用纯 git commit：白板环境未必有全局身份，
    // 测试在 docs 仓内置仓级身份（不依赖、不污染全局配置）
    gitAt(root.root, ["config", "user.name", "ait-test"]);
    gitAt(root.root, ["config", "user.email", "ait-test@localhost"]);

    const vm = new VersionManager(root);
    const nm = new NewModelManager(root);

    // version create：唯一开放版本，空工作区自建
    expect(vm.versionCreate("v0.1").version).toBe("v0.1");

    // 简单 prd 需求写入（内容契约：用户故事 + 编号验收标准）
    const content = [
      "<!-- @id:[PRD]-demo:smoke -->",
      "## smoke 需求",
      "",
      "**用户故事:** 作为用户，我要冒烟验证白板推进。",
      "",
      "### 验收标准",
      "",
      "1. init 后无需手工建目录即可推进到 merge。",
      "",
    ].join("\n");
    const written = await nm.createDocument("prd", "[PRD]-demo:smoke", {
      content,
      skipContext: true,
    });
    expect(written.mode).toBe("written");

    // commit → confirm → merge：全链无需任何手工建目录
    expect(vm.versionCommit("v0.1").committed).toContain(
      "[PRD]-demo:smoke",
    );
    const confirmed = await vm.versionConfirm("v0.1");
    expect(confirmed.passed).toBe(true);
    const merged = await versionMerge(root, "v0.1");
    expect(merged.merged_chunks).toContain("[PRD]-demo:smoke");

    // 落盘事实：smoke chunk 已合入 baseline 文档与索引
    const mergedDoc = readNorm(
      path.join(root.docs, "prd", "[PRD]-demo.md"),
    );
    expect(mergedDoc).toContain("<!-- @id:[PRD]-demo:smoke -->");
    expect(
      new IndexManager(root)
        .loadBaseline()
        .chunks.map((r) => r.id),
    ).toContain("[PRD]-demo:smoke");
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 6 条 — 项目本地 wrapper
// ---------------------------------------------------------------------------

/** 仓库根（tests/ 的上一级）：独立解析 bin 目标，不复用被测实现的路径计算。 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** 独立解析 ait-core bin 绝对路径（读 package.json 的 bin.ait）。 */
function expectedBin(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { bin?: string | Record<string, string> };
  const bin = pkg.bin;
  const rel =
    typeof bin === "string" ? bin : (bin?.["ait"] as string | undefined);
  expect(rel, "package.json 缺少 bin.ait").toBeTruthy();
  return path.resolve(REPO_ROOT, rel as string);
}

/** project-docs/.ait 下的两种 wrapper 形态路径（实际只有本平台那一个落盘）。 */
function wrapperPathsOf(base: string): { cmd: string; sh: string } {
  const dir = path.join(base, "project-docs", ".ait");
  return { cmd: path.join(dir, "ait-cli.cmd"), sh: path.join(dir, "ait-cli") };
}

const IS_WINDOWS = process.platform === "win32";
const CMD_REL = "project-docs/.ait/ait-cli.cmd";
const SH_REL = "project-docs/.ait/ait-cli";

/** 本平台 wrapper 相对路径：Windows 只写 `.cmd`，POSIX 只写无扩展名脚本。 */
const CURRENT_REL = IS_WINDOWS ? CMD_REL : SH_REL;
/** 另一平台形态：init 不写、--check 不校验、--refresh-wrapper 不重写。 */
const OTHER_REL = IS_WINDOWS ? SH_REL : CMD_REL;

/** 本平台 wrapper 的绝对路径。 */
function currentWrapperPath(base: string): string {
  return IS_WINDOWS ? wrapperPathsOf(base).cmd : wrapperPathsOf(base).sh;
}

/** 另一平台 wrapper 的绝对路径（断言其不存在）。 */
function otherWrapperPath(base: string): string {
  return IS_WINDOWS ? wrapperPathsOf(base).sh : wrapperPathsOf(base).cmd;
}

/** stderr 仅允许公共 API 进度事件，不能混入业务结果、日志或异常栈。 */
function parseWrapperProgress(stderr: string): CoreProgressEvent[] {
  return stderr.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => {
    const value: unknown = JSON.parse(line);
    expect(value).toBeTypeOf("object");
    expect(value).not.toBeNull();
    expect(Array.isArray(value)).toBe(false);
    const event = value as CoreProgressEvent;
    expect(Object.keys(event).sort()).toEqual([
      "operation", "operationId", "stage", "status",
    ]);
    for (const field of ["operationId", "operation"] as const) {
      expect(event[field]).toBeTypeOf("string");
      expect(event[field].trim()).not.toBe("");
    }
    expect([
      "read", "validate", "assemble", "write_bundle", "register_delivery",
      "acceptance", "git", "persist",
    ]).toContain(event.stage);
    expect(["started", "completed", "failed"]).toContain(event.status);
    return event;
  });
}

/** 实际执行生成入口；Windows 必须经 cmd，POSIX 直接运行可执行 wrapper。 */
function runWrapper(base: string, args: string[], operation: string | null) {
  const wrapper = currentWrapperPath(base);
  const options = {
    cwd: base,
    encoding: "utf-8" as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  const result = IS_WINDOWS
    ? spawnSync(
        process.env["ComSpec"] ?? "cmd.exe",
        [
          "/d", "/s", "/c",
          '"' + [wrapper, ...args].map((arg) => '"' + arg + '"').join(" ") + '"',
        ],
        { ...options, windowsVerbatimArguments: true },
      )
    : spawnSync(wrapper, args, options);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const progress = parseWrapperProgress(result.stderr);
  if (operation !== null) {
    expect(progress.length).toBeGreaterThan(0);
    expect(new Set(progress.map((event) => event.operation))).toEqual(new Set([operation]));
    expect(new Set(progress.map((event) => event.operationId)).size).toBe(1);
    expect(progress.some((event) => event.status === "failed")).toBe(false);
    const started = progress.findIndex((event) =>
      event.stage === "validate" && event.status === "started",
    );
    const completed = progress.findIndex((event) =>
      event.stage === "validate" && event.status === "completed",
    );
    expect(started).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(started);
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toBe("");
  return {
    status: result.status,
    payload: JSON.parse(lines[0]!) as Record<string, unknown>,
    progress,
  };
}

/** 记录目录与文件元数据，捕获 check 重写同字节内容或改变执行位的行为。 */
function snapshotTree(base: string) {
  const snapshot = new Map<
    string, { mode: number; mtime: number; hash: string | null }
  >();
  const walk = (current: string): void => {
    const stat = fs.lstatSync(current);
    snapshot.set(path.relative(base, current), {
      mode: stat.mode,
      mtime: stat.mtimeMs,
      hash: stat.isFile()
        ? createHash("sha256").update(fs.readFileSync(current)).digest("hex")
        : null,
    });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) walk(path.join(current, name));
    }
  };
  walk(base);
  return snapshot;
}

/** 仅用于模板断言，不调用被测实现的引用函数。 */
function quoteWrapperTarget(target: string): string {
  return IS_WINDOWS
    ? '"' + target.replace(/%/g, "%%") + '"'
    : "'" + target.replace(/'/g, "'\\''") + "'";
}

describe("wrapper", () => {
  it(`init 只写本平台 wrapper（${CURRENT_REL}）并转发到 ait-core bin（:TEST 第 6 条）`, () => {
    const base = mkTmp();
    const result = initProject(base, { name: "demo" });
    const current = currentWrapperPath(base);
    const bin = expectedBin();

    // 只写本平台形态：另一平台 wrapper 不被预写，也不出现在 createdFiles
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(otherWrapperPath(base))).toBe(false);
    expect(result.createdFiles).toContain(CURRENT_REL);
    expect(result.createdFiles).not.toContain(OTHER_REL);

    if (IS_WINDOWS) {
      // Windows wrapper 显式调用 Node，禁用延迟展开并透传退出码。
      const cmd = readNorm(current);
      const cmdLines = cmd.split("\n").map((l) => l.trim());
      expect(cmdLines[0]).toBe("@echo off");
      expect(cmd).toContain("setlocal DisableDelayedExpansion");
      expect(cmd).toContain(
        `${quoteWrapperTarget(process.execPath)} ${quoteWrapperTarget(bin)} %*`,
      );
      expect(cmd.toLowerCase()).toContain("exit /b %errorlevel%");
    } else {
      // POSIX wrapper 显式用 Node 执行 bin，不依赖 bin 的执行位。
      const sh = readNorm(current);
      expect(sh.split("\n")[0]).toBe("#!/bin/sh");
      expect(sh).toContain(
        `exec ${quoteWrapperTarget(process.execPath)} ${quoteWrapperTarget(bin)} "$@"`,
      );
      expect(fs.statSync(current).mode & 0o111).not.toBe(0);
    }

    // wrapper 不入 docs 仓版本控制：docs 仓内 .gitignore 已含 .ait/
    expect(readNorm(path.join(base, "project-docs", ".gitignore"))).toContain(
      ".ait/",
    );
  });

  it("重跑幂等：本平台 wrapper 字节不变、计入 skipped（:TEST 第 6 条）", () => {
    const base = mkTmp();
    const first = initProject(base, { name: "demo" });
    expect(first.createdFiles).toContain(CURRENT_REL);
    expect(first.createdFiles).not.toContain(OTHER_REL);

    const current = currentWrapperPath(base);
    const before = fs.readFileSync(current);
    const hash = createHash("sha256").update(before).digest("hex");

    const second = initProject(base, { name: "demo" });

    expect(
      createHash("sha256").update(fs.readFileSync(current)).digest("hex"),
    ).toBe(hash);
    expect(fs.readFileSync(current).equals(before)).toBe(true);
    expect(second.status).toBe("existing");
    expect(second.createdFiles).toEqual([]);
    expect(second.skipped).toContain(CURRENT_REL);
    // 重跑同样不补写另一平台形态
    expect(fs.existsSync(otherWrapperPath(base))).toBe(false);
    expect(second.skipped).not.toContain(OTHER_REL);
  });

  it("--refresh-wrapper 强制重写本平台 wrapper：删除/写坏后恢复，其余产物不动（:TEST 第 6 条）", () => {
    const base = mkTmp();
    initProject(base, { name: "demo" });
    const current = currentWrapperPath(base);
    const other = otherWrapperPath(base);
    const original = fs.readFileSync(current);

    // 记录其余产物：refresh 只应重写 wrapper
    const indexFile = path.join(
      base,
      "project-docs",
      ".meta",
      "chunks-index.yaml",
    );
    const indexBefore = createHash("sha256")
      .update(fs.readFileSync(indexFile))
      .digest("hex");
    const docsBefore = hashTree(path.join(base, "project-docs", "docs"));
    const metaBefore = hashTree(path.join(base, "project-docs", ".meta"));

    // 删除本平台 wrapper：refresh 应恢复
    fs.rmSync(current);
    const refreshed = refreshWrapper(base);
    expect(refreshed.createdFiles).toContain(CURRENT_REL);
    expect(refreshed.createdFiles).not.toContain(OTHER_REL);
    expect(refreshed.status).toBe("existing");
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.readFileSync(current).equals(original)).toBe(true);

    // 写坏本平台 wrapper（模拟安装路径变更后的陈旧 wrapper）：refresh 应强制重写
    fs.writeFileSync(
      current,
      IS_WINDOWS ? "@echo off\nrem tampered\n" : "#!/bin/sh\n# tampered\n",
      "utf-8",
    );
    const refreshedAgain = refreshWrapper(base);
    expect(refreshedAgain.createdFiles).toContain(CURRENT_REL);
    expect(fs.readFileSync(current).equals(original)).toBe(true);
    expect(readNorm(current)).not.toContain("tampered");
    // 另一平台形态始终不被创建
    expect(fs.existsSync(other)).toBe(false);

    // 其余既有产物字节不变
    expect(
      createHash("sha256").update(fs.readFileSync(indexFile)).digest("hex"),
    ).toBe(indexBefore);
    expect(hashTree(path.join(base, "project-docs", "docs"))).toEqual(docsBefore);

    // init 的等价入口 --refresh-wrapper：同样强制重写本平台文件（不只认顶层函数）
    fs.rmSync(current);
    const viaInit = initProject(base, { name: "demo", refreshWrapper: true });
    expect(viaInit.createdFiles).toContain(CURRENT_REL);
    expect(viaInit.createdFiles).not.toContain(OTHER_REL);
    expect(fs.readFileSync(current).equals(original)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
    expect(hashTree(path.join(base, "project-docs", "docs"))).toEqual(docsBefore);
    expect(hashTree(path.join(base, "project-docs", ".meta"))).toEqual(metaBefore);
  });

  it("--check 只要求本平台 wrapper 且零写入（:TEST 第 6 条）", () => {
    const base = mkTmp();
    initProject(base, { name: "demo" });
    const current = currentWrapperPath(base);
    const other = otherWrapperPath(base);

    // 齐备时 ok=true、无 missing：另一平台 wrapper 缺失不算未就绪
    const healthy = checkProject(base);
    expect(healthy.ok).toBe(true);
    expect(healthy.missing).toEqual([]);
    expect(healthy.missing).not.toContain(OTHER_REL);
    expect(initProject(base, { name: "demo", check: true }).skipped).toEqual(
      [],
    );

    // 删除本平台 wrapper：missing 精确报告该文件
    fs.rmSync(current);
    const broken = checkProject(base);
    expect(broken.ok).toBe(false);
    expect(broken.missing).toContain(CURRENT_REL);
    expect(broken.missing).not.toContain(OTHER_REL);

    // 零写入：--check 不重建 wrapper、不新建骨架、不改动任何既有文件
    const before = hashTree(path.join(base, "project-docs"));
    const checked = initProject(base, { name: "demo", check: true });
    const after = hashTree(path.join(base, "project-docs"));
    expect(fs.existsSync(current)).toBe(false);
    expect(checked.createdFiles).toEqual([]);
    expect(checked.status).toBe("existing");
    expect(checked.skipped).toContain(`check: ${CURRENT_REL}`);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, hash] of before) {
      expect(after.get(rel), `--check 意外写入：${rel}`).toBe(hash);
    }

    // 白板目录上 --check 同样零写入：不创建 project-docs
    const blank = mkTmp();
    const blankCheck = initProject(blank, { check: true });
    expect(blankCheck.createdFiles).toEqual([]);
    expect(blankCheck.skipped.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(blank, "project-docs"))).toBe(false);

    // 补齐本平台 wrapper 后 check 恢复 ok（另一平台仍缺失，不构成未就绪）
    refreshWrapper(base);
    expect(checkProject(base).ok).toBe(true);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
  });

  it("实际 wrapper 在空格/Unicode 目录保留 cwd、完整参数、单 JSON 与退出码（:TEST 第 8 条）", () => {
    const base = path.join(mkTmp(), "项目 空格 '入口");
    fs.mkdirSync(base);
    initProject(base, { name: "demo" });
    new VersionManager(resolveProjectRoot(base)).versionCreate("v0.17");
    const before = snapshotTree(base);

    expect(runWrapper(base, ["--version"], "project.documentVersion")).toMatchObject({
      status: 0,
      payload: { ok: true, data: { version: "v0.17" } },
    });
    expect(runWrapper(base, ["init", "--check"], "project.init")).toMatchObject({
      status: 0,
      payload: { ok: true, data: { ok: true, missing: [] } },
    });
    const invalid = runWrapper(base, ["init", "--未知 参数"], null);
    expect(invalid.status).toBeGreaterThan(0);
    expect(invalid.status).toBe(1);
    expect(invalid.payload).toMatchObject({
      ok: false,
      code: "USAGE_ERROR",
      error: "未知 flag：--未知 参数",
    });
    // 参数解析在调用公共 API 之前拒绝，没有虚构的阶段进度。
    expect(invalid.progress).toEqual([]);
    expect(snapshotTree(base)).toEqual(before);
  });

  it.each(["旧 Python", "旧包入口", "任意损坏脚本"])(
    "--check 拒绝%s且不执行，refresh 恢复真实入口并保留其余字节（:TEST 第 9 条）",
    (kind) => {
      const base = mkTmp();
      initProject(base, { name: "demo" });
      const current = currentWrapperPath(base);
      const original = fs.readFileSync(current);
      const marker = path.join(base, "wrapper-executed.txt");
      let broken: string;
      if (kind === "旧 Python") {
        broken = IS_WINDOWS
          ? '@echo off\r\npython "old-ait.py" %*\r\n'
          : '#!/bin/sh\nexec python "old-ait.py" "$@"\n';
      } else if (kind === "旧包入口") {
        const oldBin = path.join(base, "old-bin.js");
        fs.copyFileSync(expectedBin(), oldBin);
        broken = readNorm(current).replace(
          quoteWrapperTarget(expectedBin()), quoteWrapperTarget(oldBin),
        );
      } else {
        broken = IS_WINDOWS
          ? '@echo off\r\n> "' + marker + '" echo executed\r\n'
          : '#!/bin/sh\nprintf executed > ' + quoteWrapperTarget(marker) + '\n';
      }
      fs.writeFileSync(current, broken, "utf-8");
      const before = snapshotTree(base);
      expect(checkProject(base)).toEqual({ ok: false, missing: [CURRENT_REL] });
      const checked = initProject(base, { name: "demo", check: true });
      expect(checked.createdFiles).toEqual([]);
      expect(checked.skipped).toContain('check: ' + CURRENT_REL);
      expect(snapshotTree(base)).toEqual(before);
      expect(fs.existsSync(marker)).toBe(false);

      const unchanged = hashTree(base);
      unchanged.delete(CURRENT_REL);
      const refreshed = refreshWrapper(base);
      expect(refreshed.createdFiles).toEqual([CURRENT_REL]);
      expect(Object.keys(refreshed.files)).toEqual([CURRENT_REL]);
      expect(fs.readFileSync(current)).toEqual(original);
      expect(checkProject(base)).toEqual({ ok: true, missing: [] });
      expect(runWrapper(base, ["--version"], "project.documentVersion")).toMatchObject({
        status: 0, payload: { ok: true },
      });
      const after = hashTree(base);
      after.delete(CURRENT_REL);
      expect(after).toEqual(unchanged);
    },
  );

  it("--check 允许模板 LF/CRLF 差异且保持原字节", () => {
    const base = mkTmp();
    initProject(base, { name: "demo" });
    const wrapper = currentWrapperPath(base);
    const normalized = readNorm(wrapper);
    fs.writeFileSync(wrapper, IS_WINDOWS ? normalized : normalized.replace(/\n/g, "\r\n"));
    const before = snapshotTree(base);
    expect(checkProject(base)).toEqual({ ok: true, missing: [] });
    expect(snapshotTree(base)).toEqual(before);
  });

  it("--check 报告本例包副本的 Node/bin 目标缺失，不改动真实 Node", async () => {
    const packageCopy = path.join(mkTmp(), "安装 包副本");
    fs.mkdirSync(packageCopy);
    fs.copyFileSync(
      path.join(REPO_ROOT, "package.json"), path.join(packageCopy, "package.json"),
    );
    fs.cpSync(path.join(REPO_ROOT, "src"), path.join(packageCopy, "src"), {
      recursive: true,
    });
    fs.symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(packageCopy, "node_modules"),
      "junction",
    );
    const binCopy = path.join(packageCopy, path.relative(REPO_ROOT, expectedBin()));
    fs.mkdirSync(path.dirname(binCopy), { recursive: true });
    fs.copyFileSync(expectedBin(), binCopy);
    const nodeCopy = path.join(packageCopy, path.basename(process.execPath));
    fs.copyFileSync(process.execPath, nodeCopy);
    const fixture = await import(
      path.join(packageCopy, "src/init/init-manager.ts").split(path.sep).join("/")
    ) as typeof import("../src/init/init-manager.js");
    const base = mkTmp();
    const nodeDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
    try {
      Object.defineProperty(process, "execPath", { ...nodeDescriptor, value: nodeCopy });
      fixture.initProject(base, { name: "demo" });
      expect(fixture.checkProject(base)).toEqual({ ok: true, missing: [] });
      for (const target of [nodeCopy, binCopy]) {
        fs.renameSync(target, target + ".unavailable");
        try {
          const before = snapshotTree(base);
          const checked = fixture.checkProject(base);
          expect(checked.ok).toBe(false);
          expect(checked.missing).toContain(CURRENT_REL);
          expect(checked.missing).toContain(
            path.relative(base, target).split(path.sep).join("/"),
          );
          expect(snapshotTree(base)).toEqual(before);
        } finally {
          fs.renameSync(target + ".unavailable", target);
        }
        expect(fixture.checkProject(base)).toEqual({ ok: true, missing: [] });
      }
    } finally {
      Object.defineProperty(process, "execPath", nodeDescriptor);
    }
  });

  it.skipIf(IS_WINDOWS)("POSIX --check 拒绝缺执行位的 wrapper，refresh 后可直接执行", () => {
    const base = mkTmp();
    initProject(base, { name: "demo" });
    const wrapper = currentWrapperPath(base);
    fs.chmodSync(wrapper, 0o644);
    const before = snapshotTree(base);
    expect(checkProject(base)).toEqual({ ok: false, missing: [CURRENT_REL] });
    expect(snapshotTree(base)).toEqual(before);
    refreshWrapper(base);
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
    expect(checkProject(base)).toEqual({ ok: true, missing: [] });
    expect(runWrapper(base, ["--version"], "project.documentVersion")).toMatchObject({
        status: 0, payload: { ok: true },
      });
  });
});

// ---------------------------------------------------------------------------
// :TEST 第 5/7 条 — Python 版 ait 真实仓库副本上 init 不改写 .meta
// ---------------------------------------------------------------------------

const REPO_PROJECT_DOCS = path.join(REPO_ROOT, "project-docs");

/** AIT_CORPUS_DIRS（";" 分隔）→ 存在的 project-docs 目录列表；缺省为 ait-core 自身。 */
function corpusProjectDocs(): { configured: string[]; existing: string[] } {
  const raw = process.env["AIT_CORPUS_DIRS"];
  const configured =
    raw !== undefined && raw.trim() !== ""
      ? raw
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : [REPO_PROJECT_DOCS];
  // 容忍两种给法：project-docs 目录本身，或它的 .meta 目录
  return {
    configured,
    existing: configured
      .map((item) =>
        path.basename(item) === ".meta" ? path.dirname(item) : item,
      )
      .filter(
        (dir) =>
          fs.existsSync(path.join(dir, "docs")) &&
          fs.existsSync(path.join(dir, ".meta")),
      ),
  };
}

/** 拷贝 project-docs 到 <base>/project-docs（跳过 .git/.ait，独立验证本地入口补齐）。 */
function copyProjectDocs(src: string, base: string): string {
  const dst = path.join(base, "project-docs");
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) =>
      !p.split(path.sep).some((part) => part === ".git" || part === ".ait"),
  });
  return dst;
}

describe("Python 仓库副本", () => {
  const corpus = corpusProjectDocs();
  if (corpus.existing.length === 0) {
    console.warn(
      `Python 仓库副本用例 skip：AIT_CORPUS_DIRS 未指向任何含 docs/ 与 .meta/ 的 ` +
        `project-docs 目录；配置值 = ${JSON.stringify(corpus.configured)}`,
    );
    it.skip("缺少 Python project-docs 语料，已打印配置原因", () => {});
  }

  for (const src of corpus.existing) {
    it(
      `init 返回 existing，.meta 全部文件字节不变（${src}）`,
      { timeout: 120_000 },
      () => {
        const base = mkTmp();
        // 裸拷贝（不含 .git）：docs 仓缺失时由 init 自行补齐，.meta 必须原样
        copyProjectDocs(src, base);
        const metaDir = path.join(base, "project-docs", ".meta");
        const docsDir = path.join(base, "project-docs", "docs");
        expect(fs.existsSync(metaDir)).toBe(true);

        // 语料自身的根名：init 传同名才不会另建根文档（否则会补写新根，属预期行为）
        const prdRoots = fs
          .readdirSync(path.join(docsDir, "prd"))
          .filter((f) => /^\[PRD\]-[^:]+\.md$/.test(f));
        expect(prdRoots.length).toBeGreaterThan(0);
        const name = String(prdRoots[0])
          .replace(/^\[PRD\]-/, "")
          .replace(/\.md$/, "");

        const before = hashTree(metaDir);
        const docsBefore = hashTree(docsDir);
        expect(before.size).toBeGreaterThan(0);

        const result = initProject(base, { name });

        // 已初始化：status=existing；既有产物零改写，只在 wrapper 缺失时补齐
        expect(result.status).toBe("existing");
        const nonWrapper = result.createdFiles.filter(
          (f) => !f.startsWith("project-docs/.ait/"),
        );
        expect(nonWrapper).toEqual([]);
        for (const rel of Object.keys(result.files)) {
          expect(rel, `既有文件被改写：${rel}`).toMatch(
            /^project-docs\/\.ait\//,
          );
        }

        // .meta 全部文件字节不变（基线索引、关系图、历史版本目录一并比对）
        const after = hashTree(metaDir);
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [rel, hash] of before) {
          expect(after.get(rel), `.meta 字节已变：${rel}`).toBe(hash);
        }
        // docs 全部文件字节不变
        expect(hashTree(docsDir)).toEqual(docsBefore);

        // wrapper 按需补齐（拷贝时排除了 .ait/）：只写本平台形态，转发目标仍指向 ait-core bin
        const current = currentWrapperPath(base);
        expect(fs.existsSync(current)).toBe(true);
        expect(fs.existsSync(otherWrapperPath(base))).toBe(false);
        expect(result.createdFiles).toContain(CURRENT_REL);
        expect(result.createdFiles).not.toContain(OTHER_REL);
        const currentText = readNorm(current);
        expect(currentText).toContain(quoteWrapperTarget(process.execPath));
        expect(currentText).toContain(quoteWrapperTarget(expectedBin()));
        if (IS_WINDOWS) {
          expect(currentText.split("\n")[0]).toBe("@echo off");
          expect(currentText).toContain("%*");
        } else {
          expect(currentText.split("\n")[0]).toBe("#!/bin/sh");
          expect(currentText).toContain(
            `exec ${quoteWrapperTarget(process.execPath)} ${quoteWrapperTarget(expectedBin())} "$@"`,
          );
        }
      },
    );
  }
});
