// [TDD]-new_model_tests — new_model 域三个制品（model-manager/validator/codegen）的集成验收。
// 覆盖 [FSD]-ait-core-new_model:TEST 全部验收条款及 v0.10/v0.12 生产路径回归。
// 约束：每个用例在 os.tmpdir() 下自建 project-docs 骨架与版本工作区（init 语义由
// 测试手工搭骨架替代），用例间零共享状态；全流程用例按 phase 机顺序推进；
// 内联文档文本一律用行数组 join，避免 ``` 围栏与 @id 注释自嵌套。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectRoot } from "../src/foundation/root.js";
import * as atomicIo from "../src/foundation/io.js";
import { loadModel, loadYaml, saveModel } from "../src/foundation/yaml.js";
import { ChangeRecordSchema, SpecGraphSchema, VersionIndexSchema, VersionMetaSchema } from "../src/doc-model/schemas.js";
import { IndexManager } from "../src/indexing/index-manager.js";
import {
  CombinedView,
  SpecGraphStore,
  combinedView,
  type Edge,
  type EdgeRel,
  type SpecNode,
} from "../src/specgraph/graph-model.js";
import {
  NewModelManager,
  type CreateResult,
  type DecomposeResult,
} from "../src/new-model/model-manager.js";
import {
  checkEdgeWrite,
  normalizeTargetFile,
  scanContentRelations,
  scanPrdRequirementContract,
  validateInvariants,
  validateTargetFileUniqueness,
  type Violation,
} from "../src/new-model/validator.js";
import { codegenPrepare, CodegenError } from "../src/new-model/codegen.js";
import { parseFile } from "../src/doc-model/chunk-parser.js";
import { prepareDelivery } from "../src/orchestration/context-delivery.js";
import { registerGenerationReceipt } from "../src/orchestration/generation-receipts.js";

// ---------------------------------------------------------------------------
// 临时项目骨架
// ---------------------------------------------------------------------------

const VERSION = "v0.3";

let tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ait-new-model-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // 清理失败仅告警不 fail（Windows 文件锁容忍）。
      console.warn(`afterEach 清理失败（忽略）: ${dir}`, err);
    }
  }
  tmpDirs = [];
});

/** 搭建空 project-docs 骨架（docs/{prd,fsd,tdd} + .meta/versions），返回 ProjectRoot。 */
function makeRoot(): ProjectRoot {
  const base = mkTmp();
  const pd = path.join(base, "project-docs");
  const docs = path.join(pd, "docs");
  const meta = path.join(pd, ".meta");
  for (const d of [
    docs,
    meta,
    path.join(docs, "prd"),
    path.join(docs, "fsd"),
    path.join(docs, "tdd"),
    path.join(meta, "versions"),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return { cwd: base, root: pd, docs, meta };
}

/** 空基线 + 活动版本 v0.3（phase=empty），返回 manager。 */
function makeProject(): { root: ProjectRoot; mgr: NewModelManager } {
  const root = makeRoot();
  activateVersion(root);
  return { root, mgr: new NewModelManager(root) };
}

/** 手工活化版本（替代 init/create version 语义）。 */
function activateVersion(root: ProjectRoot): void {
  saveModel(path.join(root.meta, "versions", `${VERSION}.yaml`), {
    version: VERSION,
    created_at: new Date().toISOString(),
    merged_at: null,
    owner: null,
    changes: [],
    dependencies: {
      based_on: null,
      conflicts_with: [],
      merge_after: [],
    },
    snapshot: null,
    phase: "empty",
    title: null,
    prd_locked: false,
    impl_locked: false,
    docs_commit: null,
    code_base: null,
    code_result: null,
    confirmed_plan: null,
    revert_anchor: null,
    recovery_journal: null,
    historical_anchor_repairs: [],
  });
}

/** 写 baseline docs 文件：key 为相对 docs 的路径，value 为行数组。 */
function writeDocs(root: ProjectRoot, files: Record<string, string[]>): void {
  for (const [rel, lines] of Object.entries(files)) {
    const abs = path.join(root.docs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${lines.join("\n")}\n`, "utf-8");
  }
}

/** baseline 图与索引重建（空 docs 亦合法）。 */
function syncBaseline(root: ProjectRoot): void {
  new IndexManager(root).rebuildBaseline();
  new SpecGraphStore(root).sync();
}

/** 版本工作区某层文件清单（目录不存在视为空——零落盘断言用）。 */
function versionFiles(root: ProjectRoot, layer: string): string[] {
  const dir = path.join(root.root, "versions", VERSION, layer);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/** 讨论背景结果的令牌提取（模式窄化）。 */
function tokenOf(res: CreateResult | DecomposeResult): string {
  if (res.mode !== "discussion-context") {
    throw new Error(`期望 discussion-context，实际 ${res.mode}`);
  }
  return res.context_token;
}

/** 异步错误码断言。 */
async function expectErrCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

/** 同步错误码断言。 */
function expectThrowCode(fn: () => unknown, code: string): unknown {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: unknown }).code).toBe(code);
    return err;
  }
  throw new Error(`期望抛出 code=${code}，实际未抛出`);
}

/** 组合视图边存在断言。 */
function hasEdge(
  view: CombinedView,
  src: string,
  dst: string,
  rel: EdgeRel,
): boolean {
  return view.edgesFrom(src, rel).some((e) => e.dst === dst);
}

// ---------------------------------------------------------------------------
// 内联文档文本（行数组 join，避免围栏/@id 自嵌套）
// ---------------------------------------------------------------------------

const PRD_DOC = [
  "<!-- @id:[PRD]-demo -->",
  "## demo 产品 PRD",
  "",
  "### 概述",
  "demo 概述文本。",
].join("\n");

const FSD_ROOT_DOC = [
  "<!-- @id:[FSD]-demo -->",
  "## demo 域功能分解根",
  "",
  "### 功能描述",
  "demo 域描述。",
].join("\n");

function tddDoc(id: string, targetFile: string): string {
  return [
    `<!-- @id:${id} -->`,
    `## ${id} TDD`,
    "",
    "```yaml",
    `target_file: ${targetFile}`,
    "```",
    "",
    "### 技术栈",
    "TypeScript。",
  ].join("\n");
}


/** 对受管目录的存在性和原始文件字节快照，覆盖新文件与新目录回滚。 */
function treeSnapshot(root: ProjectRoot): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root.root, file).split(path.sep).join("/");
      if (entry.isDirectory()) {
        result[rel + "/"] = "directory";
        visit(file);
      } else {
        result[rel] = fs.readFileSync(file).toString("base64");
      }
    }
  };
  visit(root.root);
  return result;
}

function versionFile(root: ProjectRoot, file: string): string {
  return path.join(root.root, "versions", VERSION, file);
}

function fsdFixture(
  id = "[FSD]-alpha",
  declarations: Record<string, string[]> = {},
  splits = ["splitA", "splitB", "TEST"],
): string {
  return ["<!-- @id:" + id + " -->", "## 功能根", "根契约。", ...splits.flatMap((split) => [
    "", "<!-- @id:" + id + ":" + split + " -->", "## " + split,
    ...(declarations[split] === undefined ? [] : ["```yaml", ...declarations[split]!, "```"]),
    split + " 功能正文。",
  ])].join("\n");
}

const PRD_REQUIREMENTS = [PRD_DOC, ...["req1", "req2"].map((id) => [
  "", "<!-- @id:[PRD]-demo:" + id + " -->", "## " + id,
  "**用户故事:** 作为开发者，我希望能力符合契约，以便可靠集成。",
  "#### 验收标准", "1. WHEN 调用能力 THEN 系统 SHALL 返回约定结果。",
].join("\n"))].join("\n");

async function advanceToPrdConfirm(mgr: NewModelManager): Promise<void> {
  await mgr.createDocument("prd", "[PRD]-demo", { content: PRD_REQUIREMENTS, skipContext: true });
  mgr.confirmLayer("prd");
}

function baselineEdges(root: ProjectRoot, edges: Array<[string, string, EdgeRel]>): void {
  const graph = new SpecGraphStore(root).load();
  const uri = (id: string): string => {
    const node = graph.specs.find((item) => item.chunk_id === id);
    if (node === undefined) throw new Error("测试夹具缺少节点 " + id);
    return node.uri;
  };
  for (const [src, dst, rel] of edges) {
    graph.edges.push({ src: uri(src), dst: uri(dst), rel, weight: 1,
      metadata: { source: rel === "depends_on" || (rel === "derives" && src.includes(":"))
        ? "fsd-declaration" : "new-model-cli" } });
  }
  saveModel(path.join(root.meta, "specgraph.yaml"), graph);
}
/** 推进到 fsd-confirm（prd/fsd 各一篇写入并 confirm）。 */
async function advanceToFsdConfirm(mgr: NewModelManager): Promise<void> {
  await mgr.createDocument("prd", "[PRD]-demo", {
    content: PRD_DOC,
    skipContext: true,
  });
  mgr.confirmLayer("prd");
  await mgr.createDocument("fsd", "[FSD]-demo", {
    content: `${FSD_ROOT_DOC}

<!-- @id:[FSD]-demo:svc -->
## svc split
服务能力。`,
    parent: "[PRD]-demo",
    skipContext: true,
  });
  mgr.confirmLayer("fsd");
}

// ---------------------------------------------------------------------------
// 全流程（:TEST 第 1 条）
// ---------------------------------------------------------------------------

