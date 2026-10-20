# ait-core

ait-core 是以 TypeScript 实现的 Node 机制核心，提供 chunk 级规格版本控制与实现编排。PRD、FSD、TDD 是规格文档；TDD 的 `target_file` 指向生成制品，可以是源码、测试或其他文件。主线为：

```text
PRD → FSD（可递归分解）→ TDD（一文件一映射）→ 上下文交付 → 宿主生成制品
```

core 提供库与 `ait` CLI，共用同一套命令实现。ait-pi、ait-skill 是独立的宿主胶水，负责模型调用、工具接入和实际拦截；core 不调用 LLM、不创建 agent、不生成内容。本说明面向安装者和宿主开发者，具体能力与文件设计以项目规格为准。

`state` 与 `delivery` 是独立功能域。`state` 负责状态读模型、渲染及 `state.md` 保存；CLI 负责参数解析、命令路由与输出；`delivery` 负责公开入口、包分发、宿主无关使用和标准对接契约。功能职责不按源码所在目录划分。

当前公开 Node 接口与 CLI 均已有入口；生成回执登记目前仅提供 Node 函数 `registerGenerationReceipt`，尚无对应 CLI 命令。现有安装流程测试采用 CLI 与 Node 混合入口，不能据此宣称纯 CLI 独立闭环已通过。CLI 回执接续、完整标准对接文档，以及 Node 导入和 CLI 两种模式各自独立的完整流程验收仍待补齐；本 README 提供当前基础使用说明。

## 构建、安装与升级

需要 **Node.js >=22** 和 npm。源码目录中的完整检查与打包顺序是：

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack
```

完整测试包含依赖构建产物的检查，必须先完成 `build`；`npm pack` 的 `prepack` 脚本也会执行构建。以 `npm pack` 输出的实际 `.tgz` 文件名为准，下面路径均需替换成该文件的绝对路径。

在使用者的项目根安装：

```sh
npm install "/absolute/path/to/ait-core-x.y.z.tgz"
npm ls ait-core --depth=0
npm exec -- ait --version
```

安装同时提供 ESM 库、TypeScript 声明和 `ait` bin；运行不依赖 Python。升级时在同一项目安装新打包文件，再核验包版本：

```sh
npm install "/absolute/path/to/ait-core-new-version.tgz"
npm ls ait-core --depth=0
```

本地验收使用真实的打包与安装流程，不能用 `npm link` 代替。上述命令是交付检查方法，不代表已经执行验收或发布到公共 registry。

在尚未纳管的项目中初始化：

```sh
npm exec -- ait init --name demo
npm exec -- ait state
```

之后从包含 `project-docs/` 的项目根运行命令。也可使用初始化生成的项目本地 wrapper：POSIX 为 `./project-docs/.ait/ait-cli`，Windows 为 `.\project-docs\.ait\ait-cli.cmd`。已有项目无需重复初始化；需要更新 wrapper 时使用 `npm exec -- ait init --refresh-wrapper`。

## 公共 Node 接口

只从包根 `ait-core` 导入。公开函数如下，相关参数和返回类型随包提供：

| 接口 | 用途 |
| --- | --- |
| `dispatch(argv)` | 执行与 CLI 相同的命令，返回 `Promise<CoreResult>`。 |
| `getSessionContext(root)` | 读取项目、活动版本、phase、各层三态计数及统一的流程文本。 |
| `evaluateWriteGuard(input)` | 返回 `{ decision: "allow" \| "block", reason }`，由宿主执行判定。 |
| `issueGenerationToken(root, delivery)` | 校验已有的完整仓外交付文件并签发生成令牌；标准 `codegen prepare` 已完成此步骤。 |
| `registerGenerationReceipt(root, { generation_token })` | 在宿主写入制品后，登记交付、规格与实际制品字节的关联。 |
| `verifyGenerationReceipts(root, version)` | 返回 `{ enforcement, passed, findings }`，供宿主报告或门禁使用。 |

公开类型包括 `CoreResult`、`NextAction`、`ProjectRoot`、`SessionContext`、`LayerCounts`、`GuardInput`、`GuardDecision`、`GenerationDeliveryInput`、`GenerationReceipt` 和 `GenerationVerification`。包内部模块不属于公开接口。

`dispatch(argv)` 使用**进程当前工作目录**定位项目，直接库调用可避免 CLI 子进程，但当前接口没有项目根参数。请在调用前确定 cwd，并在整个操作期间保持不变；同一进程中不能通过并发 `process.chdir()` 来操作多个项目。`ProjectRoot` 参数只用于接受它的命名函数，不会改变 `dispatch` 的 cwd。

以下 ESM 示例可放在 `.mjs` 文件或 `"type": "module"` 的项目中。调用前应位于已初始化的项目根，目标 TDD 已按流程确认。`generateTarget` 是宿主提供的异步函数：它必须完整读取 bundle、遵循其中规格并把制品写入 `targetFile` 后返回；目标状态为 `unreadable` 时应先解决读取问题并重新准备上下文。

```js
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  dispatch,
  getSessionContext,
  evaluateWriteGuard,
  registerGenerationReceipt,
  verifyGenerationReceipts,
} from "ait-core";

