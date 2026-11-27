import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import { catalogScope } from "../src/pi/features/catalog/scope.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/entry.ts";
import type { DevinSessionState } from "../src/pi/features/runs/types.ts";
import { registerTestExtension } from "./extension-harness.ts";
import { finalFrames, STATUS_METHOD, statusResponse, streamResponse, unaryResponse } from "./helpers.ts";
import { LOGIN_TOKEN_URL, providerCredential, providerFixture } from "./provider-fixture.ts";

/** The session token and user of a second Devin account, which `/login` returns once `switchAccount()` was called. */
const secondCredential = { ...providerCredential, sessionToken: "devin-session-token$mock-second-account-token" };

/**
 * One model runtime that sessions share, as in-process subagents do, each session loading its own extension instance.
 * With `modelsJson`, models.json configures `devin`, so Pi composes the registered provider and checks its list before each call.
 */
async function sharedRuntime(options: { modelsJson?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-shared-"));
  const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("done")) });
  fixture.shutdown();
  let isSecondAccount = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    if (isSecondAccount && String(url) === LOGIN_TOKEN_URL) return Response.json({ token: secondCredential.sessionToken });
    if (isSecondAccount && new URL(String(url)).pathname.slice(1) === STATUS_METHOD) {
      const status = statusResponse() as { userStatus: Record<string, unknown> };
      return unaryResponse(STATUS_METHOD, { userStatus: { ...status.userStatus, userId: "second-user-id" } });
    }
    return fixture.dependencies.fetch(url, init);
  };
  const dependencies = { ...fixture.dependencies, fetch: fetchImpl };
  if (options.modelsJson) {
    await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { devin: { modelOverrides: { [fixture.model.id]: { contextWindow: 100_000 } } } } }));
  }
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(directory, "models.json"),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", cacheWarming: "off",
    compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const agentDir = join(directory, "agent"), errors: string[] = [];
  const extensions: ReturnType<typeof registerTestExtension>[] = [];
  const sessions: { dispose(): void }[] = [];
  // Each session loads its own extension instance, as Pi's SDK does for a session that shares the host's model runtime.
  const open = async () => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { extensions.push(registerTestExtension(pi, dependencies)); }] });
    await loader.reload();
    const manager = SessionManager.inMemory(directory);
    const { session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, model: fixture.model, thinkingLevel: "medium",
      settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "all" });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    const cascade = () => (manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY)
      .at(-1) as { data: DevinSessionState } | undefined)?.data.cascadeId;
    /** The answer of the session's last turn, or its error. */
    const answer = () => {
      const last = session.messages.at(-1);
      return last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage : session.getLastAssistantText();
    };
    return { session, manager, cascade, answer };
  };
  const login = () => runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-shared-code" });
  const fetchModels = async () => { expect((await runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0); };
  /** The first session, signed in, with the catalog fetched and one answered turn. */
  const openHost = async () => {
    const host = await open();
    await login();
    await fetchModels();
    await host.session.prompt("first");
    expect(host.answer()).toBe("done");
    return host;
  };
  const chats = () => fixture.requests.filter((entry) => entry.method === CHAT_METHOD);
  const close = async () => {
    for (const extension of extensions) extension.shutdown();
    for (const session of sessions) session.dispose();
    await rm(directory, { recursive: true, force: true });
  };
  return { runtime, extensions, errors, open, openHost, login, fetchModels, chats, close, switchAccount: () => { isSecondAccount = true; } };
}

test("sessions sharing a model runtime: each session's requests, compaction included, run on its own instance, also after the other one shut down", { timeout: 30_000 }, async () => {
  const shared = await sharedRuntime();
  const { runtime, extensions, errors, chats } = shared;
  try {
    const host = await shared.openHost();
    const hostCascade = host.cascade();
    expect(hostCascade).toBeTruthy();

    const subagent = await shared.open();
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
    expect(host.answer()).toBe("done");
    expect(chats().slice(before).map((entry) => entry.body.cascadeId)).toStrictEqual([hostCascade]);
    // Model list and sign-in calls of the subagent's provider, which Pi still holds, reach the host's instance.
    await shared.fetchModels();
    expect(runtime.getModels("devin").length).toBeGreaterThan(0);
  } finally {
    await shared.close();
  }
});