describe("全流程", () => {
  let root: ProjectRoot;
  let mgr: NewModelManager;

  beforeEach(() => {
    ({ root, mgr } = makeProject());
  });

  it("背景+令牌→写入→confirm→下层 create 的相位链；四出生地建边；正文零关系残留", async () => {
    // 1. prd create 无内容 → 讨论背景 + 令牌（零写入）
    const prdCtx = await mgr.createDocument("prd", "[PRD]-demo", {});
    expect(prdCtx.mode).toBe("discussion-context");
    if (prdCtx.mode !== "discussion-context") throw new Error("unreachable");
    expect(prdCtx.context_token).toMatch(/^ctx-v1\.[0-9a-f]{64}$/);
    expect(prdCtx.background).toContain("[PRD]-demo");
    expect(versionFiles(root, "prd")).toEqual([]);

    // 2. 带内容 + 令牌写入 → 版本工作区落盘，phase 推进 prd-creating
    const prdWritten = await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      contextToken: prdCtx.context_token,
    });
    expect(prdWritten.mode).toBe("written");
    if (prdWritten.mode !== "written") throw new Error("unreachable");
    expect(prdWritten.phase).toBe("prd-creating");
    expect(versionFiles(root, "prd")).toEqual(["[PRD]-demo.md"]);

    // 3. 下层未 confirm 上层时拒绝：phase=prd-creating 时 fsd create → PRD_NOT_CONFIRMED 零落盘
    await expectErrCode(
      mgr.createDocument("fsd", "[FSD]-alpha", {
        content: fsdFixture("[FSD]-alpha"),
        skipContext: true,
      }),
      "PRD_NOT_CONFIRMED",
    );
    expect(versionFiles(root, "fsd")).toEqual([]);

    // 4. prd confirm → prd-confirm
    expect(mgr.confirmLayer("prd")).toMatchObject({
      version: VERSION,
      phase: "prd-confirm",
    });

    // 5. fsd create --parent（带 depends_on 声明块）：derives 随 --parent 出生、
    //    depends_on 随声明块出生、声明块剥离（正文零关系残留）
    const fsdCtx = await mgr.createDocument("fsd", "[FSD]-alpha", {
      parent: "[PRD]-demo",
    });
    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:svc -->",
      "## svc split",
      "",
      "```yaml",
      "depends_on: [lib]",
      "```",
      "",
      "### 功能描述",
      "svc 功能描述。",
      "",
      "<!-- @id:[FSD]-alpha:lib -->",
      "## lib split",
      "",
      "### 功能描述",
      "lib 功能描述。",
    ].join("\n");
    const fsdWritten = await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent,
      parent: "[PRD]-demo",
      contextToken: tokenOf(fsdCtx),
    });
    expect(fsdWritten.mode).toBe("written");
    if (fsdWritten.mode !== "written") throw new Error("unreachable");
    expect(fsdWritten.phase).toBe("fsd-creating");
    expect(
      hasEdge(
        combinedView(root, VERSION),
        "[PRD]-demo",
        "[FSD]-alpha",
        "derives",
      ),
    ).toBe(true);
    expect(
      hasEdge(
        combinedView(root, VERSION),
        "[FSD]-alpha:svc",
        "[FSD]-alpha:lib",
        "depends_on",
      ),
    ).toBe(true);
    const fsdText = fs.readFileSync(
      path.join(root.root, "versions", VERSION, "fsd", "[FSD]-alpha.md"),
      "utf-8",
    );
    expect(fsdText).not.toContain("depends_on");
    expect(fsdText).toContain("@id:[FSD]-alpha:svc");

    // 6. decompose：FSD split → 子 FSD 根，decomposes 边随拆分出生
    const decompCtx = await mgr.decompose("[FSD]-alpha:svc", "[FSD]-alpha-svc", {});
    const childDoc = [
      "<!-- @id:[FSD]-alpha-svc -->",
      "## alpha-svc FSD 根",
      "",
      "### 功能描述",
      "子域描述。",
      "",
      "<!-- @id:[FSD]-alpha-svc:impl -->",
      "## impl split",
      "实现子域能力。",
    ].join("\n");
    const decompWritten = await mgr.decompose("[FSD]-alpha:svc", "[FSD]-alpha-svc", {
      content: childDoc,
      contextToken: tokenOf(decompCtx),
    });
    expect(decompWritten.mode).toBe("written");
    if (decompWritten.mode !== "written") throw new Error("unreachable");
    expect(decompWritten.rel).toBe("decomposes");
    expect(
      hasEdge(
        combinedView(root, VERSION),
        "[FSD]-alpha:svc",
        "[FSD]-alpha-svc",
        "decomposes",
      ),
    ).toBe(true);

    // 7. tdd create 需 fsd-confirm：当前 phase=fsd-creating → FSD_NOT_CONFIRMED 零落盘
    await expectErrCode(
      mgr.createDocument("tdd", "[TDD]-svc", {
        content: tddDoc("[TDD]-svc", "src/svc.ts"),
        parent: "[FSD]-alpha-svc:impl",
        skipContext: true,
      }),
      "FSD_NOT_CONFIRMED",
    );
    expect(versionFiles(root, "tdd")).toEqual([]);

    // 8. fsd confirm → tdd create --parent：details 边随创建出生
    expect(mgr.confirmLayer("fsd")).toMatchObject({
      version: VERSION,
      phase: "fsd-confirm",
    });
    const tddCtx = await mgr.createDocument("tdd", "[TDD]-svc", {
      parent: "[FSD]-alpha-svc:impl",
    });
    const tddWritten = await mgr.createDocument("tdd", "[TDD]-svc", {
      content: tddDoc("[TDD]-svc", "src/svc.ts"),
      parent: "[FSD]-alpha-svc:impl",
      contextToken: tokenOf(tddCtx),
    });
    expect(tddWritten.mode).toBe("written");
    if (tddWritten.mode !== "written") throw new Error("unreachable");
    expect(tddWritten.phase).toBe("tdd-creating");
    expect(
      hasEdge(
        combinedView(root, VERSION),
        "[FSD]-alpha-svc:impl",
        "[TDD]-svc",
        "details",
      ),
    ).toBe(true);
    expect(versionFiles(root, "tdd")).toEqual(["[TDD]-svc.md"]);

    // 9. tdd confirm → tdd-confirm；版本工作区三层齐备
    expect(mgr.confirmLayer("tdd")).toMatchObject({
      version: VERSION,
      phase: "tdd-confirm",
    });
    expect(versionFiles(root, "fsd")).toEqual([
      "[FSD]-alpha-svc.md",
      "[FSD]-alpha.md",
    ]);

    // 10. 四种关系边随创建原子出生且正文零关系残留（全部版本工作区文档过残留扫描）
    const view = combinedView(root, VERSION);
    expect(hasEdge(view, "[PRD]-demo", "[FSD]-alpha", "derives")).toBe(true);
    expect(
      hasEdge(view, "[FSD]-alpha:svc", "[FSD]-alpha-svc", "decomposes"),
    ).toBe(true);
    expect(hasEdge(view, "[FSD]-alpha-svc:impl", "[TDD]-svc", "details")).toBe(true);
    expect(
      hasEdge(view, "[FSD]-alpha:svc", "[FSD]-alpha:lib", "depends_on"),
    ).toBe(true);
    for (const layer of ["prd", "fsd", "tdd"] as const) {
      for (const name of versionFiles(root, layer)) {
        const text = fs.readFileSync(
          path.join(root.root, "versions", VERSION, layer, name),
          "utf-8",
        );
        expect(scanContentRelations(text, layer)).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FSD yaml 声明（v0.6 新增）
// ---------------------------------------------------------------------------

describe("FSD yaml 声明", () => {
  let root: ProjectRoot;
  let mgr: NewModelManager;

  beforeEach(() => {
    ({ root, mgr } = makeProject());
  });

  it("基础建边与剥离：围栏外 yaml 块建 fsd-declaration 边并从版本工作区剥离", async () => {
    // 准备：prd 已 confirm，含需求 split 作为 derives 目标
    const prdWithReq = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "### 概述",
      "demo 概述文本。",
      "",
      "<!-- @id:[PRD]-demo:req1 -->",
      "## req1 需求",
      "",
      "**用户故事:** 作为用户，我希望功能可用。",
      "",
      "### 验收标准",
      "1. 功能按契约工作。",
    ].join("\n");
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: prdWithReq,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    // FSD 内容：根 + splitA（含 derives + depends_on 声明）+ splitB（无声明）
    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitA -->",
      "## splitA split",
      "",
      "```yaml",
      "derives: [\"[PRD]-demo:req1\"]",
      "depends_on: [splitB]",
      "```",
      "",
      "### 功能描述",
      "splitA 功能描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitB -->",
      "## splitB split",
      "",
      "### 功能描述",
      "splitB 功能描述。",
    ].join("\n");

    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent,
      parent: "[PRD]-demo",
      skipContext: true,
    });

    const view = combinedView(root, VERSION);

    // 断言 derives 边：req1 ─derives──▶ splitA（PRD chunk 为 src，与 --parent 根边同向）
    const derivesEdge = view
      .edgesTo("[FSD]-alpha:splitA", "derives")
      .find((e) => e.src === "[PRD]-demo:req1");
    expect(derivesEdge).toBeDefined();
    expect(derivesEdge?.metadata?.source).toBe("fsd-declaration");

    // 断言 depends_on 边：splitA → splitB（短名解析为 [FSD]-alpha:splitB）
    const dependsEdge = view
      .edgesFrom("[FSD]-alpha:splitA", "depends_on")
      .find((e) => e.dst === "[FSD]-alpha:splitB");
    expect(dependsEdge).toBeDefined();
    expect(dependsEdge?.metadata?.source).toBe("fsd-declaration");

    // 断言版本工作区文件不含 yaml 声明块（已剥离）
    const fsdText = fs.readFileSync(
      path.join(root.root, "versions", VERSION, "fsd", "[FSD]-alpha.md"),
      "utf-8",
    );
    expect(fsdText).not.toContain("derives:");
    expect(fsdText).not.toContain("depends_on:");
    expect(fsdText).toContain("@id:[FSD]-alpha:splitA");
    expect(fsdText).toContain("splitA 功能描述");
  });

  it("owned-scope reconcile：未涉及 split 的 fsd-declaration 边保留", async () => {
    // 准备：prd 已 confirm，含两个需求 split
    const prdContent = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "### 概述",
      "demo 概述文本。",
      "",
      "<!-- @id:[PRD]-demo:req1 -->",
      "## req1 需求",
      "",
      "**用户故事:** 作为用户，我希望 req1 可用。",
      "",
      "### 验收标准",
      "1. req1 按契约工作。",
      "",
      "<!-- @id:[PRD]-demo:req2 -->",
      "## req2 需求",
      "",
      "**用户故事:** 作为用户，我希望 req2 可用。",
      "",
      "### 验收标准",
      "1. req2 按契约工作。",
    ].join("\n");
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: prdContent,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    // 第一次写入：splitA 声明 derives req1
    const fsdV1 = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitA -->",
      "## splitA split",
      "",
      "```yaml",
      "derives: [\"[PRD]-demo:req1\"]",
      "```",
      "",
      "### 功能描述",
      "splitA 功能描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitB -->",
      "## splitB split",
      "",
      "### 功能描述",
      "splitB 功能描述。",
    ].join("\n");

    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdV1,
      parent: "[PRD]-demo",
      skipContext: true,
    });

    let view = combinedView(root, VERSION);
    expect(
      hasEdge(view, "[PRD]-demo:req1", "[FSD]-alpha:splitA", "derives"),
    ).toBe(true);

    // 第二次写入：splitB 声明 derives req2（未涉及 splitA）
    const fsdV2 = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitB -->",
      "## splitB split",
      "",
      "```yaml",
      "derives: [\"[PRD]-demo:req2\"]",
      "```",
      "",
      "### 功能描述",
      "splitB 功能描述。",
    ].join("\n");

    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdV2,
      action: "modify",
      skipContext: true,
    });

    view = combinedView(root, VERSION);
    // 断言 splitA→req1 边仍存在（reconcile 保留）
    expect(
      hasEdge(view, "[PRD]-demo:req1", "[FSD]-alpha:splitA", "derives"),
    ).toBe(true);
    // 断言 splitB→req2 边新增
    expect(
      hasEdge(view, "[PRD]-demo:req2", "[FSD]-alpha:splitB", "derives"),
    ).toBe(true);
  });

  it("derives 非 PRD 拒绝：yaml 含 derives 目标不是 [PRD]- 开头 → DERIVES_NOT_PRD 零落盘", async () => {
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    const badFsd = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:split1 -->",
      "## split1 split",
      "",
      "```yaml",
      "derives: [\"[FSD]-other\"]",
      "```",
      "",
      "### 功能描述",
      "split1 功能描述。",
    ].join("\n");

    await expectErrCode(
      mgr.createDocument("fsd", "[FSD]-alpha", {
        content: badFsd,
        parent: "[PRD]-demo",
        skipContext: true,
      }),
      "DERIVES_NOT_PRD",
    );
    expect(versionFiles(root, "fsd")).toEqual([]);
  });

  it("端点不存在：yaml 含不存在的 PRD id → MISSING_ENDPOINT，整树字节不变", async () => {
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:split1 -->",
      "## split1 split",
      "",
      "```yaml",
      "derives: [\"[PRD]-ghost:req999\"]",
      "```",
      "",
      "### 功能描述",
      "split1 功能描述。",
    ].join("\n");

    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent,
      parent: "[PRD]-demo",
      skipContext: true,
    }), "MISSING_ENDPOINT");
    expect(treeSnapshot(root)).toEqual(before);

    // 断言图中无幽灵边（以 [FSD]-alpha:split1 为 dst 的 derives 边应为空）
    const view = combinedView(root, VERSION);
    const derivesEdges = view.edgesTo("[FSD]-alpha:split1", "derives");
    expect(
      derivesEdges.filter((e) => e.metadata?.source === "fsd-declaration"),
    ).toEqual([]);
  });

  it("短名解析：同次提交的新 sibling 可解析为 ${parentRoot}:${shortName}", async () => {
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitA -->",
      "## splitA split",
      "",
      "```yaml",
      "depends_on: [splitB]",
      "```",
      "",
      "### 功能描述",
      "splitA 功能描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitB -->",
      "## splitB split",
      "",
      "### 功能描述",
      "splitB 功能描述。",
    ].join("\n");

    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent,
      parent: "[PRD]-demo",
      skipContext: true,
    });

    const view = combinedView(root, VERSION);
    // 短名 "splitB" 解析为 "[FSD]-alpha:splitB"
    expect(
      hasEdge(view, "[FSD]-alpha:splitA", "[FSD]-alpha:splitB", "depends_on"),
    ).toBe(true);

    expect(view.edgesFrom("[FSD]-alpha:splitA", "depends_on").map((e) => e.dst))
      .toEqual(["[FSD]-alpha:splitB"]);
  });

  it("围栏内 yaml 保留：split 含围栏内的 yaml 代码块 → 不剥离、不建边", async () => {
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:split1 -->",
      "## split1 split",
      "",
      "### 功能描述",
      "split1 功能描述。",
      "",
      "### 示例代码",
      "",
      "````ts",
      "const config = `",
      "```yaml",
      "depends_on: [fake]",
      "```",
      "`;",
      "````",
    ].join("\n");

    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent,
      parent: "[PRD]-demo",
      skipContext: true,
    });

    const view = combinedView(root, VERSION);
    // 围栏内的 yaml 不建边
    const deps = view.edgesFrom("[FSD]-alpha:split1", "depends_on");
    expect(
      deps.filter((e) => e.metadata?.source === "fsd-declaration"),
    ).toEqual([]);

    // 断言版本工作区文件保留围栏内 yaml
    const fsdText = fs.readFileSync(
      path.join(root.root, "versions", VERSION, "fsd", "[FSD]-alpha.md"),
      "utf-8",
    );
    expect(fsdText).toContain("```yaml");
    expect(fsdText).toContain("depends_on: [fake]");
  });

  it("关系 yaml 损坏：FSD_DECLARATION_INVALID，先出现的合法声明也不落盘", async () => {
    const prdContent = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "### 概述",
      "demo 概述文本。",
      "",
      "<!-- @id:[PRD]-demo:req1 -->",
      "## req1 需求",
      "",
      "**用户故事:** 作为用户，我希望功能可用。",
      "",
      "### 验收标准",
      "1. 功能按契约工作。",
    ].join("\n");
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: prdContent,
      skipContext: true,
    });
    mgr.confirmLayer("prd");

    const fsdContent = [
      "<!-- @id:[FSD]-alpha -->",
      "## alpha 域功能分解根",
      "",
      "### 功能描述",
      "alpha 域描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitA -->",
      "## splitA split",
      "",
      "```yaml",
      "derives: [\"[PRD]-demo:req1\"]",
      "```",
      "",
      "### 功能描述",
      "splitA 功能描述。",
      "",
      "<!-- @id:[FSD]-alpha:splitB -->",
      "## splitB split",
      "",
      "```yaml",
      "derives: [unclosed bracket",
      "```",
      "",
      "### 功能描述",
      "splitB 功能描述。",
    ].join("\n");

    const before = treeSnapshot(root);
    await expect(mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdContent, parent: "[PRD]-demo", skipContext: true,
    })).rejects.toMatchObject({
      code: "FSD_DECLARATION_INVALID",
      message: expect.stringMatching(/fsd\/\[FSD\]-alpha\.md:\d+:\d+.*chunk=\[FSD\]-alpha:splitB/),
    });
    expect(treeSnapshot(root)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 令牌（:TEST 第 2 条）
// ---------------------------------------------------------------------------

describe("令牌", () => {
  let root: ProjectRoot;
  let mgr: NewModelManager;

  beforeEach(() => {
    ({ root, mgr } = makeProject());
  });

  it("令牌缺失/格式非法 → CONTEXT_TOKEN_INVALID 零落盘", async () => {
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", { content: PRD_DOC }),
      "CONTEXT_TOKEN_INVALID",
    );
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: PRD_DOC,
        contextToken: "not-a-token",
      }),
      "CONTEXT_TOKEN_INVALID",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("意图不符 → CONTEXT_TOKEN_STALE 零落盘", async () => {
    const otherDoc = [
      "<!-- @id:[PRD]-other -->",
      "## other 产品 PRD",
      "",
      "### 概述",
      "other 概述。",
    ].join("\n");
    const token = tokenOf(await mgr.createDocument("prd", "[PRD]-demo", {}));
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-other", {
        content: otherDoc,
        contextToken: token,
      }),
      "CONTEXT_TOKEN_STALE",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("背景已变 → CONTEXT_TOKEN_STALE 零落盘", async () => {
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    mgr.confirmLayer("prd");
    // fsd 层为空时取 s1 令牌（discovery 背景）
    const s1Token = tokenOf(await mgr.createDocument("fsd", "[FSD]-s1", {}));
    // 写入另一个 FSD 改变本层背景（survey 含 s2）
    const s2Doc = [
      "<!-- @id:[FSD]-s2 -->",
      "## s2 域功能分解根",
      "",
      "### 功能描述",
      "s2 描述。",
    ].join("\n");
    await mgr.createDocument("fsd", "[FSD]-s2", {
      content: s2Doc,
      parent: "[PRD]-demo",
      skipContext: true,
    });
    const s1Doc = [
      "<!-- @id:[FSD]-s1 -->",
      "## s1 域功能分解根",
      "",
      "### 功能描述",
      "s1 描述。",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("fsd", "[FSD]-s1", {
        content: s1Doc,
        contextToken: s1Token,
      }),
      "CONTEXT_TOKEN_STALE",
    );
    expect(versionFiles(root, "fsd")).toEqual(["[FSD]-s2.md"]);
  });

  it("--skip-context 与令牌互斥（USAGE_ERROR）；skip-context 单独使用留审计痕迹", async () => {
    const token = tokenOf(await mgr.createDocument("prd", "[PRD]-demo", {}));
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: PRD_DOC,
        contextToken: token,
        skipContext: true,
      }),
      "USAGE_ERROR",
    );
    expect(versionFiles(root, "prd")).toEqual([]);

    const written = await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_DOC,
      skipContext: true,
    });
    expect(written.mode).toBe("written");
    if (written.mode !== "written") throw new Error("unreachable");
    expect(written.audit?.skip_context).toBe(true);
    expect(typeof written.audit?.at).toBe("string");
    expect(versionFiles(root, "prd")).toEqual(["[PRD]-demo.md"]);
  });
});

// ---------------------------------------------------------------------------
// 内容闸与写时门禁（:TEST 第 3 条）——逐条构造违例输入，断言零落盘
// ---------------------------------------------------------------------------

