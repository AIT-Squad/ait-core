// [TDD]-versioning_tests v0.11 — versioning 域三个制品（version-manager / merge-engine /
// publish）的集成验收，覆盖 [FSD]-ait-core-versioning:TEST 第 1~8 条全部断言点。
//
// 持久化形态按 Python 当前形态断言（v0.5 对齐，doc-model schemas 为权威）：
// - 变更记录 `.meta/changes/chg-NNN.yaml`，一条一文件、全仓共享编号空间
//   （ChangeRecordSchema；编号为**文件名数值**，非字典序）；
// - 确认计划存于版本元数据 `confirmed_plan`（ReconciliationPlanSchema），
//   **不存在** `plan-<v>.yaml` / `changes-<v>.yaml` 这类 Python 不认识的独立文件；
// - 版本元数据 `.meta/versions/<v>.yaml`（含 `version` 字段）。
//
// 约束：每个用例在 os.tmpdir() 下自建真实双仓（docs 仓 = project-docs git 仓、宿主仓 =
// root.cwd git 仓）与最小合法规格树（NewModelManager 真实相位流：prd → fsd 两个 chunk，
// 无 TDD——:TEST 第 1~6 条不要求树内含 TDD，含 TDD 的合法树另有回归用例），用例间零共享；
// merge 失败注入用可控桩（`foundation/io` 原子写第 N 次抛异常，见下）、tag 引用预占、
// 宿主仓 index.lock 占用；内联文档文本一律用行数组 join，避免 ``` 围栏与 @id 注释自嵌套。
//
// 失败注入为何不走「篡改持久化计划」：merge 在执行前按 `conflict_policy` 重算计划与判定
// 输入指纹，并与持久化 `confirmed_plan` 逐项比对——任何对 operations 的篡改只会得到
// CONFIRMATION_STALE（零落盘），永远进不了执行阶段。执行期注入因此经 `foundation/io`
// 的 `atomicWriteText` 可控桩（第 N 次落盘抛异常），使 applyPlan 在**已写入部分文件**后
// 失败，从而真实覆盖 :TEST 第 3 条的字节级回退与可重试语义。
//
// 环境适配（测试侧垫片，不改实现、不改语义）：本机 node 为子进程创建 stdin pipe
// 必返 EBUSY（已实测：stdio[0]='pipe' 100% 失败，'ignore'/'inherit' 100% 正常，
// 与 node 版本、cwd、沙箱无关）；被测实现与 git 命令均不读 stdin，故经
// vi.mock("node:child_process") 将 spawnSync 的 stdin 形态 'pipe' 改写为 'ignore'，
// stdout/stderr 管道与其余选项原样保留。

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("node:child_process")>();
  type Options = Record<string, unknown> | undefined;
  /** stdin 形态 'pipe' → 'ignore'（缺省/字符串 'pipe'/数组首元素）；其余原样。 */
  const fixStdin = (opts: Options): Record<string, unknown> => {
    const stdio = opts?.["stdio"];
    if (stdio === undefined || stdio === "pipe") {
      return { ...opts, stdio: ["ignore", "pipe", "pipe"] };
    }
    if (Array.isArray(stdio)) {
      const next = [...stdio];
      if (next[0] === "pipe") {
        next[0] = "ignore";
      }
      return { ...opts, stdio: next };
    }
    return { ...opts };
  };
  const spawnSyncPatched = ((
    command: string,
    argsOrOptions?: readonly string[] | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    if (argsOrOptions === undefined) {
      return original.spawnSync(command, [], fixStdin(options));
    }
    if (Array.isArray(argsOrOptions)) {
      return original.spawnSync(command, argsOrOptions, fixStdin(options));
    }
    // spawnSync(command, options) 形态（readonly 数组在 isArray 反分支不窄化，显式断言）
    return original.spawnSync(
      command,
      [],
      fixStdin(argsOrOptions as Record<string, unknown>),
    );
  }) as typeof original.spawnSync;
  return { ...original, default: original, spawnSync: spawnSyncPatched };
});
/**
 * 执行期失败注入桩（`foundation/io`）：`failAfter < 0` 关闭注入；否则第
 * `failAfter + 1` 次 `atomicWriteText`（0 基，含经 saveModel 的落盘）抛异常。
 *
 * applyPlan 逐文件原子写 docs（一文件一次 `atomicWriteText`），故 `failAfter=1`
 * 恰好在**首个 docs 文件已落盘**后失败——正是「部分执行后回滚」的注入点。
 */
const ioFail = vi.hoisted(() => ({ failAfter: -1, calls: 0, failBindings: false }));

vi.mock("../src/foundation/io.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/foundation/io.js")>();
  return {
    ...original,
    atomicWriteText: (target: string, content: string): void => {
      if (ioFail.failBindings && /docs_commit: [0-9a-f]{40}/.test(content) && /phase: merged/.test(content)) {
        throw new Error("注入故障：绑定元数据落盘失败");
      }
      if (ioFail.failAfter >= 0) {
        const ordinal = ioFail.calls;
        ioFail.calls += 1;
        if (ordinal >= ioFail.failAfter) {
          throw new Error(`注入故障：atomicWriteText 第 ${ordinal + 1} 次落盘失败`);
        }
      }
      original.atomicWriteText(target, content);
    },
  };
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

import {
  resolveProjectRoot,
  type ProjectRoot,
} from "../src/foundation/root.js";
import { loadModel, saveModel } from "../src/foundation/yaml.js";
import { loadConfig, writeLocalConfig } from "../src/foundation/config.js";
import {
  ChangeRecordSchema,
  SpecGraphSchema,
  VersionMetaSchema,
  type ChangeRecord,
  type VersionMeta,
} from "../src/doc-model/schemas.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import { NewModelManager } from "../src/new-model/model-manager.js";
import { VersionManager } from "../src/versioning/version-manager.js";
import { versionMerge } from "../src/versioning/merge-engine.js";
import {
  acceptanceSet,
  acceptanceShow,
  push,
  runAcceptance,
} from "../src/versioning/publish.js";
import { dispatch } from "../src/cli/dispatcher.js";
import { SpecGraphStore, combinedView } from "../src/specgraph/graph-model.js";
import { prepareDelivery, type DeliveryPointer } from "../src/orchestration/context-delivery.js";
import { registerGenerationReceipt } from "../src/orchestration/generation-receipts.js";

// ---------------------------------------------------------------------------
// 常量与临时目录
// ---------------------------------------------------------------------------

const V = "v0.4";
/** 全流程用例 git 子进程密集，给足超时。 */
const T = 30_000;
/** 真实语料接管用例（整树拷贝 + 全流程 + git），单独放长超时。 */
const T_CORPUS = 600_000;

let tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-versioning-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  // 注入桩是本文件级共享状态，用例间必须复位（零共享的硬约束）。
  ioFail.failAfter = -1;
  ioFail.calls = 0;
  ioFail.failBindings = false;
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

// ---------------------------------------------------------------------------
// git 子进程辅助（白板入口不依赖全局身份配置：仓内本地身份）
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.error !== undefined || res.status !== 0) {
    const detail =
      typeof res.stderr === "string" && res.stderr.trim() !== ""
        ? res.stderr.trim()
        : String(res.error ?? `exit=${res.status ?? "?"}`);
    throw new Error(`git ${args.join(" ")} 失败（cwd=${cwd}）：${detail}`);
  }
  return typeof res.stdout === "string" ? res.stdout.trim() : "";
}

/** 探测型 git：成功返回 stdout（去尾空白），失败返回 null。 */
function gitTry(cwd: string, args: string[]): string | null {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (res.error !== undefined || res.status !== 0) {
    return null;
  }
  return typeof res.stdout === "string" ? res.stdout.trim() : "";
}

/** bare 远端 git（--git-dir 前缀）。 */
function gitBare(bare: string, args: string[]): string | null {
  return gitTry(bare, [`--git-dir=${bare}`, ...args]);
}

/** git init（main 分支，兼容旧版 git 的 symbolic-ref 方式）+ 仓内本地身份。 */
function initRepo(dir: string): void {
  git(dir, ["init"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "user.name", "ait"]);
  git(dir, ["config", "user.email", "ait@localhost"]);
}

function gitCommitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

// ---------------------------------------------------------------------------
// 环境搭建（真实双仓 + 最小合法规格树）
// ---------------------------------------------------------------------------

interface Env {
  base: string;
  root: ProjectRoot;
}

/**
 * 搭建 project-docs 骨架（docs/{prd,fsd,tdd} + .meta/versions）。
 * docsGit：project-docs 为独立 git 仓（含 .gitignore 与 initial baseline 提交）；
 * hostGit：root.cwd 为宿主 git 仓（.gitignore 隔离 project-docs/，含 initial 提交）。
 */
function makeEnv(opts?: { docsGit?: boolean; hostGit?: boolean }): Env {
  const docsGit = opts?.docsGit !== false;
  const hostGit = opts?.hostGit !== false;
  const base = mkTmp();
  const pd = path.join(base, "project-docs");
  const docs = path.join(pd, "docs");
  const meta = path.join(pd, ".meta");
  for (const d of [
    docs,
    meta,
    path.join(docs, "prd"),
    path.join(docs, "fsd"),
    path.join(docs, "tdd"),
    path.join(meta, "versions"),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (docsGit) {
    fs.writeFileSync(
      path.join(pd, ".gitignore"),
      ".meta/snapshots/\n.ait/\nconfig.local.yaml\n",
    );
    initRepo(pd);
    gitCommitAll(pd, "initial baseline");
  }
  if (hostGit) {
    fs.writeFileSync(path.join(base, ".gitignore"), "project-docs/\n");
    initRepo(base);
    gitCommitAll(base, "initial host");
  }
  return { base, root: { cwd: base, root: pd, docs, meta } };
}

// ---------------------------------------------------------------------------
// 最小合法规格树（PRD 根 →derives→ FSD 根）
// ---------------------------------------------------------------------------

const PRD_DOC = [
  "<!-- @id:[PRD]-demo -->",
  "## demo 产品 PRD",
  "",
  "### 概述",
  "demo 概述文本。",
  "",
  "### 范围",
  "管理 demo 的规格与制品版本。",
  "",
  "### 目标与度量",
  "合法版本能够完成确认与合入。",
  "",
  "### 反向要求",
  "- 不修改其它项目的历史。",
].join("\n");

const FSD_DOC = [
  "<!-- @id:[FSD]-demo -->",
  "## demo 功能分解根",
  "",
  "### 功能描述",
  "demo 域描述。",
  "",
  "### 反向要求",
  "- 不管理其它功能域。",
  "",
  "### 分解视图",
  "- implementation：demo 制品的实现。",
].join("\n");

const FSD_LEAF_DOC = [
  "<!-- @id:[FSD]-demo:implementation -->",
  "## demo 实现能力",
  "",
  "### 功能描述",
  "提供 demo 制品。",
  "",
  "### 能力契约",
  "导出 value，调用者能够读取当前版本的值。",
  "",
  "### 反向要求",
  "- 不修改其它制品。",
].join("\n");

/**
 * 主规格树 chunk id：PRD 根 + FSD 根，恰好两个。
 * 恰两个是本文件的硬前提——TDD 实现逻辑 §2 要求预置 chg-999/chg-1000 后
 * 「commit 两个 chunk 后断言新增 chg-1001、chg-1002」，故每次 versionCommit 只
 * 能产出两条变更记录。
 */
const CHUNK_IDS = ["[PRD]-demo", "[FSD]-demo"];

/** 含 TDD 的规格树（回归用例：合法树 confirm 通过）。 */
const TDD_DOC = [
  "<!-- @id:[TDD]-demo -->",
  "## demo TDD",
  "",
  "```yaml",
  "target_file: src/demo.ts",
  "```",
  "",
  "### 技术栈",
  "TypeScript。",
  "",
  "### 实现约束",
  "仅修改 src/demo.ts，保持 ESM 导出。",
  "",
  "### 文件职责",
  "提供 demo 的 value 导出。",
  "",
  "### 代码结构",
  "export const value = 1;",
  "",
  "### 实现逻辑",
  "将当前版本的值作为常量导出。",
  "",
  "### 错误处理与边界条件",
  "无外部输入。",
  "",
  "### 单测要求",
  "确认导出值与当前版本一致。",
].join("\n");

/**
 * 经 NewModelManager 真实相位流写入版本工作区（working 记录 + 关系边随创建出生）：
 * prd create → prd confirm（层冻结，同时产出 chg-001）→ fsd create（--parent 出生
 * derives 边，留下一条 working 条目）。
 *
 * 层冻结会顺带委托 versioning 域提交本层 working 条目（其自身语义，归 new_model
 * 域验收），故返回时 chg 编号已用掉一条；版本级 versionCommit 再产出一条——合计
 * **恰好两条**新记录，满足 TDD 实现逻辑 §2「commit 两个 chunk 后断言新增
 * chg-1001、chg-1002」。
 */
async function buildContent(root: ProjectRoot): Promise<void> {
  const mgr = new NewModelManager(root);
  await mgr.createDocument("prd", "[PRD]-demo", {
    content: PRD_DOC,
    skipContext: true,
  });
  mgr.confirmLayer("prd");
  await mgr.createDocument("fsd", "[FSD]-demo", {
    content: FSD_DOC,
    parent: "[PRD]-demo",
    skipContext: true,
  });
}

/** 含 TDD 的规格树：主树 + fsd confirm + tdd create（--parent 出生 details 边）。 */
async function buildContentWithTdd(root: ProjectRoot): Promise<void> {
  await buildContent(root);
  const mgr = new NewModelManager(root);
  await mgr.createDocument("fsd", "[FSD]-demo:implementation", {
    content: FSD_LEAF_DOC,
    skipContext: true,
  });
  mgr.confirmLayer("fsd");
  await mgr.createDocument("tdd", "[TDD]-demo", {
    content: TDD_DOC,
    parent: "[FSD]-demo:implementation",
    skipContext: true,
  });
}

async function advanceToCommit(root: ProjectRoot): Promise<VersionManager> {
  const vm = new VersionManager(root);
  vm.versionCreate(V);
  await buildContent(root);
  vm.versionCommit(V);
  return vm;
}

async function advanceToConfirm(root: ProjectRoot): Promise<{
  vm: VersionManager;
  confirm: Awaited<ReturnType<VersionManager["versionConfirm"]>>;
}> {
  const vm = await advanceToCommit(root);
  const confirm = await vm.versionConfirm(V);
  return { vm, confirm };
}

async function advanceToMerged(root: ProjectRoot): Promise<{
  vm: VersionManager;
  confirm: Awaited<ReturnType<VersionManager["versionConfirm"]>>;
  merge: Awaited<ReturnType<typeof versionMerge>>;
}> {
  const { vm, confirm } = await advanceToConfirm(root);
  const merge = await versionMerge(root, V);
  return { vm, confirm, merge };
}

// ---------------------------------------------------------------------------
// 字节级快照 / 持久化读取辅助
// ---------------------------------------------------------------------------

/** 目录全量字节摘要：相对路径 → 内容 sha256；目录不存在返回空表。 */
function treeDigest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) {
    return out;
  }
  const walk = (cur: string): void => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.set(
          path.relative(dir, abs),
          createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
        );
      }
    }
  };
  walk(dir);
  return out;
}

/** 两份字节摘要逐项相等（文件集合 + 逐文件字节）。 */
function expectSameDigest(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rel, hash] of before) {
    expect(after.get(rel)).toBe(hash);
  }
}

/** 指定文件集合的字节摘要（子集核对：历史文件逐字节不变）。 */
function fileDigests(dir: string, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of names) {
    const abs = path.join(dir, name);
    out.set(
      name,
      createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
    );
  }
  return out;
}

function metaPathOf(root: ProjectRoot, version: string): string {
  return path.join(root.meta, "versions", `${version}.yaml`);
}

function readMeta(root: ProjectRoot, version: string): VersionMeta {
  return loadModel(metaPathOf(root, version), VersionMetaSchema);
}

/** `.meta/changes/` 目录绝对路径（变更记录一条一文件）。 */
function changesDirOf(root: ProjectRoot): string {
  return path.join(root.meta, "changes");
}

/** `.meta/changes/` 下全部 chg 文件名（字典序，仅用于集合比对）。 */
function changeFileNames(root: ProjectRoot): string[] {
  const dir = changesDirOf(root);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("chg-"))
    .sort();
}

/** 单条变更记录（changeId 形如 `chg-NNN`）。 */
function readChange(root: ProjectRoot, changeId: string): ChangeRecord {
  return loadModel(
    path.join(changesDirOf(root), `${changeId}.yaml`),
    ChangeRecordSchema,
  );
}

/** 变更记录文件名 → 数值编号（非 chg-<数字>.yaml 的名字跳过）。 */
function changeNumber(name: string): number | null {
  const m = /^chg-(\d+)\.yaml$/.exec(name);
  return m === null ? null : Number(m[1]);
}

