import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTasksFile, validateTask } from "../src/tasks.js";

const prompt = (overrides = {}) => ({
  id: "standup",
  kind: "prompt",
  cron: "0 9 * * 1-5",
  text: "Summarize yesterday",
  workspace: "api",
  agent: "claude",
  ...overrides,
});

const command = (overrides = {}) => ({
  id: "nightly",
  kind: "command",
  cron: "30 2 * * *",
  workspace: "api",
  command: "npm test",
  ...overrides,
});

const errorOf = (raw) => {
  const result = validateTask(raw);
  assert.equal(result.ok, false, JSON.stringify(raw));
  return result.error;
};

test("normalizes a prompt task targeting workspace + agent", () => {
  const result = validateTask(prompt({ cron: " 0  9 * * 1-5 " }));
  assert.deepEqual(result, {
    ok: true,
    task: {
      id: "standup",
      name: "standup",
      kind: "prompt",
      cron: "0 9 * * 1-5",
      enabled: true,
      text: "Summarize yesterday",
      workspace: "api",
      agent: "claude",
    },
  });
});

test("accepts a prompt task targeting a pane id", () => {
  const result = validateTask(prompt({ workspace: undefined, agent: undefined, pane_id: "w1:p2", name: "Standup" }));
  assert.equal(result.ok, true);
  assert.equal(result.task.pane_id, "w1:p2");
  assert.equal(result.task.name, "Standup");
  assert.equal("workspace" in result.task, false);
});

test("normalizes a command task with optional cwd and tab name", () => {
  const result = validateTask(command({ cwd: "~/src/api", tab_name: "nightly", enabled: false }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.task, {
    id: "nightly",
    name: "nightly",
    kind: "command",
    cron: "30 2 * * *",
    enabled: false,
    command: "npm test",
    workspace: "api",
    cwd: "~/src/api",
    tab_name: "nightly",
  });
});

test("rejects invalid tasks with specific messages", () => {
  assert.match(errorOf(null), /must be an object/);
  assert.match(errorOf(prompt({ id: undefined })), /"id" is required/);
  assert.match(errorOf(prompt({ id: "has space" })), /"id" must be/);
  assert.match(errorOf(prompt({ id: "x".repeat(65) })), /"id" must be/);
  assert.match(errorOf(prompt({ kind: "shell" })), /"kind" must be/);
  assert.match(errorOf(prompt({ cron: undefined })), /"cron" is required/);
  assert.match(errorOf(prompt({ cron: "0 9 * *" })), /^cron: expected 5 fields/);
  assert.match(errorOf(prompt({ cron: "0 0 30 2 *" })), /never matches/);
  assert.match(errorOf(prompt({ enabled: "yes" })), /"enabled" must be true or false/);
  assert.match(errorOf(prompt({ text: "" })), /"text" must be a non-empty string/);
  assert.match(errorOf(prompt({ agent: undefined })), /needs "pane_id" or both/);
  assert.match(errorOf(prompt({ pane_id: "w1:p1" })), /not both/);
  assert.match(errorOf(prompt({ crom: "0 9 * * *" })), /unknown field for prompt task: crom/);
  assert.match(errorOf(prompt({ cwd: "/tmp" })), /unknown field for prompt task: cwd/);
  assert.match(errorOf(command({ workspace: undefined })), /"workspace" is required/);
  assert.match(errorOf(command({ command: 42 })), /"command" must be a non-empty string/);
  assert.match(errorOf(command({ cwd: "relative/dir" })), /absolute path/);
  assert.match(errorOf(command({ agent: "claude" })), /unknown field for command task: agent/);
});

const agentTask = (overrides = {}) => ({
  id: "brief",
  kind: "agent",
  cron: "0 10 * * 1-5",
  agent: "murong",
  model: "anthropic/claude-opus-5-5",
  thinking: "medium",
  prompt_file: "~/brief.md",
  workspace: "api",
  ...overrides,
});

test("agent tasks name a supported CLI and exactly one prompt source", () => {
  assert.equal(validateTask(agentTask()).ok, true);
  assert.equal(validateTask(agentTask({ model: undefined, thinking: undefined })).ok, true);
  assert.match(errorOf(agentTask({ agent: "bash" })), /"agent" must be one of: murong, claude/);
  assert.match(errorOf(agentTask({ prompt: "hi" })), /exactly one of "prompt" or "prompt_file"/);
  assert.match(errorOf(agentTask({ prompt_file: undefined })), /exactly one of "prompt" or "prompt_file"/);
  assert.match(errorOf(agentTask({ prompt_file: "brief.md" })), /"prompt_file" must be an absolute path/);
  assert.match(errorOf(agentTask({ command: "ls" })), /unknown field for agent task: command/);
});

test("parseTasksFile reports per-task problems and duplicate ids", () => {
  const text = JSON.stringify({
    tasks: [prompt(), command(), prompt({ cron: "bad" }), command({ name: "Again" })],
  });
  const entries = parseTasksFile(text);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].ok, true);
  assert.equal(entries[1].ok, true);
  assert.equal(entries[2].ok, false);
  assert.equal(entries[2].id, "standup");
  assert.match(entries[2].error, /^cron:/);
  assert.deepEqual(entries[3], { index: 3, ok: false, error: `duplicate id "nightly"`, id: "nightly", name: "Again" });
});

test("parseTasksFile rejects unreadable roots", () => {
  assert.throws(() => parseTasksFile("{"), /not valid JSON/);
  assert.throws(() => parseTasksFile("[]"), /"tasks" array/);
  assert.throws(() => parseTasksFile(`{"tasks": {}}`), /"tasks" array/);
  assert.deepEqual(parseTasksFile(`{"tasks": []}`), []);
});
