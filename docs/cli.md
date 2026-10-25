# CLI 命令参考

本文适用于 `ait-core` 0.3.0，运行环境为 Node.js 22 及以上。CLI 通过同一套公共业务接口执行规格、版本、图查询、交付与回执操作。Node 集成入口见 [Node API 参考](node-api.md)。

## 安装与运行目录

本次开发交付使用已构建、打包的本地 tarball，安装后同时提供 `ait` 命令：

```sh
npm install --global /absolute/path/ait-core-0.3.0.tgz
ait init --name demo
```

本页不表示 0.3.0 已发布到公开 registry。只有目标版本已经发布到所配置的 registry 时，才可按包名安装：

```sh
npm install --global ait-core
```

除 `ait clone` 外，在宿主项目根目录执行命令，该目录应包含 `project-docs/`。首次初始化前可直接运行 `ait init`；从已有双仓恢复时，在空的最终项目根运行 `ait clone`。初始化或克隆后优先使用项目本地 wrapper：

| 环境 | 项目入口 |
| --- | --- |
| Windows PowerShell | `& .\project-docs\.ait\ait-cli.cmd <命令及参数>` |
| Linux / macOS | `./project-docs/.ait/ait-cli <命令及参数>` |

下文的 `ait` 均可替换为对应 wrapper。入口记录当前 Node 和 CLI 的路径；安装位置或 Node 路径改变后，在项目根使用新安装的 `ait init --refresh-wrapper` 刷新。读取 Python AIT 管理的既有项目不要求迁移或重新初始化；显式刷新 wrapper 才会替换项目入口。

`project-docs/docs`、`project-docs/versions` 和 `project-docs/.meta` 由 AIT 管理。通过文档、版本和回执命令修改它们；普通编辑器或脚本只负责草稿与目标制品，不直接写这些目录来绕过门禁。CLI 没有任意元数据文件写入命令，也没有 `--root` 项目路径覆盖参数。

## 参数、输出与退出码

语法中的 `<值>` 必填，`[选项]` 可省略，`a|b` 表示二选一。含空格的查询、命令正文和路径应按所用 shell 引号规则传成一个参数。带值选项支持 `--name value` 和 `--name=value`；布尔选项只写名称，例如 `--check`，不接受 `--check=true`。重复的带值选项采用最后一次值。

未知命令、未知选项、多余位置参数、缺少必填参数和非法枚举返回 `USAGE_ERROR`。没有通用 `--help`、短选项、`--root` 或取消选项。各命令仅接受本页列出的参数。

除 `baseline-summary` 的成功展示外，stdout 始终为一个单行 JSON 信封：

```json
{"ok":true,"data":{"version":"v0.1"}}
```

```json
{"ok":false,"code":"USAGE_ERROR","error":"缺参数：--generation-token"}
```

退出码只反映外层 `ok`：`true` 为 `0`，`false` 为 `1`。业务检查未通过不一定使进程退出 `1`：

| 命令 | 外层成功后仍须检查 |
| --- | --- |
| `init --check` | `data.ok`、`data.missing` |
| `acceptance run` | `data.ran`、`data.passed`、`data.exitCode` |
| `specgraph validate-new-model` | `data.passed`、`data.violations`，以及独立的 `data.policy_violations`、`data.warnings` |
| `codegen verify` | `data.enforcement`、`data.passed`、`data.findings` |
| `push` | `data.host.status` 和 `data.docs.status` |

例如验收失败可返回以下结果，AIT 进程退出码仍为 `0`：

```json
{"ok":true,"data":{"ran":true,"passed":false,"exitCode":1}}
```

耗时操作的实际阶段进度写到 stderr，stdout 不混入进度、验收子进程输出或 Git 输出。阶段事件是独立 JSON 行：

```json
{"operationId":"本次运行标识","operation":"version.confirm","stage":"acceptance","status":"started"}
```

`stage` 为 `read`、`validate`、`assemble`、`write_bundle`、`register_delivery`、`acceptance`、`git` 或 `persist`；`status` 为 `started`、`completed` 或 `failed`。一次操作不保证出现所有阶段；事件不表示完成百分比，最终结果信封才是调用结论。脚本应分别处理 stdout 和 stderr。

结果不包含 `next_action`，也不提供下一次调用指令。读取背景、生成、运行测试和安排后续调用由调用方负责。CLI 不提供 `cancel`、取消状态或取消错误码；外部终止进程属于中断恢复，不承诺撤销此前副作用。同一项目的写操作应串行执行。

## 项目命令

### `ait --version`

无其他参数。返回文档版本记录中数值序最大的版本号，例如 `data: {"version":"v0.13"}`；无版本记录或不在项目根时为 `"unversioned"`。它不是 npm 包版本，也不用于判断项目结构是否完整。包安装版本可由 `npm list --global ait-core --depth=0` 查询；项目检查使用 `init --check`。

### `ait clone <docs-url> [--host-url <url>] [--branch <host-branch>] [--docs-branch <docs-branch>]`

在当前空目录原地恢复文档仓和宿主代码仓；当前目录就是最终项目根，不接受目标目录等额外位置参数。执行顺序固定为：

1. 在当前目录创建 `project-docs/`，先把 `<docs-url>` 克隆到该目录。
2. 从已克隆文档仓读取 `project-docs/.meta/repositories.yaml`。
3. 在当前父目录原地执行宿主仓的 `git init`、添加 `origin`、获取并安全检出分支。

不会先把代码克隆到临时目录再搬迁，也不会对非空父目录执行 `git clone ... .`。每个 Git 子进程使用明确的工作目录；命令不改变调用进程的当前目录。

| 参数 | 默认值、优先级与含义 |
| --- | --- |
| `<docs-url>` | 必需，是本次文档仓来源的权威地址；可与共享配置中的 `docs.url` 不同，用于从 fork 恢复 |
| `--docs-branch <docs-branch>` | 缺省使用文档远端声明的默认分支；分支在读取共享元数据之前选定。共享配置中的 `docs.branch` 若与实际选择不同，只在 `warnings` 中提示，不切换分支、不使克隆失败 |
| `--host-url <url>` | 缺省读取共享配置的 `host.url`；显式值只覆盖本次克隆，不改写共享配置 |
| `--branch <host-branch>` | 宿主分支优先级为：显式 `--branch` > 共享配置 `host.branch` > 宿主远端默认分支；不硬编码 `main` 或 `master` |

