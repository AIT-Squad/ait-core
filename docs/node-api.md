# Node API 参考

`ait-core` 为 Node.js 22 及以上环境提供 ESM API。集成代码从包根导入 `createCoreApi`，通过 `CoreApi` 的 47 个分组方法读写项目；类型也从包根导入。本文适用于 0.3.1。

```ts
import { createCoreApi } from "ait-core";
import type { ApiResult, CoreApi, CoreProgressEvent } from "ait-core";

const core: CoreApi = createCoreApi();
const result = await core.session.get();
if (result.ok) {
  console.log(result.data.active_version, result.data.phase);
} else {
  console.error(result.code, result.error);
}
```

包根另有用于命令行适配的 `dispatch`，不需要通过它调用 Node 业务能力。内部模块、项目路径结构对象和令牌签发函数不属于公共接口。命令行参数及输出见 [CLI 参考](cli.md)。

## 创建 client 与结果约定

### `createCoreApi(options?: CoreApiOptions): CoreApi`

`options` 可省略，唯一可选字段为 `onProgress?: (event: CoreProgressEvent) => void`。不接受 `cwd`、`root`、`signal` 或其他选项；工厂参数非法时同步抛出带 `code: "USAGE_ERROR"` 的错误。

client 绑定创建时的 `process.cwd()`，调用方应在宿主项目根目录创建它。项目规格位于该目录下的 `project-docs`；无需自行构造内部路径。包根导入和创建 client 均不执行文件读写、不初始化项目。项目结构在需要它的调用中才解析，因此未初始化的目录仍可调用 `project.init()` 或 `project.init({ check: true })`。client 后续不会随外部 `process.chdir()` 改变目标，也不会自行切换进程目录。

除同步纯函数 `guard.evaluate` 外，所有分组方法返回 `Promise<ApiResult<T>>`。下文用 `R<T>` 表示这一类型：

```ts
type ApiResult<T extends object> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string };

type R<T extends object> = Promise<ApiResult<T>>;
```

输入统一为一个对象，使用 camelCase；无参数方法直接调用即可，不要求传 `{}`。输出保留各业务已有字段名，例如 `context_token`、`target_file`、`exitCode`。调用方应省略不需要的可选字段；不传 `null` 代替缺省值。运行时仍验证字段、枚举和类型，未知字段会返回 `USAGE_ERROR`，不会被静默忽略。公开方法将业务错误转为错误信封；一般未预期异常转换为 `INTERNAL_ERROR` 并保留错误消息。

`ok: true` 表示调用正常完成，业务检查仍可能失败：

| 调用 | 仍须检查的业务字段 |
| --- | --- |
| `project.init({ check: true })` | `data.ok` 与 `data.missing` |
| `acceptance.run()` | `data.ran`、`data.passed`、`data.exitCode` |
| `graph.validateNewModel()` | `data.passed` 仅表示图不变式通过；另看 `policy_violations`、`warnings` |
| `generation.verifyReceipts(...)` | `data.passed`、`data.enforcement`、`data.findings`；`report` 策略可带发现通过 |
| `publish.push(...)` | `data.host.status` 与 `data.docs.status`；单仓可能为 `failed` |

例如 `{ ok: true, data: { ran: true, passed: false, exitCode: 1 } }` 表示验收命令已运行但未通过。不要仅凭外层 `ok` 进入合入步骤。

结果只包含业务事实，不含 `next_action`、`next_call` 或 `required_next_call`。讨论、生成、测试、用户交互和调用顺序由宿主安排；相位、关系、上下文令牌、回执和合入门禁仍由 core 执行。

### 阶段进度与并发边界

```ts
import { createCoreApi } from "ait-core";

const core = createCoreApi({
  onProgress(event) {
    console.error(event.operationId, event.operation, event.stage, event.status);
  },
});
const result = await core.acceptance.run();
```

| `CoreProgressEvent` 字段 | 类型与含义 |
| --- | --- |
| `operationId` | `string`，本次调用的运行标识，不是持久化 AIT 状态 |
| `operation` | `string`，公共方法路径，例如 `version.confirm` |
| `stage` | `"read" \| "validate" \| "assemble" \| "write_bundle" \| "register_delivery" \| "acceptance" \| "git" \| "persist"` |
| `status` | `"started" \| "completed" \| "failed"` |

I/O、扫描、验收和 Git 操作在内部 worker 中执行，宿主事件循环可以继续处理事件。独立验收与版本确认内的验收采用同一隔离执行边界。进度只报告实际阶段，不承诺每次调用出现所有阶段，也不提供百分比或后续操作建议。同一次调用的事件按顺序送达，最终结果信封才是调用结论。库不会自行向宿主 stdout 打印进度或业务输出；示例中的输出由调用方选择。

回调用于展示，其异常不触发业务重试或回滚；不得从回调重入写 API。同一项目采用单写者模型，应 `await` 完成本次写入后再发起下一次。不要依赖 Promise 或多个 client 实现跨进程并发修改；多次只读调用也不构成原子快照。

API 不提供 `signal`、`AbortSignal`、`cancel`、取消状态或取消错误码。外部终止进程属于中断恢复，不承诺撤销已经产生的文件、Git 或验收副作用。

## 公共输入

以下表格中的 `?` 表示可选；其他字段必需。`string` 标识符通常须为非空字符串。版本名不得含路径分隔符、空字符或为 `.`、`..`。

| 类型 | 字段与默认值 |
| --- | --- |
| `InitInput` | `name?: string`，缺省从当前目录名归一生成项目名称；`check?: boolean = false`；`refreshWrapper?: boolean = false`。`check` 优先于刷新和初始化 |
| `CloneInput` | `docsUrl: string`；`hostUrl?: string`；`branch?: string`，代码仓分支；`docsBranch?: string`，文档仓分支。地址支持严格的 HTTPS/SSH URL、SCP 形式、完整 file URL 或绝对本地路径；不接受相对路径、畸形 URL 或内嵌凭据 |
| `SetRepositoriesInput` | `hostUrl: string`；`docsUrl: string`；`hostBranch?: string`；`docsBranch?: string`。完整替换共享仓库配置，不做部分更新 |
| `VersionInput` | `version: string`，无默认版本 |
| `OptionalVersionInput` | `version?: string`，具体默认读视图见各方法 |
| `VersionRevertInput` | `version: string`；`confirm?: boolean = false`，实际回滚必须显式为 `true` |
| `DeliveryPrepareInput` | `tddRootId: string`；`version?: string`，默认活动版本、无活动版本时基线；`output?: "memory" \| "file" = "memory"` |
| `GraphQueryInput` | `target: string`；`direction?: "in" \| "out" \| "both" = "both"`；`rels?: EdgeRel[]`，缺省不过滤；`version?: string`，默认活动版本、无活动版本时基线 |
| `GraphImpactInput` | `target: string`，chunk ID |
| `SearchInput` | `query: string`；`scope?: "baseline" \| "all" = "baseline"`；`regexp?: boolean = false` |
| `BaselineSummaryInput` | `scope?: "prd" \| "fsd" \| "tdd"`，省略表示全部基线条目；不接受 `"all"` 或 `format` 字段 |
| `StateSaveInput` | `version?: string`，默认活动版本；`format?: "markdown" \| "json" = "markdown"`，决定返回格式 |
| `AcceptanceSetInput` | `command: string`，完整 shell 命令，无默认值 |
| `PushInput` | `dryRun?: boolean = false` |
| `GenerationReceiptInput` | `generationToken: string`，由本次 `delivery.prepare` 返回 |
| `GenerationStatusInput` | `version: string`；`tddRootId?: string`，缺省为该版本全部生成候选 |
| `GuardEvaluateInput` | `toolName: string`；`input: unknown`，实际工具参数，字段本身必需 |

