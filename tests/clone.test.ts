// [TDD]-clone_tests - real local Git integration tests for the v0.15
// docs-first, current-directory clone and shared repository configuration.

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCoreApi } from "../src/index.js";
import type { ApiResult, CoreApi } from "../src/index.js";
import { cloneProject } from "../src/init/clone-manager.js";
import { validateRepositoryUrl } from "../src/init/repository-config.js";

const diagnosticStub = vi.hoisted(() => ({ stderr: null as string | null, calls: [] as string[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: (...args: unknown[]) => {
    if (diagnosticStub.stderr !== null && args[0] === "git") {
      const argv = args[1] as string[];
      diagnosticStub.calls.push([...argv]);
      const stderr = argv.includes("clone") ? diagnosticStub.stderr : "fatal: not a git repository";
      return { pid: 0, status: 128, signal: null, stdout: "", stderr, output: [null, "", stderr] };
    }
    return Reflect.apply(original.spawnSync, undefined, args);
  } };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../dist/src/bin.js");
const TEMP = path.resolve(os.tmpdir());
const owned = new Set<string>();
const originalCwd = process.cwd();

interface Fixture {
  root: string;
  hostRemote: string;
  docsRemote: string;
  hostBranch: string;
  docsBranch: string;
  hostHead: string;
  docsHead: string;
  repositories: string;
}

function directory(label = "fixture"): string {
  const root = fs.mkdtempSync(path.join(TEMP, `ait-clone-${label}-`));
  owned.add(path.resolve(root));
  return root;
}

afterEach(() => {
  diagnosticStub.stderr = null;
  diagnosticStub.calls = [];
  process.chdir(originalCwd);
  for (const root of owned) {
    const relative = path.relative(TEMP, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
        || !path.basename(root).startsWith("ait-clone-")) {
      throw new Error(`Unsafe clone fixture cleanup refused: ${root}`);
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  owned.clear();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "AIT Clone Test",
      GIT_AUTHOR_EMAIL: "clone@example.invalid",
      GIT_COMMITTER_NAME: "AIT Clone Test",
      GIT_COMMITTER_EMAIL: "clone@example.invalid",
    },
  }).trim();
}

function api(cwd: string): CoreApi {
  const before = process.cwd();
  process.chdir(cwd);
  try { return createCoreApi(); } finally { process.chdir(before); }
}

function unwrap<T extends object>(result: ApiResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.data;
}

function rejection(result: ApiResult<object>, code: string): void {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) throw new Error(`Expected ${code}`);
  expect(result).toEqual({ ok: false, code, error: expect.any(String) });
  expect(result.error.length).toBeGreaterThan(0);
}

function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      hash.update(`${relative}\0${entry.isDirectory() ? "d" : "f"}\0`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) hash.update(fs.readFileSync(absolute));
      else hash.update("link").update(fs.readlinkSync(absolute));
    }
  };
  visit(root);
  return hash.digest("hex");
}

