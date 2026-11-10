# pi-background-exec

**English** | [한국어](README.ko.md)

Runs long shell commands such as builds, tests, and simulations in the background, so the agent can end its turn instead of waiting. When a job finishes, the package wakes the agent with the job's status and the end of its log. Inside [Herdr](https://herdr.dev), the Pi pane stays `working` until those jobs finish and the agent has handled their results.

## Requirements

- Pi 1.5.0 or later, and Node.js 22.19 or later.
- `background_exec` works only in interactive (TUI) and RPC sessions.
- Herdr state reporting follows Herdr 0.9.5 (Pi integration version 9) and works only in the TUI.

## Install

```sh
pi install npm:@buyong/pi-background-exec
```

If you already load your own copy of `background_exec`, for example `~/.pi/agent/extensions/background-exec.ts`, remove it first. Two extensions that register the same tool name collide.

## What you get

| Name | Type | What it does |
| --- | --- | --- |
| `background_exec` | Tool | Starts a shell command in the session's working directory and returns its `jobId` right away. `timeout` (seconds) is optional. |
| `background_job` | Tool | Shows the status of a job or cancels it. |
| `background-exec` | Skill | Tells the model when to use these tools and how to handle their results. |
| Herdr agent state | Extension | Reports `working`, `blocked`, and `idle` to Herdr. |

When a job finishes while the agent is idle, the agent starts a new turn with a `background-job-finished` message. Jobs that finish during a turn are held and sent together at the next turn boundary as `background-jobs-finished`. Each message carries the status, the exit code, up to 1 KiB or 12 lines of the log, and `remainingJobs`.

Switching, reloading, or quitting the session cancels its running jobs. Ending a turn does not. Each job keeps `output.log` and `result.json` under `<session directory>/background-exec/<session id>/<job id>/`. The files are readable only by you and are not deleted automatically.

## Use with Herdr

Herdr accepts state reports for a Pi pane from one reporter only. Replace Herdr's own Pi integration with this package's:

1. Run `herdr integration uninstall pi`.
2. In Pi, run `/reload` after your running jobs finish, because a reload cancels them.

While Herdr's Pi integration is installed (`herdr-agent-state.ts` in Pi's `extensions` directory), this package does not report to Herdr, and Herdr's integration reports alone. To switch back, run `herdr integration install pi` and `/reload`.

With this package reporting:

- The pane stays `working` after the agent ends a turn with jobs still running, and becomes `done` after the agent handles the last result. `herdr agent prompt --wait` returns at that point.
- Pressing Escape to stop a run makes the pane `idle` at once, even with jobs still running.
- Another extension can keep the pane `working` by answering the `background-work:query-pending` event for its own pending work. pi-notify waits on the same event before it notifies "Ready for input".

To use only the background jobs without Herdr reporting, select the extension in your Pi settings:

```json
{
  "packages": [
    {
      "source": "npm:@buyong/pi-background-exec",
      "extensions": ["src/background-exec.ts"]
    }
  ]
}
```

## Verify

From `apps/pi-background-exec` in this repository:

```sh
pnpm run lint
pnpm run typecheck
pnpm run test:unit
```

To check a running Pi, start it from the repository root with only this package's extensions (`pi --no-extensions -e ./apps/pi-background-exec`) and ask: `Use background_exec to run "sleep 5 && echo done", then end your turn.` A `background-job-finished` message with `"status":"succeeded"` and the log tail `done` should arrive about five seconds later. This check needs a model.

## License

Apache-2.0. The Herdr reporter is derived from Herdr's Pi integration; see [NOTICE](NOTICE).