### 文档输入与讨论令牌

```ts
interface DocumentInput {
  id: string;
  parent?: string;
  content?: string;
  action?: "add" | "modify";
  overrides?: string;
  contextToken?: string;
  skipContext?: boolean;
  file?: string;
}

type PrdInput = Omit<DocumentInput, "parent">;
type DecomposeInput = Omit<DocumentInput, "id" | "parent"> & {
  parentSplit: string;
  childRootId: string;
};
```

| 字段 | 用途、默认值与限制 |
| --- | --- |
| `id` | 必需，根或 split 的 chunk ID，例如 `[TDD]-feature` |
| `parent` | 按当前新增/修改场景确定是否必需；FSD 可指定 PRD 根，TDD 指定 FSD 叶 split。PRD 不接受该字段 |
| `content` | 省略时只读讨论背景；提供字符串时为写入请求。空字符串仍走写入校验，不等价于讨论 |
| `action` | 缺省时，ID 已在基线则为 `modify`，否则为 `add`；显式值不绕过已有 chunk 或修改目标检查 |
| `overrides` | 可选，被替换的基线根 ID，用于根重命名；不支持借此重命名 split |
| `contextToken` | 写入时提交相同意图的讨论结果 `context_token`；绑定版本、层、ID、父级、有效 action、归一文件路径、overrides 与操作类型 |
| `skipContext` | 缺省 `false`；显式 `true` 可跳过讨论令牌检查并留下 `audit`，与 `contextToken` 互斥，不跳过内容或相位门禁 |
| `file` | 可选，文档在当前层内的路径；缺省为根 ID 对应的 `.md`。接受带或不带层前缀、带或不带 `.md` 的兼容写法，统一归一；拒绝绝对路径、跨层或越界路径 |
| `parentSplit` | `fsd.decompose` 必需，待分解的 FSD split |
| `childRootId` | `fsd.decompose` 必需，新子 FSD 根 ID；该输入没有 `id` 和 `parent` 字段 |

先不传 `content` 取得背景，宿主读取完整 `background` 并形成草稿，再用相同写入意图和 `contextToken` 提交。背景或意图变化后需要重新取得上下文；令牌不是登录凭据，也不证明操作者身份或已经阅读正文。文档正文必须满足对应层的内容契约：PRD 需求含用户故事和验收标准，TDD 声明唯一 `target_file`，FSD 关系声明须合法。`contentFile` 不属于 Node 输入；宿主可以自行读取草稿文件并传入正文。

## 方法参考

每个方法均适用前述参数校验与公共项目/存储错误。表中的错误是用于分支处理的常见错误，并非穷举底层 I/O 故障。副作用为“只读”的方法不会自动重建索引、同步图或修复状态。

### 项目与版本：14 个方法

| 方法签名 | 默认行为与结果 | 副作用与常见错误 |
| --- | --- | --- |
| `core.project.documentVersion(): R<DocumentVersionResult>` | 返回 `{ version: string }`，取最大数值文档版本号；无记录或无法按项目根读取时回退 `"unversioned"`。这不是 npm 包版本 | 只读；回退语义不能用于判断项目健康 |
| `core.project.init(input?: InitInput): R<InitResponse>` | 普通初始化返回 `InitResult`；`check: true` 返回 `{ ok, missing }`；`refreshWrapper: true` 刷新本平台 wrapper | 初始化项目骨架、基线、文档 Git 仓和 wrapper，宿主为 Git 仓时维护忽略项；检查分支只读。常见 `WRAPPER_PATH_UNRESOLVED`；文件/Git 故障保留错误 |
| `core.project.clone(input: CloneInput): R<CloneResult>` | 在 client 绑定的空目录中先克隆文档仓，再按共享配置恢复代码仓；返回目录、是否续跑、两仓原始 origin URL/分支/提交、wrapper 路径及警告 | 写两套 Git 工作区、恢复记录、忽略项和 wrapper，并执行项目检查。常见 `CLONE_DIRECTORY_NOT_EMPTY`、`CLONE_REPOSITORY_MISMATCH`、`CLONE_PATH_CONFLICT`、`CLONE_GIT_FAILED`、`CLONE_BRANCH_NOT_FOUND`、`CLONE_STATE_INVALID`、`CLONE_PROJECT_INVALID` |
| `core.project.getRepositories(): R<RepositoriesResult>` | 读取 `project-docs/.meta/repositories.yaml`，返回 `{ path, repositories }`；配置包含 `schema_version: 1`、`host` 与固定 `path: "project-docs"` 的 `docs` | 只读；不存在报 `REPOSITORIES_NOT_FOUND`，损坏、路径链接或非法地址/分支报 `REPOSITORIES_INVALID` |
| `core.project.setRepositories(input: SetRepositoriesInput): R<RepositoriesResult>` | 校验后原子写入完整共享仓库配置并返回同形结果；分支字段省略即不记录 | 写 `project-docs/.meta/repositories.yaml`；不验证远端存在或切换当前分支。路径或内容非法报 `REPOSITORIES_INVALID` |
| `core.version.create(input: VersionInput): R<VersionCreateResult>` | 返回 `{ version, created_at, based_on }`；`based_on` 为最后一个已合入版本或 `null` | 创建工作区、版本元数据和空索引。已有活动版本报 `ACTIVE_VERSION_EXISTS`，多活动版本报 `ACTIVE_VERSION_CONFLICT`，重复版本报 `USAGE_ERROR` |
| `core.version.commit(input: VersionInput): R<VersionCommitResult>` | 返回 `{ committed: string[], changes: string[] }`；提交 working/staged chunk，无 `message` 输入 | 写变更记录、版本索引/图和元数据；不等同宿主 Git 提交。无可提交项报 `COMMIT_EMPTY`，版本不存在报 `VERSION_NOT_FOUND` |
| `core.version.status(input: VersionInput): R<VersionStatus>` | 返回版本、相位、working/staged/committed ID 与 `by_action` 计数 | 只读；`VERSION_NOT_FOUND`、索引/元数据损坏 |
| `core.version.confirm(input: VersionInput): R<VersionConfirmResult>` | 校验规格、关系、治理和回执，执行验收并再次校验，生成确认计划和指纹；不接受 `conflictPolicy` | 写本版本确认元数据，可能提交宿主变更并记录 `code_result`。常见 `INVARIANT_VIOLATION`、`SPEC_CONTENT_MISMATCH`、`GENERATION_RECEIPTS_FAILED`、`ACCEPTANCE_FAILED`、`GIT_FAILED`；不是只读预检 |
| `core.version.merge(input: VersionInput): R<VersionMergeResult>` | 执行时重新校验已保存计划、当前指纹和回执，再合入基线 | 写基线及相关索引/图/元数据、文档仓提交和标签。缺计划报 `CONFIRMATION_REQUIRED`，计划过期报 `CONFIRMATION_STALE`；另可能 `GENERATION_RECEIPTS_FAILED`、`INVARIANT_VIOLATION`、`MERGE_ROLLBACK` |
| `core.version.revert(input: VersionRevertInput): R<VersionRevertResult>` | `confirm` 默认 `false` 并拒绝执行；`true` 时撤销未合入版本，或恢复到已合入版本的锚点 | 可能移除版本工作区与后续版本、重置文档/宿主 Git 状态，失败时按恢复记录补偿。常见 `USAGE_ERROR`、`REVERT_PRECHECK_FAILED`、`REVERT_FAILED`、`GIT_FAILED`；历史无宿主绑定时不回滚宿主 |
| `core.version.backfillTags(): R<BackfillTagsResult>` | 为可验证的历史文档提交补齐缺失锚点标签；返回补齐与跳过列表 | 写 Git 标签，已存在项跳过；检查 `git` 和 `skipped[].reason`，例如 `tag_failed` |
| `core.version.list(): R<VersionListResult>` | `{ versions: VersionSummary[] }`，按版本数值序列出；空项目为 `[]` | 只读；多活动版本 `ACTIVE_VERSION_CONFLICT`，损坏元数据不降级为空列表 |
| `core.version.inspect(input: VersionInput): R<VersionInspection>` | 返回确认计划、Git 绑定及恢复记录的当前读模型，详见下节 | 只读，包含 Git 锚点解析；`VERSION_NOT_FOUND`、`SPEC_CONTENT_MISMATCH`、`GIT_FAILED` 或计划计算错误；不运行恢复 |