test("of two sessions that join a shared model runtime together, the one whose provider Pi replaced before its refresh also gets the OAuth session and its list (#96)", { timeout: 30_000 }, async () => {
  const shared = await sharedRuntime();
  try {
    await shared.openHost();
    // Pi refreshes only the provider registered last, so of two sessions registering together only the second one is refreshed by Pi.
    const subagents = await Promise.all([shared.open(), shared.open()]);
    await Promise.all(subagents.map((subagent, index) => subagent.session.prompt(`hi ${index}`)));
    expect(shared.errors).toStrictEqual([]);
    expect(subagents.map((subagent) => subagent.answer())).toStrictEqual(["done", "done"]);
    for (const extension of shared.extensions) expect(extension.models().length).toBeGreaterThan(0);
  } finally {
    await shared.close();
  }
});

test("with a devin entry in models.json, a session that joins a shared model runtime does not stop Devin requests before Pi restored its list (#94)", { timeout: 30_000 }, async () => {
  const shared = await sharedRuntime({ modelsJson: true });
  try {
    const host = await shared.openHost();
    const subagent = await shared.open();
    expect(shared.runtime.getRegisteredNativeProvider("devin")).toBe(shared.extensions[1].provider);
    // Pi's composed provider dispatches only to a provider that lists a model of the call's API.
    expect(shared.extensions[1].provider.getModels().length).toBeGreaterThan(0);
    await Promise.all([subagent.session.prompt("hi"), host.session.prompt("second")]);
    expect(shared.errors).toStrictEqual([]);
    expect([subagent.answer(), host.answer()]).toStrictEqual(["done", "done"]);
  } finally {
    await shared.close();
  }
});

test("an account switch or logout reaches every instance of a shared model runtime and none exposes the old account's models", { timeout: 30_000 }, async () => {
  const shared = await sharedRuntime();
  const { extensions } = shared;
  const scopes = () => extensions.map((extension) => [...new Set(extension.models().map((model) => model.devin.scope))]);
  try {
    await shared.openHost();
    const subagent = await shared.open();
    await subagent.session.prompt("hi");
    expect(subagent.answer()).toBe("done");
    const firstScope = catalogScope(providerCredential), secondScope = catalogScope(secondCredential);
    expect(scopes()).toStrictEqual([[firstScope], [firstScope]]);

    // `/login` reaches only the registering instance; the others learn the new session from Pi's refreshes.
    shared.switchAccount();
    await shared.login();
    expect(scopes()).toStrictEqual([[], []]);
    expect(shared.runtime.getModels("devin")).toStrictEqual([]);
    await shared.fetchModels();
    expect(scopes()).toStrictEqual([[secondScope], [secondScope]]);
    // A session bound to the old account refuses to continue; a new one runs on the new account.
    await subagent.session.prompt("after the switch");
    expect(subagent.answer()).toBe("This Pi session is bound to a different Devin account or endpoint. Start a new session.");
    const next = await shared.open();
    await next.session.prompt("on the new account");
    expect(next.answer()).toBe("done");
    expect((shared.chats().at(-1)!.body.metadata as { apiKey?: string }).apiKey).toBe(secondCredential.sessionToken);
    expect(scopes()).toStrictEqual([[secondScope], [secondScope], [secondScope]]);

    await shared.runtime.logout("devin");
    expect(scopes()).toStrictEqual([[], [], []]);
    expect(shared.runtime.getModels("devin")).toStrictEqual([]);
    expect(shared.errors).toStrictEqual([]);
  } finally {
    await shared.close();
  }
});
