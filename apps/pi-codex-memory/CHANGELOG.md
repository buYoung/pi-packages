# Changelog

## [Unreleased]

### New

- In a clone of the repository, `pnpm --filter @buyong/pi-codex-memory create-memory <session-file>` turns one session file into memory with the settings and models of its memory scope, whether memory is on or off there.
- In `/codex-memory-settings`, **Stop a model call after** sets how long one memory or summary request may run: 2, 5 or 10 minutes.

### Improved

- **BREAKING:** The memory database moves to version 2 the first time this version opens it, and earlier versions refuse to open it from then on. They split no session into parts and keep only the memories that fit in one summary request, so a Pi session running one would rewrite the summaries this version builds. A session that was already open keeps the version it loaded, so restart every open Pi session or run `/reload` in it after updating. Going back to an earlier version needs a new memory database.
- The memory prompt now says that the length limit counts bytes and that Korean, Chinese and Japanese take 3 bytes per character, so memories in those languages are less likely to run past 9,000 bytes and lose their middle. The summary prompt says the same of its 10,000-byte limit, and each summary request states the size of the existing summary so the model shortens older entries instead of appending past the limit.
- A model call now stops after 10 minutes by default instead of 2, so a summary made with a slow model or a high thinking level can finish. A scope whose settings were saved before keeps 2 minutes until you change **Stop a model call after**.
- A conversation too long for one model call is split at its compactions into parts, and each part becomes its own memory. Before, the middle of such a conversation was cut to fit one call, so most of it was lost, and every continuation processed the whole conversation again. A part closed by a later compaction is now processed once, and a fork reuses the closed parts it copied.

### Fixed

- The summary now reflects every memory. Before, when the memories did not fit in one model call, the summary drew only on those that fit, and the rest never reached it. Now it is updated over several calls, newest conversations first, each building on the summary the one before produced.
- A memory that names a file by joining a folder and a file name the conversation mentions apart, as after `cd`, is no longer rejected as `ungrounded_identifier`. A path under a folder the conversation does not mention is still rejected, and the memory prompt now asks for each path in full instead of paths merged with braces or wildcards, which the check also rejects.
- Session files larger than 16 MiB, such as long conversations with many screenshots, now become memory. Before, they were skipped without notice. A session file is now read one line at a time and its images are dropped while reading, and a file with nothing left to process is not read again until it changes.
- In a repository, a conversation that memory first saw after it had begun, or a fork of one, now becomes memory from its next session start on. **Create memories now** also takes what it held before and counts it for the repository its folder belongs to now. Before, such a conversation never became memory.

## [0.2.0] - 2026-11-10

### New

- In `/codex-memory`, **Memory model** and **Summary model** pick a model and then its thinking level: **Default** or one of the levels that model offers. Each row shows the level it uses, such as `· high`.

### Improved

- **Use current Pi model** now also follows the Pi session's thinking level, moved to the nearest level the model offers. Before, it always used `low` for memories and `medium` for the summary. When thinking is off in the session, memory runs without reasoning too.
- Changing only the thinking level no longer asks again for consent to send conversations. Changing a model still does.
- An answer that cites a `thread_id` shown in the summary sent with that request now counts as using that memory, so a memory used only through the summary is not deleted as unused. These citations also count in the status bar's `cited`.

### Fixed

- Picking the model already in use no longer removes its thinking level, and the model list now opens on that model even when it has a level set.
- A memory deleted by **Delete unused memories after** no longer empties the summary. The next summary update removes only what that memory alone supported, and the memory is deleted once that update succeeds.

## [0.1.2] - 2026-11-02

### Improved

- The package now contains only the files Pi loads and is about half its previous size. Type declarations and source maps are no longer included, and the documentation and the Korean changelog are no longer included; they remain on GitHub.

## [0.1.1] - 2026-10-29

### Fixed

- Other bug fixes

## [0.1.0] - 2026-10-28

### New

- Extract and consolidate decisions and context from Pi conversations, then recall them with citations in later sessions. Turn memory on, choose its models and scope, and manage saved memories in `/codex-memory`; change timing and limits in `/codex-memory-settings`.
- Memory starts off, and turning it on asks for consent to send masked conversation copies. Memories and the summary each use the current Pi model or a model chosen from `/scoped-models`.
- Turn closed conversations into memory in the background: one open Pi session per scope runs up to 8 conversations at once, and another open session takes over when it closes. By default a conversation becomes memory 2 hours after its last message, the summary is updated at most every 2 hours, and conversations from the last 7 days are used. **Create memories now** in `/codex-memory` runs this without the wait, and every session in the scope shows running jobs in the status bar.
- Edit and forget memories without a model call; forgotten conversations do not produce memory again. Ask the agent to remember something, and it saves the text after you confirm.
- Share memory across subfolders and worktrees of one Git repository. Read another repository's memory with per-request confirmation or saved one-way access.
- Use original user messages as extraction input even after the conversation is compacted.
- Include the extension in the `@buyong/pi-codex` bundle.
