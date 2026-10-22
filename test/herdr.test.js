import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { listenControl, sendControl } from "../src/control.js";
import { agentCommand, executeTask, focusTask, resolveAgentPane, resolveWorkspace, runHerdr, socketRequest } from "../src/herdr.js";
import { clickedItemId, controlSocketPath } from "../src/paths.js";

const dir = mkdtempSync(join(tmpdir(), "hs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const workspaces = [
  { workspace_id: "w1", label: "api" },
  { workspace_id: "w2", label: "Web" },
  { workspace_id: "w3", label: "dup" },
  { workspace_id: "w4", label: "dup" },
];
const agents = [
  { pane_id: "w1:p1", workspace_id: "w1", agent: "claude" },
  { pane_id: "w1:p2", workspace_id: "w1", agent: "codex", name: "reviewer" },
  { pane_id: "w1:p3", workspace_id: "w1", agent: "codex" },
  { pane_id: "w2:p1", workspace_id: "w2", agent: "claude" },
];

test("resolveWorkspace matches label, then case-insensitive label, then id", () => {
  assert.equal(resolveWorkspace(workspaces, "api").workspace_id, "w1");
  assert.equal(resolveWorkspace(workspaces, "web").workspace_id, "w2");
  assert.equal(resolveWorkspace(workspaces, "w2").workspace_id, "w2");
  assert.throws(() => resolveWorkspace(workspaces, "nope"), /target_not_found: workspace "nope" not found/);
  assert.throws(() => resolveWorkspace(workspaces, "dup"), /target_ambiguous: .*\(w3, w4\)/);
});

test("resolveAgentPane prefers agent names, then agent kinds, within the workspace", () => {
  assert.equal(resolveAgentPane(agents, "w1", "claude"), "w1:p1");
  assert.equal(resolveAgentPane(agents, "w1", "Reviewer"), "w1:p2");
  assert.equal(resolveAgentPane(agents, "w2", "claude"), "w2:p1");
  assert.throws(() => resolveAgentPane(agents, "w1", "codex"), /ambiguous \(w1:p2, w1:p3\)/);
  assert.throws(() => resolveAgentPane(agents, "w2", "codex"), /not found/);
});

function fakeHerdr(responses) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response ?? {};
  };
  return { calls, run };
}

test("prompt task resolves workspace + agent and submits with agent prompt", async () => {
  const herdr = fakeHerdr({ "workspace list": { workspaces }, "agent list": { agents } });
  const task = { kind: "prompt", workspace: "api", agent: "reviewer", text: "--review now" };
  assert.deepEqual(await executeTask(task, herdr.run), { summary: "prompted w1:p2", pane_id: "w1:p2" });
  assert.deepEqual(herdr.calls.at(-1), ["agent", "prompt", "w1:p2", "--review now"]);
});

test("prompt task with pane_id skips resolution", async () => {
  const herdr = fakeHerdr({});
  await executeTask({ kind: "prompt", pane_id: "w9:p9", text: "hi" }, herdr.run);
  assert.deepEqual(herdr.calls, [["agent", "prompt", "w9:p9", "hi"]]);
});

test("missing prompt target is reported as an error, not a crash", async () => {
  const herdr = fakeHerdr({ "workspace list": { workspaces }, "agent list": { agents } });
  await assert.rejects(executeTask({ kind: "prompt", workspace: "api", agent: "gemini", text: "x" }, herdr.run), /not found/);
  assert.equal(herdr.calls.some((call) => call[1] === "prompt"), false);
});

test("command task opens an unfocused tab and runs the command in its root pane", async () => {
  const herdr = fakeHerdr({
    "workspace list": { workspaces },
    "tab create": { type: "tab_created", tab: { tab_id: "w1:t4" }, root_pane: { pane_id: "w1:p7" } },
  });
  const task = { kind: "command", workspace: "api", cwd: "~/src/api", tab_name: "nightly", command: "npm test" };
  assert.deepEqual(await executeTask(task, herdr.run), { summary: "started in w1:p7", tab_id: "w1:t4", pane_id: "w1:p7" });
  assert.deepEqual(herdr.calls.slice(1), [
    ["tab", "create", "--workspace", "w1", "--no-focus", "--cwd", join(homedir(), "src/api"), "--label", "nightly"],
    ["pane", "run", "w1:p7", "npm test"],
  ]);
});

test("command task fails cleanly when tab create returns no pane", async () => {
  const herdr = fakeHerdr({ "workspace list": { workspaces }, "tab create": { type: "tab_created" } });
  await assert.rejects(executeTask({ kind: "command", workspace: "api", command: "ls" }, herdr.run), /no root pane/);
});

