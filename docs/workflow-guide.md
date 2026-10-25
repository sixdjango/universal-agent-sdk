# Universal Agent Workflow 指南

这份指南讲清楚 workflow 编排能做什么、各个概念怎么配合，以及三种用法：网页、命令行 / HTTP、嵌入 SDK。读完不需要看源码就能上手。

- 速查和接入外部系统：[workflow-integration.md](./workflow-integration.md)
- HTTP API：[workflow-api.openapi.json](./workflow-api.openapi.json)（OpenAPI 3.1）
- 专题：[Chief](./chief.md)、[对话记录](./conversations.md)、[按项并行](./node-parallel.md)、[发布](./releasing.md)

---

## 1. 它解决什么

把多个 AI agent（Claude Code、Codex、DeepSeek、Kimi……）和脚本编排成一个可靠的流程：

- **按图执行**：步骤之间有先后、有分支、有回退循环、有并发。
- **评审驱动**：评审步骤给出结论（PASS / NEEDS_FIX / FAIL / BLOCKED），流程据此往下走、打回重做或停下。
- **安全地并发改代码**：并发写同一个仓库的步骤各自在副本里工作，三方合并回来，可再跑一次检查。
- **全程留痕**：每一步的输入、产物、结论、改动、agent 对话都记录下来，可回放、可重跑某一步。
- **有人兜底**：Chief（监督 agent）在失败、卡住、需要提问时介入；人可以随时和它对话、回答问题、停止 run。

编排层不关心每一步的内容怎么做。agent 自己读文件、看图、写代码；编排层负责调度、数据传递、隔离与合并、监督和记录。

## 2. 包与分层

| 包 | 作用 | 什么时候直接用 |
|---|---|---|
| `@universal-agent/client` | 启动和驱动各家 agent（ACP 协议），记录对话 | 只想在自己的程序里调用 agent |
| `@universal-agent/workflow-contract` | workflow 定义的 schema、builder、编译器 | 生成或校验 workflow 定义（可在浏览器里用） |
| `@universal-agent/workflow-runtime` | 调度器和运行时：执行、循环、并行、Chief、事件日志 | 自己提供执行器和存储，嵌入任何环境 |
| `@universal-agent/workflow-node` | Node.js 宿主：SQLite 存储、agent/脚本执行器、git 隔离、`ua-workflow` CLI | 在 Node 里嵌入完整的编排能力 |
| `@universal-agent/workflow-agents` | agent 档案注册表和 LLM Chief | 嵌入时需要 agent 档案和 Chief |
| `@universal-agent/workflow-server` | HTTP 服务、命令行 `universal-agent-workflow`、JS 客户端、OpenAPI | 起一个服务，用网页 / CLI / API 操作 |
| `@universal-agent/workflow-ui` | React 组件：画布编辑器、Inspector、Trace、Chief 对话框 | 把画布嵌进自己的前端 |
| `@universal-agent/workflow-web` | 用 workflow-ui 构建好的网页（由 server 提供） | 一般不直接用 |

依赖方向：`contract ← runtime ← node ← agents ← server`，`ui` 依赖 `contract` 和 `runtime`。

## 3. 快速开始

需要 Node.js ≥ 22.13，以及至少一个已登录的 agent CLI（例如 `claude login`，见 [client 的认证说明](../packages/agent-client/README.md#authentication)）。

```bash
npm install -g @universal-agent/workflow-server
universal-agent-workflow --workdir ~/my-project        # 启动服务和网页：http://127.0.0.1:4317
```

在网页里新建 workflow，拖出步骤、连线、保存，点 **Run**。也可以用命令行：

```bash
universal-agent-workflow workflows                                   # 已保存的 workflow
universal-agent-workflow run my-flow --input request='"Add a dark mode toggle"' --watch
universal-agent-workflow findings <runId>                            # 还没解决的问题
```

或者在代码里定义并直接运行（不需要服务）：

```ts
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';
import { createNodeWorkflowRuntime } from '@universal-agent/workflow-node';

const flow = createWorkflowBuilder('hello', 'Hello workflow')
  .addWorkflowInput({ name: 'name', type: 'string', required: true })
  .addWorkflowOutput({ name: 'greeting', type: 'string', required: true })
  .addScript({
    id: 'greet',
    name: 'Greet',
    command: process.execPath,
    args: ['-e', `const fs = require('node:fs');
      const name = fs.readFileSync(process.env.UA_INPUT_NAME, 'utf8');
      fs.writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { greeting: 'Hello, ' + name } }));`],
    inputs: [{ name: 'name', type: 'string', required: true }],
    outputs: [{ name: 'greeting', type: 'string', required: true }],
    producesAssessment: false,
  })
  .connectData({ fromNodeId: '$input', fromPort: 'name', toNodeId: 'greet', toPort: 'name' })
  .connectData({ fromNodeId: 'greet', fromPort: 'greeting', toNodeId: '$output', toPort: 'greeting' })
  .buildDefinition();

const runtime = createNodeWorkflowRuntime({ workdir: process.cwd() });
const { runId } = await runtime.start({ definition: flow, inputs: { name: 'Ada' } });
const done = await runtime.runUntilSettled(runId);
console.log(done.status, done.outputs.greeting); // SUCCEEDED Hello, Ada
```

