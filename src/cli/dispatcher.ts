/**
 * [TDD]-cli_dispatcher — cli 域命令分发器：argv 解析、命令表路由、CoreResult
 * 信封、双入口（dispatch 库函数 + runCli bin 薄壳）。
 *
 * 边界（反向要求）：本文件只做解析/路由/封装，不含任何业务规则；各域按命令
 * 动态 import 并惰性构造（import 本模块零副作用、零 IO）；不吞异常——域抛
 * 带 code 的错误原样透传 {ok:false,error,code}，无 code 异常统一包装
 * {ok:false,error:message,code:"INTERNAL_ERROR"} 并保留原始 message。
 */

import fs from "node:fs";
import path from "node:path";
import { resolveProjectRoot, type ProjectRoot } from "../foundation/root.js";
import type { CoreResult, NextAction } from "../doc-model/schemas.js";
import type { CreateOpts, DocLayer } from "../new-model/model-manager.js";

// ---------------------------------------------------------------------------
// 内部类型与辅助（不导出）
// ---------------------------------------------------------------------------

type FlagKind = "value" | "boolean";

interface CommandContext {
  /** 项目根（needsRoot 命令已惰性解析；init 豁免，为 null）。 */
  root: ProjectRoot | null;
  /** 位置参数（个数已在 parseArgs 按命令规格校验）。 */
  args: string[];
  flags: Record<string, string | boolean>;
}

interface CommandSpec {
  positionals: readonly string[];
  flags: Record<string, FlagKind>;
  enums?: Record<string, readonly string[]>;
  /** init 豁免项目根解析（白板入口），其余命令一律惰性解析。 */
  needsRoot: boolean;
  /** 解析层校验（先于项目根解析与一切域调用）：抛 UsageError → USAGE_ERROR 零副作用。 */
  validate?(args: string[], flags: Record<string, string | boolean>): void;
  run(ctx: CommandContext): Promise<Record<string, unknown>>;
}

/** 用法错误：解析/匹配阶段抛出，dispatch 统一转 USAGE_ERROR，不进业务逻辑。 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usageError(message: string): CoreResult {
  return { ok: false, error: message, code: "USAGE_ERROR" };
}

/** 域返回对象进入统一信封组装，已有 next_action 保留。 */
function asData(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// parseArgs：--flag value / --flag=value / 布尔 flag / 位置参数；未知 flag 报错
// ---------------------------------------------------------------------------

function parseArgs(
  tokens: string[],
  spec: CommandSpec,
): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const kind = spec.flags[name];
      if (kind === undefined) {
        throw new UsageError(`未知 flag：--${name}`);
      }
      if (kind === "boolean") {
        if (eq !== -1) {
          throw new UsageError(`参数非法：布尔 flag 不接受值 --${name}`);
        }
        flags[name] = true;
      } else {
        let value: string;
        if (eq !== -1) {
          value = tok.slice(eq + 1);
        } else {
          i += 1;
          if (i >= tokens.length || tokens[i]!.startsWith("--")) {
            throw new UsageError(`缺参数：flag --${name} 缺参数值`);
          }
          value = tokens[i]!;
        }
        if (value.length === 0) {
          throw new UsageError(`缺参数：flag --${name} 参数值为空`);
        }
        flags[name] = value;
      }
    } else {
      positionals.push(tok);
    }
  }

  if (positionals.length < spec.positionals.length) {
    throw new UsageError(
      `缺参数：${spec.positionals[positionals.length] ?? spec.positionals[spec.positionals.length - 1]}`,
    );
  }
  if (positionals.length > spec.positionals.length) {
    throw new UsageError(
      `参数非法：多余的位置参数 ${positionals.slice(spec.positionals.length).join(" ")}`,
    );
  }
  for (const [name, allowed] of Object.entries(spec.enums ?? {})) {
    const v = flags[name];
    if (typeof v === "string" && !allowed.includes(v)) {
      throw new UsageError(
        `参数非法：--${name} 须为 ${allowed.join("|")}，实际 ${v}`,
      );
    }
  }
  return { positionals, flags };
}

// ---------------------------------------------------------------------------
// COMMANDS：一张命令→域调用的映射表（精确匹配；未匹配 → USAGE_ERROR）
// ---------------------------------------------------------------------------

const CREATE_FLAGS: Record<string, FlagKind> = {
  parent: "value",
  content: "value",
  "content-file": "value",
  overrides: "value",
  action: "value",
  "context-token": "value",
  "skip-context": "boolean",
  file: "value",
};

