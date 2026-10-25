# 真实 Agent 的 Flow 验收

运行 `pnpm --filter @universal-agent/workflow-server test:acceptance:live`。默认使用本机 DeepSeek 配置，调用真实模型。每次创建独立的 Git 测试目录，保存主 Flow `test-full-acceptance` 和子 Flow `test-full-acceptance-repair`，通过 SDK 的 `WorkflowHost` 执行。与默认 Server 共用数据库，因此运行、Conversation 和历史重试可以直接在前端查看。

主流程为：准备产物 → 只读权限探针 → 修复子流程 → 验证返回结果。子流程为：Agent 生成代码 → 脚本独立验收 → condition。`NEEDS_FIX` 进入有界回路并触发 Chief；`PASS` 输出验收报告。Chief 读取产物，向原 Agent 节点注入指导，并从原节点重跑，下游重新验收。图和节点执行仍使用既有 SDK。

测试包含两处明确的故障注入：

- Runner 通过现有 `adapters` 参数，让第一次 implement 调用启动一个立即退出的 ACP 子进程；普通 Executor 保存失败 Conversation，Flow 的 `maxTechnicalRetries: 1` 再调用真实 DeepSeek。后续 Agent、Chief 和工具结果都来自真实执行。
- 初次实现刻意生成 `a - b`，独立验收要求 `a + b`。Chief 必须指导原生产节点修复，不能修改测试或覆盖 verdict。

权限探针是 `writeScopes: []` 的普通 Agent 节点，主动请求一次受保护文件的写入权限，由 SDK 默认策略拒绝。生产节点写入 `src/add.mjs` 的权限应被允许。两种请求和回答都必须出现在 Conversation 中，受保护文件必须保持原样。DeepSeek 的请求使用工具自身的一次性审批参数，确保测试经过 ACP 权限回调；直接触碰只读沙箱可能仅产生工具失败，不能替代 SDK 拒绝记录。

Runner 对最终结果执行断言，覆盖：运行成功、子流程快照、失败 Conversation、技术重试、真实 Agent 会话、工具调用与结果、允许和拒绝权限、受保护文件、condition 的回路与通过路径、真实 Chief 会话及产物读取、指导与重跑命令、原节点重做、旧验收失效和新验收通过、无被拒绝的 Chief 命令。任何一项缺失都以非零状态退出；不能仅凭 Flow 的 SUCCEEDED 宣布验收通过。

运行目录下保存 `invocation.json`、`run.json`、`conversations.json` 和 `result.json`。数据库保留所有运行和不可变定义版本，失败试跑也不删除。控制台打印精确的运行 URL 和报告路径。

可选参数：`--home` 指定 SDK 数据目录，`--id` 指定测试 Flow ID，`--engine` / `--model` / `--mode` 指定真实引擎配置，`--server-url` 控制报告中的前端链接，`--timeout-ms` 指定整次验收的等待时间（默认 15 分钟）。Agent profile 按内容生成版本，切换参数不会改写已运行的 profile。默认 `read-only` 是 DeepSeek 的模式名，换引擎时需选择该引擎支持的模式。

在前端直接重新运行已保存的主 Flow，会复用默认 Server 的 SDK 权限、Chief、子流程和 condition 路径；启动故障只由验收 Runner 注入。为了重新覆盖启动失败及重试，应运行上述命令。测试子流程需要主流程的 spec 输入和 Chief 策略，应从主流程开始运行。

## 2026-10-24 实跑结果

