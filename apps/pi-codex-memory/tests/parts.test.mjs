import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import extension from "../dist/index.js";
import { EMPTY_SUMMARY, runPipeline } from "../dist/pipeline.js";
import { findRepository, observeRepository } from "../dist/repositories.js";
import { workspaceScope } from "../dist/safety.js";
import {
    currentSource,
    currentSources,
    ORIGIN_ENTRY,
    readSource,
    readSources,
} from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

const maxBytes = 256 * 1024 - 8192;
const signal = () => new AbortController().signal;
const settings = {
    ...DEFAULT_SETTINGS,
    useMemories: true,
    generateMemories: true,
    maxRolloutsPerRun: 8,
    extractModel: { provider: "fixture", id: "extract" },
    consolidateModel: { provider: "fixture", id: "consolidate" },
};
const assistant = (content) => ({
    role: "assistant",
    content:
        typeof content === "string"
            ? [{ type: "text", text: content }]
            : content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
});
async function directory(t) {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "pi-memory-parts-")),
    );
    const cwd = join(root, "work"),
        sessions = join(root, "sessions");
    await mkdir(cwd);
    await mkdir(sessions);
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, cwd, sessions };
}
/** A session whose cwd is outside Git, marked as an interactive conversation. */
function session(f) {
    const manager = SessionManager.create(f.cwd, f.sessions);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
    });
    const user = (content) =>
        manager.appendMessage({ role: "user", content, timestamp: Date.now() });
    const reply = (content) => manager.appendMessage(assistant(content));
    const compact = () =>
        manager.appendCompaction(
            "Generated summary.",
            manager.getLeafId(),
            1000,
        );
    return { manager, user, reply, compact };
}
/** Assistant text large enough that two such turns exceed one part. */
const long = (label) => `${label} ${"detail ".repeat((150 * 1024) / 7)}`;
/** Assistant text larger than one part. */
const huge = (label) => `${label} ${"detail ".repeat((260 * 1024) / 7)}`;
/** Writes the session's entries under another session ID, as a fork copies them. */
async function fork(f, manager, id) {
    const path = join(f.sessions, `fork_${id}.jsonl`);
    await writeFile(
        path,
        `${[{ ...manager.getHeader(), id }, ...manager.getEntries()]
            .map((value) => JSON.stringify(value))
            .join("\n")}\n`,
    );
    return path;
}
function fixtureModel(requests) {
    return {
        async complete(request) {
            requests.push(request);
            const input = JSON.parse(request.input);
            return {
                text: JSON.stringify(
                    request.stage === "extraction"
                        ? {
                              rollout_summary: `Recorded decisions: ${[
                                  ...input.rendered_conversation.matchAll(
                                      /DECISION_\w+/g,
                                  ),
                              ]
                                  .map((match) => match[0])
                                  .join(", ")}.`,
                              rollout_slug: "decisions",
                          }
                        : {
                              memory_summary:
                                  EMPTY_SUMMARY +
                                  input.documents
                                      .map(
                                          (document) =>
                                              `- ${document.path} — decisions`,
                                      )
                                      .join("\n"),
                          },
                ),
            };
        },
    };
}

test("a session file over the former 16 MiB limit is read; images and thinking never reach extraction", async (t) => {
    const f = await directory(t),
        s = session(f);
    s.user("DECISION_GATE: keep the release gate amber.");
    s.manager.appendMessage(
        assistant([
            { type: "toolCall", id: "shot", name: "screenshot", arguments: {} },
        ]),
    );
    s.manager.appendMessage({
        role: "toolResult",
        toolCallId: "shot",
        toolName: "screenshot",
        content: [
            { type: "text", text: "SCREENSHOT_CAPTION" },
            {
                type: "image",
                data: "A".repeat(17 * 1024 * 1024),
                mimeType: "image/png",
            },
        ],
        details: { raw: "B".repeat(1024 * 1024) },
        isError: false,
        timestamp: Date.now(),
    });
    s.manager.appendMessage(
        assistant([
            { type: "thinking", thinking: "THINKING_ONLY" },
            { type: "text", text: "The gate stays amber." },
        ]),
    );
    const file = s.manager.getSessionFile();
    assert.ok((await stat(file)).size > 17 * 1024 * 1024);
    const source = await readSource(file, maxBytes, signal(), true);
    assert.ok(source);
    assert.match(source.text, /DECISION_GATE/);
    assert.match(source.text, /SCREENSHOT_CAPTION/);
    assert.match(source.text, /The gate stays amber/);
    assert.doesNotMatch(source.text, /AAAA|BBBB|THINKING_ONLY/);
    assert.equal(
        source.id,
        s.manager.getSessionId(),
        "one part keeps the session ID",
    );
    assert.equal(source.part, undefined);
    assert.equal(
        source.fingerprint,
        currentSource(s.manager, maxBytes).fingerprint,
        "dropping unread content does not change what extraction sees",
    );
});