const DECOMPOSE_FLAGS: Record<string, FlagKind> = {
  content: "value",
  "content-file": "value",
  overrides: "value",
  action: "value",
  "context-token": "value",
  "skip-context": "boolean",
  file: "value",
};

const ACTION_ENUM = { action: ["add", "modify"] as const };
const DIRECTION_ENUM = { direction: ["from", "to", "both"] as const };

function createOptsFrom(flags: Record<string, string | boolean>): CreateOpts {
  const opts: CreateOpts = {};
  if (typeof flags.parent === "string") opts.parent = flags.parent;
  if (typeof flags.content === "string") opts.content = flags.content;
  if (typeof flags.action === "string") {
    opts.action = flags.action as "add" | "modify";
  }
  if (typeof flags["context-token"] === "string") {
    opts.contextToken = flags["context-token"];
  }
  if (flags["skip-context"] === true) opts.skipContext = true;
  if (typeof flags.file === "string") opts.file = flags.file;
  if (typeof flags.overrides === "string") opts.overrides = flags.overrides;
  return opts;
}

/**
 * 正文来源解析（解析层职责，落在任何域调用之前 → 同现/不可读均零落盘）：
 * `--content-file <path>` 从文件读正文，与 `--content` 互斥；读取失败一律
 * USAGE_ERROR，不把 fs 异常漏成 INTERNAL_ERROR。
 */
function readContentFileOrThrow(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`参数非法：--content-file 不可读（${file}）：${reason}`);
  }
}

/** 校验 --content 与 --content-file 互斥（不读文件，只做形态检查）。 */
function assertContentSourceExclusive(
  flags: Record<string, string | boolean>,
): void {
  if (
    typeof flags.content === "string" &&
    typeof flags["content-file"] === "string"
  ) {
    throw new UsageError("参数非法：--content 与 --content-file 互斥，不可同时给出");
  }
}

/** create/decompose 的参数装配：互斥与文件读取先于域调用。 */
function createOptsFor(
  flags: Record<string, string | boolean>,
): CreateOpts {
  assertContentSourceExclusive(flags);
  const opts = createOptsFrom(flags);
  const file = flags["content-file"];
  if (typeof file === "string") {
    opts.content = readContentFileOrThrow(file);
  }
  return opts;
}

/** 正则检索预校验：与检索域一致的 `i` 标志；非法 → USAGE_ERROR（零副作用）。 */
function compileRegexpOrThrow(pattern: string): void {
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new UsageError(`参数非法：--regexp 正则非法（${pattern}）：${reason}`);
  }
}

function docCreate(layer: DocLayer): CommandSpec {
  return {
    positionals: ["id"],
    flags: CREATE_FLAGS,
    enums: ACTION_ENUM,
    needsRoot: true,
    // 正文来源检查先于项目根解析：互斥/不可读一律 USAGE_ERROR 零落盘。
    validate: (_args, flags) => {
      createOptsFor(flags);
    },
    run: async ({ root, args, flags }) => {
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return asData(
        await new NewModelManager(root!).createDocument(
          layer,
          args[0]!,
          createOptsFor(flags),
        ),
      );
    },
  };
}

function docConfirm(layer: DocLayer): CommandSpec {
  return {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return asData(new NewModelManager(root!).confirmLayer(layer));
    },
  };
}

function docRevert(layer: DocLayer): CommandSpec {
  return {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return asData(new NewModelManager(root!).revertLayer(layer));
    },
  };
}

/** deps 与 specgraph query 同构：组合视图上的邻边查询。 */
function depsLike(): CommandSpec {
  return {
    positionals: ["target"],
    flags: { direction: "value" },
    enums: DIRECTION_ENUM,
    needsRoot: true,
    run: async ({ root, args, flags }) => {
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { queryDeps } = await import("../specgraph/queries.js");
      const direction = typeof flags.direction === "string"
        ? (flags.direction as "from" | "to" | "both")
        : "both";
      return asData(queryDeps(combinedView(root!), args[0]!, direction));
    },
  };
}

