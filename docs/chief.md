# Chief 的修复能力与权限边界

Chief 负责诊断和发出受约束的调度指令。修复产物走现有 Flow：读取证据 → 给原生产节点注入修复指导 → 从该节点重跑 → 下游独立验收。原有图、节点定义、验收标准和成功条件保持不变。

## 能力与限制

| 操作 | 行为 |
| --- | --- |
| 读取产物 | Runtime 为 Chief 构造只读 ContextManifest，授权本次运行已引用的产物、最近执行的输入和日志/diff；其他运行的产物 ID 不会授予读取权限。 |
| 分页读取 | 复用 `list_context_inputs` / `read_artifact`，每页默认 8 KiB，累计读取默认不限制。决策提交时保存 manifest 和读取凭据。 |
| 修复指导 | `inject_guidance` 写入节点的后续执行上下文；指定 scopeKey 可以只影响某一 Loop 轮次或 Parallel 项。 |
| 重做并验收 | `rerun_from_node` 使目标及依赖它的下游重新执行；嵌套输出变化也会使外层消费者失效，其他并行项保留。 |
| 技术重试 | `retry_node` 只用于 FAILED 执行；修复已有产物应从生产节点 `rerun_from_node`，不能仅重试审阅者。 |
| 换 Agent | 目标必须是存在的 AgentNode，显式 scopeKey 必须匹配本次运行的具体节点实例。配置的 Chief profile 解析失败时记录失败，不回退到默认 Agent。 |
| 回答问题 | 可回答普通 Agent 问题；不能代答 GateNode、循环耗尽的人工关卡或带 `requiredRole` 的问题。需要人工判断时使用 `escalate`。 |
| 最终验收 | Chief 没有修改 verdict、验收标准、图结构或 writeScopes 的命令；成功与否仍由原图的执行结果和验收分支决定。 |

重跑会清除受影响节点和容器的旧输出、verdict、当前验收引用和等待引用，旧 Assessment 标记为 stale，未回答的旧 WaitRequest 变成 CANCELLED。旧等待请求不能再被回答。重跑较早的 Loop 轮次会移除依赖旧反馈的后续轮次，使其重新产生；历史 attempt、Conversation 和不可变产物版本保留。

Chief 使用既有 `maxLevel`、`maxInterventionsPerRun` 和 `maxLoopRoundExtension`。默认分别为 `operate`、20 次、额外 2 轮；人工聊天里的操作也受同样约束，单纯解释和报告不消耗人工聊天干预次数。Token/费用预算没有新增默认限制。命令是否执行，以 `chief.intervened.applied/rejected` 为准，不以模型回复里的承诺为准。

## 嵌入 SDK 和独立 Server

- `workflow-runtime` 负责诊断上下文、命令校验、状态变迁和重跑失效传播；`ChiefSupervisor` 可由宿主实现，读取能力通过可选 `ChiefReviewInput.context` 提供。
- `workflow-agents` 的 `AgentChiefSupervisor` 提供默认 LLM 诊断和修复指令。只有完整结束的决策 turn 才能解析执行。
- `workflow-node` 的 `RunService.messageChief` 先记录消息，回答和重跑进入已有运行队列并持有运行租约。正在执行时，消息会排队等待当前执行结束或停在等待状态；回复产生后，服务自动推进被重新打开的 Flow。
- 其他宿主持有有效租约时，当前服务拒绝发起 Chief 操作；服务关闭或租约丢失会取消 Chief，迟到的决策不会提交。直接调用 Runtime 的宿主仍需管理自己的单一运行驱动和跨进程租约；Runtime 会拒绝在本实例仍有节点执行时重试或重跑。
- Server 复用这些 SDK 路径，不承担额外修复逻辑。嵌入宿主可以直接使用 SDK，无需部署 Server。

## 宿主参数与扩展

宿主策略作为 SDK 构造参数传入，不写进图或节点定义。省略新增参数时保留原行为；新增 Chief 命令、读取和工具名单配置在创建 Runtime/Executor 时取快照，修改调用方的配置数组不会改变正在运行的实例。

| 参数 | 默认值 | 宿主可控制的行为 |
| --- | --- | --- |
| `chiefOptions.allowedCommands` | 由 Flow 的 `chief.maxLevel` 决定 | 与 maxLevel 取交集，`[]` 禁止所有命令但仍可回复。自动干预和聊天命令提交前都校验，拒绝原因写入 `chief.intervened`。 |
| `chiefOptions.context.enabled` | `true` | `false` 不向 Chief 授予产物读取，仍可根据运行状态诊断。 |
| `chiefOptions.context.pageReadBytes` | 8 KiB | 每页读取字节数，必须为正安全整数。 |
| `chiefOptions.context.stageReadQuotaBytes` | 不限制 | 显式设置每次 Chief review 的累计读取额度，必须为正安全整数；不设置 Token 限制。 |
| `chiefOptions.context.includeArtifact` | 纳入本 Run 符合条件的产物 | 同步/异步回调按 `runId`、产物元数据和引用位置筛选。只能缩小授权范围；回调抛错时本次诊断失败，不回退到全量授权。 |
| `chiefPermissions.allowedToolKinds` | `read/search/think` | 允许的原生只读工具类型；`[]` 关闭这些按类型授权。 |
| `chiefPermissions.allowArtifactReads` | `true` | 单独控制已挂载的 SDK 产物读取工具，不受原生只读类型列表影响。 |
| `chiefPermissions.additionalReadOnlyTools` | `[]` | 宿主明确保证只读的工具全名列表，精确匹配，不支持通配符。允许适配器将这些工具标记为 `other/execute`；明确的 edit/delete/move/switch_mode 仍拒绝。 |
| `onRequestPermission(id, request, context)` | SDK 默认策略 | 在 Chief 权限上限内进一步判断；context 含 runId、scopeKey、nodeId、attemptId、signal 和补全后的 toolCall。原有两个参数的回调兼容，普通 Agent 节点也有此上下文。 |
| `runOptions.autoContinueAfterChief` | `true` | 传给 `WorkflowHost.open`；`false` 只提交 Chief 聊天决策，不从该回复启动后续节点。直接构造 `RunService` 时传同名参数。 |
| `runOptions.ownerId / leaseTtlMs` | 随机 ID / 30 秒 | 配置 SDK 运行驱动的租约归属与周期，队列和单驱动约束保持生效。 |

