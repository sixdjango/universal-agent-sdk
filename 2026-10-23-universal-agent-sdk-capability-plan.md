# Universal Agent SDK 核心能力演进计划：独立运行与宿主嵌入

- 日期：2026-10-23
- 状态：设计与实施计划；本次仅修订文档，不修改 SDK 实现。
- 目标：完善 SDK 自身的 Agent 执行与原生 Flow 能力，同时支持 `workflow-server` 独立运行和 Symphony 等宿主直接嵌入。
- 适配方向：**Symphony 适配 SDK 的公开契约与 Flow 模型。Symphony 的旧实现不作为 SDK 必须复刻的规格。**
- 源码基线：当前 AHOP 仓库，根 package 版本 `0.1.2`，基准 commit `906d4bc2afe8c8bd8a8098fc47474e41208116b6`；未核验 npm 发布产物。
- 验证范围：SDK 源码复核，以及使用内存 Store 和 mock Executor 的最小运行复现；未执行真实 Agent、完整测试套件、构建、Desktop 打包或 Windows 验证。
- Symphony 侧信息：来自原提案的需求描述与文件线索，本次未独立核验其源码。旧功能是否迁移由 Symphony 接入工作确认，不据此扩大 SDK 的承诺范围。
- 文中的接口扩展、阶段验收和待办均为拟实施要求，不表示已经交付。

## 1. 目标、取舍与现有设计保护

本计划从 Symphony 的需求中筛选值得进入 SDK 的通用核心能力。SDK 应形成清晰、可靠的执行模型，Symphony 未来通过适配层使用它，逐步替换自有 Agent 执行和 Flow 编排核心；没有 Symphony 时，现有 server 仍能提供完整的独立运行路径。

“Flow 更优”是设计目标，需要通过执行正确性、数据来源可追溯、恢复行为明确、资源有界和接入复杂度下降来验证。验收以 SDK 的公开语义为准，不要求与 Symphony 的所有旧行为相同。

### 1.1 保留的架构

- 保留 `agent-client`、`workflow-contract`、`workflow-runtime`、`workflow-node`、`workflow-agents`、`workflow-server` 的职责分层。
- 保留分层 DAG、控制边/数据边分离、Loop/Parallel 容器、ContextManifest、不可变产物、CAS/epoch 和现有 ports。
- 保留 `WorkflowRuntime` 的直接调用方式；优先补齐 `UniversalAgentExecutor`、`RunService` 等现有组件，不再叠加职责重复的执行框架。
- 保留 `WorkflowHost`、本地 Registry、默认 SQLite 存储、工作区管理和 server 的便捷组装路径。嵌入方式与独立方式共用核心实现。
- 不为 Symphony 的节点名称、V2 JSON 形状、特定 Inline 层数、业务修复规则或旧交互习惯修改 SDK 的基本图模型。

### 1.2 变更约束

1. **先修正确性，再接通已有能力，最后考虑新抽象。** 每项任务须标明属于修复、接口补通、通用增强还是候选扩展。
2. 保留现有公开入口；新增参数优先可选。终态、权限、attempt 身份等行为修正即使不改变函数签名，也必须说明兼容影响并补回归用例。
3. 新的严格输入输出或配置要求须显式声明；旧定义的解释遵守执行格式版本，不能借新默认值静默改变历史运行。
4. 跨包重构、持久化格式变化、完整 Conversation 和历史 Fork，先提交独立设计，说明不能通过现有 ports 解决的原因、迁移方式和验证范围，再进入实现。只有实际耦合阻塞接入时才扩展 ports，不预先抽象所有可能的宿主。
5. 每批变更保持两种运行路径可用；不得以“可嵌入”为由移除独立运行的默认实现。
6. 当前计划不授权大范围重写 Runtime，也不要求一次性实现全部候选能力。

## 2. SDK、server 与宿主的边界

### 2.1 能力落点

这里的“核心 SDK”是可直接导入的库集合，不意味着把所有代码塞进 `workflow-runtime`。纯执行语义与 Node.js 进程、文件、数据库实现仍保持分层。

| 包/层 | 应承担的职责 | 约束 |
| --- | --- | --- |
| `acp-extension-core` / adapters / `agent-client` | ACP 协议、引擎适配、会话与 turn、权限能力映射、进程生命周期、事件与 usage | 不理解 Symphony 的 Task/Project；不依赖 workflow-server |
| `workflow-contract` | SDK 原生 Flow 定义、校验、编译、能力声明、来源映射与版本契约 | 不接受 Symphony 专有定义作为内核契约 |
| `workflow-runtime` | 调度、attempt 状态转换、数据提交、等待、重试、循环/并行、失效与恢复判定；相关 ports | 无 HTTP/Fastify/业务数据库依赖；宿主不复制这些状态机 |
| `workflow-node` | Agent/Script 执行器、进程与日志、默认存储、租约、工作区；可直接调用的运行驱动服务 | 属于可嵌入 SDK；Node 能力无需搬入纯 Runtime |
| `workflow-agents` | Agent Registry 默认实现、Chief 实现与便捷组装 | 使用宿主快照时可绕开本地可编辑配置库；Chief 决策受 Runtime 策略校验 |
| `workflow-server` | 独立应用的默认组装、HTTP/SSE、请求身份接入、传输校验、错误映射、静态页面 | 调用 SDK 完成执行操作，不另写调度、恢复、结果校验或会话状态机 |
| `workflow-web` / `workflow-ui` | 编辑器、状态展示与交互 | 核心执行不依赖界面存在 |

依赖方向保持为：server/宿主调用 SDK；SDK 不反向依赖 server、web 或 Symphony。HTTP/SSE 的连接、鉴权接入和传输背压属于 server；事件身份、游标、核心缓冲上限与持久化语义属于 SDK。

### 2.2 两种一等使用方式

**独立运行**：server 使用默认 `WorkflowHost`、Registry、SQLite、WorkspaceManager 和执行器，提供配置、启动、查看、回答、停止、恢复等入口。用户不需要 Symphony，也不应被要求先自行实现一组 ports 才能使用。现有默认目录和 CLI 方式继续保留。

**宿主嵌入**：Symphony 在自己的进程或受控 worker 中直接调用 SDK，提供授权结果、冻结配置和必要的存储/工作区适配器。无需启动 SDK 管理 HTTP 服务，不强制创建第二套 Agent/Flow 配置库或额外的 SDK 数据库。宿主可选用默认适配器，不必全部自写。

两种方式调用相同执行逻辑。具体 Agent 或 MCP 传输需要的子进程、端口由显式配置控制，不等同于要求宿主启动 `workflow-server`。

### 2.3 SDK 与 Symphony 的责任

