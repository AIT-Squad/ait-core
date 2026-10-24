/** [TDD]-context_delivery — 完整内存上下文与仓外文件交付。 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DeliveryPointer, MemoryDelivery } from "../api/types.js";
import { reportProgress, type ProgressStage } from "../foundation/progress.js";
import type { ProjectRoot } from "../foundation/root.js";
import {
  codegenPrepare,
  type CodegenBundle,
  type ContextRole,
} from "../new-model/codegen.js";
import { issueGenerationToken } from "./generation-receipts.js";

export type { DeliveryMetadata, DeliveryPointer, MemoryDelivery } from "../api/types.js";

interface DeliveryOptions {
  tddRoot: string;
  version?: string | null;
  output?: "memory" | "file";
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

function deliveryStage<T>(stage: ProgressStage, work: () => T): T {
  reportProgress(stage, "started");
  try {
    const result = work();
    reportProgress(stage, "completed");
    return result;
  } catch (error) {
    reportProgress(stage, "failed");
    throw error;
  }
}

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
        parts.push("（无）目标文件尚不存在。\n");
        break;
      case "unreadable":
        parts.push("目标文件存在但读取失败（unreadable）。\n");
        break;
    }
  }
  return parts.join("");
}

export function prepareDelivery(
  root: ProjectRoot,
  opts: DeliveryOptions & { output: "file" },
): DeliveryPointer;
export function prepareDelivery(
  root: ProjectRoot,
  opts: DeliveryOptions & { output?: "memory" },
): MemoryDelivery;
export function prepareDelivery(
  root: ProjectRoot,
  opts: DeliveryOptions,
): MemoryDelivery | DeliveryPointer;
export function prepareDelivery(
  root: ProjectRoot,
  opts: DeliveryOptions,
): MemoryDelivery | DeliveryPointer {
  // 版本与来源门禁先于任何交付目录、文件或令牌写入。
  const { bundle, content, bytes, metadata } = deliveryStage("assemble", () => {
    const bundle = codegenPrepare(root, opts.version ?? null, opts.tddRoot);
    const content = renderBundle(root, bundle);
    const bytes = Buffer.from(content, "utf8");
    return {
      bundle,
      content,
      bytes,
      metadata: {
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        version: bundle.version,
        target_file: bundle.targetFile,
        tdd_root: bundle.tddRoot,
        source_file: bundle.sourceFile,
      },
    };
  });

  let createdDirectory: string | undefined;
  try {
    let bundlePath: string | undefined;
    if (opts.output === "file") {
      bundlePath = deliveryStage("write_bundle", () => {
        const temporaryRoot = path.resolve(os.tmpdir());
        assertOutsideProject(path.resolve(root.cwd), temporaryRoot);
        const realProject = fs.realpathSync(root.cwd);
        assertOutsideProject(realProject, fs.realpathSync(temporaryRoot));
        createdDirectory = fs.mkdtempSync(path.join(temporaryRoot, "ait-codegen-"));
        assertOutsideProject(path.resolve(root.cwd), path.resolve(createdDirectory));
        const realDirectory = fs.realpathSync(createdDirectory);
        assertOutsideProject(realProject, realDirectory);
        const destination = path.join(realDirectory, "bundle.md");
        fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
        const stored = fs.readFileSync(destination);
        if (!stored.equals(bytes)) {
          throw new DeliveryError("DELIVERY_CONTENT_MISMATCH", "上下文交付文件的实际字节与完整组装结果不一致");
        }
        return destination;
      });
    }

    const generationToken = deliveryStage("register_delivery", () => issueGenerationToken(root, {
      version: metadata.version,
      tdd_root: metadata.tdd_root,
      target_file: metadata.target_file,
      content,
      bundle_sha256: metadata.sha256,
      bytes: metadata.bytes,
    }));
    // 此后仅用已验证的同一输入与签发结果构造返回值，不再访问磁盘。
    if (bundlePath !== undefined) {
      return { ...metadata, generation_token: generationToken, bundle_path: bundlePath };
    }
    return {
      ...metadata,
      generation_token: generationToken,
      content,
      target_state: bundle.targetState,
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