仓库地址支持 `https`、`ssh`、scp 样式、`file:` URL 和绝对本地路径。相对路径、以 `-` 开头、含控制字符、内嵌凭据、查询参数或片段的 URL，以及 `ext::` 等 external remote helper 地址会被拒绝；SSH 的普通用户名可用。分支名也必须是安全 Git ref，不能是选项或 `@{-1}` 一类历史表达式。CLI 不转换地址拼写；本地路径和 file URL 只在身份比较时规范化。

首次执行要求目录为空，并拒绝卷根、用户根、符号链接/重解析路径、已有祖先 Git 工作树中的意外嵌套，以及宿主树中会与 `project-docs` 冲突的路径。获取完整分支和 tags，不提供 shallow、force、submodule 递归或固定 AIT `--version` 选项。成功后保留两仓各自的历史、分支、upstream 和 origin，生成当前平台 wrapper，并验证项目结构、基线索引和规格图；不会运行验收命令，也不声称文档分支与代码分支属于同一 AIT 发布。

成功 stdout 的 `data` 为：

```text
{
  directory:string,
  resumed:boolean,
  host:{path:string,url:string,branch:string,commit:string},
  docs:{path:string,url:string,branch:string,commit:string},
  wrapper:string,
  warnings:string[]
}
```

`directory`、两仓 `path` 和 `wrapper` 均为绝对路径；URL、分支和 commit 来自完成后的真实仓库。`resumed` 表示本次调用使用了已有恢复记录，不表示跳过了身份与工作区核对。

命令在 `project-docs/.git/ait-clone-state.json` 保存本机恢复状态。该文件不进入版本库；它是“哪些原地步骤由本次流程创建并可安全续跑”的本地标记，不是密码、签名或加密身份认证。只有恢复记录、调用参数、两仓 origin/分支/commit、Git 根和干净状态全部匹配时才能继续。共享 `repositories.yaml` 不能授权删除或覆盖文件；无记录或身份不一致的残留、脏工作区和未知 `.git` 都会拒绝，命令不会用 reset、clean、force 或覆盖来猜测恢复。

文档仓成功而宿主初始化、fetch、checkout 或项目验证失败时，已成功的 `project-docs/` 和可能已创建的父 `.git` 会保留，错误文字包含失败阶段及位置；修正外部原因后，以完全相同的 clone 参数重跑即可从已记录阶段继续。已完成后重复调用只核对并返回当前两仓 HEAD，不拉取新提交、不覆盖后来编辑；若真实状态已变化，可以拒绝而不是改写。

```powershell
New-Item -ItemType Directory -Path 'restored-project' | Out-Null
Set-Location 'restored-project'
ait clone 'https://example.invalid/team/project-docs.git' `
    --host-url 'git@example.invalid:team/project.git' `
    --branch 'release' --docs-branch 'docs-release'
```

### `ait repos show`

无参数，只读返回当前项目的共享双仓配置。成功 `data` 为：

```text
{path:string,repositories:{schema_version:1,host:{url,branch?},docs:{url,branch?,path:"project-docs"}}}
```

`path` 是 `project-docs/.meta/repositories.yaml` 的绝对路径。文件缺失报 `REPOSITORIES_NOT_FOUND`；未知键、坏 YAML、错误 schema、非法地址/分支、`docs.path` 不是 `project-docs`，或 `.meta`/配置文件是符号链接或越界路径时，报 `REPOSITORIES_INVALID`。既有项目没有该文件不影响其它旧命令。

### `ait repos set --host-url <url> --docs-url <url> [--host-branch <branch>] [--docs-branch <branch>]`

`--host-url` 和 `--docs-url` 都必需。命令完整验证后原子替换共享配置；它不合并旧的可选分支，因此省略 `--host-branch` 或 `--docs-branch` 会从新配置中删除对应旧值。成功返回与 `repos show` 相同的 `{path,repositories}`。

此命令只修改 `project-docs/.meta/repositories.yaml`，不修改两仓 Git remote，不 checkout 分支，不自动 commit 或 push。地址和分支采用与 `clone` 相同的安全规则；配置不得保存密码、私钥或带 token 的查询 URL。

```powershell
# 维护者从项目根登记双仓关系；文件保存到文档仓，随后审阅并提交。
ait repos set `
    --host-url 'git@example.invalid:team/project.git' `
    --docs-url 'git@example.invalid:team/project-docs.git' `
    --host-branch 'release' `
    --docs-branch 'docs-release'
ait repos show
```

### `ait init [--name <name>] [--check] [--refresh-wrapper] [--new-model]`

| 选项 | 默认值与行为 |
| --- | --- |
| `--name <name>` | 缺省从当前目录名派生；归一为小写字母、数字、下划线及短横线组成的根 ID 名称，空归一结果采用 `project` |
| `--check` | 默认不启用；只读检查项目骨架及本平台 wrapper，优先于刷新和初始化 |
| `--refresh-wrapper` | 默认不启用；重写当前平台 wrapper，不重建文档历史 |
| `--new-model` | 兼容空操作；指定与否不改变行为 |

正常初始化创建目录、初始 PRD/FSD 根与派生关系、独立文档 Git 仓库和本平台 wrapper；在宿主已有 Git 仓时维护其 `project-docs/` 忽略条目。重复运行保留已有内容，并报告跳过项。

初始化或刷新成功的 `data` 包含 `createdFiles: string[]`、`chunks: number`、`specs: number`、`status: "fresh"|"existing"`、`files: Record<string,string>` 和 `skipped: string[]`。检查分支返回 `{ok:boolean,missing:string[]}`，其中 `ok` 是内层检查结果。

无法确定可执行入口时报 `WRAPPER_PATH_UNRESOLVED`。目录结构、文件访问或 Git 初始化失败也会返回错误信封；初始化并非“检查失败后继续空项目”的降级入口。

## 版本命令

所有 `<id>` 均为明确的版本名，例如 `v0.1`，没有省略版本的默认值。名称不得包含路径分隔符、空字符或为 `.`、`..`。项目一次只有一个活动版本。