test("agent task launches the agent CLI with model, thinking, and a prompt read at run time", async () => {
  const herdr = fakeHerdr({
    "workspace list": { workspaces },
    "tab create": { tab: { tab_id: "w1:t4" }, root_pane: { pane_id: "w1:p7" } },
  });
  const task = {
    kind: "agent",
    agent: "murong",
    model: "anthropic/claude-opus-5-5",
    thinking: "medium",
    prompt_file: "~/brief's.md",
    workspace: "api",
  };
  await executeTask(task, herdr.run);
  assert.deepEqual(herdr.calls.at(-1), [
    "pane",
    "run",
    "w1:p7",
    `murong --model 'anthropic/claude-opus-5-5' --thinking 'medium' "$(cat '${join(homedir(), "brief")}'\\''s.md')"`,
  ]);
});

test("agent flags follow the CLI: claude takes thinking as --effort, inline prompts are quoted", () => {
  assert.equal(
    agentCommand({ agent: "claude", thinking: "high", prompt: "it's $HOME" }),
    `claude --effort 'high' 'it'\\''s $HOME'`,
  );
});

test("a focused run brings the new tab to the front after the command is typed", async () => {
  const herdr = fakeHerdr({
    "workspace list": { workspaces },
    "tab create": { tab: { tab_id: "w1:t4" }, root_pane: { pane_id: "w1:p7" } },
  });
  await executeTask({ kind: "command", workspace: "api", command: "ls" }, herdr.run, { focus: true });
  assert.deepEqual(herdr.calls.slice(-2), [["pane", "run", "w1:p7", "ls"], ["tab", "focus", "w1:t4"]]);
});

test("opening a task focuses its last tab, or its workspace once that tab is gone", async () => {
  const task = { kind: "agent", workspace: "api" };
  const live = fakeHerdr({});
  assert.equal(await focusTask(task, { last_tab_id: "w1:t4" }, live.run), "focused w1:t4");
  assert.deepEqual(live.calls, [["tab", "focus", "w1:t4"]]);

  const closed = fakeHerdr({ "tab focus": new Error("tab_not_found"), "workspace list": { workspaces } });
  assert.equal(await focusTask(task, { last_tab_id: "w1:t4" }, closed.run), "focused w1");
  assert.deepEqual(closed.calls.at(-1), ["workspace", "focus", "w1"]);

  const never = fakeHerdr({ "workspace list": { workspaces } });
  assert.equal(await focusTask(task, {}, never.run), "focused w1");
});

test("socketRequest speaks newline-delimited JSON and surfaces API errors", async () => {
  const path = join(dir, "herdr.sock");
  const seen = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.trim());
      seen.push(request);
      const reply =
        request.method === "module.set"
          ? { id: request.id, result: { type: "module_list", modules: [request.params] } }
          : { id: request.id, error: { code: "plugin_disabled", message: "plugin schedule-tasks is disabled" } };
      socket.write(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  try {
    const result = await socketRequest(path, "module.set", { module_id: "tasks" });
    assert.deepEqual(result, { type: "module_list", modules: [{ module_id: "tasks" }] });
    await assert.rejects(socketRequest(path, "ping"), (error) => error.code === "plugin_disabled");
    assert.equal(seen[0].method, "module.set");
    assert.equal(typeof seen[0].id, "string");
  } finally {
    server.close();
  }
  await assert.rejects(socketRequest(join(dir, "missing.sock"), "ping"), (error) => error.code === "ENOENT");
});

test("control channel round-trips one message per connection", async () => {
  const path = controlSocketPath(dir);
  const server = await listenControl(path, async (message) => ({ ok: true, echo: message.cmd }));
  try {
    assert.deepEqual(await sendControl(path, { cmd: "ping" }), { ok: true, echo: "ping" });
  } finally {
    server.close();
  }
});

test("long state dirs fall back to a short socket path", () => {
  const long = join(tmpdir(), "x".repeat(120));
  const path = controlSocketPath(long);
  assert.ok(Buffer.byteLength(path) <= 100);
  assert.equal(path, controlSocketPath(long));
  assert.equal(controlSocketPath("/short"), "/short/ctl.sock");
});

test("clickedItemId reads the env var, then the context JSON", () => {
  assert.equal(clickedItemId({ HERDR_MODULE_ITEM_ID: "a", HERDR_PLUGIN_CONTEXT_JSON: `{"module_item_id":"b"}` }), "a");
  assert.equal(clickedItemId({ HERDR_PLUGIN_CONTEXT_JSON: `{"module_id":"tasks","module_item_id":"b"}` }), "b");
  assert.equal(clickedItemId({ HERDR_PLUGIN_CONTEXT_JSON: `{"invocation_source":"keybinding"}` }), undefined);
  assert.equal(clickedItemId({ HERDR_PLUGIN_CONTEXT_JSON: "not json" }), undefined);
  assert.equal(clickedItemId({}), undefined);
});

test("runHerdr treats silent success as no result and rejects non-JSON output", async () => {
  // `herdr pane run` prints nothing on success.
  assert.equal(await runHerdr([], { bin: "/usr/bin/true" }), undefined);
  await assert.rejects(runHerdr(["not-json"], { bin: "/bin/echo" }), { code: "invalid_response" });
});
