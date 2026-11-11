# Changelog

## [Unreleased]

### Improved

- Long sessions with screenshots use fewer tokens. An image a tool returned is sent for 5 model responses and then replaced with a note. For an image opened with `read`, the note gives the file path so the model can read it again. Images you attach are still sent every time, and Pi's history keeps every image.

### Fixed

- Conversations with many images, such as screenshots opened with `read`, keep working. When a request would be larger than 8 MiB, images are made smaller, oldest first, and then left out with a note, oldest first. An image over 4 MiB and images over 5 MiB in one message are handled the same way. Before, the request failed with "The request body exceeds 8 MiB." and every later request in the session failed the same way. A request that is still too large without images now fails as a context overflow, so Pi compacts the conversation.

## [0.1.15] - 2026-11-11

### Fixed

- Manual authorization code sign-in opens the same Devin sign-in page and exchanges the code the same way as the Devin CLI. Before, the sign-in URL showed a 404 page, so the sign-in could not finish.
- Claude models can call several tools in one response. Before, such a response failed with "Cannot attach a delta without a tool ID to a specific call."
- A session whose history has a tool call without a result, for example after moving to another point with `/tree`, works again. Like Pi's own providers, the call gets the error result "No result provided"; before, every Devin request in that session failed with `invalid_argument`.
- The output limit leaves room for the input in the model's context window, as in Pi's own providers. A full context now ends the reply with a `length` stop, which Pi recovers from by compacting; before, the session could keep sending input larger than the window.
- Claude's prompt cache keeps growing in long sessions. Only the newest user message or tool result is marked for caching, as in Pi's Anthropic provider; before, every one was marked, the cache stopped growing after the first few requests, and the rest of the conversation was sent uncached each time.
- Sessions that share one Pi model runtime, such as in-process subagents, each keep their own Devin runs. Before, the session that started last received every session's Devin requests; when it ended, the other sessions' requests failed with "The Devin provider shut down.", and its own first request could fail with "No Devin model list matches the current account and endpoint."

## [0.1.14] - 2026-11-07

### Improved

- Update Effect and the bundled `@effect/platform-node` to 4.1.2.

## [0.1.13] - 2026-11-02

### New

- Pi 1.5.0 and later show what changed in this package after you update it.

### Improved

- Modules that only declare types or are used only by the development CLI are no longer included in the package.

## [0.1.12] - 2026-11-02

### Improved

- The package is about five times smaller (1.6 MB to 0.34 MB compressed). The bundled Node platform packages now carry only the JavaScript files this package loads, without type declarations, source maps, documentation, or the unused `undici` HTTP client.

## [0.1.11] - 2026-11-02

### Fixed

- Updating from 0.1.7 or 0.1.8 no longer leaves Pi unable to start with `Cannot find module '…/effect/dist/process/CommandLine.js'`. Those versions left a newer `@effect/platform-node-shared` in Pi's package folder, which 0.1.10 still picked up. The package now ships `@effect/platform-node` and `@effect/platform-node-shared` inside itself, so they always use this package's own `effect`, whatever other packages or earlier versions installed.

## [0.1.10] - 2026-11-02

### Fixed

- Pi starts again after installing or updating this package. 0.1.9 still failed with `Cannot find module '…/effect/dist/process/CommandLine.js'` when other packages had installed `effect` 4.0.7, because Pi installs packages without solving peer dependencies. `effect` and its Node platform packages now stay on 4.0.7 together with the other packages, and `@effect/platform-node-shared` is pinned to that version.

## [0.1.9] - 2026-11-02

### Fixed

- Pi no longer fails to start with `Cannot find module '…/effect/dist/process/CommandLine.js'` after installing or updating this package. `effect` and `@effect/platform-node` are updated to 4.1.2, so npm no longer installs a newer `@effect/platform-node-shared` that the bundled `effect` cannot load.

## [0.1.8] - 2026-11-01

### Fixed

- Subagents started in the background (for example pi-subagents async runs) no longer fail at random with `Model "devin/…" not found` when the Devin model list is restored from the saved cache.

## [0.1.7] - 2026-10-29

### Improved

- Update Effect and `@effect/platform-node` to 4.0.7 and adapt the HTTP response wrapper to the updated API.

## [0.1.6] - 2026-10-25

### Improved

- Pi no longer limits how many model requests one user message may send. Before, a message stopped with `Used all 8 Devin model HTTP requests in the budget.` after 8 requests by default, counting tool follow-ups, retries and auto-compaction. `PI_DEVIN_MAX_MODEL_CALLS` is removed and ignored, and `/devin` no longer shows the run budget. Sessions saved by earlier versions keep working. The `--max-model-calls` option of the bundled CLI is unchanged.

### Fixed

