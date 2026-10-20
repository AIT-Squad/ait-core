// [TDD]-config_store v0.10
// 分层配置（共享 config.yaml / 机器本地 config.local.yaml）的读取合并与本地层写入。
// fail closed：配置文件存在但解析/校验失败时抛 CONFIG_UNREADABLE，绝不降级为空配置。
// 本文件不判断配置语义（哪个字段驱动哪个门禁归消费方）。

import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { loadModel, saveModel } from "./yaml.js";

// v0.1 过渡决策：ArtifactScope/ProjectConfig/LocalConfig 的最小 schema 内联于本文件；
// v0.2 起改从 doc_model 域导入（doc_model 是持久化 schema 的单一权威来源）。
export interface ArtifactScope {
  [k: string]: unknown;
}

export interface ProjectConfig {
  idPrefixSeparator: string;
  versionFormat: string;
  autoSnapshotOnMerge: boolean;
  artifactScopes: Record<string, ArtifactScope>;
  [k: string]: unknown;
}

export interface LocalConfig {
  skillDir?: string;
  cliPath?: string;
  wrapperPath?: string;
  acceptanceCommand?: string | null;
  acceptance_command?: string | null;
  [k: string]: unknown;
}

export class ConfigUnreadableError extends Error {
  readonly code = "CONFIG_UNREADABLE" as const;

  constructor(path: string, reason: string) {
    super(`配置文件不可读：${path}（${reason}）`);
    this.name = "ConfigUnreadableError";
  }
}

const CONFIG_FILE = "config.yaml";
const LOCAL_CONFIG_FILE = "config.local.yaml";

// 宽松 object schema：只要求顶层为对象，未知键透传（向前兼容新增机器字段）。
const LOOSE_OBJECT_SCHEMA = z.object({}).passthrough();

// 存在性 → 解析 → 校验的统一管线；文件不存在返回 {}（合法空配置），
// 存在但解析/校验失败抛 ConfigUnreadableError（含 path 与原因）。
function readLayer(filePath: string, label: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return loadModel(filePath, LOOSE_OBJECT_SCHEMA) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigUnreadableError(filePath, `${label}解析/校验失败：${reason}`);
  }
}

function readAcceptanceCommand(layer: Record<string, unknown>, filePath: string): string | null {
  let command: string | null = null;
  for (const key of ["acceptance_command", "acceptanceCommand"]) {
    if (!Object.hasOwn(layer, key)) continue;
    const value = layer[key];
    if (value !== null && typeof value !== "string") {
      throw new ConfigUnreadableError(filePath, `${key} 必须为字符串或 null`);
    }
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate) continue;
    if (command !== null && command !== candidate) {
      throw new ConfigUnreadableError(filePath, "acceptance_command 与 acceptanceCommand 冲突");
    }
    command = candidate;
  }
  return command;
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function loadConfig(root: string): ProjectConfig {
  const shared = readLayer(path.join(root, CONFIG_FILE), "共享层");
  const local = readLayer(path.join(root, LOCAL_CONFIG_FILE), "本地层");
  // 本地层覆盖共享层的机器字段；本地层缺失键（含 undefined）不覆盖。
  return { ...shared, ...dropUndefined(local) } as ProjectConfig;
}

export function loadLocalConfig(root: string): LocalConfig {
  return readLayer(path.join(root, LOCAL_CONFIG_FILE), "本地层") as LocalConfig;
}

export function loadAcceptanceCommand(root: string): string | null {
  const sharedPath = path.join(root, CONFIG_FILE);
  const localPath = path.join(root, LOCAL_CONFIG_FILE);
  const shared = readLayer(sharedPath, "共享层");
  const local = readLayer(localPath, "本地层");
  // 两层均先校验，避免健康的本地命令遮蔽共享层损坏。
  const sharedCommand = readAcceptanceCommand(shared, sharedPath);
  const localCommand = readAcceptanceCommand(local, localPath);
  return localCommand ?? sharedCommand;
}

export function writeLocalConfig(root: string, patch: Partial<LocalConfig>): void {
  const localPath = path.join(root, LOCAL_CONFIG_FILE);
  const local = readLayer(localPath, "本地层");
  const values = dropUndefined(patch as Record<string, unknown>);
  const hasSnakeCase = Object.hasOwn(values, "acceptance_command");
  const hasCamelCase = Object.hasOwn(values, "acceptanceCommand");
  if (hasSnakeCase || hasCamelCase) {
    const command = readAcceptanceCommand(values, localPath);
    delete local.acceptance_command;
    delete local.acceptanceCommand;
    if (hasSnakeCase && hasCamelCase) {
      // 双键归一为 Python 拼法，空值不得丢掉另一键的有效命令。
      values.acceptance_command = command ?? values.acceptance_command;
      delete values.acceptanceCommand;
    }
  }
  saveModel(localPath, { ...local, ...values });
}
