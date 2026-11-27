---
name: background-exec
description: Run long non-agent shell commands such as builds, tests, and simulations with the background_exec tool, and handle the background-job-finished and background-jobs-finished messages that report their results. Use before starting such a command and whenever one of those messages arrives.
---

# Background shell jobs

- `background_exec` runs work, not agents. Use `subagent` for authorized delegation by default. If trusted project instructions require local Herdr role sessions, use the `herdr` skill from a verified Herdr pane with the prescribed session fork and role prompt. Do not switch routes on failure or launch a bare agent CLI or SDK wrapper through `bash`. Explicit user-requested CLI tests remain allowed.
- Long non-agent commands (build, test, simulation): use `background_exec` (TUI or RPC sessions only). `command` runs in the session's working directory; use `cd PATH && COMMAND` to run elsewhere. `timeout` is optional, in seconds; without it the job has no limit.
- Run the command in the foreground: no `nohup`, trailing `&`, completion watchers, or wait-only `sleep` or Perl. Keep the returned `jobId`, then end the turn or do independent work. Never poll, call `bg_wait`, or ask the user to resume you manually.
- On `background-job-finished` or `background-jobs-finished` (with `results[]`), check each `status`, `exitCode`, and `logTail` (up to 1 KiB or 12 lines). Reuse those excerpts; read `logPath` only for missing evidence. Batch artifact reads, and verify before reporting success. Each result is progress, not overall completion; `remainingJobs` counts the jobs still running.
- `background_job`: pass `jobId` with `action: "status"` or `"cancel"`, and only when the user asks. Never relaunch a job to check on it.
- Switching, reloading, or quitting the session cancels its jobs; ending a turn does not. Each job's record stays at `resultPath`; nothing recovers a cancelled job. If the tool is missing, report it, and in the TUI ask for `/reload` only after existing jobs finish. Reuse this guide within the same context.