/** 变更记录编号的**数值**升序列表（跨位数不按字典序）。 */
function changeNumbers(root: ProjectRoot): number[] {
  return changeFileNames(root)
    .map(changeNumber)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

/** 预置一条变更记录文件（模拟 Python 版 ait 已写下的历史记录）。 */
function seedChangeRecord(
  root: ProjectRoot,
  id: string,
  target: string,
  message: string,
): void {
  fs.mkdirSync(changesDirOf(root), { recursive: true });
  saveModel(
    path.join(changesDirOf(root), `${id}.yaml`),
    ChangeRecordSchema.parse({
      id,
      version: V,
      type: "ADD",
      target,
      author: "legacy",
      date: new Date(0).toISOString(),
      message,
      base_hash: null,
      discussion_usage: null,
      base_content: null,
      new_content: null,
    }),
  );
}

/** 同步错误码断言。 */
function expectThrowCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 code=${code}，实际未抛出`);
}

/** 异步错误码断言。 */
async function expectErrCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/** 捕获异步异常（不断言），用于同时断言 code 与 message。 */
async function captureErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("期望抛出异常，实际正常返回");
}

/** 进程内 dispatch（dispatcher 以 process.cwd() 解析项目根，调用期间临时 chdir）。 */
async function dispatchIn(
  cwd: string,
  argv: string[],
): Promise<Record<string, unknown>> {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return (await dispatch(argv)) as unknown as Record<string, unknown>;
  } finally {
    process.chdir(prev);
  }
}

/** 断言 dispatch 成功并返回 data（失败即抛出完整信封，便于定位）。 */
async function dispatchOk(
  cwd: string,
  argv: string[],
): Promise<Record<string, unknown>> {
  const res = await dispatchIn(cwd, argv);
  if (res["ok"] !== true) {
    throw new Error(`dispatch ${argv.join(" ")} 失败：${JSON.stringify(res)}`);
  }
  return res["data"] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// :TEST 1 — 生命周期全流程
// ---------------------------------------------------------------------------

describe("生命周期全流程", () => {
  it(
    "create→commit→confirm→merge 全流程；第二开放版本 ACTIVE_VERSION_EXISTS；confirm 指纹持久化且 docs/.meta 零额外落盘；merge 原子落盘",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = new VersionManager(root);

      // create：首个开放版本
      const created = vm.versionCreate(V);
      expect(created.version).toBe(V);
      expect(created.based_on).toBe(null);
      expect(readMeta(root, V).phase).toBe("empty");

      // 一次一个开放版本：第二个报 ACTIVE_VERSION_EXISTS
      expectThrowCode(() => vm.versionCreate("v0.5"), "ACTIVE_VERSION_EXISTS");

      // 规格树写入 + commit：chg 文件编号数值递增
      // （prd 层冻结顺带提交本层条目 → chg-001；版本级 commit 提交余下的 fsd 条目）
      await buildContent(root);
      const committed = vm.versionCommit(V);
      expect(committed.committed).toEqual(["[FSD]-demo"]);
      expect(committed.changes).toEqual(["chg-002"]);
      expect(changeNumbers(root)).toEqual([1, 2]);
      expect(readMeta(root, V).changes).toEqual(["chg-001", "chg-002"]);
      // 记录形态：type 大写、target 为 `<file>#<chunk_id>`、new_content 为 chunk 内容
      const firstChange = readChange(root, "chg-001");
      expect(firstChange.id).toBe("chg-001");
      expect(firstChange.version).toBe(V);
      expect(firstChange.type).toBe("ADD");
      expect(firstChange.target).toBe("prd/[PRD]-demo#[PRD]-demo");
      expect(firstChange.new_content).toContain("@id:[PRD]-demo");
      const secondChange = readChange(root, "chg-002");
      expect(secondChange.type).toBe("ADD");
      expect(secondChange.target).toBe("fsd/[FSD]-demo#[FSD]-demo");
      expect(secondChange.new_content).toContain("@id:[FSD]-demo");

      // confirm：纯门禁。操作前字节快照 docs 与 .meta
      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const confirm = await vm.versionConfirm(V);
      expect(confirm.version).toBe(V);
      expect(confirm.passed).toBe(true);
      expect(confirm.planned_operations).toBe(CHUNK_IDS.length);
      expect(confirm.conflict_policy).toBe("use-version");
      // 验收未配置 → 真空通过
      expect(confirm.acceptance).toEqual({
        ran: false,
        passed: true,
        exitCode: null,
      });
      // 宿主 clean → 绑定 HEAD
      expect(confirm.code_result).toBe(git(root.cwd, ["rev-parse", "HEAD"]));

      // 零落盘：docs 字节零变化；.meta 唯一允许的写入是 versions/<v>.yaml
      // （confirmed_plan + code_result 绑定）——confirm 只写本版本元数据
      expectSameDigest(docsBefore, treeDigest(root.docs));
      const metaAfter = treeDigest(root.meta);
      const allowed = new Set([path.join("versions", `${V}.yaml`)]);
      for (const [rel, hash] of metaBefore) {
        if (!allowed.has(rel)) {
          expect(metaAfter.get(rel)).toBe(hash);
        }
      }
      for (const rel of metaAfter.keys()) {
        if (!allowed.has(rel)) {
          expect(metaBefore.has(rel)).toBe(true);
        }
      }
      // 不存在 Python 不认识的独立计划/变更日志文件
      expect(fs.existsSync(path.join(root.meta, `plan-${V}.yaml`))).toBe(false);
      expect(fs.existsSync(path.join(root.meta, `changes-${V}.yaml`))).toBe(
        false,
      );
      // 指纹持久化于版本元数据 confirmed_plan：64 位 hex、与返回值一致、
      // operations 与版本记录对应
      const plan = readMeta(root, V).confirmed_plan;
      expect(plan).not.toBe(null);
      expect(plan?.input_fingerprint).toBe(confirm.plan_fingerprint);
      expect(plan?.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(plan?.conflict_policy).toBe(confirm.conflict_policy);
      expect(plan?.operations.length).toBe(CHUNK_IDS.length);

      // merge：唯一落盘点，原子落盘
      const merge = await versionMerge(root, V);
      expect(merge.version).toBe(V);
      // merged_chunks 按 plan 顺序（= 版本索引顺序）返回，非字典序
      expect(merge.merged_chunks).toEqual(CHUNK_IDS);
      expect(merge.commit).not.toBe(null);
      expect(merge.git).toBe("committed");
      expect(merge.tag_created).toBe(true);
      expect(merge.plan_fingerprint).toBe(confirm.plan_fingerprint);
      // baseline 提升 + tag 验证存在
      expect(
        git(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(merge.commit);
      const mergedMeta = readMeta(root, V);
      expect(mergedMeta.phase).toBe("merged");
      // docs_commit 记录「按计划落盘 docs」那一步的提交；绑定提交（AIT <v> meta:
      // record bindings）在其后，tag 建在绑定提交上，故 merge.commit 是更晚的 HEAD
      expect(typeof mergedMeta.docs_commit).toBe("string");
      const log = git(root.root, ["log", "--format=%H"]).split(String.fromCharCode(10));
      expect(log.indexOf(mergedMeta.docs_commit as string)).toBeGreaterThan(0);
      expect(log.indexOf(mergedMeta.docs_commit as string)).toBeGreaterThan(
        log.indexOf(merge.commit as string),
      );
      // 版本工作区、版本索引、版本图保留（与 Python 一致，供历史查询）
      expect(fs.existsSync(path.join(root.root, "versions", V))).toBe(true);
      expect(new IndexManager(root).loadVersionIndex(V).status).toBe("merged");
      expect(
        loadModel(path.join(root.meta, `specgraph-${V}.yaml`), SpecGraphSchema)
          .specs.map((s) => s.chunk_id)
          .sort(),
      ).toEqual([...CHUNK_IDS].sort());
    },
  );

  it(
    "变更记录编号跨 999 不重发不覆盖：预置 chg-999/chg-1000，新增 chg-1001/chg-1002 且既有文件字节不变",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = new VersionManager(root);
      vm.versionCreate(V);

      // 预置 chg-999.yaml 与 chg-1000.yaml（Python 历史记录形态，跨位数边界）
      seedChangeRecord(
        root,
        "chg-999",
        "prd/[PRD]-legacy#[PRD]-legacy",
        "预置 999 号记录",
      );
      seedChangeRecord(
        root,
        "chg-1000",
        "prd/[PRD]-legacy2#[PRD]-legacy2",
        "预置 1000 号记录",
      );
      const seededBefore = fileDigests(changesDirOf(root), [
        "chg-999.yaml",
        "chg-1000.yaml",
      ]);

      // 本版本新增恰好两条记录：层冻结续号 chg-1001，版本级 commit 续号 chg-1002
      await buildContent(root);
      const committed = vm.versionCommit(V);
      expect(committed.changes).toEqual(["chg-1002"]);

      expect(changeFileNames(root)).toEqual([
        "chg-1000.yaml",
        "chg-1001.yaml",
        "chg-1002.yaml",
        "chg-999.yaml",
      ]);
      // 数值最大值+1：跨 999 不重发（1001/1002，非字典序 "1000" < "999" 陷阱）
      expect(changeNumbers(root)).toEqual([999, 1000, 1001, 1002]);
      const numbers = changeNumbers(root);
      expect(new Set(numbers).size).toBe(numbers.length);

      // 既有文件原样保留（字节级不覆盖）
      expectSameDigest(
        seededBefore,
        fileDigests(changesDirOf(root), ["chg-999.yaml", "chg-1000.yaml"]),
      );
      expect(readChange(root, "chg-999").message).toBe("预置 999 号记录");
      expect(readChange(root, "chg-1000").message).toBe("预置 1000 号记录");

      // 新记录形态：编号即文件名数值、type 大写、target 为 `<file>#<chunk_id>`
      const fresh = readChange(root, "chg-1001");
      expect(fresh.id).toBe("chg-1001");
      expect(fresh.version).toBe(V);
      expect(fresh.type).toBe("ADD");
      expect(fresh.target).toBe("prd/[PRD]-demo#[PRD]-demo");
      expect(fresh.new_content).toContain("@id:[PRD]-demo");
      expect(readMeta(root, V).changes).toEqual(["chg-1001", "chg-1002"]);
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 1/2 — confirm 门禁
// ---------------------------------------------------------------------------

describe("confirm 门禁", () => {
  it(
    "六不变式违例 → INVARIANT_VIOLATION 拒绝且零落盘",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      // 注入违例：删除版本图中 PRD 根 → FSD 根的 derives 边（PRD 根 derives 数 ≠ 1）
      const graphPath = path.join(root.meta, `specgraph-${V}.yaml`);
      const graph = loadModel(graphPath, SpecGraphSchema);
      graph.edges = graph.edges.filter(
        (e) => !(e.rel === "derives" && e.src.endsWith(":[PRD]-demo")),
      );
      saveModel(graphPath, graph);

      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      await expectErrCode(vm.versionConfirm(V), "INVARIANT_VIOLATION");
      // 零落盘：docs 与 .meta 字节不变、confirmed_plan 仍为 null、
      // 不存在 plan-<v>.yaml 这类独立计划文件
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      expect(fs.existsSync(path.join(root.meta, `plan-${V}.yaml`))).toBe(false);
    },
  );

  it(
    "制品验收三态：未配置真空通过 / exit≠0 ACCEPTANCE_FAILED / 配置损坏 CONFIG_UNREADABLE",
    { timeout: T },
    async () => {
      // 未配置：真空通过（ran=false）
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        const confirm = await vm.versionConfirm(V);
        expect(confirm.acceptance).toEqual({
          ran: false,
          passed: true,
          exitCode: null,
        });
      }
      // exit≠0：ACCEPTANCE_FAILED 且零落盘
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        writeLocalConfig(root.meta, { acceptanceCommand: "exit 3" });
        const docsBefore = treeDigest(root.docs);
        const metaBefore = treeDigest(root.meta);
        await expectErrCode(vm.versionConfirm(V), "ACCEPTANCE_FAILED");
        expectSameDigest(docsBefore, treeDigest(root.docs));
        expectSameDigest(metaBefore, treeDigest(root.meta));
        expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      }
      // 配置损坏：CONFIG_UNREADABLE 拒而不放
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        fs.writeFileSync(
          path.join(root.meta, "config.local.yaml"),
          "- not\n- an\n- object\n",
        );
        await expectErrCode(vm.versionConfirm(V), "CONFIG_UNREADABLE");
        expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      }
    },
  );

  it(
    "宿主仓脏 → confirm 主动提交并绑定 code_result（新 HEAD）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      const headBefore = git(root.cwd, ["rev-parse", "HEAD"]);
      // 制造宿主脏状态（未提交改动）
      fs.mkdirSync(path.join(root.cwd, "src"), { recursive: true });
      fs.writeFileSync(path.join(root.cwd, "src", "svc.ts"), "export {};\n");
      expect(git(root.cwd, ["status", "--porcelain"])).not.toBe("");

      const confirm = await vm.versionConfirm(V);
      // 主动提交：宿主仓 clean、HEAD 前移、提交信息可辨
      expect(git(root.cwd, ["status", "--porcelain"])).toBe("");
      const headAfter = git(root.cwd, ["rev-parse", "HEAD"]);
      expect(headAfter).not.toBe(headBefore);
      expect(git(root.cwd, ["log", "-1", "--format=%s"])).toContain(
        `ait: confirm ${V}`,
      );
      // 绑定 code_result = 新 HEAD
      expect(confirm.code_result).toBe(headAfter);
      expect(readMeta(root, V).code_result).toBe(headAfter);
    },
  );

  it(
    "宿主仓 clean → 绑定 HEAD（不产生新提交）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      const headBefore = git(root.cwd, ["rev-parse", "HEAD"]);
      const confirm = await vm.versionConfirm(V);
      expect(confirm.code_result).toBe(headBefore);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(headBefore);
    },
  );

  it(
    "宿主非 git 仓 → code_result=null 跳过不报错，confirm 其余语义不变",
    { timeout: T },
    async () => {
      const { root } = makeEnv({ hostGit: false });
      const vm = await advanceToCommit(root);
      const confirm = await vm.versionConfirm(V);
      expect(confirm.passed).toBe(true);
      expect(confirm.code_result).toBe(null);
      expect(readMeta(root, V).code_result ?? null).toBe(null);
      // 其余语义不变：计划与指纹照常产出并持久化
      expect(readMeta(root, V).confirmed_plan?.input_fingerprint).toBe(
        confirm.plan_fingerprint,
      );
      expect(confirm.planned_operations).toBe(CHUNK_IDS.length);
    },
  );

  // 正式回归用例：规格树含 TDD（TDD 正文声明 target_file，视图节点携带该声明），
  // confirm 正常通过——锁死 TDD_TARGET_FILE_REQUIRED 的历史落差不再回归。
  it(
    "含 TDD 的合法规格树 confirm 通过（target_file 经视图节点携带）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = new VersionManager(root);
      vm.versionCreate(V);
      await buildContentWithTdd(root);
      const committed = vm.versionCommit(V);
      expect(committed.committed).toContain("[TDD]-demo");
      // 合法树（TDD 正文已声明 target_file）confirm 通过
      const confirm = await vm.versionConfirm(V);
      expect(confirm.passed).toBe(true);
      expect(confirm.planned_operations).toBe(4);
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 1/3/4 — merge 原子性
// ---------------------------------------------------------------------------

describe("merge 原子性", () => {
  it(
    "指纹一致原子落盘：baseline 提升（省略≠删除）+ 绑定字段 + revert_anchor + tag 创建并验证存在",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { confirm, merge } = await advanceToMerged(root);

      // baseline 提升：版本 chunk 字节落进 docs/ 对应文件
      for (const rel of [
        path.join("prd", "[PRD]-demo.md"),
        path.join("fsd", "[FSD]-demo.md"),
      ]) {
        expect(fs.existsSync(path.join(root.docs, rel))).toBe(true);
      }
      expect(
        fs.readFileSync(path.join(root.docs, "fsd", "[FSD]-demo.md"), "utf-8"),
      ).toContain("@id:[FSD]-demo");
      // 基线索引重建收录提升 chunk
      const baseline = new IndexManager(root).loadBaseline();
      expect(baseline.chunks.map((r) => r.id).sort()).toEqual(
        [...CHUNK_IDS].sort(),
      );
      // 绑定字段：phase=merged、docs_commit 落盘、code_result 保留 confirm 绑定值
      const meta = readMeta(root, V);
      expect(meta.phase).toBe("merged");
      expect(meta.merged_at).not.toBe(null);
      expect(typeof meta.docs_commit).toBe("string");
      expect(meta.code_result).toBe(confirm.code_result);
      // revert_anchor：docs_ref 为版本锚点标签，code_result 与绑定一致
      expect(meta.revert_anchor).toEqual({
        docs_ref: `refs/tags/ait/${V}`,
        code_result: meta.code_result ?? null,
      });
      // tag 创建并验证存在：refs/tags/ait/<v> 指向返回 commit
      expect(merge.tag_created).toBe(true);
      expect(
        git(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(merge.commit);
      // 版本索引与版本图保留（与 Python 一致）：status=merged、图内节点在册
      expect(new IndexManager(root).loadVersionIndex(V).status).toBe("merged");
      expect(fs.existsSync(path.join(root.root, "versions", V))).toBe(true);
      expect(
        loadModel(path.join(root.meta, `specgraph-${V}.yaml`), SpecGraphSchema)
          .specs.map((s) => s.chunk_id)
          .sort(),
      ).toEqual([...CHUNK_IDS].sort());
    },
  );

  it(
    "未 confirm → CONFIRMATION_REQUIRED；计划已过期 → CONFIRMATION_STALE，均零落盘并附 recovery 指引",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = new VersionManager(root);
      vm.versionCreate(V);
      await buildContent(root);
      vm.versionCommit(V);

      // 未 confirm（无 confirmed_plan）→ CONFIRMATION_REQUIRED 零落盘
      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const noPlan = await captureErr(versionMerge(root, V));
      expect((noPlan as { code?: unknown }).code).toBe("CONFIRMATION_REQUIRED");
      expect((noPlan as Error).message).toContain("recovery");
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(
        gitTry(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(null);

      // confirm 后篡改判定输入（版本图字节）→ 指纹过期
      await vm.versionConfirm(V);
      fs.appendFileSync(
        path.join(root.meta, `specgraph-${V}.yaml`),
        "\n# tamper after confirm\n",
      );
      const docsBefore2 = treeDigest(root.docs);
      const metaBefore2 = treeDigest(root.meta);
      const stale = await captureErr(versionMerge(root, V));
      expect((stale as { code?: unknown }).code).toBe("CONFIRMATION_STALE");
      expect((stale as Error).message).toContain("recovery");
      // 零落盘：docs/.meta 字节不变、无 tag 产生
      expectSameDigest(docsBefore2, treeDigest(root.docs));
      expectSameDigest(metaBefore2, treeDigest(root.meta));
      expect(
        gitTry(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(null);
    },
  );

  it(
    "执行阶段注入失败（已写入部分文件）→ docs 与 .meta 字节级回退到操作前，撤除故障后可重试成功",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      await advanceToConfirm(root);
      // 计划形态核对：计划只在版本元数据内，无独立 plan 文件
      expect(readMeta(root, V).confirmed_plan?.operations.length).toBe(
        CHUNK_IDS.length,
      );
      expect(fs.existsSync(path.join(root.meta, `plan-${V}.yaml`))).toBe(false);
      expect(fs.existsSync(path.join(root.meta, `changes-${V}.yaml`))).toBe(
        false,
      );

      // 操作前字节快照
      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);

      // 可控桩：applyPlan 逐文件原子写 docs，第 2 次落盘抛异常——此时首个文件
      // 已写入，正是「部分执行后回滚」的注入点（既覆盖回退语义，也覆盖重试语义）。
      ioFail.calls = 0;
      ioFail.failAfter = 1;
      const err = await captureErr(versionMerge(root, V));
      ioFail.failAfter = -1;
      ioFail.calls = 0;

      expect((err as { code?: unknown }).code).toBe("MERGE_ROLLBACK");
      expect((err as Error).message).toContain("applyPlan");
      expect((err as Error).message).toContain("可安全重试");
      // 字节级回退：docs 与 .meta 与操作前逐字节一致（部分写入被清除）
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(readMeta(root, V).phase).not.toBe("merged");

      // 撤除故障 → 重试成功
      const retry = await versionMerge(root, V);
      expect(retry.plan_fingerprint).toBe(
        readMeta(root, V).confirmed_plan?.input_fingerprint,
      );
      expect(retry.tag_created).toBe(true);
      expect(
        git(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(retry.commit);
      expect(readMeta(root, V).phase).toBe("merged");
      expect(
        new IndexManager(root).loadBaseline().chunks.map((r) => r.id).sort(),
      ).toEqual([...CHUNK_IDS].sort());
    },
  );

  it(
    "tag 引用预占冲突 → 不阻断 merge（tag_created=false，可回滚性由绑定 SHA 兜底）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      await advanceToConfirm(root);
      // 预占 tag 引用制造冲突点
      const preHead = git(root.root, ["rev-parse", "HEAD"]);
      git(root.root, ["tag", `ait/${V}`, preHead]);

      const merge = await versionMerge(root, V);
      // tag 失败不阻断：merge 成功落盘，tag_created=false
      expect(merge.tag_created).toBe(false);
      expect(merge.commit).not.toBe(null);
      expect(readMeta(root, V).phase).toBe("merged");
      expect(typeof readMeta(root, V).docs_commit).toBe("string");
      // 预占 tag 未被移动（SHA 兜底语义：绑定字段承载可回滚性）
      expect(git(root.root, ["rev-parse", `refs/tags/ait/${V}`])).toBe(preHead);
      // 绑定字段仍记录锚点 ref（解析时可回落到 SHA）
      expect(readMeta(root, V).revert_anchor?.docs_ref).toBe(
        `refs/tags/ait/${V}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 5 — revert 双态
// ---------------------------------------------------------------------------

describe("revert 双态", () => {
  it(
    "未合入版本：confirm:false 拒绝；confirm:true 物理清空工作区、索引/图/元数据与本版本 chg 文件，基线不动",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      const changeIds = readMeta(root, V).changes;
      expect(changeIds.length).toBeGreaterThan(0);

      await expectErrCode(
        vm.versionRevert(V, { confirm: false }),
        "USAGE_ERROR",
      );

      const docsBefore = treeDigest(root.docs);
      const docsHeadBefore = git(root.root, ["rev-parse", "HEAD"]);
      const res = await vm.versionRevert(V, { confirm: true });
      expect(res).toMatchObject({
        version: V,
        reverted: true,
        mode: "unmerged",
        removed_versions: [],
      });
      // 物理清空：工作区目录 + 版本索引 / 版本图 / 版本元数据
      expect(fs.existsSync(path.join(root.root, "versions", V))).toBe(false);
      for (const name of [
        path.join("versions", `${V}.yaml`),
        `chunks-index-${V}.yaml`,
        `specgraph-${V}.yaml`,
      ]) {
        expect(fs.existsSync(path.join(root.meta, name))).toBe(false);
      }
      // 本版本产生的变更记录随之消失
      //
      // 规格落差登记（如实记录，不弱化断言）：FSD version_manager 的 versionRevert
      // 要求未合入回滚「物理清空版本工作区/索引/图/**本版本产生的变更记录**」，
      // 但 src/versioning/version-manager.ts 的 purgeVersionArtifacts 先删版本元数据
      // 再调 changeIdsOfMeta（读同一份元数据取 `changes` 列表），元数据已不在，
      // changeIds 回落为空数组，chg-*.yaml 因此全部留存 —— 本断言保持红。
      for (const changeId of changeIds) {
        expect(
          fs.existsSync(path.join(changesDirOf(root), `${changeId}.yaml`)),
        ).toBe(false);
      }
      // Python 不认识的独立文件本就不存在（revert 也不应"清理"它们）
      expect(fs.existsSync(path.join(root.meta, `plan-${V}.yaml`))).toBe(false);
      expect(fs.existsSync(path.join(root.meta, `changes-${V}.yaml`))).toBe(
        false,
      );
      // 基线不动：docs 字节与 docs 仓 HEAD 零变化
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(docsHeadBefore);
    },
  );

  it(
    "merged 版本：tag 优先解析锚点，docs 仓 reset 到锚点且 clean",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, merge } = await advanceToMerged(root);
      const docsCommit = readMeta(root, V).docs_commit as string;
      expect(typeof docsCommit).toBe("string");
      // merge 已建 refs/tags/ait/<v>（指向绑定提交）；docs_commit 是更早的 docs 提交
      expect(git(root.root, ["rev-parse", `refs/tags/ait/${V}`])).toBe(
        merge.commit,
      );
      expect(docsCommit).not.toBe(merge.commit);
      // 后续提交使 docs 仓偏离锚点（保持 clean 以便 reset 后校验）
      fs.writeFileSync(
        path.join(root.root, "post-merge-docs.txt"),
        "docs 后续\n",
      );
      gitCommitAll(root.root, "post-merge docs");

      const res = await vm.versionRevert(V, { confirm: true });
      expect(res.mode).toBe("merged");
      // tag 优先：docs 锚点解析为 tag 目标（merge 最终 HEAD，≠ docs_commit）
      expect(res.docs_anchor).toBe(merge.commit);
      expect(res.docs_anchor).not.toBe(docsCommit);
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(merge.commit);
      expect(git(root.root, ["status", "--porcelain"])).toBe("");
      expect(fs.existsSync(path.join(root.root, "post-merge-docs.txt"))).toBe(
        false,
      );
      // merged 回滚不删被回滚版本自身的制品：锚点提交把它们原样带回
      expect(fs.existsSync(path.join(root.meta, `versions/${V}.yaml`))).toBe(
        true,
      );
    },
  );

  it(
    "merged 版本：tag 缺失 → 绑定字段 SHA 兜底（docs 到 docs_commit）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, merge } = await advanceToMerged(root);
      const docsCommit = readMeta(root, V).docs_commit as string;
      expect(typeof docsCommit).toBe("string");
      // 删除版本号标签 → revert_anchor.docs_ref 与 refs/tags/ait/<v> 同 ref，
      // 一并失效，只能走 docs_commit 兜底
      git(root.root, ["tag", "-d", `ait/${V}`]);
      expect(
        gitTry(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(null);
      // 构造偏离：docs 后续提交
      fs.writeFileSync(path.join(root.root, "later.txt"), "later\n");
      gitCommitAll(root.root, "later docs");

      const res = await vm.versionRevert(V, { confirm: true });
      // SHA 兜底：锚点 = 绑定 docs_commit（≠ tag 曾指向的 merge 最终 HEAD）
      expect(res.docs_anchor).toBe(docsCommit);
      expect(res.docs_anchor).not.toBe(merge.commit);
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(docsCommit);
      expect(git(root.root, ["status", "--porcelain"])).toBe("");
      expect(fs.existsSync(path.join(root.root, "later.txt"))).toBe(false);
    },
  );

  it(
    "merged 版本：双仓同步回滚，双仓到达各自锚点且 clean",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, confirm, merge } = await advanceToMerged(root);
      // 宿主侧无 refs/tags/ait/<v>，锚点解析走 revert_anchor.code_result → code_base；
      // confirm 已绑定 code_result，故宿主锚点可达
      expect(confirm.code_result).not.toBe(null);
      expect(readMeta(root, V).revert_anchor?.code_result).toBe(
        confirm.code_result,
      );
      // 双仓后续提交（保持 clean 以便 reset 后校验）
      fs.writeFileSync(path.join(root.root, "post-docs.txt"), "docs 后续\n");
      gitCommitAll(root.root, "post docs");
      fs.writeFileSync(path.join(root.cwd, "post-host.txt"), "host 后续\n");
      gitCommitAll(root.cwd, "post host");

      const res = await vm.versionRevert(V, { confirm: true });
      expect(res.mode).toBe("merged");
      expect(res.docs_anchor).toBe(merge.commit);
      expect(res.host_anchor).toBe(confirm.code_result);
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(merge.commit);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(confirm.code_result);
      expect(git(root.root, ["status", "--porcelain"])).toBe("");
      expect(git(root.cwd, ["status", "--porcelain"])).toBe("");
      // 双仓后续提交内容都被物理回退
      expect(fs.existsSync(path.join(root.root, "post-docs.txt"))).toBe(false);
      expect(fs.existsSync(path.join(root.cwd, "post-host.txt"))).toBe(false);
    },
  );

  it(
    "merged 版本：单仓 reset 失败（宿主 index.lock 占用）→ 双仓恢复操作前状态",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, merge } = await advanceToMerged(root);
      // docs 后续提交（确保 docs reset 真实发生后才需要补偿）
      fs.writeFileSync(path.join(root.root, "later.txt"), "later\n");
      gitCommitAll(root.root, "later docs");
      const docsHeadBefore = git(root.root, ["rev-parse", "HEAD"]);
      const hostHeadBefore = git(root.cwd, ["rev-parse", "HEAD"]);
      // 宿主锚点须可解析，否则预检即拒、进不到 reset 阶段
      expect(readMeta(root, V).revert_anchor?.code_result).toBe(hostHeadBefore);
      expect(merge.commit).not.toBe(null);

      // 可控桩：占用宿主仓 index（.git/index.lock）使宿主 reset 必然失败
      const lock = path.join(root.cwd, ".git", "index.lock");
      fs.writeFileSync(lock, "");
      let err: unknown;
      try {
        err = await captureErr(vm.versionRevert(V, { confirm: true }));
      } finally {
        fs.rmSync(lock, { force: true });
      }
      expect((err as { code?: unknown }).code).toBe("REVERT_FAILED");
      // 补偿：docs 仓已恢复操作前 HEAD；宿主仓未动
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(docsHeadBefore);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(hostHeadBefore);
      // 版本身份未被回退（仍为 merged，可重试）
      expect(readMeta(root, V).phase).toBe("merged");
    },
  );

  it(
    "merged 版本：docs 锚点不可解析 → REVERT_PRECHECK_FAILED 零写入",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm } = await advanceToMerged(root);
      // 破坏全部 docs 锚点：删版本号标签 + 绑定 docs_commit 置为不存在的 SHA
      git(root.root, ["tag", "-d", `ait/${V}`]);
      const meta = readMeta(root, V);
      meta.docs_commit = "0".repeat(40);
      saveModel(metaPathOf(root, V), meta);
      // 宿主锚点仍可解析（code_result 未动）：docs 锚点失守即预检拒绝
      expect(readMeta(root, V).revert_anchor?.code_result).not.toBe(null);

      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const docsHeadBefore = git(root.root, ["rev-parse", "HEAD"]);
      const hostHeadBefore = git(root.cwd, ["rev-parse", "HEAD"]);

      const err = await captureErr(vm.versionRevert(V, { confirm: true }));
      expect((err as { code?: unknown }).code).toBe("REVERT_PRECHECK_FAILED");
      // 零写入：docs/.meta 字节、双仓 HEAD 与补偿基准零变化
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(docsHeadBefore);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(hostHeadBefore);
      expect(readMeta(root, V).recovery_journal ?? null).toBe(null);
    },
  );

  it(
    "merged 版本：绑定但不可解析的宿主锚点 → REVERT_PRECHECK_FAILED 零写入",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm } = await advanceToMerged(root);
      // docs 锚点保持可解析（tag 在册）；把宿主锚点全改为不存在的 SHA
      const meta = readMeta(root, V);
      const bogus = "1".repeat(40);
      meta.code_base = bogus;
      meta.code_result = bogus;
      meta.revert_anchor = {
        docs_ref: `refs/tags/ait/${V}`,
        code_result: bogus,
      };
      saveModel(metaPathOf(root, V), meta);

      const metaBefore = treeDigest(root.meta);
      const docsHeadBefore = git(root.root, ["rev-parse", "HEAD"]);
      const hostHeadBefore = git(root.cwd, ["rev-parse", "HEAD"]);

      const err = await captureErr(vm.versionRevert(V, { confirm: true }));
      expect((err as { code?: unknown }).code).toBe("REVERT_PRECHECK_FAILED");
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(git(root.root, ["rev-parse", "HEAD"])).toBe(docsHeadBefore);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(hostHeadBefore);
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 6 — publish
// ---------------------------------------------------------------------------

describe("publish", () => {
  /** 建 bare 远端 + 上游；返回 bare 路径（posix 形态）。 */
  function setupRemote(repoDir: string, name: string): string {
    const holder = mkTmp();
    const bare = path.join(holder, `${name}.git`);
    git(holder, ["init", "--bare", bare]);
    git(repoDir, ["remote", "add", "origin", bare.replace(/\\/g, "/")]);
    git(repoDir, ["push", "-u", "origin", "main"]);
    return bare;
  }

  it("验收三态：未配置真空通过 / exit=0 通过 / exit≠0 失败", () => {
    const { root } = makeEnv();
    // 未配置：真空通过，与损坏严格区分
    expect(acceptanceShow(root)).toBe(null);
    expect(runAcceptance(root)).toEqual({
      ran: false,
      passed: true,
      exitCode: null,
    });
    // 通过
    acceptanceSet(root, "exit 0");
    expect(acceptanceShow(root)).toBe("exit 0");
    expect(runAcceptance(root)).toEqual({
      ran: true,
      passed: true,
      exitCode: 0,
    });
    // 失败：exit≠0 → passed=false（错误码由调用方决定）
    acceptanceSet(root, "exit 7");
    expect(runAcceptance(root)).toEqual({
      ran: true,
      passed: false,
      exitCode: 7,
    });
  });

  it(
    "双仓一体发布：按序推送（先宿主后文档）含版本锚点标签",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const bareHost = setupRemote(root.cwd, "host-remote");
      const bareDocs = setupRemote(root.root, "docs-remote");
      // 双仓各有待推提交；docs 仓带版本锚点标签
      fs.writeFileSync(path.join(root.cwd, "feature.txt"), "host 待推\n");
      gitCommitAll(root.cwd, "host feature");
      fs.writeFileSync(path.join(root.root, "notes.txt"), "docs 待推\n");
      gitCommitAll(root.root, "docs notes");
      git(root.root, ["tag", `ait/${V}`]);
      const hostHead = git(root.cwd, ["rev-parse", "HEAD"]);
      const docsHead = git(root.root, ["rev-parse", "HEAD"]);

      const report = await push(root);
      expect(report.host.status).toBe("pushed");
      expect(report.host.detail).toContain("宿主仓");
      expect(report.docs.status).toBe("pushed");
      expect(report.docs.detail).toContain("文档仓");
      expect(report.docs.detail).toContain(`ait/${V}`);
      // 远端收敛：分支与锚点标签随行
      expect(gitBare(bareHost, ["rev-parse", "main"])).toBe(hostHead);
      expect(gitBare(bareDocs, ["rev-parse", "main"])).toBe(docsHead);
      expect(
        gitBare(bareDocs, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(docsHead);
      // 幂等重跑：双双 nothing
      const again = await push(root);
      expect(again.host.status).toBe("nothing");
      expect(again.docs.status).toBe("nothing");
    },
  );

  it(
    "无远端 / 无上游 → failed + 稳定错误码（PUSH_NO_REMOTE / PUSH_NO_UPSTREAM），不静默跳过",
    { timeout: T },
    async () => {
      // 无远端
      {
        const { root } = makeEnv();
        fs.writeFileSync(path.join(root.cwd, "a.txt"), "a\n");
        gitCommitAll(root.cwd, "host a");
        fs.writeFileSync(path.join(root.root, "b.txt"), "b\n");
        gitCommitAll(root.root, "docs b");
        const report = await push(root);
        expect(report.host.status).toBe("failed");
        expect(report.host.detail).toContain("PUSH_NO_REMOTE");
        expect(report.docs.status).toBe("failed");
        expect(report.docs.detail).toContain("PUSH_NO_REMOTE");
      }
      // 有远端但无上游
      {
        const { root } = makeEnv();
        const holder = mkTmp();
        const bare = path.join(holder, "r.git");
        git(holder, ["init", "--bare", bare]);
        const url = bare.replace(/\\/g, "/");
        git(root.cwd, ["remote", "add", "origin", url]);
        git(root.root, ["remote", "add", "origin", url]);
        const report = await push(root);
        expect(report.host.status).toBe("failed");
        expect(report.host.detail).toContain("PUSH_NO_UPSTREAM");
        expect(report.docs.status).toBe("failed");
        expect(report.docs.detail).toContain("PUSH_NO_UPSTREAM");
      }
    },
  );

  it(
    "单仓失败标明失败仓，不回滚成功侧",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      // docs 仓可推；宿主仓无远端（失败侧）
      const bareDocs = setupRemote(root.root, "docs-remote");
      fs.writeFileSync(path.join(root.root, "notes.txt"), "docs 待推\n");
      gitCommitAll(root.root, "docs notes");
      const docsHead = git(root.root, ["rev-parse", "HEAD"]);

      const report = await push(root);
      expect(report.host.status).toBe("failed");
      expect(report.host.detail).toContain("PUSH_NO_REMOTE");
      expect(report.docs.status).toBe("pushed");
      // 成功侧不回滚：docs 远端已收敛
      expect(gitBare(bareDocs, ["rev-parse", "main"])).toBe(docsHead);
    },
  );

  it(
    "dryRun 只列待推提交与标签，不推送",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const bareHost = setupRemote(root.cwd, "host-remote");
      const bareDocs = setupRemote(root.root, "docs-remote");
      fs.writeFileSync(path.join(root.cwd, "feature.txt"), "host 待推\n");
      gitCommitAll(root.cwd, "host feature");
      fs.writeFileSync(path.join(root.root, "notes.txt"), "docs 待推\n");
      gitCommitAll(root.root, "docs notes");
      git(root.root, ["tag", `ait/${V}`]);
      const bareHostMain = gitBare(bareHost, ["rev-parse", "main"]);
      const bareDocsMain = gitBare(bareDocs, ["rev-parse", "main"]);

      const report = await push(root, { dryRun: true });
      expect(report.host.status).toBe("nothing");
      expect(report.host.detail).toContain("dry-run");
      expect(report.host.detail).toContain("待推提交 1 个");
      expect(report.docs.status).toBe("nothing");
      expect(report.docs.detail).toContain("dry-run");
      expect(report.docs.detail).toContain(`ait/${V}`);
      // 远端零变化：分支未前移、标签未随行
      expect(gitBare(bareHost, ["rev-parse", "main"])).toBe(bareHostMain);
      expect(gitBare(bareDocs, ["rev-parse", "main"])).toBe(bareDocsMain);
      expect(
        gitBare(bareDocs, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(null);
    },
  );

  it(
    "宿主非 git 仓 → not_applicable 标明，只发文档仓",
    { timeout: T },
    async () => {
      const { root } = makeEnv({ hostGit: false });
      const bareDocs = setupRemote(root.root, "docs-remote");
      fs.writeFileSync(path.join(root.root, "notes.txt"), "docs 待推\n");
      gitCommitAll(root.root, "docs notes");
      const docsHead = git(root.root, ["rev-parse", "HEAD"]);

      const report = await push(root);
      expect(report.host.status).toBe("not_applicable");
      expect(report.host.detail).toContain("非 git 仓");
      expect(report.docs.status).toBe("pushed");
      expect(gitBare(bareDocs, ["rev-parse", "main"])).toBe(docsHead);
    },
  );
});

// ---------------------------------------------------------------------------
// :TEST 5/7 — backfill-tags（幂等补齐已合入版本的 docs 锚点标签）
// ---------------------------------------------------------------------------
//
// 判定顺序（version_manager 实现逻辑 §7）：非 git 宿主 → 无 anchor →
// tag 已存在 → 无 docs_commit → 以 docs_commit 重建。故 no_docs_commit 用例
// 必须先删掉标签，否则会先命中 tag_present。

describe("backfill-tags", () => {
  it(
    "缺标签 → 以 docs_commit 补建 ait/<v>，记入 backfilled，不改写版本元数据",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, merge } = await advanceToMerged(root);
      const docsCommit = readMeta(root, V).docs_commit as string;
      expect(typeof docsCommit).toBe("string");
      // merge 建在绑定提交上；docs_commit 是更早的 docs 提交，二者不同
      expect(docsCommit).not.toBe(merge.commit);

      // 抹掉标签 → 进入 backfill 的补建分支
      git(root.root, ["tag", "-d", `ait/${V}`]);
      expect(
        gitTry(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(null);
      const metaBefore = treeDigest(root.meta);

      const res = vm.backfillRevertTags();
      expect(res.git).toBe("committed");
      expect(res.backfilled).toEqual([V]);
      expect(res.skipped).toEqual([]);
      // 标签重新指向绑定字段 docs_commit（不是 merge 的绑定提交）
      expect(
        git(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
      ).toBe(docsCommit);
      // 只建标签：版本元数据逐字节不变
      expectSameDigest(metaBefore, treeDigest(root.meta));
    },
  );

  it(
    "标签已存在 → skipped(tag_present)，既有标签不被移动",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm, merge } = await advanceToMerged(root);
      expect(
        git(root.root, ["rev-parse", `refs/tags/ait/${V}`]),
      ).toBe(merge.commit);

      const res = vm.backfillRevertTags();
      expect(res.git).toBe("committed");
      expect(res.backfilled).toEqual([]);
      expect(res.skipped).toEqual([{ version: V, reason: "tag_present" }]);
      // 标签原样保留（非 -f 重建，不指向 docs_commit）
      expect(git(root.root, ["rev-parse", `refs/tags/ait/${V}`])).toBe(
        merge.commit,
      );
    },
  );

  it(
    "已合入但缺 docs_commit → skipped(no_docs_commit)；无 anchor → skipped(no_anchor)",
    { timeout: T },
    async () => {
      // 缺 docs_commit：anchor 在册、标签已删，才轮到 no_docs_commit 判定
      {
        const { root } = makeEnv();
        const { vm } = await advanceToMerged(root);
        git(root.root, ["tag", "-d", `ait/${V}`]);
        const meta = readMeta(root, V);
        expect(meta.revert_anchor?.docs_ref).toBe(`refs/tags/ait/${V}`);
        meta.docs_commit = null;
        saveModel(metaPathOf(root, V), meta);

        const res = vm.backfillRevertTags();
        expect(res.git).toBe("committed");
        expect(res.backfilled).toEqual([]);
        expect(res.skipped).toEqual([{ version: V, reason: "no_docs_commit" }]);
        expect(
          gitTry(root.root, ["rev-parse", "--verify", `refs/tags/ait/${V}`]),
        ).toBe(null);
      }
      // 无 anchor：revert_anchor 缺失优先于 tag 存在性判定
      {
        const { root } = makeEnv();
        const { vm } = await advanceToMerged(root);
        const meta = readMeta(root, V);
        meta.revert_anchor = null;
        saveModel(metaPathOf(root, V), meta);

        const res = vm.backfillRevertTags();
        expect(res.backfilled).toEqual([]);
        expect(res.skipped).toEqual([{ version: V, reason: "no_anchor" }]);
      }
    },
  );

  it(
    "非 git 宿主（docs 非仓）→ git=unavailable，不报错",
    { timeout: T },
    async () => {
      // docs 非 git 仓时，宿主仓也必须非 git：isGitRepo(root.root) 走
      // `git rev-parse --git-dir`，会向上级目录探测，父目录是宿主 git 仓时
      // project-docs 会被判为「仓内子目录」而非非 git 宿主。
      const { root } = makeEnv({ docsGit: false, hostGit: false });
      const res = new VersionManager(root).backfillRevertTags();
      expect(res).toEqual({ backfilled: [], skipped: [], git: "unavailable" });
    },
  );

  it(
    "重复执行幂等：二次全部 skipped(tag_present)，标签与 .meta 零变化",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const { vm } = await advanceToMerged(root);
      const docsCommit = readMeta(root, V).docs_commit as string;
      git(root.root, ["tag", "-d", `ait/${V}`]);

      const first = vm.backfillRevertTags();
      expect(first.backfilled).toEqual([V]);
      const metaAfterFirst = treeDigest(root.meta);
      const tagAfterFirst = git(root.root, ["rev-parse", `refs/tags/ait/${V}`]);
      expect(tagAfterFirst).toBe(docsCommit);

      const second = vm.backfillRevertTags();
      expect(second.git).toBe("committed");
      expect(second.backfilled).toEqual([]);
      expect(second.skipped).toEqual([{ version: V, reason: "tag_present" }]);
      expect(git(root.root, ["rev-parse", `refs/tags/ait/${V}`])).toBe(
        tagAfterFirst,
      );
      expectSameDigest(metaAfterFirst, treeDigest(root.meta));
    },
  );
});

// ---------------------------------------------------------------------------
// 读取诊断（version workspace 取 chunk 正文的三类根因，不得混同）
// ---------------------------------------------------------------------------
//
// `chunkContent`（version-manager 内部）只读一次工作区文件再按文本解析，三种
// 根因的分界是**解析是否成功**，不是「有没有拿到正文」：
//   文件不存在                  → MERGE_SOURCE_MISSING
//   文件存在但其中无该 chunk    → MERGE_SOURCE_MISSING
//   文件存在但解析失败（重复 id）→ CHUNK_PARSE_ERROR（带 file 与 line）
// 第三条错在 parseText 里抛 ChunkParseError，调用方不得吞成 null 再报「源缺失」。
// 三者都发生在 buildReconciliation（confirm 第 ④ 步）之前对文档的读取上，
// 故均属零落盘拒绝：confirmed_plan 不写、docs 与 .meta 字节不变。

/** 版本工作区里某索引条目对应的文档绝对路径（`file` 不含扩展名）。 */
function workspaceDocPath(root: ProjectRoot, file: string): string {
  return path.join(root.root, "versions", V, `${file}.md`);
}

/**
 * 构造「同一文档内重复 chunk id」的正文：原文档的 header + 原样的 chunk 块，
 * 再追加一份目标 chunk 块。第二个 @id 注释因此落在可预测的行上，
 * 用于核对 CHUNK_PARSE_ERROR 携带的 `line`。
 */
function duplicateChunkText(original: string, chunkId: string): string {
  const marker = `<!-- @id:${chunkId} -->`;
  const at = original.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const header = original.slice(0, at).replace(/\n+$/, "");
  const chunk = original.slice(at).replace(/\n+$/, "");
  const text = [header, "", chunk, "", chunk].join("\n");
  // 第二个 id 注释所在行（1 基）即解析报错行
  const secondAt = text.lastIndexOf(marker);
  const line = text.slice(0, secondAt).split("\n").length;
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** 从文档中移除某个 chunk 块（其余内容原样保留，不引入重复 id）。 */
function dropChunkText(original: string, chunkId: string): string {
  const marker = `<!-- @id:${chunkId} -->`;
  const at = original.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = original.slice(at + marker.length);
  const next = rest.search(/^\s*<!--\s*@id:/m);
  const end = next === -1 ? original.length : at + marker.length + next;
  return original.slice(0, at) + original.slice(end);
}

describe("读取诊断", () => {
  it(
    "版本工作区文档重复 chunk id → CHUNK_PARSE_ERROR，带文件与行号，零落盘",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      const entry = new IndexManager(root)
        .loadVersionIndex(V)
        .chunks.find((c) => c.id === "[PRD]-demo");
      expect(entry).toBeDefined();
      const doc = workspaceDocPath(root, entry?.file as string);
      expect(fs.existsSync(doc)).toBe(true);

      // 前置对照：同一文件在此之前可正常读出该 chunk（损坏点唯一）
      const original = fs.readFileSync(doc, "utf-8");
      expect(original).toContain("<!-- @id:[PRD]-demo -->");
      const broken = duplicateChunkText(original, "[PRD]-demo");
      expect(broken.split("<!-- @id:[PRD]-demo -->").length - 1).toBe(2);
      const firstMarkerAt = broken.indexOf("<!-- @id:[PRD]-demo -->");
      const expectedLine = broken
        .slice(0, broken.lastIndexOf("<!-- @id:[PRD]-demo -->"))
        .split("\n").length;
      const firstLine = broken.slice(0, firstMarkerAt).split("\n").length;
      expect(expectedLine).toBeGreaterThan(firstLine);

      fs.writeFileSync(doc, broken);

      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const err = await captureErr(vm.versionConfirm(V));

      // 根因一：文档解析错误（不是源缺失）
      expect((err as { code?: unknown }).code).toBe("CHUNK_PARSE_ERROR");
      expect((err as { code?: unknown }).code).not.toBe("MERGE_SOURCE_MISSING");
      expect((err as { code?: unknown }).code).not.toBe("MERGE_TARGET_MISSING");
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("ChunkParseError");
      // 带文件（相对版本工作区根的 posix 路径）与行号：`line` 指向重复出现处，
      // 消息里另注明首个出现位置
      expect((err as { file?: unknown }).file).toBe(`${entry?.file}.md`);
      expect((err as { line?: unknown }).line).toBe(expectedLine);
      expect((err as Error).message).toContain("[PRD]-demo");
      expect((err as Error).message).toContain("重复 chunk id");
      expect((err as Error).message).toContain(`首个出现于第 ${firstLine} 行`);

      // 零落盘：docs/.meta 逐字节不变、confirmed_plan 未写
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);

      // merge 入口同源读取同样拒绝（计划从未产出，进不到执行阶段）
      const mergeErr = await captureErr(versionMerge(root, V));
      expect((mergeErr as { code?: unknown }).code).toBe(
        "CONFIRMATION_REQUIRED",
      );
    },
  );

  it(
    "版本工作区文件缺失 / 文件内无该 chunk → MERGE_SOURCE_MISSING（不报解析错误）",
    { timeout: T },
    async () => {
      // 文件缺失
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        const entry = new IndexManager(root)
          .loadVersionIndex(V)
          .chunks.find((c) => c.id === "[PRD]-demo");
        const doc = workspaceDocPath(root, entry?.file as string);
        expect(fs.existsSync(doc)).toBe(true);
        fs.rmSync(doc);

        const docsBefore = treeDigest(root.docs);
        const metaBefore = treeDigest(root.meta);
        const err = await captureErr(vm.versionConfirm(V));
        expect((err as { code?: unknown }).code).toBe("MERGE_SOURCE_MISSING");
        expect((err as { code?: unknown }).code).not.toBe("CHUNK_PARSE_ERROR");
        expect((err as Error).message).toContain("[PRD]-demo");
        expectSameDigest(docsBefore, treeDigest(root.docs));
        expectSameDigest(metaBefore, treeDigest(root.meta));
        expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      }
      // 文件存在但其中无该 chunk
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        const entry = new IndexManager(root)
          .loadVersionIndex(V)
          .chunks.find((c) => c.id === "[PRD]-demo");
        const doc = workspaceDocPath(root, entry?.file as string);
        const original = fs.readFileSync(doc, "utf-8");
        // 去掉该 chunk 块：文件仍可解析（无重复 id），只是不含目标 chunk
        fs.writeFileSync(doc, dropChunkText(original, "[PRD]-demo"));
        expect(fs.readFileSync(doc, "utf-8")).not.toContain(
          "<!-- @id:[PRD]-demo -->",
        );

        const docsBefore = treeDigest(root.docs);
        const err = await captureErr(vm.versionConfirm(V));
        expect((err as { code?: unknown }).code).toBe("MERGE_SOURCE_MISSING");
        expect((err as { code?: unknown }).code).not.toBe("CHUNK_PARSE_ERROR");
        expect((err as { line?: unknown }).line).toBeUndefined();
        expectSameDigest(docsBefore, treeDigest(root.docs));
        expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      }
      // 索引记录指向的工作区文件根本不存在（非本版本正常写路径产生的条目）
      {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        const im = new IndexManager(root);
        const index = im.loadVersionIndex(V);
        const entry = index.chunks.find((c) => c.id === "[PRD]-demo");
        expect(entry).toBeDefined();
        index.chunks.push({
          ...(entry as NonNullable<typeof entry>),
          id: "[PRD]-ghost",
          file: "prd/[PRD]-ghost",
          state: "committed",
        });
        im.saveVersionIndex(index);
        expect(
          fs.existsSync(workspaceDocPath(root, "prd/[PRD]-ghost")),
        ).toBe(false);

        const err = await captureErr(vm.versionConfirm(V));
        expect((err as { code?: unknown }).code).toBe("MERGE_SOURCE_MISSING");
        expect((err as { code?: unknown }).code).not.toBe("CHUNK_PARSE_ERROR");
        expect((err as Error).message).toContain("[PRD]-ghost");
        expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      }
    },
  );

  it(
    "三类根因不混同：只有文档解析失败报 CHUNK_PARSE_ERROR，缺失一律 MERGE_SOURCE_MISSING，健康路径照常通过",
    { timeout: T },
    async () => {
      /** 结果码：成功记为 `ok`，失败取错误码（不假设三者都会失败）。 */
      const outcomeOf = async (
        label: string,
        body: (doc: string) => void,
      ): Promise<string> => {
        const { root } = makeEnv();
        const vm = await advanceToCommit(root);
        const entry = new IndexManager(root)
          .loadVersionIndex(V)
          .chunks.find((c) => c.id === "[PRD]-demo");
        const doc = workspaceDocPath(root, entry?.file as string);
        body(doc);
        try {
          const confirm = await vm.versionConfirm(V);
          if (confirm.passed && confirm.planned_operations === CHUNK_IDS.length) {
            return "ok";
          }
          return `unexpected:${JSON.stringify(confirm)}`;
        } catch (err) {
          return String((err as { code?: unknown }).code);
        }
      };

      const healthy = await outcomeOf("文件与 chunk 齐备", () => {});
      const noChunk = await outcomeOf("文件内无该 chunk", (doc) => {
        const original = fs.readFileSync(doc, "utf-8");
        fs.writeFileSync(doc, dropChunkText(original, "[PRD]-demo"));
      });
      const noFile = await outcomeOf("文件缺失", (doc) => {
        fs.rmSync(doc);
      });
      const unparsable = await outcomeOf("文档解析失败", (doc) => {
        const original = fs.readFileSync(doc, "utf-8");
        fs.writeFileSync(doc, duplicateChunkText(original, "[PRD]-demo"));
      });

      // 对照：健康工作区正常通过，证明上面三种失败都来自被注入的那一处
      expect(healthy).toBe("ok");
      // 缺失类两种根因归同一码
      expect(noChunk).toBe("MERGE_SOURCE_MISSING");
      expect(noFile).toBe("MERGE_SOURCE_MISSING");
      // 解析类独占另一码，不被吞成源缺失
      expect(unparsable).toBe("CHUNK_PARSE_ERROR");
      // 严格二分：三类根因落在两个互不相交的码上，且没有任何第三种码混入
      expect(new Set([noChunk, noFile, unparsable])).toEqual(
        new Set(["MERGE_SOURCE_MISSING", "CHUNK_PARSE_ERROR"]),
      );
      expect(unparsable).not.toBe(noFile);
      expect(unparsable).not.toBe(noChunk);
    },
  );
});

// ---------------------------------------------------------------------------
// override 冲突门禁（改名的写时放行、confirm 拒绝、合并安全）
// ---------------------------------------------------------------------------
//
// 两条规则（与 Python `_assert_no_override_conflicts` 同规则）只在版本记录的
// `id`/`overrides`/`action` 上判定，与文档正文无关：
//   MODIFY_RENAME_COLLISION —— modify 且 id≠overrides 且 id 已存在于基线；
//   DUPLICATE_OVERRIDES_TARGET —— 两条 modify/delete 记录的有效目标
//   `overrides ?? id` 相同且持有者不同。
// 二者均属 confirm 门禁（buildReconciliation 与 versionConfirm 同源判定），
// **create 不拦截**：写时只记下 overrides，冲突要到 confirm 组合全局视图时才可见。

/** 冲突门禁用例的基线版本（先合入，作为 v0.4 的比对基准）。 */
const OVERRIDE_BASE = "v0.1";

const SEED_PRD_DEMO = PRD_DOC;
const SEED_FSD_DEMO = FSD_DOC;
const SEED_PRD_NEW = PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-new").replaceAll("demo", "new");
const SEED_FSD_NEW = FSD_DOC.replaceAll("[FSD]-demo", "[FSD]-new").replaceAll("demo", "new");

/** 合法 PRD 需求夹具，供正文完整性回归使用。 */
function seedRequirement(id: string, title: string): string {
  return [
    `<!-- @id:${id} -->`,
    `## 需求：${title}`,
    "",
    "### 功能描述",
    `${title}的需求文本。`,
    "",
    "**用户故事:** 作为维护者，我希望调整该需求，以便治理。",
    "",
    "#### 验收标准",
    "",
    "1. WHEN 版本确认与合入完成 THEN 系统 SHALL 能够从基线查到该需求。",
  ].join("\n");
}

/** 根改名种子树：[PRD]-demo→[FSD]-demo 与 [PRD]-new→[FSD]-new。 */
async function buildSeedContent(root: ProjectRoot): Promise<void> {
  const mgr = new NewModelManager(root);
  await mgr.createDocument("prd", "[PRD]-demo", {
    content: SEED_PRD_DEMO,
    skipContext: true,
  });
  await mgr.createDocument("prd", "[PRD]-new", {
    content: SEED_PRD_NEW,
    skipContext: true,
  });
  mgr.confirmLayer("prd");
  await mgr.createDocument("fsd", "[FSD]-demo", {
    content: SEED_FSD_DEMO,
    parent: "[PRD]-demo",
    skipContext: true,
  });
  await mgr.createDocument("fsd", "[FSD]-new", {
    content: SEED_FSD_NEW,
    parent: "[PRD]-new",
    skipContext: true,
  });
  mgr.confirmLayer("fsd");
}

/**
 * 合入种子基线版本：基线因此含 `[PRD]-demo`、`[PRD]-new`、
 * `[FSD]-demo`、`[FSD]-new`，以及两条 PRD 根 → FSD 根的 derives 边。
 *
 * 基线必须经真实 merge 落成——override 冲突判定读的是**基线索引**
 * （`.meta/chunks-index.yaml`），手写 docs 而不重建索引会让判定落空。
 */
async function seedOverrideBaseline(root: ProjectRoot): Promise<void> {
  const vm = new VersionManager(root);
  vm.versionCreate(OVERRIDE_BASE);
  await buildSeedContent(root);
  // 两层冻结已提交本层条目，此处无剩余 working 条目（COMMIT_EMPTY 是正确结果）
  const commitErr = await captureErr(
    Promise.resolve().then(() => vm.versionCommit(OVERRIDE_BASE)),
  );
  expect((commitErr as { code?: unknown }).code).toBe("COMMIT_EMPTY");
  await vm.versionConfirm(OVERRIDE_BASE);
  await versionMerge(root, OVERRIDE_BASE);
}

/** 基线索引中的 chunk id（判定输入，非持久化形态断言）。 */
function baselineIds(root: ProjectRoot): string[] {
  return new IndexManager(root)
    .loadBaseline()
    .chunks.map((r) => r.id)
    .sort();
}

/** `prd create` 的冲突用例公共参数：显式 modify + overrides，跳过讨论上下文。 */
function prdOverrideArgs(
  id: string,
  overrides: string,
  content: string,
): string[] {
  return [
    "prd",
    "create",
    id,
    "--action",
    "modify",
    "--overrides",
    overrides,
    "--content",
    content,
    "--skip-context",
  ];
}

describe("override 冲突门禁", () => {
  it(
    "基线含 [PRD]-new：prd create [PRD]-new --overrides [PRD]-demo 成功（create 不拦截），version confirm 拒绝 MODIFY_RENAME_COLLISION 且 docs/.meta 零落盘",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      await seedOverrideBaseline(root);
      // 前置：基线确实含新 id 与改名源
      expect(baselineIds(root)).toEqual([
        "[FSD]-demo",
        "[FSD]-new",
        "[PRD]-demo",
        "[PRD]-new",
      ]);

      const vm = new VersionManager(root);
      vm.versionCreate(V);

      // create 不拦截：写时只记 overrides，不判全局冲突
      const written = await dispatchOk(
        root.cwd,
        prdOverrideArgs(
          "[PRD]-new",
          "[PRD]-demo",
          SEED_PRD_NEW,
        ),
      );
      expect(written["mode"]).toBe("written");
      expect(written["id"]).toBe("[PRD]-new");
      // 版本索引记下了改名意图（id 与 overrides 不同）
      const created = new IndexManager(root)
        .loadVersionIndex(V)
        .chunks.find((r) => r.id === "[PRD]-new");
      expect(created?.action).toBe("modify");
      expect(created?.overrides).toBe("[PRD]-demo");

      // 提交后进入 confirm 判定输入
      const committed = vm.versionCommit(V);
      expect(committed.committed).toEqual(["[PRD]-new"]);

      // confirm：override 冲突门禁以自身 code 拒绝（不泛化为 INVARIANT_VIOLATION）
      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const headBefore = git(root.cwd, ["rev-parse", "HEAD"]);
      const err = await captureErr(vm.versionConfirm(V));
      expect((err as { code?: unknown }).code).toBe("MODIFY_RENAME_COLLISION");
      expect((err as Error).message).toContain("[PRD]-new");
      expect((err as Error).message).toContain("[PRD]-demo");

      // 零落盘：docs 与 .meta 逐字节不变（confirmed_plan 未写、code_result 未绑定）
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
      expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(headBefore);
      // 不存在 Python 不认识的独立计划文件
      expect(fs.existsSync(path.join(root.meta, `plan-${V}.yaml`))).toBe(false);
    },
  );

  it(
    "两条 modify 记录以不同 id 指向同一 override 目标：version confirm 拒绝 DUPLICATE_OVERRIDES_TARGET 且零落盘",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      await seedOverrideBaseline(root);

      const vm = new VersionManager(root);
      vm.versionCreate(V);
      // 两条记录同持 [PRD]-demo 为有效目标（overrides 相同、持有者不同）
      await dispatchOk(
        root.cwd,
        prdOverrideArgs(
          "[PRD]-renamed",
          "[PRD]-demo",
          PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-renamed"),
        ),
      );
      await dispatchOk(
        root.cwd,
        prdOverrideArgs(
          "[PRD]-other",
          "[PRD]-demo",
          PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-other"),
        ),
      );
      const committed = vm.versionCommit(V);
      expect(committed.committed).toEqual([
        "[PRD]-renamed",
        "[PRD]-other",
      ]);

      const docsBefore = treeDigest(root.docs);
      const metaBefore = treeDigest(root.meta);
      const err = await captureErr(vm.versionConfirm(V));
      expect((err as { code?: unknown }).code).toBe(
        "DUPLICATE_OVERRIDES_TARGET",
      );
      expect((err as Error).message).toContain("[PRD]-demo");
      // 零落盘
      expectSameDigest(docsBefore, treeDigest(root.docs));
      expectSameDigest(metaBefore, treeDigest(root.meta));
      expect(readMeta(root, V).confirmed_plan ?? null).toBe(null);
    },
  );

  it(
    "合法改名（基线不含新 id）：version confirm 通过，计划中该操作指向原名（不误报冲突）",
    { timeout: T },
    async () => {
      const { root } = makeEnv();
      await seedOverrideBaseline(root);
      // 前置：新 id 不在基线，改名源在基线
      expect(baselineIds(root)).not.toContain("[PRD]-renamed");
      expect(baselineIds(root)).toContain("[PRD]-demo");

      const vm = new VersionManager(root);
      vm.versionCreate(V);
      await dispatchOk(
        root.cwd,
        prdOverrideArgs(
          "[PRD]-renamed",
          "[PRD]-demo",
          PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-renamed"),
        ).concat(["--file", "[PRD]-demo.md"]),
      );
      const committed = vm.versionCommit(V);
      expect(committed.committed).toEqual(["[PRD]-renamed"]);

      const confirm = await vm.versionConfirm(V);
      expect(confirm.passed).toBe(true);
      expect(confirm.planned_operations).toBe(1);

      const plan = readMeta(root, V).confirmed_plan;
      expect(plan?.operations.length).toBe(1);
      const [op] = plan?.operations ?? [];
      // 基线不含新 id → 不误报冲突；改名不产生重复 @id
      expect(op?.chunk_id).toBe("[PRD]-renamed");
      // 根改名保留 modify；目标为基线中的原根。
      expect(op?.action).toBe("modify");
      expect(op?.target_id).toBe("[PRD]-demo");
      // 目标文件取基线条目的 file（改名落在同一文档里）
      expect(op?.file).toBe("prd/[PRD]-demo");
    },
  );
});


// ---------------------------------------------------------------------------
// v0.10 — 真实交付/回执、确认指纹、正文与原始图门禁
// ---------------------------------------------------------------------------

async function createWithContext(
  root: ProjectRoot,
  layer: "prd" | "fsd" | "tdd",
  id: string,
  content: string,
  options: string[] = [],
): Promise<void> {
  const args = [layer, "create", id, ...options];
  const context = await dispatchOk(root.cwd, args);
  expect(typeof context["context_token"]).toBe("string");
  const result = await dispatchOk(root.cwd, [
    ...args, "--content", content, "--context-token", context["context_token"] as string,
  ]);
  expect(result["mode"]).toBe("written");
}

/** 每次经真实命令取得背景并逐层冻结，生成路径不使用 skip-context。 */
async function buildGenerationVersion(root: ProjectRoot): Promise<VersionManager> {
  await dispatchOk(root.cwd, ["version", "create", V]);
  await createWithContext(root, "prd", "[PRD]-demo",
    PRD_DOC + "\n\n" + seedRequirement("[PRD]-demo:behavior", "demo 制品"));
  await dispatchOk(root.cwd, ["prd", "confirm"]);
  await createWithContext(root, "fsd", "[FSD]-demo", FSD_DOC + "\n\n" + FSD_LEAF_DOC, ["--parent", "[PRD]-demo"]);
  await dispatchOk(root.cwd, ["fsd", "confirm"]);
  await createWithContext(root, "tdd", "[TDD]-demo", TDD_DOC,
    ["--parent", "[FSD]-demo:implementation"]);
  await dispatchOk(root.cwd, ["tdd", "confirm"]);
  return new VersionManager(root);
}

function deliverGeneration(root: ProjectRoot): DeliveryPointer {
  const pointer = prepareDelivery(root, { tddRoot: "[TDD]-demo", version: V });
  tmpDirs.push(path.dirname(pointer.bundle_path));
  const bytes = fs.readFileSync(pointer.bundle_path);
  expect(bytes.length).toBe(pointer.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pointer.sha256);
  return pointer;
}

function writeDemoArtifact(root: ProjectRoot, content = "export const value = 1;\n"): string {
  const target = path.join(root.cwd, "src", "demo.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function registerReceipt(root: ProjectRoot, delivery: DeliveryPointer): void {
  const receipt = registerGenerationReceipt(root, { generation_token: delivery.generation_token });
  expect(receipt.bundle_sha256).toBe(delivery.sha256);
  expect(receipt.artifact_sha256).toBe(createHash("sha256")
    .update(fs.readFileSync(path.join(root.cwd, delivery.target_file))).digest("hex"));
}

async function generatedVersion(root: ProjectRoot): Promise<{
  vm: VersionManager; delivery: DeliveryPointer;
}> {
  const vm = await buildGenerationVersion(root);
  writeLocalConfig(root.meta, { generation_receipts: { enforcement: "block" } });
  const delivery = deliverGeneration(root);
  writeDemoArtifact(root);
  registerReceipt(root, delivery);
  return { vm, delivery };
}

function managedSnapshot(root: ProjectRoot): Map<string, string>[] {
  return [root.docs, root.meta, path.join(root.root, "versions")].map(treeDigest);
}

function expectManagedUnchanged(root: ProjectRoot, before: Map<string, string>[]): void {
  const after = managedSnapshot(root);
  before.forEach((digest, index) => expectSameDigest(digest, after[index]!));
}

describe("生成回执门禁", () => {
  it.each([false, true])("缺回执（prepare=%s）：report 报告且允许确认，block 零落盘拒绝", { timeout: T }, async (prepared) => {
    const { root } = makeEnv();
    const vm = await buildGenerationVersion(root);
    if (prepared) deliverGeneration(root);
    writeDemoArtifact(root);
    const report = await vm.versionConfirm(V);
    expect(report.generation_receipts).toMatchObject({ enforcement: "report", passed: true });
    expect(report.generation_receipts.findings).toEqual([
      expect.objectContaining({ code: "GENERATION_RECEIPT_MISSING", tdd_root: "[TDD]-demo", target_file: "src/demo.ts" }),
    ]);
    const confirmedPlan = readMeta(root, V).confirmed_plan;
    writeLocalConfig(root.meta, { generation_receipts: { enforcement: "block" } });
    const before = managedSnapshot(root);
    const rejected = await dispatchIn(root.cwd, ["version", "confirm", V]);
    expect(rejected).toMatchObject({ ok: false, code: "GENERATION_RECEIPTS_FAILED" });
    expectManagedUnchanged(root, before);
    expect(readMeta(root, V).confirmed_plan).toEqual(confirmedPlan);
  });

  it("纯文档版本在 block 下通过；非 Git 宿主如实返回空绑定", { timeout: T }, async () => {
    const { root } = makeEnv({ hostGit: false });
    const vm = await advanceToCommit(root);
    writeLocalConfig(root.meta, { generation_receipts: { enforcement: "block" } });
    const confirmed = await vm.versionConfirm(V);
    expect(confirmed.generation_receipts).toEqual({ enforcement: "block", passed: true, findings: [] });
    expect(confirmed.code_result).toBeNull();
    const merged = await versionMerge(root, V);
    expect(merged.generation_receipts.findings).toEqual([]);
    expect(readMeta(root, V).code_result).toBeNull();
  });

  it("有效回执仍受验收失败约束；无 Git 也不伪造制品提交", { timeout: T }, async () => {
    const { root } = makeEnv({ hostGit: false });
    const { vm } = await generatedVersion(root);
    const confirmed = await vm.versionConfirm(V);
    expect(confirmed.generation_receipts.findings).toEqual([]);
    expect(confirmed.code_result).toBeNull();
    const repeated = await vm.versionConfirm(V);
    expect(repeated.plan_fingerprint).toBe(confirmed.plan_fingerprint);
    acceptanceSet(root, "exit 7");
    const before = managedSnapshot(root);
    await expectErrCode(vm.versionConfirm(V), "ACCEPTANCE_FAILED");
    expectManagedUnchanged(root, before);
  });

  it.each(["artifact", "same-bundle", "new-receipt", "policy"] as const)(
    "确认后 %s 改变使 merge 过期，重新交付登记确认后可合入", { timeout: T }, async (change) => {
      const { root } = makeEnv();
      const { vm } = await generatedVersion(root);
      // 目标已存在时再交付，以便后续验证字节完全相同的 bundle 也有新的交付身份。
      const stable = deliverGeneration(root);
      registerReceipt(root, stable);
      const confirmed = await vm.versionConfirm(V);
      if (change === "artifact") writeDemoArtifact(root, "export const value = 2;\n");
      if (change === "same-bundle" || change === "new-receipt") {
        const newer = deliverGeneration(root);
        expect(newer.sha256).toBe(stable.sha256);
        expect(newer.generation_token).not.toBe(stable.generation_token);
        if (change === "new-receipt") registerReceipt(root, newer);
      }
      if (change === "policy") {
        writeLocalConfig(root.meta, { generation_receipts: { enforcement: "report" } });
      }
      const before = managedSnapshot(root);
      await expectErrCode(versionMerge(root, V), "CONFIRMATION_STALE");
      expectManagedUnchanged(root, before);
      expect(readMeta(root, V).confirmed_plan?.input_fingerprint).toBe(confirmed.plan_fingerprint);

      const fresh = deliverGeneration(root);
      writeDemoArtifact(root, "export const value = 3;\n");
      registerReceipt(root, fresh);
      const reconfirmed = await vm.versionConfirm(V);
      expect(reconfirmed.plan_fingerprint).not.toBe(confirmed.plan_fingerprint);
      const merged = await versionMerge(root, V);
      expect(merged.generation_receipts.findings).toEqual([]);
      expect(readMeta(root, V).phase).toBe("merged");
      expectThrowCode(() => registerGenerationReceipt(root, { generation_token: fresh.generation_token }), "GENERATION_TOKEN_STALE");
    },
  );

  it.each(["block", "report"] as const)("验收命令改写目标后按最终字节核验回执（%s）", { timeout: T }, async (enforcement) => {
    const { root } = makeEnv();
    const { vm } = await generatedVersion(root);
    writeLocalConfig(root.meta, { generation_receipts: { enforcement } });
    writeLocalConfig(root.meta, { acceptanceCommand: 'node -e "require(\'node:fs\').appendFileSync(\'src/demo.ts\', \'// acceptance\\n\')"' });
    const before = managedSnapshot(root);
    if (enforcement === "block") {
      await expectErrCode(vm.versionConfirm(V), "GENERATION_RECEIPTS_FAILED");
      expectManagedUnchanged(root, before);
      expect(readMeta(root, V).confirmed_plan).toBeNull();
    } else {
      const confirmed = await vm.versionConfirm(V);
      expect(confirmed.generation_receipts.findings).toEqual([
        expect.objectContaining({ code: "GENERATION_ARTIFACT_CHANGED", target_file: "src/demo.ts" }),
      ]);
      // 没有新的输入变化即可执行已确认计划，证明指纹来自验收后的实际字节。
      const merged = await versionMerge(root, V);
      expect(merged.plan_fingerprint).toBe(confirmed.plan_fingerprint);
      expect(merged.generation_receipts.findings).toEqual(confirmed.generation_receipts.findings);
    }
    expect(fs.readFileSync(path.join(root.cwd, "src/demo.ts"), "utf8")).toContain("// acceptance");
  });

  it("绑定落盘前注入失败时完整恢复 generation，保留凭证并可重试", { timeout: T }, async () => {
    const { root } = makeEnv();
    const { vm, delivery } = await generatedVersion(root);
    await vm.versionConfirm(V);
    const generation = readMeta(root, V).generation;
    const before = managedSnapshot(root);
    ioFail.failBindings = true;
    let error: unknown;
    try {
      error = await captureErr(versionMerge(root, V));
    } finally {
      ioFail.failBindings = false;
    }
    expect(error).toMatchObject({ code: "MERGE_ROLLBACK" });
    expect((error as Error).message).toContain("绑定元数据落盘失败");
    expectManagedUnchanged(root, before);
    expect(readMeta(root, V).generation).toEqual(generation);
    registerReceipt(root, delivery);
    expect((await versionMerge(root, V)).generation_receipts.findings).toEqual([]);
  });

  it.each(["layer", "version"] as const)("%s 返工后旧 token/receipt 失效，重建后只接受新交付", { timeout: T }, async (scope) => {
    const { root } = makeEnv();
    const { vm, delivery } = await generatedVersion(root);
    await vm.versionConfirm(V);
    if (scope === "layer") {
      await dispatchOk(root.cwd, ["tdd", "revert"]);
      expect(readMeta(root, V).generation).toBeNull();
      await dispatchOk(root.cwd, ["tdd", "confirm"]);
    } else {
      await vm.versionRevert(V, { confirm: true });
      await buildGenerationVersion(root);
    }
    expect(readMeta(root, V).confirmed_plan).toBeNull();
    const before = managedSnapshot(root);
    expectThrowCode(() => registerGenerationReceipt(root, { generation_token: delivery.generation_token }), "GENERATION_TOKEN_STALE");
    expectManagedUnchanged(root, before);
    await expectErrCode(new VersionManager(root).versionConfirm(V), "GENERATION_RECEIPTS_FAILED");
    const fresh = deliverGeneration(root);
    expect(fresh.generation_token).not.toBe(delivery.generation_token);
    writeDemoArtifact(root);
    registerReceipt(root, fresh);
    expect((await new VersionManager(root).versionConfirm(V)).generation_receipts.findings).toEqual([]);
  });
});

const CONTENT_CORRUPTIONS = [
  { name: "target_file 与已提交正文不一致", file: "tdd/[TDD]-demo", code: "SPEC_CONTENT_MISMATCH", mutate: (text: string) => text.replace("src/demo.ts", "src/other.ts") },
  { name: "PRD 用户故事缺失", file: "prd/[PRD]-demo", code: "PRD_REQUIREMENT_CONTRACT_VIOLATION", mutate: (text: string) => text.replace("**用户故事:**", "需求说明：") },
  { name: "PRD 关系注释残留", file: "prd/[PRD]-demo", code: "MARKDOWN_CONTAINS_RELATION", mutate: (text: string) => text + "\n<!-- @ref:[PRD]-demo -->\n" },
  { name: "FSD 已持久化声明残留", file: "fsd/[FSD]-demo", code: "MARKDOWN_CONTAINS_RELATION", mutate: (text: string) => text + "\n" + ["```yaml", 'depends_on: ["[FSD]-ghost"]', "```"].join("\n") },
  { name: "声明 chunk 缺失", file: "tdd/[TDD]-demo", code: "MERGE_SOURCE_MISSING", mutate: (text: string) => dropChunkText(text, "[TDD]-demo") },
  { name: "文档重复 id 解析失败", file: "tdd/[TDD]-demo", code: "CHUNK_PARSE_ERROR", mutate: (text: string) => duplicateChunkText(text, "[TDD]-demo") },
  { name: "旁路添加未登记 chunk", file: "prd/[PRD]-demo", code: "SPEC_CONTENT_MISMATCH", mutate: (text: string) => text + "\n\n" + seedRequirement("[PRD]-demo:unmanaged", "未登记需求") },
];

describe("实际正文门禁", () => {
  for (const gate of ["confirm", "merge"] as const) {
    it.each(CONTENT_CORRUPTIONS)(gate + " 拒绝 $name 且受管目录零落盘", { timeout: T }, async ({ file, code, mutate }) => {
      const { root } = makeEnv();
      const vm = await buildGenerationVersion(root);
      if (gate === "merge") await vm.versionConfirm(V);
      const doc = workspaceDocPath(root, file);
      fs.writeFileSync(doc, mutate(fs.readFileSync(doc, "utf8")));
      const before = managedSnapshot(root);
      const error = await captureErr(gate === "confirm" ? vm.versionConfirm(V) : versionMerge(root, V));
      expect(error).toMatchObject({ code });
      if (code === "CHUNK_PARSE_ERROR") {
        expect(error).toMatchObject({ file: file + ".md", line: expect.any(Number) });
      } else {
        expect((error as Error).message.replaceAll("\\", "/")).toContain(file);
      }
      expectManagedUnchanged(root, before);
    });
  }
});

async function versionOverBaseline(root: ProjectRoot): Promise<VersionManager> {
  await seedOverrideBaseline(root);
  const vm = new VersionManager(root);
  vm.versionCreate(V);
  await createWithContext(root, "prd", "[PRD]-demo", PRD_DOC.replace("demo 概述文本。", "demo 新版本概述。"), ["--action", "modify"]);
  await dispatchOk(root.cwd, ["prd", "confirm"]);
  return vm;
}

describe("原始图端点门禁", () => {
  for (const gate of ["confirm", "merge"] as const) {
    for (const side of ["baseline", "version"] as const) {
      it.each([false, true])(gate + " 拒绝 " + side + " 原始图悬空边（双端缺失=%s）且零落盘", { timeout: T }, async (bothMissing) => {
        const { root } = makeEnv();
        const vm = await versionOverBaseline(root);
        if (gate === "merge") await vm.versionConfirm(V);
        const store = new SpecGraphStore(root);
        const graph = store.load(side === "baseline" ? undefined : V);
        const known = store.load(V).specs.find((spec) => spec.chunk_id === "[PRD]-demo");
        expect(known).toBeDefined();
        graph.edges.push({
          src: bothMissing ? "spec:prd:" + V + ":[PRD]-ghost" : known!.uri,
          dst: "spec:fsd:" + V + ":[FSD]-ghost",
          rel: "derives", weight: 1,
          metadata: { source: "new-model-cli" },
        });
        saveModel(path.join(root.meta, side === "baseline" ? "specgraph.yaml" : "specgraph-" + V + ".yaml"), graph);
        const before = managedSnapshot(root);
        const error = await captureErr(gate === "confirm" ? vm.versionConfirm(V) : versionMerge(root, V));
        expect(error).toMatchObject({ code: "INVARIANT_VIOLATION" });
        expect((error as Error).message).toContain("MISSING_ENDPOINT");
        expect((error as Error).message).toContain("[FSD]-ghost");
        expectManagedUnchanged(root, before);
      });
    }
  }

  it("合法跨 baseline/version URI 仍通过 confirm 与 merge", { timeout: T }, async () => {
    const { root } = makeEnv();
    const vm = await versionOverBaseline(root);
    const store = new SpecGraphStore(root);
    const graph = store.load(V);
    const prd = graph.specs.find((spec) => spec.chunk_id === "[PRD]-demo")!;
    const fsd = store.load().specs.find((spec) => spec.chunk_id === "[FSD]-demo")!;
    graph.edges.push({ src: prd.uri, dst: fsd.uri, rel: "derives", weight: 1, metadata: { source: "new-model-cli" } });
    saveModel(path.join(root.meta, "specgraph-" + V + ".yaml"), graph);
    expect((await vm.versionConfirm(V)).passed).toBe(true);
    expect((await versionMerge(root, V)).merged_chunks).toContain("[PRD]-demo");
  });
});


// ---------------------------------------------------------------------------
// v0.11 — 连续迭代基线隔离与既有治理策略
// ---------------------------------------------------------------------------

function expectBaselineLifecycleClean(root: ProjectRoot): void {
  const baseline = new SpecGraphStore(root).load();
  expect(baseline.specs.length).toBeGreaterThan(0);
  for (const node of baseline.specs) {
    for (const field of ["state", "action", "commit_id", "fsd_declaration_overrides"]) {
      expect(node.metadata).not.toHaveProperty(field);
    }
  }
}

/** 只在第一轮 merge 后取一次预期；所有第二轮操作共用该字节基准。 */
async function exerciseSecondRoundIsolation(
  root: ProjectRoot,
  version: string,
  docs: { prdId: string; prd: string; fsdId: string; fsd: string; tddId: string; tdd: string },
): Promise<void> {
  expectBaselineLifecycleClean(root);
  const baselineDocs = treeDigest(root.docs);
  const baselineNames = ["chunks-index.yaml", "specgraph.yaml"];
  const baselineMeta = fileDigests(root.meta, baselineNames);
  const history = metaHistoryDigests(root.meta);
  const unchanged = (): void => {
    expectSameDigest(baselineDocs, treeDigest(root.docs));
    expectSameDigest(baselineMeta, fileDigests(root.meta, baselineNames));
    expectSameDigest(history, fileDigests(root.meta, [...history.keys()]));
  };
  const command = async (args: string[]): Promise<Record<string, unknown>> => {
    const result = await dispatchOk(root.cwd, args);
    unchanged();
    return result;
  };
  await command(["version", "create", version]);
  await createWithContext(root, "prd", docs.prdId, docs.prd + "\n\n第二轮概述。", ["--action", "modify"]);
  unchanged();
  await command(["prd", "confirm"]);
  await command(["prd", "revert"]);
  await createWithContext(root, "prd", docs.prdId, docs.prd + "\n\n第二轮返工后的概述。", ["--action", "modify"]);
  unchanged();
  await command(["prd", "confirm"]);
  await createWithContext(root, "fsd", docs.fsdId, docs.fsd + "\n\n第二轮能力说明。", ["--action", "modify"]);
  unchanged();
  await command(["fsd", "confirm"]);
  const tddOptions = ["--parent", docs.fsdId, "--action", "modify"];
  await createWithContext(root, "tdd", docs.tddId, docs.tdd + "\n\n第二轮实现说明。", tddOptions);
  unchanged();
  const committed = await command(["version", "commit", version]);
  expect(committed["committed"]).toContain(docs.tddId);
  await command(["tdd", "confirm"]);
  await command(["tdd", "revert"]);
  await createWithContext(root, "tdd", docs.tddId, docs.tdd + "\n\n第二轮返工后的实现说明。", tddOptions);
  unchanged();
  await command(["tdd", "confirm"]);
  const confirmed = await command(["version", "confirm", version]);
  expect(confirmed["passed"]).toBe(true);
  expect(confirmed["plan_fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
  await command(["version", "revert", version, "--confirm"]);
  expect(fs.existsSync(path.join(root.root, "versions", version))).toBe(false);
  expectSameDigest(history, metaHistoryDigests(root.meta));
}

/** 第一轮真实合入带 TDD 的基线，再开启只修改 PRD 的纯文档版本。 */
async function documentVersionOverTddBaseline(root: ProjectRoot): Promise<VersionManager> {
  const vm = await buildGenerationVersion(root);
  writeDemoArtifact(root);
  await vm.versionConfirm(V);
  await versionMerge(root, V);
  await dispatchOk(root.cwd, ["version", "create", "v0.5"]);
  await createWithContext(root, "prd", "[PRD]-demo", PRD_DOC + "\n\n纯文档更新。", ["--action", "modify"]);
  await dispatchOk(root.cwd, ["prd", "confirm"]);
  expect(new IndexManager(root).loadVersionIndex("v0.5").chunks.map((chunk) => chunk.id)).toEqual(["[PRD]-demo"]);
  return vm;
}

describe("连续两轮基线字节隔离", () => {
  it("第一轮 merge 清理生命周期；第二轮逐层写入、confirm、返工、commit 与未合入 revert 均不改基线或历史", { timeout: T }, async () => {
    const { root } = makeEnv();
    const vm = await buildGenerationVersion(root);
    writeDemoArtifact(root);
    await vm.versionConfirm(V);
    const graphName = "specgraph-" + V + ".yaml";
    const versionGraph = fileDigests(root.meta, [graphName]);
    await versionMerge(root, V);
    expectSameDigest(versionGraph, fileDigests(root.meta, [graphName]));
    await exerciseSecondRoundIsolation(root, "v0.5", {
      prdId: "[PRD]-demo", prd: PRD_DOC,
      fsdId: "[FSD]-demo:implementation", fsd: FSD_LEAF_DOC,
      tddId: "[TDD]-demo", tdd: TDD_DOC,
    });
  });
});

describe("既有治理策略的版本门禁", () => {
  it.each(["confirm", "merge"] as const)("纯文档版本 %s 仍阻断缺失的基线制品，零提交且受管目录零落盘", { timeout: T }, async (gate) => {
    const { root } = makeEnv();
    const vm = await documentVersionOverTddBaseline(root);
    writeLocalConfig(root.meta, {
      target_file_existence: { enforcement: "block" },
      generation_receipts: { enforcement: "block" },
    });
    if (gate === "merge") {
      const confirmed = await vm.versionConfirm("v0.5");
      expect(confirmed.warnings).toEqual([]);
      expect(confirmed.generation_receipts).toEqual({ enforcement: "block", passed: true, findings: [] });
    }
    fs.rmSync(path.join(root.cwd, "src/demo.ts"));
    const before = managedSnapshot(root);
    const heads = [root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]));
    const error = await captureErr(gate === "confirm" ? vm.versionConfirm("v0.5") : versionMerge(root, "v0.5"));
    expect(error).toMatchObject({ code: "INVARIANT_VIOLATION" });
    expect((error as Error).message).toContain("TDD_TARGET_FILE_MISSING");
    expect((error as Error).message).toContain("[TDD]-demo");
    expect((error as Error).message).toContain("src/demo.ts");
    expectManagedUnchanged(root, before);
    expect([root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]))).toEqual(heads);
  });

  it("确认后删除本版制品仍报计划过期，并保留缺失制品的治理定位", { timeout: T }, async () => {
    const { root } = makeEnv();
    const { vm } = await generatedVersion(root);
    writeLocalConfig(root.meta, { target_file_existence: { enforcement: "block" } });
    const confirmed = await vm.versionConfirm(V);
    fs.rmSync(path.join(root.cwd, "src/demo.ts"));
    const before = managedSnapshot(root);
    const heads = [root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]));
    const error = await captureErr(versionMerge(root, V));
    expect(error).toMatchObject({ code: "CONFIRMATION_STALE" });
    expect((error as Error).message).toContain("TDD_TARGET_FILE_MISSING");
    expect((error as Error).message).toContain("[TDD]-demo");
    expect((error as Error).message).toContain("src/demo.ts");
    expect((error as Error).message).toContain("recovery");
    expectManagedUnchanged(root, before);
    expect(readMeta(root, V).confirmed_plan?.input_fingerprint).toBe(confirmed.plan_fingerprint);
    expect([root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]))).toEqual(heads);
  });

  it("warn 在 confirm/merge 返回相同定位，纯文档回执豁免且未配 scope 的非 Git 宿主可用", { timeout: T }, async () => {
    const { root } = makeEnv({ hostGit: false });
    const vm = await documentVersionOverTddBaseline(root);
    writeLocalConfig(root.meta, {
      target_file_existence: { enforcement: "warn" },
      generation_receipts: { enforcement: "block" },
    });
    fs.rmSync(path.join(root.cwd, "src/demo.ts"));
    const confirmed = await vm.versionConfirm("v0.5");
    expect(confirmed.warnings).toEqual([expect.objectContaining({
      code: "TDD_TARGET_FILE_MISSING", chunkId: "[TDD]-demo", file: "tdd/[TDD]-demo",
      targetFile: "src/demo.ts", enforcement: "warn",
    })]);
    expect(confirmed.generation_receipts).toEqual({ enforcement: "block", passed: true, findings: [] });
    expect(confirmed.code_result).toBeNull();
    const merged = await versionMerge(root, "v0.5");
    expect(merged.warnings).toEqual(confirmed.warnings);
    expect(merged.generation_receipts).toEqual(confirmed.generation_receipts);
    expect(readMeta(root, "v0.5").code_result).toBeNull();
    expect(fs.existsSync(path.join(root.cwd, ".git"))).toBe(false);
  });

  it("验收成功但删除基线制品时按最终事实阻断，不能提交宿主或保存确认计划", { timeout: T }, async () => {
    const { root } = makeEnv();
    const vm = await documentVersionOverTddBaseline(root);
    writeLocalConfig(root.meta, { target_file_existence: { enforcement: "block" } });
    acceptanceSet(root, 'node -e "require(\'node:fs\').unlinkSync(\'src/demo.ts\')"');
    const before = managedSnapshot(root);
    const heads = [root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]));
    const error = await captureErr(vm.versionConfirm("v0.5"));
    expect(error).toMatchObject({ code: "INVARIANT_VIOLATION" });
    expect((error as Error).message).toContain("TDD_TARGET_FILE_MISSING");
    expect(fs.existsSync(path.join(root.cwd, "src/demo.ts"))).toBe(false);
    expectManagedUnchanged(root, before);
    expect(readMeta(root, "v0.5").confirmed_plan).toBeNull();
    expect([root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]))).toEqual(heads);
  });

  it.each([
    { target_file_existence: { enforcement: "report" } },
    { artifact_scopes: { tests: { parent_suffix: "TEST", enforcement: "block" } } },
    { derives_residue: { enforcement: "ignore" } },
  ])("坏治理配置拒绝且零落盘：%j", { timeout: T }, async (policy) => {
    const { root } = makeEnv({ hostGit: false });
    const vm = await advanceToCommit(root);
    writeLocalConfig(root.meta, policy);
    const before = managedSnapshot(root);
    await expectErrCode(vm.versionConfirm(V), "CONFIG_UNREADABLE");
    expectManagedUnchanged(root, before);
  });

  for (const enforcement of ["warn", "block"] as const) {
    it.each(["UNCOVERED_ARTIFACT", "TEST_SPLIT_UNCOVERED", "DERIVES_RESIDUE"] as const)(
      enforcement + " 治理实际 %s，warn 在 merge 保留诊断，block 不落盘", { timeout: T }, async (code) => {
        const { root } = makeEnv();
        const vm = new VersionManager(root);
        vm.versionCreate(V);
        await createWithContext(root, "prd", "[PRD]-demo", PRD_DOC + "\n\n" + seedRequirement("[PRD]-demo:behavior", "demo 制品"));
        await dispatchOk(root.cwd, ["prd", "confirm"]);
        const leaf = code === "TEST_SPLIT_UNCOVERED"
          ? FSD_LEAF_DOC.replaceAll(":implementation", ":TEST")
          : FSD_LEAF_DOC + (code === "DERIVES_RESIDUE" ? "\n\n满足 [PRD]-demo:behavior。" : "");
        await createWithContext(root, "fsd", "[FSD]-demo", FSD_DOC + "\n\n" + leaf, ["--parent", "[PRD]-demo"]);
        await dispatchOk(root.cwd, ["fsd", "confirm"]);
        if (code === "DERIVES_RESIDUE") {
          writeLocalConfig(root.meta, { derives_residue: { enforcement } });
        } else {
          writeLocalConfig(root.meta, { artifact_scopes: { tests: { parent_suffix: ":TEST", enforcement } } });
        }
        if (code === "UNCOVERED_ARTIFACT") {
          fs.mkdirSync(path.join(root.cwd, "tests"));
          fs.writeFileSync(path.join(root.cwd, "tests/unmanaged.test.ts"), "export {};\n");
          git(root.cwd, ["add", "--", "tests/unmanaged.test.ts"]);
        }
        const before = managedSnapshot(root);
        const hostHead = git(root.cwd, ["rev-parse", "HEAD"]);
        if (enforcement === "block") {
          const error = await captureErr(vm.versionConfirm(V));
          expect(error).toMatchObject({ code: "INVARIANT_VIOLATION" });
          expect((error as Error).message).toContain(code);
          expectManagedUnchanged(root, before);
          expect(git(root.cwd, ["rev-parse", "HEAD"])).toBe(hostHead);
        } else {
          const confirmed = await vm.versionConfirm(V);
          expect(confirmed.warnings).toEqual([expect.objectContaining({ code, enforcement })]);
          expect((await versionMerge(root, V)).warnings).toEqual(confirmed.warnings);
        }
      },
    );
  }

  it.each(["existence", "scope", "path-exemption", "node-exemption", "derives"] as const)(
    "确认后 %s 策略变化使计划过期，重新确认后可合入", { timeout: T }, async (change) => {
      const { root } = makeEnv();
      const vm = await advanceToCommit(root);
      const scopes = { tests: { parent_suffix: ":TEST", enforcement: "warn", exempt_paths: [] as string[], exempt_test_splits: [] as string[] } };
      writeLocalConfig(root.meta, {
        artifact_scopes: scopes, target_file_existence: { enforcement: "warn" }, derives_residue: { enforcement: "warn" },
      });
      const confirmed = await vm.versionConfirm(V);
      expect(confirmed.warnings).toEqual([]);
      expect((await vm.versionConfirm(V)).plan_fingerprint).toBe(confirmed.plan_fingerprint);
      if (change === "existence") writeLocalConfig(root.meta, { target_file_existence: { enforcement: "block" } });
      if (change === "derives") writeLocalConfig(root.meta, { derives_residue: { enforcement: "block" } });
      if (change === "scope") scopes.tests.enforcement = "block";
      if (change === "path-exemption") scopes.tests.exempt_paths.push("tests/future.test.ts");
      if (change === "node-exemption") scopes.tests.exempt_test_splits.push("[FSD]-demo:TEST");
      if (["scope", "path-exemption", "node-exemption"].includes(change)) writeLocalConfig(root.meta, { artifact_scopes: scopes });
      const before = managedSnapshot(root);
      const heads = [root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]));
      await expectErrCode(versionMerge(root, V), "CONFIRMATION_STALE");
      expectManagedUnchanged(root, before);
      expect([root.cwd, root.root].map((dir) => git(dir, ["rev-parse", "HEAD"]))).toEqual(heads);
      expect(readMeta(root, V).confirmed_plan?.input_fingerprint).toBe(confirmed.plan_fingerprint);
      const refreshed = await vm.versionConfirm(V);
      expect(refreshed.plan_fingerprint).not.toBe(confirmed.plan_fingerprint);
      expect((await versionMerge(root, V)).warnings).toEqual([]);
    },
  );
});