const COMMANDS: Record<string, CommandSpec> = {
  // init 域：白板入口，豁免项目根解析
  init: {
    positionals: [],
    flags: {
      name: "value",
      "refresh-wrapper": "boolean",
      check: "boolean",
      // 已废弃空操作：仅为使既有调用不因未知参数报 USAGE_ERROR，指定与否行为相同。
      "new-model": "boolean",
    },
    needsRoot: false,
    // 分支顺序即优先级：--check（只读）优先于 --refresh-wrapper，同给时零写入。
    run: async ({ flags }) => {
      if (flags.check === true) {
        const { checkProject } = await import("../init/init-manager.js");
        return asData(checkProject(process.cwd()));
      }
      if (flags["refresh-wrapper"] === true) {
        const { refreshWrapper } = await import("../init/init-manager.js");
        return asData(refreshWrapper(process.cwd()));
      }
      const { initProject } = await import("../init/init-manager.js");
      const name = flags.name;
      return asData(
        initProject(process.cwd(), typeof name === "string" ? { name } : { name: "" }),
      );
    },
  },

  // versioning 域：version_manager / merge_engine / publish 三 split
  "version create": {
    positionals: ["id"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(new VersionManager(root!).versionCreate(args[0]!));
    },
  },
  "version commit": {
    positionals: ["id"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(new VersionManager(root!).versionCommit(args[0]!));
    },
  },
  "version status": {
    positionals: ["id"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(new VersionManager(root!).versionStatus(args[0]!));
    },
  },
  "version confirm": {
    positionals: ["id"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(await new VersionManager(root!).versionConfirm(args[0]!));
    },
  },
  "version merge": {
    positionals: ["id"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { versionMerge } = await import("../versioning/merge-engine.js");
      return asData(await versionMerge(root!, args[0]!));
    },
  },
  "version revert": {
    positionals: ["id"],
    flags: { confirm: "boolean" },
    needsRoot: true,
    run: async ({ root, args, flags }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(
        await new VersionManager(root!).versionRevert(args[0]!, {
          confirm: flags.confirm === true,
        }),
      );
    },
  },
  // 幂等补齐已合入版本的 `ait/<v>` 锚点标签；无参数（遍历全部已合入版本）。
  "version backfill-tags": {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { VersionManager } = await import(
        "../versioning/version-manager.js"
      );
      return asData(new VersionManager(root!).backfillRevertTags());
    },
  },

  // new_model 域：三层 create/confirm/revert 与 fsd decompose、codegen prepare
  "prd create": docCreate("prd"),
  "prd confirm": docConfirm("prd"),
  "prd revert": docRevert("prd"),
  "fsd create": docCreate("fsd"),
  "fsd confirm": docConfirm("fsd"),
  "fsd revert": docRevert("fsd"),
  "tdd create": docCreate("tdd"),
  "tdd confirm": docConfirm("tdd"),
  "tdd revert": docRevert("tdd"),
  "fsd decompose": {
    positionals: ["parentSplit", "childRootId"],
    flags: DECOMPOSE_FLAGS,
    enums: ACTION_ENUM,
    needsRoot: true,
    validate: (_args, flags) => {
      createOptsFor(flags);
    },
    run: async ({ root, args, flags }) => {
      const { NewModelManager } = await import("../new-model/model-manager.js");
      return asData(
        await new NewModelManager(root!).decompose(
          args[0]!,
          args[1]!,
          createOptsFor(flags),
        ),
      );
    },
  },
  "codegen prepare": {
    positionals: ["tddRootId"],
    flags: { version: "value" },
    needsRoot: true,
    run: async ({ root, args, flags }) => {
      const { prepareDelivery } = await import("../orchestration/context-delivery.js");
      return asData(prepareDelivery(root!, {
        tddRoot: args[0]!,
        ...(typeof flags.version === "string" ? { version: flags.version } : {}),
      }));
    },
  },

  // specgraph 域：deps/impact/query/sync/export/validate-new-model
  deps: depsLike(),
  impact: {
    positionals: ["target"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { analyzeImpact } = await import("../specgraph/queries.js");
      return asData(analyzeImpact(combinedView(root!), args[0]!));
    },
  },
  "specgraph query": depsLike(),
  "specgraph sync": {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { SpecGraphStore } = await import("../specgraph/graph-model.js");
      return asData(new SpecGraphStore(root!).sync());
    },
  },
  "specgraph export": {
    positionals: [],
    flags: { version: "value" },
    needsRoot: true,
    run: async ({ root, flags }) => {
      const { SpecGraphStore } = await import("../specgraph/graph-model.js");
      const store = new SpecGraphStore(root!);
      return asData(
        typeof flags.version === "string"
          ? store.load(flags.version)
          : store.load(),
      );
    },
  },
  // 校验类：违规 → {ok:true,data:{passed:false,violations}}，退出码 0
  "specgraph validate-new-model": {
    positionals: [],
    flags: { version: "value" },
    needsRoot: true,
    run: async ({ root, flags }) => {
      const { combinedView } = await import("../specgraph/graph-model.js");
      const { validateInvariants } = await import("../new-model/validator.js");
      const { evaluateGovernance } = await import("../new-model/governance.js");
      const { IndexManager } = await import("../indexing/index-manager.js");
      const { VersionMetaSchema } = await import("../doc-model/schemas.js");
      const { loadModel } = await import("../foundation/yaml.js");
      const { ensureWithin } = await import("../foundation/io.js");
      const versions = typeof flags.version === "string"
        ? [flags.version]
        : new IndexManager(root!).listVersions();
      const active = versions.filter((version) => {
        const metaPath = ensureWithin(path.join(root!.meta, "versions"), `${version}.yaml`);
        try {
          const meta = loadModel(metaPath, VersionMetaSchema);
          return meta.merged_at === null && meta.phase !== "merged";
        } catch (err) {
          if ((err as { code?: unknown } | null)?.code === "ENOENT") {
            throw Object.assign(new Error(`版本元数据不存在：${version}（${metaPath}）`), {
              code: "VERSION_NOT_FOUND",
            });
          }
          throw err;
        }
      });
      if (active.length > 1) {
        throw Object.assign(new Error(`存在多个活动版本：${active.join(", ")}`), {
          code: "ACTIVE_VERSION_CONFLICT",
        });
      }
      const effectiveVersion = active[0];
      const violations = validateInvariants(combinedView(root!, effectiveVersion));
      const report = evaluateGovernance(root!, effectiveVersion);
      return {
        version: effectiveVersion ?? "baseline",
        passed: violations.length === 0,
        violations,
        policy_violations: report.violations,
        warnings: report.warnings,
        target_file_missing: report.target_file_missing,
        derives_residue: report.derives_residue,
      };
    },
  },

  // search 域
  search: {
    positionals: ["query"],
    flags: { scope: "value", regexp: "boolean" },
    enums: { scope: ["baseline", "all"] as const },
    needsRoot: true,
    // 非法正则先于项目根解析与检索 → USAGE_ERROR 零副作用。
    validate: (args, flags) => {
      if (flags.regexp === true) {
        compileRegexpOrThrow(args[0]!);
      }
    },
    run: async ({ root, args, flags }) => {
      const { searchChunks } = await import("../search/keyword-search.js");
      const query = args[0]!;
      const scope = flags.scope;
      const regexp = flags.regexp === true;
      const hits = searchChunks(root!, query, {
        ...(typeof scope === "string"
          ? { scope: scope as "baseline" | "all" }
          : {}),
        ...(regexp ? { regexp: true } : {}),
      });
      return { query, count: hits.length, hits };
    },
  },
  "baseline-summary": {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { baselineSummary } = await import(
        "../search/baseline-summary.js"
      );
      return asData(baselineSummary(root!));
    },
  },

  // 状态域（state 面板归 src/cli/state.ts）：markdown 人读通道，json 才是契约
  state: {
    positionals: [],
    flags: { version: "value", save: "boolean", format: "value" },
    enums: { format: ["markdown", "json"] as const },
    needsRoot: true,
    run: async ({ root, flags }) => {
      const { renderState, saveState } = await import("./state.js");
      const version = typeof flags.version === "string" ? flags.version : null;
      const fmt = (typeof flags.format === "string" ? flags.format : "markdown") as
        | "markdown"
        | "json";
      const rendered = renderState(root!, version, fmt);
      if (flags.save !== true) {
        return asData(rendered);
      }
      // --save 只写 versions/<v>/state.md，其余文件不触碰。
      const savedTo = saveState(root!, version);
      return { ...asData(rendered), saved_to: savedTo };
    },
  },

  // indexing 域
  reindex: {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { IndexManager } = await import("../indexing/index-manager.js");
      return asData(new IndexManager(root!).rebuildBaseline());
    },
  },

  // versioning 域 publish split：acceptance 与 push
  "acceptance set": {
    positionals: ["command"],
    flags: {},
    needsRoot: true,
    run: async ({ root, args }) => {
      const { acceptanceSet } = await import("../versioning/publish.js");
      const command = args[0]!;
      acceptanceSet(root!, command);
      return { command };
    },
  },
  "acceptance run": {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { runAcceptance } = await import("../versioning/publish.js");
      return asData(runAcceptance(root!));
    },
  },
  "acceptance show": {
    positionals: [],
    flags: {},
    needsRoot: true,
    run: async ({ root }) => {
      const { acceptanceShow } = await import("../versioning/publish.js");
      return { command: acceptanceShow(root!) };
    },
  },
  push: {
    positionals: [],
    flags: { "dry-run": "boolean" },
    needsRoot: true,
    run: async ({ root, flags }) => {
      const { push } = await import("../versioning/publish.js");
      return asData(
        await push(
          root!,
          flags["dry-run"] === true ? { dryRun: true } : undefined,
        ),
      );
    },
  },
};