| 事项 | SDK | Symphony |
| --- | --- | --- |
| Flow 模型 | 定义原生图语义、校验与编译规则 | 调整编辑器/发布入口；需要时转换或重建旧 Flow |
| 执行 | Agent/Script 生命周期、节点推进、重试、等待、恢复、事件 | 选择何时提交运行、业务关联与展示 |
| 权限 | 执行给定策略、校验能力、报告生效结果，禁止静默提升 | 用户身份、项目权限、工具/目录/外部动作的业务授权 |
| 配置与 Provider | 消费冻结选择与按次启动资源，维护会话兼容性 | 权威配置、账号和路由、凭证获取及私有资源供给 |
| 状态与存储 | 执行状态机、持久记录与一致性规则；默认适配器及 ports | 接宿主数据库/对象存储；维护 Task/Delivery 等业务投影 |
| 工作区与检查点 | 租约、隔离及恢复的机制与一致性约束 | 仓库归属、目录生命周期授权、可选文件快照实现 |
| 人工输入与审阅 | request/attempt 归属、幂等、状态转换、审阅证据绑定 | Inbox/聊天界面、通知渠道、回答者/审阅者权限 |

Symphony 适配层可以转换数据、提供 I/O、做业务授权和投影；不应重新决定哪个节点执行、怎样重试、何时结束等待或如何修复 Loop 游标。旧功能无法由 SDK 表达时，应明确重建、延后迁移或留在旧运行路径，不能在适配层偷偷补出第二套调度器。

## 3. 已有基础与嵌入接入任务 E00

### 3.1 已有能力继续复用

Client 已具备启动参数、流式通知、usage、权限/elicitation、cancel/shutdown 和 resume/fork；Runtime 已允许注入 Store、Executor、Registry、WorkspaceManager，并有 Gate、WaitRequest、journal 与恢复路径。当前 server 主要通过 `WorkflowHost` / `RunService` 调用 SDK，已有正确的分层基础。

下列事项属于接通或补测，不按从零建设计量：

- 宿主指定 run ID、直接注入 Runtime ports。
- scoped artifact reader 的授权/配额和不依赖 MCP 的库调用。
- Script 保留运行身份环境变量的覆盖保护。
- 进程树终止工具、Agent 配置顺序应用、历史归并和 usage 分类。
- 默认独立运行服务与 HTTP/UI 接入。

本次最小复现确认：执行期间状态中尚无对应 attempt、自动重试复用 attempt ID、声明为 boolean 的输出收到字符串仍可成功。这些是 F02/F03 的具体修复依据；mock 结果不证明真实引擎隔离或崩溃恢复已通过。

### 3.2 E00 · 以现有 ports 完成双路径组装（P0，按阶段落实）

- 保留直接组装 `WorkflowRuntime` 的方式，补齐宿主执行入口所需的公开类型、错误和导出；不新建重复 facade。
- `RunService` 已位于 SDK，但直接依赖默认数据库。M1 前将嵌入所需的运行查询、协调器租约等持久操作接到合适的 ports，保留 SQLite 默认实现；不能仅靠绕开 RunService，把后台驱动责任交给 Symphony 重写。
- 启动后台驱动、恢复扫描和关闭资源均可由宿主显式调用，不只挂在 HTTP 的 onReady/onClose 上。库不自行退出宿主进程或安装不可控的全局信号处理。
- 明确资源所有权：SDK 清理由自己创建的会话/进程和订阅；注入的数据库、存储连接等默认由宿主管理。独立 server 的组装层负责其拥有资源的启动与关闭。
- 所有执行命令的校验和状态转换在库入口完成。直接调用 SDK 与经 server 调用的结果保持一致，HTTP 校验只是额外的传输检查。
- 嵌入示例仅依赖所需 SDK 包；不安装 server/web/UI 也能运行。独立 server 仍使用同一批公开入口，并具备默认配置与持久化。

## 4. 纳入核心的能力与最小实现范围

保留原提案的 A/F 编号，便于追踪。P0 表示正确性或接入阻塞；P1 表示通用能力补齐；P2 表示候选扩展。优先级不意味着采用原提案的全部实现细节。

### A01 · 终态与取消契约（P0；修复；M0）

**落点**：Client/adapter 提供可信执行结果，默认 Workflow Executor 消费该结果。

- 检查 `stopReason` 和缺失响应，保留原始原因；未完整结束的执行不能默认发布成功输出。
- 区分正常完成、取消、输出/上下文限制、进程失败、协议中断。单次工具拒绝是事件；只有拒绝导致 turn 终止时，才映射相应终态。
- 每个 turn 只提交一次终态；定义收到的最后一批消息与终态的顺序。
- 保持 cancel 当前 turn 与 shutdown 整个 session 的区别；会话可按引擎能力继续后续 turn。
- Agent 执行结束与业务验收通过保持独立。

**验收**：正常、截断、断流、退出与取消竞争均有测试；部分文本不会导致成功节点或下游产物，取消后可按声明能力继续会话。

### A02 · 显式访问策略与可验证权限（P0；修复与增强；M0）

**落点**：Client/adapters 与 Node 执行器；Contract 仅承载声明。

- 分离调度用 `writeScopes` 与实际访问权限，避免把“未声明写范围”当作已建立只读隔离。
- 扩展现有权限回调与配置入口，报告支持的能力和实际生效策略。对明确要求的限制，不支持时执行前拒绝。
- 优先使用引擎原生 sandbox/tool guard 或宿主提供的隔离实现；不在本计划中建设通用操作系统沙箱。
- 受限模式覆盖 SDK 提供的文件/terminal 操作、shell 间接写入、越界和符号链接；未知工具不能自动放行。无法覆盖原生写入路径时，不声明强只读。
- 保留兼容调用方式，但不虚报隔离保证。恢复或切换配置不能扩大已冻结权限。

**验收**：按引擎分别验证声明的限制，区分“可启动”和“隔离已验证”；无需为所有引擎虚构统一权限能力。

### A03 · 执行事件与完整 usage（P0；补通；M0 → M1）

**落点**：Client 事件、Executor 关联信息、Runtime/Store 持久化；server 仅传输。

- 复用文本、思考、工具、子 Agent、问题、usage 与诊断通知，提供宿主可消费的事件通道。
- M0 明确 session/turn/toolCall/accounting identity；M1 增加 run/scope/node/attempt 关联与持久游标，不另造另一套 Client 历史模型。
- 控制请求、结果接受和终态具有持久确认边界；普通文本可批量存储。慢消费者的缓存有上限，关键事件可恢复。
- 保留 input/output/cache 分类，明确 delta/cumulative；同一计费身份不重复统计。已知零费用与未知费用区分，原生费用与宿主估算区分。
- M0 的单 Agent 持久记录可由宿主 sink 保存；接入 Flow 后由 SDK 的执行记录与事件 ports 统一提供语义。无 HTTP 也能订阅和读取。

**验收**：实时与重放的归属、顺序和终态一致；恢复、累计上报及子 Agent 汇总不重复计费；两种宿主均能消费同一事件契约。

### A04 · 启动资源、实际配置与恢复身份（P1；补通；M0）

**落点**：Client、默认 Executor、宿主资源供给 hooks。

- 复用 env、dataDir、command/args、executable override、MCP 与 resume/fork；只补按次资源获取/释放和必要配置反馈。
- 对实际取得的临时资源，在成功、失败、取消与启动中断路径只调用一次释放逻辑；释放失败可诊断。
- 请求配置与实际配置分开记录。宿主可声明必须生效的 model/mode/effort；兼容模式允许回退，但不能把请求值当作实际值。
- session reference 记录影响恢复的引擎、工作目录、权限和非敏感 Provider 身份；不兼容时明确拒绝或按宿主选择新建会话，handoff 不伪装为 resume。
- 凭证不写入定义、事件、receipt 或 checkpoint。Provider 路由、账号管理和远程基础设施由宿主负责。
- 本地/远程、引擎/平台分别声明支持范围；确需远程时扩展 process driver，不将 Symphony 远程平台搬入 SDK。