`InitResult` 为 `{ createdFiles: string[], chunks: number, specs: number, status: "fresh" | "existing", files: Record<string,string>, skipped: string[] }`；`files` 是本次结果中的文件内容映射。重复初始化遵循既有幂等行为，不用它代替只读检查。

#### 克隆与共享仓库配置

`project.clone` 是 docs-first 的就地恢复操作。调用方或 CLI 必须先直接提供 `docsUrl`，可用 `docsBranch` 指定文档分支；未指定时由 Git 按文档远端 `HEAD` 选择默认分支。文档仓成功检出后，core 才读取其中的 `project-docs/.meta/repositories.yaml`。`hostUrl` 与 `branch` 是本次代码仓恢复的显式覆盖；省略时使用共享配置的 `host.url` 与可选 `host.branch`，代码分支仍未确定时再读取代码远端 `HEAD`。

共享配置中的 `repositories.docs.branch` 只提供信息，不支配本次文档仓检出；它与 `docsBranch` 或远端 `HEAD` 得到的实际分支不同时，结果在 `warnings` 中报告且不会切换分支。

| 类型 | 完整字段 |
| --- | --- |
| `RepositoryReference` | `url: string`、`branch?: string` |
| `RepositoriesConfig` | `schema_version: 1`、`host: RepositoryReference`、`docs: RepositoryReference & { path: "project-docs" }` |
| `RepositoriesResult` | `path: string`（配置文件绝对路径）、`repositories: RepositoriesConfig` |
| `ClonedRepository` | `path: string`（仓库绝对路径）、`url: string`（仓库本地配置中原始的 `remote.origin.url`）、`branch: string`、`commit: string`（实际 HEAD） |
| `CloneResult` | `directory: string`、`resumed: boolean`、`host: ClonedRepository`、`docs: ClonedRepository`、`wrapper: string`（本机入口绝对路径）、`warnings: string[]` |

克隆被中断后，可在同一目录用完全相同的输入再次调用。续跑依据文档仓 `.git` 内的本地恢复记录，并逐项核对真实 Git 仓库、origin、分支、提交、upstream、工作区清洁状态与已完成阶段；`resumed: true` 只表示采用了这条恢复路径。恢复记录是需与实际 Git 状态共同验证的本地进度记录，不是签名、凭据或密码学认证。若记录未成功保存、参数或现场状态不一致，core 拒绝覆盖，不保证任意时刻强制中断均可自动恢复。

该流程不会递归子模块，不运行仓库 hooks，也不承诺整个双仓恢复具备原子回滚。失败时可能已经留下可安全续跑的文档仓、代码仓 `.git`、远端配置或恢复记录；调用方应保留现场并根据错误信封决定重试，不应假设目标目录恢复为空。

仓库地址在交给 URL 解析器或 Git 前先执行严格语法校验。HTTPS/SSH 地址必须是完整的 `scheme://authority/path`；拒绝缺少双斜杠、只有单斜杠、包含反斜杠、未编码空白或明显 Markdown 包装的形式。file URL 必须使用完整 `file://` 形式。绝对本地路径是独立的合法输入，因此 Windows 路径中的空格、中文和反斜杠不会被远端 URL 规则误拒；相对路径仍不接受。HTTP(S) userinfo、密码、query、fragment，以及外部 remote helper 等不安全形式会被拒绝；合法 SSH/SCP 用户名（例如 `git`）可以保留。地址规范化只用于身份比较，不会把合法原始地址改写后再传给 Git。

Git 自身的 `url.*.insteadOf` 配置仍参与传输：例如仓库配置可保留 HTTPS origin，而 Git 实际从映射后的 file/SSH endpoint 获取数据。core 不禁用、修改或持久化这些映射；origin 身份核对、断点恢复比较和 `CloneResult.host.url/docs.url` 均使用仓库本地配置中的原始 `remote.origin.url`，不是 `git remote get-url` 展开的传输 endpoint。原始 origin 被真实修改时仍会以 `CLONE_REPOSITORY_MISMATCH` 拒绝续跑。

Git 失败的 `error` 会标明操作角色、阶段和实际工作目录，例如文档仓克隆、代码仓拉取或代码仓默认分支查询；当 Git 输出未包含地址时，可附加本操作使用的安全仓库地址。正常公开 host/path 和本地路径不会被整段替换成占位符。诊断会遮蔽 URL userinfo（包括 token-only username）、密码及 query/fragment 中的敏感值，也会处理 `insteadOf` 展开后 endpoint 可能回显的凭据。该错误信息只陈述实际失败阶段，不把所有 `CLONE_GIT_FAILED` 归因为 URL、网络或 TLS，也不要求修改代理、证书或 Git 全局配置。