/** 命令匹配：先两词（version create / specgraph sync …）后单词；未匹配 → USAGE_ERROR。 */
function matchCommand(argv: string[]): string {
  const t0 = argv[0]!;
  if (t0.startsWith("--")) {
    throw new UsageError(`未知命令：${t0}`);
  }
  const t1 = argv[1];
  if (t1 !== undefined && !t1.startsWith("--")) {
    const two = `${t0} ${t1}`;
    if (two in COMMANDS) {
      return two;
    }
    if (!(t0 in COMMANDS)) {
      throw new UsageError(`未知命令：${two}`);
    }
    return t0;
  }
  if (t0 in COMMANDS) {
    return t0;
  }
  throw new UsageError(`未知命令：${t0}`);
}

// ---------------------------------------------------------------------------
// latestDocVersion：读 .meta/versions/v*.yaml 数值最大者；只读
// ---------------------------------------------------------------------------

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** 无版本记录或非项目根 → "unversioned"；任何读取失败同样回落，保证只读零副作用。 */
function latestDocVersion(cwd: string): string {
  try {
    const root = resolveProjectRoot(cwd);
    const names = fs
      .readdirSync(path.join(root.meta, "versions"))
      .filter((n) => /^v\d+(?:\.\d+)*\.yaml$/.test(n));
    if (names.length === 0) {
      return "unversioned";
    }
    const versions = names.map((n) => n.slice(0, -".yaml".length));
    versions.sort(compareVersionsDesc);
    return versions[0]!;
  } catch {
    return "unversioned";
  }
}