// [TDD]-versioning_tests v0.5 — 接管 Python 版 ait 已管理仓库（:TEST 7/8）。

/** AIT_CORPUS_DIRS（";" 分隔的 .meta 目录或 project-docs 目录列表）。 */
function corpusProjectDocs(): { configured: string[]; existing: string[] } {
  const raw = process.env["AIT_CORPUS_DIRS"];
  const configured =
    raw !== undefined && raw.trim() !== ""
      ? raw
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : [];
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

/**
 * 整树拷贝 project-docs（**保留 .git**）：:TEST 8 要求 docs 仓可用（合入提交 +
 * 锚点 tag），历史文件须能在副本上原样比对。
 */
function copyProjectDocsWithGit(src: string, base: string): string {
  const dst = path.join(base, "project-docs");
  fs.cpSync(src, dst, { recursive: true });
  // 语料配置可能要求 TDD 制品真实存在；只复制其声明且实际存在的宿主文件。
  const root = resolveProjectRoot(base);
  for (const node of combinedView(root).nodes.values()) {
    if (typeof node.target_file !== "string") continue;
    const source = path.resolve(path.dirname(src), node.target_file);
    const relative = path.relative(path.dirname(src), source);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
      throw new Error("语料制品路径越界：" + node.target_file);
    }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const scopes = loadConfig(root.meta)["artifact_scopes"] as Record<string, unknown> | undefined;
  if (scopes !== undefined && Object.keys(scopes).length > 0) {
    // 配置 scope 的副本使用真实 Git 跟踪清单，连同未建 TDD 的受治理文件一起核验。
    const sourceRoot = path.dirname(src);
    const tracked = git(sourceRoot, ["ls-files", "-z", "--", ...Object.keys(scopes)]).split("\0").filter(Boolean);
    for (const relative of tracked) {
      const source = path.resolve(sourceRoot, relative);
      const within = path.relative(sourceRoot, source);
      if (path.isAbsolute(within) || within === ".." || within.startsWith(".." + path.sep)) {
        throw new Error("语料受治理路径越界：" + relative);
      }
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const target = path.join(base, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.writeFileSync(path.join(base, ".gitignore"), "project-docs/\n");
    initRepo(base);
    gitCommitAll(base, "corpus artifact baseline");
  }
  return dst;
}

/**
 * `.meta` 历史持久化文件的字节摘要：`versions/*.yaml`、`changes/*.yaml`、
 * `chunks-index-v*.yaml`、`specgraph-v*.yaml`（:TEST 8 的历史只读核对面）。
 */
function metaHistoryDigests(meta: string): Map<string, string> {
  const out = new Map<string, string>();
  const record = (rel: string): void => {
    const abs = path.join(meta, rel);
    if (!fs.existsSync(abs)) return;
    out.set(
      rel,
      createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
    );
  };
  const listDir = (rel: string): void => {
    const dir = path.join(meta, rel);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".yaml")) record(path.join(rel, name));
    }
  };
  listDir("versions");
  listDir("changes");
  for (const name of fs.readdirSync(meta)) {
    if (
      (name.startsWith("chunks-index-v") || name.startsWith("specgraph-v")) &&
      name.endsWith(".yaml")
    ) {
      record(name);
    }
  }
  return out;
}