function runBin(cwd: string, args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`clone CLI timed out\n${stderr}`)); }, 90_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function makeFixture(options: {
  hostBranch?: string;
  docsBranch?: string;
  hostTree?: Record<string, string>;
  rootLabel?: string;
  omitBranches?: boolean;
} = {}): Promise<Fixture> {
  const root = directory(options.rootLabel ?? "remotes");
  const hostBranch = options.hostBranch ?? "trunk-host";
  const docsBranch = options.docsBranch ?? "specs-live";
  const hostWork = path.join(root, "host work");
  const docsWork = path.join(root, "docs work");
  const hostRemote = path.join(root, "host remote.git");
  const docsRemote = path.join(root, "docs remote.git");

  fs.mkdirSync(hostWork);
  git(hostWork, "init", "-b", hostBranch);
  const hostTree = options.hostTree ?? { "README.md": "host repository\n", "src/value.txt": "value\n" };
  for (const [relative, content] of Object.entries(hostTree)) {
    const target = path.join(hostWork, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(hostWork, "add", ".");
  git(hostWork, "commit", "-m", "host baseline");
  git(root, "clone", "--bare", hostWork, hostRemote);
  git(hostRemote, "symbolic-ref", "HEAD", `refs/heads/${hostBranch}`);

  fs.mkdirSync(docsWork);
  unwrap(await api(docsWork).project.init({ name: "clone-fixture" }));
  const repositories = path.join(docsWork, "project-docs", ".meta", "repositories.yaml");
  unwrap(await api(docsWork).project.setRepositories({
    hostUrl: hostRemote,
    docsUrl: docsRemote,
    ...(options.omitBranches ? {} : { hostBranch, docsBranch }),
  }));
  // Pin this fixture's metadata bytes across Git's platform EOL settings.
  fs.writeFileSync(path.join(docsWork, "project-docs", ".gitattributes"), ".meta/repositories.yaml -text\n");
  git(path.join(docsWork, "project-docs"), "checkout", "-B", docsBranch);
  // init deliberately leaves the newly-created root specs/index refresh in the
  // docs worktree.  The remote fixture must publish the complete valid project,
  // not merely the repository association file.
  git(path.join(docsWork, "project-docs"), "add", ".");
  git(path.join(docsWork, "project-docs"), "commit", "-m", "associate repositories");
  git(path.join(docsWork, "project-docs"), "tag", "docs-v1");
  git(root, "clone", "--bare", path.join(docsWork, "project-docs"), docsRemote);
  git(docsRemote, "symbolic-ref", "HEAD", `refs/heads/${docsBranch}`);

  return {
    root, hostRemote, docsRemote, hostBranch, docsBranch,
    hostHead: git(hostWork, "rev-parse", "HEAD"),
    docsHead: git(path.join(docsWork, "project-docs"), "rev-parse", "HEAD"),
    repositories: fs.readFileSync(repositories, "utf8"),
  };
}

describe("shared repository configuration", { timeout: 30_000 }, () => {
  it("reports missing metadata without writing and does not echo corrupt credential-bearing YAML", async () => {
    const cwd = directory("missing-repositories");
    unwrap(await api(cwd).project.init({ name: "missing-repositories" }));
    const before = treeHash(cwd);
    rejection(await api(cwd).project.getRepositories(), "REPOSITORIES_NOT_FOUND");
    expect(treeHash(cwd)).toBe(before);
    const secret = "yaml-private-value";
    fs.writeFileSync(path.join(cwd, "project-docs/.meta/repositories.yaml"), `host: [https://user:${secret}@example.invalid/repo\n`);
    const failed = await api(cwd).project.getRepositories();
    rejection(failed, "REPOSITORIES_INVALID");
    expect(JSON.stringify(failed)).not.toContain(secret);
  });
  it("round-trips a complete replacement without changing remotes or committing", async () => {
    const cwd = directory("repos");
    unwrap(await api(cwd).project.init({ name: "repos" }));
    const docs = path.join(cwd, "project-docs");
    const beforeHead = git(docs, "rev-parse", "HEAD");
    const value = unwrap(await api(cwd).project.setRepositories({
      hostUrl: "git@example.com:team/host.git",
      docsUrl: "ssh://git@example.com/team/docs.git",
      hostBranch: "release/one",
      docsBranch: "specs/one",
    }));
    expect(path.isAbsolute(value.path)).toBe(true);
    expect(value.repositories).toEqual({
      schema_version: 1,
      host: { url: "git@example.com:team/host.git", branch: "release/one" },
      docs: { url: "ssh://git@example.com/team/docs.git", branch: "specs/one", path: "project-docs" },
    });
    expect(unwrap(await api(cwd).project.getRepositories())).toEqual(value);
    expect(git(docs, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(docs, "remote")).toBe("");

    const replaced = unwrap(await api(cwd).project.setRepositories({
      hostUrl: path.join(cwd, "host.git"), docsUrl: path.join(cwd, "docs.git"),
    }));
    expect(replaced.repositories.host).toEqual({ url: path.join(cwd, "host.git") });
    expect(replaced.repositories.docs).toEqual({ url: path.join(cwd, "docs.git"), path: "project-docs" });
  });

  it("rejects credentials, relative/helper URLs, unsafe branches, unknown input, and leaves bytes unchanged", async () => {
    const cwd = directory("repos-invalid");
    unwrap(await api(cwd).project.init({ name: "repos-invalid" }));
    const core = api(cwd);
    unwrap(await core.project.setRepositories({ hostUrl: "https://example.invalid/h.git", docsUrl: "https://example.invalid/d.git" }));
    const file = path.join(cwd, "project-docs", ".meta", "repositories.yaml");
    const before = fs.readFileSync(file);
    const invalid: unknown[] = [
      { hostUrl: "https://user:secret@example.invalid/h.git", docsUrl: "https://example.invalid/d.git" },
      { hostUrl: "https://example.invalid/h.git?token=secret", docsUrl: "https://example.invalid/d.git" },
      { hostUrl: "../host.git", docsUrl: "https://example.invalid/d.git" },
      { hostUrl: "ext::sh -c bad", docsUrl: "https://example.invalid/d.git" },
      { hostUrl: "https://example.invalid/h.git", docsUrl: "https://example.invalid/d.git", hostBranch: "--upload-pack=bad" },
      { hostUrl: "https://example.invalid/h.git", docsUrl: "https://example.invalid/d.git", docsBranch: "@{-1}" },
      { hostUrl: "https://example.invalid/h.git", docsUrl: "https://example.invalid/d.git", surprise: true },
    ];
    for (const input of invalid) {
      const unknown = Object.hasOwn(input as object, "surprise");
      rejection(await (core.project.setRepositories as (value: unknown) => Promise<ApiResult<object>>)(input), unknown ? "USAGE_ERROR" : "REPOSITORIES_INVALID");
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });

  it("fails closed on malformed/unknown metadata and refuses a symlinked target", async () => {
    const cwd = directory("repos-corrupt");
    unwrap(await api(cwd).project.init({ name: "repos-corrupt" }));
    const file = path.join(cwd, "project-docs", ".meta", "repositories.yaml");
    fs.writeFileSync(file, "schema_version: 2\nhost: {}\ndocs: {}\nunknown: true\n");
    rejection(await api(cwd).project.getRepositories(), "REPOSITORIES_INVALID");

    fs.rmSync(file);
    const outside = path.join(cwd, "outside.yaml");
    fs.writeFileSync(outside, "do-not-touch\n");
    try {
      fs.symlinkSync(outside, file, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        const meta = path.dirname(file);
        const moved = path.join(cwd, "external-meta");
        fs.renameSync(meta, moved);
        fs.symlinkSync(moved, meta, "junction");
        rejection(await api(cwd).project.getRepositories(), "REPOSITORIES_INVALID");
        expect(fs.readFileSync(outside, "utf8")).toBe("do-not-touch\n");
        return;
      }
      throw error;
    }
    rejection(await api(cwd).project.getRepositories(), "REPOSITORIES_INVALID");
    expect(fs.readFileSync(outside, "utf8")).toBe("do-not-touch\n");
  });
});

describe("docs-first clone", { timeout: 120_000 }, () => {
  it("clones two non-main default branches in place through the public API", async () => {
    const fixture = await makeFixture({ rootLabel: "unicode-\u4e2d\u6587", omitBranches: true });
    const cwd = directory("destination with space \u4e2d\u6587");
    const result = unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote }));

    expect(result.directory).toBe(path.resolve(cwd));
    expect(result.resumed).toBe(false);
    expect(result.host).toMatchObject({ path: path.resolve(cwd), url: fixture.hostRemote, branch: fixture.hostBranch, commit: fixture.hostHead });
    expect(result.docs).toMatchObject({ path: path.join(path.resolve(cwd), "project-docs"), url: fixture.docsRemote, branch: fixture.docsBranch, commit: fixture.docsHead });
    expect(path.isAbsolute(result.wrapper)).toBe(true);
    expect(fs.existsSync(result.wrapper)).toBe(true);
    expect(git(cwd, "remote", "get-url", "origin")).toBe(fixture.hostRemote);
    expect(git(path.join(cwd, "project-docs"), "remote", "get-url", "origin")).toBe(fixture.docsRemote);
    expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${fixture.hostBranch}`);
    expect(git(path.join(cwd, "project-docs"), "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${fixture.docsBranch}`);
    expect(git(path.join(cwd, "project-docs"), "tag", "--list", "docs-v1")).toBe("docs-v1");
    expect(fs.readFileSync(path.join(cwd, "project-docs", ".meta", "repositories.yaml"), "utf8")).toBe(fixture.repositories);
    expect(git(cwd, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(path.join(cwd, "project-docs"), "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("supports explicit independent branches and a one-shot host URL override without rewriting shared metadata", async () => {
    const configured = await makeFixture({ hostBranch: "host-release", docsBranch: "docs-release" });
    const override = await makeFixture({ hostBranch: "override-host", docsBranch: "unused-docs" });
    const cwd = directory("override");
    const data = unwrap(await api(cwd).project.clone({
      docsUrl: configured.docsRemote,
      hostUrl: override.hostRemote,
      branch: override.hostBranch,
      docsBranch: configured.docsBranch,
    }));
    expect(data.host.url).toBe(override.hostRemote);
    expect(data.host.branch).toBe(override.hostBranch);
    expect(data.docs.branch).toBe(configured.docsBranch);
    expect(fs.readFileSync(path.join(cwd, "project-docs", ".meta", "repositories.yaml"), "utf8")).toBe(configured.repositories);
  });

  it("runs the real CLI with single JSON stdout and progress only on stderr", async () => {
    const fixture = await makeFixture();
    const cwd = directory("cli");
    const run = await runBin(cwd, ["clone", fixture.docsRemote]);
    expect(run.status, run.stderr).toBe(0);
    const lines = run.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!) as { ok: boolean; data?: { host: { commit: string }; docs: { commit: string } } };
    expect(envelope).toMatchObject({ ok: true, data: { host: { commit: fixture.hostHead }, docs: { commit: fixture.docsHead } } });
    for (const phase of ["git", "read", "validate", "persist"]) expect(run.stderr).toContain(phase);

    const wrapper = process.platform === "win32"
      ? path.join(cwd, "project-docs", ".ait", "ait-cli.cmd")
      : path.join(cwd, "project-docs", ".ait", "ait-cli");
    const wrapperRun = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/v:on", "/c", '""!AIT_CLONE_TEST_WRAPPER!" --version"'], { cwd, encoding: "utf8", windowsVerbatimArguments: true, env: { ...process.env, AIT_CLONE_TEST_WRAPPER: wrapper } })
      : spawnSync(wrapper, ["--version"], { cwd, encoding: "utf8" });
    expect(wrapperRun.status, wrapperRun.stderr).toBe(0);
    expect(JSON.parse(wrapperRun.stdout)).toMatchObject({ ok: true });
  });

  it("rejects unknown/extra/cancelled inputs before touching an empty directory", async () => {
    const fixture = await makeFixture();
    for (const args of [
      ["clone"],
      ["clone", fixture.docsRemote, "extra-directory"],
      ["clone", fixture.docsRemote, "--unknown"],
      ["clone", fixture.docsRemote, "--branch", "--bad"],
    ]) {
      const cwd = directory("bad-cli");
      const before = treeHash(cwd);
      const run = await runBin(cwd, args);
      expect(run.status).toBe(1);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, code: "USAGE_ERROR" });
      expect(treeHash(cwd)).toBe(before);
    }

    const cwd = directory("cancelled");
    const controller = new AbortController();
    controller.abort();
    const before = treeHash(cwd);
    expect(() => {
      const old = process.cwd(); process.chdir(cwd);
      try {
        // @ts-expect-error cancellation is intentionally not a factory option.
        createCoreApi({ signal: controller.signal });
      } finally { process.chdir(old); }
    }).toThrow(/signal/);
    expect(treeHash(cwd)).toBe(before);
  });

  it("refuses nonempty destinations and host trees that collide with project-docs without overwriting", async () => {
    const fixture = await makeFixture();
    const nonempty = directory("nonempty");
    fs.writeFileSync(path.join(nonempty, "valuable.txt"), "keep\n");
    const before = treeHash(nonempty);
    rejection(await api(nonempty).project.clone({ docsUrl: fixture.docsRemote }), "CLONE_DIRECTORY_NOT_EMPTY");
    expect(treeHash(nonempty)).toBe(before);

    const collision = await makeFixture({ hostTree: { "Project-Docs/owned.txt": "collision\n" } });
    const target = directory("collision");
    const failed = await api(target).project.clone({ docsUrl: collision.docsRemote });
    rejection(failed, "CLONE_PATH_CONFLICT");
    expect(fs.existsSync(path.join(target, "project-docs", ".git"))).toBe(true);
    expect(fs.existsSync(path.join(target, "Project-Docs", "owned.txt"))).toBe(false);
  });

  it("preserves docs after host failure and safely resumes the same recorded operation", async () => {
    const fixture = await makeFixture();
    const cwd = directory("resume");
    const missingHost = path.join(fixture.root, "temporarily-missing.git");
    const metadata = path.join(cwd, "project-docs", ".meta", "repositories.yaml");
    const first = await api(cwd).project.clone({ docsUrl: fixture.docsRemote, hostUrl: missingHost });
    rejection(first, "CLONE_GIT_FAILED");
    expect(fs.existsSync(path.join(cwd, "project-docs", ".git"))).toBe(true);
    const docsHead = git(path.join(cwd, "project-docs"), "rev-parse", "HEAD");
    const state = path.join(cwd, "project-docs", ".git", "ait-clone-state.json");
    expect(fs.existsSync(state)).toBe(true);

    fs.renameSync(fixture.hostRemote, missingHost);
    const resumed = unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote, hostUrl: missingHost }));
    expect(resumed.resumed).toBe(true);
    expect(git(path.join(cwd, "project-docs"), "rev-parse", "HEAD")).toBe(docsHead);
    expect(fs.readFileSync(metadata, "utf8")).toBe(fixture.repositories);
  });

  it("completed repetition is read-only, while dirty or identity-mismatched recovery is rejected", async () => {
    const fixture = await makeFixture();
    const cwd = directory("repeat");
    unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote }));
    const before = treeHash(cwd);
    const repeated = unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote }));
    expect(repeated.resumed).toBe(true);
    expect(treeHash(cwd)).toBe(before);

    fs.writeFileSync(path.join(cwd, "local-change.txt"), "mine\n");
    const dirtyBefore = treeHash(cwd);
    const dirty = await api(cwd).project.clone({ docsUrl: fixture.docsRemote });
    expect(dirty.ok).toBe(false);
    expect(treeHash(cwd)).toBe(dirtyBefore);

    const other = await makeFixture();
    fs.rmSync(path.join(cwd, "local-change.txt"));
    rejection(await api(cwd).project.clone({ docsUrl: other.docsRemote }), "CLONE_REPOSITORY_MISMATCH");
  });

  it("does not touch host state when docs cloning or metadata validation fails", async () => {
    const cwd = directory("docs-fail");
    const missing = path.join(cwd, "missing-docs.git");
    const before = treeHash(cwd);
    const failed = await api(cwd).project.clone({ docsUrl: missing, hostUrl: path.join(cwd, "also-missing.git") });
    expect(failed.ok).toBe(false);
    expect(fs.existsSync(path.join(cwd, ".git"))).toBe(false);
    expect(treeHash(cwd)).toBe(before);

    const fixture = await makeFixture();
    const work = path.join(fixture.root, "corrupt-docs");
    git(fixture.root, "clone", fixture.docsRemote, work);
    fs.writeFileSync(path.join(work, ".meta", "repositories.yaml"), "schema_version: nope\n");
    git(work, "add", ".meta/repositories.yaml");
    git(work, "commit", "-m", "corrupt metadata");
    const corruptRemote = path.join(fixture.root, "corrupt-docs.git");
    git(fixture.root, "clone", "--bare", work, corruptRemote);
    const target = directory("invalid-metadata");
    rejection(await api(target).project.clone({ docsUrl: corruptRemote }), "REPOSITORIES_INVALID");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
  });

  it("serializes clone with repository writes for one cwd and never leaks credential URLs", async () => {
    const fixture = await makeFixture();
    const cwd = directory("serial");
    const core = api(cwd);
    const clone = core.project.clone({ docsUrl: fixture.docsRemote });
    const set = core.project.setRepositories({ hostUrl: fixture.hostRemote, docsUrl: fixture.docsRemote });
    const [cloned, configured] = await Promise.all([clone, set]);
    expect(cloned.ok).toBe(true);
    expect(configured.ok).toBe(true);

    const secret = "do-not-print-this-secret";
    const rejected = await api(directory("secret")).project.clone({ docsUrl: `https://user:${secret}@example.invalid/docs.git` });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(secret);
  });

  it("rejects missing docs branches before creating files and resumes when a missing host branch becomes available", async () => {
    const fixture = await makeFixture();
    const docsMissing = directory("missing-docs-branch");
    const before = treeHash(docsMissing);
    rejection(await api(docsMissing).project.clone({ docsUrl: fixture.docsRemote, docsBranch: "absent-docs" }), "CLONE_BRANCH_NOT_FOUND");
    expect(treeHash(docsMissing)).toBe(before);
    const hostMissing = directory("missing-host-branch");
    const input = { docsUrl: fixture.docsRemote, branch: "future-branch" };
    rejection(await api(hostMissing).project.clone(input), "CLONE_BRANCH_NOT_FOUND");
    const docsHead = git(path.join(hostMissing, "project-docs"), "rev-parse", "HEAD");
    git(fixture.hostRemote, "update-ref", "refs/heads/future-branch", fixture.hostHead);
    const result = unwrap(await api(hostMissing).project.clone(input));
    expect(result.host.branch).toBe("future-branch");
    expect(result.resumed).toBe(true);
    expect(result.docs.commit).toBe(docsHead);
  });

  it("preserves unknown files and rejects corrupt recovery state before retrying a failed host fetch", async () => {
    const fixture = await makeFixture();
    const cwd = directory("resume-conflict");
    const input = { docsUrl: fixture.docsRemote, hostUrl: path.join(fixture.root, "unavailable.git") };
    rejection(await api(cwd).project.clone(input), "CLONE_GIT_FAILED");
    const added = path.join(cwd, "valuable.txt");
    fs.writeFileSync(added, "keep unchanged\n");
    const before = treeHash(cwd);
    rejection(await api(cwd).project.clone(input), "CLONE_DIRECTORY_NOT_EMPTY");
    expect(treeHash(cwd)).toBe(before);
    fs.rmSync(added);
    const marker = path.join(cwd, "project-docs/.git/ait-clone-state.json");
    const state = JSON.parse(fs.readFileSync(marker, "utf8"));
    state.phase = "complete"; state.hostGitCreated = false;
    fs.writeFileSync(marker, JSON.stringify(state));
    const broken = treeHash(cwd);
    rejection(await api(cwd).project.clone(input), "CLONE_STATE_INVALID");
    expect(treeHash(cwd)).toBe(broken);
  });

  it("rejects a missing baseline index and tracked wrapper without synthesizing or overwriting them", async () => {
    const fixture = await makeFixture();
    for (const kind of ["missing-index", "tracked-wrapper"] as const) {
      const work = path.join(fixture.root, kind);
      git(fixture.root, "clone", fixture.docsRemote, work);
      if (kind === "missing-index") git(work, "rm", ".meta/chunks-index.yaml");
      else {
        fs.mkdirSync(path.join(work, ".ait"));
        fs.writeFileSync(path.join(work, ".ait/ait-cli.cmd"), "shared-wrapper-do-not-overwrite\n");
        git(work, "add", "-f", ".ait/ait-cli.cmd");
      }
      git(work, "commit", "-m", kind);
      const target = directory(kind);
      const result = await api(target).project.clone({ docsUrl: work });
      rejection(result, kind === "missing-index" ? "CLONE_PROJECT_INVALID" : "CLONE_PATH_CONFLICT");
      if (kind === "missing-index") expect(fs.existsSync(path.join(target, "project-docs/.meta/chunks-index.yaml"))).toBe(false);
      else expect(fs.readFileSync(path.join(target, "project-docs/.ait/ait-cli.cmd"), "utf8").trim()).toBe("shared-wrapper-do-not-overwrite");
    }
  });

  it("validates graph structure and rejects actual linked destinations without touching the outside directory", async () => {
    const fixture = await makeFixture();
    const work = path.join(fixture.root, "bad-graph");
    git(fixture.root, "clone", fixture.docsRemote, work);
    const graph = path.join(work, ".meta/specgraph.yaml");
    const original = fs.readFileSync(graph, "utf8");
    fs.writeFileSync(graph, original.replace(/^edges:[\s\S]*$/m, "edges: []\n"));
    git(work, "add", ".meta/specgraph.yaml"); git(work, "commit", "-m", "remove derives edge");
    rejection(await api(directory("invalid-graph")).project.clone({ docsUrl: work }), "CLONE_PROJECT_INVALID");
    const parent = directory("linked-parent"), outside = directory("outside");
    const link = path.join(parent, "linked");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const before = treeHash(outside);
    const run = await runBin(link, ["clone", fixture.docsRemote]);
    // Some platforms canonicalize process.cwd() before the CLI sees it. In
    // those environments validate a linked project-docs path explicitly.
    if (run.status === 0) {
      const other = directory("linked-docs");
      fs.symlinkSync(path.join(outside, "project-docs"), path.join(other, "project-docs"), process.platform === "win32" ? "junction" : "dir");
      const snapshot = treeHash(outside);
      rejection(await api(other).project.clone({ docsUrl: fixture.docsRemote }), "CLONE_PATH_CONFLICT");
      expect(treeHash(outside)).toBe(snapshot);
    } else {
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, code: "CLONE_PATH_CONFLICT" });
      expect(treeHash(outside)).toBe(before);
    }
  });

  it("passes original docs and metadata host URLs to real Git while insteadOf selects offline transports", async () => {
    const fixture = await makeFixture({ rootLabel: "v017-url-rewrite" });
    const cwd = directory("v017-url-rewrite-destination");
    const config = path.join(fixture.root, "isolated-git-config");
    const trace = path.join(fixture.root, "git-trace.jsonl");
    const docsAlias = "https://offline.invalid/docs.git", hostAlias = "https://offline.invalid/host.git";
    const docsParent = path.join(fixture.root, "docs work");
    const docsWork = path.join(docsParent, "project-docs");
    unwrap(await api(docsParent).project.setRepositories({ hostUrl: hostAlias, docsUrl: docsAlias, hostBranch: fixture.hostBranch, docsBranch: fixture.docsBranch }));
    git(docsWork, "add", ".meta/repositories.yaml"); git(docsWork, "commit", "-m", "public URLs for offline mapping");
    git(docsWork, "push", fixture.docsRemote, `HEAD:refs/heads/${fixture.docsBranch}`);
    const metadata = fs.readFileSync(path.join(docsWork, ".meta/repositories.yaml"));
    git(fixture.root, "config", "--file", config, `url.${pathToFileURL(fixture.docsRemote).href}.insteadOf`, docsAlias);
    git(fixture.root, "config", "--file", config, `url.${pathToFileURL(fixture.hostRemote).href}.insteadOf`, hostAlias);
    const childEnv = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file", GIT_TRACE2_EVENT: trace };
    const run = await runBin(cwd, ["clone", docsAlias], childEnv);
    expect(run.status, run.stderr).toBe(0);
    const envelope = JSON.parse(run.stdout.trim()) as { ok: boolean; data?: { host: { url: string }; docs: { url: string } } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.host.url).toBe(hostAlias);
    expect(envelope.data?.docs.url).toBe(docsAlias);
    expect(git(cwd, "config", "--local", "--get", "remote.origin.url")).toBe(hostAlias);
    const docsClone = path.join(cwd, "project-docs");
    expect(git(docsClone, "config", "--local", "--get", "remote.origin.url")).toBe(docsAlias);
    expect(fs.readFileSync(path.join(docsClone, ".meta/repositories.yaml"))).toEqual(metadata);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(fixture.hostHead);
    expect(git(docsClone, "rev-parse", "HEAD")).toBe(git(docsWork, "rev-parse", "HEAD"));
    expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(`origin/${fixture.hostBranch}`);
    const events = fs.readFileSync(trace, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
    const starts = events.filter((event) => event.event === "start" && Array.isArray(event.argv)).map((event) => event.argv!);
    expect(starts.some((argv) => argv.includes("clone") && argv.includes(docsAlias))).toBe(true);
    expect(starts.some((argv) => argv.includes("remote") && argv.includes("add") && argv.includes(hostAlias))).toBe(true);
    expect(starts.flat().some((arg) => arg.includes("<repository-url>"))).toBe(false);
    const before = treeHash(cwd);
    const repeated = await runBin(cwd, ["clone", docsAlias], childEnv);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).data.resumed).toBe(true);
    expect(treeHash(cwd)).toBe(before);
    git(cwd, "remote", "set-url", "origin", "https://offline.invalid/different.git");
    const changed = treeHash(cwd);
    const mismatched = await runBin(cwd, ["clone", docsAlias], childEnv);
    expect(JSON.parse(mismatched.stdout)).toMatchObject({ ok: false, code: "CLONE_REPOSITORY_MISMATCH" });
    expect(treeHash(cwd)).toBe(changed);
  });

  it("rejects malformed URLs before any write and reports a missing source readably", async () => {
    const cwd = directory("v017-preflight");
    const before = treeHash(cwd);
    for (const docsUrl of ["https:example.invalid/repo.git", "https:/example.invalid/repo.git", "https:\\example.invalid\\repo.git", "https://example.invalid/repo name.git", "[repo](https://example.invalid/repo.git)", "<https://example.invalid/repo.git>", "https://user:secret@example.invalid/docs.git?token=x"]) {
      rejection(await api(cwd).project.clone({ docsUrl }), "REPOSITORIES_INVALID");
      const cliResult = await runBin(cwd, ["clone", docsUrl]);
      expect(JSON.parse(cliResult.stdout)).toMatchObject({ ok: false, code: "REPOSITORIES_INVALID" });
      expect(treeHash(cwd)).toBe(before);
    }

    const missing = path.join(cwd, "missing-source.git");
    const failed = await api(cwd).project.clone({ docsUrl: missing });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toContain(missing);
      expect(failed.error).toContain("文档仓克隆失败");
      expect(failed.error).toContain("工作目录");
      expect(failed.error).not.toContain("<repository-url>");
      expect(failed.error).not.toContain("clone clone");
    }
    expect(treeHash(cwd)).toBe(before);
  });

  it("keeps origin identity and HEAD stable across a completed repeat", async () => {
    const fixture = await makeFixture({ rootLabel: "v017-repeat" });
    const cwd = directory("v017-repeat-destination");
    const first = unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote }));
    const hostHead = git(cwd, "rev-parse", "HEAD");
    const docsHead = git(path.join(cwd, "project-docs"), "rev-parse", "HEAD");
    const repeated = unwrap(await api(cwd).project.clone({ docsUrl: fixture.docsRemote }));
    expect(repeated.resumed).toBe(true);
    expect(first.host.url).toBe(git(cwd, "remote", "get-url", "origin"));
    expect(first.docs.url).toBe(git(path.join(cwd, "project-docs"), "remote", "get-url", "origin"));
    expect(git(cwd, "rev-parse", "HEAD")).toBe(hostHead);
    expect(git(path.join(cwd, "project-docs"), "rev-parse", "HEAD")).toBe(docsHead);
  });

  it("validates supported URL spellings without changing the value later passed to Git", () => {
    const local = path.join(TEMP, "space 中文", "repo.git");
    for (const url of ["https://github.com/AIT-Squad/ait-core.git", "https://[::1]/repo.git", "ssh://git@example.invalid/team/repo.git", "git@example.invalid:team/repo.git", pathToFileURL(local).href, local]) {
      expect(validateRepositoryUrl(url)).toBe(url);
    }
  });

  it("keeps raw Git argv separate from display-only credential redaction", () => {
    const cwd = directory("diagnostic-argv");
    const docsUrl = "https://github.com/AIT-Squad/ait-core-project-docs.git";
    diagnosticStub.stderr = `fatal: unable to access '${docsUrl}/': failure\nredirected to https://TOKEN_ONLY@example.invalid/team/repo.git?token=QUERY_SECRET#FRAGMENT_SECRET\nother https://alice:PASSWORD_SECRET@example.invalid/path.git`;
    let caught: unknown;
    try { cloneProject(cwd, { docsUrl }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "CLONE_GIT_FAILED" });
    const message = (caught as Error).message;
    expect(message).toContain(docsUrl);
    expect(message).toContain("example.invalid/team/repo.git");
    expect(message).toContain("文档仓克隆失败");
    expect(message).not.toContain("<repository-url>");
    for (const secret of ["TOKEN_ONLY", "QUERY_SECRET", "FRAGMENT_SECRET", "PASSWORD_SECRET"]) expect(message).not.toContain(secret);
    const argv = diagnosticStub.calls.find((call) => call.includes("clone"))!;
    expect(argv.slice(-3)).toEqual(["--", docsUrl, "."]);
    expect(argv.some((arg) => /<repository-url>|<credentials>|<redacted>/.test(arg))).toBe(false);
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});
