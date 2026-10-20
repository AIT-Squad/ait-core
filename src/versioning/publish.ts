// [TDD]-publish v0.10
// 制品验收命令的配置与执行、双仓一体发布（先宿主仓后文档仓，文档仓附带 refs/tags/ait/* 锚点标签）。
// 硬约束：只推当前分支与 refs/tags/ait/*（无强制推送、不接受任意引用）；
// 不创建远端、不设置上游、不改写远端历史；推送失败不回滚已成功侧；幂等重跑收敛。

import { spawnSync } from "node:child_process";
import type { ProjectRoot } from "../foundation/root.js";
import {
  loadAcceptanceCommand,
  writeLocalConfig,
} from "../foundation/config.js";

export interface PushResult {
  status: "pushed" | "nothing" | "failed" | "not_applicable";
  detail: string;
}

export interface PushReport {
  host: PushResult;
  docs: PushResult;
}

// ---------- 验收命令 ----------

// 经 config_store 写本地层 acceptanceCommand。
export function acceptanceSet(root: ProjectRoot, command: string): void {
  writeLocalConfig(root.meta, { acceptanceCommand: command });
}

// 经 config_store 读有效验收命令（本地优先、共享回退）；未配置返回 null。
export function acceptanceShow(root: ProjectRoot): string | null {
  return loadAcceptanceCommand(root.meta);
}

// 未配置 → { ran:false, passed:true, exitCode:null }（真空通过，
// 与"配置损坏"严格区分：损坏时 loadAcceptanceCommand 抛 CONFIG_UNREADABLE 向上传播）。
// 已配置 → 子进程执行（shell:true，cwd=宿主根），passed = (exitCode === 0)。
export function runAcceptance(root: ProjectRoot): {
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
} {
  const command = loadAcceptanceCommand(root.meta);
  if (command === null) {
    return { ran: false, passed: true, exitCode: null };
  }
  const result = spawnSync(command, {
    shell: true,
    cwd: root.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = result.status;
  return { ran: true, passed: !result.error && exitCode === 0, exitCode };
}

// ---------- 内部辅助（不导出） ----------

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function gitIn(dir: string, args: string[]): GitOutcome {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

function hasUpstream(dir: string): boolean {
  return gitIn(dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]).ok;
}

function unpushedCommits(dir: string): string[] {
  const r = gitIn(dir, ["log", "@{u}..HEAD", "--oneline"]);
  if (!r.ok || r.stdout === "") {
    return [];
  }
  return r.stdout.split("\n").filter(Boolean);
}

function pendingChanges(dir: string): string[] {
  const r = gitIn(dir, ["status", "--porcelain"]);
  if (!r.ok || r.stdout === "") {
    return [];
  }
  return r.stdout.split("\n").filter(Boolean);
}

function aitTags(dir: string): string[] {
  const r = gitIn(dir, ["tag", "--list", "ait/*"]);
  if (!r.ok || r.stdout === "") {
    return [];
  }
  return r.stdout.split("\n").filter(Boolean);
}

// ---------- 双仓一体发布 ----------

export async function push(
  root: ProjectRoot,
  opts?: { dryRun?: boolean },
): Promise<PushReport> {
  const dryRun = opts?.dryRun === true;

  // withAitTags：仅文档仓附带 refs/tags/ait/* 锚点标签。
  const pushRepo = (
    dir: string,
    label: string,
    withAitTags: boolean,
  ): PushResult => {
    // 非 git 仓 → not_applicable 并标明。
    if (!gitIn(dir, ["rev-parse", "--is-inside-work-tree"]).ok) {
      return {
        status: "not_applicable",
        detail: `${label}：非 git 仓（${dir}），不发布`,
      };
    }
    // 无远端 → failed + 稳定错误码，不自动创建。
    const remotes = gitIn(dir, ["remote"]);
    if (!remotes.ok || remotes.stdout === "") {
      return {
        status: "failed",
        detail: `${label}：PUSH_NO_REMOTE 未配置远端，不自动创建，不静默跳过`,
      };
    }
    // 无上游 → failed + 稳定错误码，不自动设置。
    if (!hasUpstream(dir)) {
      return {
        status: "failed",
        detail: `${label}：PUSH_NO_UPSTREAM 当前分支无上游，不自动设置，不静默跳过`,
      };
    }
    // 有未提交改动 → detail 标明不携带，不阻断。
    const pending = pendingChanges(dir);
    const pendingNote =
      pending.length > 0
        ? `；有 ${pending.length} 项未提交改动，不携带`
        : "";
    const commits = unpushedCommits(dir);
    const tags = withAitTags ? aitTags(dir) : [];
    // 无待推提交 → nothing，不视为错误。
    if (commits.length === 0) {
      return {
        status: "nothing",
        detail: `${label}：无待推提交${pendingNote}`,
      };
    }
    // dryRun：只返回待推列表，不推送。
    if (dryRun) {
      const tagNote =
        withAitTags && tags.length > 0 ? `；待推标签：${tags.join(", ")}` : "";
      return {
        status: "nothing",
        detail: `${label}：dry-run 不推送；待推提交 ${commits.length} 个：${commits.join("；")}${tagNote}${pendingNote}`,
      };
    }
    // 推送当前分支（上游已配置，git push 默认 simple 策略只推当前分支；无强制推送）。
    const pushBranch = gitIn(dir, ["push"]);
    if (!pushBranch.ok) {
      return {
        status: "failed",
        detail: `${label}：推送当前分支失败：${pushBranch.stderr || pushBranch.stdout}${pendingNote}`,
      };
    }
    // 文档仓附带锚点标签：显式 refspec 仅推 refs/tags/ait/*（重跑幂等，已存在即 up-to-date）。
    if (withAitTags && tags.length > 0) {
      const up = gitIn(dir, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ]);
      const slash = up.stdout.indexOf("/");
      const remote = slash > 0 ? up.stdout.slice(0, slash) : "origin";
      const pushTags = gitIn(dir, [
        "push",
        remote,
        "refs/tags/ait/*:refs/tags/ait/*",
      ]);
      if (!pushTags.ok) {
        return {
          status: "failed",
          detail: `${label}：推送 refs/tags/ait/* 失败：${pushTags.stderr || pushTags.stdout}${pendingNote}`,
        };
      }
    }
    const tagNote =
      withAitTags && tags.length > 0 ? `，并推送标签：${tags.join(", ")}` : "";
    return {
      status: "pushed",
      detail: `${label}：已推送 ${commits.length} 个提交${tagNote}${pendingNote}`,
    };
  };

  // 先宿主后文档；两侧独立判定，任一侧失败不影响另一侧结果，不回滚已成功侧。
  const host = pushRepo(root.cwd, "宿主仓", false);
  const docs = pushRepo(root.root, "文档仓", true);
  return { host, docs };
}
