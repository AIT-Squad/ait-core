/** [TDD]-context_delivery — 仓外完整上下文交付与可核验指针。 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NextAction } from "../doc-model/schemas.js";
import type { ProjectRoot } from "../foundation/root.js";
import {
  codegenPrepare,
  type CodegenBundle,
  type ContextRole,
} from "../new-model/codegen.js";
import { issueGenerationToken } from "./generation-receipts.js";
import { buildNextAction } from "./next-action.js";

export interface DeliveryPointer {
  bundle_path: string;
  sha256: string;
  bytes: number;
  version: string | null;
  target_file: string;
  tdd_root: string;
  source_file: string;
  generation_token: string;
  next_action: NextAction;
}

class DeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

const ROLES: readonly ContextRole[] = [
  "实现规格",
  "直接开发依据",
  "依赖的对外接口",
  "所属域约束",
  "相关实现参考",
  "产品意图",
  "目标文件现状",
];

function assertOutsideProject(project: string, directory: string): void {
  const relative = path.relative(project, directory);
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
    throw new DeliveryError("DELIVERY_PATH_INVALID", "上下文交付的临时目录必须位于整个项目仓库之外");
  }
}

function renderBundle(root: ProjectRoot, bundle: CodegenBundle): string {
  const parts = [
    `# Codegen Task — ${bundle.tddRoot}\n\n`,
    `target_file: ${JSON.stringify(bundle.targetFile)}\n`,
    `version: ${JSON.stringify(bundle.version)}\n`,
    `tdd_root: ${JSON.stringify(bundle.tddRoot)}\n`,
    `source_file: ${JSON.stringify(bundle.sourceFile)}\n`,
    `target_state: ${bundle.targetState}\n\n`,
    "仅修改 target_file；按下列章节顺序确定权威，完整保留并阅读各来源正文。\n",
  ];
  const items = [...bundle.upstream, ...bundle.dependencies];
  for (const [index, role] of ROLES.entries()) {
    parts.push(`\n## ${index + 1}. ${role}\n\n`);
    const selected = items.filter((item) => item.role === role);
    for (const item of selected) {
      parts.push(
        `id: ${JSON.stringify(item.id)}\n`,
        `source_file: ${JSON.stringify(item.file)}\n`,
        `selection_reason: ${JSON.stringify(item.selectionReason)}\n\n`,
        item.content,
        "\n\n",
      );
    }
    if (role !== "目标文件现状") {
      if (selected.length === 0) parts.push("（无）\n");
      continue;
    }
    parts.push(
      `id: ${JSON.stringify(bundle.targetFile)}\n`,
      `source_file: ${JSON.stringify(path.resolve(root.cwd, bundle.targetFile))}\n`,
      `selection_reason: ${JSON.stringify(`TDD ${bundle.tddRoot} 的 target_file 当前状态`)}\n`,
      `target_state: ${bundle.targetState}\n\n`,
    );
    switch (bundle.targetState) {
      case "loaded":
        parts.push(bundle.targetContent!, "\n");
        break;
      case "absent":
        parts.push("（无）目标文件尚不存在，按规格新建。\n");
        break;
      case "unreadable":
        parts.push("目标文件存在但读取失败（unreadable）。停止生成并报告读取错误；先解决读取问题并重新交付上下文，不得以空内容覆盖。\n");
        break;
    }
  }
  return parts.join("");
}

export function prepareDelivery(
  root: ProjectRoot,
  opts: { tddRoot: string; version?: string | null },
): DeliveryPointer {
  // 版本与来源门禁先于任何交付目录、文件或令牌写入。
  const bundle = codegenPrepare(root, opts.version ?? null, opts.tddRoot);
  const content = Buffer.from(renderBundle(root, bundle), "utf8");
  const temporaryRoot = path.resolve(os.tmpdir());
  assertOutsideProject(path.resolve(root.cwd), temporaryRoot);
  const realProject = fs.realpathSync(root.cwd);
  assertOutsideProject(realProject, fs.realpathSync(temporaryRoot));

  let createdDirectory: string | undefined;
  try {
    createdDirectory = fs.mkdtempSync(path.join(temporaryRoot, "ait-codegen-"));
    assertOutsideProject(path.resolve(root.cwd), path.resolve(createdDirectory));
    const realDirectory = fs.realpathSync(createdDirectory);
    assertOutsideProject(realProject, realDirectory);
    const bundlePath = path.join(realDirectory, "bundle.md");
    fs.writeFileSync(bundlePath, content, { flag: "wx", mode: 0o600 });
    const stored = fs.readFileSync(bundlePath);
    if (!stored.equals(content)) {
      throw new DeliveryError("DELIVERY_CONTENT_MISMATCH", "上下文交付文件的实际字节与完整组装结果不一致");
    }
    const pointer = {
      bundle_path: bundlePath,
      sha256: crypto.createHash("sha256").update(stored).digest("hex"),
      bytes: stored.length,
      version: bundle.version,
      target_file: bundle.targetFile,
      tdd_root: bundle.tddRoot,
      source_file: bundle.sourceFile,
    };
    const actionInput = { ...pointer, target_state: bundle.targetState };
    // 纯函数预检在发布令牌之前完成；签发函数保证返回非空令牌。
    const checkedAction = buildNextAction("codegen prepare", {
      ...actionInput,
      generation_token: "pending-generation-token",
    });
    if (checkedAction?.type !== "continue") {
      throw new DeliveryError("DELIVERY_ACTION_INVALID", "上下文交付缺少可构造接续动作的完整信息");
    }
    const generationToken = issueGenerationToken(root, {
      version: pointer.version,
      tdd_root: pointer.tdd_root,
      target_file: pointer.target_file,
      bundle_path: pointer.bundle_path,
      bundle_sha256: pointer.sha256,
      bytes: pointer.bytes,
    });
    // 此后仅用已验证的同一输入与签发结果构造返回值，不再访问磁盘。
    const nextAction = buildNextAction("codegen prepare", {
      ...actionInput,
      generation_token: generationToken,
    }) as Extract<NextAction, { type: "continue" }>;
    return {
      ...pointer,
      generation_token: generationToken,
      next_action: {
        ...nextAction,
        instruction: `${nextAction.instruction}\n执行规格要求的相关测试，测试通过后登记生成回执。`,
      },
    };
  } catch (error) {
    if (createdDirectory !== undefined) {
      try {
        fs.rmSync(createdDirectory, { recursive: true, force: true });
      } catch {
        // 仅清理本次 mkdtemp 创建的目录；保留原始错误与以前的有效交付。
      }
    }
    throw error;
  }
}