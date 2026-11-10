# Changelog

## [Unreleased]

### New

- `background_exec` runs a long shell command in the background and returns its job ID at once. When the job finishes, the agent wakes up with its status, exit code, and the end of its log. `background_job` shows a job's status or cancels it, and the `background-exec` skill tells the model how to use both.
- Inside Herdr, the Pi pane stays `working` until background jobs finish and the agent has handled their results. This replaces Herdr's own Pi integration and stays off while that integration is installed.