/** `.meta/changes/` 下现有最大变更记录编号（Python 语料已有上千条）。 */
function maxChangeNumber(meta: string): number {
  const dir = path.join(meta, "changes");
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = /^chg-(\d+)\.yaml$/.exec(name);
    if (m === null) continue;
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

const TAKEOVER_VERSION = "v9.9";

/**
 * 接管探针内容按**语料自身的 PRD 根 id** 参数化：AIT-project 语料根为 `[PRD]-ait`，
 * ait-core 自身语料根为 `[PRD]-ait-core`——硬编码其一会让另一套语料失败。
 * 需求 split 名两套语料一致（`<根>:chunk_versioning` 均存在）。
 */
function takeoverDocs(rootId: string, fsdRootId: string): {
  requirementId: string;
  fsdSplitId: string;
  tddId: string;
  prdRequirement: string;
  prdRoot: string;
  fsdSplit: string;
  tdd: string;
} {
  const requirementId = `${rootId}:takeover_probe`;
  const fsdSplitId = `${fsdRootId}:takeover_probe`;
  const tddId = "[TDD]-takeover_probe";
  const derivesFrom = requirementId;
  return {
    requirementId,
    fsdSplitId,
    tddId,
    /** 新 PRD 需求 chunk：须含 用户故事 行与带编号条目的验收标准小节。 */
    prdRequirement: [
      `<!-- @id:${requirementId} -->`,
      "## 需求：接管验证探针",
      "",
      "### 功能描述",
      "在 Python 版 ait 管理过的仓库上验证 ait-core 接管路径。",
      "",
      "**用户故事:** 作为维护者，我希望在既有 project-docs 上继续开新版本，以便免迁移接管。",
      "",
      "#### 验收标准",
      "",
      "1. WHEN 新版本进入接管流程 THEN 系统 SHALL 支持创建、提交、确认与合入。",
      "2. WHEN 新版本合入完成 THEN 系统 SHALL 保持既有历史文件逐字节不变。",
    ].join("\n"),
    /** 既有 PRD 根 chunk 的 modify 内容（modify 根 chunk 与本层新增同批提交）。 */
    prdRoot: [
      `<!-- @id:${rootId} -->`,
      "## ait 产品 PRD",
      "",
      "### 概述",
      "接管验证在 PRD 根追加的概述行。",
      "",
      "### 范围",
      "接管验证追加的范围说明。",
      "",
      "### 目标与度量",
      "新版本全流程成功，历史文件哈希不变。",
      "",
      "### 反向要求",
      "- 不改写已合入版本。",
    ].join("\n"),
    /** 新 FSD split：derives 自已有 PRD 需求 split（声明块由创建方解析后剥离建边）。 */
    fsdSplit: [
      `<!-- @id:${fsdSplitId} -->`,
      "## takeover_probe 能力 split",
      "",
      "### 功能描述",
      "接管验证探针的域内分解。",
      "",
      "### 能力契约",
      "接收新版本操作，返回合入结果与历史文件一致性。",
      "",
      "### 反向要求",
      "- 不承载历史版本数据的改写。",
      "",
      "```yaml",
      `derives: ["${derivesFrom}"]`,
      "```",
      "",
      "### 分解视图",
      "- takeover_probe 叶：探针用例与逐字节核对面",
    ].join("\n"),
    /** 新 TDD：target_file 指向语料中未占用的路径。 */
    tdd: [
      `<!-- @id:${tddId} -->`,
      "## takeover_probe TDD",
      "",
      "```yaml",
      "target_file: src/takeover_probe.ts",
      "```",
      "",
      "### 技术栈",
      "TypeScript（ESM, strict），Node >= 22；vitest。",
      "",
      "### 实现约束",
      "只读语料历史，不写入历史版本产物。",
      "",
      "### 文件职责",
      "提供新版本接管探针。",
      "",
      "### 代码结构",
      "导出一个版本探针常量。",
      "",
      "### 实现逻辑",
      "返回固定探针值，验证 target_file 可追溯。",
      "",
      "### 错误处理与边界条件",
      "无外部输入。",
      "",
      "### 单测要求",
      "接管全流程成功且历史文件哈希不变。",
    ].join("\n"),
  };
}

describe("接管 Python 仓库", () => {
  const corpus = corpusProjectDocs();
  if (corpus.existing.length === 0) {
    // 语料缺席时显式登记一条 skip 用例：describe 内零用例会让 vitest 把整个
    // suite 判为失败（No test found in suite），而规格要求「skip 并打印原因」。
    it.skip(
      `接管用例 skip：AIT_CORPUS_DIRS 未指向任何含 docs/ 与 .meta/ 的 project-docs 目录（配置值 = ${JSON.stringify(corpus.configured)}）`,
    );
    console.warn(
      `接管用例 skip：AIT_CORPUS_DIRS 未指向任何含 docs/ 与 .meta/ 的 project-docs 目录；` +
        `配置值 = ${JSON.stringify(corpus.configured)}`,
    );
  } else {
    console.info(`接管用例启用：${corpus.existing.join(", ")}`);
  }

  // ── :TEST 7 — 历史版本只读可用 ──
  for (const src of corpus.existing) {
    it(
      `历史版本只读可用：全部版本 versionStatus 成功且与元数据/版本索引一致（${src}）`,
      { timeout: T_CORPUS },
      () => {
        const base = mkTmp();
        copyProjectDocsWithGit(src, base);
        const root = resolveProjectRoot(base);
        const vm = new VersionManager(root);
        const im = new IndexManager(root);

        const versions = im.listVersions();
        expect(versions.length).toBeGreaterThan(0);
        for (const version of versions) {
          const status = vm.versionStatus(version);
          expect(status.version).toBe(version);
          // phase 与元数据一致、chunk 与版本索引一致
          expect(status.phase).toBe(readMeta(root, version).phase);
          const index = im.loadVersionIndex(version);
          const byState = (state: string): string[] =>
            index.chunks.filter((c) => c.state === state).map((c) => c.id);
          expect(status.working).toEqual(byState("working"));
          expect(status.staged).toEqual(byState("staged"));
          expect(status.committed).toEqual(byState("committed"));
        }

        // 只读命令零落盘：历史持久化文件逐字节不变
        const before = metaHistoryDigests(root.meta);
        expect(before.size).toBeGreaterThan(0);
        for (const version of versions) {
          vm.versionStatus(version);
        }
        expectSameDigest(before, metaHistoryDigests(root.meta));
      },
    );
  }

  // ── :TEST 8 — 副本上新版本全流程 ──
  for (const src of corpus.existing) {
    it(
      `副本上新版本全流程：version create→PRD/FSD/TDD 写入与冻结→confirm→merge，历史文件逐字节不变（${src}）`,
      { timeout: T_CORPUS },
      async () => {
        const base = mkTmp();
        copyProjectDocsWithGit(src, base);
        const root = resolveProjectRoot(base);

        // 只在副本撤销尚未合入的工作区，使真实历史基线可以继续新版本。
        // 已合入历史的快照在清理前记录；活动版本不属于只读历史。
        const im = new IndexManager(root);
        const mergedBefore = metaHistoryDigests(root.meta);
        for (const version of im.listVersions()) {
          const meta = readMeta(root, version);
          if (meta.merged_at === null && meta.phase !== "merged") {
            for (const rel of [path.join("versions", version + ".yaml"), "chunks-index-" + version + ".yaml", "specgraph-" + version + ".yaml", ...meta.changes.map((id) => path.join("changes", id + ".yaml"))]) {
              mergedBefore.delete(rel);
            }
            await new VersionManager(root).versionRevert(version, { confirm: true });
          }
        }
        const afterCleanup = metaHistoryDigests(root.meta);
        for (const [rel, hash] of mergedBefore) {
          expect(afterCleanup.get(rel)).toBe(hash);
        }

        // ① 步骤②基线：全部历史持久化文件字节哈希；版本清单与新记录编号起点
        const historyBefore = metaHistoryDigests(root.meta);
        expect(historyBefore.size).toBeGreaterThan(0);
        const versionsBefore = new IndexManager(root).listVersions();
        expect(versionsBefore.length).toBeGreaterThan(0);
        const maxChgBefore = maxChangeNumber(root.meta);
        expect(maxChgBefore).toBeGreaterThan(0);

        // 语料自身的 PRD 根 id（AIT-project=`[PRD]-ait`，ait-core=`[PRD]-ait-core`）
        const prdRootId = new IndexManager(root)
          .loadBaseline()
          .chunks.map((r) => r.id)
          .find((id) => id.startsWith("[PRD]-") && !id.includes(":"));
        expect(prdRootId).toBeDefined();
        const view = combinedView(root);
        const fsdRootId = [...view.nodes.keys()].find((id) =>
          id.startsWith("[FSD]-") && !id.includes(":") &&
          ![...view.nodes.keys()].some((child) => child.startsWith(id + ":") && view.edgesFrom(child, "decomposes").length > 0),
        );
        expect(fsdRootId).toBeDefined();
        const docs = takeoverDocs(prdRootId as string, fsdRootId as string);

        // ② 经 dispatcher 以真实命令走一个新版本；每步 ok
        const created = await dispatchOk(base, [
          "version",
          "create",
          TAKEOVER_VERSION,
        ]);
        expect(created["version"]).toBe(TAKEOVER_VERSION);
        expect(created["based_on"]).toBe(
          versionsBefore[versionsBefore.length - 1],
        );

        // PRD：取背景 → 带令牌写一个新需求 chunk；再 modify 根 chunk
        const prdBg = await dispatchOk(base, [
          "prd",
          "create",
          docs.requirementId,
        ]);
        expect(typeof prdBg["context_token"]).toBe("string");
        expect(typeof prdBg["background"]).toBe("string");
        const prdWritten = await dispatchOk(base, [
          "prd",
          "create",
          docs.requirementId,
          "--content",
          docs.prdRequirement,
          "--context-token",
          prdBg["context_token"] as string,
        ]);
        expect(prdWritten["mode"]).toBe("written");
        const prdRootWritten = await dispatchOk(base, [
          "prd",
          "create",
          prdRootId as string,
          "--action",
          "modify",
          "--content",
          docs.prdRoot,
          "--skip-context",
        ]);
        expect(prdRootWritten["mode"]).toBe("written");
        const prdConfirm = await dispatchOk(base, ["prd", "confirm"]);
        expect(prdConfirm["confirmed"]).toContain(docs.requirementId);

        // FSD：取背景 → 带令牌给某域 split 补 derives 与新 split
        const fsdBg = await dispatchOk(base, [
          "fsd",
          "create",
          docs.fsdSplitId,
        ]);
        expect(typeof fsdBg["context_token"]).toBe("string");
        const fsdWritten = await dispatchOk(base, [
          "fsd",
          "create",
          docs.fsdSplitId,
          "--content",
          docs.fsdSplit,
          "--context-token",
          fsdBg["context_token"] as string,
        ]);
        expect(fsdWritten["mode"]).toBe("written");
        // 声明块解析成边：derives 自已有 PRD 需求 split（source=fsd-declaration）
        const writtenEdges = fsdWritten["edges"] as { src: string; dst: string; rel: string; source: string }[];
        expect(writtenEdges.filter((edge) => edge.dst === docs.fsdSplitId)).toEqual([
          {
            src: docs.requirementId,
            dst: docs.fsdSplitId,
            rel: "derives",
            source: "fsd-declaration",
          },
        ]);
        const currentView = combinedView(root, TAKEOVER_VERSION);
        for (const id of view.nodes.keys()) {
          for (const edge of view.edgesFrom(id, "derives")) {
            if (!edge.dst.startsWith(fsdRootId + ":")) continue;
            expect(currentView.edgesFrom(id, "derives")).toEqual(expect.arrayContaining([
              expect.objectContaining({ src: edge.src, dst: edge.dst, rel: "derives" }),
            ]));
          }
        }
        const fsdConfirm = await dispatchOk(base, ["fsd", "confirm"]);
        expect(fsdConfirm["confirmed"]).toContain(docs.fsdSplitId);

        // 在副本中提供新制品，遵守语料的 target_file_existence 门禁。
        const probeTarget = path.join(base, "src", "takeover_probe.ts");
        expect(fs.existsSync(probeTarget)).toBe(false);
        fs.mkdirSync(path.dirname(probeTarget), { recursive: true });
        fs.writeFileSync(probeTarget, "export const takeoverProbe = true;\n");

        // TDD：新 TDD，target_file 指向未占用路径（令牌绑定父锚点）
        const tddBg = await dispatchOk(base, [
          "tdd",
          "create",
          docs.tddId,
          "--parent",
          docs.fsdSplitId,
        ]);
        expect(typeof tddBg["context_token"]).toBe("string");
        const tddWritten = await dispatchOk(base, [
          "tdd",
          "create",
          docs.tddId,
          "--parent",
          docs.fsdSplitId,
          "--content",
          docs.tdd,
          "--context-token",
          tddBg["context_token"] as string,
        ]);
        expect(tddWritten["mode"]).toBe("written");
        const tddConfirm = await dispatchOk(base, ["tdd", "confirm"]);
        expect(tddConfirm["confirmed"]).toContain(docs.tddId);

        // 层冻结顺带提交本层 working 条目（提交归 versioning 域），故此时
        // 已无可提交内容——COMMIT_EMPTY 是正确结果，不是失败。
        const commitRes = await dispatchIn(base, [
          "version",
          "commit",
          TAKEOVER_VERSION,
        ]);
        if (commitRes["ok"] !== true) {
          expect(commitRes["code"]).toBe("COMMIT_EMPTY");
        }
        // 提交项已由三层冻结落盘：prd 层冻结一次（split 与根 modify 同批）→ c1，
        // fsd → c2，tdd → c3；故此处无需再提交，且四条 chunk 全部 committed
        const versionIndex = new IndexManager(root).loadVersionIndex(
          TAKEOVER_VERSION,
        );
        expect(versionIndex.commits.map((c) => c.id)).toEqual([
          "c1",
          "c2",
          "c3",
        ]);
        expect(versionIndex.commits.map((c) => c.chunks)).toEqual([
          [docs.requirementId, prdRootId],
          [docs.fsdSplitId],
          [docs.tddId],
        ]);
        expect(versionIndex.chunks.map((c) => c.id)).toEqual([
          docs.requirementId,
          prdRootId,
          docs.fsdSplitId,
          docs.tddId,
        ]);
        expect(versionIndex.chunks.every((c) => c.state === "committed")).toBe(
          true,
        );

        const confirm = await dispatchOk(base, [
          "version",
          "confirm",
          TAKEOVER_VERSION,
        ]);
        expect(confirm["passed"]).toBe(true);
        expect(confirm["planned_operations"]).toBe(4);
        expect(confirm["plan_fingerprint"]).toMatch(/^[0-9a-f]{64}$/);

        const merge = await dispatchOk(base, [
          "version",
          "merge",
          TAKEOVER_VERSION,
        ]);
        expect(merge["commit"]).not.toBe(null);
        expect(merge["merged_chunks"]).toEqual([
          docs.requirementId,
          prdRootId,
          docs.fsdSplitId,
          docs.tddId,
        ]);

        // ③ 新变更记录编号接续语料既有最大编号（严格连续，不重发不覆盖）
        const fresh = changeNumbers(root).filter((n) => n > maxChgBefore);
        expect(fresh.length).toBe(4);
        for (let i = 0; i < fresh.length; i += 1) {
          expect(fresh[i]).toBe(maxChgBefore + 1 + i);
        }

        // ④ 新版本 status 为 merged；基线可查到新 chunk
        expect(
          new VersionManager(root).versionStatus(TAKEOVER_VERSION).phase,
        ).toBe("merged");
        const baselineIds = new IndexManager(root)
          .loadBaseline()
          .chunks.map((r) => r.id);
        expect(baselineIds).toContain(docs.requirementId);
        expect(baselineIds).toContain(docs.fsdSplitId);
        expect(baselineIds).toContain(docs.tddId);

        // ⑤ 步骤②记录的全部历史文件哈希不变（新版本的 chg/版本元数据/索引/图不在
        //    历史集合内，故逐项核对子集）
        const historyAfter = metaHistoryDigests(root.meta);
        for (const [rel, hash] of historyBefore) {
          expect(historyAfter.get(rel)).toBe(hash);
        }

        // ⑥ 对旧版本与新版本的只读命令都返回正确结果
        for (const version of versionsBefore) {
          const status = new VersionManager(root).versionStatus(version);
          expect(status.phase).toBe(readMeta(root, version).phase);
        }
        const depsOld = await dispatchOk(base, ["deps", "[TDD]-chunk_parser"]);
        expect(depsOld["found"]).toBe(true);
        const depsNew = await dispatchOk(base, [
          "deps",
          docs.tddId,
        ]);
        expect(depsNew["found"]).toBe(true);
        expect(depsNew["edges"]).toEqual([
          {
            src: docs.fsdSplitId,
            dst: docs.tddId,
            rel: "details",
            metadata: { source: "new-model-cli" },
          },
        ]);
        const impactOld = await dispatchOk(base, [
          "impact",
          prdRootId as string,
        ]);
        expect(impactOld["found"]).toBe(true);
        const impactNew = await dispatchOk(base, [
          "impact",
          docs.fsdSplitId,
        ]);
        expect(impactNew["found"]).toBe(true);
        expect(impactNew["impacted"]).toContain(docs.tddId);

        // 同一份百版本语料副本继续第二轮，快照先于所有第二轮操作。
        await exerciseSecondRoundIsolation(root, "v9.10", {
          prdId: prdRootId as string, prd: docs.prdRoot,
          fsdId: docs.fsdSplitId, fsd: docs.fsdSplit,
          tddId: docs.tddId, tdd: docs.tdd,
        });
        expect(new VersionManager(root).versionStatus(TAKEOVER_VERSION).phase).toBe("merged");
        const historyAfterSecondRound = metaHistoryDigests(root.meta);
        for (const [rel, hash] of historyBefore) {
          expect(historyAfterSecondRound.get(rel)).toBe(hash);
        }
      },
    );
  }
});
