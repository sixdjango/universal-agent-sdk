# 节点按项并行

Agent、Script、Sub-flow 保持原节点类型，通过可选的 `parallel` 属性按输入列表运行。不同普通节点之间仍由图依赖和写入范围决定能否同时执行。

```ts
builder.addAgent({
  id: 'review', name: 'Review each file', role: 'reviewer', goal: 'Review this file',
  inputs: [{ name: 'file', type: 'json', required: true }],
  outputs: [
    { name: 'report', type: 'json', required: true },
    { name: 'passed', type: 'boolean', required: true },
  ],
  parallel: { itemsPort: 'file', maxConcurrency: 4, failurePolicy: 'settle_all' },
});
```

端口声明描述**一次执行**：图上的 `file` 接收数组，每项调用仍从 `file` 取单个值。其他输入原样共享；所有输出端口分别汇总成数组，保留输入顺序，和完成先后无关。可以用 SDK 的 `nodeBoundaryPorts(node, 'in' | 'out')` 获取连线看到的端口类型。输入本身是数组类型时，开启后接收数组的数组；每项得到一个数组。

未设置 `parallel` 时只执行一次；并发数设为 1 时仍逐项执行。空列表得到各端口的空数组；非数组列表输入明确失败。前端提供开关、列表端口、并发数、失败策略，新增节点菜单不再提供独立 Parallel。单节点画布保留节点 ID、类型和连接，在执行详情的 **Item execution** 中选择任务项，再查看其 Conversation 和各次重试。Sub-flow 的每项包含完整子流程，可包含条件分支和循环。

## 写在定义里的 Parallel 容器（内联子流程）

需要每项跑一段多步流程、又不想另存一个 workflow 时，用 `addParallel({ itemsPort, itemBody })`，内部流程直接写在 `itemGraph` 里；画布上点进这个步骤即可看到并编辑内部流程。容器内部和节点 `parallel` 属性规则一致：

- `$input.<itemsPort>` 是**当前这一项**（外面接的是列表），`$input.itemIndex` 是它在列表中的位置（从 0 开始）；
- 容器的其他输入原样共享给每项；
- 内部写到 `$output.<name>` 的值按输入顺序汇总成数组。

```ts
builder.addParallel({
  id: 'pages', name: 'Build each page', itemsPort: 'page', maxConcurrency: 3,
  inputs: [{ name: 'page', type: 'array', required: true }, { name: 'system', type: 'artifact', required: true }],
  outputs: [{ name: 'report', type: 'array', required: true }],
  itemBody: (b) => b
    .addAgent({ id: 'build', name: 'Build page', role: 'developer', goal: 'Build this page', inputs: [{ name: 'page', type: 'json', required: true }] })
    .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'build', toPort: 'page' }), // 当前这一页
});
```

`workflow-contract` 把属性编译成现有按项执行 scope；保存的定义不改成容器。Agent/Script 实例身份为 `scopeKey = "$root/review[0]"`、`nodeId = "review"`。Sub-flow 再进入自己的子流程 scope。现有低层 Parallel 容器继续作为调度机制使用，不需要宿主重写图调度。

- `settle_all`：运行其他项，等全部结束后，只要有失败就将整个节点标记 FAILED。
- `fail_fast`：失败后停止派发并取消运行中的其他项；等待全部执行器收尾后返回 FAILED。取消中的权限会在 Conversation 留档，不做技术重试；未启动项标记 SKIPPED。底层 Node 状态没有 CANCELLED，已启动的取消项以 FAILED 和明确的取消原因表达，Conversation 为 cancelled。
- 外部 AbortSignal 继续遵循现有中断语义，向调用方抛出取消；即使执行器在取消后返回成功也不会发布结果。宿主仍负责驱动中断后的恢复。
- 失败批次保留完整 `nodeState.parallelItems`（每项 scope、状态、输出和错误），并在各输出数组中保留缺失位置为 `null`；不能只看数组判断成功，必须同时读取状态。必填输出缺失也会失败。失败结果不解锁正常下游。
- 每项原始输出的 `artifactId` 保留在 `parallelItems` 中；聚合端口需要时携带 `items` 元数据，下游并行节点仍可按原产物引用读取和分页。不会用第一个输出替代其他输出，也不会将合法的 `null`、`false`、`0` 或空字符串丢掉。
- 当每项都有验收 verdict 时，整体按 `BLOCKED > FAIL > NEEDS_FIX > PASS` 汇总，全部 PASS 才返回 PASS，从这个节点出发的条件连线可以继续按它分支，或直接从它画回退线建立回路。执行失败与验收失败保持区别：正常完成但 NEEDS_FIX 的项可进入修复分支；空列表或缺少 verdict 不伪造 PASS。
- 重试、权限、Conversation 沿用每项自身的 scope/attempt/invocation/retryIndex。Chief 的 `inject_guidance` 和 `rerun_from_node` 应同时提供准确的 `scopeKey`，只修复目标项，保留兄弟项；受影响的汇总和下游验收重新生成。SDK 的 Chief 上下文为每个节点、验收记录提供独立的 `target={scopeKey,nodeId}`，可以直接复制到指令中；不能把节点 ID 追加到 scopeKey。错误目标仍由运行时拒绝。

宿主可向 `createWorkflowRuntime`、`createNodeWorkflowRuntime` 或 `createAgentWorkflowRuntime` 传入 `parallelOptions: { maxConcurrency: 2 }`。实际并发数取节点配置和宿主上限的较小值；这是每个批次的上限，不是整个进程的全局限流器。写入隔离沿用 `isolation` 和 `writeScopes`，默认自动隔离并行写入者：

- 每个写入者在自己的副本里工作。macOS（APFS）上整个仓库按写时复制克隆，`node_modules`、`dist` 都是独立副本；其他平台用 git worktree，被忽略的目录软链接回原仓库。
- 跑完后三方合并回工作区（`git merge-tree`），只有改到同一处才算冲突。
- 工作区槽位可以配置 `mergeCheck`（如 `{ command: 'pnpm', args: ['typecheck'] }`）。一步的改动和别人期间的改动合到一起时，先在副本里对合并结果跑这个检查，通过才落地；失败按冲突处理。
- 冲突（或检查失败）的步骤会在最新工作区的新副本里自动重做一次，agent 会被告知冲突的文件或检查输出，以及之前的改动保存在哪个分支（`git show <branch>`）。再次冲突则该步失败，改动留在分支上，由 Chief（`node.failed`）或人接手。

逻辑全部位于 SDK；Server 提供现有 API 和持久化宿主。浏览器或其他宿主也能使用同一份定义、编译器、运行时和分项详情。

运行 `pnpm --filter @universal-agent/workflow-server test:acceptance:live --parallel`，会创建 `test-parallel-acceptance` 及其子流程，在新的 Git 工作目录调用真实 Agent。两项分别经历一次 ACP 启动故障及技术重试；两项权限探针应被 SDK 默认策略拒绝；生产节点写入获准。alpha 的预置缺陷由 `verify` 的 NEEDS_FIX 回退线触发 Chief 定点修复，beta 的成功执行必须保留。Script 并行节点独立汇总两个输出，再由它出发的 `if PASS` 连线检查整体 PASS，最终进行严格断言并保存完整报告。