describe("内容闸与写时门禁", () => {
  let root: ProjectRoot;
  let mgr: NewModelManager;

  beforeEach(() => {
    ({ root, mgr } = makeProject());
  });

  it("正文含 @ref 注释 → MARKDOWN_CONTAINS_RELATION 零落盘", async () => {
    const bad = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "### 概述",
      "demo 概述文本。",
      "",
      "<!-- @ref:[FSD]-demo -->",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: bad,
        skipContext: true,
      }),
      "MARKDOWN_CONTAINS_RELATION",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("非 FSD 层正文含 depends_on 声明块 → MARKDOWN_CONTAINS_RELATION 零落盘", async () => {
    const bad = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "```yaml",
      "depends_on: [foundation]",
      "```",
      "",
      "### 概述",
      "demo 概述文本。",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: bad,
        skipContext: true,
      }),
      "MARKDOWN_CONTAINS_RELATION",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("PRD 需求 chunk 缺用户故事 → PRD_REQUIREMENT_CONTRACT_VIOLATION 零落盘", async () => {
    const bad = [
      "<!-- @id:[PRD]-demo -->",
      "## demo 产品 PRD",
      "",
      "### 概述",
      "demo 概述文本。",
      "",
      "<!-- @id:[PRD]-demo:req1 -->",
      "## req1 需求",
      "",
      "只有描述，没有用户故事与验收标准。",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: bad,
        skipContext: true,
      }),
      "PRD_REQUIREMENT_CONTRACT_VIOLATION",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("TDD 缺 target_file → TDD_TARGET_FILE_REQUIRED 零落盘", async () => {
    await advanceToFsdConfirm(mgr);
    const bad = [
      "<!-- @id:[TDD]-svc -->",
      "## svc TDD",
      "",
      "### 技术栈",
      "TypeScript。",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("tdd", "[TDD]-svc", {
        content: bad,
        parent: "[FSD]-demo:svc",
        skipContext: true,
      }),
      "TDD_TARGET_FILE_REQUIRED",
    );
    expect(versionFiles(root, "tdd")).toEqual([]);
  });

  it("action=add 命中 baseline 已有 chunk → DUPLICATE_BASELINE_CHUNK 零落盘", async () => {
    writeDocs(root, {
      "prd/[PRD]-base.md": [
        "<!-- @id:[PRD]-base -->",
        "## base 产品 PRD",
        "",
        "### 概述",
        "base 概述。",
      ],
    });
    syncBaseline(root);
    const newDoc = [
      "<!-- @id:[PRD]-base -->",
      "## base 产品 PRD",
      "",
      "### 概述",
      "改写后的 base 概述。",
    ].join("\n");
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-base", {
        content: newDoc,
        action: "add",
        skipContext: true,
      }),
      "DUPLICATE_BASELINE_CHUNK",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });

  it("TDD target_file 归一化后命中 baseline 已有制品 → DUPLICATE_TARGET_FILE 零落盘", async () => {
    setupCodegenBaseline(root);
    await createVersionTdd(root, "add", false);
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("tdd", "[TDD]-impl2", {
      content: tddDoc("[TDD]-impl2", "./src//impl.ts"), parent: "[FSD]-demo:impl", skipContext: true,
    }), "DUPLICATE_TARGET_FILE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("split create 省略 --file 落父根文档（不派生含冒号文件名）", async () => {
    setupCodegenBaseline(root);
    await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_REQUIREMENTS, action: "modify", skipContext: true,
    });
    mgr.confirmLayer("prd");
    const before = parseFile(path.join(root.docs, "fsd", "[FSD]-demo.md"), root.root);
    const splitDoc = ["<!-- @id:[FSD]-demo:news -->", "## news split", "新增能力。"].join("\n");
    const written = await mgr.createDocument("fsd", "[FSD]-demo:news", { content: splitDoc, skipContext: true });
    expect(written).toMatchObject({ mode: "written", file: "fsd/[FSD]-demo.md" });
    expect(versionFiles(root, "fsd")).toEqual(["[FSD]-demo.md"]);
    const after = parseFile(versionFile(root, "fsd/[FSD]-demo.md"), root.root);
    expect(after.chunks.map((chunk) => chunk.id)).toEqual([...before.chunks.map((chunk) => chunk.id), "[FSD]-demo:news"]);
    for (const chunk of before.chunks) {
      expect(after.chunks.find((item) => item.id === chunk.id)?.content).toBe(chunk.content);
    }
  });

  it("--file 含冒号 → INVALID_FILE_NAME 零落盘", async () => {
    await expectErrCode(
      mgr.createDocument("prd", "[PRD]-demo", {
        content: PRD_DOC,
        file: "a:b.md",
        skipContext: true,
      }),
      "INVALID_FILE_NAME",
    );
    expect(versionFiles(root, "prd")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 文件合成（FSD 能力契约：按 chunk id 覆盖合成）
// ---------------------------------------------------------------------------

/** 既有 FSD 基线：根 chunk + 3 个 split（共 4 chunk）。 */
const FSD_MULTI_DOC = [
  "<!-- @id:[FSD]-multi -->",
  "## multi 域功能分解根",
  "",
  "### 功能描述",
  "multi 域描述。",
  "",
  "<!-- @id:[FSD]-multi:svc -->",
  "## svc split",
  "",
  "### 功能描述",
  "svc 功能描述。",
  "",
  "<!-- @id:[FSD]-multi:lib -->",
  "## lib split",
  "",
  "### 功能描述",
  "lib 功能描述。",
  "",
  "<!-- @id:[FSD]-multi:store -->",
  "## store split",
  "",
  "### 功能描述",
  "store 功能描述。",
].join("\n");

/** 仅根 chunk 的提交形态。 */
const FSD_MULTI_ROOT_ONLY = [
  "<!-- @id:[FSD]-multi -->",
  "## multi 域功能分解根",
  "",
  "### 功能描述",
  "multi 域描述。",
].join("\n");

const FSD_MULTI_FILE = "[FSD]-multi.md";

/** 双版本激活：活动版本为首个非 merged 版本，故写新版本前先把既有未合并版本置 merged。 */
const COMPOSE_V1 = "v0.3";
const COMPOSE_V2 = "v0.4";

function activateComposeVersion(root: ProjectRoot, version: string): void {
  const metaDir = path.join(root.meta, "versions");
  for (const existing of new IndexManager(root).listVersions()) {
    if (existing === version) continue;
    const p = path.join(metaDir, `${existing}.yaml`);
    const meta = loadModel(p, VersionMetaSchema);
    if (meta.phase === "merged") continue;
    meta.phase = "merged";
    meta.merged_at = new Date().toISOString();
    saveModel(p, meta);
  }
  saveModel(path.join(metaDir, `${version}.yaml`), {
    version,
    created_at: new Date().toISOString(),
    merged_at: null,
    owner: null,
    changes: [],
    dependencies: { based_on: null, conflicts_with: [], merge_after: [] },
    snapshot: null,
    phase: "empty",
    title: null,
    prd_locked: false,
    impl_locked: false,
    docs_commit: null,
    code_base: null,
    code_result: null,
    confirmed_plan: null,
    revert_anchor: null,
    recovery_journal: null,
    historical_anchor_repairs: [],
  });
}

/**
 * 在独立版本里对既有 4-chunk FSD 执行一次 create 提交，返回版本工作区文件路径。
 * 基线取自 docs（版本工作区初始为空），故源文本即含 4 个 chunk 的既有 FSD。
 */
async function composeInto(
  root: ProjectRoot,
  mgr: NewModelManager,
  version: string,
  content: string,
): Promise<string> {
  activateComposeVersion(root, version);
  await mgr.createDocument("prd", "[PRD]-demo", {
    content: PRD_REQUIREMENTS,
    action: "modify",
    skipContext: true,
  });
  mgr.confirmLayer("prd");
  await mgr.createDocument("fsd", "[FSD]-multi", {
    content,
    parent: "[PRD]-demo",
    action: "modify",
    file: FSD_MULTI_FILE,
    skipContext: true,
  });
  const written = path.join(
    root.root,
    "versions",
    version,
    "fsd",
    FSD_MULTI_FILE,
  );
  expect(fs.existsSync(written)).toBe(true);
  return written;
}

describe("文件合成", () => {
  let root: ProjectRoot;
  let mgr: NewModelManager;

  /** 空版本工作区 + 含 4 个 chunk 的既有 FSD 基线。 */
  beforeEach(() => {
    root = makeRoot();
    writeDocs(root, { "prd/[PRD]-demo.md": PRD_REQUIREMENTS.split("\n"), "fsd/[FSD]-multi.md": FSD_MULTI_DOC.split("\n") });
    syncBaseline(root);
    baselineEdges(root, [["[PRD]-demo", "[FSD]-multi", "derives"]]);
    mgr = new NewModelManager(root);
    // 基线索引已含 4 个 chunk：create 的默认 action 会推出 modify（不命中 add 门禁）
    expect(new IndexManager(root).queryBaseline("[FSD]-multi:svc")).not.toBeNull();
  });

  it("完整文档 replay 与仅根 chunk 提交字节等价；chunk 数均 4；parseFile 不抛重复 id", async () => {
    // 独立版本 A：仅根 chunk
    const fileA = await composeInto(root, mgr, COMPOSE_V1, FSD_MULTI_ROOT_ONLY);
    const textA = fs.readFileSync(fileA, "utf-8");

    // 独立版本 B：根 + 全部既有 split 的完整文档 replay
    const fileB = await composeInto(root, mgr, COMPOSE_V2, FSD_MULTI_DOC);
    const textB = fs.readFileSync(fileB, "utf-8");

    // 两种提交形态落盘字节等价
    expect(textB).toBe(textA);
    expect(Buffer.compare(fs.readFileSync(fileA), fs.readFileSync(fileB))).toBe(0);

    // chunk 数均为 4，且 id 集合与既有基线一致
    expect(() => parseFile(fileA, root.root)).not.toThrow();
    expect(() => parseFile(fileB, root.root)).not.toThrow();
    const parsedA = parseFile(fileA, root.root);
    const parsedB = parseFile(fileB, root.root);
    expect(parsedA.chunks).toHaveLength(4);
    expect(parsedB.chunks).toHaveLength(4);
    const expectedIds = [
      "[FSD]-multi",
      "[FSD]-multi:svc",
      "[FSD]-multi:lib",
      "[FSD]-multi:store",
    ];
    expect(parsedA.chunks.map((c) => c.id)).toEqual(expectedIds);
    expect(parsedB.chunks.map((c) => c.id)).toEqual(expectedIds);
    // 无重复 chunk id（parseFile 本身对重复 id 抛 CHUNK_PARSE_ERROR）
    expect(new Set(parsedA.chunks.map((c) => c.id)).size).toBe(4);
    expect(new Set(parsedB.chunks.map((c) => c.id)).size).toBe(4);
  });

  it("仅根 chunk 提交：既有 split 原样保留、split 正文不变", async () => {
    const fileA = await composeInto(root, mgr, COMPOSE_V1, FSD_MULTI_ROOT_ONLY);
    const parsedA = parseFile(fileA, root.root);
    const baseline = parseFile(
      path.join(root.docs, "fsd", FSD_MULTI_FILE),
      root.root,
    );

    // 仅根 chunk 提交后，既有 3 个 split 仍在且正文逐字不变
    for (const id of [
      "[FSD]-multi:svc",
      "[FSD]-multi:lib",
      "[FSD]-multi:store",
    ]) {
      const after = parsedA.chunks.find((c) => c.id === id);
      const before = baseline.chunks.find((c) => c.id === id);
      expect(after).toBeDefined();
      expect(after?.content).toBe(before?.content);
      expect(after?.heading).toBe(before?.heading);
    }
    // 根 chunk 正文与提交形态一致
    const rootChunk = parsedA.chunks.find((c) => c.id === "[FSD]-multi");
    expect(rootChunk?.content).toBe(FSD_MULTI_ROOT_ONLY);
  });
});

// ---------------------------------------------------------------------------
// validator（:TEST 第 4 条）
// ---------------------------------------------------------------------------

/** 内存节点构造（target_file 经运行期附加，模拟视图携带的 TDD 声明）。 */
function nodeOf(id: string, targetFile?: string): SpecNode {
  const layer = id.startsWith("[PRD]-")
    ? "prd"
    : id.startsWith("[FSD]-")
      ? "fsd"
      : "tdd";
  const base = id.split(":")[0] as string;
  const node: Record<string, unknown> = {
    chunk_id: id,
    type: layer,
    version: "baseline",
    uri: `spec:${layer}:baseline:${id}`,
    title: id,
    file: `${layer}/${base}.md`,
    heading: id,
    summary: null,
  };
  if (targetFile !== undefined) {
    node["target_file"] = targetFile;
  }
  return node as unknown as SpecNode;
}

/** 内存组合视图构造：ids 项为 id 或 [id, target_file]；edges 项为 [src, dst, rel]。 */
function makeView(
  ids: Array<string | [string, string]>,
  edges: Array<[string, string, EdgeRel]>,
): CombinedView {
  const nodes = new Map<string, SpecNode>();
  for (const item of ids) {
    if (Array.isArray(item)) {
      nodes.set(item[0], nodeOf(item[0], item[1]));
    } else {
      nodes.set(item, nodeOf(item));
    }
  }
  const edgeObjs: Edge[] = edges.map(([src, dst, rel]) => ({
    src,
    dst,
    rel,
    metadata: {},
  }));
  return new CombinedView(nodes, edgeObjs);
}

function codesOf(violations: Violation[]): string[] {
  return violations.map((v) => v.code);
}

/** 合法图：PRD 根→FSD 根（derives）、根→split（结构通道）、split→TDD（details）。 */
const LEGAL_IDS: Array<string | [string, string]> = [
  "[PRD]-p",
  "[FSD]-p",
  "[FSD]-p:svc",
  ["[TDD]-svc", "src/svc.ts"],
];
const LEGAL_EDGES: Array<[string, string, EdgeRel]> = [
  ["[PRD]-p", "[FSD]-p", "derives"],
  ["[FSD]-p:svc", "[TDD]-svc", "details"],
];

describe("validator", () => {
  it("合法图零违例；空视图零违例", () => {
    expect(validateInvariants(makeView(LEGAL_IDS, LEGAL_EDGES))).toEqual([]);
    expect(validateInvariants(makeView([], []))).toEqual([]);
  });

  it("PRD 第二 FSD → PRD_FSD_LINK_NOT_UNIQUE", () => {
    const view = makeView(
      [...LEGAL_IDS, "[FSD]-q"],
      [...LEGAL_EDGES, ["[PRD]-p", "[FSD]-q", "derives"]],
    );
    expect(codesOf(validateInvariants(view))).toContain(
      "PRD_FSD_LINK_NOT_UNIQUE",
    );
  });

  it("TDD 第二父 → TDD_MULTI_PARENT", () => {
    const view = makeView(
      [...LEGAL_IDS, "[FSD]-p:svc2"],
      [...LEGAL_EDGES, ["[FSD]-p:svc2", "[TDD]-svc", "details"]],
    );
    expect(codesOf(validateInvariants(view))).toContain("TDD_MULTI_PARENT");
  });

  it("制品撞车（归一化后）→ DUPLICATE_TARGET_FILE", () => {
    const view = makeView(
      [...LEGAL_IDS, ["[TDD]-dup", "./src//svc.ts"]],
      [...LEGAL_EDGES, ["[FSD]-p:svc", "[TDD]-dup", "details"]],
    );
    expect(codesOf(validateInvariants(view))).toContain(
      "DUPLICATE_TARGET_FILE",
    );
  });

  it("幽灵端点 → MISSING_ENDPOINT", () => {
    const view = makeView(LEGAL_IDS, [
      ...LEGAL_EDGES,
      ["[FSD]-p", "[FSD]-ghost", "decomposes"],
    ]);
    expect(codesOf(validateInvariants(view))).toContain("MISSING_ENDPOINT");
  });

  it("孤立 FSD 根没有 TDD 仍是孤儿，真实 PRD 根无需上游", () => {
    const view = makeView([...LEGAL_IDS, "[FSD]-x", "[FSD]-x:stray"], LEGAL_EDGES);
    const codes = codesOf(validateInvariants(view));
    expect(codes).toContain("ORPHAN_CHUNK");
    const orphan = validateInvariants(view).find(
      (v) => v.code === "ORPHAN_CHUNK",
    );
    expect(orphan?.chunkId).toBe("[FSD]-x");
    expect(validateInvariants(makeView(["[PRD]-only"], []))
      .filter((v) => v.code === "ORPHAN_CHUNK")).toEqual([]);
  });

  it("断链（TDD 上溯不可达 PRD）→ TRACE_BROKEN", () => {
    const view = makeView(
      [...LEGAL_IDS, "[FSD]-q", "[FSD]-q:svc", ["[TDD]-qsvc", "src/q.ts"]],
      [...LEGAL_EDGES, ["[FSD]-q:svc", "[TDD]-qsvc", "details"]],
    );
    expect(codesOf(validateInvariants(view))).toContain("TRACE_BROKEN");
  });

  it("树关系成环 → SPEC_CYCLE；depends_on 环不判", () => {
    const cycled = makeView(LEGAL_IDS, [
      ...LEGAL_EDGES,
      ["[FSD]-p:svc", "[FSD]-p", "decomposes"],
    ]);
    expect(codesOf(validateInvariants(cycled))).toContain("SPEC_CYCLE");

    const depCycled = makeView(
      [...LEGAL_IDS, "[FSD]-p:lib"],
      [
        ...LEGAL_EDGES,
        ["[FSD]-p:svc", "[FSD]-p:lib", "depends_on"],
        ["[FSD]-p:lib", "[FSD]-p:svc", "depends_on"],
      ],
    );
    expect(validateInvariants(depCycled)).toEqual([]);
  });

  it("checkEdgeWrite：合法边零违例；幽灵端点；类型/基数/根-split 规则", () => {
    const view = makeView(
      [
        ...LEGAL_IDS,
        "[PRD]-p:r1",
        "[FSD]-p:lib",
        "[FSD]-p:TEST",
        "[FSD]-q",
        "[FSD]-q:zap",
        ["[TDD]-new", "src/new.ts"],
      ],
      LEGAL_EDGES,
    );
    // 合法 depends_on（同父兄弟 split）
    expect(
      checkEdgeWrite(view, "[FSD]-p:svc", "[FSD]-p:lib", "depends_on"),
    ).toEqual([]);
    // 合法 details（FSD split → 无父 TDD）
    expect(
      checkEdgeWrite(view, "[FSD]-p:lib", "[TDD]-new", "details"),
    ).toEqual([]);
    // 幽灵端点
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-ghost", "[FSD]-p", "derives")),
    ).toContain("MISSING_ENDPOINT");
    // derives 类型非法
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-p", "[PRD]-p", "derives")),
    ).toContain("INVALID_DERIVES");
    // derives 非法目标：PRD split → FSD 根；任意 PRD → :TEST
    expect(
      codesOf(checkEdgeWrite(view, "[PRD]-p:r1", "[FSD]-p", "derives")),
    ).toContain("DERIVES_ILLEGAL_TARGET");
    expect(
      codesOf(checkEdgeWrite(view, "[PRD]-p", "[FSD]-p:TEST", "derives")),
    ).toContain("DERIVES_ILLEGAL_TARGET");
    // PRD 第二 FSD（已有 derives [PRD]-p→[FSD]-p）
    expect(
      codesOf(checkEdgeWrite(view, "[PRD]-p", "[FSD]-q", "derives")),
    ).toContain("PRD_FSD_LINK_NOT_UNIQUE");
    // details 类型非法
    expect(
      codesOf(checkEdgeWrite(view, "[PRD]-p", "[TDD]-new", "details")),
    ).toContain("INVALID_DETAILS");
    // TDD 第二父（[TDD]-svc 已有 details 父 [FSD]-p:svc）
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-p:lib", "[TDD]-svc", "details")),
    ).toContain("TDD_MULTI_PARENT");
    // decomposes 类型/形态非法
    expect(
      codesOf(checkEdgeWrite(view, "[TDD]-svc", "[FSD]-p", "decomposes")),
    ).toContain("INVALID_DECOMPOSES_TYPES");
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-p", "[FSD]-q", "decomposes")),
    ).toContain("INVALID_FSD_DECOMPOSES");
    // depends_on：端点须为同父 FSD split
    expect(
      codesOf(checkEdgeWrite(view, "[PRD]-p", "[FSD]-p:svc", "depends_on")),
    ).toContain("INVALID_DEPENDS_ON_TYPES");
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-p:svc", "[FSD]-p", "depends_on")),
    ).toContain("DEPENDS_ON_ROOT_CHUNK");
    expect(
      codesOf(checkEdgeWrite(view, "[FSD]-p:svc", "[FSD]-q:zap", "depends_on")),
    ).toContain("DEPENDS_ON_CROSS_LEVEL");
  });

  it("PRD 需求契约三态（合规/缺用户故事/空壳小节）与根豁免", () => {
    const ok = [
      "**用户故事:** 作为用户，我希望系统工作。",
      "",
      "### 验收标准",
      "1. 条目一成立。",
    ].join("\n");
    expect(scanPrdRequirementContract("[PRD]-p:req", ok)).toEqual([]);

    const noStory = ["### 验收标准", "1. 条目一成立。"].join("\n");
    expect(
      codesOf(scanPrdRequirementContract("[PRD]-p:req", noStory)),
    ).toContain("PRD_REQUIREMENT_CONTRACT_VIOLATION");

    const emptySection = [
      "**用户故事:** 作为用户，我希望系统工作。",
      "",
      "### 验收标准",
      "（待补充）",
    ].join("\n");
    expect(
      codesOf(scanPrdRequirementContract("[PRD]-p:req", emptySection)),
    ).toContain("PRD_REQUIREMENT_CONTRACT_VIOLATION");

    // PRD 根 chunk 不受需求契约约束
    expect(scanPrdRequirementContract("[PRD]-p", "任意概述文本。")).toEqual([]);
  });

  it("正文关系残留两类（@ref/@extract 注释、非 FSD 层声明块）；FSD 层声明块豁免", () => {
    const withRef = ["正文。", "<!-- @ref:[FSD]-x -->"].join("\n");
    expect(codesOf(scanContentRelations(withRef, "prd"))).toContain(
      "MARKDOWN_CONTAINS_RELATION",
    );
    const withExtract = ["正文。", "<!-- @extract:src/a.ts -->"].join("\n");
    expect(codesOf(scanContentRelations(withExtract, "tdd"))).toContain(
      "MARKDOWN_CONTAINS_RELATION",
    );
    const withDecl = ["```yaml", "depends_on: [x]", "```"].join("\n");
    expect(codesOf(scanContentRelations(withDecl, "tdd"))).toContain(
      "MARKDOWN_CONTAINS_RELATION",
    );
    expect(scanContentRelations(withDecl, "fsd")).toEqual([]);
    expect(scanContentRelations("干净正文。", "prd")).toEqual([]);
  });

  it("normalizeTargetFile 归一化与 validateTargetFileUniqueness", () => {
    expect(normalizeTargetFile("./src//a.ts")).toBe("src/a.ts");
    expect(normalizeTargetFile("src\\x\\y.ts")).toBe("src/x/y.ts");
    expect(normalizeTargetFile("src/a.ts")).toBe("src/a.ts");

    const dup = makeView(
      [
        ["[TDD]-a", "src/x.ts"],
        ["[TDD]-b", "./src//x.ts"],
      ],
      [],
    );
    expect(codesOf(validateTargetFileUniqueness(dup))).toContain(
      "DUPLICATE_TARGET_FILE",
    );
    const ok = makeView(
      [
        ["[TDD]-a", "src/x.ts"],
        ["[TDD]-b", "src/y.ts"],
      ],
      [],
    );
    expect(validateTargetFileUniqueness(ok)).toEqual([]);
  });
});

