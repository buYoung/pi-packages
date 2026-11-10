# Changelog

## [Unreleased]

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