`chiefOptions` 可直接传给 `createWorkflowRuntime`，也可通过 `createNodeWorkflowRuntime` / `createAgentWorkflowRuntime` 传入。两层 Node 组装同样透传 `chiefPermissions`、`onRequestPermission`、`artifactTools`、`captureChanges` 和 `conversationStore`。所有可选参数都在 SDK，Server 不需要另实现一套策略。

```ts
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';
import { WorkflowHost } from '@universal-agent/workflow-node';

const { runtime, db } = createAgentWorkflowRuntime({
  workdir: process.cwd(),
  chiefOptions: {
    allowedCommands: ['report', 'inject_guidance', 'rerun_from_node', 'escalate'],
    context: {
      pageReadBytes: 16 * 1024,
      // 不传 stageReadQuotaBytes，累计读取仍不限。
      includeArtifact: ({ artifact }) => artifact.portName !== 'privateNotes',
    },
  },
  chiefPermissions: {
    allowedToolKinds: [], // 仅使用已授权的产物工具和宿主登记的只读工具。
    additionalReadOnlyTools: ['mcp__host__read_issue'],
  },
});
const host = await WorkflowHost.open({
  runtime, db,
  runOptions: { ownerId: 'embedded-app', autoContinueAfterChief: false },
});
// 调用方管理生命周期：结束时 await host.close()，然后 db.$client.close()。
```

工具名单只授予权限，不负责挂载宿主工具；工具由宿主的 Agent 配置/adapter 提供。`autoContinueAfterChief: false` 也不是持久暂停：Run 仍为 RUNNING，显式调用 `resumeInterrupted`、已启用的恢复监听或其他宿主驱动仍能继续它。完全自行调度的宿主直接调用 Runtime；采用 SDK RunService 的宿主按需启用恢复。

已有扩展点继续使用：通过 Agent profile 的 charter/instructions 定制 Chief 职责，通过 `chief: ChiefSupervisor` 替换决策实现，通过 `adapters` 替换引擎执行，通过 `conversationStore` / `WorkflowHost.conversationOptions` 定制会话存储和运行策略。宿主可增加自己的业务策略，但不能通过参数改写验收结果、绕过人工关卡或破坏重跑失效、取消和历史保留语义。

## ACP 工具权限

默认 Executor 对 `$chief` 的 ACP 权限请求设置只读上限：允许 read/search/think，以及已挂载的两个产物读取工具；拒绝写入、删除、移动、shell 执行、切换模式和无法识别的工具。兼容适配器只在权限请求中发送 toolCallId 的情况，结合此前工具事件识别产物读取。宿主可通过 `chiefPermissions` 缩小权限或登记自己的只读工具，`onRequestPermission` 在此上限内继续判断。其他普通节点保持原权限处理。

这是对 ACP 权限请求的检查，不是操作系统沙箱。底层引擎的绕过审批模式、未上报的原生工具或自定义 adapter，需要宿主提供对应的只读进程/文件系统隔离。原节点修复工作区时继续受自身的执行配置约束。

## 回归验收

- 真实 Runtime、默认 Chief 实现和 ArtifactStore：失败产物超过 128 KiB，Chief 分页读完、拒绝跨 Run 读取、指导作者重做、审阅者重新执行后 PASS；原文件版本、旧验收和读取凭据可查询。
- 嵌套 Parallel 修复后重新汇总与验收，兄弟项不重跑；早期 Loop 修复后重新生成后续轮次；自动干预清除当前子作用域时正确返回调度器。
- 人工关卡、指定角色问题、无效 scope、配置错误、干预次数用尽、重复消息、执行中重跑、取消后的迟到决策均有回归覆盖。
- 真实 SQLite 和 RunService：执行中发消息、排队修复、自动续跑、双宿主租约冲突和 Chief 思考时失去租约。
- Executor 的 ACP 边界测试覆盖只读上限、宿主回调不能越权、产物 MCP 读取、未知工具拒绝和普通节点权限兼容。
- 宿主配置覆盖自动/聊天命令白名单、maxLevel 交集、禁用/筛选产物、显式分页额度、过滤失败、非法配置、只读工具扩展及回调上下文；真实 Node/Agents 组装与 WorkflowHost 验证透传、关闭自动续跑和显式恢复。

这些测试使用模拟模型/ACP 会话，不保证模型每次都能找到修复方案，也不代替底层引擎隔离验证。业务授权、凭据或人工验收缺失时，Flow 应明确等待或失败；Chief 不能为了结束运行而绕过它们。
