import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/state.ts";
import type { DevinSessionState } from "../src/pi/features/runs/types.ts";
import { registerTestExtension } from "./extension-harness.ts";
import { finalFrames, streamResponse } from "./helpers.ts";
import { providerFixture } from "./provider-fixture.ts";

test("sessions sharing a model runtime: each session's requests, compaction included, run on its own instance, also after the other one shut down", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-shared-"));
  const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("done")) });
  fixture.shutdown();
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(directory, "models.json"),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off",
    compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const agentDir = join(directory, "agent"), errors: string[] = [];
  const extensions: ReturnType<typeof registerTestExtension>[] = [];
  // Each session loads its own extension instance, as Pi's SDK does for a session that shares the host's model runtime.
  const open = async () => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { extensions.push(registerTestExtension(pi, fixture.dependencies)); }] });
    await loader.reload();
    const manager = SessionManager.inMemory(directory);
    const { session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, model: fixture.model, thinkingLevel: "medium",
      settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "all" });
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    const cascade = () => (manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY)
      .at(-1) as { data: DevinSessionState } | undefined)?.data.cascadeId;
    return { session, manager, cascade };
  };
  const chats = () => fixture.requests.filter((entry) => entry.method === CHAT_METHOD);
  const host = await open();
  try {
    await runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-shared-code" });
    expect((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0);
    await host.session.prompt("first");
    const hostCascade = host.cascade();
    expect(hostCascade).toBeTruthy();

    const subagent = await open();
    expect(runtime.getRegisteredNativeProvider("devin")).toBe(extensions[1].provider);
    // The subagent's first request may come before Pi restored its instance's model list.
    await subagent.session.prompt("hi");
    await host.session.prompt("second");
    await host.session.compact();
    expect(errors).toStrictEqual([]);
    const subagentCascade = subagent.cascade();
    expect(subagentCascade).toBeTruthy(); expect(subagentCascade).not.toBe(hostCascade);
    // The host's turns and its compaction, whose requests carry a new session ID, stay on the host's run state.
    const cascades = chats().map((entry) => entry.body.cascadeId);
    expect(cascades.slice(0, 3)).toStrictEqual([hostCascade, subagentCascade, hostCascade]);
    expect(cascades.length).toBeGreaterThan(3); expect(cascades.slice(3).every((cascade) => cascade === hostCascade)).toBe(true);
    expect(chats().slice(0, 3).map((entry) => entry.body.clientSessionId)).toStrictEqual([host.manager.getSessionId(), subagent.manager.getSessionId(), host.manager.getSessionId()]);

    // The host's next session start is no collision: the registered provider reaches the host's instance too.
    await host.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    expect(errors).toStrictEqual([]);

    await subagent.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    subagent.session.dispose();
    const before = chats().length;
    await host.session.prompt("third");
    expect(host.session.getLastAssistantText()).toBe("done");
    expect(chats().slice(before).map((entry) => entry.body.cascadeId)).toStrictEqual([hostCascade]);
    // Model list and sign-in calls of the subagent's provider, which Pi still holds, reach the host's instance.
    expect((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0);
    expect(runtime.getModels("devin").length).toBeGreaterThan(0);
  } finally {
    for (const extension of extensions) extension.shutdown();
    host.session.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
/**
 * A shared model runtime with a signed-in host session. With `modelsJson`, models.json configures devin, so Pi composes the
 * provider and checks its model list before each call.
 */
async function sharedRuntime({ modelsJson }: { modelsJson: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-shared-"));
  const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("done")) });
  fixture.shutdown();
  if (modelsJson) await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { devin: { modelOverrides: { [fixture.model.id]: { contextWindow: 100_000 } } } } }));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(directory, "models.json"),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", enableInstallTelemetry: false, cacheWarming: "off",
    compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const agentDir = join(directory, "agent"), errors: string[] = [], sessions: { dispose(): void }[] = [];
  const extensions: ReturnType<typeof registerTestExtension>[] = [];
  const open = async () => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { extensions.push(registerTestExtension(pi, fixture.dependencies)); }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, model: fixture.model, thinkingLevel: "medium",
      settingsManager: settings, sessionManager: SessionManager.inMemory(directory), resourceLoader: loader, noTools: "all" });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    return session;
  };
  /** The first session, signed in, with the catalog fetched and one answered request. */
  const openHost = async () => {
    const host = await open();
    await runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-shared-code" });
    expect((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0);
    await host.prompt("first");
    expect(host.getLastAssistantText()).toBe("done");
    return host;
  };
  const close = async () => {
    for (const extension of extensions) extension.shutdown();
    for (const session of sessions) session.dispose();
    await rm(directory, { recursive: true, force: true });
  };
  return { runtime, extensions, errors, open, openHost, close };
}

test("a session that joins a shared model runtime can use Devin before Pi restored its instance's model list, also when models.json configures devin", { timeout: 30_000 }, async () => {
  const shared = await sharedRuntime({ modelsJson: true });
  try {
    const host = await shared.openHost();
    const subagent = await shared.open();
    expect(shared.runtime.getRegisteredNativeProvider("devin")).toBe(shared.extensions[1].provider);
    // The subagent's instance has no list until Pi's refresh restores it; the registered provider still lists the host's.
    expect(shared.extensions[1].provider.getModels().length).toBeGreaterThan(0);
    await Promise.all([subagent.prompt("hi"), host.prompt("second")]);
    expect(shared.errors).toStrictEqual([]);
    expect(subagent.getLastAssistantText()).toBe("done");
    expect(host.getLastAssistantText()).toBe("done");
  } finally {
    await shared.close();
  }
});

test("sessions that join a shared model runtime together all get their model list, also the ones whose provider Pi replaced before its refresh", { timeout: 15_000 }, async () => {
  const shared = await sharedRuntime({ modelsJson: false });
  try {
    await shared.openHost();
    // Pi refreshes the provider registered last, so of two sessions registering together only the second one is refreshed by Pi.
    const subagents = await Promise.all([shared.open(), shared.open()]);
    await Promise.all(subagents.map((subagent, index) => subagent.prompt(`hi ${index}`)));
    expect(shared.errors).toStrictEqual([]);
    expect(subagents.map((subagent) => subagent.getLastAssistantText())).toStrictEqual(["done", "done"]);
  } finally {
    await shared.close();
  }
});