| 版本结果类型 | 业务字段 |
| --- | --- |
| `VersionStatus` | `version: string`、`phase: VersionPhase`、`working/staged/committed: string[]`、`by_action: Record<string, number>` |
| `VersionConfirmResult` | `version`、`passed: true`、`plan_fingerprint`、`planned_operations: number`、`conflict_policy`、`acceptance: AcceptanceResult`、`generation_receipts: GenerationVerification`、`warnings: GovernanceFinding[]`、`code_result: string \| null` |
| `VersionMergeResult` | `version`、`merged_chunks: string[]`、`commit: string \| null`、`git: "committed" \| "unavailable"`、`tag_created: boolean`、`plan_fingerprint`、`generation_receipts`、`warnings` |
| `VersionRevertResult` | `version`、`reverted: true`、`mode: "unmerged" \| "merged"`、`docs_anchor/host_anchor: string \| null`、`removed_versions: string[]` |
| `BackfillTagsResult` | `backfilled: string[]`、`skipped: { version: string, reason: "no_anchor" \| "tag_present" \| "no_docs_commit" \| "tag_failed" }[]`、`git: "committed" \| "unavailable"` |
| `VersionSummary` | `version: string`、`title: string \| null`、`phase: VersionPhase`、`merged: boolean`、`created_at: string`、`merged_at: string \| null`、`based_on: string \| null` |

`VersionPhase` 包含主线的 `empty`、`prd-creating`、`prd-confirm`、`fsd-creating`、`fsd-confirm`、`tdd-creating`、`tdd-confirm`、`merged`，并兼容历史相位 `prd_locked`、`impl_locked`、`coding`。读取结果应保留其真实值。

`VersionInspection` 的顶层为 `{ version, phase, based_on, confirmation, bindings, recovery }`：

| 读模型部分 | 字段与含义 |
| --- | --- |
| `confirmation` | `state: "missing" \| "valid" \| "stale" \| "not_applicable"`；`plan_fingerprint/current_fingerprint: string \| null`；`planned_operations: number` |
| `bindings` | `docs_ref/docs_commit/code_base/code_result: string \| null`；`docs_anchor_resolvable/host_anchor_resolvable: boolean \| null` |
| `recovery` | `state: "none" \| "recorded"`；`phase: "prepared" \| "applying" \| "compensating" \| "recovery_pending" \| null`；`diagnostic: string \| null` |

未合入且无计划为 `missing`；保存计划与当前真实输入指纹一致为 `valid`，否则 `stale`；已合入版本为 `not_applicable`。`missing/not_applicable` 的指纹为 `null`、操作数为 0。Git 记录存在和当前可解析是两件事：解析布尔值为 `null` 表示不适用/无绑定，`false` 表示存在适用候选但无法解析。读取到 `valid` 不保证之后的合入仍有效，合入会重新校验。

### PRD、FSD、TDD：10 个方法

三层文档方法不接受 `version`，操作唯一活动版本。没有活动版本报 `NO_ACTIVE_VERSION`；存在多个活动版本报 `ACTIVE_VERSION_CONFLICT`。

| 方法签名 | 返回与默认行为 | 副作用与常见错误 |
| --- | --- | --- |
| `core.prd.create(input: PrdInput): R<DocumentResult>` | 无正文取 PRD 讨论背景，有正文校验并写入 | 讨论只读；写入更新文档、索引/图、相位。拒绝 `parent`；常见上下文、内容、冻结错误 |
| `core.prd.confirm(): R<LayerConfirmResult>` | 确认并冻结 PRD 层，返回版本、确认 chunk ID、相位 | 提交该层 chunk 与变更记录、写元数据；层不开放或正文不合法时拒绝 |
| `core.prd.revert(): R<LayerRevertResult>` | PRD 层返工，返回版本、返工 chunk ID、相位 | 写相位/索引并使关联生成与确认状态失效；非该层确认阶段报 `PRD_LAYER_NOT_OPEN` |
| `core.fsd.create(input: DocumentInput): R<DocumentResult>` | 无正文取背景；有正文建立合法内容和关系；新增根的父级为相应 PRD 根 | 讨论只读，写入有持久化；需 PRD 已确认，常见 `PRD_NOT_CONFIRMED`、FSD 声明及关系错误 |
| `core.fsd.confirm(): R<LayerConfirmResult>` | 确认并冻结 FSD 层 | 提交该层并写相位；层不开放/关系不合法时拒绝 |
| `core.fsd.revert(): R<LayerRevertResult>` | FSD 层返工 | 写相位/索引、失效关联生成与确认状态；非该层确认阶段报 `FSD_LAYER_NOT_OPEN` |
| `core.fsd.decompose(input: DecomposeInput): R<DecomposeResult>` | 无正文取背景，有正文创建子 FSD 与 `decomposes` 关系 | 写入原子维护子文档及关系；常见 `MISSING_ENDPOINT`、`FSD_LAYER_NOT_OPEN`、上下文及关系错误 |
| `core.tdd.create(input: DocumentInput): R<DocumentResult>` | 无正文取背景，有正文按 FSD 叶 split 写文件级规格 | 需 FSD 已确认；校验唯一目标文件及父级。常见 `FSD_NOT_CONFIRMED`、`TDD_TARGET_FILE_REQUIRED`、`DUPLICATE_TARGET_FILE`、`TDD_MULTI_PARENT` |
| `core.tdd.confirm(): R<LayerConfirmResult>` | 确认并冻结 TDD 层，随后允许为活动版本准备交付 | 提交该层并写相位；层不开放/规格不合法时拒绝 |
| `core.tdd.revert(): R<LayerRevertResult>` | TDD 层返工 | 写相位/索引，失效旧交付、回执和确认计划；非该层确认阶段报 `TDD_LAYER_NOT_OPEN` |

共同的文档错误包括 `CONTEXT_TOKEN_INVALID`、`CONTEXT_TOKEN_STALE`、`ROOT_CHUNK_REQUIRED`、`CHUNK_LOCKED`、`INVALID_FILE_NAME`、`DUPLICATE_BASELINE_CHUNK`，以及 `PRD_REQUIREMENT_CONTRACT_VIOLATION`、`MARKDOWN_CONTAINS_RELATION`、`FSD_DECLARATION_INVALID`、`DERIVES_NOT_PRD`、`PRD_FSD_LINK_NOT_UNIQUE` 等内容或关系错误。层关闭时返回对应的 `PRD_LAYER_NOT_OPEN`、`FSD_LAYER_NOT_OPEN` 或 `TDD_LAYER_NOT_OPEN`。

| 文档结果类型 | 业务字段 |
| --- | --- |
| `DiscussionResult` | `mode: "discussion-context"`、`version`、`layer: "prd" \| "fsd" \| "tdd"`、`id`、`parent: string \| null`、`background: string`、`context_token: string` |
| `DocumentWrittenResult` | `mode: "written"`、`layer`、`id`、`file`、`chunks: string[]`、`edges: { src, dst, rel: EdgeRel }[]`、`phase`、可选 `audit: { skip_context: true, at: string }` |
| `DecomposeWrittenResult` | `mode: "written"`、`src`、`dst`、`rel: "decomposes"`、`file`、`phase`、可选同形 `audit` |
| `LayerConfirmResult` | `{ version: string, confirmed: string[], phase: VersionPhase }` |
| `LayerRevertResult` | `{ version: string, reverted: string[], phase: VersionPhase }` |