export async function generateFromSpec(tddRoot, generateTarget) {
  const cwd = path.resolve(process.cwd());
  const docsRoot = path.join(cwd, "project-docs");
  /** @type {import("ait-core").ProjectRoot} */
  const root = {
    cwd,
    root: docsRoot,
    docs: path.join(docsRoot, "docs"),
    meta: path.join(docsRoot, ".meta"),
  };

  const session = getSessionContext(root);
  const result = await dispatch(["codegen", "prepare", tddRoot]);
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  const delivery = result.data;

  // bundle_path 指向仓外临时文件；对原始字节核验，随后完整解码。
  const bytes = await readFile(delivery.bundle_path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== delivery.bytes || sha256 !== delivery.sha256) {
    throw new Error("生成上下文的字节数或 SHA-256 不匹配");
  }

  const targetFile = path.resolve(root.cwd, delivery.target_file);
  const guard = evaluateWriteGuard({
    projectRoot: root.cwd,
    cwd: root.cwd,
    toolName: "write",
    input: { path: targetFile },
  });
  if (guard.decision === "block") throw new Error(guard.reason);

  await generateTarget({ bundle: bytes.toString("utf8"), targetFile, session });
  const receipt = registerGenerationReceipt(root, {
    generation_token: delivery.generation_token,
  });
  const verification = delivery.version === null
    ? null
    : verifyGenerationReceipts(root, delivery.version);
  return { receipt, verification };
}
```

`ProjectRoot` 的四个字段都是绝对路径：`cwd` 是宿主项目根，`root` 是其 `project-docs/`，`docs` 和 `meta` 分别指向其中的 `docs/` 与 `.meta/`。宿主可把 `session.text` 提供给会话，并根据 `next_action` 处理接续建议。

只有实现自定义交付流程时，才需要单独 `import { issueGenerationToken } from "ait-core"`。其 `GenerationDeliveryInput` 字段为 `version`（可为 `null`）、`tdd_root`、`target_file`、`bundle_path`、`bundle_sha256` 和 `bytes`；其中哈希字段名是 `bundle_sha256`，标准交付指针中的字段名是 `sha256`。签发要求实际仓外文件及完整规格匹配。标准流程直接使用 `codegen prepare` 返回的 `generation_token`；同一 TDD 再次交付会使旧令牌失效。

`dispatch` 成功返回 `{ ok: true, data }`，失败返回 `{ ok: false, error, code }`，不会退出调用者进程。CLI 输出同一 JSON 信封，退出码随 `ok` 为 0 或 1。校验类命令可能返回 `ok: true` 但 `data.passed: false`，宿主必须继续检查 `passed` 和 `violations`。成功结果的 `data.next_action` 为 `present_and_collect`、`report`、`continue` 之一或 `null`；建议本身不执行下一步。

命名函数直接返回各自的结果，不包裹 `CoreResult`。宿主应使用 `try/catch` 处理异常；领域错误带有 `code`，例如 `GENERATION_TOKEN_STALE`、`GENERATION_SPEC_CHANGED`、`GENERATION_ARTIFACT_CHANGED` 或 `CONFIG_UNREADABLE`，同时保留一般异常的 `message`。

## 规格到制品的流程

以下是命令模板：`ait` 指已安装的 bin，本地安装可用 `npm exec -- ait` 或项目 wrapper 替代。示例假设项目以 `init --name demo` 初始化；版本号、chunk ID、草稿绝对路径和令牌需要替换成当前项目的实际值。每次无正文 `create` 返回讨论背景和 `context_token`，先据此讨论并准备草稿，再携带**同一意图**的令牌写入。

```sh
ait version create v0.1

ait prd create "[PRD]-demo:feature"
ait prd create "[PRD]-demo:feature" --content-file "/absolute/path/to/prd.md" --context-token "PRD_CONTEXT_TOKEN"
ait prd confirm

