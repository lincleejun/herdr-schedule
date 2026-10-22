// Entry point for manifest commands: `node src/actions.js <startup|run-now|toggle|open|restart|stop|open-config>`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { controlAlive, sendControl } from "./control.js";
import { runHerdr } from "./herdr.js";
import { ensureDaemon, stopDaemon } from "./launcher.js";
import { TITLE } from "./module.js";
import { clickedItemId, controlSocketPath, pluginDirsFromEnv, tasksFile, writeFileAtomic, writeStatePointer } from "./paths.js";
import { emptyTasksFile } from "./tasks.js";

async function notify(body) {
  await runHerdr(["notification", "show", TITLE, "--body", body], { timeoutMs: 5000 }).catch(() => undefined);
}

async function taskCommand(stateDir, action, message) {
  const itemId = clickedItemId();
  if (!itemId) {
    throw new Error(`invoke ${action} from a task row in the sidebar, or use bin/schedule`);
  }
  await ensureDaemon(stateDir);
  const response = await sendControl(controlSocketPath(stateDir), { ...message, task_id: itemId });
  if (!response.ok) throw new Error(response.error);
  return response;
}

function openInDefaultApp(file) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(opener, [file], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Printing the path is the fallback.
  }
}

async function main(action) {
  const dirs = pluginDirsFromEnv();
  if (!dirs) throw new Error("this command must be run by Herdr as a schedule-tasks plugin action");
  writeStatePointer(dirs.configDir, dirs.stateDir);
  const control = controlSocketPath(dirs.stateDir);
  switch (action) {
    case "startup":
      // Herdr reruns startup hooks after a live handoff; modules are transient,
      // so an already-running daemon only needs to publish again.
      if (await controlAlive(control)) {
        await sendControl(control, { cmd: "republish" });
        return "scheduler already running; republished";
      }
      return `scheduler ${await ensureDaemon(dirs.stateDir)}`;
    case "run-now":
      // A click is a request to watch the run, so bring its tab to the front.
      await taskCommand(dirs.stateDir, action, { cmd: "run", focus: true });
      return `started ${clickedItemId()}`;
    case "toggle": {
      const response = await taskCommand(dirs.stateDir, action, { cmd: "toggle" });
      return `${clickedItemId()} ${response.enabled ? "enabled" : "paused"}`;
    }
    case "open":
      return (await taskCommand(dirs.stateDir, action, { cmd: "open" })).focused;
    case "restart":
      await stopDaemon(dirs.stateDir);
      await ensureDaemon(dirs.stateDir);
      return "scheduler restarted";
    case "stop":
      return (await stopDaemon(dirs.stateDir)) === "stopped" ? "scheduler stopped" : "scheduler was not running";
    case "open-config": {
      const file = tasksFile(dirs.configDir);
      if (!existsSync(file)) writeFileAtomic(file, emptyTasksFile());
      openInDefaultApp(file);
      await notify(file);
      return file;
    }
    default:
      throw new Error(`unknown action "${action}"`);
  }
}

const action = process.argv[2];
main(action).then(
  (message) => {
    console.log(message);
  },
  async (error) => {
    console.error(`schedule-tasks ${action}: ${error.message}`);
    if (action !== "startup") await notify(error.message);
    process.exit(1);
  },
);