`DocumentResult = DiscussionResult | DocumentWrittenResult`；`DecomposeResult = DiscussionResult | DecomposeWrittenResult`。先判断 `mode` 再读取分支字段。层确认已提交该层的 chunk，完整分层流程通常不需要额外调用 `version.commit`。

### 生成交付与回执：4 个方法

| 方法签名 | 默认行为与结果 | 副作用与常见错误 |
| --- | --- | --- |
| `core.delivery.prepare(input: DeliveryPrepareInput): R<MemoryDelivery \| DeliveryPointer>` | 默认内存交付；字面量 `output: "file"` 的重载返回 `R<DeliveryPointer>`，省略 output 或 `"memory"` 的重载返回 `R<MemoryDelivery>` | 两种模式均登记交付元数据并签发令牌；file 另写仓外交付文件。常见 `VERSION_NOT_FOUND`、`TDD_NOT_CONFIRMED`、`TDD_NOT_FOUND`、`TARGET_FILE_MISSING`、`CODEGEN_SOURCE_MISSING`、`CODEGEN_CHUNK_MISSING`、`TRACE_BROKEN`、`SPEC_CYCLE` |
| `core.generation.registerReceipt(input: GenerationReceiptInput): R<GenerationReceipt>` | 按有效令牌读取目标实际字节，由 core 计算制品 SHA-256 并登记 | 写回执；不接受调用方提供的制品 hash。常见 `GENERATION_TOKEN_INVALID`、`GENERATION_TOKEN_STALE`、`GENERATION_SPEC_CHANGED`、`GENERATION_ARTIFACT_MISSING`、`GENERATION_ARTIFACT_UNREADABLE`、`GENERATION_ARTIFACT_CHANGED` |
| `core.generation.verifyReceipts(input: VersionInput): R<GenerationVerification>` | 核验指定版本的当前规格、交付、回执和实际制品；必须传版本，不提供基线 verify | 只读；缺失/过期等通常作为 `findings` 返回；版本/配置/存储损坏仍返回错误信封 |
| `core.generation.status(input: GenerationStatusInput): R<GenerationStatus>` | 返回逐 TDD 的交付、回执、实际文件状态与发现；可按 `tddRootId` 筛选 | 只读；候选可为空，指定根不在候选中报 `TDD_NOT_FOUND`；无效版本报 `VERSION_NOT_FOUND`，无法解析规格时不伪造 absent |

两种交付共享以下 `DeliveryMetadata`：

| 字段 | 类型与含义 |
| --- | --- |
| `sha256`、`bytes` | `string`、`number`；完整上下文实际 UTF-8 字节的 SHA-256 和字节数，不能用 `content.length` 代替 |
| `version` | `string \| null`；`null` 表示基线交付 |
| `target_file`、`tdd_root`、`source_file` | `string`；目标相对路径、TDD 根 ID、规格来源文件 |
| `generation_token` | `string`；本次交付令牌 |
| 内存专有 `content` | `string`；直接交给宿主生成器的完整 prompt 上下文 |
| 内存专有 `target_state` | `"loaded" \| "absent" \| "unreadable"`，明确区分目标不存在与读取失败 |
| 文件专有 `bundle_path` | `string`；完整交付文件的位置，文件指针不内联 `content`，目标状态在正文中 |

`prepare` 不生成目标制品。缺省选唯一活动版本，无活动版本才回退基线；显式版本会检查存在与状态，已合入版本按既有规则读取基线，不代表历史快照。活动版本需 TDD 已确认。不要将 `graph.query` 专用的 `version: "baseline"` 视为所有方法的通用选择器。

内存交付不创建 bundle 中间文件，但会读取规格和目标制品、登记交付元数据。两种模式的正文与字节算法相同；文件模式先完成写入和校验，再登记新交付，失败清理本次文件并保留原有效交付。再次为同一 TDD prepare 会替换最新交付，使旧令牌/回执失效。元数据保存令牌摘要而非可恢复原 token、完整正文或 bundle 路径；宿主需保留当前交付，丢失后重新 prepare。

回执为 `{ version: string | null, tdd_root: string, target_file: string, bundle_sha256: string, artifact_sha256: string, generated_at: string }`。`bundle_sha256` 在内存模式下同样表示上下文内容 hash。相同有效令牌与相同制品的重复登记幂等；生成前后 hash 相同不必然失败。令牌与回执只关联规格、交付和制品，不证明 agent 身份、测试执行、模型阅读行为或业务正确性。

对于已经合入的版本，相关回执按历史记录只读比较：合入后 write token 过期不等于历史回执失效。读模型会把历史合入证据与当前目标文件的实时指纹分开；当前字节不同应报告 current drift，而不是改写历史结论。调用方不得用旧 prepare/token 为当前制品补登记；处理漂移需要新版本、新交付和新的收口证据。

`GenerationVerification` 为 `{ enforcement: "report" | "block", passed: boolean, findings: { code, message, tdd_root, target_file }[] }`。`report` 下有发现仍可 `passed: true`；`block` 下发现会阻断。宿主应同时展示策略与发现。

`GenerationStatus` 为 `{ version, enforcement, items: GenerationItemStatus[] }`。每项含 `tdd_root`、`target_file`、`delivery_present`、`receipt_present`、`artifact_state`、`artifact_sha256`、`receipt_artifact_sha256` 与 `{ code, message }[]` 形状的 `findings`。两个 present 字段只表示记录存在；制品变化时仍可 `receipt_present: true` 并出现 `GENERATION_ARTIFACT_CHANGED`。`loaded` 有实际 hash，`absent/unreadable` 的实际 hash 为 `null`。候选按根 ID 和目标路径稳定排序，包含版本内最新未删除 TDD 根以及需要诊断制品变化的历史交付；没有回执不能推断生成任务尚未开始或正在运行。

### 图与检索：8 个方法