describe("v0.10 行内 code span 关系扫描", () => {
  const examples = [
    ["单反引号与中文", "说明 `<!-- @ref:[FSD]-demo -->` 和 `<!-- @extract:src/a.ts -->` 是语法示例。"],
    ["双反引号内含不同长度反引号", "说明 ``单个 `、三个 ``` 与 <!-- @ref:[FSD]-demo --> / <!-- @extract:src/a.ts -->``。"],
    ["三反引号内含单双反引号", "说明 ```单个 `、两个 `` 与 <!-- @ref:[FSD]-demo --> / <!-- @extract:src/a.ts -->```。"],
    ["跨行 span", ["说明 ``中文示例", "<!-- @ref:[FSD]-demo -->", "单个 ` 不闭合 span。", "<!-- @extract:src/a.ts -->", "结束``。"].join("\n")],
    ["CRLF 跨行 span", ["说明 `中文示例", "<!-- @ref:[FSD]-demo -->", "<!-- @extract:src/a.ts -->", "结束`。"].join("\r\n")],
  ];
  const relations = [
    ["未闭合 span", "说明 `未闭合 <!-- @ref:[FSD]-demo -->"],
    ["不同长度不能闭合", "说明 ``未闭合 ` <!-- @extract:src/a.ts -->"],
    ["未闭合 span 的后续行", "说明 `未闭合\n<!-- @ref:[FSD]-demo -->"],
    ["同一行 span 前真实注释", "<!-- @ref:[FSD]-demo --> 说明 `<!-- @extract:src/a.ts -->`。"],
    ["同一行 span 后真实注释", "说明 `<!-- @ref:[FSD]-demo -->`。 <!-- @extract:src/a.ts -->"],
    ["已闭合 span 后续行真实注释", "说明 ``<!-- @extract:src/a.ts -->``。\n<!-- @ref:[FSD]-demo -->"],
  ];
  const cases = (["prd", "fsd", "tdd"] as const).flatMap((layer) => [
    ...examples.map(([label, content]) => ({ layer, label, content: content!, rejected: false })),
    ...relations.map(([label, content]) => ({ layer, label, content: content!, rejected: true })),
  ]);
  it.each(cases)("$layer：$label", ({ layer, content, rejected }) => {
    expect(codesOf(scanContentRelations(content, layer)))
      .toEqual(rejected ? ["MARKDOWN_CONTAINS_RELATION"] : []);
  });

  it.each(["prd", "fsd", "tdd"] as const)("%s 注释语法说明通过真实 create/confirm，span 外注释拒绝且零落盘", async (layer) => {
    const { root, mgr } = makeProject();
    if (layer === "fsd") await advanceToPrdConfirm(mgr);
    if (layer === "tdd") await advanceToFsdConfirm(mgr);
    const id = layer === "prd" ? "[PRD]-demo" : layer === "fsd" ? "[FSD]-alpha" : "[TDD]-chunk_parser";
    const parent = layer === "fsd" ? { parent: "[PRD]-demo" } : layer === "tdd" ? { parent: "[FSD]-demo:svc" } : {};
    const document = layer === "prd" ? PRD_REQUIREMENTS : layer === "fsd" ? fsdFixture()
      : tddDoc(id, "src/doc-model/chunk-parser.ts");
    const notes = examples.map(([, content]) => content!.replace(/\r\n/g, "\n"));
    const content = [document, "### 注释语法说明", ...notes].join("\n\n");
    const invalidLine = relations.find(([label]) => label === "同一行 span 后真实注释")![1]!;
    const contextToken = tokenOf(await mgr.createDocument(layer, id, parent));
    const beforeCreate = treeSnapshot(root);
    await expectErrCode(mgr.createDocument(layer, id, {
      ...parent, content: content + "\n" + invalidLine, contextToken,
    }), "MARKDOWN_CONTAINS_RELATION");
    expect(treeSnapshot(root)).toEqual(beforeCreate);

    expect((await mgr.createDocument(layer, id, { ...parent, content, contextToken })).mode).toBe("written");
    const file = versionFile(root, layer + "/" + id + ".md");
    const stored = fs.readFileSync(file, "utf8");
    for (const note of notes) expect(stored).toContain(note);
    expect(scanContentRelations(stored, layer)).toEqual([]);

    // 仅破坏临时测试副本，验证 confirm 重新执行同一内容门禁。
    fs.writeFileSync(file, stored + "\n" + invalidLine, "utf8");
    const beforeConfirm = treeSnapshot(root);
    expectThrowCode(() => mgr.confirmLayer(layer), "MARKDOWN_CONTAINS_RELATION");
    expect(treeSnapshot(root)).toEqual(beforeConfirm);
    fs.writeFileSync(file, stored, "utf8");
    expect(mgr.confirmLayer(layer)).toMatchObject({
      phase: layer + "-confirm", confirmed: expect.arrayContaining([id]),
    });
    expect(fs.readFileSync(file, "utf8")).toBe(stored);
    expect(new IndexManager(root).queryVersion(VERSION, id)?.state).toBe("committed");
  });
});

// ---------------------------------------------------------------------------
// codegenPrepare（:TEST 第 5 条）
// ---------------------------------------------------------------------------

/** baseline 文档树：PRD 根+需求 split；FSD 根+impl/helper/:TEST split；五个 TDD。 */
const CODEGEN_DOCS: Record<string, string[]> = {
  "prd/[PRD]-demo.md": [
    "<!-- @id:[PRD]-demo -->",
    "## demo 产品 PRD",
    "",
    "### 概述",
    "demo 概述文本。",
    "",
    "<!-- @id:[PRD]-demo:req1 -->",
    "## req1 需求",
    "",
    "**用户故事:** 作为用户，我希望 impl 能力可用。",
    "",
    "### 验收标准",
    "1. impl 能力按契约工作。",
  ],
  "fsd/[FSD]-demo.md": [
    "<!-- @id:[FSD]-demo -->",
    "## demo 域功能分解根",
    "",
    "### 功能描述",
    "demo 域描述。",
    "",
    "<!-- @id:[FSD]-demo:impl -->",
    "## impl split",
    "",
    "### 功能描述",
    "impl 能力。",
    "",
    "<!-- @id:[FSD]-demo:helper -->",
    "## helper split",
    "",
    "### 能力契约",
    "- 提供 helper 接口。",
    "",
    "<!-- @id:[FSD]-demo:TEST -->",
    "## TEST 验收",
    "",
    "### 功能描述",
    "demo 域集成验收。",
  ],
  "tdd/[TDD]-impl.md": tddDoc("[TDD]-impl", "src/impl.ts").split("\n"),
  "tdd/[TDD]-helper.md": tddDoc("[TDD]-helper", "src/helper.ts").split("\n"),
  "tdd/[TDD]-acceptance.md": tddDoc(
    "[TDD]-acceptance",
    "tests/acceptance.test.ts",
  ).split("\n"),
  "tdd/[TDD]-dircase.md": tddDoc("[TDD]-dircase", "src/dir-target").split("\n"),
};