**验收**：隔离启动资源、清理失败、配置拒绝和恢复不兼容可观察；独立 server 与嵌入宿主均可提供启动参数。

### F01 · 不可变运行输入与执行版本（P0；增强；M1）

**落点**：Contract、Runtime、Registry/Store ports。

- 定义“准备并校验 → 持久接受 → 开始调度”的边界。宿主可直接提供冻结快照；独立运行默认组装也应完成相同冻结。
- 接受时固定可静态确定的 Agent/Chief/默认 Agent、运行选择及依赖身份，支持快照 Registry；不要求宿主另建一套可编辑配置库。
- 动态选择的新 Agent 必须形成授权后的持久选择，并受原权限上限约束。
- 复用已有 run ID 支持，补提交幂等：相同请求及内容返回同一运行，复用请求 ID 却改变内容须冲突。
- 执行格式、编译器语义版本与业务定义版本分开；保留原定义及编译来源，历史运行不被新默认值重新解释。

**验收**：接收后修改 live 配置不影响排队或恢复节点；冻结失败无节点启动；相同请求只接受一次。接收与幂等记录由 Store 原子提交或提供等价的持久保证。

### F02 · 持久 attempt、重试与人工输入（P0；修复与补通；M1）

**落点**：Runtime 状态机、Executor 生命周期回调、Store；人工问题展示留给宿主。

- 先完成 F02a：外部执行前持久化 invocation/attempt/manifest 和 RUNNING 状态；重试新建 attempt，保留前次记录、错误与用量归属。
- 再完成 F02b：接通原生 elicitation 与 SDK 等待机制。回答延续同一逻辑 attempt；正常提问不消耗技术重试额度。
- request 绑定 run/scope/node/attempt，先持久化再确认；回答经过宿主授权并校验当前 request/attempt，同答案幂等，过期或冲突答案明确拒绝。
- 支持顺序提问与不同并行 attempt 分别等待；初版声明一个 attempt 同时最多一个待答请求，不声称支持未实现的并发问题模型。
- 恢复待答请求时遵循引擎能力；无法恢复原生 pending request 时进入明确的受控恢复或待处理状态，不能默默重跑已有副作用。
- 普通聊天正文在严格模式下不作为控制命令。Gate 和 Agent 提问共用等待基础，但权限审批与业务问题保持可区分。

**验收**：执行开始前可查询 attempt；失败重试记录完整；等待中重启、重复/过期回答、顺序及并行问题归属准确。

### F03 · 真实数据校验与结果提交（P0 基础校验 / P1 严格模式；M1）

**落点**：Contract 与 Runtime 的输入/提交边界；Node 提供 Script 文件 I/O。

- 先使现有 type/required 契约在运行时生效，覆盖入口、节点输出、Gate 回答和下游消费；明确文本 fallback 支持的节点。
- 在有结构化对象需求时增加有界 JSON Schema 子集，复用成熟校验器；支持范围、大小限制和不支持项均显式声明。
- 提供 attempt 绑定的库级结果提交入口，复用 Executor 返回路径。严格节点接受明确的结构化提交，普通文本任务保留便捷方式。
- 只有终态、权限与数据校验均通过的结果才能发布；旧 attempt 或旧 epoch 的提交不能覆盖当前结果。
- 复用 artifact reader 的授权/配额及 producer/hash 来源；API、CLI、MCP 只是提交或读取的可选传输。
- Script 输入/输出文件有大小限制；保留运行身份环境变量保护。技术重试使用明确分类、次数、退避和允许重试的退出码；取消、权限拒绝、契约错误不自动重试。

**验收**：错误类型、缺字段、超限/畸形结果、未授权产物、过期提交均被拒绝；下游不消费无效输出。两种宿主走同一校验入口。

### F04 · 停止、进程清理、恢复与资源上限（P0；修复与增强；基础修复前置，M1 完成）

**落点**：Runtime 的状态与恢复判定、Node 的运行驱动/进程/存储实现。

- F04a 前置处理：Script stdout/stderr 使用有界缓存及日志存储；等待终止清理结果；正常退出、失败、超时、取消都处理所属子进程树。
- 区分停止 turn、停止节点、取消 run 与关闭宿主。关闭宿主的暂停/恢复策略显式声明，不把 HTTP 断开解释成取消执行。
- F04b 在 F02a 后完成：进程归属、结果接受、终态与租约释放有明确顺序。清理状态不确定时保留诊断和冲突保护。
- 启动前落盘身份；启动与登记之间崩溃也属于不确定窗口。恢复先核对遗留执行，再选择继续、失败或请求处置，不能只凭 lease 过期自动重跑写任务。
- 保留 epoch/CAS fence，拒绝旧协调器的迟到发布；外部副作用不承诺无条件 exactly-once，可接宿主幂等键与结果核对。
- 区分全局活动进程上限与未完成 item 上限；等待是否占 item 名额由明确策略决定。默认行为及嵌套组合不能绕过资源限制。
- 复用 journal 游标与快照机制，限制事件/产物读取；长运行不随全部历史无限增长内存，也不在每个文本片段更新完整 RunState。

**验收**：真实独立进程故障注入覆盖执行前后、外部写入后未提交、等待、进程退出和合并边界；无双重发布，不确定执行不被当作成功或安全可重试。大量日志与长运行有实测资源上限。

### F05 · 完善 SDK 原生 Loop/Parallel 组合（P1；巩固现有模型；M2）

**落点**：Contract 编译器、Runtime 调度器；不实现 Symphony V2 专用运行器。

- 固化现有层级图的条件分支、被跳过依赖、汇合与嵌套语义。需要新增 join 策略时，以 SDK 自身用例论证，不能仅为匹配旧宿主枚举而增加。
- 明确 Parallel 的输入/结果顺序、失败策略、冻结批次和部分完成恢复；与 F04 的进程/item 限额共同测试。
- Loop 的轮次、退出条件与上限持久化；Retry/Resume 不恢复已消耗的预算。
- 工作区 shared/worktree/auto 是 SDK 明确支持的策略，宿主显式选择；不能用隐式串行化或切换工作区掩盖语义差异。
- 提供结构化来源标识：定义节点路径、scope、item index、loop round。嵌套测试由公开能力和资源边界决定，不把旧宿主“四层 Inline”等约定写成内核规格。

**验收**：以 SDK 原生定义建立组合 fixture，验证执行集合、数据来源、状态、顺序、轮次、并发和恢复。Symphony 使用相同 fixture 接入，不要求 SDK 复现其旧图内部形状。

### F06 · 审阅与交互执行的边界（基础 P1 / 进阶 P2）

**落点**：Runtime 管理执行语义，workflow-agents 提供 Chief 实现，宿主提供 UI 与授权。

