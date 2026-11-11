# Changelog

## [Unreleased]

## [0.1.2] - 2026-11-11

### Improved

- The `background_exec` guidance tells the model to use it instead of `bash` for builds, test suites, typechecks, lint runs, dependency installs, and simulations, including a first run to see what fails, and to keep `bash` for quick inspection. Before, it never said when to choose `background_exec` over `bash`, so models often ran long tests with `bash` unless an AGENTS.md line told them to read the `background-exec` skill.

## [0.1.1] - 2026-11-10

### New

- `background_exec` runs a long shell command in the background and returns its job ID at once. When the job finishes, the agent wakes up with its status, exit code, and the end of its log. `background_job` shows a job's status or cancels it, and the `background-exec` skill tells the model how to use both.
- Inside Herdr, the Pi pane stays `working` until background jobs finish and the agent has handled their results. This replaces Herdr's own Pi integration and stays off while that integration is installed.
- When a job finishes while the agent is idle, the agent starts a new turn with a `background-job-finished` message. Jobs that finish during a turn are held and sent together at the next turn boundary as `background-jobs-finished`, with `remainingJobs` showing how many are still running.
- `background_exec` accepts an optional `timeout` in seconds. Without it, the job has no time limit.
- Each job keeps `output.log` and `result.json` under `<session directory>/background-exec/<session id>/<job id>/`. The files are readable only by you and are not deleted automatically.
- Switching, reloading, or quitting the session cancels its running jobs. Ending a turn does not cancel them.
- With this package reporting to Herdr, pressing Escape to stop a run makes the pane `idle` at once, even with jobs still running.
- Another extension can keep the Herdr pane `working` by answering the `background-work:query-pending` event while it has pending work. pi-notify waits on the same event before it notifies "Ready for input".