function setupCodegenBaseline(root: ProjectRoot): void {
  writeDocs(root, CODEGEN_DOCS);
  syncBaseline(root);
  baselineEdges(root, [
    ["[PRD]-demo", "[FSD]-demo", "derives"],
    ["[PRD]-demo:req1", "[FSD]-demo:impl", "derives"],
    ["[FSD]-demo:impl", "[FSD]-demo:helper", "depends_on"],
    ["[FSD]-demo:impl", "[TDD]-impl", "details"],
    ["[FSD]-demo:helper", "[TDD]-helper", "details"],
    ["[FSD]-demo:helper", "[TDD]-dircase", "details"],
    ["[FSD]-demo:TEST", "[TDD]-acceptance", "details"],
  ]);
}

async function createVersionTdd(root: ProjectRoot, action: "add" | "modify", confirmed = true) {
  activateVersion(root);
  const mgr = new NewModelManager(root);
  await mgr.createDocument("prd", "[PRD]-demo", {
    content: PRD_REQUIREMENTS, action: "modify", skipContext: true,
  });
  mgr.confirmLayer("prd");
  await mgr.createDocument("fsd", "[FSD]-demo", {
    content: CODEGEN_DOCS["fsd/[FSD]-demo.md"]!.join("\n"),
    parent: "[PRD]-demo", action: "modify", skipContext: true,
  });
  mgr.confirmLayer("fsd");
  const id = action === "add" ? "[TDD]-new" : "[TDD]-impl";
  const target = action === "add" ? "src/new.ts" : "src/updated.ts";
  const content = tddDoc(id, '"' + target + '"') + "\n版本侧修改。";
  await mgr.createDocument("tdd", id, {
    content, action, parent: "[FSD]-demo:impl", skipContext: true,
  });
  if (confirmed) mgr.confirmLayer("tdd");
  return { mgr, id, target, content, file: versionFile(root, "tdd/" + id + ".md") };
}

describe("codegenPrepare", () => {
  let root: ProjectRoot;

  beforeEach(() => {
    root = makeRoot();
    setupCodegenBaseline(root);
  });

  it("普通实现 TDD：上溯全链+依赖契约+selection_reason 齐备，排序稳定，target_file absent", () => {
    const bundle = codegenPrepare(root, null, "[TDD]-impl");
    expect(bundle.tddRoot).toBe("[TDD]-impl");
    expect(bundle.targetFile).toBe("src/impl.ts");
    // 新建场景：target_file 不存在 → absent（正常交付，不带内容）
    expect(bundle.targetState).toBe("absent");
    expect(bundle.targetContent).toBeUndefined();

    // 上溯链：目标 TDD（实现规格）→ details 父（直接开发依据）→ decomposes 父（所属域约束）
    // → derives 上游 PRD 需求 split 与 PRD 根（产品意图），自近及远
    expect(bundle.upstream.map((i) => i.id)).toEqual([
      "[TDD]-impl",
      "[FSD]-demo:impl",
      "[FSD]-demo",
      "[PRD]-demo:req1",
      "[PRD]-demo",
    ]);
    const roles = new Map(bundle.upstream.map((i) => [i.id, i.role]));
    expect(roles.get("[TDD]-impl")).toBe("实现规格");
    expect(roles.get("[FSD]-demo:impl")).toBe("直接开发依据");
    expect(roles.get("[FSD]-demo")).toBe("所属域约束");
    expect(roles.get("[PRD]-demo:req1")).toBe("产品意图");
    expect(roles.get("[PRD]-demo")).toBe("产品意图");
    for (const item of bundle.upstream) {
      expect(item.selectionReason.length).toBeGreaterThan(0);
      expect(item.content.length).toBeGreaterThan(0);
    }

    // 路径 split 的 depends_on 对端收为依赖契约（不广播无关子树）
    expect(bundle.dependencies.map((d) => d.id)).toEqual([
      "[FSD]-demo:helper",
    ]);
    expect(bundle.dependencies[0]?.role).toBe("依赖的对外接口");
    expect(bundle.dependencies[0]?.selectionReason).toContain("depends_on");

    // 排序稳定：重复调用逐项一致
    const again = codegenPrepare(root, null, "[TDD]-impl");
    expect(again.upstream.map((i) => i.id)).toEqual(
      bundle.upstream.map((i) => i.id),
    );
    expect(again.dependencies.map((d) => d.id)).toEqual(
      bundle.dependencies.map((d) => d.id),
    );
  });

  it("target_file 三态互不混同：loaded 带内容；unreadable 不混同 absent", () => {
    fs.mkdirSync(path.join(root.cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(root.cwd, "src", "impl.ts"), "export const x = 1;\n");
    const loaded = codegenPrepare(root, null, "[TDD]-impl");
    expect(loaded.targetState).toBe("loaded");
    expect(loaded.targetContent).toBe("export const x = 1;\n");

    // 存在但读失败（target_file 指向目录）→ unreadable，不带内容、不混同 absent
    fs.mkdirSync(path.join(root.cwd, "src", "dir-target"));
    const unreadable = codegenPrepare(root, null, "[TDD]-dircase");
    expect(unreadable.targetState).toBe("unreadable");
    expect(unreadable.targetContent).toBeUndefined();
  });

  it("TDD 不存在 → TDD_NOT_FOUND；TDD 缺 target_file → TARGET_FILE_MISSING", () => {
    writeDocs(root, { "tdd/[TDD]-notarget.md": ["<!-- @id:[TDD]-notarget -->", "## 无制品声明"] });
    syncBaseline(root);
    expectThrowCode(
      () => codegenPrepare(root, null, "[TDD]-missing"),
      "TDD_NOT_FOUND",
    );
    expectThrowCode(
      () => codegenPrepare(root, null, "[TDD]-notarget"),
      "TARGET_FILE_MISSING",
    );
    expect(
      () => codegenPrepare(root, null, "[TDD]-notarget"),
    ).toThrowError(CodegenError);
  });

  it(":TEST TDD：同父功能 sibling 及其实现 TDD 与承接的 PRD 需求 split 一并收集", () => {
    const bundle = codegenPrepare(root, null, "[TDD]-acceptance");
    // 自身上溯链齐备
    expect(bundle.upstream[0]?.id).toBe("[TDD]-acceptance");
    expect(bundle.upstream.map((i) => i.id)).toContain("[FSD]-demo:TEST");

    // 同父功能 sibling（:impl/:helper）及其实现 TDD 收为相关实现参考
    const refs = bundle.upstream
      .filter((i) => i.role === "相关实现参考")
      .map((i) => i.id);
    expect(refs).toEqual(
      expect.arrayContaining([
        "[FSD]-demo:impl",
        "[FSD]-demo:helper",
        "[TDD]-impl",
        "[TDD]-helper",
      ]),
    );

    // sibling 承接的 PRD 需求 split 收为产品意图
    const intents = bundle.upstream
      .filter((i) => i.role === "产品意图")
      .map((i) => i.id);
    expect(intents).toContain("[PRD]-demo:req1");
    for (const item of bundle.upstream) {
      expect(item.selectionReason.length).toBeGreaterThan(0);
    }
  });

  it("baseline 回退与版本侧优先：自动/显式活动版本读取真实 .md，merged 指向 baseline", async () => {
    const base = codegenPrepare(root, null, "[TDD]-impl");
    expect(base.version).toBeNull();
    expect(base.sourceFile).toBe(path.join(root.docs, "tdd", "[TDD]-impl.md"));
    const active = await createVersionTdd(root, "modify");
    const versioned = codegenPrepare(root, null, active.id);
    expect(versioned).toMatchObject({ version: VERSION, sourceFile: active.file, targetFile: active.target });
    expect(versioned.upstream[0]?.content).toContain("版本侧修改");
    expect(codegenPrepare(root, VERSION, active.id)).toEqual(versioned);
    expect(versioned.upstream.map((item) => item.id)).toEqual(base.upstream.map((item) => item.id));
    expect(versioned.dependencies).toEqual(base.dependencies);
    const metaFile = path.join(root.meta, "versions", VERSION + ".yaml");
    const meta = loadModel(metaFile, VersionMetaSchema);
    saveModel(metaFile, { ...meta, phase: "merged", merged_at: new Date().toISOString() });
    expect(codegenPrepare(root, VERSION, active.id)).toEqual(base);
    expect(codegenPrepare(root, null, active.id)).toEqual(base);
    expectThrowCode(() => codegenPrepare(root, "v404.0", active.id), "VERSION_NOT_FOUND");
  });

});


describe("v0.10 FSD 声明生产路径", () => {
  it.each([
    ["未知 sibling", "depends_on: [ghost]", "MISSING_ENDPOINT"],
    ["自依赖", "depends_on: [splitA]", "FSD_DECLARATION_INVALID"],
    ["跨文件短名", 'depends_on: ["[FSD]-other:splitB"]', "FSD_DECLARATION_INVALID"],
    ["含冒号短名", 'depends_on: ["bad:name"]', "FSD_DECLARATION_INVALID"],
    ["非法短名", 'depends_on: ["bad name"]', "FSD_DECLARATION_INVALID"],
    ["非数组", "depends_on: splitB", "FSD_DECLARATION_INVALID"],
    ["非字符串项", "depends_on: [123]", "FSD_DECLARATION_INVALID"],
    ["derives 非数组", 'derives: "[PRD]-demo:req1"', "FSD_DECLARATION_INVALID"],
    ["derives 非字符串", "derives: [null]", "FSD_DECLARATION_INVALID"],
    ["损坏 PRD id", 'derives: ["[PRD]-bad id:req"]', "FSD_DECLARATION_INVALID"],
    ["缺失 PRD", 'derives: ["[PRD]-ghost:req"]', "MISSING_ENDPOINT"],
    ["损坏关系 YAML", 'derives: ["[PRD]-demo:req1"', "FSD_DECLARATION_INVALID"],
  ])("%s 在 create/decompose 的真实入口均零落盘", async (_name, declaration, code) => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    const content = fsdFixture("[FSD]-alpha", { splitA: [declaration!] });
    const beforeCreate = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("fsd", "[FSD]-alpha", {
      content, parent: "[PRD]-demo", skipContext: true,
    }), code!);
    expect(treeSnapshot(root)).toEqual(beforeCreate);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture(), parent: "[PRD]-demo", skipContext: true,
    });
    const beforeDecompose = treeSnapshot(root);
    await expectErrCode(mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      content: fsdFixture("[FSD]-child", { splitA: [declaration!] }), skipContext: true,
    }), code!);
    expect(treeSnapshot(root)).toEqual(beforeDecompose);
  });

  it.each(["derives", "depends_on"] as const)("省略键保留旧边，%s: [] 只清除该类边", async (cleared) => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      parent: "[PRD]-demo", skipContext: true,
      content: fsdFixture("[FSD]-alpha", {
        splitA: ['derives: ["[PRD]-demo:req1"]', "depends_on: [splitB]"],
        splitB: ['derives: ["[PRD]-demo:req2"]', "depends_on: [splitA]"],
      }),
    });
    const siblingBefore = new IndexManager(root).queryVersion(VERSION, "[FSD]-alpha:splitB");
    const file = versionFile(root, "fsd/[FSD]-alpha.md");
    const siblingContent = parseFile(file, root.root).chunks.find((chunk) => chunk.id === "[FSD]-alpha:splitB")?.content;
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture("[FSD]-alpha", {}, ["splitA"]) + "\n更新正文。",
      action: "modify", skipContext: true,
    });
    let view = combinedView(root, VERSION);
    expect(hasEdge(view, "[PRD]-demo:req1", "[FSD]-alpha:splitA", "derives")).toBe(true);
    expect(hasEdge(view, "[FSD]-alpha:splitA", "[FSD]-alpha:splitB", "depends_on")).toBe(true);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture("[FSD]-alpha", { splitA: [cleared + ": []"] }, ["splitA"]),
      action: "modify", skipContext: true,
    });
    view = combinedView(root, VERSION);
    expect(hasEdge(view, "[PRD]-demo:req1", "[FSD]-alpha:splitA", "derives")).toBe(cleared !== "derives");
    expect(hasEdge(view, "[FSD]-alpha:splitA", "[FSD]-alpha:splitB", "depends_on")).toBe(cleared !== "depends_on");
    expect(hasEdge(view, "[PRD]-demo:req2", "[FSD]-alpha:splitB", "derives")).toBe(true);
    expect(hasEdge(view, "[FSD]-alpha:splitB", "[FSD]-alpha:splitA", "depends_on")).toBe(true);
    expect(hasEdge(view, "[PRD]-demo", "[FSD]-alpha", "derives")).toBe(true);
    expect(new IndexManager(root).queryVersion(VERSION, "[FSD]-alpha:splitB")).toEqual(siblingBefore);
    expect(parseFile(file, root.root).chunks.find((chunk) => chunk.id === "[FSD]-alpha:splitB")?.content).toBe(siblingContent);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/^(derives|depends_on):/m);
  });

  it("混合普通键保留；普通 YAML 与外层围栏内的关系示例逐字保留", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    const ordinary = ["\u0060\u0060\u0060yaml", "mode: exact", "nested:", "  depends_on: example-data", "\u0060\u0060\u0060"].join("\n");
    const example = ["\u0060\u0060\u0060\u0060markdown", "\u0060\u0060\u0060yaml", "depends_on: [ghost]", "\u0060\u0060\u0060", "<!-- @ref:[FSD]-ghost -->", "\u0060\u0060\u0060\u0060"].join("\n");
    const content = fsdFixture("[FSD]-alpha", { splitA: [
      'derives: ["[PRD]-demo:req1"]', "depends_on: [splitB]", "mode: strict", "limit: 3",
    ] }) + "\n" + ordinary + "\n" + example;
    await mgr.createDocument("fsd", "[FSD]-alpha", { content, parent: "[PRD]-demo", skipContext: true });
    const stored = fs.readFileSync(versionFile(root, "fsd/[FSD]-alpha.md"), "utf8");
    expect(stored).toContain(ordinary);
    expect(stored).toContain(example);
    expect(stored).toContain("mode: strict");
    expect(stored).toContain("limit: 3");
    expect(stored).not.toContain('derives: ["[PRD]-demo:req1"]');
    expect(stored).not.toContain("depends_on: [splitB]");
    expect(scanContentRelations(stored, "fsd")).toEqual([]);
    expect(() => mgr.confirmLayer("fsd")).not.toThrow();
  });
});