---

## 4. Workflow 定义

workflow 是一份 JSON（`WorkflowDefinition`），可以用 builder 写，也可以任何语言直接生成，用 `validateWorkflowDefinition()` 校验。

| 字段 | 说明 |
|---|---|
| `id`、`name`、`version`、`description` | 标识和说明 |
| `inputs` / `outputs` | workflow 的输入、输出端口（运行时传入 / 产出） |
| `graph` | `{ nodes, controlEdges, dataEdges }`：步骤、流向连线、数据连线 |
| `workspaces` | workspace 槽位（运行时绑定到具体目录），见第 9 节 |
| `defaultWorkspace` | 不指定槽位的步骤用哪个，默认第一个 |
| `chief` | Chief 策略，不写就没有监督，见第 12 节 |

图里有两个特殊节点：`$input`（workflow 或容器的输入）和 `$output`（输出）。

### 4.1 端口

每个步骤声明 `inputs` 和 `outputs`，每个端口 `{ name, type, required, description?, defaultValue? }`。

`type` 可选：`string`、`number`、`boolean`、`json`、`array`、`artifact`（大块文本，按版本存储）、`assessment`（评审结论，见第 6 节）。

### 4.2 数据连线（dataEdges）

`{ fromNodeId, fromPort, toNodeId, toPort, required, delivery }`，把一个输出交给另一个步骤的输入。

- 数据连线本身不决定执行顺序；需要"等它做完再开始"时，加流向连线，或在 builder 里写 `withControl: true`。
- `required: false` 的输入可以缺省。
- `delivery`：`auto`（默认，小的直接内联进 prompt，大的给 artifact 引用）、`inline`、`artifact_ref`（agent 用 `read_artifact` 工具按需分页读取）。

### 4.3 流向连线（controlEdges）与条件

`{ fromNodeId, toNodeId, when?, loop? }`：上一步结束后、条件成立时，这条线"激活"。一个步骤要等所有入线的上游都结束：至少一条激活就执行，一条都没激活就被跳过（SKIPPED），并向下传播。

| 条件 `when.kind` | 含义 |
|---|---|
| 不写 / `always` | 上一步成功就走（**不看 verdict**） |
| `verdict_is` / `verdict_in` | 评审结论是某个值 / 某几个值之一 |
| `port_equals` | 某个输出等于某个值 |
| `port_truthy` | 某个输出有值且为真 |
| `port_compare` | 某个输出 `>` `>=` `<` `<=` `==` `!=` 某个值；`measure: 'length'` 比较列表或文本长度 |
| `all` / `any` | 组合子条件（可嵌套） |
| `otherwise` | 同一步出发的其他带条件连线都不成立时 |

每个条件默认读连线起点那一步的结果，`sourceNodeId` 可以改读别的步骤。

```ts
builder
  .connectControl('score', 'ship', { kind: 'all', conditions: [
    { kind: 'port_compare', port: 'score', op: '>=', value: 90 },
    { kind: 'port_compare', port: 'issues', op: '==', value: 0, measure: 'length' },
  ] })
  .connectControl('score', 'polish', { kind: 'port_compare', port: 'score', op: '<', value: 90 })
  .connectControl('score', 'triage', { kind: 'otherwise' });
```

更复杂的判断，交给一个脚本步骤算出结果（如 `route`），再用 `port_equals` 分流。