test("a long conversation splits at compactions into parts whose earlier boundaries and IDs stay put; a fork shares closed parts", async (t) => {
    const f = await directory(t),
        s = session(f);
    for (const index of [0, 1, 2]) {
        s.user(`DECISION_${index}`);
        s.reply(long(`Reply ${index}.`));
        s.compact();
    }
    s.user("DECISION_LATEST");
    s.reply("Short reply.");
    const before = currentSources(s.manager, maxBytes);
    assert.deepEqual(
        before.map((source) => source.part),
        [
            { number: 3, isLatest: true },
            { number: 2, isLatest: false },
            { number: 1, isLatest: false },
        ],
        "latest part first",
    );
    assert.match(before[2].text, /DECISION_0/);
    assert.doesNotMatch(before[2].text, /DECISION_1/);
    assert.match(before[0].text, /DECISION_2[\s\S]*DECISION_LATEST/);
    for (const source of before) {
        assert.equal(source.sessionId, s.manager.getSessionId());
        assert.match(source.id, /^part-[a-f0-9]{32}$/);
        assert.deepEqual(
            source.partIds,
            [...before].reverse().map((item) => item.id),
        );
    }
    const disk = await readSources(
        s.manager.getSessionFile(),
        maxBytes,
        signal(),
        {
            requireOrigin: true,
        },
    );
    assert.deepEqual(
        disk.map((source) => [source.id, source.fingerprint]),
        before.map((source) => [source.id, source.fingerprint]),
    );

    s.user("DECISION_MORE");
    s.reply(long("Reply 3."));
    const after = currentSources(s.manager, maxBytes);
    assert.equal(
        after.length,
        4,
        "the latest part closed when it outgrew one input",
    );
    assert.deepEqual(
        after.slice(2).map((source) => [source.id, source.fingerprint]),
        before.slice(1).map((source) => [source.id, source.fingerprint]),
        "closed parts are unchanged",
    );
    assert.notEqual(
        after[1].id,
        before[0].id,
        "the closed part is keyed by its boundaries",
    );
    assert.deepEqual(after[1].part, { number: 3, isLatest: false });
    assert.match(after[0].text, /DECISION_MORE/);

    const forked = await readSources(
        await fork(f, s.manager, "fork-session"),
        maxBytes,
        signal(),
        { requireOrigin: true },
    );
    assert.deepEqual(
        forked.slice(1).map((source) => source.id),
        after.slice(1).map((source) => source.id),
        "a fork shares the closed parts it copied",
    );
    assert.notEqual(
        forked[0].id,
        after[0].id,
        "each session keeps its own latest part",
    );
    assert.equal(forked[0].sessionId, "fork-session");
});

test("closing the latest part replaces its memory; forgetting a part excludes the session, retention only the part", async (t) => {
    const f = await directory(t),
        s = session(f),
        store = new MemoryStore(join(f.root, "memory")),
        scope = workspaceScope(f.cwd),
        requests = [];
    t.after(() => store.close());
    store.saveSettings(scope, settings);
    const run = (sources) =>
        runPipeline({
            store,
            scope,
            settings,
            model: fixtureModel(requests),
            sources,
            force: true,
            signal: signal(),
        });
    s.user("DECISION_FIRST");
    s.reply("Noted.");
    assert.equal((await run(currentSources(s.manager, maxBytes))).extracted, 1);
    assert.deepEqual(
        store.records(scope).map((record) => record.id),
        [s.manager.getSessionId()],
    );

    s.compact();
    s.user("DECISION_SECOND");
    s.reply(huge("Reply."));
    const parts = currentSources(s.manager, maxBytes);
    assert.equal(parts.length, 2);
    assert.equal((await run(parts)).extracted, 2);
    const records = store.records(scope);
    assert.deepEqual(
        records.map((record) => record.id).sort(),
        parts.map((source) => source.id).sort(),
        "the whole-session memory gave way to its parts",
    );
    const first = records.find((record) => record.id === parts[1].id);
    assert.match(first.body, /DECISION_FIRST/);
    assert.doesNotMatch(first.body, /DECISION_SECOND/);
    assert.match(
        store.document(first),
        new RegExp(`^thread_id: ${s.manager.getSessionId()}\\n`),
    );
    assert.match(store.document(first), /\nconversation_part: 1\n/);
    const envelope = JSON.parse(
        requests.find((request) => request.input.includes("DECISION_SECOND"))
            .input,
    );
    assert.equal(envelope.source_thread_id, s.manager.getSessionId());
    assert.deepEqual(
        { ...envelope.conversation_part, warning: undefined },
        { number: 2, is_latest: true, warning: undefined },
    );

    store.setRetention(scope, first.path, false, Date.now() + 1000);
    store.prune(scope, settings, Date.now() + 2000);
    assert.equal(store.isSourceExcluded(scope, parts[1]), true);
    assert.equal(
        store.isSourceExcluded(scope, parts[0]),
        false,
        "an expired part does not stop the rest of its session",
    );
    const latest = store
        .records(scope)
        .find((record) => record.id === parts[0].id);
    store.revise(scope, latest.path, null);
    s.user("DECISION_AFTER_FORGET");
    const later = currentSources(s.manager, maxBytes);
    assert.equal(
        store.isSourceExcluded(scope, later[0]),
        true,
        "forgetting excludes the conversation",
    );
    assert.equal((await run(later)).extracted, 0);
});