最终运行：[`run_e7f4a76e-dd0d-4a6a-8d19-977792588a43`](http://127.0.0.1:4317/#/w/test-full-acceptance?run=run_e7f4a76e-dd0d-4a6a-8d19-977792588a43)，真实 DeepSeek 引擎，81.6 秒，`SUCCEEDED`，17 项验收断言全部通过。

- 5 条 Conversation：1 次注入的启动失败、权限探针 1 次、生产节点 2 次真实完成、Chief 1 次真实完成。失败和 Retry 1 使用相同 attemptId、不同 Conversation；Chief 重做产生独立 attemptId。
- SDK 默认权限策略记录 1 次 `reject_once`、2 次 `allow_once`，protected.txt 未变化。
- `verify` 先返回 `NEEDS_FIX`，condition 进入修复回路。Chief 实际读取产物，提交 `inject_guidance` 和 `rerun_from_node`，两个命令均被应用。
- 原生产节点在相同 scope 重做，旧验收标记 stale，独立脚本重新验收为 `PASS`；子流程报告返回父流程，最终四个用例均通过。
- 前端确认显示 Succeeded；节点 Conversation 可选择 Initial call / Failed 和 Retry 1 / Completed，失败原因 `ACP connection closed`、工具输入输出及权限记录可见。Server 现有 12 项回归测试通过。

完整报告：[result.json](/Users/django/.universal-agent/workflow/acceptance/full-e3DfyE/result.json)。同目录保留运行状态及 Conversation 事件。

首次试跑的 Flow 虽已成功结束，但“SDK 拒绝记录”断言未通过：写入在引擎只读沙箱内被拒绝，未到达 ACP 回调。该次未计为验收通过。测试随后改为请求一次工具级审批，并将探针独立为只读节点，验证 SDK 默认拒绝策略；没有修改权限实现或放宽断言。

## 节点并行属性验收（2026-10-24）

运行 `pnpm --filter @universal-agent/workflow-server test:acceptance:live --parallel`，使用 [节点并行属性](node-parallel.md)。该模式创建独立的 `test-parallel-acceptance`，不覆盖上述串行验收 Flow。

最终运行：[`run_56af4ac7-6bfd-4677-ab0b-66ee4abe9c53`](http://127.0.0.1:4317/#/w/test-parallel-acceptance?run=run_56af4ac7-6bfd-4677-ab0b-66ee4abe9c53)，真实 DeepSeek，74.3 秒，`SUCCEEDED`，25 项验收断言全部通过。

- 保存的父图只有普通 Agent、Script、Sub-flow，三种节点都实际使用 `parallel` 属性，每批两项。
- 8 条 Conversation：两个权限探针、两个 ACP 启动失败、两次技术重试成功、Chief 一次、alpha 修复一次。两项初始失败与 Retry 1 分别归属自己的 scope；alpha 的修复产生新 attempt，beta 只执行一个生产 attempt。
- 权限记录包含两次 `reject_once` 和三次 `allow_once`，protected.txt 保持不变。工具调用和完整事件保存在 Conversation。
- alpha 经 Condition 返回 NEEDS_FIX，Chief 读取产物，在准确的 alpha scope 注入指导并重跑 implement；beta 的成功记录保留。旧 alpha 验收 stale、新验收 PASS，两个子流程共八个加法用例通过。
- Script 并行节点同时输出 `label = ["alpha", "beta"]` 和 `checked = [true, true]`；父节点保留每项完整状态和输出。两个独立验收的 PASS 汇总后，外层 Condition 才进入 finish。未使用第一个端口作为其他端口的替代。
- 前端画布保留单节点和原类型，执行详情可按 Item 选择子流程内的 Agent，再选择 Initial call / Failed、Retry 1 / Completed 和 Chief 重做；失败原因与权限结果可查询。

完整报告：[result.json](/Users/django/.universal-agent/workflow/acceptance/full-Bc5odB/result.json)。同目录包含 `run.json`、`conversations.json` 和 `invocation.json`。

前两轮 `run_1aa6ccd5-8beb-4ed3-b6f0-f2da1ba6ff12`、`run_a1307453-5e4f-406e-83f1-88b80576a386` 通过原来的 24 项断言。增加外层 Condition 后，`run_34029fc7-b123-4c9d-a228-941cde05dc15` 虽完成 Flow，但严格验收失败：Chief 把 `/implement` 拼进 scopeKey，两条修复指令均被正确拒绝，未完成预期的 Chief 修复。这轮没有算作通过，记录保留在 `full-6Nf0V5`。根因是 SDK 的验收摘要将 scope 与 nodeId 拼成路径；现已改为明确的 `target={scopeKey,nodeId}`，并用“并行子流程内循环、只重做失败项”的确定性回归验证可直接使用目标。最终实跑通过全部 25 项，指令无拒绝；没有放宽运行时校验或验收断言。

确定性回归额外覆盖乱序完成、宿主并发上限、空列表、未开启时原行为、失败项位置、必填输出缺失、fail-fast 取消权限等待、外部取消、产物引用继续传递、验收汇总驱动 Condition 循环及单项 Chief 修复。相关七个包共 269 项测试、类型检查和构建通过。真实验收只证明上述场景，不能保证任意模型都会正确完成任意任务。
