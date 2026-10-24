import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse, stringify } from "yaml";
import { createCoreApi } from "../src/index.js";
import type { ApiResult, CoreApi } from "../src/index.js";
import { resolveProjectRoot } from "../src/foundation/root.js";
import { listVersions } from "../src/api/read-models.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import { parseFile } from "../src/doc-model/chunk-parser.js";
import { combinedView, extractTargetFile } from "../src/specgraph/graph-model.js";
import { normalizeTargetFile } from "../src/new-model/validator.js";

// Documentation is an independently governed artifact. Only temporary fixtures
// below are written directly; the real project specification is always read-only.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "dist/src/bin.js");
const DOCS = ["docs/node-api.md", "docs/cli.md"] as const;
const temporary = new Set<string>();
const initialCwd = process.cwd();
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const source = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

function document(file: typeof DOCS[number]): string {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  expect(bytes.length, `${file} must contain the reference document`).toBeGreaterThan(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
}

interface Fence { language: string; text: string }
function fences(markdown: string): Fence[] {
  const result: Fence[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const opening = /^(`{3,}|~{3,})([\w-]*)\s*$/.exec(lines[i]!);
    if (!opening) continue;
    const marker = opening[1]!;
    const body: string[] = [];
    i += 1;
    while (i < lines.length && !new RegExp(`^${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) {
      body.push(lines[i++]!);
    }
    expect(i, "Unclosed Markdown code fence").toBeLessThan(lines.length);
    result.push({ language: opening[2]!, text: body.join("\n") });
  }
  return result;
}

function nodeExamples(): string[] {
  return fences(document(DOCS[0]))
    .filter((fence) => fence.language === "ts" && /from ["']ait-core["']/.test(fence.text))
    .map((fence) => fence.text);
}

function exampleContaining(fragment: string): string {
  const examples = nodeExamples().filter((example) => example.includes(fragment));
  expect(examples, `One executable Node example must contain ${fragment}`).toHaveLength(1);
  return examples[0]!;
}

function unwrap<T extends object>(result: ApiResult<T>): T {
  noAdvice(result);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.data;
}

function noAdvice(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(["next_action", "next_call", "required_next_call", "NextAction"]).not.toContain(key);
    noAdvice(child);
  }
}

function client(cwd: string): CoreApi {
  const previous = process.cwd();
  process.chdir(cwd);
  try { return createCoreApi(); } finally { process.chdir(previous); }
}

function fixtureDirectory(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ait-documentation-含空格-"));
  temporary.add(path.resolve(cwd));
  fs.mkdirSync(path.join(cwd, "node_modules"));
  // Installed-package coverage belongs to dogfood.test.ts; this fixture still
  // resolves the documented bare import through the package's actual exports.
  fs.symlinkSync(ROOT, path.join(cwd, "node_modules/ait-core"), process.platform === "win32" ? "junction" : "dir");
  fs.mkdirSync(path.join(cwd, "scratch"));
  return cwd;
}

afterEach(() => {
  process.chdir(initialCwd);
  for (const cwd of temporary) {
    const relative = path.relative(path.resolve(os.tmpdir()), cwd);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
      || path.dirname(relative) !== "." || !path.basename(cwd).startsWith("ait-documentation-")) {
      throw new Error(`Refusing unsafe fixture cleanup: ${cwd}`);
    }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  temporary.clear();
});

interface ProcessResult { status: number | null; stdout: string; stderr: string }
function run(cwd: string, argv: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, TMP: path.join(cwd, "scratch"), TEMP: path.join(cwd, "scratch"), TMPDIR: path.join(cwd, "scratch"),
        GIT_AUTHOR_NAME: "Documentation Test", GIT_AUTHOR_EMAIL: "docs@example.invalid",
        GIT_COMMITTER_NAME: "Documentation Test", GIT_COMMITTER_EMAIL: "docs@example.invalid",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Document example timed out: ${stderr}`)); }, 90_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function executeExample(cwd: string, example: string, assertionSource: string): Promise<unknown> {
  const compiled = ts.transpileModule(example, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const result = await run(cwd, ["--input-type=module", "--eval", `${compiled}\n${assertionSource}`]);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const records = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("DOC_RESULT="));
  expect(records, result.stdout).toHaveLength(1);
  const value: unknown = JSON.parse(records[0]!.slice("DOC_RESULT=".length));
  noAdvice(value);
  return value;
}

function progress(result: ProcessResult): void {
  for (const line of result.stderr.trim().split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(["operation", "operationId", "stage", "status"]);
    expect(event.operationId).toBeTypeOf("string");
    expect(["read", "validate", "assemble", "write_bundle", "register_delivery", "acceptance", "git", "persist"]).toContain(event.stage);
    expect(["started", "completed", "failed"]).toContain(event.status);
  }
}

function parseEnvelope(result: ProcessResult): Record<string, unknown> {
  expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  noAdvice(value);
  progress(result);
  return value;
}

async function initialized(): Promise<{ cwd: string; core: CoreApi }> {
  const cwd = fixtureDirectory();
  const core = client(cwd);
  unwrap(await core.project.init({ name: "demo" }));
  return { cwd, core };
}

function metadataBytes(cwd: string): Record<string, string> {
  const root = path.join(cwd, "project-docs");
  const result: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".ait" || entry.name === "snapshots") continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[path.relative(root, file)] = hash(fs.readFileSync(file));
    }
  };
  visit(root);
  return result;
}

function ast(file: string): ts.SourceFile {
  return ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  throw new Error(`Unsupported public property name: ${node.getText()}`);
}

describe("independently governed public documentation", () => {
  it("keeps each UTF-8 reference owned by exactly one effective TDD with an FSD details parent", () => {
    for (const file of DOCS) expect(document(file)).toMatch(/^# .+参考/m);
    const before = metadataBytes(ROOT);
    const root = resolveProjectRoot(ROOT);
    const active = listVersions(root).versions.filter((version) => !version.merged);
    expect(active.length).toBeLessThanOrEqual(1);
    const version = active[0]?.version;
    const indexes = new IndexManager(root);
    const records = new Map(indexes.loadBaseline().chunks.map((entry) => [entry.id, { file: entry.file, base: root.docs }]));
    if (version !== undefined) {
      for (const id of new Set(indexes.loadVersionIndex(version).chunks.map((entry) => entry.id))) {
        const entry = indexes.queryVersion(version, id)!;
        if (entry.overrides && entry.overrides !== id) records.delete(entry.overrides);
        if (entry.action === "delete") records.delete(id);
        else if (entry.file) records.set(id, { file: entry.file, base: path.join(root.root, "versions", version) });
      }
    }
    const owners = new Map<string, string[]>();
    for (const [id, entry] of records) {
      if (!id.startsWith("[TDD]-") || id.includes(":")) continue;
      const file = path.join(entry.base, entry.file.endsWith(".md") ? entry.file : `${entry.file}.md`);
      const chunk = parseFile(file, entry.base).chunks.find((item) => item.id === id);
      expect(chunk, `Indexed TDD ${id} must exist in ${file}`).toBeDefined();
      const target = extractTargetFile(chunk!.content);
      expect(target, `TDD ${id} must declare a target`).toBeDefined();
      const normalized = normalizeTargetFile(target!, "win32");
      owners.set(normalized, [...owners.get(normalized) ?? [], id]);
    }
    const view = combinedView(root, version);
    const documentOwners: string[] = [];
    for (const file of DOCS) {
      const ids = owners.get(normalizeTargetFile(file, "win32")) ?? [];
      expect(ids, `${file} must have one TDD across baseline + active version`).toHaveLength(1);
      const id = ids[0]!;
      documentOwners.push(id);
      expect(view.nodes.get(id)?.target_file).toBe(file);
      const parents = view.edgesTo(id, "details");
      expect(parents, `${id} must have one upstream details edge`).toHaveLength(1);
      const parent = view.nodes.get(parents[0]!.src);
      expect(parent?.type).toBe("fsd");
      expect(parent?.chunk_id).toMatch(/^\[FSD\]-.+:[^:]+$/);
    }
    expect(new Set(documentOwners).size).toBe(DOCS.length);
    expect(metadataBytes(ROOT)).toEqual(before);
  });

  it("documents every typed and runtime method with its real input and return signature", () => {
    const tree = ast("src/api/types.ts");
    const interfaces = new Map(tree.statements.filter(ts.isInterfaceDeclaration).map((item) => [item.name.text, item]));
    const api = interfaces.get("CoreApi")!;
    const expected = new Map<string, string[]>();
    const compact = (value: string): string => value.replace(/\\\|/g, "|").replace(/\s+/g, "");
    for (const group of api.members) {
      if (!ts.isPropertySignature(group) || !group.type || !ts.isTypeReferenceNode(group.type)) throw new Error("CoreApi must name each group");
      const groupName = propertyName(group.name);
      const contract = interfaces.get(group.type.typeName.getText(tree))!;
      for (const method of contract.members) {
        if (!ts.isMethodSignature(method) || !method.type) throw new Error("Public methods must have concrete signatures");
        const name = `${groupName}.${propertyName(method.name)}`;
        const signature = `core.${name}(${method.parameters.map((parameter) => parameter.getText(tree)).join(",")}):${method.type.getText(tree)}`;
        expected.set(name, [...expected.get(name) ?? [], compact(signature)]);
      }
    }
    const documented = new Map<string, string>();
    for (const match of document(DOCS[0]).matchAll(/^\|\s*`(core\.([\w]+\.[\w]+)\([^`]*\):[^`]+)`\s*\|/gm)) {
      expect(documented.has(match[2]!), `Duplicate method reference ${match[2]}`).toBe(false);
      documented.set(match[2]!, compact(match[1]!));
    }
    expect([...documented.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [name, signature] of documented) expect(expected.get(name), name).toContain(signature);
    const runtime = Object.entries(createCoreApi()).flatMap(([group, methods]) => Object.keys(methods).map((name) => `${group}.${name}`));
    expect(runtime.sort()).toEqual([...expected.keys()].sort());
  });

  it("documents every dispatcher command as a command declaration", () => {
    const tree = ast("src/cli/dispatcher.ts");
    let commands: ts.ObjectLiteralExpression | undefined;
    for (const statement of tree.statements.filter(ts.isVariableStatement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === "COMMANDS"
          && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) commands = declaration.initializer;
      }
    }
    expect(commands).toBeDefined();
    const expected = ["--version", ...commands!.properties.map((item) => {
      if (!ts.isPropertyAssignment(item)) throw new Error("Command registry must have named declarations");
      return propertyName(item.name);
    })];
    const declarations: string[] = [];
    const text = document(DOCS[1]);
    for (const line of text.split("\n")) {
      const match = /^(?:### |\| )`ait ([^`]+)`/.exec(line);
      if (match) declarations.push(match[1]!);
    }
    for (const fence of fences(text).filter((item) => item.language === "text")) {
      for (const line of fence.text.split("\n")) if (line.startsWith("ait ")) declarations.push(line.slice(4));
    }
    const found = new Set<string>();
    for (const declaration of declarations) {
      const command = [...expected].sort((a, b) => b.length - a.length)
        .find((candidate) => declaration === candidate || declaration.startsWith(`${candidate} `));
      expect(command, `Undocumented/unsupported command declaration: ait ${declaration}`).toBeDefined();
      found.add(command!);
    }
    expect([...found].sort()).toEqual(expected.sort());
  });

  it("typechecks the actual executable TypeScript fences against the public package", () => {
    const examples = nodeExamples();
    expect(examples.length).toBeGreaterThanOrEqual(3);
    const configPath = path.join(ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options;
    const virtual = new Map(examples.map((example, index) => [path.join(ROOT, "tests", `documentation-example-${index}.mts`), example]));
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    host.readFile = (file) => virtual.get(path.normalize(file)) ?? read(file);
    host.fileExists = (file) => virtual.has(path.normalize(file)) || exists(file);
    host.getSourceFile = (file, languageVersion) => {
      const text = host.readFile(file);
      return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
    };
    const program = ts.createProgram([...virtual.keys()], { ...options, noEmit: true }, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file, getCurrentDirectory: () => ROOT, getNewLine: () => "\n",
    })).toBe("");
  }, 30_000);

  it("runs the documented package import and graph/summary examples in an isolated project", async () => {
    const { cwd, core } = await initialized();
    // Nonempty neighbors make the example's direction and union of relations
    // observable. These are explicit historical fixture data, not production edits.
    const root = resolveProjectRoot(cwd);
    const fsdFile = path.join(root.docs, "fsd/[FSD]-demo.md");
    fs.appendFileSync(fsdFile, "\n<!-- @id:[FSD]-demo:feature -->\n## 示例功能\n提供目标。\n<!-- @id:[FSD]-demo:shared -->\n## 共享功能\n共享契约。\n");
    fs.writeFileSync(path.join(root.docs, "tdd/[TDD]-feature.md"), "<!-- @id:[TDD]-feature -->\n## 示例制品\n```yaml\ntarget_file: example.mjs\n```\n完整文件规格。\n");
    unwrap(await core.index.rebuild());
    const storedGraph = unwrap(await core.graph.sync());
    const uri = (id: string): string => {
      const node = storedGraph.specs.find((item) => item.chunk_id === id);
      if (!node) throw new Error(`Missing fixture node ${id}`);
      return node.uri;
    };
    storedGraph.edges.push(
      { src: uri("[FSD]-demo:feature"), dst: uri("[TDD]-feature"), rel: "details", weight: 1, metadata: { source: "manual" } },
      { src: uri("[FSD]-demo:feature"), dst: uri("[FSD]-demo:shared"), rel: "depends_on", weight: 1, metadata: { source: "manual" } },
    );
    fs.writeFileSync(path.join(root.meta, "specgraph.yaml"), stringify(storedGraph));
    unwrap(await core.version.create({ version: "v0.13" }));
    const before = metadataBytes(cwd);
    const imported = await executeExample(cwd, exampleContaining("const core: CoreApi"), "console.log('DOC_RESULT=' + JSON.stringify(result));");
    expect(imported).toEqual({ ok: true, data: unwrap(await core.session.get()) });
    const graph = await executeExample(cwd, exampleContaining("const neighbors ="),
      "console.log('DOC_RESULT=' + JSON.stringify({ neighbors, summary, statistics }));");
    expect(graph).toEqual({
      neighbors: await core.graph.query({ target: "[FSD]-demo:feature", direction: "out", rels: ["details", "depends_on"], version: "baseline" }),
      summary: await core.search.baselineSummary({ scope: "prd" }), statistics: await core.search.baselineStats(),
    });
    expect(graph).toMatchObject({ neighbors: { ok: true, data: { found: true, direction: "out", edges: [
      { src: "[FSD]-demo:feature", dst: "[TDD]-feature", rel: "details" },
      { src: "[FSD]-demo:feature", dst: "[FSD]-demo:shared", rel: "depends_on" },
    ] } } });
    const cliExamples = fences(document(DOCS[1])).filter((fence) => fence.language === "sh"
      && fence.text.startsWith("ait specgraph query ")).flatMap((fence) => fence.text.split("\n").filter(Boolean));
    expect(cliExamples).toHaveLength(3);
    for (const command of cliExamples) {
      const args = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
      expect(args.shift()).toBe("ait");
      const result = await run(cwd, [BIN, ...args]);
      expect(result.status, result.stderr).toBe(0);
      const envelope = parseEnvelope(result);
      expect(envelope).toMatchObject({ ok: true, data: { found: true } });
      const data = envelope.data as { edges: Array<{ rel: string; src: string; dst: string }>; direction: string };
      expect(data.edges.length).toBeGreaterThan(0);
      if (args[0] === "deps") {
        expect(data.direction).toBe("in");
        expect(data.edges.map((edge) => edge.dst)).toEqual(["[TDD]-feature"]);
      } else if (args.includes("--derives")) {
        expect(data.direction).toBe("both");
        expect(data.edges.map((edge) => edge.rel)).toEqual(["derives"]);
      } else {
        expect(data.direction).toBe("out");
        expect(data.edges.map((edge) => edge.rel).sort()).toEqual(["depends_on", "details"]);
      }
    }
    expect(metadataBytes(cwd)).toEqual(before);
  }, 30_000);

  it("executes the complete Node example with a host fixture and real memory delivery, receipt, acceptance and merge", async () => {
    const cwd = fixtureDirectory();
    const drafts = {
      prd: "<!-- @id:[PRD]-feature-api -->\n## 文档示例\n生成可验证的文件。\n<!-- @id:[PRD]-feature-api:feature -->\n## 问候需求\n**用户故事:** 作为调用者，我希望得到问候，以便核验交付。\n#### 验收标准\n1. WHEN 输入 Ada THEN 系统 SHALL 返回 Hello, Ada!。\n",
      fsd: "<!-- @id:[FSD]-feature-api -->\n## 问候功能\n只提供问候文件。\n<!-- @id:[FSD]-feature-api:feature -->\n## 问候模块\n```yaml\nderives: ['[PRD]-feature-api:feature']\n```\n导出 greet(name)，返回问候。\n",
      tdd: "<!-- @id:[TDD]-feature-api -->\n## 问候实现\n```yaml\ntarget_file: hello.mjs\n```\n导出 greet(name)，返回 Hello, 加名称及感叹号。保留 Unicode：雪 🧪。\n",
    };
    const artifact = "export const greet = (name) => `Hello, ${name}!`;\n";
    const harness = `
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
const drafts = ${JSON.stringify(drafts)};
const artifact = ${JSON.stringify(artifact)};
const calls = [];
let delivered;
const host = {
  async draft(context) {
    assert.equal(context.mode, "discussion-context");
    assert.equal(typeof context.background, "string");
    assert.ok(context.context_token.length > 0);
    calls.push(context.layer);
    return drafts[context.layer];
  },
  async generate(input) {
    assert.equal(input.targetFile, "hello.mjs");
    assert.ok(input.prompt.includes(drafts.tdd.trim()));
    assert.ok(input.prompt.includes("Unicode：雪 🧪"));
    delivered = input;
    calls.push("generate");
    fs.writeFileSync(input.targetFile, artifact);
  },
  async test(targetFile) {
    assert.equal(targetFile, "hello.mjs");
    const { greet } = await import("./hello.mjs");
    assert.equal(greet("Ada"), "Hello, Ada!");
    calls.push("test");
  },
  reportFindings(report) { assert.equal(report.passed, true); assert.deepEqual(report.findings, []); calls.push("verify"); },
};
const result = await implementFeature(host, "v0.1", "node hello.mjs");
assert.equal(result.receipt.artifact_sha256, createHash("sha256").update(artifact).digest("hex"));
assert.equal(result.receipt.bundle_sha256, createHash("sha256").update(delivered.prompt).digest("hex"));
assert.deepEqual(calls, ["prd", "fsd", "tdd", "generate", "test", "verify"]);
assert.equal(result.confirmed.passed, true);
assert.ok(result.merged.merged_chunks.includes("[TDD]-feature-api"));
assert.equal(fs.readdirSync("scratch").some((name) => name.startsWith("ait-codegen")), false);
console.log("DOC_RESULT=" + JSON.stringify(result));
`;
    const result = await executeExample(cwd, exampleContaining("export async function implementFeature("), harness) as Record<string, unknown>;
    expect(result.acceptance).toEqual({ ran: true, passed: true, exitCode: 0 });
    expect(unwrap(await client(cwd).session.get()).active_version).toBeNull();
    expect(unwrap(await client(cwd).version.inspect({ version: "v0.1" })).confirmation.state).toBe("not_applicable");
  }, 90_000);

  it("executes every documented baseline-summary form and preserves JSON/YAML projections, nulls and baseline-only scope", async () => {
    const { cwd, core } = await initialized();
    const indexFile = path.join(cwd, "project-docs/.meta/chunks-index.yaml");
    const index = parse(fs.readFileSync(indexFile, "utf8")) as { chunks: Array<{ id: string; summary: string | null }> };
    index.chunks[0]!.summary = "摘要：雪 🧪";
    fs.writeFileSync(indexFile, stringify(index));
    unwrap(await core.version.create({ version: "v0.13" }));
    unwrap(await core.prd.create({ id: "[PRD]-only_in_version", content: "<!-- @id:[PRD]-only_in_version -->\n## 活动版本专用\n不应出现在基线摘要。", skipContext: true }));
    const before = metadataBytes(cwd);
    const summarySection = document(DOCS[1]).split("### `ait baseline-summary ")[1]!.split("## 状态与索引")[0]!;
    const commands = [...summarySection.matchAll(/^\| `ait (baseline-summary[^`]*)` \|/gm)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const command of commands) {
      const args = command.split(/\s+/);
      const result = await run(cwd, [BIN, ...args]);
      expect(result.status, result.stderr).toBe(0);
      const expected = unwrap(await core.search.baselineSummary(args.includes("prd") ? { scope: "prd" } : undefined)).items;
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.some((item) => item.summary === null)).toBe(true);
      expect(expected.some((item) => item.id === "[PRD]-only_in_version")).toBe(false);
      if (args.includes("json")) expect(parseEnvelope(result)).toEqual({ ok: true, data: expected });
      else { expect(parse(result.stdout)).toEqual(expected); progress(result); }
    }
    expect(metadataBytes(cwd)).toEqual(before);
    // A damaged index must not become an empty successful YAML summary.
    fs.writeFileSync(indexFile, "chunks: [\n");
    const failed = await run(cwd, [BIN, "baseline-summary"]);
    expect(failed.status).toBe(1);
    expect(parseEnvelope(failed)).toMatchObject({ ok: false, code: "INDEX_UNREADABLE" });
  }, 30_000);

  it("checks documented defaults, rejected cancellation/legacy inputs and outer-success semantics against running interfaces", async () => {
    const { cwd, core } = await initialized();
    const node = document(DOCS[0]);
    const cli = document(DOCS[1]);
    expect(node).toMatch(/\| `DeliveryPrepareInput` \|[^\n]*= "memory"/);
    expect(node).toMatch(/\| `GraphQueryInput` \|[^\n]*= "both"/);
    expect(node).toMatch(/\| `SearchInput` \|[^\n]*= "baseline"/);
    expect(node).toMatch(/API 不提供 `signal`、`AbortSignal`、`cancel`/);
    expect(cli).toMatch(/CLI 不提供 `cancel`、取消状态或取消错误码/);
    const before = metadataBytes(cwd);
    expect(unwrap(await core.graph.query({ target: "[PRD]-demo" })).direction).toBe("both");
    expect(unwrap(await core.graph.query({ target: "[PRD]-demo", rels: [] })).edges).toEqual([]);
    expect(unwrap(await core.search.baselineSummary()).scope).toBe("all");
    expect(await core.search.query({ query: "demo" })).toEqual(await core.search.query({ query: "demo", scope: "baseline", regexp: false }));
    expect(unwrap(await core.acceptance.run())).toEqual({ ran: false, passed: true, exitCode: null });
    expect(await core.state.get()).toMatchObject({ ok: false, code: "NO_VERSION" });
    expect(unwrap(await core.session.get()).active_version).toBeNull();
    for (const invalid of [{ target: "[PRD]-demo", direction: "from" }, { target: "[PRD]-demo", direction: "to" },
      { target: "[PRD]-demo", signal: null }, { target: "[PRD]-demo", cancel: true }]) {
      // Deliberately exercise JS callers' runtime validation, beyond TS types.
      expect(await Reflect.apply(core.graph.query, core.graph, [invalid])).toMatchObject({ ok: false, code: "USAGE_ERROR" });
    }
    for (const invalid of [{ signal: null }, { cancel: true }]) {
      expect(() => Reflect.apply(createCoreApi, undefined, [invalid])).toThrowError(/未知参数/);
    }
    for (const args of [["deps", "[PRD]-demo", "--direction", "from"], ["specgraph", "query", "[PRD]-demo", "--deps"],
      ["specgraph", "query", "[PRD]-demo", "--implements"], ["state", "--cancel"], ["state", "--signal", "x"]]) {
      const result = await run(cwd, [BIN, ...args]);
      expect(result.status).toBe(1);
      expect(parseEnvelope(result)).toMatchObject({ ok: false, code: "USAGE_ERROR" });
    }
    expect(metadataBytes(cwd)).toEqual(before);
    unwrap(await core.acceptance.set({ command: `"${process.execPath}" -e "process.exit(7)"` }));
    const failedCheck = await run(cwd, [BIN, "acceptance", "run"]);
    expect(failedCheck.status).toBe(0);
    expect(parseEnvelope(failedCheck)).toEqual({ ok: true, data: { ran: true, passed: false, exitCode: 7 } });
    const guard = core.guard.evaluate({ toolName: "write", input: { path: "project-docs/docs/prd/demo.md" } });
    expect(guard).not.toBeInstanceOf(Promise);
    expect(unwrap(guard).decision).toBe("block");
  }, 30_000);
});