test("a repository binding attached to a conversation under way covers what follows; manual runs also take the earlier part", async (t) => {
    const f = await directory(t);
    const repo = join(f.root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(repo, ".git", "config"), "[core]\nbare = false\n");
    const { scope } = findRepository(repo);
    const manager = SessionManager.create(repo, f.sessions);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
    });
    manager.appendMessage({
        role: "user",
        content: "DECISION_EARLIER",
        timestamp: Date.now(),
    });
    manager.appendMessage(assistant("Noted."));
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
        repository: observeRepository(repo, "attached"),
    });
    manager.appendMessage({
        role: "user",
        content: "DECISION_LATER",
        timestamp: Date.now(),
    });
    manager.appendMessage(assistant("Noted again."));
    const file = manager.getSessionFile();
    const scheduled = await readSources(file, maxBytes, signal(), {
        requireOrigin: true,
        expectedScope: scope,
    });
    assert.equal(scheduled.length, 1);
    assert.match(scheduled[0].text, /DECISION_LATER/);
    assert.doesNotMatch(scheduled[0].text, /DECISION_EARLIER/);
    assert.equal(scheduled[0].repository.binding, "attached");
    assert.deepEqual(scheduled[0].part, { number: 2, isLatest: true });
    const manual = await readSources(file, maxBytes, signal(), {
        requireOrigin: true,
        requireBinding: false,
        expectedScope: scope,
    });
    assert.deepEqual(
        manual.map((source) => source.repository.binding),
        ["attached", "current_location"],
    );
    assert.match(manual[1].text, /DECISION_EARLIER/);
});

test("session start binds a conversation memory first sees in a repository from that point on", async (t) => {
    const f = await directory(t);
    const repo = join(f.root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(repo, ".git", "config"), "[core]\nbare = false\n");
    const previous = process.env.PI_CODING_AGENT_DIR;
    await mkdir(join(f.root, "agent"));
    process.env.PI_CODING_AGENT_DIR = join(f.root, "agent");
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const start = async (manager) => {
        const handlers = new Map(),
            appended = [];
        extension({
            registerTool() {},
            registerCommand() {},
            on: (name, handler) => handlers.set(name, handler),
            appendEntry: (customType, data) =>
                appended.push({ customType, data }),
            sendMessage() {},
        });
        await handlers.get("session_start")(
            {},
            {
                cwd: repo,
                mode: "tui",
                hasUI: false,
                ui: { notify() {}, setStatus() {} },
                sessionManager: manager,
                modelRegistry: {
                    getAvailable: () => [],
                    find: () => undefined,
                },
                isIdle: () => true,
            },
        );
        await handlers.get("session_shutdown")?.();
        return appended.map((entry) => entry.data.repository?.binding);
    };
    const history = (origin) => {
        const manager = SessionManager.inMemory(repo);
        if (origin) manager.appendCustomEntry(ORIGIN_ENTRY, origin);
        manager.appendMessage({
            role: "user",
            content: "Earlier work.",
            timestamp: Date.now(),
        });
        manager.appendMessage(assistant("Noted."));
        return manager;
    };
    assert.deepEqual(await start(SessionManager.inMemory(repo)), [
        "session_start",
    ]);
    assert.deepEqual(
        await start(history()),
        ["attached"],
        "history before memory saw it",
    );
    assert.deepEqual(
        await start(history({ version: 3, isInteractiveRoot: true })),
        ["attached"],
        "an unbound conversation, or a fork of one",
    );
    assert.deepEqual(
        await start(
            history({
                version: 3,
                isInteractiveRoot: true,
                repository: observeRepository(repo, "session_start"),
            }),
        ),
        [],
        "a bound conversation is left as it is",
    );
});