---

## 5. 步骤类型

所有步骤共有：`id`、`name`、`description`、`inputs`、`outputs`、`writeScopes`（允许改动的路径）、`maxTechnicalRetries`（执行出错时自动重试次数）、`workspace`（槽位）、`isolation`、`enforceWriteScopes`。

### 5.1 Agent 步骤（`addAgent`）

交给一个 agent 完成。主要字段：

| 字段 | 说明 |
|---|---|
| `goal` | 任务目标（完整写进 prompt） |
| `acceptanceCriteria` / `constraints` | 验收标准、不可违反的约束（完整写进 prompt，不截断） |
| `agentRef` | 用哪个 agent 档案（`"id"` 或 `"id@version"`），见第 8 节 |
| `role` | 角色名；没有 agentRef 时按角色或引擎解析 |
| `agentType` / `modelId` / `modeId` / `effort` | 这一步单独覆盖引擎、模型、模式、推理强度 |
| `producesAssessment` | 是否是评审步骤（必须给出 verdict） |
| `promptTemplate`、`contextBudget` | 自定义 prompt 模板、上下文预算 |
| `parallel` | 按列表逐项并行，见第 10 节 |

agent 收到的 prompt 由编排层生成：agent 档案的职责和规则、目标、验收标准、约束、输入（内联或 artifact 引用）、workspace 和可写范围、上一轮反馈、Chief 指导，最后是输出格式。agent 在回复末尾给出结果块：

````text
```ua-workflow-result
{
  "outputs": { "score": 82 },
  "artifacts": { "spec": { "content": "# Spec …", "summary": "one line", "mediaType": "text/markdown" } },
  "assessment": { "verdict": "NEEDS_FIX", "summary": "…", "findings": [{ "id": "f1", "severity": "major", "message": "…", "filePath": "src/a.ts" }] }
}
```
````

- `outputs` 对应非 artifact 的输出端口；`artifacts` 对应 artifact 端口。
- 评审步骤必须有合法的 `assessment.verdict`，否则这一步按失败处理。
- 需要人拍板时，agent 可以返回 `"waitRequest": { "prompt": "…", "options": [{ "value": "a", "label": "A" }] }`，run 进入等待；回答后（或 Chief 代答）继续。
- agent 改动的文件会被记录为这一步的 CHANGES（diff）。

### 5.2 脚本步骤（`addScript`）

执行一个命令：`command`、`args`、`cwd`（相对 workspace）、`env`、`timeoutMs`（默认 60 秒）。

- 输入：每个输入写成一个文件，路径在环境变量 `UA_INPUT_<端口名大写>`；全部输入在 `UA_INPUTS_FILE`（JSON）。
- 输出：把结果写到 `UA_OUTPUTS_FILE`，格式同 agent 结果块：`{ outputs, artifacts, assessment }`。
- **注意：`producesAssessment` 默认是 `true`**——不写 assessment 时，退出码 0 视为 PASS，非 0 视为 NEEDS_FIX。普通脚本请设 `producesAssessment: false`。
- 脚本里可以用 `ua-workflow` 命令存取中间数据（第 11 节）。

### 5.3 Gate（`addGate`）

停下来问人：`prompt`、`options`（`{ value, label, description }`）。run 进入 WAITING；回答（网页、`POST /api/runs/{id}/respond`、或 `runtime.respond()`）后，答案写到 gate 的第一个输出端口（默认叫 `decision`），后面用 `port_equals` 分支。

### 5.4 容器：Parallel 与 Loop

- **Parallel**（`addParallel`）：内部图对列表的每一项各跑一遍，最多同时 `maxConcurrency` 个。也就是"内联子流程"。见第 10 节。
- **Loop**（`addLoop`）：内部图按轮重复。通常不用手写——画一条回退线（第 7 节）会自动编译成 loop。

画布上点进容器即可看到、编辑内部流程。

### 5.5 子流程（`addSubflow`）

运行另一个已保存的 workflow：`workflowId`。启动 run 时会把子流程的定义快照嵌进来（`resolveSubflows`），保证可复现。子流程也可以设 `parallel` 按项并行。不想另存一个 workflow 时，用 Parallel 容器写内联子流程。

---

## 6. 评审与 verdict