| 命令与全部参数 | 行为及成功 `data` |
| --- | --- |
| `ait version create <id>` | 建立版本工作区与元数据；返回 `{version,created_at,based_on}`，`based_on` 为此前最大已合入版本或 `null` |
| `ait version commit <id>` | 将 working/staged 条目置为 committed，记录变更并同步该版本图；返回 `{committed:string[],changes:string[]}` |
| `ait version status <id>` | 只读返回 `{version,phase,working:string[],staged:string[],committed:string[],by_action:Record<string,number>}` |
| `ait version confirm <id>` | 校验规格、图、治理和回执，执行验收并在验收后重检，保存确认计划；宿主为 Git 仓时提交并绑定制品提交；返回确认结果，见下表 |
| `ait version merge <id>` | 校验确认计划仍有效，按计划合入基线、提交文档仓并记录锚点；返回合入结果，见下表 |
| `ait version revert <id> [--confirm]` | `--confirm` 默认关闭，实际撤销必须显式提供；未合入版本撤销其版本工作，已合入版本按记录锚点回滚，返回撤销结果 |
| `ait version backfill-tags` | 无参数；补齐可验证的已合入版本 `ait/<版本>` 标签，已存在标签幂等跳过；返回补标签结果 |

| 结果 | 字段 |
| --- | --- |
| 确认结果 | `{version,passed:true,plan_fingerprint,planned_operations,conflict_policy,acceptance,generation_receipts,warnings,code_result}`；`code_result` 为宿主提交 SHA 或 `null` |
| 合入结果 | `{version,merged_chunks:string[],commit:string|null,git:"committed"|"unavailable",tag_created:boolean,plan_fingerprint,generation_receipts,warnings}` |
| 撤销结果 | `{version,reverted:true,mode:"unmerged"|"merged",docs_anchor:string|null,host_anchor:string|null,removed_versions:string[]}` |
| 补标签结果 | `{backfilled:string[],skipped:[{version,reason}],git:"committed"|"unavailable"}`；`reason` 为 `no_anchor`、`tag_present`、`no_docs_commit` 或 `tag_failed` |

`confirm` 是有副作用的操作，不是只读预览：验收可能改变制品，宿主 Git 提交及确认计划可能被保存。`merge` 需要该计划；规格、策略、交付、回执或制品等相关事实变化后计划可能失效。合入保留版本历史工作区。没有相应 Git 仓时，相关提交字段为 `null`，`git` 可为 `unavailable`，需按实际结果判断。

已合入版本的撤销依据记录恢复文档仓及有绑定的宿主仓，并清理后续版本；历史版本没有宿主绑定时只恢复文档仓。该命令具有实际回滚副作用，使用前核对目标版本和工作区状态。标签补齐只建立可验证锚点，不伪造缺失的历史提交。

常见拒绝包括：已有活动版本 `ACTIVE_VERSION_EXISTS`，多活动版本 `ACTIVE_VERSION_CONFLICT`，版本不存在 `VERSION_NOT_FOUND`，重复版本名或缺少回滚确认 `USAGE_ERROR`，无可提交条目 `COMMIT_EMPTY`，缺确认计划 `CONFIRMATION_REQUIRED`，计划过期 `CONFIRMATION_STALE`，验收未过 `ACCEPTANCE_FAILED`，回执阻断 `GENERATION_RECEIPTS_FAILED`，不变式失败 `INVARIANT_VIOLATION`。回滚预检/执行错误为 `REVERT_PRECHECK_FAILED` / `REVERT_FAILED`；Git 失败可为 `GIT_FAILED`，合入执行失败由 `MERGE_ROLLBACK` 报告其恢复情况。

`version commit` 没有 `--message`，`version confirm` 没有 `--conflict-policy`，`version merge` 没有 `--allow-dirty-git`。不能用这些未提供的选项绕过检查。

## PRD、FSD 与 TDD

### 创建和讨论的共用选项

```text
ait prd create <id> [共用选项]
ait fsd create <id> [共用选项] [--parent <prdRootId>]
ait tdd create <id> [共用选项] [--parent <fsdSplitId>]
ait fsd decompose <parentSplit> <childRootId> [共用选项]
```

| 共用选项 | 默认值、限制与含义 |
| --- | --- |
| `--content <text>` | 缺省不提供正文，进入讨论背景模式；显式空字符串仍是写入请求，按正文门禁校验 |
| `--content-file <path>` | 读取一次完整 UTF-8 正文；相对路径相对于当前项目根；与 `--content` 互斥，不可读时报 `USAGE_ERROR` |
| `--action <add|modify>` | 缺省时该 ID 已在基线中则 `modify`，否则 `add`；不一律默认 `add` |
| `--overrides <id>` | 缺省无替换；指定修改所替换的原根 chunk ID，用于根改名；内部 split ID 不支持改名 |
| `--context-token <token>` | 有正文写入通常必须提供同一意图的讨论令牌；与 `--skip-context` 互斥 |
| `--skip-context` | 默认关闭；明确跳过讨论时使用，仍执行内容、关系与相位门禁，并留下 `audit` |
| `--file <path>` | 缺省使用根 ID 作为文件名，置于当前层目录；允许当前层内相对路径、可选本层前缀和可选 `.md` 后缀，禁止绝对路径、`..` 和跨层路径 |

`--file` 的等价写法例如 TDD 的 `[TDD]-feature`、`[TDD]-feature.md`、`tdd/[TDD]-feature` 和 `tdd/[TDD]-feature.md`；子目录与 Windows 分隔符会归一。它指定受管理文档的逻辑路径，不是任意磁盘输出路径。TDD 的制品路径由正文 `target_file` 声明，和 `--file` 含义不同。

PRD 不支持父锚点；传 `--parent` 虽被解析器识别，仍返回 `USAGE_ERROR`。`fsd decompose` 的父级由位置参数给出，不接受 `--parent`。创建 FSD 根时父级是 PRD 根；创建 TDD 时父级是叶 FSD split；是否必须指定父级由新增/修改场景的领域规则判断，修改已有合法关系不要求重新发明父级。

这些命令操作活动版本，没有 `--version`。先执行 `version create`；FSD 写入要求 PRD 已确认，TDD 写入要求 FSD 已确认。ID 使用 `[PRD]-…`、`[FSD]-…`、`[TDD]-…`，split 使用 `<根ID>:<split名>`。

第一次不传正文取得背景；依据完整背景讨论后，携带令牌和相同目标、父级、action、overrides、file、操作意图提交。背景或意图改变后旧令牌失效。令牌证明上下文连续性，不证明操作者身份或授权。

