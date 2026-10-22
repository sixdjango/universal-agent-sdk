import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  access,
  copyFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  LODY_EXTENSION_METHODS,
  isLodySubagentEvent,
} from "acp-extension-core";

// Real official CLI and packaged extensions, with a local deterministic model.
// The baseline phase uses no external provider plugin or alternate runtime.
const root = await mkdtemp(join(tmpdir(), "pi-v1-smoke-"));
if (process.platform === "win32") {
  // Cancellation must use the system executable, never a repository-local namesake.
  await copyFile(process.execPath, join(root, "taskkill.exe"));
}
const profile = join(root, "profile");
await mkdir(join(profile, "extensions"), { recursive: true });
await mkdir(join(root, ".pi", "extensions"), { recursive: true });
const marker = join(root, "external-loaded");
const external = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function() {}`;
await writeFile(join(profile, "extensions", "unwanted.ts"), external);
await writeFile(join(root, ".pi", "extensions", "unwanted.ts"), external);
const bodies = [];
const reasoningFixtures = {
  initialThinking: [
    { reasoning_content: "a" },
    { content: "这个" },
    { reasoning_content: "b" },
    { content: " alpine" },
  ],
  metadataThinking: [
    { reasoning_details: [{ type: "reasoning.text", text: "opaque" }] },
    { content: "这个" },
    { reasoning_content: "late" },
    { content: " alpine" },
  ],
  textFirst: [
    { content: "这个" },
    { reasoning_content: "late" },
    { content: " alpine" },
  ],
};
const reasoningSseInput = (deltas) => [
  ...deltas.map((delta) => ({
    id: "completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: null }],
  })),
  {
    id: "completion",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  "[DONE]",
];
const reasoningObservations = [];
let codemodeOnly = false;
let childRequest;
let releaseChild;
let heldChild;
let mainRequest;
let releaseMain;
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  bodies.push(body);
  const completionId = `completion_${bodies.length}`;
  const user = [...body.messages]
    .reverse()
    .find((message) => message.role === "user");
  const content =
    typeof user?.content === "string"
      ? user.content
      : (user?.content ?? []).map((block) => block.text ?? "").join("\n");
  const last = body.messages.at(-1);
  if (content === "STEER_HOLD") {
    await new Promise((resolve) => {
      releaseMain = resolve;
      mainRequest();
    });
  }
  if (content === "MODEL_ERROR") {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "synthetic provider failure",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }
  let tool;
  if (last?.role !== "tool" && body.tools?.length) {
    if (content.startsWith("WORKSPACE_TOOL:"))
      tool = JSON.parse(content.slice("WORKSPACE_TOOL:".length));
    if (content.startsWith("WORKSPACE_CHILD:"))
      tool = ["read", { path: content.slice("WORKSPACE_CHILD:".length) }];
    if (content === "WRITE_EFFECT")
      tool = ["write", { path: "effect.txt", content: "before\n" }];
    if (content === "READ_EFFECT") tool = ["read", { path: "effect.txt" }];
    if (content === "EDIT_EFFECT")
      tool = [
        "edit",
        { path: "effect.txt", oldText: "before", newText: "after" },
      ];
    if (content === "BASH_EFFECT")
      tool = [
        "bash",
        { command: "echo native-shell-effect > shell-effect.txt" },
      ];
    if (content === "READ_MISSING")
      tool = ["read", { path: "missing-effect.txt" }];
    if (content.includes("ASK_TEST"))
      tool = [
        "questionnaire",
        {
          questions: [
            {
              id: "scope",
              question: "Choose scope",
              options: [{ label: "Small" }, { label: "Large" }],
            },
            { id: "note", question: "Any note?" },
          ],
        },
      ];
    if (content.includes("TODO_TEST"))
      tool = ["todo", { action: "add", text: "Verify native adapter" }];
    if (content.includes("CLEAR_TODO")) tool = ["todo", { action: "clear" }];
    if (content.includes("MCP_TEST"))
      tool = ["mcp_fixture_echo", { value: "native-mcp" }];
    if (content.includes("MCP_ERROR")) tool = ["mcp_fixture_error", {}];
    if (content.includes("MCP_IMAGE")) tool = ["mcp_fixture_image", {}];
    if (content.includes("MCP_RESOURCE"))
      tool = ["mcp_fixture_echo", { value: "unsupported-resource" }];
    if (content.includes("SUB_TEST"))
      tool = [
        "subagent",
        { task: "CHILD_TEST", description: "Inspect child task" },
      ];
    if (content === "SUBAGENT_REASONING_FIXTURE")
      tool = [
        "subagent",
        {
          task: "CHILD_REASONING_INITIAL",
          description: "Late reasoning fixture",
        },
      ];
    if (content === "SUB_MODEL")
      tool = [
        "subagent",
        {
          task: "CHILD_TEST",
          description: "Use the selected child model",
          model: "localtest/fixture",
        },
      ];
    if (codemodeOnly && content === "CHILD_TEST")
      tool = [
        "codemode",
        {
          code: "text(ALL_TOOLS.some(tool => tool.name === 'subagent' || tool.name === 'questionnaire' || tool.name.startsWith('mcp_')) ? 'CHILD_NOT_ISOLATED' : 'CHILD_ISOLATED');",
        },
      ];
    if (content.includes("CANCEL_SUB"))
      tool = [
        "subagent",
        { task: "CHILD_HOLD", description: "Cancelled child" },
      ];
    if (content.includes("SUB_LENGTH"))
      tool = [
        "subagent",
        { task: "CHILD_LENGTH", description: "Truncated child" },
      ];
  }
  if (content === "CHILD_HOLD") {
    releaseChild = response;
    childRequest();
    return;
  }
  if (codemodeOnly && body.tools?.length) {
    assert.deepEqual(
      body.tools.map((entry) => entry.function.name),
      ["codemode"],
      "only mode must expose codemode while retaining callable nested tools",
    );
    if (tool && tool[0] !== "codemode")
      tool = [
        "codemode",
        {
          code:
            tool[0] === "mcp_fixture_image"
              ? "const result = await tools.mcp_fixture_image({}); image(result.content.find(block => block.type === 'image'));"
              : `text(await tools.${tool[0]}(${JSON.stringify(tool[1])}));`,
        },
      ];
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (tool) {
    chunk({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `call_${bodies.length}`,
          type: "function",
          function: { name: tool[0], arguments: JSON.stringify(tool[1]) },
        },
      ],
    });
    chunk({}, "tool_calls");
  } else {
    const reasoningFixture =
      content === "REASONING_INITIAL_THINKING" ||
      content === "CHILD_REASONING_INITIAL"
        ? reasoningFixtures.initialThinking
        : content === "REASONING_METADATA_THINKING"
          ? reasoningFixtures.metadataThinking
          : content === "REASONING_TEXT_FIRST"
            ? reasoningFixtures.textFirst
            : undefined;
    if (reasoningFixture) {
      for (const delta of reasoningFixture) chunk(delta);
      chunk({}, "stop");
    } else {
      chunk({
        role: "assistant",
        content: content === "CHILD_TEST" ? "CHILD_RESULT" : "DONE",
      });
      chunk({}, content === "CHILD_LENGTH" ? "length" : "stop");
    }
  }
  response.write(
    `data: ${JSON.stringify({ id: completionId, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
await writeFile(
  join(profile, "models.json"),
  JSON.stringify({
    providers: {
      localtest: {
        api: "openai-completions",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        models: [
          {
            id: "fixture",
            input: ["text", "image"],
            contextWindow: 32000,
            maxTokens: 4096,
          },
          {
            id: "fixture-alt",
            input: ["text", "image"],
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    },
  }),
);
const children = new Set();
const updates = [];
const acpReasoningChunks = (events) =>
  events
    .filter(
      (update) =>
        (update.sessionUpdate === "agent_message_chunk" ||
          update.sessionUpdate === "agent_thought_chunk") &&
        update.content?.type === "text",
    )
    .map(({ sessionUpdate, content }) => ({ sessionUpdate, content }));
const assertReasoningOutput = (events, expected) => {
  const observed = acpReasoningChunks(events);
  assert.deepEqual(observed, expected);
  assert.equal(
    observed
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => update.content.text)
      .join(""),
    "这个 alpine",
  );
  return observed;
};
const expectedReasoningOutput = {
  initialThinking: [
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "a" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "这个" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " alpine" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "b" },
    },
  ],
  metadataThinking: [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "这个" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " alpine" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "late" },
    },
  ],
  textFirst: [
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "这个" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " alpine" },
    },
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "late" },
    },
  ],
};
const observeMainReasoning = async (session, prompt, fixture, expected) => {
  const offset = updates.length;
  await session.prompt(prompt);
  const observed = assertReasoningOutput(updates.slice(offset), expected);
  reasoningObservations.push({
    prompt,
    sseEvents: reasoningSseInput(fixture),
    observedAcp: observed,
  });
};
const answerQuestions = async (request) => {
  assert.equal(Object.keys(request.requestedSchema.properties).length, 3);
  assert.ok(request.toolCallId);
  return { action: "accept", content: { q0: "Small", q1: "No extra scope" } };
};
let answer = answerQuestions;
const execFileAsync = promisify(execFile);
const entry =
  process.argv[2] ??
  fileURLToPath(new URL("../dist/index.js", import.meta.url));
