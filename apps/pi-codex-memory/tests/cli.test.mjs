import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../dist/config.js";
import { workspaceScope } from "../dist/safety.js";
import { ORIGIN_ENTRY } from "../dist/sources.js";
import { MemoryStore } from "../dist/store.js";

const script = fileURLToPath(
    new URL("../scripts/create-memory.mjs", import.meta.url),
);
// A model provider extension that answers memory requests without a network.
const provider = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function (pi) {
    pi.registerProvider("memory-cli-fixture", {
        baseUrl: "http://unused.invalid",
        api: "openai-completions",
        apiKey: "synthetic",
        models: [{ id: "local", name: "Fixture", reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 400000, maxTokens: 4096 }],
        streamSimple(model, context) {
            const user = context.messages.findLast((message) => message.role === "user");
            const input = JSON.parse(typeof user.content === "string"
                ? user.content
                : user.content.map((part) => part.text ?? "").join(""));
            const reply = "rendered_conversation" in input
                ? { rollout_summary: "The user kept the release gate amber.", rollout_slug: "release-gate" }
                : { memory_summary: "v1\\n## User Profile\\n\\n## User preferences\\n\\n## General Tips\\n\\n## What's in Memory\\n" +
                    input.documents.map((document) => "- " + document.path + " — release gate").join("\\n") };
            const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(reply) }],
                api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
                stream.push({ type: "start", partial: message });
                stream.push({ type: "done", reason: "stop", message });
                stream.end(message);
            });
            return stream;
        },
    });
}
`;

test("create-memory turns one session file into memory with its scope's settings and Pi's model providers, even while memory is off there", async (t) => {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), "pi-memory-cli-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent"),
        cwd = join(root, "work"),
        sessions = join(root, "sessions");
    await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(sessions)]);
    await writeFile(join(root, "provider.mjs"), provider);
    await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ extensions: [join(root, "provider.mjs")] }),
    );
    const manager = SessionManager.create(cwd, sessions);
    manager.appendCustomEntry(ORIGIN_ENTRY, {
        version: 3,
        isInteractiveRoot: true,
    });
    manager.appendMessage({
        role: "user",
        content: "Keep the release gate amber.",
        timestamp: Date.now(),
    });
    manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Kept amber." }],
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
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
    });
    const scope = workspaceScope(cwd);
    const run = () =>
        spawnSync(process.execPath, [script, manager.getSessionFile()], {
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: agentDir,
                PI_OFFLINE: "1",
                INIT_CWD: root,
            },
            encoding: "utf8",
        });
    const store = new MemoryStore(join(agentDir, "pi-codex-memory"));
    t.after(() => store.close());
    store.saveSettings(scope, {
        // Memory stays off: the script runs anyway.
        ...DEFAULT_SETTINGS,
        extractModel: { provider: "memory-cli-fixture", id: "local" },
        consolidateModel: { provider: "memory-cli-fixture", id: "local" },
    });
    const created = run();
    assert.equal(created.status, 0, created.stderr);
    assert.match(
        created.stdout,
        /1 part\(s\) from the last 7 day\(s\), 1 to create/,
    );
    assert.match(created.stdout, /Part 1: extracted\./);
    assert.match(created.stdout, /Summary updated\./);
    const records = store.records(scope);
    assert.deepEqual(
        records.map((record) => record.id),
        [manager.getSessionId()],
    );
    assert.match(records[0].body, /release gate amber/);
    assert.match(store.state(scope).summary, /release gate/);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(
        again.stdout,
        /0 to create/,
        "an unchanged session is not made again",
    );
    assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