评审步骤（`producesAssessment: true`）给出 **assessment**：`verdict` + `summary` + `findings[]`（每条 `{ id, severity: critical|major|minor|info, message, filePath?, line? }`）。

| verdict | 含义 | 常见用法 |
|---|---|---|
| `PASS` | 通过（可以带 minor 的问题清单） | 往下走 |
| `NEEDS_FIX` | 有问题，可修 | 回退重做 |
| `FAIL` | 不合格，重做解决不了 | 失败分支或终止 |
| `BLOCKED` | 无法评审（缺信息、环境问题） | 交给人或 Chief |

- **执行失败和评审不通过不同**：评审正常跑完，步骤状态是 SUCCEEDED，verdict 附在上面；只有执行出错才是 FAILED。
- 评审步骤声明一个 `type: 'assessment'` 的输出端口，结论会自动填进去，可以用数据连线传给后面的步骤。
- 重跑后旧结论标记为过期（stale）；Chief 不能修改 verdict 和验收标准。

## 7. 回退循环

从"判断步骤"画一条回到前面某一步的连线，带上条件和 `loop`：

```ts
builder
  .connectData({ fromNodeId: 'write', fromPort: 'draft', toNodeId: 'review', toPort: 'draft', withControl: true })
  .loopBack('review', 'write', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 3, onExhausted: 'fail' });
```

- 第一轮也算一轮；条件成立就回到起点再来一轮，最多 `maxRounds` 轮。
- 轮次用完仍成立时，按 `onExhausted`：`fail`（判失败）、`gate`（停下来问人，回答 approve/pass/continue 才继续）、`pass_with_findings`（带着问题继续，verdict 保留为 NEEDS_FIX）。
- **上一轮的反馈自动传给下一轮**：summary 和 findings 注入下一轮起点步骤的 prompt。
- **循环携带值**：从循环里的步骤连回循环里更早步骤的数据连线（包括连回自己），会把上一轮的值带到下一轮（第一轮没有，所以这类输入设 `required: false`）。例：`write.spec → write.previous_spec`。
- 条件可以是组合条件，例如"NEEDS_FIX **或** 分数 < 80"。
- 每一轮有独立的作用域（`$root/review__loop:round_0`、`round_1`…），记录、对话、重试都按轮分开。

## 8. Agent、引擎与档案

**agent 档案**（`AgentProfile`）是可复用的角色：

```ts
{
  id: 'reviewer', version: '1', name: 'Reviewer',
  charter: 'Reviews changes against the acceptance criteria.',      // 职责，写在每个 prompt 开头
  instructions: ['Never edit files.', 'Name the file and line of each problem.'], // 规则
  skills: [],
  runtime: { adapter: 'acp', agentType: 'claude', modelId: 'sonnet', effort: 'high' },
}
```

- 注册：网页的 Agents 面板、`POST /api/agents`、或嵌入时 `createAgentWorkflowRuntime({ agents: [...] })`。**同一个 id + version 注册后不可修改**，改规则请升版本。
- 步骤用 `agentRef` 引用；容器的 `defaultAgentRef` 给内部步骤兜底；都没有时按 `role` / `agentType` 解析。
- 一个 run 开始用某个 agent 时会固定它的档案（pinned），回放和重跑结果一致。
- 引擎：`claude`、`codex`、`deepseek`、`kimi`、`pi`、`grok`、`devin`，以及任意说 ACP 协议的命令（`custom`）。认证由本机 CLI 负责，见 [client README](../packages/agent-client/README.md)。
- agent 在 workspace 目录里运行，仓库里的配置（skills、命令、模板）由引擎自己读取；图片、文件也由 agent 自己打开。

## 9. Workspace、隔离与合并

**槽位**：workflow 声明 `workspaces: [{ name, description?, required?, mergeCheck? }]`；启动 run 时把每个槽位绑定到一个目录（或登记过的 workspace id）。不声明时只有一个隐含槽位 `main`。

**写入范围** `writeScopes`：步骤允许改动的路径（如 `['src/ui']`）。没有写入范围的 agent 步骤是只读的，改文件的请求会被拒绝；有写入范围的步骤，改动才会被记录为 CHANGES。超出范围的改动默认只记录，`enforceWriteScopes: true` 时这一步失败。写入范围重叠的步骤会排队，不同时执行。

