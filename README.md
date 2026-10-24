# ait-core

ait-core 是以 TypeScript 实现的 Node 机制核心，提供 chunk 级规格版本控制与实现编排。PRD、FSD、TDD 是规格文档；TDD 的 `target_file` 指向生成制品，可以是源码、测试或其他文件。主线为：

```text
PRD → FSD（可递归分解）→ TDD（一文件一映射）→ 上下文交付 → 宿主生成制品
```

core 提供库与 `ait` CLI；CLI 直接适配同一公共 Node API。ait-pi、ait-skill 是独立的宿主胶水，负责模型调用、工具接入和实际拦截；core 不调用 LLM、不创建 agent、不生成内容。

本文适用于 **0.2.0** 公共接口。完整参数、默认值、返回值、错误和流程示例见：

- [Node API 参考](docs/node-api.md)：`createCoreApi` 分组接口、内存交付和宿主接入。
- [CLI 参考](docs/cli.md)：命令行参数、文件交付和纯 CLI 回执闭环。

## 构建、安装与升级

需要 **Node.js >=22** 和 npm；版本确认、合入等 Git 操作还需要 Git。开发期优先从本地 tarball 安装。源码目录中的完整检查与打包顺序是：

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack
```

完整测试依赖构建产物，`npm test` 的 `pretest` 会先构建；`npm pack` 的 `prepack` 也会构建。构建失败时不能用陈旧产物作为验收依据。以 `npm pack` 输出的实际 `.tgz` 文件名为准，下面路径需替换成该文件的绝对路径。

在使用者的项目根安装：

```sh
npm install "/absolute/path/to/ait-core-0.2.0.tgz"
npm ls ait-core --depth=0
npm exec -- ait --version
```

安装同时提供 ESM 库、TypeScript 声明、`ait` bin 和两份参考文档；运行不依赖 Python。升级时在同一项目安装新打包文件，再核验包版本：

```sh
npm install "/absolute/path/to/ait-core-new-version.tgz"
npm ls ait-core --depth=0
```

安装验收须使用真实 tarball，并分别验证 Node API 与纯 CLI 各自完成规格写入、交付、实际制品生成、回执、验收、确认和合入；混合入口流程不能替代这两项检查。上述命令是检查方法，不表示已执行本次全量验收、真实 Python 项目接管或 LLM 生成验证，也不表示已发布到 registry。

在尚未纳管的项目中初始化：

```sh
npm exec -- ait init --name demo
npm exec -- ait init --check
```

之后从包含 `project-docs/` 的项目根运行命令，不要进入 `project-docs/` 运行。也可使用初始化生成的项目本地 wrapper：POSIX 为 `./project-docs/.ait/ait-cli`，Windows 为 `.\project-docs\.ait\ait-cli.cmd`。已有项目无需重复初始化；需要更新 wrapper 时使用 `npm exec -- ait init --refresh-wrapper`。初始化不会自动创建活动版本；无活动版本时不带版本参数的 `state` 返回 `NO_VERSION`。

## 公共 Node 接口

只从包根 `ait-core` 导入。包根运行时仅导出以下两个函数，公共类型随包提供：

| 接口 | 用途 |
| --- | --- |
| `createCoreApi(options?)` | 创建分组 client，提供项目、版本、规格、图、检索、状态、交付、回执、验收和治理能力。 |
| `dispatch(argv, options?)` | 命令行适配入口，返回 `Promise<CliDispatchResult>`；Node 集成直接调用 client 方法。 |

公开类型包括 `CoreApi`、`CoreApiOptions`、`ApiResult<T>`、`CoreProgressEvent`、`MemoryDelivery`、`DeliveryPointer`、`GenerationReceipt` 及各方法的输入和读模型。内部模块不属于公开接口。

`createCoreApi()` 绑定**创建时的 `process.cwd()`**，后续不随 `process.chdir()` 改变目标。请在宿主项目根创建 client，无需拼装内部项目路径；不接受 `cwd` 或 `root` 选项。导入和创建 client 不执行文件读写，项目解析延迟到实际调用，因此空目录可调用 `core.project.init()`。`dispatch` 每次调用使用当时的当前目录。

业务输入使用单个对象和 camelCase 字段，无参数方法可直接调用。除同步纯函数 `core.guard.evaluate(...)` 外，方法均返回 `Promise<ApiResult<T>>`。成功为 `{ok:true,data}`，失败为 `{ok:false,code,error}`；先检查 `ok` 再取数据。工厂的非法选项同步抛出 `USAGE_ERROR`，方法的非法输入返回错误信封。

以下 ESM 示例可放在 `.mjs` 文件或 `"type": "module"` 的项目中。调用前应位于已初始化的项目根，目标 TDD 已确认。`generateAndTest` 由宿主提供：接收完整正文，限制生成器只能写入 `targetFile`，生成并完成制品测试后才返回，失败时拒绝 Promise。

```js
import { createHash } from "node:crypto";
import path from "node:path";
import { createCoreApi } from "ait-core";