async function start(
  sessionId,
  extensionPaths = [],
  provider = "localtest",
  open = "resumeSession",
  subagentEvents = false,
  activation = {},
) {
  const runEvents = [];
  const usages = [];
  const usageEvents = new EventEmitter();
  const appliedSteers = [];
  const child = spawn(
    process.execPath,
    [
      entry,
      "--provider",
      provider,
      "--model",
      "fixture",
      ...extensionPaths.flatMap((path) => ["-e", path]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: profile,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(child);
  child.stderr.pipe(process.stderr);
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async ({ update }) => {
        updates.push(update);
      },
      unstable_createElicitation: (request) => answer(request),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      extNotification: async (method, params) => {
        if (isLodySubagentEvent(params)) runEvents.push(params);
        if (method === LODY_EXTENSION_METHODS.sessionUsageUpdate) {
          usages.push(params);
          usageEvents.emit("usage");
        }
        if (method === LODY_EXTENSION_METHODS.sessionSteerApplied)
          appliedSteers.push(params);
      },
    }),
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );
  const init = await client.initialize({
    protocolVersion: 1,
    clientCapabilities: subagentEvents
      ? { _meta: { lody: { subagentEvents: { version: 1 } } } }
      : {},
  });
  assert.equal(init.agentCapabilities._meta.lody.subagents.cancel, true);
  const mcpServers = [
    {
      name: "fixture",
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../test/fixtures/mcp.mjs", import.meta.url)),
      ],
      env: [{ name: "MCP_FIXTURE_TAG", value: "v1" }],
    },
  ];
  const result = sessionId
    ? await client[open]({ sessionId, cwd: root, mcpServers, ...activation })
    : await client.newSession({ cwd: root, mcpServers, ...activation });
  const id = result.sessionId ?? sessionId;
  return {
    process: child,
    client,
    id,
    configOptions: result.configOptions,
    capabilities: init.agentCapabilities,
    runEvents,
    usages,
    usageEvents,
    appliedSteers,
    prompt: (text) =>
      client.prompt({ sessionId: id, prompt: [{ type: "text", text }] }),
    close: async () => {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
      children.delete(child);
    },
  };
}
const deadline = setTimeout(
  () => {
    for (const child of children) child.kill("SIGTERM");
    server.closeAllConnections();
    throw new Error("Native smoke did not converge");
  },
  // windows-11-arm runners take roughly triple the x64 wall time.
  180_000,
);
async function exerciseWorkspace() {
  await writeFile(
    join(profile, "APPEND_SYSTEM.md"),
    "WORKSPACE_USER_SYSTEM_PRESERVED",
  );
  const models = new Map();
  const base = await realpath(root);
  const cwd = join(base, `workspace-main-${codemodeOnly}`);
  const targetCwd = join(base, `workspace-fork-${codemodeOnly}`);
  const a = join(base, `extra-a-${codemodeOnly}`);
  const b = join(base, `extra-b-${codemodeOnly}`);
  await Promise.all([cwd, targetCwd, a, b].map((path) => mkdir(path)));
  await writeFile(join(a, "input.txt"), "EXTRA_A_CONTENT");
  await writeFile(join(b, "input.txt"), "EXTRA_B_CONTENT");
  await writeFile(join(cwd, "relative.txt"), "MAIN_RELATIVE_CONTENT");
  await writeFile(join(targetCwd, "relative.txt"), "FORK_RELATIVE_CONTENT");
  let session = await start(
    undefined,
    [],
    "localtest",
    "resumeSession",
    false,
    { cwd, additionalDirectories: [a] },
  );
  assert.ok(session.capabilities.sessionCapabilities.fork);
  const sourceId = session.id;
  const prompt = async (id, text, expectedCwd, directories) => {
    const offset = bodies.length;
    const result = await session.client.prompt({
      sessionId: id,
      prompt: [{ type: "text", text }],
    });
    assert.equal(result.stopReason, "end_turn");
    const requests = bodies.slice(offset);
    assert.ok(requests.length);
    for (const body of requests) {
      const system = body.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      assert.ok(
        system.includes("WORKSPACE_USER_SYSTEM_PRESERVED"),
        "native user system configuration survives workspace context",
      );
      assert.equal(body.model, models.get(id) ?? "fixture");
      const marker = system.lastIndexOf("ACP workspace directories");
      assert.ok(
        marker >= 0,
        "native model receives explicit activation workspace context",
      );
      const context = system.slice(marker);
      // JSON escaping matters for Windows paths; inspect the structured context.
      const jsonStart = context.indexOf("{");
      const jsonEnd = context.indexOf("}", jsonStart);
      const actual = JSON.parse(context.slice(jsonStart, jsonEnd + 1));
      assert.equal(actual.cwd, expectedCwd);
      assert.deepEqual(actual.additionalDirectories, directories);
    }
    return requests;
  };
  const tool = (id, name, args, dir, roots) =>
    prompt(id, `WORKSPACE_TOOL:${JSON.stringify([name, args])}`, dir, roots);
  const assertToolText = (requests, expected) =>
    assert.ok(
      requests.some((body) =>
        body.messages.some(
          (message) =>
            message.role === "tool" &&
            JSON.stringify(message.content).includes(expected),
        ),
      ),
      `${expected}: ${JSON.stringify(requests.at(-1)?.messages.slice(-2))}`,
    );
  assertToolText(
    await tool(sourceId, "read", { path: join(a, "input.txt") }, cwd, [a]),
    "EXTRA_A_CONTENT",
  );
  assertToolText(
    await tool(sourceId, "read", { path: "relative.txt" }, cwd, [a]),
    "MAIN_RELATIVE_CONTENT",
  );
  await tool(
    sourceId,
    "write",
    { path: join(a, "written.txt"), content: "EXTRA_NATIVE_WRITE" },
    cwd,
    [a],
  );
  assert.equal(
    await readFile(join(a, "written.txt"), "utf8"),
    "EXTRA_NATIVE_WRITE",
  );
  await tool(
    sourceId,
    "bash",
    { command: "echo PRIMARY_NATIVE_BASH > bash-relative.txt" },
    cwd,
    [a],
  );
  assert.equal(
    (await readFile(join(cwd, "bash-relative.txt"), "utf8")).trim(),
    "PRIMARY_NATIVE_BASH",
  );
  assertToolText(
    await tool(
      sourceId,
      "subagent",
      {
        task: `WORKSPACE_CHILD:${join(a, "input.txt")}`,
        description: "Workspace inheritance",
      },
      cwd,
      [a],
    ),
    "EXTRA_A_CONTENT",
  );
  const bashExtra = join(a, "bash-extra.txt");
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await tool(
    sourceId,
    "bash",
    {
      command: `printf '%s' EXTRA_NATIVE_BASH > ${quote(bashExtra.replaceAll("\\", "/"))}`,
    },
    cwd,
    [a],
  );
  assert.equal(await readFile(bashExtra, "utf8"), "EXTRA_NATIVE_BASH");
  const attachment = (id, roots) => ({
    sessionId: id,
    cwd,
    mcpServers: [],
    ...(roots === undefined ? {} : { additionalDirectories: roots }),
  });
  // Hot reattach must replace, clear, and default the complete roots list.
  for (const method of ["resumeSession", "loadSession"]) {
    for (const roots of [[a], [b], [], undefined]) {
      const before = bodies.length;
      await session.client[method](attachment(sourceId, roots));
      assert.equal(
        bodies.length,
        before,
        `${method} must not send historical prompts`,
      );
      await prompt(
        sourceId,
        `WORKSPACE_${method}_${JSON.stringify(roots)}`,
        cwd,
        roots ?? [],
      );
    }
  }
  await session.client.resumeSession(attachment(sourceId, [a]));
  const sourceFile = await readFile(sourceId, "utf8");
  assert.ok(
    !sourceFile.includes("ACP workspace directories"),
    "activation context stays outside native history",
  );
  const sourceHeader = JSON.parse(sourceFile.split("\n")[0]);
  const forkIds = [];
  for (const roots of [[b], [], undefined]) {
    const before = bodies.length;
    const child = await session.client.unstable_forkSession({
      ...attachment(sourceId, roots),
      cwd: targetCwd,
      ...(roots?.length
        ? {
            mcpServers: [
              {
                name: "forkfixture",
                command: process.execPath,
                args: [
                  fileURLToPath(
                    new URL("../test/fixtures/mcp.mjs", import.meta.url),
                  ),
                ],
                env: [{ name: "MCP_FIXTURE_TAG", value: "fork" }],
              },
            ],
            _meta: {
              lody: {
                sessionConfig: {
                  configOptionValues: { model: "localtest/fixture-alt" },
                },
              },
            },
          }
        : {}),
    });
    if (roots?.length) models.set(child.sessionId, "fixture-alt");
    assert.equal(
      bodies.length,
      before,
      "fork cannot replay history as model prompts",
    );
    assert.notEqual(child.sessionId, sourceId);
    assert.ok(!forkIds.includes(child.sessionId));
    forkIds.push(child.sessionId);
    const childFile = await readFile(child.sessionId, "utf8");
    const childHeader = JSON.parse(childFile.split("\n")[0]);
    assert.notEqual(childHeader.id, sourceHeader.id);
    assert.equal(childHeader.parentSession, sourceId);
    assert.equal(childHeader.cwd, targetCwd);
    assert.deepEqual(
      childFile
        .trim()
        .split("\n")
        .slice(1, sourceFile.trim().split("\n").length),
      sourceFile.trim().split("\n").slice(1),
      "native fork copies history without rewriting entries",
    );
    assertToolText(
      await tool(
        child.sessionId,
        "read",
        { path: "relative.txt" },
        targetCwd,
        roots ?? [],
      ),
      "FORK_RELATIVE_CONTENT",
    );
    if (roots?.length)
      assertToolText(
        await tool(
          child.sessionId,
          "read",
          { path: join(b, "input.txt") },
          targetCwd,
          roots,
        ),
        "EXTRA_B_CONTENT",
      );
    if (roots?.length)
      assertToolText(
        await tool(
          child.sessionId,
          "mcp_forkfixture_echo",
          { value: "fork-isolated" },
          targetCwd,
          roots,
        ),
        "MCP:fork:fork-isolated",
      );
    assert.equal(
      await readFile(sourceId, "utf8"),
      sourceFile,
      "fork cannot mutate source native history",
    );
  }
  // Prompt all retained activations without resume: source and siblings stay independent.
  const sourceRequests = await prompt(
    sourceId,
    "WORKSPACE_SOURCE_UNCHANGED",
    cwd,
    [a],
  );
  if (codemodeOnly) {
    assertToolText(
      await tool(
        sourceId,
        "codemode",
        {
          code: "text(ALL_TOOLS.some(tool => tool.name === 'mcp_forkfixture_echo') ? 'MCP_LEAK' : 'MCP_ISOLATED');",
        },
        cwd,
        [a],
      ),
      "MCP_ISOLATED",
    );
  } else {
    assert.ok(
      sourceRequests.every(
        (body) =>
          !body.tools.some(
            (tool) => tool.function.name === "mcp_forkfixture_echo",
          ),
      ),
      "fork MCP tools do not enter source activation",
    );
  }
  await prompt(forkIds[0], "WORKSPACE_FIRST_SIBLING", targetCwd, [b]);
  await prompt(forkIds[1], "WORKSPACE_SECOND_SIBLING", targetCwd, []);
  const other = await session.client.newSession({ cwd, mcpServers: [] });
  await prompt(other.sessionId, "WORKSPACE_OTHER_DEFAULT", cwd, []);
  await prompt(sourceId, "WORKSPACE_SOURCE_AFTER_NEW", cwd, [a]);
  await session.close();
  // Cold load/resume use only requested roots, never roots from native history.
  for (const method of ["loadSession", "resumeSession"]) {
    for (const roots of [[b], [], undefined]) {
      const before = bodies.length;
      session = await start(sourceId, [], "localtest", method, false, {
        cwd,
        mcpServers: [],
        ...(roots === undefined ? {} : { additionalDirectories: roots }),
      });
      assert.equal(bodies.length, before);
      await prompt(sourceId, "WORKSPACE_COLD_ATTACH", cwd, roots ?? []);
      await session.close();
    }
  }
  // A cold source can also be forked with an independent cwd and root set.
  session = await start(undefined, [], "localtest", "resumeSession", false, {
    cwd,
    mcpServers: [],
  });
  const coldFork = await session.client.unstable_forkSession({
    ...attachment(sourceId, [b]),
    cwd: targetCwd,
  });
  await prompt(coldFork.sessionId, "WORKSPACE_COLD_FORK", targetCwd, [b]);
  await session.close();
  await unlink(join(profile, "APPEND_SYSTEM.md"));
  console.log(
    `Workspace lifecycle smoke passed (${codemodeOnly ? "codemode only" : "ordinary tools"}): native roots, file tools, hot/cold attach, fork identity/history/cwd/MCP/model isolation and user system context`,
  );
}

