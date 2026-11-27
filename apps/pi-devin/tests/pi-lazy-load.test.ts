import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, normalizeContext, type Model, type ModelsPublication, type ModelsStoreEntry, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { makeLazyProvider } from "../src/pi/adapters/pi/lazy-provider.ts";
import { fileDisplaySettings, fileFusionSettings } from "../src/pi/adapters/storage/files.ts";
import { devinSettingsPath, fusionSettingsPath } from "../src/pi/adapters/storage/settings-files.ts";
import type { DevinModel, FusionSelection } from "../src/pi/features/catalog/types.ts";
import { DEVIN_STATE_ENTRY } from "../src/pi/features/runs/entry.ts";
import { makeTestProvider, registerLazyTestExtension, type TestOptions } from "./extension-harness.ts";
import { finalFrames, streamResponse } from "./helpers.ts";
import { providerCredential, providerFixture, providerHostCredential } from "./provider-fixture.ts";

let agentDir: string;
beforeEach(async () => { agentDir = await mkdtemp(join(tmpdir(), "pi-devin-lazy-")); });
afterEach(async () => { await rm(agentDir, { recursive: true, force: true }); });

const fixture = await providerFixture({ chat: () => streamResponse(finalFrames("done")) });
fixture.shutdown();
const settingsFiles = (): TestOptions => ({ fusionSettings: fileFusionSettings(fusionSettingsPath(agentDir)), devinSettings: fileDisplaySettings(devinSettingsPath(agentDir)) });
const writeSetting = async (path: string, value: unknown) => {
  await mkdir(join(agentDir, "pi-devin"), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

/** What a loaded instance stores after a catalog fetch and the list it shows, built from the files in `agentDir`. */
async function storedByLoadedInstance(options: TestOptions = {}) {
  const opened = makeTestProvider({ ...fixture.dependencies, ...settingsFiles(), ...options });
  let stored: ModelsStoreEntry | undefined;
  await opened.provider.refreshModels({ credential: providerHostCredential, allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async (publication) => { if (publication.persist) stored = publication.persist; publication.update?.(); return true; } });
  const shown = opened.provider.getModels();
  opened.shutdown();
  return { stored: stored!, shown };
}

/** The provider an unloaded instance registers, whose loads the test counts and refuses. */
function coldProvider() {
  let loads = 0;
  const lazy = makeLazyProvider({ load: async () => { loads++; throw new Error("The test does not load the runtime."); }, isLoading: () => false, agentDir: () => agentDir, now: Date.now });
  const refresh = async (context: Partial<RefreshModelsContext>) => {
    const published: ModelsPublication[] = [];
    const outcome = await lazy.provider.refreshModels({ allowNetwork: false, signal: new AbortController().signal, credential: providerHostCredential, ...context,
      publish: async (publication) => { published.push(publication); publication.update?.(); return true; } }).then(() => "answered", () => "loaded");
    return { outcome, published };
  };
  return { provider: lazy.provider, refresh, loads: () => loads };
}

test("before it loads, the provider lists exactly what a loaded instance shows for a list it stored, and filters and authorizes requests the same way", async () => {
  await writeSetting(fusionSettingsPath(agentDir), { schemaVersion: 1, leadID: "swe-2", sidekickID: "swe-2-medium" });
  const { stored, shown } = await storedByLoadedInstance();
  expect(shown.some((model) => model.id === "fusion")).toBe(true);
  const cold = coldProvider();
  expect((await cold.refresh({ stored })).outcome).toBe("answered");
  expect(cold.provider.getModels()).toStrictEqual(shown);
  expect(cold.provider.filterModels!(cold.provider.getModels(), providerHostCredential)).toStrictEqual(shown);
  expect(cold.provider.filterModels!(cold.provider.getModels(), { ...providerHostCredential, access: "devin-session-token$another" })).toStrictEqual([]);
  expect(cold.provider.filterModels!(cold.provider.getModels(), { type: "api_key", key: "not-oauth" })).toStrictEqual([]);
  expect(await cold.provider.auth.oauth!.toAuth(providerHostCredential)).toStrictEqual({ apiKey: providerCredential.sessionToken, baseUrl: providerCredential.apiServerURL });
  // A fresh list needs no lookup, so a network refresh is answered too.
  expect((await cold.refresh({ stored: { ...stored, checkedAt: Date.now() }, allowNetwork: true })).outcome).toBe("answered");
  expect(cold.loads()).toBe(0);
});

test("before it loads, the provider lists nothing without a list it can restore, as a loaded instance does", async () => {
  const { stored } = await storedByLoadedInstance();
  const anotherSession = { ...providerHostCredential, access: "devin-session-token$another-session" };
  const edited: ModelsStoreEntry = { ...stored, models: stored.models.map((model, index) => index === 1 ? { ...model, devin: { ...(model as DevinModel).devin, scope: "edited" } } : model) };
  for (const context of [{ credential: undefined, stored }, { credential: { type: "api_key" as const, key: "not-oauth" }, stored }, { credential: anotherSession, stored }, { stored: edited }, { stored: undefined }]) {
    const cold = coldProvider();
    expect((await cold.refresh(context)).outcome).toBe("answered");
    expect(cold.provider.getModels()).toStrictEqual([]);
    expect(cold.loads()).toBe(0);
    const loaded = makeTestProvider({ ...fixture.dependencies, ...settingsFiles() });
    await loaded.provider.refreshModels({ credential: providerHostCredential, allowNetwork: false, signal: new AbortController().signal, ...context, publish: async (publication) => { publication.update?.(); return true; } }).catch(() => {});
    expect(loaded.provider.getModels()).toStrictEqual([]);
    loaded.shutdown();
  }
});

test("the provider loads the runtime for a stored list it cannot vouch for, a credential it would reject, or a lookup the catalog would make", async () => {
  const { stored } = await storedByLoadedInstance();
  const byChild = (await storedByLoadedInstance({ isFusionChild: true })).stored;
  const otherVersion: ModelsStoreEntry = { ...stored, models: stored.models.map((model) => ({ ...model, devin: { ...(model as DevinModel).devin, storedBy: { version: "0.0.0", fusion: null } } })) };
  const cases: [string, Partial<RefreshModelsContext>, (() => Promise<void>)?][] = [
    ["stored by the sidekick child, without the Fusion entry", { stored: byChild }],
    ["stored by another package version", { stored: otherVersion }],
    ["another endpoint configured for the provider", { stored, baseUrl: "https://other.invalid" }],
    ["an OAuth credential the catalog rejects", { stored, credential: { ...providerHostCredential, devin: { version: 2 } } }],
    ["the recommended-only filter on", { stored }, () => writeSetting(devinSettingsPath(agentDir), { schemaVersion: 1, recommendedOnly: true, showUsageStatus: false })],
    ["unreadable display settings", { stored }, () => writeSetting(devinSettingsPath(agentDir), "{")],
    ["another Fusion choice saved since", { stored }, () => writeSetting(fusionSettingsPath(agentDir), { schemaVersion: 1, leadID: "swe-2", sidekickID: "swe-2-high" } satisfies FusionSelection & { schemaVersion: 1 })],
    ["a stale list on a network refresh", { stored: { ...stored, checkedAt: Date.now() - 10 * 60_000 }, allowNetwork: true }],
    ["a forced network refresh", { stored: { ...stored, checkedAt: Date.now() }, allowNetwork: true, force: true }],
    ["no list on a network refresh", { stored: undefined, allowNetwork: true }],
  ];
  for (const [label, context, prepare] of cases) {
    await rm(join(agentDir, "pi-devin"), { recursive: true, force: true });
    await prepare?.();
    const cold = coldProvider();
    expect((await cold.refresh(context)).outcome, label).toBe("loaded");
    expect(cold.loads(), label).toBe(1);
  }
  const cold = coldProvider();
  await expect(cold.provider.auth.oauth!.toAuth({ ...providerHostCredential, refresh: "unexpected" })).rejects.toThrow("The test does not load the runtime.");
  await expect(cold.provider.auth.oauth!.refresh(providerHostCredential, new AbortController().signal)).rejects.toThrow("The test does not load the runtime.");
  const result = await cold.provider.streamSimple(fixture.model, normalizeContext({ messages: [] }), { apiKey: providerCredential.sessionToken }).result();
  expect([result.stopReason, result.errorMessage]).toStrictEqual(["error", "The test does not load the runtime."]);
  expect(cold.loads()).toBe(3);
});

/** One model runtime on shared stores, as one Pi process; sessions load the extension as Pi's entry point does. */
async function lazyRuntime(stores: { credentials: InMemoryCredentialStore; modelsStore: InMemoryModelsStore }, directory: string) {
  const runtime = await ModelRuntime.create({ ...stores, modelsPath: join(directory, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const settings = SettingsManager.inMemory({ defaultProjectTrust: "never", cacheWarming: "off", compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
  const registrations: ReturnType<typeof registerLazyTestExtension>[] = [], sessions: { dispose(): void }[] = [], errors: string[] = [];
  const open = async (model: Model<any> = fixture.model, seed?: (manager: SessionManager) => void) => {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: join(directory, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => { registrations.push(registerLazyTestExtension(pi, { ...fixture.dependencies, ...settingsFiles(), agentDir })); }] });
    await loader.reload();
    const manager = SessionManager.inMemory(directory);
    seed?.(manager);
    const { session } = await createAgentSession({ cwd: directory, agentDir: join(directory, "agent"), modelRuntime: runtime, model, thinkingLevel: "medium",
      settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: "all" });
    sessions.push(session);
    await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error.error); } });
    return { session, registration: registrations.at(-1)! };
  };
  const close = () => { for (const session of sessions) session.dispose(); };
  return { runtime, open, errors, close };
}

test("a Pi process that never uses Devin never loads the runtime but lists the same models; using Devin loads it and works as before", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-lazy-runtime-"));
  const stores = { credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() };
  await stores.credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-not-used" }));
  const first = await lazyRuntime(stores, directory);
  try {
    // A session on a Devin model loads at its start.
    const lead = await first.open();
    expect(lead.registration.loads()).toBe(1);
    await first.runtime.login("devin", "oauth", { notify: () => {}, prompt: async (prompt) => prompt.type === "select" ? "manual" : "ordinary-shared-code" });
    expect((await first.runtime.refresh({ providers: ["devin"], allowNetwork: true, force: true })).errors.size).toBe(0);
    const listed = first.runtime.getModels("devin"), available = await first.runtime.getAvailable("devin");
    expect(listed.length).toBeGreaterThan(0);

    // Another Pi process restores the stored list without loading.
    const second = await lazyRuntime(stores, directory);
    const other = second.runtime.getModels("anthropic")[0];
    const idle = await second.open(other);
    await second.runtime.refresh({ providers: ["devin"], allowNetwork: false });
    expect(idle.registration.loads()).toBe(0);
    expect(second.runtime.getModels("devin")).toStrictEqual(listed);
    expect(await second.runtime.getAvailable("devin")).toStrictEqual(available);
    // A session with a Devin run state loads at its start; so does switching to a Devin model.
    const resumed = await second.open(other, (manager) => { manager.appendCustomEntry(DEVIN_STATE_ENTRY, { version: 99 }); });
    expect(resumed.registration.loads()).toBe(1);
    expect(second.errors.some((error) => /state/i.test(error))).toBe(true);
    await idle.session.setModel(second.runtime.getModels("devin").find((model) => model.id === fixture.model.id)!);
    expect(idle.registration.loads()).toBe(1);

    await idle.session.prompt("hi");
    const last = idle.session.messages.at(-1);
    expect(last?.role === "assistant" && last.stopReason !== "error" ? idle.session.getLastAssistantText() : last).toBe("done");
    expect(second.runtime.getModels("devin")).toStrictEqual(listed);
    second.close();
  } finally {
    first.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("run events of a session before the runtime loads are replayed, so a compaction that loads it is still auxiliary", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-devin-lazy-runtime-"));
  const stores = { credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore() };
  await stores.credentials.modify("anthropic", async () => ({ type: "api_key", key: "sk-ant-not-used" }));
  const opened = await lazyRuntime(stores, directory);
  try {
    const idle = await opened.open(opened.runtime.getModels("anthropic")[0]);
    await idle.session.extensionRunner.emit({ type: "session_before_compact", reason: "threshold" } as never);
    expect(idle.registration.loads()).toBe(0);
    const instance = await idle.registration.registration.load();
    expect(instance.isInAuxiliaryPhase()).toBe(true);
    await idle.session.extensionRunner.emit({ type: "session_compact", reason: "threshold" } as never);
    expect(instance.isInAuxiliaryPhase()).toBe(false);
    expect(opened.errors).toStrictEqual([]);
  } finally {
    opened.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("loading the extension imports no Effect, Node platform or protobuf module until first use", { timeout: 30_000 }, async () => {
  const script = `
    import { registerHooks } from "node:module";
    const heavy = [];
    registerHooks({ load(url, context, next) { if (/\\/node_modules\\/(effect|@effect\\/platform-node(-shared)?|protobufjs)\\//.test(url)) heavy.push(url); return next(url, context); } });
    const { default: devin } = await import(process.env.ENTRY);
    const providers = [], tools = [], commands = [];
    await devin({ registerProvider: (provider) => providers.push(provider), registerTool: (tool) => tools.push(tool.name), registerCommand: (name) => commands.push(name),
      on: () => () => {}, getActiveTools: () => [], setActiveTools: () => {} });
    const provider = providers[0];
    await provider.refreshModels({ credential: undefined, allowNetwork: false, signal: new AbortController().signal, publish: async (publication) => { publication.update?.(); return true; } });
    const listed = provider.getModels().length;
    const before = heavy.length;
    await provider.auth.oauth.refresh({ type: "oauth", access: "x", refresh: "", expires: 0 }).catch(() => {});
    console.log(JSON.stringify({ before, after: heavy.length, providers: providers.length, tools, commands, listed }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: agentDir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ENTRY: new URL("../index.ts", import.meta.url).href } });
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(result).toMatchObject({ before: 0, providers: 1, tools: ["devin_sidekick"], commands: ["devin", "devin-fusion"], listed: 0 });
  expect(result.after).toBeGreaterThan(0);
});
