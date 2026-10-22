# schedule-tasks

A Herdr plugin that runs tasks on cron schedules and shows them as a
**schedules** module at the top of the sidebar. Each row has `▶` (run now and
switch to the run's tab) and `⏸`/`⏵` (pause/resume) controls. Clicking the
row itself switches to the tab of the task's latest run, or to its workspace
when that tab is gone; this needs a Herdr build whose modules support
`click_action`.

Three kinds of task:

- **prompt**: type a prompt into an existing agent pane and submit it.
- **command**: open a new tab in a workspace and run a shell command in it.
- **agent**: open a new tab in a workspace and start an agent CLI (`murong` or
  `claude`) there with a configured model, thinking level, and prompt.

Needs Node.js 22+ on the `PATH` Herdr sees, macOS or Linux, and a Herdr build
with the sidebar module API (`module.set`). On older Herdr builds tasks still
run, but nothing shows in the sidebar.

## Install

```bash
herdr plugin link /path/to/herdr-schedule
herdr plugin action invoke schedule-tasks.restart   # or restart Herdr
```

The `[[startup]]` hook starts the scheduler daemon every time the Herdr server
starts.

## tasks.json

Tasks live in `$(herdr plugin config-dir schedule-tasks)/tasks.json`. Edit it
by hand or with `bin/schedule`; the daemon reloads it as soon as it changes.

```json
{
  "tasks": [
    {
      "id": "standup",
      "name": "Morning standup",
      "cron": "0 9 * * mon-fri",
      "kind": "prompt",
      "workspace": "api",
      "agent": "claude",
      "text": "Summarize yesterday's commits and open PRs"
    },
    {
      "id": "review-pane",
      "cron": "*/30 9-18 * * 1-5",
      "kind": "prompt",
      "pane_id": "w1:p2",
      "text": "Any new review comments?"
    },
    {
      "id": "nightly",
      "cron": "30 2 * * *",
      "kind": "command",
      "workspace": "api",
      "cwd": "~/src/api",
      "tab_name": "nightly",
      "command": "npm test 2>&1 | tee /tmp/nightly.log",
      "enabled": false
    },
    {
      "id": "daily-brief",
      "cron": "0 10 * * 1-5",
      "kind": "agent",
      "agent": "murong",
      "model": "anthropic/claude-opus-5-5",
      "thinking": "medium",
      "prompt_file": "~/briefs/daily.md",
      "workspace": "api",
      "cwd": "~/src/api",
      "tab_name": "daily-brief"
    }
  ]
}
```

| Field | Kinds | Meaning |
| --- | --- | --- |
| `id` | all | Required. 1-64 of `A-Z a-z 0-9 : . _ -`. |
| `name` | all | Sidebar label. Defaults to `id`. |
| `cron` | all | Required. `minute hour day-of-month month day-of-week`, local time. Supports `*`, lists `1,15`, ranges `1-5`, steps `*/10` `9-17/2`, and names `jan`, `mon`. `0` and `7` are Sunday. If both day fields are set, either one can match (classic cron). |
| `enabled` | all | Defaults to `true`. |
| `text` | prompt | Required. The prompt to submit. |
| `pane_id` | prompt | Target agent pane, e.g. `w1:p2`. |
| `workspace` + `agent` | prompt | Or pick the agent at run time: the workspace label (or id), and the agent's name (set with `herdr agent rename`) or kind (`claude`, `codex`, …). It must match exactly one agent in that workspace. |
| `workspace` | command, agent | Required. Workspace label (or id) that gets the new tab. |
| `cwd` | command, agent | Absolute path or `~/…` for the new tab. |
| `tab_name` | command, agent | Label for the new tab. |
| `command` | command | Required. Shell command typed into the new tab and run with Enter. |
| `agent` | agent | Required. Agent CLI to start: `murong` or `claude`. |
| `model` | agent | Model passed with `--model`. Omit for the CLI's default. |
| `thinking` | agent | Thinking level: `murong --thinking`, `claude --effort`. Omit for the CLI's default. |
| `prompt` / `prompt_file` | agent | Exactly one. The first message, inline or as an absolute / `~/…` file path. A file is read when the run starts, so edits apply to the next run. |

## CLI

`bin/schedule` works inside or outside Herdr panes. It finds tasks.json with
`herdr plugin config-dir schedule-tasks`.

```bash
bin/schedule add standup --cron "0 9 * * 1-5" --workspace api --agent claude \
  --prompt "Summarize yesterday's commits"
bin/schedule add nightly --cron "30 2 * * *" --workspace api --cwd ~/src/api \
  --tab-name nightly --command "npm test"
bin/schedule add daily-brief --cron "0 10 * * 1-5" --workspace api --cwd ~/src/api \
  --launch murong --model anthropic/claude-opus-5-5 --thinking medium \
  --prompt-file ~/briefs/daily.md
bin/schedule set daily-brief --thinking high   # change fields; "" removes one
bin/schedule list            # next run and last result
bin/schedule disable nightly
bin/schedule enable nightly
bin/schedule run standup     # run now
bin/schedule remove nightly
bin/schedule path            # print the tasks.json path
```

Plugin actions: `run-now`, `toggle`, and `open` (from the sidebar controls and
row clicks), `restart`, `stop`, and `open-config` (opens tasks.json and shows
its path in a notification).

## How runs work

- The scheduler checks every 10 seconds and runs each task at most once per
  matching minute.
- After sleep or downtime, missed runs are folded into one run, and the row
  shows `(missed N)`. Pausing and then resuming a task never catches up runs
  from while it was paused.
- A run that is still going when the next slot comes up makes that slot get
  skipped.
- Prompt runs use `herdr agent prompt <pane> <text>`. A missing or ambiguous
  target, or an agent that is `blocked`, marks the run failed.
- Command and agent runs use `herdr tab create --workspace <id> --no-focus
  [--cwd] [--label]` then `herdr pane run <root pane> <command>`. The run
  counts as successful once the command has been typed in; the command's exit
  status is not tracked. Scheduled runs never take focus; `▶` in the sidebar
  switches to the new tab.
- Daylight saving: local times skipped by spring-forward don't run that day,
  and the repeated hour at fall-back runs once.

## Troubleshooting

- **Nothing in the sidebar**: check that the plugin is enabled
  (`herdr plugin list`), then look at
  `herdr plugin log list --plugin schedule-tasks` and the daemon log at
  `<state dir>/daemon.log`. The state dir is printed in
  `<config dir>/.state-dir`.
- **A row shows `invalid: …`**: fix that task in tasks.json. Other tasks keep
  running. If the whole file fails to parse, an error row shows up and the last
  good task list keeps running.
- **`target_not_found` / `target_ambiguous`**: the workspace label or agent
  didn't match exactly one target. Use `pane_id`, or give the agent a unique
  name with `herdr agent rename`.
- **Long commands on macOS**: Herdr rejects a command line longer than the
  terminal's input limit. Put long commands in a script.
- **Stuck daemon**: run the `restart` action. `stop` shows a row with a `↻`
  control that starts it again. The daemon exits by itself when the Herdr
  socket goes away or the plugin is disabled.

Runtime state (enabled flags, last run and result) is kept in
`<state dir>/state.json`. Only the daemon writes it.

## Development

```bash
node --test
```