async function exercise(mode) {
  codemodeOnly = mode;
  deadline.refresh();
  updates.length = 0;
  bodies.length = 0;
  answer = answerQuestions;
  heldChild = new Promise((resolve) => {
    childRequest = resolve;
  });
  const settings = codemodeOnly
    ? { defaultTools: ["+codemode"], codemode: { mode: "only" } }
    : {};
  await writeFile(join(profile, "settings.json"), JSON.stringify(settings));
  await exerciseWorkspace();
  bodies.length = 0;
  updates.length = 0;
  const a = await start();
  await a.prompt("WRITE_EFFECT");
  assert.equal(await readFile(join(root, "effect.txt"), "utf8"), "before\n");
  const beforeRead = updates.length;
  await a.prompt("READ_EFFECT");
  assert.ok(
    updates
      .slice(beforeRead)
      .some(
        (update) =>
          update.title === "read" &&
          update.status === "completed" &&
          JSON.stringify(update.rawOutput).includes("before"),
      ),
  );
  await a.prompt("EDIT_EFFECT");
  assert.equal(await readFile(join(root, "effect.txt"), "utf8"), "after\n");
  await a.prompt("BASH_EFFECT");
  assert.equal(
    (await readFile(join(root, "shell-effect.txt"), "utf8")).trim(),
    "native-shell-effect",
  );
  const beforeMissing = updates.length;
  await a.prompt("READ_MISSING");
  assert.ok(
    updates
      .slice(beforeMissing)
      .some((update) => update.title === "read" && update.status === "failed"),
  );
  await a.prompt("RECOVER_TEST");
  // Extension notifications are dispatched independently of the prompt response.
  while (
    (a.usages.at(-1)?.modelUsage["localtest/fixture"]?.inputTokens ?? 0) <
    bodies.length * 10
  )
    await once(a.usageEvents, "usage");
  const nativeUsage = a.usages.at(-1).modelUsage["localtest/fixture"];
  assert.equal(nativeUsage.inputTokens, bodies.length * 10);
  assert.equal(nativeUsage.outputTokens, bodies.length * 5);
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR4nGP4z8DwHwohFABFzAf5Zsv/OQAAAABJRU5ErkJggg==";
  const beforeImage = bodies.length;
  assert.equal(
    (
      await a.client.prompt({
        sessionId: a.id,
        prompt: [
          { type: "text", text: "IMAGE_TEST" },
          { type: "image", mimeType: "image/png", data: image },
        ],
      })
    ).stopReason,
    "end_turn",
  );
  assert.ok(
    bodies
      .slice(beforeImage)
      .some((body) =>
        body.messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === "image_url"),
        ),
      ),
    JSON.stringify(
      bodies.slice(beforeImage).map((body) => body.messages.slice(-2)),
    ),
  );
  await assert.rejects(a.prompt("MODEL_ERROR"), (error) => {
    assert.match(
      error.data?.details ?? error.message,
      /synthetic provider failure/,
    );
    return true;
  });
  await a.prompt("RECOVER_TEST");
  const heldMain = new Promise((resolve) => {
    mainRequest = resolve;
  });
  const steeringRun = a.prompt("STEER_HOLD");
  await heldMain;
  const steering = a.client.extMethod(LODY_EXTENSION_METHODS.sessionSteer, {
    sessionId: a.id,
    steerId: "smoke-steer",
    prompt: [{ type: "text", text: "STEER_APPLIED" }],
  });
  // A following native control ACK is an explicit barrier after steer enqueue.
  await a.client.extMethod(LODY_EXTENSION_METHODS.subagentsList, {
    sessionId: a.id,
  });
  releaseMain();
  assert.deepEqual(await steering, { outcome: "injected" });
  assert.equal((await steeringRun).stopReason, "end_turn");
  assert.ok(
    a.appliedSteers.some(
      (event) => event.steerId === "smoke-steer" && event.sessionId === a.id,
    ),
  );
  await a.prompt("MCP_TEST");
  assert.ok(
    updates.some((update) =>
      (JSON.stringify(update.rawOutput) ?? "").includes("MCP:v1:native-mcp"),
    ),
  );
  await a.prompt("MCP_ERROR");
  assert.ok(
    updates.some(
      (update) =>
        update.title === "mcp_fixture_error" && update.status === "failed",
    ),
  );
  const beforeMcpImage = bodies.length;
  await a.prompt("MCP_IMAGE");
  assert.ok(
    updates.some(
      (update) =>
        update.title === "mcp_fixture_image" &&
        update.status === "completed" &&
        update.content?.some(
          (block) => block.type === "content" && block.content.type === "image",
        ),
    ),
  );
  assert.ok(
    bodies
      .slice(beforeMcpImage)
      .some((body) =>
        body.messages
          .slice(-2)
          .some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((block) => block.type === "image_url"),
          ),
      ),
    "MCP image must reach the model, including through codemode image()",
  );
  const beforeUnsupported = updates.length;
  await a.prompt("MCP_RESOURCE");
  assert.ok(
    updates
      .slice(beforeUnsupported)
      .some(
        (update) =>
          update.title === "mcp_fixture_echo" &&
          update.status === "failed" &&
          JSON.stringify(update.content).includes(
            "Unsupported MCP content type: resource_link",
          ),
      ),
  );
  assert.equal((await a.prompt("ASK_TEST")).stopReason, "end_turn");
  assert.ok(
    bodies.some((body) =>
      body.messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("No extra scope"),
      ),
    ),
  );
  await a.prompt("TODO_TEST");
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "plan" &&
        update.entries.some((item) => item.content === "Verify native adapter"),
    ),
  );
  await a.prompt("SUB_TEST");
  const listed = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: a.id },
  );
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].status, "completed");
  const output = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsOutput,
    { sessionId: a.id, taskId: listed.tasks[0].taskId },
  );
  assert.match(output.output, /CHILD_RESULT/);
  assert.ok(
    updates.some(
      (update) =>
        update._meta?.lody?.task?.taskId === listed.tasks[0].taskId &&
        update._meta.lody.task.status === "completed",
    ),
  );
  const beforeLength = updates.length;
  await a.prompt("SUB_LENGTH");
  const lengthUpdates = updates.slice(beforeLength);
  const truncated = lengthUpdates
    .filter(
      (update) => update._meta?.lody?.task?.description === "Truncated child",
    )
    .at(-1)._meta.lody.task;
  assert.equal(truncated.status, "failed");
  assert.equal(truncated.error, "length");
  const lengthTool = lengthUpdates.find(
    (update) => update.title === "subagent" && update.status === "failed",
  );
  assert.equal(lengthTool.rawOutput.details.isError, true);
  assert.match(lengthTool.rawOutput.content[0].text, /^length\n/);
  const running = a.prompt("CANCEL_SUB");
  await heldChild;
  assert.ok(
    updates.some(
      (update) =>
        update.sessionUpdate === "tool_call" &&
        update._meta?.lody?.task?.description === "Cancelled child" &&
        update._meta.lody.task.status === "in_progress",
    ),
  );
  const active = await a.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: a.id, activeOnly: true },
  );
  assert.equal(active.tasks.length, 1);
  await a.client.extMethod(LODY_EXTENSION_METHODS.subagentsCancel, {
    sessionId: a.id,
    taskId: active.tasks[0].taskId,
  });
  releaseChild.destroy();
  await running;
  assert.equal(
    (
      await a.client.extMethod(LODY_EXTENSION_METHODS.subagentsList, {
        sessionId: a.id,
      })
    ).tasks.at(-1).status,
    "killed",
  );
  let asked;
  const questionSeen = new Promise((resolve) => {
    asked = resolve;
  });
  answer = async () => {
    asked();
    return new Promise(() => {});
  };
  const waiting = a.prompt("ASK_TEST");
  await questionSeen;
  await a.client.cancel({ sessionId: a.id });
  assert.equal((await waiting).stopReason, "cancelled");
  await a.prompt("RECOVER_TEST");
  await observeMainReasoning(
    a,
    "REASONING_INITIAL_THINKING",
    reasoningFixtures.initialThinking,
    expectedReasoningOutput.initialThinking,
  );
  await observeMainReasoning(
    a,
    "REASONING_METADATA_THINKING",
    reasoningFixtures.metadataThinking,
    expectedReasoningOutput.metadataThinking,
  );
  await observeMainReasoning(
    a,
    "REASONING_TEXT_FIRST",
    reasoningFixtures.textFirst,
    expectedReasoningOutput.textFirst,
  );
  const id = a.id;
  await a.close();
  const beforeLoad = updates.length;
  const loaded = await start(id, [], "localtest", "loadSession");
  const { sessions } = await loaded.client.listSessions({ cwd: root });
  assert.ok(sessions.some((session) => session.sessionId === id));
  const replay = updates.slice(beforeLoad);
  assert.ok(
    !replay.some(
      (update) =>
        update.sessionUpdate === "user_message_chunk" &&
        update.content.type === "text" &&
        update.content.text.startsWith("/lody-steer-"),
    ),
  );
  assert.ok(
    replay.some(
      (update) =>
        update.sessionUpdate === "user_message_chunk" &&
        update.content.text === "MCP_TEST",
    ),
  );
  assert.ok(
    replay.some(
      (update) =>
        update.title === "mcp_fixture_error" && update.status === "failed",
    ),
  );
  assert.ok(
    replay.some(
      (update) =>
        update.sessionUpdate === "plan" &&
        update.entries.some((item) => item.content === "Verify native adapter"),
    ),
  );
  await loaded.close();
  const before = updates.length;
  // Make manual compaction deterministic without changing the earlier length test.
  await writeFile(
    join(profile, "settings.json"),
    JSON.stringify({
      ...settings,
      compaction: { enabled: false, keepRecentTokens: 256 },
    }),
  );
  const b = await start(id);
  assert.ok(
    updates
      .slice(before)
      .some(
        (update) =>
          update.sessionUpdate === "plan" &&
          update.entries.some(
            (item) => item.content === "Verify native adapter",
          ),
      ),
  );
  await b.prompt("CLEAR_TODO");
  assert.equal(
    updates.filter((update) => update.sessionUpdate === "plan").at(-1).entries
      .length,
    0,
  );
  const beforeStats = updates.length;
  assert.equal((await b.prompt("/stats")).stopReason, "end_turn");
  assert.ok(
    updates
      .slice(beforeStats)
      .some(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.text.includes("Pi session usage:"),
      ),
  );
  const beforeCompact = updates.length;
  assert.equal(
    (await b.prompt("/compact Keep the task checklist.")).stopReason,
    "end_turn",
  );
  assert.ok(
    updates
      .slice(beforeCompact)
      .some(
        (update) =>
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.text === "Context compacted.",
      ),
  );
  const closingChild = new Promise((resolve) => {
    childRequest = resolve;
  });
  const interrupted = assert.rejects(b.prompt("CANCEL_SUB"));
  await closingChild;
  const childDisconnected = once(releaseChild, "close");
  await b.close();
  await Promise.all([interrupted, childDisconnected]);
  await writeFile(join(profile, "settings.json"), JSON.stringify(settings));
  if (process.platform === "win32") {
    for (const crash of ["pi", "adapter"]) {
      const c = await start();
      const held = new Promise((resolve) => {
        childRequest = resolve;
      });
      const rejectedPrompt = assert.rejects(c.prompt("CANCEL_SUB"));
      await held;
      // Real Pi, MCP and subagent processes; the model request is held open.
      const rows = JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name='CreatedAt';Expression={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}},CommandLine | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8" },
        ),
      );
      const adapter = rows.find((row) => row.ProcessId === c.process.pid);
      assert.ok(adapter, "adapter process found");
      // Windows retains the original parent PID after that parent exits. A
      // reused PID does not make an older process this adapter's child.
      const childrenOf = (processes, parent) =>
        processes.filter(
          (row) =>
            row.ParentProcessId === parent.ProcessId &&
            row.CreatedAt >= parent.CreatedAt,
        );
      const candidates = childrenOf(rows, adapter).filter(
        (row) =>
          /[\\/]pi-coding-agent[\\/]dist[\\/]bundle[\\/]cli\.js/.test(
            row.CommandLine ?? "",
          ) && /\s--mode rpc(?:\s|$)/.test(row.CommandLine),
      );
      assert.equal(
        candidates.length,
        1,
        `Expected one native RPC Pi: ${JSON.stringify({ crash, adapter, candidates, children: childrenOf(rows, adapter) })}`,
      );
      const [pi] = candidates;
      // Exercise PID reuse and enumeration order using this real snapshot.
      const older = { ...pi, CreatedAt: adapter.CreatedAt - 1 };
      assert.deepEqual(childrenOf([older, pi], adapter), [pi]);
      const descendants = childrenOf(rows, pi);
      assert.ok(
        descendants.length >= 2,
        `MCP and native subagent are running: ${JSON.stringify({ crash, adapter, pi, descendants })}`,
      );
      const exited = once(c.process, "exit");
      process.kill(crash === "pi" ? pi.ProcessId : c.process.pid, "SIGKILL");
      const [[code]] = await Promise.all([exited, rejectedPrompt]);
      if (crash === "pi")
        assert.equal(code, 1, "runtime crash fails the connection");
      children.delete(c.process);
      // Kernel process waits, not polling/sleep-based assertions.
      const pids = [pi.ProcessId, ...descendants.map((row) => row.ProcessId)];
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `
        $ErrorActionPreference = 'Stop'
        foreach ($processId in @(${pids.join(",")})) {
          $owned = Get-Process -Id $processId -ErrorAction SilentlyContinue
          if ($owned -and !$owned.WaitForExit(5000)) {
            $owned.Kill()
            throw "Descendant survived adapter exit: $processId"
          }
        }
        exit 0
      `,
        ],
        { stdio: "pipe" },
      );
      releaseChild.destroy();
      console.log(`PASS ${crash} crash cleans native descendants`);
    }
  }
  const discovered = JSON.parse(
    (
      await execFileAsync(process.execPath, [entry, "--list-extensions"], {
        env: {
          ...process.env,
          HOME: root,
          PI_CODING_AGENT_DIR: profile,
          PI_SKIP_VERSION_CHECK: "1",
        },
      })
    ).stdout,
  );
  assert.equal(discovered.version, 1);
  assert.equal(discovered.agentDir, profile);
  assert.ok(
    discovered.extensions.some(
      (item) => item.name === "unwanted.ts" && item.source === "directory",
    ),
    "ambient extension listed as a selectable candidate",
  );
  await assert.rejects(access(marker));
  const plugin = join(root, "opted-in.ts");
  await writeFile(
    plugin,
    `export default (pi) => { pi.registerProvider("extensiontest", ${JSON.stringify(
      {
        api: "openai-completions",
        apiKey: "synthetic",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        models: [
          {
            id: "fixture",
            name: "Extension fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      },
    )}); pi.registerCommand("lody-smoke-handled", {
      description: "Synthetic command without a model turn",
      handler: async (_args, ctx) => ctx.ui.notify("HANDLED_COMMAND", "info"),
    }); };`,
  );
  const c = await start(
    undefined,
    [plugin],
    "extensiontest",
    "resumeSession",
    true,
  );
  assert.ok(
    c.configOptions
      ?.find((option) => option.id === "model" || option.category === "model")
      ?.options.some((option) => option.value === "extensiontest/fixture"),
    "extension provider model is advertised",
  );
  const beforeHandled = bodies.length;
  assert.equal((await c.prompt("/lody-smoke-handled")).stopReason, "end_turn");
  assert.equal(
    bodies.length,
    beforeHandled,
    "handled command must not start a model request",
  );
  await c.prompt("SUB_TEST");
  const extensionTasks = await c.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: c.id },
  );
  assert.equal(extensionTasks.tasks.at(-1).status, "completed");
  const extensionOutput = await c.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsOutput,
    { sessionId: c.id, taskId: extensionTasks.tasks.at(-1).taskId },
  );
  assert.match(extensionOutput.output, /CHILD_RESULT/);
  assert.equal(c.runEvents[0].type, "snapshot");
  assert.equal(c.runEvents[0].snapshot.state, "running");
  assert.ok(
    c.runEvents.some(
      (event) =>
        event.type === "output" &&
        event.update.sessionUpdate === "agent_message_chunk" &&
        event.update.content.text.includes("CHILD_RESULT"),
    ),
  );
  assert.equal(c.runEvents.at(-1).snapshot.state, "completed");
  assert.ok(
    c.runEvents.every(
      (event) =>
        event.sessionId === c.id && event.runId === c.runEvents[0].runId,
    ),
  );
  const childReasoningOffset = c.runEvents.length;
  await c.prompt("SUBAGENT_REASONING_FIXTURE");
  const childReasoningEvents = c.runEvents.slice(childReasoningOffset);
  const childReasoningRun = childReasoningEvents.find(
    (event) =>
      event.type === "snapshot" &&
      event.snapshot.state === "running" &&
      event.snapshot.description === "Late reasoning fixture",
  );
  assert.ok(childReasoningRun, "negotiated child run started");
  const childReasoningOutput = childReasoningEvents.filter(
    (event) =>
      event.type === "output" &&
      event.sessionId === c.id &&
      event.runId === childReasoningRun.runId &&
      (event.update.sessionUpdate === "agent_message_chunk" ||
        event.update.sessionUpdate === "agent_thought_chunk"),
  );
  const childMessageIds = new Set(
    childReasoningOutput.map((event) => event.messageId),
  );
  assert.equal(childMessageIds.size, 1);
  const [childMessageId] = childMessageIds;
  assert.ok(childMessageId, "child output carries its message ID");
  const observedChildReasoning = assertReasoningOutput(
    childReasoningOutput
      .filter((event) => event.messageId === childMessageId)
      .map((event) => event.update),
    expectedReasoningOutput.initialThinking,
  );
  reasoningObservations.push({
    prompt: "SUBAGENT_REASONING_FIXTURE",
    runId: childReasoningRun.runId,
    messageId: childMessageId,
    sseEvents: reasoningSseInput(reasoningFixtures.initialThinking),
    observedAcp: observedChildReasoning,
  });
  await c.prompt("SUB_MODEL");
  const selectedChild = await c.client.extMethod(
    LODY_EXTENSION_METHODS.subagentsList,
    { sessionId: c.id },
  );
  assert.equal(selectedChild.tasks.at(-1).modelId, "localtest/fixture");
  assert.equal(selectedChild.tasks.at(-1).status, "completed");
  await c.close();
  const broken = join(root, "failing.ts");
  await writeFile(
    broken,
    `export default function() { throw new Error('synthetic extension load failure'); }`,
  );
  const failing = spawn(
    process.execPath,
    [entry, "--provider", "localtest", "--model", "fixture", "-e", broken],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: profile,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(failing);
  failing.stderr.pipe(process.stderr);
  const failingClient = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      unstable_createElicitation: () => new Promise(() => {}),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      extNotification: async () => {},
    }),
    ndJsonStream(Writable.toWeb(failing.stdin), Readable.toWeb(failing.stdout)),
  );
  await failingClient.initialize({ protocolVersion: 1 });
  await Promise.all([
    assert.rejects(
      failingClient.newSession({ cwd: root, mcpServers: [] }),
      (error) => {
        assert.match(
          error.data?.details ?? "",
          /Failed to load extension[\s\S]*synthetic extension load failure/,
          JSON.stringify(error),
        );
        return true;
      },
    ),
    once(failing, "exit"),
  ]);
  children.delete(failing);
  await assert.rejects(access(marker));
  const conflictingTodo = join(root, "conflicting-todo.ts");
  await writeFile(
    conflictingTodo,
    [
      "export default function (pi) {",
      "  pi.registerTool({",
      '    name: "todo",',
      '    label: "Conflicting todo",',
      '    description: "Conflicts with the packaged todo tool",',
      '    parameters: { type: "object", properties: {} },',
      '    execute: async () => ({ content: [{ type: "text", text: "" }] }),',
      "  });",
      "}",
    ].join("\n"),
  );
  const conflicting = spawn(
    process.execPath,
    [
      entry,
      "--provider",
      "localtest",
      "--model",
      "fixture",
      "-e",
      conflictingTodo,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: profile,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.add(conflicting);
  conflicting.stderr.pipe(process.stderr);
  const conflictingClient = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      unstable_createElicitation: () => new Promise(() => {}),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      extNotification: async () => {},
    }),
    ndJsonStream(
      Writable.toWeb(conflicting.stdin),
      Readable.toWeb(conflicting.stdout),
    ),
  );
  await conflictingClient.initialize({ protocolVersion: 1 });
  await Promise.all([
    assert.rejects(
      conflictingClient.newSession({ cwd: root, mcpServers: [] }),
      (error) => {
        assert.match(
          error.data?.details ?? "",
          /Failed to load extension[\s\S]*Tool "todo" conflicts with/,
          JSON.stringify(error),
        );
        return true;
      },
    ),
    once(conflicting, "exit"),
  ]);
  children.delete(conflicting);
  const rejected = spawn(
    process.execPath,
    [entry, "-e", join(root, "does-not-exist.ts")],
    { cwd: root, stdio: "ignore" },
  );
  assert.notEqual((await once(rejected, "exit"))[0], 0);
  for (const body of bodies.filter((body) =>
    body.messages.some(
      (message) =>
        message.role === "user" &&
        ["CHILD_TEST", "CHILD_HOLD"].includes(message.content),
    ),
  )) {
    const names = body.tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(!names.includes("questionnaire") && !names.includes("subagent"));
  }
  const reasoningArtifact = join(root, "reasoning-sse-observations.json");
  await writeFile(
    reasoningArtifact,
    `${JSON.stringify({ fixtures: reasoningObservations }, null, 2)}\n`,
  );
  console.log(`Reasoning SSE artifact: ${reasoningArtifact}`);
  if (codemodeOnly)
    assert.ok(
      bodies.some((body) =>
        body.messages.some(
          (message) =>
            message.role === "tool" &&
            String(message.content).includes("CHILD_ISOLATED"),
        ),
      ),
      "native child must not inherit parent question, recursive subagent or MCP tools",
    );
  console.log(
    `Native Pi V1 smoke passed (${codemodeOnly ? "codemode only" : "ordinary tools"}): additionalDirectories new/load/resume/fork, native workspace tools and isolation, questions, todo/resume, session list/load, subagent lifecycle/output/cancel, Stop/recovery, ambient exclusion, explicit extension opt-in and handled commands`,
  );
}
try {
  for (const mode of [false, true]) await exercise(mode);
} finally {
  clearTimeout(deadline);
  for (const child of children) child.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