| 方法签名 | 默认行为与结果 | 副作用与常见错误 |
| --- | --- | --- |
| `core.graph.query(input: GraphQueryInput): R<DepsResult>` | 当前基线叠加所选版本的直接邻边，默认活动版本/基线、双向、不过滤关系 | 只读；非法方向/关系 `USAGE_ERROR`，显式版本不存在 `VERSION_NOT_FOUND`，默认选择冲突 `ACTIVE_VERSION_CONFLICT` |
| `core.graph.impact(input: GraphImpactInput): R<ImpactResult>` | 在活动版本叠加基线的视图上分析影响范围；无活动版本读基线；返回 `{ found, impacted: string[], count: number }` | 只读；`ACTIVE_VERSION_CONFLICT`、图/版本读取错误 |
| `core.graph.sync(): R<SpecGraph>` | 同步基线和未合入版本的存储图，返回基线图 | 写图；可能报告 `GRAPH_UNREADABLE`、索引或内容错误；不应作为只读刷新 |
| `core.graph.export(input?: OptionalVersionInput): R<SpecGraph>` | 缺省读基线存储图，指定版本读该存储图；不合成叠加视图 | 只读；损坏图报 `GRAPH_UNREADABLE`；保留存储图的既有缺失处理，不用于验证版本是否存在 |
| `core.graph.validateNewModel(input?: OptionalVersionInput): R<ValidationReport>` | 默认检查活动版本/基线；指定已合入版本按既有规则检查当前基线 | 只读；无效版本/损坏图返回错误；不变式与治理发现见结果字段 |
| `core.search.query(input: SearchInput): R<SearchResult>` | 默认只查基线、大小写不敏感的字面量子串；`all` 包含版本工作区；`regexp: true` 使用正则 | 只读；空/纯空白查询 `SEARCH_EMPTY_QUERY`，非法正则 `USAGE_ERROR`；源文件解析错误不吞掉 |
| `core.search.baselineSummary(input?: BaselineSummaryInput): R<BaselineSummary>` | 默认全部基线索引摘要，按索引顺序；可筛 PRD/FSD/TDD | 只读，不重建索引；空索引/无匹配层返回 `items: []`，损坏索引 `INDEX_UNREADABLE` |
| `core.search.baselineStats(): R<BaselineStats>` | 基线文档、chunk、关系计数与版本列表，独立于摘要 | 只读；索引/图等存储错误原样报告 |

`EdgeRel = "derives" | "decomposes" | "details" | "depends_on"`。`graph.query` 的 `out` 表示 `src === target`，`in` 表示 `dst === target`，`both` 为双向邻边；不递归展开，也不推导新关系。旧 `from/to` 值返回 `USAGE_ERROR`。`rels` 缺省不过滤，`[]` 返回空边集，多个关系取并集后再与方向条件相交，重复项不产生重复边。未过滤时可保留历史图中的其他关系，四项全选仅匹配四种指定关系。

显式 `version: "baseline"` 只查基线；指定其他版本先检查存在，再读取“当前基线 + 该版本”，不切换活动版本，不承诺该版本发布时的历史快照。未知目标返回 `found: false, edges: []`。

```ts
import { createCoreApi } from "ait-core";

const core = createCoreApi();
const neighbors = await core.graph.query({
  target: "[FSD]-demo:feature",
  direction: "out",
  rels: ["details", "depends_on"],
  version: "baseline",
});
const summary = await core.search.baselineSummary({ scope: "prd" });
const statistics = await core.search.baselineStats();
```

| 图/检索结果类型 | 字段 |
| --- | --- |
| `DepsResult` | `{ found: boolean, target: string, direction: Direction, edges: ViewEdge[] }` |
| `ViewEdge` | `{ src: string, dst: string, rel: string, metadata: Record<string, unknown> }`；端点为 chunk ID |
| `SpecGraph` | `{ version, updated, specs, edges }`；这里的 `version` 是图数据格式版本 |
| `ValidationReport` | `{ version, passed, violations, policy_violations, warnings, target_file_missing, derives_residue }`；各发现保留公开类型提供的定位信息 |
| `SearchResult` | `{ query: string, count: number, hits: SearchHit[] }` |
| `SearchHit` | `{ chunkId, file, heading, version, matches: { line: number, text: string }[] }` |
| `BaselineSummary` | `{ scope: "all" \| LayerScope, items: { id: string, heading: string, summary: string \| null }[] }` |
| `BaselineStats` | `{ docs: { prd: number, fsd: number, tdd: number }, chunks: number, edges: Record<EdgeRel, number>, versions: string[] }` |

摘要只读取基线索引，保留真实摘要及 `null`，不会为缺摘要条目生成正文摘要。层级优先由规格文件路径识别，再看 `[PRD]/[FSD]/[TDD]` 前缀；全量结果保留无法归层的历史条目，指定层只返回可归层的条目。

### 状态、索引、验收与发布：8 个方法

| 方法签名 | 默认行为与结果 | 副作用与常见错误 |
| --- | --- | --- |
| `core.state.get(input?: OptionalVersionInput): R<StatePanel>` | 默认活动版本，返回结构化状态面板 | 只读；未指定且无活动版本 `NO_VERSION`，显式不存在 `VERSION_NOT_FOUND` |
| `core.state.render(input?: OptionalVersionInput): R<MarkdownState>` | 同一状态模型渲染 Markdown，默认活动版本 | 只读；同 `state.get` |
| `core.state.save(input?: StateSaveInput): R<StateSaveResult>` | 从同一次读取生成保存内容和返回值；默认返回 Markdown，`format: "json"` 返回面板 | 写该版本 `state.md`；保存文件始终为 Markdown，`format` 只选返回结构。错误同 `state.get` 加写入错误 |
| `core.index.rebuild(): R<BaselineIndex>` | 重建基线索引，返回 `{ version, scope, updated, chunks }`，`version` 是索引格式版本 | 扫描并写基线索引；源文件解析/读取错误不伪装成功，不应作为只读刷新 |
| `core.acceptance.set(input: AcceptanceSetInput): R<AcceptanceConfigResult>` | 保存完整命令字符串，返回 `{ command }`，此调用不执行命令 | 写本地配置；坏配置 `CONFIG_UNREADABLE`，另可能写入错误 |
| `core.acceptance.show(): R<AcceptanceConfigResult>` | 返回本地覆盖共享配置后的 `{ command: string \| null }`；未配置为 `null` | 只读；坏配置 `CONFIG_UNREADABLE` |
| `core.acceptance.run(): R<AcceptanceResult>` | 在绑定的宿主根执行配置的 shell 命令；未配置返回 `{ ran: false, passed: true, exitCode: null }` | 命令可能改制品/文件；非零退出通常是成功信封中的 `passed: false`，坏配置仍报 `CONFIG_UNREADABLE` |
| `core.publish.push(input?: PushInput): R<PushReport>` | `dryRun` 默认 `false`；先宿主、后文档，分别返回状态；`true` 只检查 | 推送当前分支，文档仓附带 AIT 标签；不创建远端/上游，不强推，不回滚已成功侧。推送问题在各仓 `status/detail` 中报告 |

`StatePanel` 包含 `version`、`title: string | null`、`phase`、`prd_locked/impl_locked/merged: boolean`、`working/staged/committed: string[]`、`by_action: Record<string, number>`、`prd_chunks/fsd_chunks/tdd_chunks: string[]` 和 `counts: { working, staged, committed, prd, fsd, tdd }`。`MarkdownState` 为 `{ version: string, format: "markdown", content: string }`；`StateSaveResult` 为面板或 Markdown 结果再加 `saved_to: string`。

`AcceptanceResult` 为 `{ ran: boolean, passed: boolean, exitCode: number | null }`。未配置的跳过不能当作实际验收执行成功；宿主需要实际验收时检查 `ran`。`version.confirm` 会再次运行配置命令并在验收后重检规格/回执。