describe("v0.10 持久化故障回滚", () => {
  const cases = (["create-new", "create-modify", "decompose-new", "decompose-modify"] as const)
    .flatMap((operation) => (["graph", "index", "meta"] as const).map((stage) => ({ operation, stage })));
  it.each(cases)("$operation 在 $stage 落盘失败恢复全部原始字节与存在性", async ({ operation, stage }) => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    if (operation !== "create-new") {
      await mgr.createDocument("fsd", "[FSD]-alpha", {
        content: fsdFixture(), parent: "[PRD]-demo", skipContext: true,
      });
    }
    if (operation === "decompose-modify") {
      await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
        content: fsdFixture("[FSD]-child"), skipContext: true,
      });
    }
    const before = treeSnapshot(root);
    const target = path.join(root.meta, stage === "graph" ? "specgraph-" + VERSION + ".yaml"
      : stage === "index" ? "chunks-index-" + VERSION + ".yaml" : "versions/" + VERSION + ".yaml");
    const originalWrite = atomicIo.atomicWriteText;
    let injected = false;
    const spy = vi.spyOn(atomicIo, "atomicWriteText").mockImplementation((file, content) => {
      if (!injected && path.resolve(file) === path.resolve(target)) {
        injected = true;
        throw new Error("injected " + stage + " write failure");
      }
      originalWrite(file, content);
    });
    const modified = operation.endsWith("modify");
    try {
      const request = operation.startsWith("decompose")
        ? mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
          content: fsdFixture("[FSD]-child", { splitA: ["depends_on: [splitB]"] }) + "\n新正文。",
          action: modified ? "modify" : "add", skipContext: true,
        })
        : mgr.createDocument("fsd", "[FSD]-alpha", {
          content: fsdFixture("[FSD]-alpha", { splitA: ["depends_on: [splitB]"] }) + "\n新正文。",
          parent: "[PRD]-demo", action: modified ? "modify" : "add", skipContext: true,
        });
      await expect(request).rejects.toThrow("injected " + stage + " write failure");
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(treeSnapshot(root)).toEqual(before);
  });
});


describe("v0.10 validator 与真实入口", () => {
  it("真实创建的孤立 FSD 根无 TDD 也报孤儿；缺结构父的 TEST 不豁免", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    await mgr.createDocument("fsd", "[FSD]-orphan", { content: fsdFixture("[FSD]-orphan"), skipContext: true });
    const violations = validateInvariants(combinedView(root, VERSION));
    expect(violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ORPHAN_CHUNK", chunkId: "[FSD]-orphan" }),
    ]));
    expect(violations.filter((item) => item.code === "ORPHAN_CHUNK").map((item) => item.chunkId)).not.toContain("[PRD]-demo");
    expect(validateInvariants(makeView(["[FSD]-missing:TEST"], []))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "ORPHAN_CHUNK", chunkId: "[FSD]-missing:TEST" }),
    ]));
  });

  it("需求可映射多个功能 split；第二个根 FSD 在写入前拒绝", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      parent: "[PRD]-demo", skipContext: true,
      content: fsdFixture("[FSD]-alpha", {
        splitA: ['derives: ["[PRD]-demo:req1", "[PRD]-demo:req2"]'],
        splitB: ['derives: ["[PRD]-demo:req1"]'],
      }),
    });
    expect(validateInvariants(combinedView(root, VERSION))).toEqual([]);
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("fsd", "[FSD]-second", {
      content: fsdFixture("[FSD]-second"), parent: "[PRD]-demo", skipContext: true,
    }), "PRD_FSD_LINK_NOT_UNIQUE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("decompose 缺失父端点与同根 TEST 混合子树均拒绝；叶子域 TEST 成功", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      parent: "[PRD]-demo", content: fsdFixture(), skipContext: true,
    });
    const beforeMissing = treeSnapshot(root);
    await expectErrCode(mgr.decompose("[FSD]-alpha:ghost", "[FSD]-leaf", {
      content: fsdFixture("[FSD]-leaf"), skipContext: true,
    }), "MISSING_ENDPOINT");
    expect(treeSnapshot(root)).toEqual(beforeMissing);
    await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-leaf", {
      content: fsdFixture("[FSD]-leaf"), skipContext: true,
    });
    mgr.confirmLayer("fsd");
    const nodes = new Map(combinedView(root, VERSION).nodes);
    nodes.set("[TDD]-root_test", nodeOf("[TDD]-root_test", "tests/root.test.ts"));
    const view = combinedView(root, VERSION);
    const edges = [...view.nodes.keys()].flatMap((id) => view.edgesFrom(id));
    const candidate = new CombinedView(nodes, edges);
    expect(codesOf(checkEdgeWrite(candidate, "[FSD]-alpha:TEST", "[TDD]-root_test", "details")))
      .toContain("FSD_MIXED_CHILDREN");
    const mixed = new CombinedView(nodes, [...edges, {
      src: "[FSD]-alpha:TEST", dst: "[TDD]-root_test", rel: "details", metadata: {},
    }]);
    expect(codesOf(validateInvariants(mixed))).toContain("FSD_MIXED_CHILDREN");
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("tdd", "[TDD]-root_test", {
      content: tddDoc("[TDD]-root_test", "tests/root.test.ts"), parent: "[FSD]-alpha:TEST", skipContext: true,
    }), "FSD_MIXED_CHILDREN");
    expect(treeSnapshot(root)).toEqual(before);
    await mgr.createDocument("tdd", "[TDD]-leaf_test", {
      content: tddDoc("[TDD]-leaf_test", "tests/leaf.test.ts"), parent: "[FSD]-leaf:TEST", skipContext: true,
    });
    expect(hasEdge(combinedView(root, VERSION), "[FSD]-leaf:TEST", "[TDD]-leaf_test", "details")).toBe(true);
    expect(validateInvariants(combinedView(root, VERSION))).toEqual([]);
  });

  it.each(["src/a/../svc.ts", "./src//svc.ts", "src\\svc.ts", "SRC/SVC.TS"])(
    "target_file 别名 %s 与纯校验一致", async (target) => {
      const { root, mgr } = makeProject();
      await advanceToFsdConfirm(mgr);
      await mgr.createDocument("tdd", "[TDD]-owner", {
        content: tddDoc("[TDD]-owner", "src/svc.ts"), parent: "[FSD]-demo:svc", skipContext: true,
      });
      const pure = validateTargetFileUniqueness(makeView([
        ["[TDD]-owner", "src/svc.ts"], ["[TDD]-alias", target],
      ], []));
      const before = treeSnapshot(root);
      const request = mgr.createDocument("tdd", "[TDD]-alias", {
        content: tddDoc("[TDD]-alias", target), parent: "[FSD]-demo:svc", skipContext: true,
      });
      if (target === "SRC/SVC.TS" && process.platform !== "win32") {
        expect(pure).toEqual([]);
        expect((await request).mode).toBe("written");
      } else {
        expect(codesOf(pure)).toContain("DUPLICATE_TARGET_FILE");
        await expectErrCode(request, "DUPLICATE_TARGET_FILE");
        expect(treeSnapshot(root)).toEqual(before);
      }
    },
  );

  it("路径规范化使用显式平台语义：Windows 折叠大小写，POSIX 保留", () => {
    expect(normalizeTargetFile("SRC/a/../SVC.ts", "win32")).toBe("src/svc.ts");
    expect(normalizeTargetFile("SRC/a/../SVC.ts", "linux")).toBe("SRC/SVC.ts");
    expect(normalizeTargetFile("SRC/SVC.ts", "linux")).not.toBe(normalizeTargetFile("src/svc.ts", "linux"));
  });

  it.each(["../escape.ts", "src/../../escape.ts", "/outside.ts", "C:/outside.ts", "C:outside.ts", "\\\\server\\share\\x.ts"])(
    "项目外 target_file %s 在纯校验和真实入口拒绝", async (target) => {
      expectThrowCode(() => normalizeTargetFile(target), "INVALID_TARGET_FILE");
      expect(codesOf(validateTargetFileUniqueness(makeView([["[TDD]-escape", target]], []))))
        .toContain("INVALID_TARGET_FILE");
      const { root, mgr } = makeProject();
      await advanceToFsdConfirm(mgr);
      const before = treeSnapshot(root);
      await expectErrCode(mgr.createDocument("tdd", "[TDD]-escape", {
        content: tddDoc("[TDD]-escape", target), parent: "[FSD]-demo:svc", skipContext: true,
      }), "INVALID_TARGET_FILE");
      expect(treeSnapshot(root)).toEqual(before);
    },
  );

  it.each([
    ["缺用户故事", "#### 验收标准\n1. WHEN 调用 THEN 系统 SHALL 返回结果。"],
    ["缺验收小节", "**用户故事:** 作为开发者，我希望能力可用，以便集成。"],
    ["空壳验收小节", "**用户故事:** 作为开发者，我希望能力可用，以便集成。\n#### 验收标准\n待补充。"],
  ])("PRD %s：纯函数、create 与 confirm 均拒绝且无额外落盘", async (_name, invalid) => {
    expect(codesOf(scanPrdRequirementContract("[PRD]-demo:req1", invalid!)))
      .toContain("PRD_REQUIREMENT_CONTRACT_VIOLATION");
    const { root, mgr } = makeProject();
    const content = PRD_DOC + "\n\n<!-- @id:[PRD]-demo:req1 -->\n## req1\n" + invalid;
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("prd", "[PRD]-demo", { content, skipContext: true }), "PRD_REQUIREMENT_CONTRACT_VIOLATION");
    expect(treeSnapshot(root)).toEqual(before);
    await mgr.createDocument("prd", "[PRD]-demo", { content: PRD_REQUIREMENTS, skipContext: true });
    fs.writeFileSync(versionFile(root, "prd/[PRD]-demo.md"), content);
    const beforeConfirm = treeSnapshot(root);
    expectThrowCode(() => mgr.confirmLayer("prd"), "PRD_REQUIREMENT_CONTRACT_VIOLATION");
    expect(treeSnapshot(root)).toEqual(beforeConfirm);
  });

  it("已冻结 chunk 重写报 CHUNK_LOCKED，受管目录字节不变", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_REQUIREMENTS, action: "modify", skipContext: true,
    }), "CHUNK_LOCKED");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("PRD 层返工后可重新修改原 chunk", async () => {
    const { mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    mgr.revertLayer("prd");
    expect((await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_REQUIREMENTS + "\n新增说明。", action: "modify", skipContext: true,
    })).mode).toBe("written");
  });
});


