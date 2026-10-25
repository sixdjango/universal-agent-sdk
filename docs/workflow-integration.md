# 接入工作流服务：CLI、HTTP API 与步骤约定

工作流服务负责编排（步骤、回退循环、并发、隔离与合并、Chief 监督），内容由各步骤的 agent 或脚本完成。别的 SDD 流程可以按需要接入下面任意一层。

## 1. 命令行

`universal-agent-workflow`（`@universal-agent/workflow-server`）既启动服务，也操作一个运行中的服务：

```bash
universal-agent-workflow                      # 启动服务（等同 serve），默认 http://127.0.0.1:4317
universal-agent-workflow workflows            # 已保存的 workflow
universal-agent-workflow run test-d2c-pages \
  --workspace main=./my-repo \                # 目录（首次自动登记）或 workspace id
  --input brief='"Lumen landing"' \           # 可重复；能解析成 JSON 的按 JSON
  --watch                                     # 跟到结束
universal-agent-workflow status <runId>       # 状态、每步结果（含循环轮次/并行项）、输出
universal-agent-workflow logs <runId>         # 事件流，运行中持续跟随；--no-follow 只看已有
universal-agent-workflow findings <runId>     # 还没解决的问题（评审留下的 + 步骤登记的）
universal-agent-workflow cancel <runId>       # 彻底停止
universal-agent-workflow runs --workflow <id>
universal-agent-workflow openapi > api.json   # 导出 OpenAPI 文档（不需要服务在跑）
```

- 服务地址：`--server <url>` 或环境变量 `UA_WORKFLOW_SERVER`。
- `--json`：机器可读输出；`logs --json` 每行一个事件（另有 `node.started`）。
- `run --watch` 的退出码适合 CI：`0` 成功、`1` 失败、`2` 已取消、`3` 等人回答（Gate 或 agent 提问）。用法错误 `64`，连不上服务 `69`。

## 2. HTTP API

- OpenAPI 3.1 文档：运行中的服务 `GET /api/openapi.json`，或仓库里的 [`workflow-api.openapi.json`](./workflow-api.openapi.json)（`universal-agent-workflow openapi` 生成）。请求体由服务端校验用的 zod schema 生成，测试保证每个路由都有文档。每个操作有 `operationId`，可直接生成各语言客户端。
- 典型流程：`PUT /api/workflows/{id}` 保存定义 → `POST /api/runs` 启动 → `GET /api/runs/{id}/stream`（SSE）跟随 → 需要时 `POST …/respond` 回答 Gate、`POST …/chief/messages` 和 Chief 对话、`POST …/cancel` 停止 → `GET /api/artifacts/{id}`、`GET /api/runs/{id}/data`、`GET /api/runs/{id}/conversations` 取产物与证据。
- 服务默认只监听本机，没有鉴权。

JS/TS 可直接用客户端：

```ts
import { WorkflowClient } from '@universal-agent/workflow-server/client';

const client = new WorkflowClient('http://127.0.0.1:4317');
const { id: workspace } = await client.workspaceFor('/path/to/repo');
const { runId } = await client.startRun({ workflowId: 'test-d2c-pages', workspaces: { main: workspace } });
for await (const item of client.followRun(runId)) {
  if (item.type === 'log' && item.entry.mutation.kind === 'event.emitted') console.log(item.entry.mutation.event);
}
```

## 3. 把 SDD 接成步骤

**角色 → agent。** 每个角色 `POST /api/agents` 注册一个档案（引擎 `runtime.agentType`、`charter`、`instructions`、`skills`），节点用 `agentRef` 引用。agent 在 workspace 目录里运行，仓库里已有的 SDD 配置（skills、命令、模板）由引擎自己读取；图片和文件也由 agent 自己打开。agent 在回复末尾给出结果块，prompt 会自动说明格式：

````text
```ua-workflow-result
{ "outputs": { … }, "artifacts": { "spec": { "content": "…", "mediaType": "text/markdown" } },
  "assessment": { "verdict": "NEEDS_FIX", "summary": "…", "findings": [ … ] } }
```
````

**工具链命令 → 脚本步骤。** `command` + `args` 调用现有 CLI。每个输入写成文件，路径在 `UA_INPUT_<端口名>`（全部输入在 `UA_INPUTS_FILE`）；结果写成同样结构的 JSON 到 `UA_OUTPUTS_FILE`。评审类步骤返回 `assessment.verdict`（`PASS`/`NEEDS_FIX`/`FAIL`/`BLOCKED`），回退线据此决定是否再来一轮。

**步骤内的中间数据。** agent 的 shell 和脚本都可以用 `ua-workflow`（agent 另有同名 MCP 工具）：`ua-workflow data put|append|get|list`（`--shared` 为整个 run 共享）、`ua-workflow inputs`、`ua-workflow artifact read <id>`。

**分支写在连线上。** 连线条件：`verdict_is` / `verdict_in`（评审结论）、`port_equals` / `port_truthy`（输出值）、`port_compare`（`>` `>=` `<` `<=` `==` `!=`，`measure: 'length'` 比较列表或文本长度）、`all` / `any`（组合，可嵌套，每个子条件可用 `sourceNodeId` 读别的步骤）、`otherwise`（其余分支都不成立时）。不带条件的连线在上一步成功后就走，不看 verdict。更复杂的判断交给一个脚本步骤算出结果，再用 `port_equals` 分流。

**阶段 → workflow 定义。** 用 `createWorkflowBuilder`（`@universal-agent/workflow-contract`）或直接生成 JSON：评审用回退线（`loopBack`，`maxRounds`、`onExhausted`）；任务列表用 `parallel`（`itemsPort` 内部即当前一项，见 [node-parallel.md](./node-parallel.md)）；并发写同一仓库会各自隔离、三方合并，可在 workspace 槽位配置 `mergeCheck`。

## 4. 允许留问题，最后交接给人

流程不必把每个小问题都修完：

1. **评审分级**：评审只对 critical/major 给 `NEEDS_FIX`；minor 给 `PASS`，并写进 findings（PASS 可以带问题清单）。
2. **修不完不卡住**：回退线 `onExhausted: 'pass_with_findings'`，轮次用完带着问题继续。
3. **主动登记妥协**：步骤里 `ua-workflow issue "<问题和改法>" --severity minor --file <path>`（agent 另有 `log_issue` 工具），记进 run 级的 `issues` 集合；同一步每轮重复登记只算一条。
4. **汇总**：`GET /api/runs/{id}/findings`、`universal-agent-workflow findings <runId>`，或步骤里的 `ua-workflow findings` / `list_findings`。每个评审步骤只取最新、未过期的结论（循环取最后一轮，并行各项分开），加上登记的 issues，按严重程度排序。
5. **交接步骤**：最后一步读取 findings 和证据，写 `HANDOFF.md`（问题、文件位置、证据、可直接粘贴的修改提示），人在 Claude Code / Cursor 里接着微调。`scripts/d2c-demo-flow.mjs` 和 `scripts/d2c-pages-flow.mjs` 的 `handoff` 步骤是现成的例子。