**纳入当前核心（基础审阅来源 M1，组合失效与 Chief 约束 M2）**：

- 保留合法 assessment 要求；审阅绑定确切产物与 producer attempt，工作区审阅带对应版本证据；修改后使旧审阅失效。
- 使用 Chief 时执行既有 maxLevel、干预次数和 Loop 扩展约束；不得覆盖 verdict、验收标准或代答必须人工确认的问题。
- Chief 换 Agent、修订或恢复经过授权且受原运行权限上限约束；与调度器共享执行租约规则。

**候选扩展，不作为 M0–M2 默认门槛**：

- 持续 Conversation 节点、interactive chain、post-run Ask/Revise。独立聊天的持久发送队列已按明确需求单独纳入第 10 节，不改变 Flow 调度。
- 只有 SDK 产品需要这些交互时才独立设计。若纳入，消息幂等、turn 与节点完成边界、恢复状态机归 SDK；不能要求 Symphony 自己补另一套执行机制。
- 新交互模型不改变普通一次性 Agent 节点的默认语义。

**验收**：基础审阅来源与失效准确、Chief 无越权路径；候选扩展另定能力范围及验收，不以 Symphony 旧交互齐全为前提。

### F07 · 重试、局部重跑与历史 Fork 分级（核心 P0/P1；高级 P2）

**落点**：Runtime 的执行历史/失效语义，Node 或宿主提供可选 checkpoint/workspace 实现。

| 能力 | 核心含义 | 排期 |
| --- | --- | --- |
| Retry | 新 attempt，保留前次证据和当前 Loop 位置 | M1，随 F02 |
| 局部重跑 | 明确重跑范围和受影响后继，保留前次 attempt/产物/审阅来源 | M2，完善现有 rerunFromNode |
| 完整 Replay / Checkpoint Fork | 独立执行批次或从历史文件与调度检查点创建新 Run | P2，独立设计，不因 Symphony 已有而自动立项 |

- 当前局部重跑要定义历史查询、审阅失效、工作区基线和重验范围；不把“失效下游再跑”宣传为任意历史时间旅行。
- 若实现高级 Fork，必须同时校验文件快照、定义/输入摘要、调度位置、Loop 游标和 Parallel 批次；不能把原生 session fork 或 worktree 复制等同于运行检查点。
- Fork 来源可追溯，源运行只读，创建幂等；缺快照或来源不明时失败。新 Run 的预算政策单独声明，保留既有消耗证据，不能悄悄清零。
- checkpoint store/workspace hooks 可由默认 Node 实现或宿主提供；凭证排除、符号链接边界和 ignored 文件策略必须明确。
- 外部数据库/服务副作用不随文件回滚自动恢复，不宣称文件检查点覆盖所有业务状态。

**验收**：M1 验证 retry 身份；M2 验证局部重跑的受影响集合与历史保留。完整 Replay/Fork 仅在立项后按独立规格验收。

## 5. 实施顺序与每阶段替换验收

M0–M2 衡量 SDK 能力与宿主采用程度，不是 Symphony 旧功能兼容级别。每阶段同时交付直接调用示例和独立 server 路径；SDK 阶段完成与 Symphony 实际替换完成分开记录。

### 5.1 实施批次

| 批次 | 工作项与依赖 | 交付边界 |
| --- | --- | --- |
| 0 | E00 接口/资源所有权梳理、原生 fixture 与现有用法回归基线 | 确认扩展落点；保留默认 server 组装；不开展全量重构 |
| 1 | A01、A02、A04；提前修 F04a 的日志与清理问题 | Agent 执行契约可靠，具体引擎能力有证据 |
| 2 | A03 的会话事件/usage，E00 的 Agent 嵌入路径 | M0；独立和嵌入方式均可启动、停止与恢复受支持会话 |
| 3 | F01、F02a、F03 基础校验、F06 基础审阅来源；E00 的运行驱动/存储接入 | 先确定不可变输入、持久身份和数据接受边界 |
| 4 | F02b、F03 严格提交/Script 重试、F04b、A03 Flow 事件 | M1；原生基础 Flow 的等待、停止、恢复与数据传递可靠 |
| 5 | F05、F06 基础审阅/Chief 约束、F07 局部重跑 | M2；原生组合 Flow 成为宿主可直接采用的执行核心 |
| 后续候选 | F06 进阶交互、F07 完整 Replay/Fork、额外引擎/远程能力 | 独立需求与设计，不阻塞已验收能力的使用 |

每批包含实现、契约/兼容说明和针对性测试。新增持久身份与版本字段先确定，再实现依赖它们的恢复；完整 Fork 暂不实现，不代表可以省略当前产物和 attempt 的来源记录。

### 5.2 M0 · Agent 核心可替换

**SDK 完成标准**

- A01–A04 在声明的引擎/平台组合通过验收；直接导入 Client 即可使用，不要求 Workflow 包或管理服务。
- 多轮执行、取消、权限、配置反馈、恢复身份、事件与 usage 一致且可诊断。

**独立运行验收**

- server 默认组装能运行一个 Agent 节点，展示执行事件/结果，提供本阶段支持的控制入口。
- 默认配置、启动与资源清理不依赖 Symphony；本阶段不宣称已完成 Flow 崩溃恢复。

**Symphony 替换验收**

- 薄 Agent adapter 调用 SDK，Symphony 调整事件/配置映射以符合 SDK 契约。
- 已切换引擎不再通过 Symphony 自有的进程启动、协议解析、turn 生命周期代码执行。
- 只声明已验证组合的替换；其他组合保持明确状态，不因“引擎同名”推断兼容。

### 5.3 M1 · 原生基础 Flow 可替换

**SDK 完成标准**

- E00、F01–F04 达到本阶段范围；提交、查询、回答、停止和恢复都可直接调用库入口。
- 原生 DAG + Agent + Script + Gate/Agent 提问串起冻结、执行、校验、持久化、停止与重启恢复。
- 执行状态只有一个权威状态机；不确定副作用不自动当作未执行而重试。
- 有审阅节点时，合法 assessment 与被审阅产物的来源关联同时验证。

**独立运行验收**

- 使用默认存储与工作区，完成上述原生 Flow，退出后重启恢复；HTTP 控制与直接 SDK 调用结果一致。
- server 提供必要操作入口，UI 可逐步完善，但关键功能不能只存在于未公开的 server 内部。

**Symphony 替换验收**

- Symphony 提交 SDK 原生定义与冻结配置，提供宿主 ports 并消费事件；无需启动 SDK 管理 server。
- 对已接入运行禁用旧 graph worker；Symphony 不再为其维护节点推进、技术重试和等待恢复逻辑。
- 首先接入新建原生 Flow。旧 Flow 的转换或重建属于 Symphony 任务，不阻塞 SDK M1。

### 5.4 M2 · 原生组合 Flow 成为主要执行路径

**SDK 完成标准**

- 原生 Loop/Parallel 组合、部分完成恢复、审阅失效及局部重跑通过确定性 fixture 和故障测试。
- 两种组装方式使用同一执行语义；长任务的资源和查询边界有证据。
- 对未支持能力在运行前拒绝；不要求完整 Conversation 或历史 Fork 才能达到 M2。

