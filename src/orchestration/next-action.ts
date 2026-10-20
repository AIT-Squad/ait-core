import type { NextAction } from "../doc-model/schemas.js";

/** 宿主接续指令与会话背景共用的流程契约。 */
export function contractText(): string {
  return "流程：命令讨论 → 携令牌写入 → 分层确认 → 上下文交付 → 宿主生成 → 生成回执 → 验收 → 版本确认 → 合并。core 不调用 LLM；宿主决定并执行工具拦截；生成回执不证明语义正确。确认与合并须显式决定，接续建议不表示这些操作已执行。";
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 调用文本采用 Node 表达式，不依赖宿主 shell 的引号规则。 */
function literal(value: string | readonly string[]): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function discussionAction(
  operation: string,
  result: Record<string, unknown>,
): NextAction | null {
  const layer = operation.split(" ")[0];
  const target = result.target === undefined ? result.id : record(result.target)?.id;
  const anchor = result.anchor === undefined ? result.parent : record(result.anchor)?.id;
  const version = result.version;
  const token = result.context_token;
  if (
    result.layer !== layer || !nonempty(target) || !nonempty(version) ||
    !nonempty(token) ||
    (anchor !== undefined && anchor !== null && !nonempty(anchor)) ||
    ((layer === "tdd" || operation === "fsd decompose") && !nonempty(anchor))
  ) {
    return null;
  }

  const argv = operation.split(" ");
  if (operation === "fsd decompose") {
    if (!nonempty(anchor)) return null;
    argv.push(anchor, target);
  } else {
    argv.push(target);
    if (nonempty(anchor)) {
      if (layer === "prd") return null;
      argv.push("--parent", anchor);
    }
  }

  for (const name of ["action", "file", "overrides"] as const) {
    const value = result[name];
    if (value === undefined) continue;
    if (!nonempty(value) || (name === "action" && value !== "add" && value !== "modify")) {
      return null;
    }
    argv.push(`--${name}`, value);
  }
  argv.push("--context-token", token, "--content", "<讨论后确定的完整正文>");

  return {
    type: "present_and_collect",
    instruction: `${contractText()}\n呈现 ${operation} 返回的讨论背景，收集并确定正文；执行前核对活动版本仍为 ${literal(version)}，保持本次目标、父锚点与写入意图。将调用中的正文占位替换为讨论后的完整正文，并携带本次 context_token 写入。`,
    // create/decompose 没有 --version 参数；显式保留活动版本前置条件。
    required_next_call: `// active version must be ${literal(version)}\nawait dispatch(${literal(argv)})`,
  };
}

function generationAction(result: Record<string, unknown>): NextAction | null {
  const { bundle_path, sha256, bytes, version, target_file, tdd_root, source_file, generation_token } = result;
  if (
    !nonempty(bundle_path) || !nonempty(sha256) || !/^[a-f\d]{64}$/i.test(sha256) ||
    typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
    (version !== null && !nonempty(version)) || !nonempty(target_file) ||
    !nonempty(tdd_root) || !nonempty(source_file) || !nonempty(generation_token)
  ) {
    return null;
  }

  const unreadable = result.target_state === "unreadable" || result.targetState === "unreadable";
  const targetInstruction = unreadable
    ? "目标文件状态为 unreadable，暂停覆盖；先解决读取问题并重新取得可读上下文，再按规格生成。"
    : "检查 bundle 中的目标文件状态；若为 unreadable，暂停覆盖并先解决读取问题，重新取得可读上下文后再生成。";
  return {
    type: "continue",
    instruction: `${contractText()}\n完整读取 bundle_path=${literal(bundle_path)}，核验实际字节数 bytes=${bytes} 与 SHA-256 sha256=${literal(sha256)} 均一致后，依据其中规格生成唯一目标 target_file=${literal(target_file)}（version=${version === null ? "null（baseline）" : literal(version)}，tdd_root=${literal(tdd_root)}，source_file=${literal(source_file)}）。${targetInstruction}校验失败时暂停生成。完成制品生成后，执行 bundle 规定的相关测试，确认测试通过且制品满足规格后，再调用 registerGenerationReceipt 登记本次交付的回执；测试失败不得呈现为生成验收成功。`,
    next_call: `registerGenerationReceipt(root, { generation_token: ${literal(generation_token)} })`,
  };
}

/** 仅描述真实结果；不执行调用，也不推进任何阶段。 */
export function buildNextAction(
  operation: string,
  result: Record<string, unknown>,
): NextAction | null {
  if (result.ok === false) return null;

  switch (operation) {
    case "prd create":
    case "fsd create":
    case "tdd create":
    case "fsd decompose":
      return result.mode === "discussion-context" ? discussionAction(operation, result) : null;
    case "codegen prepare":
      return generationAction(result);
    case "version create":
      return nonempty(result.version)
        ? { type: "report", message: `已创建版本 ${literal(result.version)}。` }
        : null;
    case "prd confirm":
    case "fsd confirm":
    case "tdd confirm": {
      const layer = operation.split(" ")[0];
      if (
        !nonempty(result.version) || result.phase !== `${layer}-confirm` ||
        !Array.isArray(result.confirmed) || !result.confirmed.every(nonempty)
      ) {
        return null;
      }
      return {
        type: "report",
        message: `版本 ${literal(result.version)} 的 ${layer?.toUpperCase()} 层已确认，包含 ${result.confirmed.length} 个 chunk；当前阶段为 ${literal(result.phase)}。`,
      };
    }
    case "version confirm":
      if (!nonempty(result.version) || typeof result.passed !== "boolean") return null;
      return {
        type: "report",
        message: `版本 ${literal(result.version)} 的确认检查${result.passed ? "已通过" : "未通过"}。`,
      };
    default:
      return null;
  }
}