讨论成功的 `data` 为：

```text
{mode:"discussion-context",version,layer,id,parent:string|null,background,context_token}
```

普通写入成功为：

```text
{mode:"written",layer,id,file,chunks:string[],edges:[{src,dst,rel}],phase,audit?}
```

`fsd decompose` 有正文时原子写入子 FSD 和 `decomposes` 边，返回：

```text
{mode:"written",src,dst,rel:"decomposes",file,phase,audit?}
```

无正文的 `decompose` 取得讨论背景，不登记一条关系。`audit` 仅在跳过讨论时出现，为 `{skip_context:true,at:string}`。讨论模式不写元数据，写入前的参数/正文门禁拒绝不会把无效正文作为部分文档保存。

正文必须包含请求根 chunk 的 `<!-- @id:… -->` 与自身内容。提交根及本次新增或变化的 chunk 即可，省略的既有 chunk 不表示删除；`action=add` 不得重传基线已有 chunk。PRD 需求 chunk 应含 `**用户故事:**` 和 `#### 验收标准` 下的编号 EARS 条目；PRD 根承载概述、范围、目标和反向要求。TDD 根须有唯一目标声明：

````markdown
<!-- @id:[TDD]-feature -->
## feature 文件实现

```yaml
target_file: src/feature.ts
```

此文件的功能、边界和验证要求。
````

`target_file` 是宿主项目内的制品相对路径，须通过当前项目的范围治理规则；不同 TDD 不得占有同一目标。

### 层确认和返工

| 命令 | 前置状态及行为 |
| --- | --- |
| `ait prd confirm` | PRD 创建相位；提交本层条目并冻结，进入 `prd-confirm` |
| `ait prd revert` | `prd-confirm`；本层返工，回到 `prd-creating` |
| `ait fsd confirm` | FSD 创建相位；提交本层条目并冻结，进入 `fsd-confirm` |
| `ait fsd revert` | `fsd-confirm`；本层返工，回到 `fsd-creating` |
| `ait tdd confirm` | TDD 创建相位；提交本层条目并冻结，进入 `tdd-confirm` |
| `ait tdd revert` | `tdd-confirm`；本层返工，回到 `tdd-creating`，旧交付及计划可能失效 |

六个命令均无位置参数和选项；确认返回 `{version,confirmed:string[],phase}`，返工返回 `{version,reverted:string[],phase}`。返工是对应层的成对操作，不能从任意后续相位直接跳回较早层。版本整体撤销使用 `version revert`。

层确认已提交本层的 working 条目，完整逐层确认后通常无需额外 `version commit`；无剩余可提交条目再调用会报 `COMMIT_EMPTY`。版本合入仍需 `version confirm` 和 `version merge`。

文档常见错误：`NO_ACTIVE_VERSION`、`PRD_NOT_CONFIRMED`、`FSD_NOT_CONFIRMED`、`TDD_NOT_CONFIRMED`，以及 `PRD_LAYER_NOT_OPEN` / `FSD_LAYER_NOT_OPEN` / `TDD_LAYER_NOT_OPEN`。正文或关系问题可能为 `ROOT_CHUNK_REQUIRED`、`PRD_REQUIREMENT_CONTRACT_VIOLATION`、`TDD_TARGET_FILE_REQUIRED`、`DUPLICATE_BASELINE_CHUNK`、`DUPLICATE_TARGET_FILE`、`CHUNK_LOCKED`、`MISSING_ENDPOINT`、`TDD_MULTI_PARENT`、`PRD_FSD_LINK_NOT_UNIQUE`、`INVALID_FILE_NAME`、`FSD_DECLARATION_INVALID`、`DERIVES_NOT_PRD` 或 `MARKDOWN_CONTAINS_RELATION`。令牌问题为 `CONTEXT_TOKEN_INVALID` / `CONTEXT_TOKEN_STALE`，根替换冲突在版本校验时可报 `MODIFY_RENAME_COLLISION` / `DUPLICATE_OVERRIDES_TARGET`。

## 图、依赖与影响

### 四种关系

| 关系 | 意义与创建入口 | 查询开关 |
| --- | --- | --- |
| `derives` | PRD 派生 FSD；根关系随 `fsd create --parent` 建立，需求到 FSD split 的声明由 FSD 正文的受支持 YAML 维护 | `--derives` |
| `decomposes` | FSD split 向下分解为子 FSD 根；随 `fsd decompose` 建立 | `--decomposes` |
| `details` | 叶 FSD split 细化为文件级 TDD；随 `tdd create --parent` 建立 | `--details` |
| `depends_on` | 同父 FSD 兄弟 split 间的依赖；由 FSD split 的 `depends_on` YAML 声明维护 | `--depends-on` |

CLI 不提供独立的 `link` / `depend` 命令。关系随合法的规格写入维护，不能通过手改图文件建立。FSD YAML 中关系值使用原拼写，例如 `depends_on: [shared]`；`--depends-on` 只是 CLI 开关的拼写。

### `ait deps <target> [--direction <in|out|both>]`

`target` 是 chunk ID；`--direction` 默认 `both`。只查询直接邻边，不递归。默认读“当前基线 + 活动版本”，没有活动版本则读基线。该命令不接受关系开关或 `--version`；需要筛选时使用 `specgraph query`。

### `ait specgraph query <target> [--direction <in|out|both>] [--derives] [--decomposes] [--details] [--depends-on] [--version <v>]`

| 参数 | 默认与精确语义 |
| --- | --- |
| `<target>` | 必需，chunk ID，不是文件路径 |
| `--direction out` | 仅 `src == target` 的出边 |
| `--direction in` | 仅 `dst == target` 的入边 |
| `--direction both` | 默认；入边与出边 |
| 四个关系开关 | 默认均不指定，表示不过滤；指定多个取关系并集，再与方向相交；不会改变默认方向 |
| `--version <v>` | 缺省取唯一活动版本，无活动版本取基线；显式 `baseline` 只查基线；其他值须为存在的版本 |

指定版本查询的是“当前基线 + 该版本”的组合视图，不承诺还原该版本发布时的历史快照，不切换活动版本或写元数据。默认选择遇到多个活动版本报 `ACTIVE_VERSION_CONFLICT`；显式不存在版本报 `VERSION_NOT_FOUND`，不能因缺少版本图而伪装成功。合法空版本图仍可与基线组合。