**独立运行验收**

- server 可创建/加载、执行、观测和控制 SDK 原生组合 Flow，恢复后保留正确轮次、结果与历史。
- SDK 的新增核心操作经薄接口暴露；server 未增加另一套循环/恢复实现。

**Symphony 替换验收**

- 新建流程的编辑、发布与执行入口采用 SDK 契约，SDK 成为已声明范围内的主执行路径。
- 对这些运行可删除或禁用旧调度、循环/并行推进、重试和恢复代码；保留的适配代码限于业务、转换、I/O 与投影。
- 未迁移旧 Flow 明确标注为重建、暂留旧引擎或不再支持。M2 不等于所有历史定义都能无损运行。
- 如实际采用范围仍依赖旧调度器补核心行为，必须列为替换未完成项，不能以“SDK 已接入”代替完成证明。

### 5.5 每阶段验收记录

每阶段分别记录：SDK 契约及版本、支持引擎/平台、直接调用结果、独立 server 结果、Symphony 接入结果、旧代码退出范围、未支持项。尚未获得 Symphony 真实接入证据时，状态只能写“SDK 已就绪，宿主替换待验收”。

## 6. Symphony 适配与迁移工作

以下工作由 Symphony 承担，不成为 SDK 兼容旧实现的任务单。

1. 维护采用清单：业务场景、选用的 SDK 能力、适配代码、验收 fixture、旧执行入口退出状态。以业务意图和 SDK 语义验收，不逐项复制旧对象形状。
2. Agent adapter 对接身份、权限、Provider 资源和事件投影；Flow 入口调整为 SDK 原生契约。
3. 旧定义分为可无损转换、需要按 SDK 模型重建、继续保留历史解释路径三类。转换不能通过串行化、隐式改工作区或补宿主调度逻辑伪造等价。
4. Web/项目配置仍由 Symphony 管理；接收时提供冻结输入。SDK 不读取 Symphony 的 live 业务表作为执行过程中可变化的配置。
5. 运行状态由 SDK 状态机通过选定 Store 持久化。Task/Runtime/Delivery 等业务投影由 Symphony 维护；明确事务或持久事件投影边界，按游标/事件身份幂等更新。
6. 一个 Run 只绑定一个执行引擎及格式版本。旧运行按旧契约结束或经显式迁移；不得后台切换调度器重放副作用。
7. 回退停止接纳新的 SDK 运行，已接受运行由原冻结引擎处理或显式处置。旧执行代码在其历史责任结束后退出，不为新 SDK Flow 保留补丁调度器。
8. 真实对比测试使用隔离工作区或可控工具，不让旧/新引擎同时对同一业务资源执行写操作。发生行为差异时按 SDK 契约判断，旧行为不自动正确。

SDK 开发可在没有 Symphony 仓库时推进直接调用和独立 server 验收；实际删除 Symphony 旧核心的结论必须由其接入验证给出。

## 7. 测试、发布与两种使用方式的共同证据

### 7.1 核心测试矩阵

| 编号 | 场景 | 首次要求 |
| --- | --- | --- |
| T01 | 多轮文本/工具/子 Agent 事件、稳定归属与 usage 去重 | M0 |
| T02 | 取消、截断、权限终止、异常退出竞争与唯一终态 | M0 |
| T03 | 各引擎声明的访问边界、越界/链接、不支持限制时拒绝 | M0 |
| T04 | Provider/目录/权限变化、实际配置与恢复兼容性 | M0 |
| T05 | 冻结配置、提交幂等、执行格式与历史解释 | M1 |
| T06 | 执行前 attempt 可见、重试记录、等待重启/重复/过期回答 | M1 |
| T07 | 入口/输出/Gate 数据校验、大小限制、过期结果、Script 重试 | M1 |
| T08 | 真实独立进程故障、租约接管、旧协调器迟到结果、不确定副作用 | M1 |
| T09 | 日志/事件/读取有界、全局进程与 item 限额、长运行 | M1，组合场景 M2 |
| T10 | SDK 原生分支/Loop/Parallel、部分失败、部分完成恢复 | M2 |
| T11 | 审阅证据与失效、启用 Chief 时的权限约束、局部重跑历史 | 基础 M1，组合 M2 |
| T12 | 不安装 server/web/UI 的干净嵌入示例，以及默认独立 server | 各阶段对应能力 |
| T13 | 同一 fixture 经库入口和 server 入口执行，核心结果一致 | 各阶段对应能力 |
| T14 | Symphony 对已接入范围停用旧执行逻辑后的验证 | 各阶段宿主替换验收 |

Conversation 专项与完整 Replay/Fork 各自单独增加测试，不混入 M0–M2 的默认门槛。普通回归不调用用户账号、真实用户工作区或正在运行的会话。

### 7.2 发布要求

- 从 pack 后的包安装到干净示例，验证公开导出和资源路径；不能依赖 monorepo 源码 condition 或隐式 workspace 依赖。
- 嵌入示例不安装管理 server/web/UI；独立示例使用默认适配器与正常 CLI/服务入口。两者均覆盖明确的启动/关闭和资源所有权。
- 每个承诺支持的引擎/平台组合给出结果。macOS/Linux/Windows、Node/Electron 分别记录；模拟 win32 不算 Windows 实测，未验证不宣称支持。
- Windows 覆盖路径、进程树、锁/链接；Electron 覆盖 ASAR unpack、迁移与 adapter 资源。额外平台不自动阻塞已验证范围发布，但纳入实际宿主采用范围时必须验证。
- 区分 mock ACP、真实 Agent、真实独立进程故障与打包验证；现有同进程多实例租约测试不替代强制退出测试。
- README 同批说明原生 Flow 模型、默认独立运行、嵌入组装、能力限制与执行格式版本，不只描述 Client。
- 验收证据使用状态、事件归属、产物来源、执行次数与资源边界；非确定性模型输出不要求逐字一致。

## 8. 首批任务与暂不立项内容

**首批任务**

- [ ] 建立 E00 的现有接口/默认组装清单，标出嵌入所需的真实耦合点；保留当前分包。
- [ ] 修 A01 终态与缺失响应，补默认 Executor 的取消/异常回归。
- [ ] 定义 A02 显式访问策略及已验证能力，明确 writeScopes 的调度职责。
- [ ] 补 A04 实际配置与资源释放反馈，贯通 A03 的现有事件/usage。
- [ ] 提前修 Script 日志上限与进程清理；完成 F02a 的执行前记录和独立 retry 身份。
- [ ] 使现有 type/required 契约实际生效；再设计确有需要的严格提交与 schema 扩展。
- [ ] 确定冻结输入和执行版本；接通持久人工输入及安全恢复。
- [ ] 每批同时维护直接调用示例、独立 server 入口和兼容说明。

**暂不自动立项**

- Symphony V2 全量兼容层、专有节点/Inline 规则。
- interactive chain、历史 Replay/Fork。Conversation 已按 2026-10-24 的明确需求单独进入实现，边界见第 10 节。
- 新 Provider 管理平台、远程调度平台、通用操作系统沙箱。
- 新的通用运行框架或将全部职责合并进一个 Runtime 文件。