**隔离** `isolation`：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 可能和别的写入步骤同时执行时，在自己的副本里工作 |
| `worktree` | 总是在副本里工作 |
| `shared` | 直接在 workspace 里改 |

- 副本：macOS（APFS）上整个仓库按写时复制克隆（`node_modules`、`dist` 都是独立副本，几乎不占磁盘）；其他平台用 git worktree，被忽略的目录软链接回原仓库。需要 workspace 是 git 仓库。
- 合并：步骤结束后，把它的改动和期间别人的改动**三方合并**回 workspace（只有改到同一处才算冲突），不碰 git index。
- **合并检查** `mergeCheck: { command, args, timeoutMs }`：改动和别人的改动合到一起时，先在副本里对合并结果跑这个命令（如 `pnpm typecheck`），通过才落地。
- 冲突或检查失败：这一步在最新代码的新副本里**自动重做一次**，agent 会被告知冲突的文件或检查输出，以及旧改动所在分支（`git show <branch>`）；再冲突则失败，改动留在分支上。

## 10. 并行

**按节点并行**：Agent、Script、Sub-flow 步骤设 `parallel: { itemsPort, maxConcurrency, failurePolicy }`。端口描述"一次执行"：`itemsPort` 那个输入在图上接数组，每项执行拿到一个元素；所有输出按输入顺序汇总成数组。

**Parallel 容器（内联子流程）**：

```ts
builder.addParallel({
  id: 'pages', name: 'Build each page', itemsPort: 'page', maxConcurrency: 3,
  inputs: [{ name: 'page', type: 'array', required: true }, { name: 'system', type: 'artifact', required: true }],
  outputs: [{ name: 'report', type: 'array', required: true }],
  itemBody: (b) => b
    .addAgent({ id: 'build', name: 'Build page', role: 'developer', goal: 'Build this page',
      inputs: [{ name: 'page', type: 'json', required: true }], outputs: [{ name: 'report', type: 'json', required: true }] })
    .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'build', toPort: 'page' })   // 当前这一项
    .connectData({ fromNodeId: 'build', fromPort: 'report', toNodeId: '$output', toPort: 'report' }),
});
```

- 内部 `$input.<itemsPort>` 是当前这一项，`$input.itemIndex` 是序号（从 0 开始），其他输入原样共享。
- `failurePolicy`：`settle_all`（跑完全部，有失败则整体失败）或 `fail_fast`（一项失败就取消其余）。
- 每项都有评审结论时，整体取最严重的：`BLOCKED > FAIL > NEEDS_FIX > PASS`。
- 每项有独立作用域（`$root/pages[0]`…），重试、对话、Chief 修复都按项进行。
- 宿主可以用 `parallelOptions.maxConcurrency` 再限制一层。详见 [node-parallel.md](./node-parallel.md)。

## 11. 中间数据、产物与交接

| 数据 | 怎么产生 | 存在哪 |
|---|---|---|
| 输出值 | 结果块的 `outputs` | run 状态（作用域的节点输出） |
| 产物（artifact） | 结果块的 `artifacts`、artifact 类型的输出 | `artifacts` 表；内容按 sha256 去重，≤1 MB 存表里，更大的写到 `blobs/` |
| 评审结论 | 结果块的 `assessment` | `assessments` |
| 文件改动 | 步骤改了 workspace | workspace 本身；diff 作为 `changes` 产物记录 |
| 步骤数据 | `ua-workflow data put/append`、MCP `data_*` | `node_data` 表；默认属于这一步，`--shared` 属于整个 run |
| 遗留问题 | `ua-workflow issue`、MCP `log_issue` | `node_data` 的 `issues` 集合（run 共享） |
| 对话 | agent 的每次执行 | `conversations*` 表 |

**步骤内工具**（agent 的 shell、脚本都可以用 `ua-workflow` 命令；agent 另有同名 MCP 工具）：

```bash
ua-workflow data put notes plan '{"steps":3}'           # 存（JSON 或文本）
ua-workflow data get notes plan                          # 取
ua-workflow data append metrics '{"round":1}' --shared   # 追加到 run 共享集合
ua-workflow data list --shared --collection metrics      # 列出
ua-workflow inputs                                       # 这一步收到的输入
ua-workflow artifact read <artifactId> --max 65536       # 分页读产物
ua-workflow issue "Card radius is 16px, design has 14px" --severity minor --file app/styles.css
ua-workflow findings                                     # run 里还没解决的问题
```

