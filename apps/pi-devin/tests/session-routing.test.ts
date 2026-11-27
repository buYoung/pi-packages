import { expect, test } from "vitest";
import type { ModelsPublication, ModelsStoreEntry, OAuthCredential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { makeSessionRouting, type ProviderRegistry } from "../src/pi/adapters/pi/session-routing.ts";
import type { DevinProvider } from "../src/pi/adapters/pi/types.ts";
import type { DevinModel } from "../src/pi/features/catalog/types.ts";

const credential = { type: "oauth", access: "token", refresh: "", expires: 0 } as OAuthCredential;
const entry = (id: string): ModelsStoreEntry => ({ models: [{ id } as DevinModel], checkedAt: 1 });

/** An instance's own provider that records what reaches it and publishes what the test gives it. */
function instance(name: string, options: { models?: DevinModel[]; persist?: ModelsStoreEntry; toAuth?: () => Promise<{ apiKey: string }>; refreshError?: Error } = {}) {
  const refreshes: RefreshModelsContext[] = [], published: ModelsPublication[] = [], authorized: string[] = [];
  let models = options.models ?? [];
  const provider = {
    id: "devin", name: "Devin",
    auth: { oauth: { name: "Devin account", login: async () => credential, refresh: async () => credential,
      toAuth: async () => { authorized.push(name); return options.toAuth ? options.toAuth() : { apiKey: name }; } } },
    getModels: () => models,
    filterModels: (candidates: readonly DevinModel[]) => candidates,
    refreshModels: async (context: RefreshModelsContext) => {
      refreshes.push(context);
      if (options.refreshError) throw options.refreshError;
      const publication: ModelsPublication = { ...(options.persist && context.allowNetwork ? { persist: options.persist } : {}), update: () => { models = [{ id: name } as DevinModel]; } };
      published.push(publication);
      await context.publish(publication);
    },
    stream: () => { throw new Error("unused"); },
    streamSimple: () => { throw new Error("unused"); },
  } as unknown as DevinProvider;
  const routing = makeSessionRouting(provider, () => false);
  return { routing, refreshes, published, authorized, models: () => models };
}

/** A model runtime: the registry answers with the provider registered last. */
function runtime() {
  let registered: unknown;
  const registry: ProviderRegistry = { getRegisteredNativeProvider: () => registered };
  let sessions = 0;
  const register = (opened: ReturnType<typeof instance>) => { registered = opened.routing.provider; };
  const attach = (opened: ReturnType<typeof instance>) => { const id = `session-${++sessions}`; opened.routing.attach(() => id, registry); };
  return { register, attach };
}

/** Pi's refresh context, whose publications Pi accepts until `controller` aborts. */
function hostRefresh(options: { allowNetwork: boolean; stored?: ModelsStoreEntry; controller?: AbortController }) {
  const controller = options.controller ?? new AbortController();
  const accepted: ModelsPublication[] = [];
  const context: RefreshModelsContext = {
    credential, stored: options.stored, allowNetwork: options.allowNetwork, signal: controller.signal,
    publish: async (publication) => {
      if (controller.signal.aborted) return false;
      accepted.push(publication); publication.update?.();
      return true;
    },
  };
  return { context, accepted, controller };
}

test("a refresh reaches every attached instance of the registration; only the registering one stores, the others restore what it stored", async () => {
  const pi = runtime(), fetched = entry("fetched");
  const older = instance("older"), registering = instance("registering", { persist: fetched });
  pi.register(older); pi.register(registering); pi.attach(older); pi.attach(registering);
  const offline = hostRefresh({ allowNetwork: false, stored: entry("stored") });
  await registering.routing.provider.refreshModels(offline.context);
  expect(older.refreshes.map((context) => [context.allowNetwork, context.stored, context.credential])).toStrictEqual([[false, offline.context.stored, credential]]);

  const network = hostRefresh({ allowNetwork: true, stored: entry("stored") });
  await registering.routing.provider.refreshModels(network.context);
  // The others restore at once from what Pi stored, then again from the list the registering instance fetched and stored.
  expect(older.refreshes.slice(1).map((context) => [context.allowNetwork, context.stored])).toStrictEqual([[false, network.context.stored], [false, fetched]]);
  expect(registering.refreshes.map((context) => context.allowNetwork)).toStrictEqual([false, true]);
  expect(network.accepted.filter((publication) => publication.persist !== undefined)).toStrictEqual([registering.published[1]]);
  expect(older.models()).toStrictEqual([{ id: "older" }]);
});

test("another instance's failed restore does not fail the refresh Pi gave the registering instance", async () => {
  const pi = runtime();
  const failing = instance("failing", { refreshError: new Error("runtime failed to load") }), registering = instance("registering");
  pi.register(failing); pi.register(registering); pi.attach(failing); pi.attach(registering);
  const refresh = hostRefresh({ allowNetwork: false, stored: entry("stored") });
  await expect(registering.routing.provider.refreshModels(refresh.context)).resolves.toBe(undefined);
  expect(failing.refreshes).toHaveLength(1);
  expect(registering.models()).toStrictEqual([{ id: "registering" }]);

  const broken = instance("broken", { refreshError: new Error("own failure") });
  pi.register(broken); pi.attach(broken);
  await expect(broken.routing.provider.refreshModels(hostRefresh({ allowNetwork: false }).context)).rejects.toThrow("own failure");
});

test("an instance that attaches after the latest refresh restores from it, but not from a refresh Pi superseded", async () => {
  const pi = runtime();
  const registering = instance("registering"), late = instance("late"), later = instance("later");
  pi.register(late); pi.register(later); pi.register(registering); pi.attach(registering);
  const refresh = hostRefresh({ allowNetwork: false, stored: entry("stored") });
  await registering.routing.provider.refreshModels(refresh.context);
  expect(late.refreshes).toStrictEqual([]);
  pi.attach(late);
  await new Promise((resolve) => setImmediate(resolve));
  expect(late.refreshes.map((context) => [context.allowNetwork, context.stored, context.signal])).toStrictEqual([[false, refresh.context.stored, refresh.context.signal]]);
  expect(late.models()).toStrictEqual([{ id: "late" }]);
  expect(refresh.accepted.at(-1)!.persist).toBe(undefined);

  refresh.controller.abort();
  pi.attach(later);
  await new Promise((resolve) => setImmediate(resolve));
  expect(later.refreshes).toStrictEqual([]);
});

test("toAuth reaches every attached instance and answers with the registering instance's result, whatever another instance answers", async () => {
  const pi = runtime();
  const failing = instance("failing", { toAuth: async () => { throw new Error("invalidated in this instance"); } }), registering = instance("registering");
  pi.register(failing); pi.register(registering); pi.attach(failing); pi.attach(registering);
  expect(await registering.routing.provider.auth.oauth!.toAuth(credential)).toStrictEqual({ apiKey: "registering" });
  expect(failing.authorized).toStrictEqual(["failing"]);
  expect(registering.authorized).toStrictEqual(["registering"]);
});

test("until Pi's first refresh reaches the registering instance, the oldest attached instance with a list answers for the list; afterwards its own empty list stays", async () => {
  const pi = runtime();
  const listing = instance("listing", { models: [{ id: "listed" } as DevinModel] }), registering = instance("registering");
  pi.register(listing); pi.register(registering); pi.attach(listing); pi.attach(registering);
  expect(registering.routing.provider.getModels()).toStrictEqual([{ id: "listed" }]);
  // A superseded refresh does not count.
  const superseded = hostRefresh({ allowNetwork: false, controller: new AbortController() });
  superseded.controller.abort();
  await registering.routing.provider.refreshModels(superseded.context).catch(() => {});
  expect(registering.routing.provider.getModels()).toStrictEqual([{ id: "listed" }]);

  const signedOut = hostRefresh({ allowNetwork: false });
  signedOut.context.publish = async () => true;
  await registering.routing.provider.refreshModels(signedOut.context);
  expect(registering.routing.provider.getModels()).toStrictEqual([]);
});