function unwrap(result) {
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  return result.data;
}

export async function generateFromSpec(tddRootId, generateAndTest) {
  const core = createCoreApi();
  const session = unwrap(await core.session.get());
  const delivery = unwrap(await core.delivery.prepare({ tddRootId }));
  // 默认 output: "memory"，content 已是完整正文，不读 bundle 文件。
  if (delivery.target_state === "unreadable") {
    throw new Error("目标文件不可读，处理后重新准备交付");
  }
  const bytes = Buffer.from(delivery.content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== delivery.bytes || sha256 !== delivery.sha256) {
    throw new Error("生成上下文的字节数或 SHA-256 不匹配");
  }

  const targetFile = path.resolve(session.project_root, delivery.target_file);
  const guard = unwrap(core.guard.evaluate({
    toolName: "write",
    input: { path: targetFile },
  }));
  if (guard.decision === "block") throw new Error(guard.reason ?? "写入被阻止");

  await generateAndTest({ bundle: delivery.content, targetFile, session });
  const receipt = unwrap(await core.generation.registerReceipt({
    generationToken: delivery.generation_token,
  }));
  const verification = delivery.version === null
    ? null
    : unwrap(await core.generation.verifyReceipts({ version: delivery.version }));
  return { receipt, verification };
}
```

`prepare` 默认选活动版本，无活动版本时交付基线（`version:null`）。内存交付不创建 bundle 中间文件，但会登记交付元数据并签发 `generation_token`，不是只读调用。`target_state` 区分 `loaded/absent/unreadable`；宿主完整接收 `content` 后再启动生成器，不用摘要代替正文。

文件模式 `core.delivery.prepare({tddRootId,output:"file"})` 与内存模式共用正文和门禁，返回仓外 `bundle_path` 指针。CLI 固定使用文件模式。同一 TDD 再次交付会使旧令牌和回执失效；调用方应保留完整交付与令牌，丢失后重新 prepare。令牌签发已包含在 prepare 内，不提供独立公共签发接口。

API 和 CLI 只返回事实，没有 `next_action`、`next_call` 或 `required_next_call`；`session.text` 也不包含接续指令。宿主决定讨论、生成、测试及确认的顺序，core 继续执行相位、令牌、图和合入门禁。

可选 `createCoreApi({onProgress(event) { /* 展示实际阶段 */ }})` 报告操作、阶段和状态；耗时操作不阻塞宿主事件循环。进度回调只用于展示，不从回调重入写 API。同一项目的 AIT 写操作仍须串行完成。API 与 CLI 均不支持取消，不接受 `signal`、`AbortSignal` 或 `cancel`；外部终止不承诺撤销既有副作用。

## 规格到制品的流程

以下是纯 CLI 命令模板：`ait` 指已安装的 bin，本地安装可用 `npm exec -- ait` 或项目 wrapper 替代。示例使用独立于初始化根的新功能根 `[PRD]-feature`、`[FSD]-feature`，FSD 草稿需包含叶 split `[FSD]-feature:implementation`。版本号、ID、草稿路径和令牌须替换为实际值。每次无正文 `create` 返回讨论背景和 `context_token`，先据此讨论并准备草稿，再携带**同一意图**的令牌写入。可直接运行的完整示例见 [CLI 参考](docs/cli.md)。

```sh
ait version create v0.1