describe("v0.10 codegen 权威来源", () => {
  it.each([["LF", "\n"], ["CRLF", "\r\n"]])("baseline 正文逐字保留 %s 与末尾空白", (_label, newline) => {
    const root = makeRoot();
    setupCodegenBaseline(root);
    const file = path.join(root.docs, "tdd", "[TDD]-impl.md");
    const source = [...tddDoc("[TDD]-impl", "src/impl.ts").split("\n"), "尾部保留空格。  ", "", ""].join(newline!);
    fs.writeFileSync(file, source, "utf8");
    const before = treeSnapshot(root);
    const bundle = codegenPrepare(root, null, "[TDD]-impl");
    expect(bundle).toMatchObject({ version: null, sourceFile: file });
    expect(bundle.upstream[0]?.content).toBe(fs.readFileSync(file, "utf8"));
    expect(treeSnapshot(root)).toEqual(before);
  });

  it.each(["add", "modify"] as const)("%s TDD 自动/显式活动版本均读取 .md，未确认零副作用", async (action) => {
    const root = makeRoot();
    setupCodegenBaseline(root);
    const active = await createVersionTdd(root, action, false);
    const before = treeSnapshot(root);
    expectThrowCode(() => codegenPrepare(root, null, active.id), "TDD_NOT_CONFIRMED");
    expectThrowCode(() => codegenPrepare(root, VERSION, active.id), "TDD_NOT_CONFIRMED");
    expect(treeSnapshot(root)).toEqual(before);
    active.mgr.confirmLayer("tdd");
    const confirmed = treeSnapshot(root);
    const bundle = codegenPrepare(root, null, active.id);
    expect(bundle).toMatchObject({ version: VERSION, sourceFile: active.file, targetFile: active.target });
    expect(bundle.upstream[0]?.content).toBe(fs.readFileSync(active.file, "utf8"));
    expect(bundle.sourceFile.endsWith(".md.md")).toBe(false);
    expect(codegenPrepare(root, VERSION, active.id)).toEqual(bundle);
    expect(treeSnapshot(root)).toEqual(confirmed);
  });

  const brokenCases = (["add", "modify"] as const).flatMap((action) => [
    { action, damage: "file", code: "CODEGEN_SOURCE_MISSING" },
    { action, damage: "chunk", code: "CODEGEN_CHUNK_MISSING" },
    { action, damage: "parse", code: "CHUNK_PARSE_ERROR" },
  ]);
  it.each(brokenCases)("$action TDD $damage 缺失/损坏报 $code，不回落旧 baseline", async ({ action, damage, code }) => {
    const root = makeRoot();
    setupCodegenBaseline(root);
    const active = await createVersionTdd(root, action);
    if (damage === "file") fs.unlinkSync(active.file);
    else if (damage === "chunk") fs.writeFileSync(active.file, tddDoc("[TDD]-other", "src/other.ts"));
    else fs.writeFileSync(active.file, active.content + "\n" + active.content);
    const before = treeSnapshot(root);
    for (const selected of [null, VERSION]) {
      const error = expectThrowCode(() => codegenPrepare(root, selected, active.id), code);
      if (damage === "parse") {
        expect(error).toMatchObject({ file: "versions/" + VERSION + "/tdd/" + active.id + ".md", line: expect.any(Number) });
        expect((error as { line: number }).line).toBeGreaterThan(1);
      } else {
        expect(error).toMatchObject({ message: expect.stringContaining(active.file) });
      }
    }
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("TEST 的版本 sibling 缺失时也失败；baseline 的旧实现规格不替代它", async () => {
    const root = makeRoot();
    setupCodegenBaseline(root);
    const active = await createVersionTdd(root, "modify");
    fs.unlinkSync(active.file);
    const before = treeSnapshot(root);
    expectThrowCode(() => codegenPrepare(root, null, "[TDD]-acceptance"), "CODEGEN_SOURCE_MISSING");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("递归 FSD 上溯到 PRD，TEST 收集真实 sibling 与实现 TDD，不广播依赖子树", async () => {
    const { root, mgr } = makeProject();
    await advanceToPrdConfirm(mgr);
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture("[FSD]-alpha", { splitA: ["depends_on: [splitB]"] }),
      parent: "[PRD]-demo", skipContext: true,
    });
    await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-middle", {
      content: fsdFixture("[FSD]-middle"), skipContext: true,
    });
    await mgr.decompose("[FSD]-middle:splitA", "[FSD]-leaf", {
      content: fsdFixture("[FSD]-leaf", { splitA: ['derives: ["[PRD]-demo:req1"]', "depends_on: [splitB]"] }),
      skipContext: true,
    });
    await mgr.decompose("[FSD]-alpha:splitB", "[FSD]-unrelated", {
      content: fsdFixture("[FSD]-unrelated"), skipContext: true,
    });
    mgr.confirmLayer("fsd");
    for (const [id, parent, target] of [
      ["[TDD]-leaf", "[FSD]-leaf:splitA", "src/leaf.ts"],
      ["[TDD]-helper", "[FSD]-leaf:splitB", "src/helper.ts"],
      ["[TDD]-tests", "[FSD]-leaf:TEST", "tests/leaf.test.ts"],
      ["[TDD]-unrelated", "[FSD]-unrelated:splitA", "src/unrelated.ts"],
    ]) {
      await mgr.createDocument("tdd", id!, { content: tddDoc(id!, target!), parent: parent!, skipContext: true });
    }
    mgr.confirmLayer("tdd");
    const ordinary = codegenPrepare(root, null, "[TDD]-leaf");
    expect(ordinary.upstream.map((item) => item.id)).toEqual([
      "[TDD]-leaf", "[FSD]-leaf:splitA", "[FSD]-leaf", "[FSD]-middle:splitA",
      "[FSD]-middle", "[FSD]-alpha:splitA", "[FSD]-alpha", "[PRD]-demo:req1", "[PRD]-demo",
    ]);
    expect(ordinary.dependencies.map((item) => item.id)).toEqual(["[FSD]-alpha:splitB", "[FSD]-leaf:splitB"]);
    expect([...ordinary.upstream, ...ordinary.dependencies].map((item) => item.id)).not.toContain("[FSD]-unrelated");
    expect([...ordinary.upstream, ...ordinary.dependencies].map((item) => item.id)).not.toContain("[TDD]-unrelated");
    expect(ordinary.upstream.slice(0,3).map(({ role, selectionReason }) => ({ role, selectionReason }))).toEqual([
      { role: "实现规格", selectionReason: "目标 TDD" },
      { role: "直接开发依据", selectionReason: "[TDD]-leaf 的 details 父" },
      { role: "所属域约束", selectionReason: "[FSD]-leaf:splitA 的 结构 父" },
    ]);
    const acceptance = codegenPrepare(root, null, "[TDD]-tests");
    expect(acceptance.upstream.filter((item) => item.role === "相关实现参考").map((item) => item.id))
      .toEqual(["[FSD]-leaf:splitA", "[FSD]-leaf:splitB", "[TDD]-leaf", "[TDD]-helper"]);
    expect(acceptance.upstream.find((item) => item.id === "[FSD]-leaf:splitA")).toMatchObject({
      role: "相关实现参考", selectionReason: ":TEST split [FSD]-leaf:TEST 的同父功能 sibling",
    });
    expect(acceptance.upstream.find((item) => item.id === "[TDD]-leaf")).toMatchObject({
      role: "相关实现参考", selectionReason: "功能 sibling [FSD]-leaf:splitA 的实现 TDD",
    });
    expect(acceptance.upstream.find((item) => item.id === "[PRD]-demo:req1")).toMatchObject({
      role: "产品意图", selectionReason: "[FSD]-leaf:splitA 的 derives 对端",
    });
    expect(codegenPrepare(root, VERSION, "[TDD]-leaf")).toEqual(ordinary);
    expect(codegenPrepare(root, VERSION, "[TDD]-tests")).toEqual(acceptance);
  });

  it("TDD 返工清空生成凭证和确认计划，重新确认后旧 token 仍失效", async () => {
    const root = makeRoot();
    setupCodegenBaseline(root);
    const active = await createVersionTdd(root, "modify");
    fs.mkdirSync(path.join(root.cwd, "src"));
    fs.writeFileSync(path.join(root.cwd, active.target), "export const generated = true;\n");
    const delivery = prepareDelivery(root, { tddRoot: active.id });
    tmpDirs.push(path.dirname(delivery.bundle_path));
    expect(() => registerGenerationReceipt(root, { generation_token: delivery.generation_token })).not.toThrow();
    const metaFile = path.join(root.meta, "versions", VERSION + ".yaml");
    const meta = loadModel(metaFile, VersionMetaSchema);
    expect(meta.generation?.deliveries).toHaveLength(1);
    saveModel(metaFile, { ...meta, confirmed_plan: { operations: [], input_fingerprint: "a".repeat(64), conflict_policy: "abort" } });
    active.mgr.revertLayer("tdd");
    expect(loadModel(metaFile, VersionMetaSchema)).toMatchObject({ generation: null, confirmed_plan: null, phase: "tdd-creating" });
    await active.mgr.createDocument("tdd", active.id, {
      content: active.content + "\n返工后的实现约束。", action: "modify", skipContext: true,
    });
    active.mgr.confirmLayer("tdd");
    const before = treeSnapshot(root);
    expectThrowCode(() => registerGenerationReceipt(root, { generation_token: delivery.generation_token }), "GENERATION_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });
});


describe("持久化形态", () => {
  it.each(["prd", "fsd", "tdd"] as const)("%s 层 receipt、schema、冻结变更记录及返工复位", async (layer) => {
    const { root, mgr } = makeProject();
    if (layer !== "prd") await advanceToPrdConfirm(mgr);
    if (layer === "tdd") {
      await mgr.createDocument("fsd", "[FSD]-alpha", {
        content: fsdFixture("[FSD]-alpha", { splitA: ['derives: ["[PRD]-demo:req1"]', "depends_on: [splitB]"] }),
        parent: "[PRD]-demo", skipContext: true,
      });
      mgr.confirmLayer("fsd");
    }
    const id = layer === "prd" ? "[PRD]-demo" : layer === "fsd" ? "[FSD]-alpha" : "[TDD]-impl";
    const parent = layer === "fsd" ? { parent: "[PRD]-demo" } : layer === "tdd" ? { parent: "[FSD]-alpha:splitA" } : {};
    const content = layer === "prd" ? PRD_REQUIREMENTS : layer === "fsd"
      ? fsdFixture("[FSD]-alpha", { splitA: ['derives: ["[PRD]-demo:req1"]', "depends_on: [splitB]"] })
      : tddDoc(id, "src/impl.ts");
    const beforeDiscussion = treeSnapshot(root);
    const token = tokenOf(await mgr.createDocument(layer, id, parent));
    expect(treeSnapshot(root)).toEqual(beforeDiscussion);
    await mgr.createDocument(layer, id, { ...parent, content, contextToken: token });
    const indexFile = path.join(root.meta, "chunks-index-" + VERSION + ".yaml");
    const graphFile = path.join(root.meta, "specgraph-" + VERSION + ".yaml");
    const metaFile = path.join(root.meta, "versions", VERSION + ".yaml");
    const readShape = () => {
      const rawIndex = loadYaml(indexFile) as { chunks: Record<string, unknown>[] };
      const index = VersionIndexSchema.parse(rawIndex);
      const rawGraph = loadYaml(graphFile) as { specs: unknown[]; edges: Record<string, unknown>[] };
      const graph = SpecGraphSchema.parse(rawGraph);
      expect(Array.isArray(rawGraph.specs)).toBe(true);
      for (const entry of rawIndex.chunks) {
        expect(entry).toHaveProperty("level");
        expect(entry).toHaveProperty("metadata");
        expect(entry).toHaveProperty("base_hash", null);
        expect(entry).not.toHaveProperty("hash");
        expect(entry).not.toHaveProperty("content_hash");
      }
      for (const edge of rawGraph.edges) {
        expect(edge).toHaveProperty("weight", 1);
        expect(["new-model-cli", "fsd-declaration"]).toContain((edge.metadata as { source: string }).source);
      }
      expect(graph.specs.every((spec) => !spec.file.endsWith(".md"))).toBe(true);
      return index;
    };
    const indexBefore = readShape();
    const entries = indexBefore.chunks.filter((entry) => entry.id.startsWith("[" + layer.toUpperCase() + "]-"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        state: "working", commit_id: null, base_hash: null,
        discussion_usage: { mode: "receipt", receipt_digest: "sha256:" + token.slice("ctx-v1.".length) },
      });
    }
    const changesBefore = loadModel(metaFile, VersionMetaSchema).changes;
    const confirmed = mgr.confirmLayer(layer);
    expect(confirmed.confirmed.sort()).toEqual(entries.map((entry) => entry.id).sort());
    const indexAfter = readShape();
    const commitIds = new Set(indexAfter.chunks.filter((entry) => confirmed.confirmed.includes(entry.id)).map((entry) => {
      expect(entry.state).toBe("committed");
      expect(entry.commit_id).toMatch(/^c\d+$/);
      return entry.commit_id;
    }));
    expect(commitIds.size).toBe(1);
    expect(indexAfter.commits.at(-1)?.chunks.sort()).toEqual(confirmed.confirmed.sort());
    const meta = loadModel(metaFile, VersionMetaSchema);
    const addedChanges = meta.changes.slice(changesBefore.length);
    expect(addedChanges).toHaveLength(entries.length);
    expect(meta.changes.slice(0, changesBefore.length)).toEqual(changesBefore);
    expect(fs.readdirSync(path.join(root.meta, "changes")).sort()).toEqual(meta.changes.map((change) => change + ".yaml").sort());
    for (const change of addedChanges) {
      expect(change).toMatch(/^chg-\d+$/);
      const record = loadModel(path.join(root.meta, "changes", change + ".yaml"), ChangeRecordSchema);
      expect(record).toMatchObject({ id: change, version: VERSION, discussion_usage: entries[0]!.discussion_usage });
      expect(record.new_content).toContain("<!-- @id:");
    }
    expect(mgr.revertLayer(layer)).toMatchObject({ phase: layer + "-creating", reverted: expect.arrayContaining(entries.map((entry) => entry.id)) });
    const reverted = readShape();
    for (const entry of reverted.chunks.filter((item) => confirmed.confirmed.includes(item.id))) {
      expect(entry).toMatchObject({ state: "working", commit_id: null });
    }
  });

  it("skip-context 的最小审计痕迹写入版本索引", async () => {
    const { root, mgr } = makeProject();
    await mgr.createDocument("prd", "[PRD]-demo", { content: PRD_REQUIREMENTS, skipContext: true });
    const index = loadModel(path.join(root.meta, "chunks-index-" + VERSION + ".yaml"), VersionIndexSchema);
    expect(index.chunks.length).toBe(3);
    for (const entry of index.chunks) expect(entry.discussion_usage).toEqual({ mode: "skipped", receipt_digest: null });
  });
});

// ---------------------------------------------------------------------------
// v0.12 正式写入：真实 manager 入口的文档位置、提交完整性与讨论意图
// ---------------------------------------------------------------------------

type WriteLayer = "prd" | "fsd" | "tdd";
type WriteOperation = WriteLayer | "decompose";
type WriteOptions = Parameters<NewModelManager["createDocument"]>[2];
const WRITE_OPERATIONS = ["prd", "fsd", "tdd", "decompose"] as const;

/** 经实际上层 create/confirm 到达写入相位，供四种入口复用同一断言矩阵。 */
async function formalWriteFixture(operation: WriteOperation) {
  const { root, mgr } = makeProject();
  const layer: WriteLayer = operation === "decompose" ? "fsd" : operation;
  if (operation === "fsd" || operation === "decompose") await advanceToPrdConfirm(mgr);
  if (operation === "tdd") await advanceToFsdConfirm(mgr);
  if (operation === "decompose") {
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture(), parent: "[PRD]-demo", skipContext: true,
    });
  }
  const id = operation === "prd" ? "[PRD]-demo" : operation === "fsd" ? "[FSD]-alpha"
    : operation === "tdd" ? "[TDD]-impl" : "[FSD]-child";
  const parent = operation === "fsd" ? "[PRD]-demo" : operation === "tdd" ? "[FSD]-demo:svc"
    : operation === "decompose" ? "[FSD]-alpha:splitA" : undefined;
  const content = layer === "prd" ? PRD_REQUIREMENTS : layer === "fsd" ? fsdFixture(id)
    : tddDoc(id, "src/impl.ts");
  const request = (options: WriteOptions) => operation === "decompose"
    ? mgr.decompose(parent!, id, options)
    : mgr.createDocument(layer, id, { ...(parent === undefined ? {} : { parent }), ...options });
  return { root, mgr, layer, id, parent, content, request };
}

describe("v0.12 显式文档路径", () => {
  const forms = [
    { label: "name", input: "document", relative: "document.md" },
    { label: "kind/name", input: "{kind}/document", relative: "document.md" },
    { label: "name.md", input: "document.md", relative: "document.md" },
    { label: "kind/name.md", input: "{kind}/document.md", relative: "document.md" },
    { label: "安全子目录", input: "design/details/document", relative: "design/details/document.md" },
    { label: "带层目录的子目录", input: "{kind}/design/details/document.md", relative: "design/details/document.md" },
    { label: "Unicode 与空格", input: "设计 目录/文档 名称", relative: "设计 目录/文档 名称.md" },
    { label: "带层目录的 Unicode 与空格", input: "{kind}/设计 目录/文档 名称.md", relative: "设计 目录/文档 名称.md" },
  ];
  const cases = WRITE_OPERATIONS.flatMap((operation) => forms.map((form) => ({ operation, ...form })));

  it.each(cases)("$operation 的 $label 正确落盘、等价 file 复用令牌并可确认读取", async ({ operation, input, relative }) => {
    const fixture = await formalWriteFixture(operation);
    const { root, mgr, layer, id, content, request } = fixture;
    const file = input.replace("{kind}", layer);
    const canonicalFile = layer + "/" + relative;
    const beforeDiscussion = treeSnapshot(root);
    const context = await request({ file });
    const canonicalContext = await request({ file: canonicalFile });
    expect(tokenOf(context)).toBe(tokenOf(canonicalContext));
    expect(await request({ file })).toEqual(context);
    expect(treeSnapshot(root)).toEqual(beforeDiscussion);

    const result = await request({ file, content, contextToken: tokenOf(canonicalContext) });
    expect(result).toMatchObject({ mode: "written", file: canonicalFile, phase: layer + "-creating" });
    const physicalFile = versionFile(root, canonicalFile);
    expect(fs.existsSync(physicalFile)).toBe(true);
    const parsed = parseFile(physicalFile, root.root);
    expect(parsed.chunks.map((chunk) => chunk.id)).toContain(id);
    expect(new IndexManager(root).queryVersion(VERSION, id)).toMatchObject({
      file: canonicalFile.slice(0, -3), state: "working",
    });
    expect(combinedView(root, VERSION).nodes.get(id)?.file).toBe(canonicalFile.slice(0, -3));
    const physicalDocuments = Object.keys(treeSnapshot(root))
      .filter((name) => name.startsWith("versions/" + VERSION + "/") && !name.endsWith("/"));
    expect(physicalDocuments).toContain("versions/" + VERSION + "/" + canonicalFile);
    expect(physicalDocuments.every((name) => name.endsWith(".md"))).toBe(true);
    expect(physicalDocuments.some((name) => name.startsWith("versions/" + VERSION + "/" + layer + "/" + layer + "/"))).toBe(false);
    expect(fs.existsSync(versionFile(root, canonicalFile.slice(0, -3)))).toBe(false);
    expect(fs.existsSync(physicalFile + ".md")).toBe(false);

    const stored = fs.readFileSync(physicalFile, "utf8");
    expect(mgr.confirmLayer(layer)).toMatchObject({
      phase: layer + "-confirm", confirmed: expect.arrayContaining([id]),
    });
    expect(fs.readFileSync(physicalFile, "utf8")).toBe(stored);
    expect(new IndexManager(root).queryVersion(VERSION, id)?.state).toBe("committed");
    if (layer === "tdd") {
      const bundle = codegenPrepare(root, VERSION, id);
      expect(bundle).toMatchObject({ version: VERSION, sourceFile: physicalFile, targetFile: "src/impl.ts" });
      expect(bundle.upstream[0]?.content).toBe(stored);
    }
  });

  const invalidForms = [
    { label: "空串", file: "" },
    { label: "仅空白", file: " \t " },
    { label: "绝对路径", file: "/absolute.md" },
    { label: "Windows 根路径", file: "\\absolute.md" },
    { label: "驱动器绝对路径", file: "C:/absolute.md" },
    { label: "驱动器相对路径", file: "C:relative.md" },
    { label: "冒号", file: "bad:name.md" },
    { label: "UNC", file: "\\\\server\\share\\document.md" },
    { label: "正斜杠 UNC", file: "//server/share/document.md" },
    { label: "NUL", file: "bad\0name.md" },
    { label: "当前目录名", file: "." },
    { label: "父目录名", file: ".." },
    { label: "起始点段", file: "./document.md" },
    { label: "内部点段", file: "sub/./document.md" },
    { label: "内部父目录段", file: "sub/../document.md" },
    { label: "起始父目录段", file: "../document.md" },
    { label: "跨 kind", file: "{other}/document.md" },
    { label: "空路径段", file: "sub//document.md" },
    { label: "层后的空段", file: "{kind}//document.md" },
    { label: "末尾空段", file: "sub/" },
  ];
  const invalidCases = WRITE_OPERATIONS.flatMap((operation) => invalidForms.map((form) => ({ operation, ...form })));

  it.each(invalidCases)("$operation 的 $label 在讨论和写入均 INVALID_FILE_NAME 且整树不变", async ({ operation, file }) => {
    const { root, layer, content, request } = await formalWriteFixture(operation);
    const invalidFile = file.replace("{kind}", layer).replace("{other}", layer === "prd" ? "fsd" : "prd");
    const before = treeSnapshot(root);
    await expectErrCode(request({ file: invalidFile }), "INVALID_FILE_NAME");
    expect(treeSnapshot(root)).toEqual(before);
    await expectErrCode(request({ file: invalidFile, content, skipContext: true }), "INVALID_FILE_NAME");
    expect(treeSnapshot(root)).toEqual(before);
  });
});

