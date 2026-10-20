import path from "node:path";

export interface GuardInput {
  projectRoot: string;
  cwd: string;
  toolName: string;
  input: unknown;
}

export interface GuardDecision {
  decision: "allow" | "block";
  reason: string | null;
}

function resolvePath(paths: typeof path.posix, base: string, target: string): string | null {
  if (!target || target.includes("\0")) return null;
  // A different drive's relative path needs ambient per-drive cwd state.
  if (paths === path.win32 && /^[a-z]:(?![\\/])/i.test(target)
    && target.slice(0, 2).toLowerCase() !== base.slice(0, 2).toLowerCase()) {
    return null;
  }
  return paths.resolve(base, target);
}

function shellWord(command: string, start: number, windows: boolean): {
  target: string | null;
  end: number;
} {
  let value = "";
  let quote = "";
  let dynamic = false;
  let index = start;
  for (; index < command.length; index++) {
    const char = command[index]!;
    if (!quote && /[\s;&|<>()]/.test(char)) break;
    if (char === quote) {
      quote = "";
      continue;
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (!windows && char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next === undefined) {
        dynamic = true;
        break;
      }
      if (!quote || /["\\$`\n]/.test(next)) {
        if (next !== "\n") value += next;
        index++;
        continue;
      }
    }
    if (quote !== "'" && /[$`]/.test(char)) dynamic = true;
    if (!quote && /[*?\[\]{}~]/.test(char)) dynamic = true;
    value += char;
  }
  if (windows && (/%[^%]+%/.test(value) || /![^!]+!/.test(value))) dynamic = true;
  return { target: !quote && !dynamic && value ? value : null, end: index };
}

function redirectionTargets(command: string, windows: boolean): string[] {
  const targets: string[] = [];
  let quote = "";
  let heredoc = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (!windows && char === "\\" && quote !== "'") index++;
      continue;
    }
    if ((!windows && char === "\\") || (windows && char === "`")) {
      index++;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\n" && heredoc) break;
    if (char === "#" && (index === 0 || /[\s;|&()]/.test(command[index - 1]!))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0 || heredoc) break;
      index = newline;
      continue;
    }
    // Only inspect the command header; heredoc contents are opaque.
    if (char === "<" && command[index + 1] === "<") heredoc = true;
    if (char !== ">") continue;
    if (command[index + 1] === ">") index++;
    let start = index + 1;
    while (command[start] === " " || command[start] === "\t") start++;
    if (command[start] === "#") continue;
    const word = shellWord(command, start, windows);
    if (word.target !== null) targets.push(word.target);
    index = Math.max(index, word.end - 1);
  }
  return targets;
}

/** Pure advisory write classification; the host applies the returned decision. */
export function evaluateWriteGuard(input: GuardInput): GuardDecision {
  const allow: GuardDecision = { decision: "allow", reason: null };
  if (!input || typeof input.projectRoot !== "string" || typeof input.cwd !== "string"
    || !input.projectRoot || !input.cwd || input.projectRoot.includes("\0")
    || input.input === null || typeof input.input !== "object" || Array.isArray(input.input)) {
    return allow;
  }
  const windows = /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(input.projectRoot);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(input.projectRoot)) return allow;
  const cwd = resolvePath(paths, input.projectRoot, input.cwd);
  if (cwd === null) return allow;
  const fields = input.toolName === "write" || input.toolName === "edit"
    ? ["path", "file_path", "target_file"]
    : input.toolName === "shell" ? ["command", "cmd"] : [];
  const record = input.input as Record<string, unknown>;
  const targets = fields.flatMap((field) => {
    const value = record[field];
    if (typeof value !== "string") return [];
    return input.toolName === "shell" ? redirectionTargets(value, windows) : [value];
  });
  const canonical = (value: string): string => windows ? value.toLowerCase() : value;
  const protectedPaths = ["docs", "versions", ".meta"].map((directory) =>
    canonical(paths.join(input.projectRoot, "project-docs", directory)),
  );
  for (const target of targets) {
    const resolved = resolvePath(paths, cwd, target);
    if (resolved === null) continue;
    for (const directory of protectedPaths) {
      const relative = paths.relative(directory, canonical(resolved));
      if (relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`)
        && !paths.isAbsolute(relative))) {
        return {
          decision: "block",
          reason: "该路径只许经 AIT 命令写入；请通过 AIT create/revert/merge 等正式流程修改。",
        };
      }
    }
  }
  return allow;
}