`deps` 和 `specgraph query` 的成功 `data` 均为：

```text
{found:boolean,target:string,direction:"in"|"out"|"both",edges:[{src,dst,rel,metadata}]}
```

边端点为 chunk ID，`metadata` 为事实对象。未知目标成功返回 `found:false,edges:[]`。未过滤关系时可以返回历史图的其他关系；四个开关全选只返回指定四种关系。旧方向 `from/to` 以及旧开关 `--deps/--implements` 均报 `USAGE_ERROR`。

```sh
ait specgraph query "[FSD]-demo:feature" --details --depends-on --direction out --version v0.13
ait specgraph query "[PRD]-demo" --derives --version baseline
ait deps "[TDD]-feature" --direction in
```

第一条要求项目中存在 `v0.13`；示例 ID 应替换为实际 chunk ID。省略方向始终为 `both`，不会因为只选 `--depends-on` 就自动变为出边。

### 其他图命令

| 命令与全部参数 | 行为及成功 `data` |
| --- | --- |
| `ait impact <target>` | 默认活动版本叠加基线，沿图规则计算影响闭包；返回 `{found:boolean,impacted:string[],count:number}`，未知目标为空结果 |
| `ait specgraph sync` | 写操作，同步基线及未合入版本图，返回基线存储图 `{version,updated,specs,edges}` |
| `ait specgraph export [--version <v>]` | 只读；默认导出基线存储图，指定时导出对应存储图，返回 `{version,updated,specs,edges}`；不返回 query 的组合视图 |
| `ait specgraph validate-new-model [--version <v>]` | 只读诊断；默认活动版本/基线，显式已合入版本仍按既有规则检查当前基线；返回验证报告 |

存储图中的 `version` 是数据格式版本。`export` 保留存储图的缺失处理规则，不是版本存在性检查入口。`validate-new-model` 指定未找到的版本返回 `VERSION_NOT_FOUND`；它的版本参数与 `query --version baseline` 的特殊选择规则不可互换。

验证报告为 `{version,passed,violations,policy_violations,warnings,target_file_missing,derives_residue}`。`passed` 仅反映图不变式；治理阻断另列于 `policy_violations`，不能只看 `passed:true` 就认为版本可合入。图约束包括派生归属、文件目标唯一性、无孤儿、可追溯和树无环等。合法读取返回发现时外层仍为成功，退出 `0`；损坏图/索引等读取错误返回错误信封。不要用 `sync` 代替只读刷新。

## 检索与基线摘要

### `ait search <query> [--scope <baseline|all>] [--regexp]`

`query` 必填；默认在基线中按大小写不敏感的字面量子串匹配。`--scope all` 包含版本工作区；`--regexp` 默认关闭，开启后按大小写不敏感正则解释查询。

成功 `data` 为 `{query,count,hits:[{chunkId,file,heading,version,matches:[{line,text}]}]}`。无命中为 `count:0,hits:[]`；空或纯空白查询报 `SEARCH_EMPTY_QUERY`，非法正则报 `USAGE_ERROR`。文件解析或读取错误不会被吞成空命中。

```sh
ait search "target_file"
ait search "confirm|merge" --scope all --regexp
```

### `ait baseline-summary [--scope <prd|all>] [--format <yaml|json>]`

命令始终返回基线摘要，默认 `scope=all`、`format=yaml`，没有按“是否给参数”切换到统计的分支。CLI 仅接受 `prd/all` 两种 scope；不接受 `fsd/tdd`，也没有统计 CLI 命令。

摘要项为 `{id:string,heading:string,summary:string|null}`，保持基线索引顺序。`all` 包含全部基线条目，不混入活动版本；`prd` 按规范化文件层级和新模型 ID 筛选 PRD。缺摘要保留 `null`，不自动生成摘要。无法归层的历史条目可保留在 `all` 中。

| 调用 | 成功 stdout |
| --- | --- |
| `ait baseline-summary` | 全量摘要项的 YAML 序列 |
| `ait baseline-summary --scope prd` | PRD 摘要项的 YAML 序列 |
| `ait baseline-summary --scope all --format yaml` | 同默认调用 |
| `ait baseline-summary --format json` | `{"ok":true,"data":[{"id":…,"heading":…,"summary":…}]}` |
| `ait baseline-summary --scope prd --format json` | 同一 JSON 信封，`data` 数组只含 PRD 摘要 |

默认 YAML 示例：

```yaml
- id: "[PRD]-demo"
  heading: demo 产品 PRD
  summary: null
```

JSON 的 `data` 是数组，不是 `{scope,items}` 对象，也不是数字键对象。空结果分别输出 YAML `[]` 或 `{"ok":true,"data":[]}`，退出 `0`。所有格式的失败都输出单 JSON 错误信封并退出 `1`，例如损坏索引为 `INDEX_UNREADABLE`。读取摘要不会自动 `reindex`。需要统计或 Node DTO 的集成见 [Node API 参考](node-api.md)。

## 状态与索引

### `ait state [--version <v>] [--format <markdown|json>] [--save]`

| 选项 | 默认值与行为 |
| --- | --- |
| `--version <v>` | 缺省取活动版本；无活动版本报 `NO_VERSION`；显式版本不存在报 `VERSION_NOT_FOUND`，可读取已合入版本 |
| `--format markdown` | 默认；成功信封的 `data` 为 `{version,format:"markdown",content:string}`，stdout 本身仍为 JSON |
| `--format json` | 返回结构化面板 |
| `--save` | 默认关闭；保存该版本的 `state.md`，返回所选格式加 `saved_to`；保存文件始终是 Markdown |

结构化面板包含 `version`、`title:string|null`、`phase`、`prd_locked`、`impl_locked`、`merged`、`working/staged/committed:string[]`、`by_action`、`prd_chunks/fsd_chunks/tdd_chunks:string[]` 与 `counts:{working,staged,committed,prd,fsd,tdd}`。

未使用 `--save` 时只读，不推进相位或修复存储。保存目标为 `project-docs/versions/<v>/state.md`，不接受任意输出路径；返回内容与保存内容取自同一次状态读取。

### `ait reindex`

