// `bin/schedule`: edit tasks.json and poke the daemon. Works outside Herdr panes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { controlAlive, sendControl } from "./control.js";
import { runHerdr } from "./herdr.js";
import { formatTime, PLUGIN_ID } from "./module.js";
import {
  controlSocketPath,
  pluginDirsFromEnv,
  readStatePointer,
  stateFile,
  tasksFile,
  writeFileAtomic,
} from "./paths.js";
import { upcoming } from "./scheduler.js";
import { parseTasksFile, validateTask } from "./tasks.js";

const USAGE = `usage: schedule <command> [args]

  add <id> --cron "<m h dom mon dow>" [--name <label>] [--disabled]
      --prompt "<text>" (--pane <pane_id> | --workspace <label> --agent <name>)
    | --command "<shell command>" --workspace <label> [--cwd <dir>] [--tab-name <name>]
    | --launch <murong|claude> [--model <model>] [--thinking <level>]
      (--prompt-file <path> | --prompt "<text>") --workspace <label> [--cwd <dir>] [--tab-name <name>]
  set <id> [any add option except --disabled]
                         change fields of an existing task; an empty value ("") removes the field
  list [--json]          show tasks, next run, and last result
  remove <id>            delete a task
  enable <id>            resume a task
  disable <id>           pause a task
  run <id>               run a task now (starts the daemon through Herdr if needed)
  path                   print the tasks.json path

examples:
  schedule add standup --cron "0 9 * * 1-5" --workspace api --agent claude \\
    --prompt "Summarize yesterday's commits"
  schedule add nightly --cron "30 2 * * *" --workspace api --cwd ~/src/api \\
    --tab-name nightly --command "npm test"
  schedule add brief --cron "0 10 * * 1-5" --workspace api --cwd ~/src/api \\
    --launch murong --model anthropic/claude-opus-5-5 --thinking medium --prompt-file ~/brief.md
  schedule set brief --model anthropic/claude-opus-5 --thinking high`;

class UsageError extends Error {}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (["disabled", "json", "help"].includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? args[++index] : arg.slice(eq + 1);
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  return { positional, flags };
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function locateDirs() {
  const fromEnv = pluginDirsFromEnv();
  if (fromEnv) return fromEnv;
  let configDir;
  try {
    configDir = execFileSync(herdrBin(), ["plugin", "config-dir", PLUGIN_ID], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`cannot locate the plugin config dir (herdr plugin config-dir ${PLUGIN_ID}): ${error.message}`);
  }
  return { configDir, stateDir: readStatePointer(configDir) };
}

function readTasksRoot(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { tasks: [] };
    throw error;
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}); fix it first`);
  }
  if (!root || typeof root !== "object" || !Array.isArray(root.tasks)) {
    throw new Error(`${file} must be an object with a "tasks" array; fix it first`);
  }
  return root;
}

function writeTasksRoot(file, root) {
  writeFileAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
}

function readState(stateDir) {
  if (!stateDir) return { tasks: {} };
  try {
    return JSON.parse(readFileSync(stateFile(stateDir), "utf8"));
  } catch {
    return { tasks: {} };
  }
}

/** Best-effort notification to a running daemon; it also watches tasks.json. */
async function tellDaemon(stateDir, message) {
  if (!stateDir) return undefined;
  try {
    return await sendControl(controlSocketPath(stateDir), message, { timeoutMs: 2000 });
  } catch {
    return undefined;
  }
}

function requireId(positional, command) {
  const id = positional[0];
  if (!id) throw new UsageError(`schedule ${command} needs a task id`);
  return id;
}

const COMMON_FLAGS = { name: "name", cron: "cron" };
// CLI option -> tasks.json field, per task kind.
const KIND_FLAGS = {
  prompt: { prompt: "text", pane: "pane_id", workspace: "workspace", agent: "agent" },
  command: { command: "command", workspace: "workspace", cwd: "cwd", "tab-name": "tab_name" },
  agent: {
    launch: "agent",
    model: "model",
    thinking: "thinking",
    prompt: "prompt",
    "prompt-file": "prompt_file",
    workspace: "workspace",
    cwd: "cwd",
    "tab-name": "tab_name",
  },
};

function kindFromFlags(flags) {
  if (flags.launch !== undefined) return "agent";
  if (flags.prompt !== undefined && flags.command !== undefined) {
    throw new UsageError("use either --prompt or --command");
  }
  if (flags.prompt !== undefined) return "prompt";
  if (flags.command !== undefined) return "command";
  throw new UsageError("add needs --prompt, --command or --launch");
}

/** Copies option values onto `raw`; with `unset`, an empty value deletes the field. */
function applyFlags(raw, flags, { unset }) {
  const fields = { ...COMMON_FLAGS, ...KIND_FLAGS[raw.kind] };
  for (const [flag, value] of Object.entries(flags)) {
    const key = fields[flag];
    if (key === undefined) throw new UsageError(`--${flag} does not apply to ${raw.kind} tasks`);
    if (unset && value === "") delete raw[key];
    else raw[key] = value;
  }
  // An agent prompt comes from exactly one place; setting one replaces the other.
  if (raw.kind === "agent" && flags.prompt !== undefined) delete raw.prompt_file;
  if (raw.kind === "agent" && flags["prompt-file"] !== undefined) delete raw.prompt;
}

function buildRawTask(id, flags) {
  const { disabled, ...fields } = flags;
  const raw = { id, kind: kindFromFlags(fields) };
  applyFlags(raw, fields, { unset: false });
  if (disabled) raw.enabled = false;
  return raw;
}

function describeEntry(entry, state, now) {
  if (!entry.ok) {
    return [entry.id ?? `#${entry.index + 1}`, "-", "-", "invalid", entry.error, ""];
  }
  const { task } = entry;
  const runtime = state.tasks?.[task.id];
  const enabled = runtime?.enabled ?? task.enabled;
  const next = enabled ? upcoming(task.cron, now) : null;
  let last = "";
  if (runtime?.running) last = "running";
  else if (runtime?.last_result === "ok") last = `ok ${formatTime(runtime.last_run_at, now)}`;
  else if (runtime?.last_result === "error") last = `failed ${formatTime(runtime.last_run_at, now)}: ${runtime.last_error}`;
  if (runtime?.last_note) last += ` (${runtime.last_note})`;
  return [task.id, task.kind, task.cron, enabled ? "enabled" : "paused", next === null ? "-" : formatTime(next, now), last];
}

function printTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
        .join("  ")
        .trimEnd(),
    );
  }
}

async function runNow(dirs, id) {
  let stateDir = dirs.stateDir;
  if (!stateDir || !(await controlAlive(controlSocketPath(stateDir)))) {
    // Start the daemon through Herdr so it gets the plugin environment.
    await runHerdr(["plugin", "action", "invoke", `${PLUGIN_ID}.restart`]);
    const deadline = Date.now() + 8000;
    for (;;) {
      stateDir = stateDir ?? readStatePointer(dirs.configDir);
      if (stateDir && (await controlAlive(controlSocketPath(stateDir)))) break;
      if (Date.now() > deadline) throw new Error("the scheduler daemon did not start; check `herdr plugin log list --plugin schedule-tasks`");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const response = await sendControl(controlSocketPath(stateDir), { cmd: "run", task_id: id });
  if (!response.ok) throw new Error(response.error);
  console.log(`started ${id}`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  const { positional, flags } = parseArgs(rest);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const dirs = locateDirs();
  const file = tasksFile(dirs.configDir);
  const now = Date.now();

  switch (command) {
    case "path":
      console.log(file);
      return;
    case "add": {
      const id = requireId(positional, "add");
      const raw = buildRawTask(id, flags);
      const result = validateTask(raw, now);
      if (!result.ok) throw new Error(result.error);
      const root = readTasksRoot(file);
      if (root.tasks.some((task) => task?.id === id)) throw new Error(`task "${id}" already exists`);
      root.tasks.push(raw);
      writeTasksRoot(file, root);
      await tellDaemon(dirs.stateDir, { cmd: "reload" });
      console.log(`added ${id}`);
      return;
    }
    case "set": {
      const id = requireId(positional, "set");
      if (flags.disabled) throw new UsageError("use schedule disable to pause a task");
      if (Object.keys(flags).length === 0) throw new UsageError("set needs at least one option");
      const root = readTasksRoot(file);
      const index = root.tasks.findIndex((task) => task?.id === id);
      if (index === -1) throw new Error(`no task "${id}"`);
      const raw = { ...root.tasks[index] };
      applyFlags(raw, flags, { unset: true });
      const result = validateTask(raw, now);
      if (!result.ok) throw new Error(result.error);
      root.tasks[index] = raw;
      writeTasksRoot(file, root);
      await tellDaemon(dirs.stateDir, { cmd: "reload" });
      console.log(`updated ${id}`);
      return;
    }
    case "remove": {
      const id = requireId(positional, "remove");
      const root = readTasksRoot(file);
      const kept = root.tasks.filter((task) => task?.id !== id);
      if (kept.length === root.tasks.length) throw new Error(`no task "${id}"`);
      root.tasks = kept;
      writeTasksRoot(file, root);
      await tellDaemon(dirs.stateDir, { cmd: "reload" });
      console.log(`removed ${id}`);
      return;
    }
    case "enable":
    case "disable": {
      const id = requireId(positional, command);
      const root = readTasksRoot(file);
      const task = root.tasks.find((candidate) => candidate?.id === id);
      if (!task) throw new Error(`no task "${id}"`);
      const enabled = command === "enable";
      if (enabled) delete task.enabled;
      else task.enabled = false;
      writeTasksRoot(file, root);
      // A sidebar toggle may have overridden the file value; align the runtime flag too.
      await tellDaemon(dirs.stateDir, { cmd: "set-enabled", task_id: id, enabled });
      console.log(`${id} ${enabled ? "enabled" : "disabled"}`);
      return;
    }
    case "run":
      await runNow(dirs, requireId(positional, "run"));
      return;
    case "list": {
      const root = readTasksRoot(file);
      const entries = parseTasksFile(JSON.stringify(root), now);
      const state = readState(dirs.stateDir);
      if (flags.json) {
        console.log(JSON.stringify({ tasks_file: file, entries, state }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(`no tasks in ${file}`);
        return;
      }
      printTable([["ID", "KIND", "CRON", "STATE", "NEXT", "LAST"], ...entries.map((entry) => describeEntry(entry, state, now))]);
      return;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`schedule: ${error.message}`);
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exit(error instanceof UsageError ? 2 : 1);
});