`PushReport` 为 `{ host: PushResult, docs: PushResult }`，每仓 `{ status: "pushed" | "nothing" | "failed" | "not_applicable", detail: string }`。无远端或无上游的信息在 `detail` 中分别标注 `PUSH_NO_REMOTE`、`PUSH_NO_UPSTREAM`；不是外层错误码。`dryRun` 不推送，通常返回 `nothing` 并描述待推内容。未提交改动不随推送发送。

### 会话、策略与守卫：3 个方法

| 方法签名 | 返回与默认行为 | 副作用与常见错误 |
| --- | --- | --- |
| `core.session.get(): R<SessionContext>` | 读取项目根、活动版本、相位、分层三态计数、基线是否为空及事实文本 | 只读；无活动版本为正常状态，多活动版本报 `ACTIVE_VERSION_CONFLICT`，损坏存储不伪装未初始化 |
| `core.governance.getPolicy(): R<EffectiveGovernancePolicy>` | 返回应用本地覆盖、默认值和归一规则后的有效策略 | 只读，不暴露完整机器配置；损坏配置报 `CONFIG_UNREADABLE` |
| `core.guard.evaluate(input: GuardEvaluateInput): ApiResult<GuardDecision>` | 同步纯判定，返回 `{ decision: "allow" \| "block", reason: string \| null }` | 不读文件/相位，不执行或拦截工具；输入形态非法返回 `USAGE_ERROR` |

`SessionContext` 为 `{ project_root: string, active_version: string | null, phase: VersionPhase | null, layers: { prd, fsd, tdd }, baseline_empty: boolean, text: string }`，每层计数 `{ working: number, staged: number, committed: number }`。`text` 只表达同次读取的事实，不含流程指令。`baseline_empty` 依据整个基线索引是否无 chunk，不能由某层摘要为空推导。

`EffectiveGovernancePolicy` 包含：

| 字段 | 结构 |
| --- | --- |
| `generation_receipts` | `{ enforcement: "report" \| "block" }` |
| `target_file_existence` | `{ enforcement: "warn" \| "block" }` |
| `derives_residue` | `{ enforcement: "warn" \| "block" }` |
| `artifact_scopes` | `{ prefix: string, parent_suffix: string, enforcement: "warn" \| "block", exempt_paths: string[], exempt_test_splits: string[] }[]` |

`report` 与 `warn` 属于不同策略域。宿主可展示策略，但确认/合入按实际执行时的有效配置决定是否放行。

守卫识别 `write/edit` 的 `path`、`file_path`、`target_file` 字段及 `shell` 的 `command/cmd` 中可静态识别的重定向，保护 `project-docs/docs`、`project-docs/versions` 和 `project-docs/.meta`。宿主必须在实际工具执行前调用并执行 `block` 结果；不具备工具拦截能力的接入只能提供建议。它不分析任意脚本、不限制普通源码只能由某个 agent 写、不证明 `allow` 调用安全或流程正确。生成任务的可写目标约束仍由宿主落实。

## 完整 Node 流程示例

下面的函数在新项目根通过公共 Node API 完成初始化、创建版本、PRD/FSD/TDD 讨论与写入、逐层确认、内存交付、宿主生成和测试、回执登记、验证、版本确认与合入。提供一个未使用的版本名。初始化和版本确认/合入会产生上述文件与 Git 副作用。示例 ID 特意与 `project.init` 创建的根文档分开；FSD 正文包含其根和 `:feature` split。

`Host` 是示例定义的宿主接口，不是 `ait-core` 导出。`draft` 应基于完整讨论背景与用户确认产生合法正文；示例约定 PRD 根 `[PRD]-feature-api`、FSD 根 `[FSD]-feature-api`，其中包含叶 split `[FSD]-feature-api:feature`，TDD 根 `[TDD]-feature-api` 声明一个目标文件。正式项目可换用自身 ID。宿主须实现隔离生成、仅允许指定目标写入，并在生成/测试失败时拒绝 Promise；如产生多个目标，每个目标均需独立 TDD、prepare 和回执。

```ts
import { createCoreApi } from "ait-core";
import type {
  ApiResult,
  DiscussionResult,
  DocumentInput,
  DocumentResult,
  DocumentWrittenResult,
  GenerationVerification,
} from "ait-core";

interface Host {
  draft(context: DiscussionResult): Promise<string>;
  generate(input: {
    prompt: string;
    targetFile: string;
  }): Promise<void>;
  test(targetFile: string): Promise<void>;
  reportFindings(report: GenerationVerification): void;
}

function unwrap<T extends object>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw Object.assign(new Error(result.error), { code: result.code });
  }
  return result.data;
}

export async function implementFeature(
  host: Host,
  version: string,
  acceptanceCommand: string,
) {
  const core = createCoreApi({
    onProgress(event) {
      console.error(event.operation, event.stage, event.status);
    },
  });

  unwrap(await core.project.init({ name: "node-api-example" }));
  unwrap(await core.version.create({ version }));

  const prdIntent = { id: "[PRD]-feature-api" };
  const prdContext = unwrap(await core.prd.create(prdIntent));
  if (prdContext.mode !== "discussion-context") throw new Error("预期讨论背景");
  const prdWritten = unwrap(await core.prd.create({
    ...prdIntent,
    content: await host.draft(prdContext),
    contextToken: prdContext.context_token,
  }));
  if (prdWritten.mode !== "written") throw new Error("预期已写入结果");
  unwrap(await core.prd.confirm());

  // FSD 与 TDD 共用输入；每次讨论和提交保持相同意图。
  async function discussAndWrite(
    create: (input: DocumentInput) => Promise<ApiResult<DocumentResult>>,
    intent: DocumentInput,
  ): Promise<DocumentWrittenResult> {
    const context = unwrap(await create(intent));
    if (context.mode !== "discussion-context") {
      throw new Error("预期讨论背景");
    }
    const content = await host.draft(context);
    const written = unwrap(await create({
      ...intent,
      content,
      contextToken: context.context_token,
    }));
    if (written.mode !== "written") throw new Error("预期已写入结果");
    return written;
  }

  await discussAndWrite((input) => core.fsd.create(input), {
    id: "[FSD]-feature-api",
    parent: "[PRD]-feature-api",
  });
  unwrap(await core.fsd.confirm());
  await discussAndWrite((input) => core.tdd.create(input), {
    id: "[TDD]-feature-api",
    parent: "[FSD]-feature-api:feature",
  });
  unwrap(await core.tdd.confirm());

  const delivery = unwrap(await core.delivery.prepare({
    tddRootId: "[TDD]-feature-api",
    version,
  })); // 缺省 output: "memory"，类型为 MemoryDelivery
  if (delivery.target_state === "unreadable") {
    throw new Error("目标文件不可读，宿主停止覆盖");
  }
  if (delivery.version !== version) {
    throw new Error("交付未绑定当前活动版本");
  }

  const guard = unwrap(core.guard.evaluate({
    toolName: "write",
    input: { path: delivery.target_file },
  }));
  if (guard.decision === "block") throw new Error(guard.reason ?? "写入被阻止");

  // 宿主取得完整 content 后启动隔离生成器；不从摘要重建 prompt。
  // 宿主仍须对生成器后续每次真实工具调用执行目标限制与守卫。
  await host.generate({
    prompt: delivery.content,
    targetFile: delivery.target_file,
  });
  await host.test(delivery.target_file);

  const receipt = unwrap(await core.generation.registerReceipt({
    generationToken: delivery.generation_token,
  }));
  const verification = unwrap(await core.generation.verifyReceipts({ version }));
  host.reportFindings(verification);
  if (!verification.passed) throw new Error("生成回执未通过当前策略");

  unwrap(await core.acceptance.set({ command: acceptanceCommand }));
  const acceptance = unwrap(await core.acceptance.run());
  if (!acceptance.ran || !acceptance.passed) throw new Error("项目验收未通过");

  // confirm 会再次验收与重检；若验收改变制品，必须先处理新的回执发现。
  const confirmed = unwrap(await core.version.confirm({ version }));
  const merged = unwrap(await core.version.merge({ version }));
  return { receipt, verification, acceptance, confirmed, merged };
}
```