**允许留问题、最后交接给人**：

1. 评审分级：只对 critical/major 给 NEEDS_FIX，minor 给 PASS 并写进 findings。
2. 回退线 `onExhausted: 'pass_with_findings'`：修不完不卡住。
3. 步骤主动登记已知妥协：`ua-workflow issue …`（同一步每轮重复登记只算一条）。
4. **open findings**：每个评审步骤最新、未过期的结论里的问题（循环只看最后一轮，并行各项分开）+ 登记的 issues，按严重程度排序。获取：`ua-workflow findings`、`universal-agent-workflow findings <runId>`、`GET /api/runs/{id}/findings`、`runtime.getOpenFindings(runId)`。
5. 最后一步读取 findings 写交接文档（如 `HANDOFF.md`：问题、文件、证据、可直接粘贴的修改提示），人接着微调。

## 12. Chief（监督 agent）

在 workflow 上设 `chief` 即开启：

```ts
builder.setChief({ maxLevel: 'operate' }); // 不指定 agentRef 时用内置的 Default chief，引擎跟 flow 里的 agent 走
```

| 字段 | 说明 |
|---|---|
| `agentRef` | 用哪个 agent 当 Chief；不写用 Default chief |
| `maxLevel` | 权限上限：`observe`（只汇报）< `advise`（注入指导）< `escalate`（问人）< `operate`（重试、重跑、换 agent、代答、延长循环） |
| `triggers` | 何时叫醒：`node.failed`、`loop.round_needs_fix`、`wait.requested`、`run.stalled`、`budget.exceeded`、`escalation.resolved`、`user.message` |
| `maxInterventionsPerRun` | 每个 run 最多介入次数（默认 20） |
| `maxLoopRoundExtension` | 最多给一个循环加几轮（默认 2） |
| `budget` | token / 费用上限 |

- 命令：`report`、`inject_guidance`、`retry_node`、`rerun_from_node`、`swap_agent`、`answer_wait`、`extend_loop`、`escalate`；超出权限的命令被拒绝并记录。
- Chief 只决定"怎么做"，不能改验收标准、verdict 或写入范围；它只读，不改文件。
- **和 Chief 对话**：run 进行中也可以发消息，它立刻回复；重试、重跑会等正在执行的步骤结束再执行。
- 详见 [chief.md](./chief.md)。

## 13. Run 的生命周期

| 状态 | 含义 |
|---|---|
| `RUNNING` | 执行中 |
| `WAITING` | 等人回答（Gate、agent 提问、Chief 提问） |
| `SUCCEEDED` / `FAILED` | 结束 |
| `CANCELLED` | 被停止 |

节点状态：`PENDING`、`READY`、`RUNNING`、`WAITING`、`SUCCEEDED`、`FAILED`、`SKIPPED`、`STALE`（上游重跑后需要重做）。

| 操作 | 网页 | CLI / HTTP | SDK |
|---|---|---|---|
| 启动 | Run | `run <id>` / `POST /api/runs` | `runtime.start()` + `runUntilSettled()` |
| 跟随 | Trace / 画布 | `logs <runId>` / `GET /api/runs/{id}/stream`（SSE） | `getRun`、`readLog` |
| 回答 | 弹出的问题 | `POST /api/runs/{id}/respond` | `runtime.respond({ runId, requestId, answer, responderId })` |
| 和 Chief 对话 | 底部对话框 | `POST /api/runs/{id}/chief/messages` | `postChiefMessage` + `answerChiefMessage` |
| 从某步重跑 | 节点上的重跑 | `POST /api/runs/{id}/rerun` | `runtime.rerunFromNode()` |
| 停止 | Stop | `cancel <runId>` / `POST /api/runs/{id}/cancel` | `runtime.cancelRun()`（host：`runs.cancel()`） |

- run 以**只增不改的事件日志**存储，可完整回放（`foldRunLog`）。
- 服务重启后，没跑完的 run 会被自动接手继续；多个进程靠租约（lease）避免同时驱动同一个 run。
- 停止是最终状态：正在执行的步骤被中止，迟到的结果不会被记录。

## 14. 三种用法