ait prd create "[PRD]-feature"
ait prd create "[PRD]-feature" --content-file "/absolute/path/to/prd.md" --context-token "PRD_CONTEXT_TOKEN"
ait prd confirm

ait fsd create "[FSD]-feature" --parent "[PRD]-feature"
ait fsd create "[FSD]-feature" --parent "[PRD]-feature" --content-file "/absolute/path/to/fsd.md" --context-token "FSD_CONTEXT_TOKEN"
ait fsd confirm

ait tdd create "[TDD]-feature" --parent "[FSD]-feature:implementation"
ait tdd create "[TDD]-feature" --parent "[FSD]-feature:implementation" --content-file "/absolute/path/to/tdd.md" --context-token "TDD_CONTEXT_TOKEN"
ait tdd confirm

ait codegen prepare "[TDD]-feature" --version v0.1
# 核对 bundle_path 文件的 bytes 和 sha256，完整读取正文。
# 调用方按规格生成唯一 target_file 并测试，保留本次 generation_token。
ait codegen receipt --generation-token "GENERATION_TOKEN"
ait codegen verify --version v0.1

ait acceptance set "npm test"
ait acceptance run
ait version confirm v0.1
ait version merge v0.1
```

`codegen prepare` 返回文件指针和令牌，不在 stdout 展开正文；目标状态在 bundle 中。`codegen receipt` 由 core 读取实际制品并计算 hash，调用方不能提交自填的 `artifact_sha256`。`codegen verify` 要求版本参数，不提供基线核验模式。流程无需 Node 回执桥接或手写元数据。

`npm test` 仅适用于该脚本确实完成制品验收的项目；请配置实际可用的验收命令。未配置时返回 `ran:false`，跳过不能作为业务正确性证明。上面每一步都应检查结果后再继续，回执核验还须检查 `enforcement/passed/findings`。Node 和 CLI prepare 共用交付规则；重复调用须使用新的交付和令牌。

需要递归分解时使用 `fsd decompose`；PRD 需求正文须带用户故事和编号验收标准，FSD 维护合法派生关系，TDD 须声明唯一 `target_file`。`--content-file` 与 `--content` 互斥；背景或意图改变后需重新取令牌。

返工使用对应的 `prd revert`、`fsd revert` 或 `tdd revert`，随后重新取背景、写入并逐层确认。整版撤销使用 `ait version revert <version> --confirm`；未合入版本会清理工作区，已合入版本涉及双仓回滚。不要直接修改受 AIT 管理的规格或索引来绕过流程。

`version confirm` 校验并持久化确认计划、绑定制品提交，宿主 Git 仓有未提交变更时会主动提交；`version merge` 才提升规格基线。确认后判定输入发生变化会使计划过期，需要重新确认。仅完成规格文档周期不能替代包含实际制品、回执和验收的完整自举。

## 结果与错误处理

除 `baseline-summary` 成功时的展示外，CLI stdout 为单个 JSON 信封，进度写入 stderr，退出码仅随外层 `ok` 为 `0/1`。`baseline-summary` 始终返回摘要，默认输出 YAML 序列，`--format json` 输出 `{ok:true,data:items}`；Node 对应方法返回 `{scope,items}`，统计另用 `core.search.baselineStats()`。

外层成功不等于业务检查通过：验收需检查 `ran/passed`，`init --check` 需检查 `data.ok`，图验证需检查 `passed` 及 `policy_violations`，回执需检查策略及发现，推送需检查 `host.status/docs.status`。Node 示例返回的 `verification` 也必须据此处理。

错误信封的 `code` 用于分支，`error` 保留定位信息。未知参数报 `USAGE_ERROR`；令牌过期或规格改变时重新取得背景/交付；`CONFIG_UNREADABLE`、`INDEX_UNREADABLE` 等读取失败不能当作空项目；一般未预期异常为 `INTERNAL_ERROR`。失败后先用状态、图或回执查询核对事实。`confirm`、`sync`、`reindex` 均有副作用，不能作为只读刷新或盲目重试手段。

## 回执与治理边界

共享配置位于 `project-docs/.meta/config.yaml`；机器本地覆盖位于 `project-docs/.meta/config.local.yaml`。回执策略配置示例：

```yaml
generation_receipts:
  enforcement: report