这些候选只有在 SDK 自身用例和独立设计成立时进入开发；Symphony 的需求可以作为证据，但不是强制规格。

## 9. 源码复核入口

| 文件/入口 | 本次判断依据 |
| --- | --- |
| `packages/agent-client/src/types.ts` / `launcher/runner.ts` | 已有启动、事件、权限、会话与生命周期接口；配置反馈和资源边界可在现有路径完善 |
| `packages/agent-client/src/client/agent-client.ts`，prompt | 返回协议响应，连接不可用路径可能返回 undefined |
| `packages/workflow-node/src/executors/universal-agent-executor.ts` | 终态未消费、权限默认规则、effort 反馈、usage 字段和回复解析 |
| `packages/workflow-runtime/src/runtime.ts` / `ports.ts` | 可注入边界、冻结时机、attempt/retry/结果接受、现有局部重跑 |
| `packages/workflow-runtime/src/agents/agent-resolution.ts` / `state/run-log.ts` | 首次使用 pin、状态重建和历史默认值处理 |
| `packages/workflow-contract/src/schema.ts` / `dag-compiler.ts` | 原生图模型、基础端口声明、组合结构与编译规则 |
| `packages/workflow-node/src/executors/script-executor.ts` | 运行身份 env 已保护；日志累积、输出读取、超时清理需要完善 |
| `packages/workflow-node/src/host/run-service.ts` / `workflow-host.ts` | 已有无 HTTP 运行服务；默认数据库、租约和配置库组装的嵌入边界 |
| `packages/workflow-server/src/server.ts` | HTTP/SSE 对 SDK host/services 的包装；服务生命周期目前接 HTTP hooks |
| `packages/workflow-agents/src/runtime.ts` | 默认 Registry/Chief 组装路径；嵌入时可直接选择所需实现 |
| `packages/workflow-node/test/workflow-e2e.test.ts` / `run-leases.test.ts` | mock ACP 与同进程多实例测试的证明范围 |

原提案列出的 Symphony 文件可留作其接入团队的调查线索；SDK 的公开设计和完成标准以本计划的原生契约与测试为准。

## 10. Conversation 专项设计（2026-10-24）

### 10.1 范围与分层

用户于 2026-10-24 明确选择独立聊天运行层，包含发送队列、会话占用、权限等待和崩溃恢复。本次作为可选库能力实现，不替换已有 Session API 或 Flow 执行器。ACP 已定义 ContentBlock、tool_call/tool_call_update、plan 和权限协议；复用这些类型和现有 Client/引擎适配，保留传入 Client 回调的原始通知与 `_meta`。旧 `SessionHistoryEntry` 是展示投影，存在非文本内容和工具原始输入输出的裁剪，不能单独作为完整会话的持久事实来源。

- `agent-client/conversation`：Conversation/Turn/Message/Event 类型、追加日志与 CAS 存储 port、内存实现、消息投影、会话控制和事件订阅。不依赖 Flow 或 server。
- `workflow-node`：SQLite 默认实现、`createNodeConversationService` 和 `WorkflowHost.conversations`。不要求先创建 Flow；数据库由宿主持有并关闭。
- Flow 保留现有图、节点、调度、等待、重试与 Executor 路径；Agent Executor 通过 SDK 的 `ConversationRecorder` 记录每次实际调用，不进入独立聊天队列。`source.namespace = workflow` 关联 run/scope/node/attempt/invocation/retry/round；成功 receipt 附带可选 conversation/turn ID，失败和取消仍可按 source 查询。
- server 与嵌入宿主调用同一套库接口；server 只提供 HTTP/SSE 包装，不承载会话状态机。workflow-ui/web 提供 Flow 节点的只读 Conversation 详情，不引入独立聊天发送界面。

现有 RuntimeStore 专用于 Flow run 日志，不能要求独立 Client 会话先创建一张 Flow 图，因此新增 ConversationStore port。宿主可以替换存储；默认 SQLite 在现有数据库中增加独立表，旧 Flow 表与数据不迁移、不重解释。

### 10.2 消息、历史与扩展

- 支持 user/assistant/system/tool 消息；内容覆盖 ACP 文本、图片、音频、内嵌资源、资源链接、思考、计划、工具状态/输入/输出/差异/terminal 引用，保留现有子 Agent 等归并结果。
- 工具结果遵守 ACP：关联同一 toolCallId 更新，不伪造另一次调用；原始通知完整保存，展示历史不替代协议记录。
- Conversation 与 Turn 身份独立于原生 ACP session/turn；记录正常、取消、截断、拒绝、失败、中断，部分输出可以查询但不变成成功。
- 原始事件按 sequence 分页；turn 元数据独立保存，消息投影按一个 turn 的事件生成，不在每个文本片段复制整段会话快照。发送请求先持久入队，支持幂等键和内容冲突检查。
- Conversation、Turn、Message 允许 JSON 命名空间扩展；扩展消息/事件用 `namespace + name + data`。例如 `extensions["symphony.task"]`；宿主可定义自己的 TypeScript 扩展类型和投影，不能覆盖 SDK 的 ID、顺序、状态字段。
- 所有扩展与未知协议信息经过存储往返和重放后保持；新增协议内容不会被静默丢弃。

### 10.3 独立聊天生命周期与恢复边界

- 同一 Conversation 同时只允许一个受管理会话及一个活动 turn；租约、心跳与 CAS 拒绝其他实例或迟到写入。每次占用生成新 token；租约过期后必须显式恢复，不能抢占仍有效的租约。
- turn 接受后再调用 Agent；事件持久化后发给订阅者。存储失败不能向调用者报告成功；事件写入队列有独立于 token/材料额度的内存保护。
- `send` 持久 FIFO 入队；`pause` 暂停后续发送；`resume` 显式继续队列。只有 `end_turn` 计为完成；取消、截断、拒绝、断流及其他失败均暂停后续发送。
- `cancel` 取消指定 queued/active turn；`disconnect` 中断活动 turn、暂停队列并释放连接；服务 `shutdown` 释放全部会话；`close` 取消剩余队列并关闭 Conversation。权限请求先持久化再通知，回应校验选项且先持久化再返回原生 RPC；未配置自动策略时等待宿主回应。
- 重开已有 Conversation 使用已有原生 session ID；原生恢复不支持时记录连接错误、保留暂停的队列，不自动创建新会话伪装恢复。`recover` 将崩溃后的运行中 turn 记为 interrupted，权限记为 expired，保持未发送队列暂停；之后 `resume` 只发送尚未开始的 turn。不会自动重放可能有副作用的 prompt。
- 本批不承诺跨进程恢复尚未回应的原生权限调用，也不把原生 session 恢复等同于 Flow checkpoint 或文件回滚。

### 10.4 验收

多轮、文本分片、多模态、工具更新/原始 JSON 值、计划/扩展事件、权限、usage、取消/截断/断流、重复发送、并发归属、存储失败、重开查询、扩展往返均补测试。SQLite 多连接、强杀持有进程后的恢复、mock ACP 子进程覆盖默认独立路径；注入内存/custom Store 覆盖无 server 嵌入；HTTP/SSE 验证同一套语义。既有图/节点与 Executor 回归继续通过。原生引擎实际恢复能力仍以各引擎实测为准；租约不代表外部工具副作用具备 exactly-once 保证。