- Devin requests no longer fail when Pi's `retry.provider.maxRetries` is not 0 or when `transport` is set to a WebSocket option for other providers. Devin ignores both preferences, as Pi expects from providers that do not support them.
- A long response that keeps streaming is no longer cut off when Pi's request timeout (300 seconds by default) passes. The request now fails only after that long without any data.
- Rate limits and server errors that come with an error body (for example `resource_exhausted` with HTTP 429, or `internal`) are now retried by Pi's automatic retry. Quota and billing errors are still not retried.
- When a response hits the output limit while calling tools, or calls a tool with arguments that are not valid JSON, Pi now tells the model and lets it call again instead of ending the turn with an error. Such calls are still never run.
- Switching to a model without image support no longer fails because of images earlier in the conversation; they are replaced with a note.
- A failed response that reused the ID of an earlier tool call no longer drops that earlier, successful tool result from the history sent to Devin.
- The extension now runs on Effect 4 internally. Requests, sign-in, model list refreshes, `/devin`, `/devin-fusion` and the Fusion sidekick behave as before. Installing the package now also installs its runtime dependencies `effect` and `@effect/platform-node`.
- The usage in the status line now appears only while a Devin model, including Devin Fusion, is selected, and disappears as soon as you switch to another provider's model. `/devin` still shows usage whichever model is selected.

## [0.1.5] - 2026-10-21

### Improved

- Pi checks the Devin login session again once a day instead of before every request, so Devin requests and model list refreshes no longer take Pi's shared `auth.json` lock and rewrite the file each time. Sessions saved by earlier versions keep working and are checked on their next use.
- Signing in again to the same Devin account lists its models at once instead of waiting for the list to download again. Another account still sees none of the previous account's models.
- The package now ships a Korean README (`README.ko.md`), and the README explains how to check a project-scoped installation.

### Fixed

- The status line and `/devin` now include the Devin quota used by subagents and the Fusion sidekick that share the Pi agent directory. Before, the quota changed only when the current Pi session itself sent a Devin request, so it stayed the same when Devin ran only in subagents.
- The status line's token totals now include the response that just finished. Before, they lagged one response behind during runs with tool calls.
- The quota in the status line now updates right after sign-in, sign-out and each account check instead of waiting for the next response.

## [0.1.4] - 2026-10-21

### Fixed

- A broken sidekick connection now fails its task without terminating the lead Pi. Calls cancelled before handoff no longer start sidekick work, including background calls.
- Waiting on an already-running background sidekick task no longer delivers the same report twice. Completed background tasks no longer accumulate delivery bookkeeping in long sessions.
- Sidekick report limits now include error reasons and notices on every delivery path. Saved full reports include the same status, error and report text as the delivered report.
- Requests no longer fail with "OAuth refresh failed for devin: connect ECONNREFUSED" when only the pre-request login check cannot reach the Devin server. The request is sent with the stored session, and a real outage reports the connection error itself.
- Model requests whose connection is refused, reset, times out or ends mid-response, and Devin `unavailable` or HTTP 502–504 errors, are now retried automatically by Pi.
- Several Pi sessions using Devin at once no longer wait on each other before every request. Requests could take 15–40 seconds and occasionally failed with "Credential store read failed for devin: Lock file is already being held".

## [0.1.3] - 2026-10-20

### Fixed

- Gemini models such as `gemini-4-argon` no longer fail with "There is an issue with this request, please try a different model" when a tool's parameter schema allows `null`, as `image_gen` does. Such tools stay available and are declared with a single parameter type, like Devin's own tools.
- Claude, Gemini and GPT models no longer fail complete responses with "stopReason cannot be treated as success" or "Tool calls and the stop reason do not match". Their tool calls now run in Pi, and their final answers are kept.

## [0.1.2] - 2026-10-20

- Requests no longer fail with "Devin does not support this tool's forced sampling format" when a tool such as `codemode` declares a grammar. The grammar hint is ignored and the tool's JSON schema is sent, as Pi's built-in providers without grammar tools do. Tools that require strict sampling are still rejected.

## [0.1.1] - 2026-10-20

- "Recommended models only" now keeps model families such as `swe-2` instead of listing fixed-level variants such as `swe-2-high`, so `/thinking` picks the level again.

## [0.1.0] - 2026-10-20

First release.

- Sign in to a Devin account with Pi's `/login` (OAuth). API keys are not used.
- Pick the Devin models the account can use in `/model` and the thinking level in `/thinking`. "Recommended models only" limits the list to the models Devin marks as Recommended.
- Devin Fusion (`fusion`): the lead model hands tasks to a sidekick model through the `devin_sidekick` tool. Choose the pair with `/devin-fusion`. The lead receives at most about 131,072 tokens of each sidekick report.
- `/devin` shows quota and session usage and changes display settings. Outside the TUI, settings change through arguments.
- Prompt cache: short by default. `PI_CACHE_RETENTION=long` is allowed only for models Devin marks with a 24-hour cache.
- The protocol schema ships as `.proto` sources in `proto/`, loaded directly at runtime.