type MissingChunkOperation = WriteOperation | "split";

/** baseline 与版本均可含目标，提交必须自行携带目标，不能由合成阶段补足。 */
async function missingChunkFixture(operation: MissingChunkOperation, baseline: boolean) {
  const { root, mgr } = makeProject();
  if (baseline) {
    writeDocs(root, {
      "prd/[PRD]-demo.md": PRD_REQUIREMENTS.split("\n"),
      "fsd/[FSD]-alpha.md": fsdFixture().split("\n"),
      "fsd/[FSD]-child.md": fsdFixture("[FSD]-child").split("\n"),
      "tdd/[TDD]-impl.md": tddDoc("[TDD]-impl", "src/impl.ts").split("\n"),
    });
    syncBaseline(root);
    baselineEdges(root, [
      ["[PRD]-demo", "[FSD]-alpha", "derives"],
      ["[FSD]-alpha:splitA", "[FSD]-child", "decomposes"],
      ["[FSD]-child:splitA", "[TDD]-impl", "details"],
    ]);
  }
  if (operation !== "prd") await advanceToPrdConfirm(mgr);
  if (operation === "split" || operation === "decompose" || operation === "tdd") {
    await mgr.createDocument("fsd", "[FSD]-alpha", {
      content: fsdFixture(), parent: "[PRD]-demo", skipContext: true,
    });
  }
  if (operation === "tdd") {
    await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      content: fsdFixture("[FSD]-child"), action: baseline ? "modify" : "add", skipContext: true,
    });
    mgr.confirmLayer("fsd");
  }
  const layer: WriteLayer = operation === "prd" || operation === "tdd" ? operation : "fsd";
  const id = operation === "prd" ? "[PRD]-demo" : operation === "fsd" ? "[FSD]-alpha"
    : operation === "tdd" ? "[TDD]-impl" : operation === "split" ? "[FSD]-alpha:splitA" : "[FSD]-child";
  const parent = operation === "fsd" ? { parent: "[PRD]-demo" }
    : operation === "tdd" ? { parent: "[FSD]-child:splitA" } : {};
  const request = (options: WriteOptions) => operation === "decompose"
    ? mgr.decompose("[FSD]-alpha:splitA", id, options)
    : mgr.createDocument(layer, id, { ...parent, ...options });
  const otherContent = operation === "prd" ? PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-other")
    : operation === "tdd" ? tddDoc("[TDD]-other", "src/other.ts")
      : operation === "split" ? fsdFixture("[FSD]-alpha", {}, ["splitB"])
        : fsdFixture("[FSD]-other");
  return { root, id, request, otherContent };
}

describe("v0.12 提交必须包含请求 chunk", () => {
  const operations: MissingChunkOperation[] = ["prd", "fsd", "tdd", "split", "decompose"];
  const cases = operations.flatMap((operation) => [false, true].flatMap((baseline) =>
    ["空正文", "仅空白", "仅其它合法 chunk"].map((body) => ({ operation, baseline, body }))));

  it.each(cases)("$operation baseline=$baseline：$body 报 ROOT_CHUNK_REQUIRED，undefined 仍只取背景", async ({ operation, baseline, body }) => {
    const { root, id, request, otherContent } = await missingChunkFixture(operation, baseline);
    if (baseline) expect(new IndexManager(root).queryBaseline(id)).not.toBeNull();
    const before = treeSnapshot(root);
    const context = await request({});
    expect(context.mode).toBe("discussion-context");
    expect(await request({})).toEqual(context);
    expect(treeSnapshot(root)).toEqual(before);
    const content = body === "空正文" ? "" : body === "仅空白" ? " \n\t\n" : otherContent;
    await expectErrCode(request({ content, contextToken: tokenOf(context) }), "ROOT_CHUNK_REQUIRED");
    expect(treeSnapshot(root)).toEqual(before);
    await expectErrCode(request({ content, skipContext: true }), "ROOT_CHUNK_REQUIRED");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("split 提交只需包含请求 split，省略根仍能写入并保留其它 chunk", async () => {
    const { root, mgr } = await formalWriteFixture("decompose");
    const id = "[FSD]-alpha:splitA";
    const file = versionFile(root, "fsd/[FSD]-alpha.md");
    const before = parseFile(file, root.root);
    const content = ["<!-- @id:" + id + " -->", "## 更新 splitA", "只提交请求 split 的新正文。"].join("\n");
    const contextToken = tokenOf(await mgr.createDocument("fsd", id, { action: "modify" }));
    expect((await mgr.createDocument("fsd", id, { action: "modify", content, contextToken })).mode).toBe("written");
    const after = parseFile(file, root.root);
    expect(after.chunks.map((chunk) => chunk.id)).toEqual(before.chunks.map((chunk) => chunk.id));
    expect(after.chunks.find((chunk) => chunk.id === id)?.content).toBe(content);
    for (const chunk of before.chunks.filter((item) => item.id !== id)) {
      expect(after.chunks.find((item) => item.id === chunk.id)?.content).toBe(chunk.content);
    }
    expect(mgr.confirmLayer("fsd").phase).toBe("fsd-confirm");
  });
});

/** 根改名的合法基线：两个既有子 FSD 分别由同根的两个 split 拆分。 */
async function decomposeOverrideFixture() {
  const { root, mgr } = makeProject();
  writeDocs(root, {
    "prd/[PRD]-demo.md": PRD_REQUIREMENTS.split("\n"),
    "fsd/[FSD]-alpha.md": fsdFixture().split("\n"),
    "fsd/[FSD]-old_child.md": fsdFixture("[FSD]-old_child", {}, []).split("\n"),
    "fsd/[FSD]-other_child.md": fsdFixture("[FSD]-other_child", {}, []).split("\n"),
  });
  syncBaseline(root);
  baselineEdges(root, [
    ["[PRD]-demo", "[FSD]-alpha", "derives"],
    ["[FSD]-alpha:splitA", "[FSD]-old_child", "decomposes"],
    ["[FSD]-alpha:splitB", "[FSD]-other_child", "decomposes"],
  ]);
  await advanceToPrdConfirm(mgr);
  await mgr.createDocument("fsd", "[FSD]-alpha", {
    content: fsdFixture(), parent: "[PRD]-demo", action: "modify", skipContext: true,
  });
  return { root, mgr };
}

describe("v0.12 完整讨论意图", () => {
  it.each(WRITE_OPERATIONS)("%s 的 A 文件令牌不能写入 B 文件，整树不变", async (operation) => {
    const { root, content, request } = await formalWriteFixture(operation);
    const contextToken = tokenOf(await request({ file: "first.md" }));
    const before = treeSnapshot(root);
    await expectErrCode(request({ file: "second.md", content, contextToken }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
    expect(tokenOf(await request({ file: "second.md" }))).not.toBe(contextToken);
  });

  it.each(WRITE_OPERATIONS)("%s 改变有效 action 时旧令牌失效", async (operation) => {
    const { root, content, request } = await formalWriteFixture(operation);
    const contextToken = tokenOf(await request({ action: "add" }));
    const before = treeSnapshot(root);
    await expectErrCode(request({ action: "modify", content, contextToken }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it.each([false, true])("默认 action 与基线推导的有效值一致且令牌确定（baseline=%s）", async (baseline) => {
    const { root, mgr } = makeProject();
    if (baseline) {
      writeDocs(root, { "prd/[PRD]-demo.md": PRD_REQUIREMENTS.split("\n") });
      syncBaseline(root);
    }
    const before = treeSnapshot(root);
    const implicit = await mgr.createDocument("prd", "[PRD]-demo", {});
    const explicit = await mgr.createDocument("prd", "[PRD]-demo", { action: baseline ? "modify" : "add" });
    expect(tokenOf(implicit)).toBe(tokenOf(explicit));
    expect(await mgr.createDocument("prd", "[PRD]-demo", {})).toEqual(implicit);
    expect(treeSnapshot(root)).toEqual(before);
    expect((await mgr.createDocument("prd", "[PRD]-demo", {
      content: PRD_REQUIREMENTS, action: baseline ? "modify" : "add", contextToken: tokenOf(implicit),
    })).mode).toBe("written");
  });

  it("create 改变 overrides 拒绝，即使两份被替换根均真实存在", async () => {
    const { root, mgr } = makeProject();
    writeDocs(root, {
      "prd/[PRD]-old.md": PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-old").split("\n"),
      "prd/[PRD]-other.md": PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-other").split("\n"),
    });
    syncBaseline(root);
    const contextToken = tokenOf(await mgr.createDocument("prd", "[PRD]-demo", {
      action: "modify", overrides: "[PRD]-old",
    }));
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("prd", "[PRD]-demo", {
      action: "modify", overrides: "[PRD]-other", content: PRD_DOC, contextToken,
    }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("decompose 改变 overrides 拒绝且整树不变", async () => {
    const { root, mgr } = await decomposeOverrideFixture();
    const contextToken = tokenOf(await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      action: "modify", file: "design/child.md", overrides: "[FSD]-old_child",
    }));
    const before = treeSnapshot(root);
    await expectErrCode(mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      action: "modify", file: "design/child.md", overrides: "[FSD]-other_child",
      content: fsdFixture("[FSD]-child"), contextToken,
    }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it.each(["create-to-decompose", "decompose-to-create"] as const)("%s 只改变 operation 也必须重取令牌", async (direction) => {
    const { root, mgr, id, parent, content } = await formalWriteFixture("decompose");
    const options = { parent: parent!, file: "child.md", action: "add" as const };
    const create = (extra: WriteOptions) => mgr.createDocument("fsd", id, { ...options, ...extra });
    const decompose = (extra: WriteOptions) => mgr.decompose(parent!, id, { ...options, ...extra });
    const [discuss, write] = direction === "create-to-decompose" ? [create, decompose] : [decompose, create];
    const contextToken = tokenOf(await discuss!({}));
    const before = treeSnapshot(root);
    await expectErrCode(write!({ content, contextToken }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("改变 parent 或请求 id 拒绝，正文始终包含实际请求 id", async () => {
    const { root, mgr } = makeProject();
    await mgr.createDocument("prd", "[PRD]-demo", { content: PRD_REQUIREMENTS, skipContext: true });
    await mgr.createDocument("prd", "[PRD]-other", {
      content: PRD_DOC.replaceAll("[PRD]-demo", "[PRD]-other"), skipContext: true,
    });
    mgr.confirmLayer("prd");
    const contextToken = tokenOf(await mgr.createDocument("fsd", "[FSD]-alpha", { parent: "[PRD]-demo" }));
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("fsd", "[FSD]-alpha", {
      parent: "[PRD]-other", content: fsdFixture(), contextToken,
    }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
    await expectErrCode(mgr.createDocument("fsd", "[FSD]-other", {
      parent: "[PRD]-demo", content: fsdFixture("[FSD]-other"), contextToken,
    }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("同意图的既有目标正文变化使背景令牌失效", async () => {
    const { root, mgr } = makeProject();
    await mgr.createDocument("prd", "[PRD]-demo", { content: PRD_DOC, skipContext: true });
    const contextToken = tokenOf(await mgr.createDocument("prd", "[PRD]-demo", { action: "modify" }));
    await mgr.createDocument("prd", "[PRD]-demo", {
      action: "modify", content: PRD_DOC + "\n背景已经更新。", skipContext: true,
    });
    const before = treeSnapshot(root);
    await expectErrCode(mgr.createDocument("prd", "[PRD]-demo", {
      action: "modify", content: PRD_DOC + "\n继续修改。", contextToken,
    }), "CONTEXT_TOKEN_STALE");
    expect(treeSnapshot(root)).toEqual(before);
  });

  it("decompose 自定义 file/overrides/action 的同意图讨论与写入成功，并可冻结读取", async () => {
    const { root, mgr } = await decomposeOverrideFixture();
    const options = { action: "modify" as const, overrides: "[FSD]-old_child", file: "fsd/设计 目录/新 子域" };
    const before = treeSnapshot(root);
    const context = await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", options);
    const equivalent = await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      ...options, file: "设计 目录/新 子域.md",
    });
    expect(tokenOf(equivalent)).toBe(tokenOf(context));
    expect(treeSnapshot(root)).toEqual(before);
    const result = await mgr.decompose("[FSD]-alpha:splitA", "[FSD]-child", {
      ...options, file: "设计 目录/新 子域.md", content: fsdFixture("[FSD]-child"), contextToken: tokenOf(context),
    });
    expect(result).toMatchObject({
      mode: "written", file: "fsd/设计 目录/新 子域.md",
      src: "[FSD]-alpha:splitA", dst: "[FSD]-child", rel: "decomposes",
    });
    expect(new IndexManager(root).queryVersion(VERSION, "[FSD]-child")).toMatchObject({
      file: "fsd/设计 目录/新 子域", overrides: "[FSD]-old_child", action: "modify",
      discussion_usage: { mode: "receipt", receipt_digest: "sha256:" + tokenOf(context).slice("ctx-v1.".length) },
    });
    expect(hasEdge(combinedView(root, VERSION), "[FSD]-alpha:splitA", "[FSD]-child", "decomposes")).toBe(true);
    expect(mgr.confirmLayer("fsd")).toMatchObject({ phase: "fsd-confirm", confirmed: expect.arrayContaining(["[FSD]-child"]) });
    expect(parseFile(versionFile(root, "fsd/设计 目录/新 子域.md"), root.root).chunks.map((chunk) => chunk.id))
      .toEqual(["[FSD]-child", "[FSD]-child:splitA", "[FSD]-child:splitB", "[FSD]-child:TEST"]);
  });
});