使用接口、HTTP 路由与存储边界见 `docs/conversations.md`。

### 10.5 首批独立聊天实现与验证记录（2026-10-24）

- 已实现 `ConversationService`、可替换 `ConversationStore`、内存/SQLite 存储、消息投影和命名空间扩展；Node host 默认组装及 server HTTP/SSE 均调用同一核心实现。
- 新增 28 项回归：Client 22 项、SQLite/进程 5 项、HTTP/SSE 集成 1 项。覆盖强杀持有进程、过期权限、迟到写入、原生 session 恢复失败、队列恢复、存储失败、慢存储缓冲保护和启动/关闭竞争。
- Client、workflow-contract、workflow-runtime、workflow-node、workflow-agents、workflow-server 共 167 项测试通过；Client/Node/Agents/Server 类型检查通过；Client/Node/Server 构建通过。
- 首批未改图模型、节点种类、Flow 调度和 Executor 的接入路径。测试使用本地 fixture/mock ACP，未据此宣称所有真实引擎都支持跨进程原生恢复；Symphony 的实际接入仍待其宿主验收。

### 10.6 Flow Agent 统一记录接入（2026-10-24）

- `agent-client` 新增纯记录器 `ConversationRecorder`，复用 ConversationStore/Event/Turn/消息投影；不启动 Agent，不安排重试，不引入另一套 Flow 调度。外部宿主也可用自定义 source 命名空间复用。
- 一次实际 Executor 调用对应一个独立 Conversation 和 turn。技术重试虽然复用 attemptId/invocationId，但具有独立记录 ID 和显式 retryIndex。Loop round、Parallel item 继续使用原有 scopeKey；原生 session 恢复也建立新的执行记录，重放消息不归入新 turn。
- 完整记录提交 prompt、消息/思考/多模态、工具原始输入输出及更新、权限请求/结果和会话扩展回调。启动失败、取消、截断、拒绝、断流、只读验证失败、关闭失败均保留对应终态；只有 Executor 本身及清理完成才记完成。后续调度验收/工作区合并失败仍属于 Flow attempt 状态。
- `mode: recording` 的执行归 Flow；独立聊天 send/cancel/resume/recover 等不能接管。权限仍由现有 Executor 策略决定，等待中取消由 Flow signal 传播。突发进程死亡保留未完成记录供 Flow 宿主对账，不新增自动重放或聊天恢复路径。
- 默认 Node runtime 和 host/server 使用同一 SQLite；仅新增通用 source 索引表，不迁移图/节点表。自定义存储需在 runtime 和查询 service/host 注入同一实例。支持 SDK `listWorkflowConversations`、已有 turn/messages/events 查询，以及薄包装 `GET /api/runs/:id/conversations`。
- 接入验收覆盖同 attempt 三次重试独立留档、权限等待取消、真实 ACP 消息和工具查询、SQLite 重开查询、Loop 分轮与 Parallel 并发隔离、原生恢复与人工回答、存储失败/缓冲溢出、以及聊天运行层回归。旧执行没有完整原始消息的数据不做伪造回填；自定义 adapter 需自行接入记录器。
- 本批新增 15 项测试，并扩充既有终态和真实 ACP Loop 测试断言。六个相关包共 182 项测试通过（Client 51、Contract 10、Runtime 43、Node 62、Agents 4、Server 12），六包类型检查与构建通过。

### 10.7 Flow 节点 Conversation 前端接入（2026-10-24）

- Trace 与运行画布的节点执行详情增加 Conversation 页签，按实际调用选择初次执行或各次重试；使用 runId/scopeKey/nodeId 查询和校验，技术重试即使共用 attemptId 也不合并，Loop/Parallel scope 继续隔离。保留现有图、节点和布局。
- 复用 SDK 消息投影，展示输入、回复、思考、工具参数/输出/状态、权限请求和结果，以及取消、失败、截断、拒绝、中断终态。多模态、资源、diff、terminal 引用和扩展事件保留；原始事件可展开，启动重放单独展示。
- workflow-ui 通过可注入 ConversationReader 读取；workflow-web 接现有 server 查询接口。新增 client/conversation 浏览器安全导出，仅含类型与消息投影；核心会话状态机、Flow 调度/重试/取消及权限策略不变。
- 列表和事件自动翻页，选中的调用才加载正文，运行中按事件游标增量刷新。切换或关闭取消请求；读取失败保留已有记录并支持重试，不把请求失败伪装成空历史。长文本滚动展示而不截断，展开时才序列化完整原始 JSON；当前选中记录仍会占用浏览器内存。
- 回归覆盖 100 条以上调用、跨页工具更新、大段输出、文本分片拼接、重试/作用域隔离、取消及其他非成功终态、读取失败后的游标续读、切换后的迟到响应、权限与安全内容呈现；HTTP reader 验证过滤、编码、分页与错误传播。旧运行无原始记录时明确显示空状态，不伪造补录。
- 本批新增 17 项测试并扩充 Trace 关联断言；UI 42 项、Web 2 项全部通过，UI/Web 类型检查与构建通过，Client 浏览器安全入口构建通过。额外覆盖终态提交与元数据读取竞争，防止 closed 记录搭配旧 running 状态而停止刷新。
- 使用本地模拟 Executor、真实 Recorder/SQLite/server 和构建后的页面进行浏览器验收：三次调用分别失败/截断/成功，222 个事件分页完整显示；权限等待自动更新为取消，断线保留内容并可重试，旧运行显示空状态，深浅主题及窄窗口可读。打开画布详情前后节点坐标一致，浏览器无控制台错误。此验证不调用真实模型，也不宣称覆盖所有外部引擎。

### 10.8 Chief 诊断与原节点修复（2026-10-24）

- 按已确认的路径实现：Chief 只读诊断当前 Run 的产物，注入修复指导，由原生产节点重做并让下游重新验收。复用既有图、节点、ContextManifest、分页读取和 Conversation；核心逻辑位于 Runtime/Agents/Node SDK，无需 Server 才能使用。
- 修复嵌套节点重跑后外层消费者继续使用旧结果的问题；清空受影响输出和验收引用、标记旧 Assessment stale、取消旧等待请求，后续 Loop 轮次重新生成。无关并行项和历史执行/产物版本保留。
- 校验 Chief 显式作用域、指定角色问题、干预次数、重复消息、未完成/取消决策和执行中重跑；收紧 Chief 的 ACP 工具权限，宿主回调不能放行 Chief shell/写入。底层引擎隔离仍属于宿主职责，不把权限回调视为 OS 沙箱。
- Chief 聊天操作使用 SDK RunService 原有队列与租约，当前执行结束后才进行诊断和重跑，防止执行结果互相覆盖；修复后由同一驱动自动推进。租约丢失时拒绝迟到的决策。
- 新增 21 项针对性回归，覆盖超 128 KiB 产物诊断修复闭环、独立复审、嵌套/循环失效传播、权限拒绝、取消和双宿主租约。详细边界和嵌入方式见 [Chief 修复能力](docs/chief.md)。
- 验证通过：Runtime 56、Node 72、Agents 6、Server 12，共 146 项测试；四包类型检查与构建通过。修复闭环使用模拟 Agent，不把测试通过等同于真实模型必定修复成功。