ait fsd create "[FSD]-demo:feature" --parent "[PRD]-demo:feature"
ait fsd create "[FSD]-demo:feature" --parent "[PRD]-demo:feature" --content-file "/absolute/path/to/fsd.md" --context-token "FSD_CONTEXT_TOKEN"
ait fsd confirm

ait tdd create "[TDD]-feature" --parent "[FSD]-demo:feature"
ait tdd create "[TDD]-feature" --parent "[FSD]-demo:feature" --content-file "/absolute/path/to/tdd.md" --context-token "TDD_CONTEXT_TOKEN"
ait tdd confirm

ait codegen prepare "[TDD]-feature"
# 宿主读取并核验 bundle，生成唯一 target_file。
# 完成写入后，经 Node 接口 registerGenerationReceipt 登记本次令牌。

ait acceptance set "npm test"
ait acceptance run
ait version confirm v0.1
ait version merge v0.1
```

`npm test` 仅适用于该脚本确实完成制品验收的项目；请为自己的项目配置实际可用的验收命令。未配置时验收会跳过，跳过不能作为业务正确性证明。上面每一步都应检查返回结果后再继续。CLI 的 `codegen prepare` 与 ESM 示例是同一入口的两种调用方式；若重新调用，必须使用新交付及新令牌登记回执。

根 FSD 名称来自项目：示例根为 `[FSD]-demo`，ait-core 自身项目使用 `[FSD]-ait-core`，不能把后者硬编码为所有项目的根。需要递归分解时使用既有 `fsd decompose`；PRD 需求正文须带用户故事和编号验收标准，TDD 须声明唯一 `target_file`。`--content-file` 与 `--content` 互斥；背景或意图改变后需重新取令牌。

返工使用对应的 `prd revert`、`fsd revert` 或 `tdd revert`，随后重新取背景、写入并逐层确认。整版撤销使用 `ait version revert <version> --confirm`；未合入版本会清理工作区，已合入版本涉及双仓回滚。不要直接修改受 AIT 管理的规格或索引来绕过流程。

`version confirm` 校验并持久化确认计划、绑定制品提交，宿主 Git 仓有未提交变更时会主动提交；`version merge` 才提升规格基线。确认后判定输入发生变化会使计划过期，需要重新确认。仅完成规格文档周期不能替代包含实际制品、回执和验收的完整自举。

## 回执与治理边界

共享配置位于 `project-docs/.meta/config.yaml`；机器本地覆盖位于 `project-docs/.meta/config.local.yaml`。回执策略配置示例：

```yaml
generation_receipts:
  enforcement: report
```

默认 `report` 会报告缺失、过期或字节不匹配等发现，不仅因回执问题阻断版本确认；需要门禁时设为 `block`，有此类发现就不能通过。纯文档版本没有制品变更时不要求生成回执。配置存在但损坏会报告 `CONFIG_UNREADABLE`，不会静默放宽策略。

回执关联最新交付、当前规格与制品 SHA-256；重新交付、规格变化或登记后再次修改制品，都可能使回执失效。它证明字节关联，不认证 agent 身份，也不保证业务语义正确；业务正确性仍需制品验收。

`evaluateWriteGuard` 是纯判定函数。宿主须在工具执行前调用它，并实际执行 `block` 决定；示例只展示一次目标写入的检查，宿主还应将其接入实际写入、编辑和 shell 工具。受保护路径包括 `project-docs/docs/`、`project-docs/versions/`、`project-docs/.meta/`，应经 AIT 正式接口修改。

具备工具拦截能力且落实判定的宿主渠道可提供准强制治理；没有拦截接口时，守卫只具建议性。两种情况下，core 自身的写时校验、确认和合入门禁仍生效。纯函数不能监控所有文件系统写入、解析任意脚本或防止恶意绕过，治理强度需按实际宿主能力说明。

## 兼容方向与版本号

兼容方向是 **ait-core 接管 Python 版 AIT 管理的历史项目**。不承诺 Python 版能读取 Node 扩展数据，也不承诺两版写出的文件字节一致。

`package.json` 的 `version` 标识所安装的 npm 包，可用 `npm ls ait-core --depth=0` 核验。`ait --version` 表示当前项目文档版本：读取 `project-docs/.meta/versions/` 中按数值比较最大的版本号；没有版本记录或不在项目根时返回 `unversioned`。两者分别服务于工具升级和项目迭代，不应混用。