这条流程不创建、读取或传递 bundle 中间文件，也不调用 `dispatch`。`content` 自身就是完整交付；令牌已由 prepare 签发，无需另调签发接口。宿主运行状态（正在生成、等待用户或测试中）由宿主维护，不能由 `generation.status` 猜测。

## 错误处理与恢复

| 错误族 | 处理含义 |
| --- | --- |
| `USAGE_ERROR` | 参数形态、未知字段、非法枚举或正则等；按 `error` 修正输入 |
| `NOT_AT_PROJECT_ROOT`、`CWD_INSIDE_PROJECT_DOCS`、`PROJECT_DOCS_MALFORMED` | client 绑定目录或项目结构不合法；不要通过手工拼内部路径绕过 |
| `CONFIG_UNREADABLE`、`INDEX_UNREADABLE`、`GRAPH_UNREADABLE`、`CHUNK_PARSE_ERROR`、`SPEC_CONTENT_MISMATCH` | 配置、索引、图或正文不可信；保留定位信息，不当空项目继续写入 |
| `NO_ACTIVE_VERSION` / `NO_VERSION` | 文档操作 / 状态面板缺少活动版本；`session.get` 的无活动版本则是正常结果 |
| `ACTIVE_VERSION_EXISTS` / `ACTIVE_VERSION_CONFLICT` | 已有活动版本 / 多个活动版本冲突，不任意选一个 |
| `CONTEXT_TOKEN_INVALID`、`CONTEXT_TOKEN_STALE` | 讨论令牌无效或意图/背景变化；重新取得背景并核对写入意图 |
| `GENERATION_TOKEN_INVALID`、`GENERATION_TOKEN_STALE`、`GENERATION_SPEC_CHANGED` | 生成令牌或规格快照不再匹配；重新准备完整交付并验证制品 |
| `GENERATION_RECEIPTS_FAILED`、`CONFIRMATION_REQUIRED`、`CONFIRMATION_STALE` | 回执门禁未通过、缺确认计划或计划过期；先用相应只读接口核对事实 |
| `ACCEPTANCE_FAILED`、`GIT_FAILED`、`REVERT_PRECHECK_FAILED`、`REVERT_FAILED`、`MERGE_ROLLBACK` | 验收、提交或恢复未正常完成；检查业务结果与 `version.inspect` 的恢复记录后再决定操作 |
| `INTERNAL_ERROR` | 未预期异常，保留消息并检查实际状态，不自动重试写操作 |

操作失败不意味着所有副作用均已撤销，尤其是验收命令、Git 操作和发布。读取及写前门禁、领域事务回退、外部命令的副作用范围各有边界。失败后可调用 `session.get`、`version.status/inspect`、`generation.status` 等只读方法刷新事实；不要用 `confirm`、`sync` 或 `rebuild` 代替查询。

## 从旧命名导出迁移

0.2.0 在开发期一次性替换旧接口，不保留旧五函数的包根兼容导出：

| 已移除的包根函数 | 公共替代方式 |
| --- | --- |
| `getSessionContext(root)` | `await core.session.get()`，从结果信封读取事实 DTO |
| `evaluateWriteGuard(input)` | `core.guard.evaluate({ toolName, input })`；项目目录由 client 注入，返回结果信封 |
| `issueGenerationToken(root, delivery)` | `await core.delivery.prepare({ tddRootId, version? })` 内部完成签发；不接受自行组装的交付身份 |
| `registerGenerationReceipt(root, { generation_token })` | `await core.generation.registerReceipt({ generationToken })` |
| `verifyGenerationReceipts(root, version)` | `await core.generation.verifyReceipts({ version })` |

同步旧读/回执调用改为 `await`；先判断 `ok`，再读 `data`。移除消费者的 `ProjectRoot` 拼装、`NextAction` 等旧建议类型与字段；不使用深层 import 继续调用内部实现。令牌的输出字段仍为 snake_case，输入改用 camelCase。

| 与 CLI 或旧行为的差异 | Node 集成方式 |
| --- | --- |
| 图方向 `from/to` 已移除 | 使用 `in/out/both`；方向原值在结果中返回 |
| 关系过滤与版本选择 | `rels` 使用四种实际 `EdgeRel`，与 `direction` 独立；`version` 由共享 API 校验；CLI `--depends-on` 对应 `depends_on` |
| `baseline-summary` 始终表示摘要 | Node `baselineSummary()` 返回 `{ scope, items }`；原统计消费者改用 `baselineStats()` |
| CLI 摘要默认 YAML，JSON 成功为 `{ ok: true, data: items }` | API 始终返回完整 DTO，不能把 CLI 数组投影当作 API 的 `data`；CLI scope 仅 `prd/all`，API 还支持 `fsd/tdd` |
| CLI `--content-file` | Node 只收 `content` 字符串；不传 shell 引号、argv 或文件来源选项 |
| CLI `codegen prepare` 固定文件交付 | Node 缺省内存交付；`output: "file"` 才返回文件指针，两者均登记元数据 |
| CLI `--new-model` 为兼容空操作 | Node `InitInput` 不包含 `newModel` |
| CLI stdout 与进度 | CLI 进度输出到 stderr，普通命令输出单 JSON；Node 用回调和结果信封，不自动打印；CLI 退出码只镜像外层 `ok` |

`dispatch(argv, options?)` 仍是包根的 CLI 适配函数，返回 `Promise<CliDispatchResult>`；摘要成功可能带 `presentation: { format: "yaml" | "json", projection: "baseline-items" }`，供 CLI 选择展示，不是 Node 业务 DTO 或持久化内容。通用 `CoreResult` 为 `ApiResult<Record<string, unknown>>`；各个命名方法保留具体结果类型。Node 集成直接调用本文的分组方法即可。