```

默认 `report` 会报告缺失、过期或字节不匹配等发现，不仅因回执问题阻断版本确认；需要门禁时设为 `block`，有此类发现就不能通过。`report` 下有发现也可能 `passed:true`。纯文档版本没有制品变更时不要求生成回执。配置存在但损坏会报告 `CONFIG_UNREADABLE`，不会静默放宽策略。

回执关联最新交付、当前规格与制品 SHA-256；重新交付、规格变化或登记后再次修改制品，都可能使回执失效。它证明字节关联，不认证 agent 身份，也不保证业务语义正确；业务正确性仍需制品验收。

`core.guard.evaluate(...)` 是同步纯判定函数。宿主须在每次真实工具执行前调用它，并实际执行 `block` 决定；示例只展示一次目标写入检查。受保护路径包括 `project-docs/docs/`、`project-docs/versions/`、`project-docs/.meta/`，应经 AIT 正式接口修改。守卫不会限制普通源码只能由指定生成器写入，宿主仍须单独限制生成任务的目标范围。

具备工具拦截能力且落实判定的宿主渠道可提供准强制治理；没有拦截接口时，守卫只具建议性。两种情况下，core 自身的写时校验、确认和合入门禁仍生效。纯函数不能监控所有文件系统写入、解析任意脚本或防止恶意绕过，治理强度需按实际宿主能力说明。

## 兼容方向与版本号

0.2.0 是开发期的一次性公共接口迁移，不保留以下五个旧函数的包根兼容导出：

| 已移除出口 | 替代方式 |
| --- | --- |
| `getSessionContext(root)` | `await core.session.get()` |
| `evaluateWriteGuard(input)` | `core.guard.evaluate({toolName,input})` |
| `issueGenerationToken(root,delivery)` | `core.delivery.prepare(...)` 内部完成签发 |
| `registerGenerationReceipt(root,{generation_token})` | `await core.generation.registerReceipt({generationToken})` |
| `verifyGenerationReceipts(root,version)` | `await core.generation.verifyReceipts({version})` |

消费者须移除 `ProjectRoot` 拼装和 `NextAction` 等旧建议类型/字段，改用结果信封与异步方法，不通过深层导入继续调用内部实现。图方向统一为 `in/out/both`，不再接受 `from/to`；`specgraph query` 支持四种关系开关与 `--version`，默认读活动版本叠加基线。`baseline-summary` 的旧统计消费者迁移到 `core.search.baselineStats()`。详细差异见两份参考文档。

兼容方向是 **ait-core 接管 Python 版 AIT 管理的历史项目**。不承诺 Python 版能读取 Node 扩展数据，也不承诺两版写出的文件字节一致。

`package.json` 的 `version` 标识所安装的 npm 包，可用 `npm ls ait-core --depth=0` 核验。`ait --version` 表示当前项目文档版本：读取 `project-docs/.meta/versions/` 中按数值比较最大的版本号；没有版本记录或不在项目根时返回 `unversioned`。两者分别服务于工具升级和项目迭代，不应混用。