无参数。扫描基线文档并重建基线索引，返回 `{version,scope,updated,chunks}`，其中 `version` 是索引格式版本。这是写操作；源文档解析和读取错误如实返回，不适合作为只读查询前的自动步骤。

## 验收与发布

| 命令与全部参数 | 默认、结果与副作用 |
| --- | --- |
| `ait acceptance set <command>` | 接收一个完整 shell 命令字符串，写入本地配置；返回 `{command:string}`，此次不运行验收 |
| `ait acceptance show` | 无参数，只读生效配置；本地覆盖共享配置，返回 `{command:string|null}` |
| `ait acceptance run` | 无参数，在宿主根执行生效命令；返回 `{ran:boolean,passed:boolean,exitCode:number|null}` |
| `ait push [--dry-run]` | 默认真实推送；`--dry-run` 只检查；先宿主仓后文档仓，返回 `{host,docs}` |

```sh
ait acceptance set "npm test"
ait acceptance show
ait acceptance run
ait push --dry-run
```

未配置验收时返回 `{ran:false,passed:true,exitCode:null}`，表示跳过，不表示已经运行测试。配置存在但损坏时报 `CONFIG_UNREADABLE`，不会降级成跳过。独立验收可能修改制品；`version confirm` 会再次执行验收并重检，回执所绑定的文件变化后需要处理新的交付和回执。

推送的每仓结果为 `{status:"pushed"|"nothing"|"failed"|"not_applicable",detail:string}`。无远端或无上游在 `detail` 中分别报告 `PUSH_NO_REMOTE` / `PUSH_NO_UPSTREAM`，通常不改变外层成功信封。推送当前分支，文档仓附带 AIT 标签，不自动创建远端或上游、不强推，也不撤回已经成功的一侧；未提交改动不会被发送。脚本应逐仓检查结果，不能只看 AIT 退出码。

## 生成交付与纯 CLI 回执

### `ait codegen prepare <tddRootId> [--version <v>]`

`tddRootId` 必需，为 TDD 根 ID。版本缺省选择活动版本，无活动版本时读基线；指定版本仍须满足版本存在性、未合入状态和 TDD 已确认等门禁。基线交付的 `version` 为 `null`。

命令提取完整 TDD、上游 FSD/PRD、相关依赖与目标文件现状，将完整 bundle 写入仓外临时文件，校验后登记交付并签发令牌。它有交付登记副作用，不是单纯读取。CLI 固定使用文件交付，没有 `--output` 或 `--format` 参数；stdout 不展开 bundle 正文。

成功 `data`：

| 字段 | 含义 |
| --- | --- |
| `bundle_path: string` | 仓外临时文件绝对路径 |
| `sha256: string` | 完整 bundle 的 SHA-256 |
| `bytes: number` | 完整 UTF-8 字节数 |
| `version: string|null` | 交付绑定版本；基线为 `null` |
| `target_file: string` | 本次生成的唯一目标制品，相对于宿主根 |
| `tdd_root: string` | TDD 根 ID |
| `source_file: string` | TDD 规格来源 |
| `generation_token: string` | 后续登记本次生成回执的令牌 |

调用方应核对文件字节数与 hash，完整读取正文，按其中的目标状态和规格生成制品，不用截断的工具输出或摘要替代全文。目标状态包含于 bundle；CLI 指针不另加 `target_state` 字段。目标不可读时应由调用方先处理该事实，不能把它当作不存在而覆盖。

CLI 不调用 LLM、不启动生成 agent、不替调用方修改目标代码。`prepare` 之后何时生成、测试及登记由调用方安排。

### `ait codegen receipt --generation-token <token>`

没有位置参数，令牌必填。core 根据当前有效交付读取实际目标文件并计算 SHA-256，返回：

```text
{version:string|null,tdd_root,target_file,bundle_sha256,artifact_sha256,generated_at}
```

不能传 `--artifact-sha256`、目标路径或自行构造元数据代替核验。同一有效令牌及相同制品重复登记保持幂等；令牌或交付过期、规格变化、制品缺失/不可读都会拒绝。已登记后制品变化时，须重新准备交付并验证制品后再登记。

回执记录“此制品 hash 对应此交付”，不证明生成者身份、曾运行哪些测试或业务语义正确。基线令牌可登记 `version:null` 回执。

已合入版本的回执是历史只读证据。合入后当时的 write token 过期，不会反向令历史回执失效；核对时同时区分历史合入记录与当前文件的实时指纹。若当前字节偏离历史记录，应报告 current drift，并通过新版本重新 prepare、生成、登记、验收和合入，不能复用旧 token 或重写历史回执。

### `ait codegen verify --version <v>`

没有位置参数，版本必填；只读核验版本回执，不提供基线 verify 模式。成功 `data` 为：

```text
{enforcement:"report"|"block",passed:boolean,findings:[{code,message,tdd_root,target_file}]}
```

默认回执策略为 `report`，项目可配置为 `block`。`report` 下存在发现时也可能 `passed:true`；`block` 下阻断发现使 `passed:false`，外层调用正常时仍退出 `0`。必须同时查看策略、`passed` 和 `findings`。

交付与回执常见错误包括 `TDD_NOT_FOUND`、`TDD_NOT_CONFIRMED`、`TARGET_FILE_MISSING`、`CODEGEN_SOURCE_MISSING`、`CODEGEN_CHUNK_MISSING`、`TRACE_BROKEN`、`SPEC_CYCLE`、`DELIVERY_PATH_INVALID`、`DELIVERY_CONTENT_MISMATCH`、`GENERATION_TOKEN_INVALID`、`GENERATION_TOKEN_STALE`、`GENERATION_SPEC_CHANGED`、`GENERATION_ARTIFACT_MISSING`、`GENERATION_ARTIFACT_UNREADABLE` 和 `GENERATION_ARTIFACT_CHANGED`。核验可在 `findings` 中报告 `GENERATION_RECEIPT_MISSING` 等问题；实际版本确认/合入按当前策略执行门禁。

## 完整 PowerShell 示例

以下示例使用 PowerShell 7、Node.js 22+、Git 和已安装的 `ait`。在一个新建的空目录中运行；示例初始化独立文档仓，创建 `v0.1` 并最终合入。它不向远端推送。已有项目应使用自己的 ID、版本、规格和验收命令。