// ---------------------------------------------------------------------------
// emit：单 JSON 保证——信封序列化一次、单行写出一次，此后无第二段输出
// ---------------------------------------------------------------------------

function emit(result: CoreResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------------------
// 双入口
// ---------------------------------------------------------------------------

export async function dispatch(argv: string[]): Promise<CoreResult> {
  try {
    if (argv.length === 0) {
      throw new UsageError(
        "缺命令：init / version <sub> / prd|fsd|tdd <sub> / fsd decompose / codegen prepare / deps / impact / state / search / specgraph <sub> / reindex / baseline-summary / acceptance <sub> / push / --version",
      );
    }
    // --version：只读反映项目当前文档版本（非项目根/无记录 → unversioned）
    if (argv[0] === "--version") {
      if (argv.length !== 1) {
        throw new UsageError("参数非法：--version 不接受额外参数");
      }
      return {
        ok: true,
        data: { version: latestDocVersion(process.cwd()), next_action: null },
      };
    }

    const key = matchCommand(argv);
    const spec = COMMANDS[key]!;
    const { positionals, flags } = parseArgs(argv.slice(key.split(" ").length), spec);
    // 解析层校验先于项目根解析：参数形态错误不因"非项目根"被掩盖，且零副作用
    spec.validate?.(positionals, flags);
    // 惰性解析项目根（init 豁免）；ProjectRootError 自带 code 透传
    const root = spec.needsRoot ? resolveProjectRoot() : null;
    const data = await spec.run({ root, args: positionals, flags });
    const { buildNextAction } = await import("../orchestration/next-action.js");
    // 接续使用实际解析的写入意图；context_token 保留领域本次返回的值。
    const intent: Record<string, unknown> = {};
    for (const name of ["action", "parent", "file", "overrides"] as const) {
      if (typeof flags[name] === "string") intent[name] = flags[name];
    }
    if (key === "fsd decompose") intent.parent = positionals[0]!;
    return {
      ok: true,
      data: {
        ...data,
        next_action: (data.next_action as NextAction | null | undefined)
          ?? buildNextAction(key, { ...data, ...intent }),
      },
    };
  } catch (err) {
    if (err instanceof UsageError) {
      return usageError(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.length > 0) {
      // 域抛带 code 的错误：原样透传（含 USAGE_ERROR/NOT_AT_PROJECT_ROOT 等稳定码）
      return { ok: false, error: message, code };
    }
    // 无 code 异常：统一包装 INTERNAL_ERROR，保留原始 message
    return { ok: false, error: message, code: "INTERNAL_ERROR" };
  }
}

/** bin 薄壳：dispatch → stdout 单行 JSON → exit code 镜像 ok 字段。 */
export async function runCli(argv: string[]): Promise<number> {
  const result = await dispatch(argv);
  emit(result);
  return result.ok ? 0 : 1;
}
