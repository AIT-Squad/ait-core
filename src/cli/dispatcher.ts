/**
 * [TDD]-cli_dispatcher — argv 解析、公共 API 适配与 CLI 输出。
 *
 * 业务只调用 createCoreApi 的分组接口；正文文件读取是输入转换。
 * dispatch 返回事实信封及可选展示描述，runCli 序列化并返回退出码，不终止宿主。
 */

import fs from "node:fs";
import { stringify } from "yaml";
import { createCoreApi } from "../api/core.js";
import type {
  ApiResult,
  CliDispatchResult,
  CliPresentation,
  CoreApi,
  CoreApiOptions,
  CoreResult,
  Direction,
  DocumentInput,
  EdgeRel,
  GraphQueryInput,
} from "../api/types.js";

// ---------------------------------------------------------------------------
// 内部类型与辅助（不导出）
// ---------------------------------------------------------------------------

type FlagKind = "value" | "boolean";
type DocLayer = "prd" | "fsd" | "tdd";
type DocumentOptions = Omit<DocumentInput, "id">;

interface CommandContext {
  core: CoreApi;
  /** 位置参数（个数已在 parseArgs 按命令规格校验）。 */
  args: string[];
  flags: Record<string, string | boolean>;
}

interface CommandSpec {
  positionals: readonly string[];
  flags: Record<string, FlagKind>;
  enums?: Record<string, readonly string[]>;
  requiredFlags?: readonly string[];
  /** 解析及正文输入转换先于 API 调用；不在这里解析项目或选择版本。 */
  validate?(args: string[], flags: Record<string, string | boolean>): void;
  presentation?(flags: Record<string, string | boolean>): CliPresentation;
  run(ctx: CommandContext): Promise<ApiResult<object>>;
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
      const kind = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
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
        // 显式空正文仍是写入请求，由 API 校验正文；其它 flag 不接受空值。
        if (value.length === 0 && name !== "content") {
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
  for (const name of spec.requiredFlags ?? []) {
    if (flags[name] === undefined) {
      throw new UsageError(`缺参数：--${name}`);
    }
  }
  return { positionals, flags };
}

// ---------------------------------------------------------------------------
// COMMANDS：命令直接映射公共 API（精确匹配；未匹配 → USAGE_ERROR）
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
const DIRECTION_ENUM = { direction: ["in", "out", "both"] as const };

function createOptsFrom(flags: Record<string, string | boolean>): DocumentOptions {
  const opts: DocumentOptions = {};
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

/** 每次调用只读取一次正文，结果保存在本次解析的 flags 中供 API 输入装配。 */
function resolveContentSource(
  flags: Record<string, string | boolean>,
): void {
  assertContentSourceExclusive(flags);
  const file = flags["content-file"];
  if (typeof file === "string") {
    flags.content = readContentFileOrThrow(file);
  }
}

function docCreate(layer: DocLayer): CommandSpec {
  return {
    positionals: ["id"],
    flags: CREATE_FLAGS,
    enums: ACTION_ENUM,
    validate: (_args, flags) => {
      resolveContentSource(flags);
    },
    // parent 保持原样送入；PRD 不支持父锚点，由公共 API 返回 USAGE_ERROR。
    run: ({ core, args, flags }) => core[layer].create({ id: args[0]!, ...createOptsFrom(flags) }),
  };
}

function docConfirm(layer: DocLayer): CommandSpec {
  return {
    positionals: [],
    flags: {},
    run: ({ core }) => core[layer].confirm(),
  };
}

function docRevert(layer: DocLayer): CommandSpec {
  return {
    positionals: [],
    flags: {},
    run: ({ core }) => core[layer].revert(),
  };
}

/** 两种命令共用图查询，只有 specgraph query 暴露关系与版本选项。 */
function depsLike(withFilters = false): CommandSpec {
  return {
    positionals: ["target"],
    flags: {
      direction: "value",
      ...(withFilters ? {
        derives: "boolean",
        decomposes: "boolean",
        details: "boolean",
        "depends-on": "boolean",
        version: "value",
      } as const : {}),
    },
    enums: DIRECTION_ENUM,
    run: ({ core, args, flags }) => {
      const input: GraphQueryInput = {
        target: args[0]!,
        direction: typeof flags.direction === "string" ? flags.direction as Direction : "both",
      };
      if (withFilters) {
        const rels: EdgeRel[] = [];
        if (flags.derives === true) rels.push("derives");
        if (flags.decomposes === true) rels.push("decomposes");
        if (flags.details === true) rels.push("details");
        if (flags["depends-on"] === true) rels.push("depends_on");
        if (rels.length > 0) input.rels = rels;
        if (typeof flags.version === "string") input.version = flags.version;
      }
      return core.graph.query(input);
    },
  };
}

const COMMANDS: Record<string, CommandSpec> = {
  // 项目初始化的分支优先级由公共 API 保持。
  init: {
    positionals: [],
    flags: {
      name: "value",
      "refresh-wrapper": "boolean",
      check: "boolean",
      // 已废弃空操作：仅为使既有调用不因未知参数报 USAGE_ERROR，指定与否行为相同。
      "new-model": "boolean",
    },
    run: ({ core, flags }) => core.project.init({
      ...(typeof flags.name === "string" ? { name: flags.name } : {}),
      ...(flags.check === true ? { check: true } : {}),
      ...(flags["refresh-wrapper"] === true ? { refreshWrapper: true } : {}),
    }),
  },
  clone: {
    positionals: ["docs-url"],
    flags: {
      "host-url": "value",
      branch: "value",
      "docs-branch": "value",
    },
    run: ({ core, args, flags }) => core.project.clone({
      docsUrl: args[0]!,
      ...(typeof flags["host-url"] === "string" ? { hostUrl: flags["host-url"] } : {}),
      ...(typeof flags.branch === "string" ? { branch: flags.branch } : {}),
      ...(typeof flags["docs-branch"] === "string" ? { docsBranch: flags["docs-branch"] } : {}),
    }),
  },
  "repos show": {
    positionals: [],
    flags: {},
    run: ({ core }) => core.project.getRepositories(),
  },
  "repos set": {
    positionals: [],
    flags: {
      "host-url": "value",
      "docs-url": "value",
      "host-branch": "value",
      "docs-branch": "value",
    },
    requiredFlags: ["host-url", "docs-url"],
    run: ({ core, flags }) => core.project.setRepositories({
      hostUrl: flags["host-url"] as string,
      docsUrl: flags["docs-url"] as string,
      ...(typeof flags["host-branch"] === "string" ? { hostBranch: flags["host-branch"] } : {}),
      ...(typeof flags["docs-branch"] === "string" ? { docsBranch: flags["docs-branch"] } : {}),
    }),
  },

  // versioning 域：version_manager / merge_engine / publish 三 split
  "version create": {
    positionals: ["id"],
    flags: {},
    run: ({ core, args }) => core.version.create({ version: args[0]! }),
  },
  "version commit": {
    positionals: ["id"],
    flags: {},
    run: ({ core, args }) => core.version.commit({ version: args[0]! }),
  },
  "version status": {
    positionals: ["id"],
    flags: {},
    run: ({ core, args }) => core.version.status({ version: args[0]! }),
  },
  "version confirm": {
    positionals: ["id"],
    flags: {},
    run: ({ core, args }) => core.version.confirm({ version: args[0]! }),
  },
  "version merge": {
    positionals: ["id"],
    flags: {},
    run: ({ core, args }) => core.version.merge({ version: args[0]! }),
  },
  "version revert": {
    positionals: ["id"],
    flags: { confirm: "boolean" },
    run: ({ core, args, flags }) => core.version.revert({
      version: args[0]!,
      confirm: flags.confirm === true,
    }),
  },
  // 幂等补齐已合入版本的 `ait/<v>` 锚点标签；无参数（遍历全部已合入版本）。
  "version backfill-tags": {
    positionals: [],
    flags: {},
    run: ({ core }) => core.version.backfillTags(),
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
    validate: (_args, flags) => {
      resolveContentSource(flags);
    },
    run: ({ core, args, flags }) => core.fsd.decompose({
      parentSplit: args[0]!,
      childRootId: args[1]!,
      ...createOptsFrom(flags),
    }),
  },
  "codegen prepare": {
    positionals: ["tddRootId"],
    flags: { version: "value" },
    run: ({ core, args, flags }) => core.delivery.prepare({
      tddRootId: args[0]!,
      ...(typeof flags.version === "string" ? { version: flags.version } : {}),
      output: "file",
    }),
  },
  "codegen receipt": {
    positionals: [],
    flags: { "generation-token": "value" },
    requiredFlags: ["generation-token"],
    run: ({ core, flags }) => core.generation.registerReceipt({
      generationToken: flags["generation-token"] as string,
    }),
  },
  "codegen verify": {
    positionals: [],
    flags: { version: "value" },
    requiredFlags: ["version"],
    run: ({ core, flags }) => core.generation.verifyReceipts({ version: flags.version as string }),
  },

  // specgraph 域：deps/impact/query/sync/export/validate-new-model
  deps: depsLike(),
  impact: {
    positionals: ["target"],
    flags: {},
    run: ({ core, args }) => core.graph.impact({ target: args[0]! }),
  },
  "specgraph query": depsLike(true),
  "specgraph sync": {
    positionals: [],
    flags: {},
    run: ({ core }) => core.graph.sync(),
  },
  "specgraph export": {
    positionals: [],
    flags: { version: "value" },
    run: ({ core, flags }) => core.graph.export(
      typeof flags.version === "string" ? { version: flags.version } : undefined,
    ),
  },
  // 校验类：违规 → {ok:true,data:{passed:false,violations}}，退出码 0
  "specgraph validate-new-model": {
    positionals: [],
    flags: { version: "value" },
    run: ({ core, flags }) => core.graph.validateNewModel(
      typeof flags.version === "string" ? { version: flags.version } : undefined,
    ),
  },

  // search 域
  search: {
    positionals: ["query"],
    flags: { scope: "value", regexp: "boolean" },
    enums: { scope: ["baseline", "all"] as const },
    run: ({ core, args, flags }) => core.search.query({
      query: args[0]!,
      ...(typeof flags.scope === "string" ? { scope: flags.scope as "baseline" | "all" } : {}),
      ...(flags.regexp === true ? { regexp: true } : {}),
    }),
  },
  "baseline-summary": {
    positionals: [],
    flags: { scope: "value", format: "value" },
    enums: { scope: ["prd", "all"] as const, format: ["yaml", "json"] as const },
    presentation: (flags) => ({
      format: typeof flags.format === "string" ? flags.format as "yaml" | "json" : "yaml",
      projection: "baseline-items",
    }),
    run: ({ core, flags }) => flags.scope === "prd"
      ? core.search.baselineSummary({ scope: "prd" })
      : core.search.baselineSummary(),
  },

  // 状态输出归 core.state；CLI 只选择读模型及展示格式。
  state: {
    positionals: [],
    flags: { version: "value", save: "boolean", format: "value" },
    enums: { format: ["markdown", "json"] as const },
    run: ({ core, flags }) => {
      const version = typeof flags.version === "string" ? { version: flags.version } : {};
      const fmt = typeof flags.format === "string" ? flags.format as "markdown" | "json" : "markdown";
      if (flags.save === true) return core.state.save({ ...version, format: fmt });
      if (fmt === "json") return core.state.get(version);
      return core.state.render(version);
    },
  },

  reindex: {
    positionals: [],
    flags: {},
    run: ({ core }) => core.index.rebuild(),
  },

  "acceptance set": {
    positionals: ["command"],
    flags: {},
    run: ({ core, args }) => core.acceptance.set({ command: args[0]! }),
  },
  "acceptance run": {
    positionals: [],
    flags: {},
    run: ({ core }) => core.acceptance.run(),
  },
  "acceptance show": {
    positionals: [],
    flags: {},
    run: ({ core }) => core.acceptance.show(),
  },
  push: {
    positionals: [],
    flags: { "dry-run": "boolean" },
    run: ({ core, flags }) => core.publish.push(
      flags["dry-run"] === true ? { dryRun: true } : undefined,
    ),
  },
};

/** 两词命令优先；未匹配命令统一为 USAGE_ERROR。 */
function matchCommand(argv: string[]): string {
  const t0 = argv[0]!;
  if (t0.startsWith("--")) throw new UsageError(`未知命令：${t0}`);
  const t1 = argv[1];
  if (t1 !== undefined && !t1.startsWith("--")) {
    const two = `${t0} ${t1}`;
    if (Object.hasOwn(COMMANDS, two)) return two;
    if (!Object.hasOwn(COMMANDS, t0)) throw new UsageError(`未知命令：${two}`);
    return t0;
  }
  if (Object.hasOwn(COMMANDS, t0)) return t0;
  throw new UsageError(`未知命令：${t0}`);
}

/** 具体 DTO 的字段保持原样，只把类型收敛到 argv 通用信封。 */
function cliResult(result: ApiResult<object>): CliDispatchResult {
  if (!result.ok) return result;
  return { ok: true, data: { ...result.data } };
}

function emit(result: CliDispatchResult): void {
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.presentation?.projection === "baseline-items") {
    const items = result.data.items;
    if (result.presentation.format === "json") {
      process.stdout.write(`${JSON.stringify({ ok: true, data: items })}\n`);
    } else {
      process.stdout.write(stringify(items, { lineWidth: 0 }));
    }
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, data: result.data })}\n`);
}

export async function dispatch(
  argv: string[],
  options?: CoreApiOptions,
): Promise<CliDispatchResult> {
  try {
    if (argv.length === 0) {
      throw new UsageError(
        "缺命令：init / clone / repos show|set / version <sub> / prd|fsd|tdd <sub> / fsd decompose / codegen prepare|receipt|verify / deps / impact / state / search / specgraph <sub> / reindex / baseline-summary / acceptance <sub> / push / --version",
      );
    }
    if (argv[0] === "--version") {
      if (argv.length !== 1) throw new UsageError("参数非法：--version 不接受额外参数");
      return cliResult(await createCoreApi(options).project.documentVersion());
    }
    const key = matchCommand(argv);
    const spec = COMMANDS[key]!;
    const { positionals, flags } = parseArgs(argv.slice(key.split(" ").length), spec);
    spec.validate?.(positionals, flags);
    const core = createCoreApi(options);
    const result = cliResult(await spec.run({ core, args: positionals, flags }));
    if (result.ok && spec.presentation !== undefined) {
      return { ...result, presentation: spec.presentation(flags) };
    }
    return result;
  } catch (err) {
    if (err instanceof UsageError) return usageError(err.message);
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.length > 0) return { ok: false, error: message, code };
    return { ok: false, error: message, code: "INTERNAL_ERROR" };
  }
}

/** 进度只写 stderr；stdout 为选定的业务展示，退出码只镜像外层 ok。 */
export async function runCli(argv: string[]): Promise<number> {
  const result = await dispatch(argv, {
    onProgress(event) {
      try {
        process.stderr.write(`${JSON.stringify(event)}\n`);
      } catch {
        // 进度展示失败不能改变 API 的业务结果。
      }
    },
  });
  emit(result);
  return result.ok ? 0 : 1;
}