示例规格定义一个导出 `greet(name)` 的 `hello.mjs`，直接运行时验证 `Ada` 和空字符串两个输入。三份草稿写入普通 `.cli-drafts` 目录，通过 CLI 纳管。初始化根与示例功能根使用不同 ID。

### 初始化和统一结果读取

```powershell
ait init --name cli-demo
if ($LASTEXITCODE -ne 0) { throw '初始化失败' }
$ait = Join-Path (Get-Location) 'project-docs/.ait/ait-cli.cmd'
# Linux/macOS 的 PowerShell 将上一行末尾改为 project-docs/.ait/ait-cli。

function Invoke-Ait {
    param([Parameter(Mandatory)][string[]] $CliArgs)
    $raw = & $ait @CliArgs
    $exitCode = $LASTEXITCODE
    $result = ($raw -join "`n") | ConvertFrom-Json
    if ($exitCode -ne 0 -or -not $result.ok) {
        throw "$($result.code): $($result.error)"
    }
    return $result.data
}

$check = Invoke-Ait -CliArgs @('init', '--check')
if (-not $check.ok) { throw "项目缺少: $($check.missing -join ', ')" }
$null = Invoke-Ait -CliArgs @('version', 'create', 'v0.1')
New-Item -ItemType Directory -Path '.cli-drafts' -Force | Out-Null
```

辅助函数只解析 stdout；进度继续走 stderr。该函数适用于 JSON 命令，摘要调用须显式使用 `--format json`。

### 讨论、写入和分层确认

每层先显示完整背景，再提交同一意图。下列草稿是本例固定需求；实际工作应依据背景与讨论结果调整草稿。

````powershell
$prdContext = Invoke-Ait -CliArgs @('prd', 'create', '[PRD]-hello_cli')
Write-Host $prdContext.background
@'
<!-- @id:[PRD]-hello_cli -->
## 问候功能
提供可独立运行和验证的问候模块。

<!-- @id:[PRD]-hello_cli:greeting -->
## 生成问候
**用户故事:** 作为模块使用者，我希望得到指定名称的问候，以便显示一致的欢迎文本。
#### 验收标准
1. WHEN 输入名称 Ada THEN 系统 SHALL 返回 Hello, Ada!。
2. WHEN 输入空字符串 THEN 系统 SHALL 返回 Hello, !。
'@ | Set-Content -LiteralPath '.cli-drafts/prd.md' -Encoding utf8
$null = Invoke-Ait -CliArgs @('prd', 'create', '[PRD]-hello_cli',
    '--content-file', '.cli-drafts/prd.md', '--context-token', $prdContext.context_token)
$null = Invoke-Ait -CliArgs @('prd', 'confirm')

$fsdContext = Invoke-Ait -CliArgs @('fsd', 'create', '[FSD]-hello_cli',
    '--parent', '[PRD]-hello_cli')
Write-Host $fsdContext.background
@'
<!-- @id:[FSD]-hello_cli -->
## 问候模块
一个模块提供问候功能与直接运行时的自检。

<!-- @id:[FSD]-hello_cli:greeting -->
## 问候文件
```yaml
derives: ["[PRD]-hello_cli:greeting"]
```
导出 greet(name)，返回 Hello, 加名称及感叹号；包含固定样例自检。
'@ | Set-Content -LiteralPath '.cli-drafts/fsd.md' -Encoding utf8
$null = Invoke-Ait -CliArgs @('fsd', 'create', '[FSD]-hello_cli',
    '--parent', '[PRD]-hello_cli', '--content-file', '.cli-drafts/fsd.md',
    '--context-token', $fsdContext.context_token)
$null = Invoke-Ait -CliArgs @('fsd', 'confirm')

$tddContext = Invoke-Ait -CliArgs @('tdd', 'create', '[TDD]-hello_cli',
    '--parent', '[FSD]-hello_cli:greeting')
Write-Host $tddContext.background
@'
<!-- @id:[TDD]-hello_cli -->
## hello.mjs 文件实现
```yaml
target_file: hello.mjs
```
使用 Node.js ESM，导出 greet(name)，返回模板字符串 Hello, ${name}!。
使用 node:assert/strict 核验 Ada 返回 Hello, Ada!，空字符串返回 Hello, !。
运行 node hello.mjs 时执行这两个断言；成功退出 0，失败非 0。
只生成 hello.mjs，不修改 AIT 元数据。
'@ | Set-Content -LiteralPath '.cli-drafts/tdd.md' -Encoding utf8
$null = Invoke-Ait -CliArgs @('tdd', 'create', '[TDD]-hello_cli',
    '--parent', '[FSD]-hello_cli:greeting', '--content-file', '.cli-drafts/tdd.md',
    '--context-token', $tddContext.context_token)
$null = Invoke-Ait -CliArgs @('tdd', 'confirm')
````

### 交付、生成、回执与合入

```powershell
$delivery = Invoke-Ait -CliArgs @('codegen', 'prepare', '[TDD]-hello_cli', '--version', 'v0.1')
$actualBytes = (Get-Item -LiteralPath $delivery.bundle_path).Length
$actualHash = (Get-FileHash -LiteralPath $delivery.bundle_path -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualBytes -ne $delivery.bytes -or $actualHash -ne $delivery.sha256) {
    throw '交付字节数或 SHA-256 不匹配'
}
$bundle = Get-Content -LiteralPath $delivery.bundle_path -Raw -Encoding utf8
Write-Host $bundle
if ($delivery.target_file -ne 'hello.mjs' -or $delivery.version -ne 'v0.1') {
    throw '交付目标或版本与本例不符'
}

# 操作者完整读取 bundle，依据规格生成唯一目标。
# 实际接入可由调用方在此调度隔离生成器，并限制其可写目标。
@'
import assert from 'node:assert/strict';
export function greet(name) {
  return `Hello, ${name}!`;
}
assert.equal(greet('Ada'), 'Hello, Ada!');
assert.equal(greet(''), 'Hello, !');
'@ | Set-Content -LiteralPath $delivery.target_file -Encoding utf8

node hello.mjs
if ($LASTEXITCODE -ne 0) { throw '生成制品自检失败' }
$receipt = Invoke-Ait -CliArgs @('codegen', 'receipt',
    '--generation-token', $delivery.generation_token)