### 10.9 宿主配置与扩展原则（2026-10-24）

- 新能力先提供 SDK 类型化可选参数或已有 port 的注入点，再由 Node/Agents/Server 组装使用。默认值保持现有独立运行行为；宿主无需修改 SDK 源码，也不需要把策略塞进图和节点定义。
- 区分可配置策略与稳定语义：宿主可限制命令、筛选证据、调整分页/显式读取额度、登记只读工具和选择续跑时机；终态判断、验收来源、取消传播、租约互斥、重跑失效和历史保留保持统一。
- 本轮落地 `chiefOptions`（命令白名单、诊断开关、分页与可选累计额度、产物过滤回调）、`chiefPermissions`（原生只读类型、产物读取开关、宿主只读工具名单）、带运行/节点/attempt 上下文的 `onRequestPermission`，以及 `WorkflowHost.runOptions`（驱动租约参数和 Chief 聊天后的自动续跑开关）。
- `createWorkflowRuntime` / `createNodeWorkflowRuntime` / `createAgentWorkflowRuntime` 按所属层提供并透传参数；自定义 ChiefSupervisor、AgentAdapter、ConversationStore 等继续复用现有接口，不引入一套泛化插件框架。累计产物读取仍默认无限额，不新增 Token 限制。
- 新增能力验收同时覆盖：不传参数的兼容行为、配置实际生效、非法值/回调失败、核心边界不可绕过、默认组装透传。嵌入示例和参数默认值见 [Chief 宿主参数与扩展](docs/chief.md#宿主参数与扩展)。
- 本轮新增 18 项配置回归通过；Runtime 68、Node 77、Agents 7、Server 12 共 164 项测试最终通过，四包构建与类型检查通过。Node 首轮中已有 `script-io` Git 差异采集用例漏报一次同长度文件修改，单独和完整 Node 重跑均通过；本轮未修改该采集逻辑，未将重跑通过视为已解决其不稳定性。

### 10.10 Git 差异采集漏报修复（2026-10-24）

- 根因已稳定复现：`snapshotWorkingTree` 复制真实 Git index 到临时文件时刷新了 index 的 mtime。文件被快速等长改写且缓存 stat 仍相同时，新 index 时间会使 Git 跳过内容复核，漏掉实际修改。这破坏了 Git 的 [racy Git 检查条件](https://git-scm.com/docs/racy-git)。
- 修复局限于 `workflow-node` 的索引复制：从同一个打开的文件读取字节和时间，避免 Git 原子替换 index 时混用两个版本；临时 index 的 mtime 按原时间向下取整到秒，防止精度转换把检查时间推后。保留 Git 缓存优化，不增加等待或重试，不改图、节点、调度或对外接口。
- 回归使用真实 Git 和固定时间戳，测试仓库关闭 ctime 比较以稳定构造同 stat 场景。修复前普通仓库、关联 worktree 和真实 ScriptExecutor 三条路径均出现预期失败，修复后通过；原来的普通时间戳脚本用例保留。
- 新增 6 项测试场景，覆盖整秒/小数时间戳、并发采集、worktree 独立 index、暂存内容与 index 字节/mtime 不变、已有未提交基线、已跟踪但被忽略的文件、显式排除目录、未产生 index 的新仓库和脚本执行集成。
- 验证：Node 包 83 项测试通过，类型检查、构建和 diff 检查通过；验收依据为确定性失败到通过，不依赖重跑碰巧成功。

### 10.11 节点按项并行（2026-10-24）

- Agent、Script、Sub-flow 增加可选 `parallel` 属性，选择一个输入列表逐项执行；未开启保持单次执行。前端去掉独立 Parallel 新增入口，画布保留原节点类型、ID 和连线，通过分项执行详情查看状态及 Conversation。
- 编译器将该属性展开到现有按项 scope，复用图调度、工作区隔离、重试、权限、Conversation、Condition 和 Chief；保存的图不改成容器。SDK 提供 `parallelOptions.maxConcurrency` 供宿主约束每个批次的并发数，Server 不实现另一套调度。
- 修复 `settle_all` 将失败项算成功的问题，等待全部项结束后如实失败；`fail_fast` 取消其他运行项及待答权限，等执行器收尾后返回，不把取消当作重试或成功。外部取消沿用现有中断/恢复语义。
- 所有输出按输入顺序分别汇总，保留空值、失败位置、必填输出缺失原因和原产物引用。分项状态及完整输出保存在 `parallelItems`；Chief 指定精确 scope 重做一项时，兄弟项保留，汇总及下游重新验收。
- 每项 verdict 汇总给外层 Condition，全部 PASS 才整体 PASS，支持并行节点放入既有 Condition 回路；空列表不伪造验收通过。Chief 上下文明确给出 `target={scopeKey,nodeId}`，防止将节点 ID 拼进 scope；错误目标仍拒绝。
- 新增/扩充回归覆盖并发与乱序、取消权限等待、逐项重试留档、产物引用传递、空列表和关闭属性、Sub-flow 内 Condition、Chief 定点修复和前端分项选择。相关七包共 269 项测试、类型检查与构建通过。
- 最终真实 DeepSeek 运行 `run_56af4ac7-6bfd-4677-ab0b-66ee4abe9c53` 耗时约 74 秒，通过全部 25 项严格验收：两项分别启动失败并重试成功；alpha 经 Chief 指导原节点修复，beta 不重跑；全部八个独立用例和外层 Condition 通过。前期一次 Chief scope 拼接错误由严格验收发现，修复了上下文表达并补上回归后再验证，保留失败历史。见 [使用与边界](docs/node-parallel.md)、[实跑报告](docs/workflow-live-acceptance.md#节点并行属性验收2026-10-24)。

### 10.12 执行连线与参数连线的前端表达（2026-10-24）

- 执行点为菱形、执行线为紫色实线，标明执行成功后的顺序或分支条件；参数点为圆形、参数线为绿色虚线，输入/输出有 IN / OUT 标记，并提供常驻图例和连接点说明。
- 编辑器拖线预校验与实际编辑都拒绝执行点和参数点混接；自动创建字段只接受参数区的“+”连接点。SDK 图结构和调度不变。
- 参数绑定需要补执行依赖时，明确提示并同时显示两条线。已有执行路径或 PASS 等条件保持原样；参数详情说明依赖路径，条件只在执行线中编辑。节点设置显示执行前置条件与参数来源。
- 删除参数线保留执行线并明确说明；撤销参数连接能同时撤回本次新增的执行依赖。新显示的重复节点间执行线不参与原有布局权重，保留卡片尺寸及节点坐标。
- 新增 15 项回归，UI 70 项、Web 2 项测试通过，两个前端包类型检查与构建通过。浏览器在未保存草稿中真实拖拽验证了双向混接拒绝、合法参数连接自动补依赖、执行点单独连接、参数删除/重连、撤销及已有 PASS 条件保留；节点坐标逐项比对一致。
