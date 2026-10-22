// tasks.json schema: { "tasks": [Task, ...] }. Pure validation, no I/O.
import { CronError, nextRun, parseCron } from "./cron.js";

export const ID_PATTERN = /^[A-Za-z0-9:._-]{1,64}$/;

const COMMON_KEYS = ["id", "name", "description", "cron", "kind", "enabled"];
const KIND_KEYS = {
  prompt: ["text", "pane_id", "workspace", "agent"],
  command: ["command", "workspace", "cwd", "tab_name"],
  agent: ["agent", "model", "thinking", "prompt", "prompt_file", "workspace", "cwd", "tab_name"],
};

/** Agent CLIs an `agent` task can launch, and their model / thinking flags. */
export const AGENT_FLAGS = {
  murong: { model: "--model", thinking: "--thinking" },
  claude: { model: "--model", thinking: "--effort" },
};

function optionalString(raw, key) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

function requiredString(raw, key) {
  const value = optionalString(raw, key);
  if (value === undefined) throw new Error(`"${key}" is required`);
  return value;
}

/** Validates one raw task. Returns { ok: true, task } or { ok: false, error }. */
export function validateTask(raw, referenceTime = Date.now()) {
  try {
    return { ok: true, task: normalizeTask(raw, referenceTime) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeTask(raw, referenceTime) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("task must be an object");
  const id = requiredString(raw, "id");
  if (!ID_PATTERN.test(id)) {
    throw new Error(`"id" must be 1-64 ASCII letters, digits, ":", ".", "_" or "-"`);
  }
  const kind = raw.kind;
  if (!Object.hasOwn(KIND_KEYS, kind ?? "")) throw new Error(`"kind" must be "prompt", "command" or "agent"`);
  const allowed = new Set([...COMMON_KEYS, ...KIND_KEYS[kind]]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`unknown field${unknown.length > 1 ? "s" : ""} for ${kind} task: ${unknown.join(", ")}`);

  const cronText = requiredString(raw, "cron");
  let cron;
  try {
    cron = parseCron(cronText);
  } catch (error) {
    if (error instanceof CronError) throw new Error(`cron: ${error.message}`);
    throw error;
  }
  if (nextRun(cron, referenceTime) === null) throw new Error(`cron "${cronText}" never matches`);

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error(`"enabled" must be true or false`);
  const task = {
    id,
    name: optionalString(raw, "name") ?? id,
    kind,
    cron: cron.source,
    enabled: raw.enabled ?? true,
  };

  if (kind === "prompt") {
    task.text = requiredString(raw, "text");
    const paneId = optionalString(raw, "pane_id");
    const workspace = optionalString(raw, "workspace");
    const agent = optionalString(raw, "agent");
    if (paneId !== undefined) {
      if (workspace !== undefined || agent !== undefined) {
        throw new Error(`use either "pane_id" or "workspace" + "agent", not both`);
      }
      task.pane_id = paneId;
    } else {
      if (workspace === undefined || agent === undefined) {
        throw new Error(`prompt task needs "pane_id" or both "workspace" and "agent"`);
      }
      task.workspace = workspace;
      task.agent = agent;
    }
  } else {
    if (kind === "command") {
      task.command = requiredString(raw, "command");
    } else {
      task.agent = requiredString(raw, "agent");
      if (!Object.hasOwn(AGENT_FLAGS, task.agent)) {
        throw new Error(`"agent" must be one of: ${Object.keys(AGENT_FLAGS).join(", ")}`);
      }
      const model = optionalString(raw, "model");
      if (model !== undefined) task.model = model;
      const thinking = optionalString(raw, "thinking");
      if (thinking !== undefined) task.thinking = thinking;
      const prompt = optionalString(raw, "prompt");
      const promptFile = optionalString(raw, "prompt_file");
      if ((prompt === undefined) === (promptFile === undefined)) {
        throw new Error(`agent task needs exactly one of "prompt" or "prompt_file"`);
      }
      if (prompt !== undefined) task.prompt = prompt;
      else task.prompt_file = homePath(promptFile, "prompt_file");
    }
    task.workspace = requiredString(raw, "workspace");
    const cwd = optionalString(raw, "cwd");
    if (cwd !== undefined) task.cwd = homePath(cwd, "cwd");
    const tabName = optionalString(raw, "tab_name");
    if (tabName !== undefined) task.tab_name = tabName;
  }
  return task;
}

function homePath(value, key) {
  if (!value.startsWith("/") && value !== "~" && !value.startsWith("~/")) {
    throw new Error(`"${key}" must be an absolute path or start with ~/`);
  }
  return value;
}

/**
 * Parses tasks.json text. Throws on unreadable JSON or a wrong root shape;
 * per-task problems are reported as entries with `ok: false`.
 * Returns [{ index, ok, task?, error?, id?, name? }].
 */
export function parseTasksFile(text, referenceTime = Date.now()) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new Error(`tasks.json is not valid JSON: ${error.message}`);
  }
  if (root === null || typeof root !== "object" || Array.isArray(root) || !Array.isArray(root.tasks)) {
    throw new Error(`tasks.json must be an object with a "tasks" array`);
  }
  const seen = new Set();
  return root.tasks.map((raw, index) => {
    const result = validateTask(raw, referenceTime);
    const rawId = typeof raw?.id === "string" ? raw.id : undefined;
    const rawName = typeof raw?.name === "string" ? raw.name : undefined;
    if (!result.ok) return { index, ok: false, error: result.error, id: rawId, name: rawName };
    if (seen.has(result.task.id)) {
      return { index, ok: false, error: `duplicate id "${result.task.id}"`, id: rawId, name: rawName };
    }
    seen.add(result.task.id);
    return { index, ok: true, task: result.task };
  });
}

export function emptyTasksFile() {
  return `${JSON.stringify({ tasks: [] }, null, 2)}\n`;
}