### 14.1 网页

`universal-agent-workflow`（或嵌入 `createDefaultWorkflowServer()`）提供：

- **设计视图**：拖出步骤、连线（顶部是流向线，参数线在选中步骤时显示）、Inspector 编辑字段和条件、画回退线、点进容器编辑内部流程、管理 workspace 槽位和 agent。
- **运行视图**：Trace（时间线、每步的执行过程、对话、数据、改动）和画布（运行中的节点有动效，循环线显示每一轮）。
- **Chief 对话框**、**Stop**、回答问题、从某步重跑。

### 14.2 命令行与 HTTP

见 [workflow-integration.md](./workflow-integration.md)：`run / status / logs / findings / cancel / openapi`，退出码适合 CI；HTTP API 有完整的 OpenAPI 文档和 `operationId`。JS 客户端：`import { WorkflowClient } from '@universal-agent/workflow-server/client'`。

### 14.3 嵌入 SDK

**完整 Node 宿主**（SQLite、agent 档案、Chief、git 隔离）：

```ts
import { createAgentWorkflowRuntime } from '@universal-agent/workflow-agents';

const { runtime } = createAgentWorkflowRuntime({
  workdir: '/path/to/repo',
  agents: [{ id: 'dev', version: '1', name: 'Developer', charter: 'Writes code.', runtime: { adapter: 'acp', agentType: 'claude' } }],
});
const { runId } = await runtime.start({ definition, inputs: { request: '…' }, workspaces: { main: '/path/to/repo' } });
const done = await runtime.runUntilSettled(runId);
console.log(done.status, await runtime.getOpenFindings(runId));
```

**带队列和租约的宿主**（服务端用的那一层，适合长期运行的进程）：`createWorkflowHost()` / `WorkflowHost`，提供 workflow 库、workspace 登记、`runs.start / respond / messageChief / cancel / rerunFromNode / resumeInterrupted`。

**只要调度器**（浏览器、测试、自定义存储和执行器）：

```ts
import { createWorkflowRuntime } from '@universal-agent/workflow-runtime';

const runtime = createWorkflowRuntime({
  executor: {
    async executeAgent(req) { return { status: 'COMPLETED', outputs: { draft: `about ${req.inputs.topic}` } }; },
    async executeScript() { throw new Error('no scripts here'); },
  },
  // store / artifacts / nodeData / workspaces / agentRegistry / chief 都可替换，默认内存实现
});
```

## 15. 存储位置

默认目录 `~/.universal-agent`（环境变量 `UNIVERSAL_AGENT_HOME` 或服务的 `--home` 可改）：

```
~/.universal-agent/workflow/
├── workflow.db          # SQLite：run 日志与快照、节点状态、产物、评审、manifest、node_data、对话、agent、workflow 库、workspace
├── blobs/               # 超过 1 MB 的产物内容（按 sha256）
└── worktrees/           # git-worktree 类型 workspace 的工作目录，以及并发写入的临时副本 forks/
```

workspace 里的真实文件（代码、图片、截图）不进数据库，数据库记录 diff 和路径。

## 16. 常见模式

| 场景 | 做法 |
|---|---|
| 写 → 评审 → 打回重做 | agent 写 + 评审步骤 + `loopBack(verdict_is NEEDS_FIX)`，`maxRounds` 2–3 |
| 人工审批 | Gate + `port_equals decision = approve` / `otherwise` |
| 任务列表并发实现 | 拆任务的步骤输出数组 → 设 `parallel` 的实现步骤或 Parallel 容器 |
| 并发改同一个仓库 | 不重叠的 `writeScopes` + 槽位 `mergeCheck` |
| 按分数分支 | 评审输出 `score` + `port_compare` |
| 需要判断"并且/或者" | `all` / `any` |
| 留问题给人 | 评审分级 + `pass_with_findings` + `ua-workflow issue` + 交接步骤读 `findings` |
| 失败兜底 | `setChief({})`，人随时在对话框里接管 |

可运行的完整例子：`packages/workflow-server/scripts/` 下的 `merge-demo-flow.mjs`（并发改代码 + 合并检查）、`d2c-demo-flow.mjs`（设计稿转代码，两个回退循环 + 截图对比 + 交接）、`d2c-pages-flow.mjs`（多页面并发 + 内联子流程）。