$artifactHash = (Get-FileHash -LiteralPath 'hello.mjs' -Algorithm SHA256).Hash.ToLowerInvariant()
if ($receipt.artifact_sha256 -ne $artifactHash) { throw '回执与制品不一致' }
$verification = Invoke-Ait -CliArgs @('codegen', 'verify', '--version', 'v0.1')
if (-not $verification.passed -or $verification.findings.Count -ne 0) {
    throw '本例要求回执核验通过且无发现'
}

$null = Invoke-Ait -CliArgs @('acceptance', 'set', 'node hello.mjs')
$acceptance = Invoke-Ait -CliArgs @('acceptance', 'run')
if (-not $acceptance.ran -or -not $acceptance.passed) { throw '验收未执行或未通过' }
$confirmed = Invoke-Ait -CliArgs @('version', 'confirm', 'v0.1')
$merged = Invoke-Ait -CliArgs @('version', 'merge', 'v0.1')
$null = Invoke-Ait -CliArgs @('state', '--version', 'v0.1', '--format', 'json')
$summary = Invoke-Ait -CliArgs @('baseline-summary', '--scope', 'prd', '--format', 'json')
$neighbors = Invoke-Ait -CliArgs @('specgraph', 'query', '[FSD]-hello_cli:greeting',
    '--details', '--direction', 'out', '--version', 'baseline')
```

本例的 hash 读取是对 CLI 交付和回执的独立检查，回执中的 `artifact_sha256` 始终由 core 计算。完整流程不调用 Node API bridge，也不手写 generation 记录。多个目标须各有唯一 TDD，分别 prepare、生成和登记；所有 AIT 元数据写入串行完成。

## 错误处理与恢复

失败信封中的 `code` 用于程序分支，`error` 保留具体文件、ID 或阶段说明。以下是跨命令常见错误；命令专有错误见各节。

| 错误码 | 含义与处理 |
| --- | --- |
| `USAGE_ERROR` | 修正未知参数、互斥参数、非法枚举或缺失值后重试；不通过改元数据绕过 |
| `REPOSITORIES_NOT_FOUND`、`REPOSITORIES_INVALID` | clone 读取或 repos show/set 使用的共享仓库配置缺失、不安全或内容非法；修复文档仓中的受管配置，不把它当作覆盖本地文件的授权 |
| `CLONE_DIRECTORY_NOT_EMPTY` | 首次 clone 的最终项目根非空，或残留不满足受管恢复布局；选择真正空目录，或只在匹配的恢复记录上以相同参数续跑 |
| `CLONE_REPOSITORY_MISMATCH`、`CLONE_STATE_INVALID` | 恢复记录、参数、origin、分支、commit、Git 根或工作区事实不一致；保留现场核对，不 reset/clean/force 后冒充同一次恢复 |
| `CLONE_PATH_CONFLICT` | 目标位于危险根、链接路径、祖先 Git 工作树中，或宿主树与 `project-docs` 冲突；更换安全空目录或修复远端树布局 |
| `CLONE_BRANCH_NOT_FOUND` | 显式分支、配置分支或远端默认分支不存在/未指向提交；修正来源或分支后按错误现场决定首次重试或匹配续跑 |
| `CLONE_GIT_FAILED`、`CLONE_PROJECT_INVALID` | Git 阶段失败，或恢复后的 AIT 项目结构、索引、规格图、wrapper 检查未通过；错误文字含阶段和保留位置，修复原因后用相同参数安全续跑 |
| `NOT_AT_PROJECT_ROOT`、`CWD_INSIDE_PROJECT_DOCS`、`PROJECT_DOCS_MALFORMED` | 切到正确宿主根，检查项目布局；不要从 `project-docs` 内运行 |
| `CONFIG_UNREADABLE`、`INDEX_UNREADABLE`、`GRAPH_UNREADABLE`、`CHUNK_PARSE_ERROR` | 存储不可读或结构损坏；保留错误定位，恢复合法来源，不能将错误视为无数据 |
| `SPEC_CONTENT_MISMATCH`、`MERGE_SOURCE_MISSING`、`MERGE_TARGET_MISSING`、`GOVERNANCE_SOURCE_MISSING` | 索引、关系、版本身份与真实规格不一致，或所需来源缺失；核对原始状态 |
| `NO_ACTIVE_VERSION`、`NO_VERSION` | 文档写入缺活动版本 / 状态查询缺版本；根据工作目的创建版本或显式查询已有版本 |
| `CONTEXT_TOKEN_INVALID`、`CONTEXT_TOKEN_STALE` | 重新以相同最终意图获取完整背景，讨论后使用新令牌 |
| `GENERATION_TOKEN_INVALID`、`GENERATION_TOKEN_STALE`、`GENERATION_SPEC_CHANGED` | 重新取得完整交付，依据当前规格生成或核对制品，再登记回执 |
| `GENERATION_ARTIFACT_MISSING`、`GENERATION_ARTIFACT_UNREADABLE`、`GENERATION_ARTIFACT_CHANGED` | 核对真实目标与最新交付；文件变化后旧回执不能冒充当前制品 |
| `TARGET_FILE_SCOPE_ESCAPE`、`TEST_SCOPE_PARENT_MISMATCH`、`INVALID_TARGET_FILE` | 目标路径或父级不符合当前制品治理规则，修正规格后重新走写入流程 |
| `CONFIRMATION_REQUIRED`、`CONFIRMATION_STALE` | 缺少当前有效确认计划；先检查版本、图和回执，再执行有副作用的确认 |
| `ACCEPTANCE_FAILED`、`GENERATION_RECEIPTS_FAILED` | 处理实际测试或回执发现，再验证；不通过改弱结果或伪造 hash 放行 |
| `REVERT_PRECHECK_FAILED`、`REVERT_FAILED`、`GIT_FAILED`、`MERGE_ROLLBACK` | 根据具体错误及实际双仓状态恢复；不要盲目重复 Git 或回滚动作 |
| `INTERNAL_ERROR` | 未预期异常，保留消息及现场，检查实际状态后处理 |

读取失败、写前校验拒绝、事务恢复和外部验收/Git 副作用的边界不同，不能把所有失败理解成“所有文件均未改变”。失败后用 `version status`、`state`、`specgraph query`、`specgraph validate-new-model` 或 `codegen verify` 等只读命令核对事实。`confirm`、`sync` 和 `reindex` 不属于只读刷新；发布、确认、合入和回滚不应自动重试。
