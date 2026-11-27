import {
  createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Credential as HostCredential,
  type Model, type OAuthCredential, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { Credential } from "../../../core/types.ts";
import { devinSettingsPath, fusionSettingsPath, fusionSelectionFromFile, preferencesFromFile, readSettingsFile } from "../storage/settings-files.ts";
import { checkOAuthCredential } from "../../features/auth/oauth-credential.ts";
import { modelsInScope } from "../../features/catalog/scope.ts";
import { isFresh, listRestoredAsStored, storedCheckedAtMs } from "../../features/catalog/stored.ts";
import type { DevinAPI, DevinModel, FusionSelection } from "../../features/catalog/types.ts";
import type { DevinInstance, DevinProvider } from "./types.ts";

export interface LazyProviderOptions {
  /** The instance, loaded and attached to the current session. Loads at most once. */
  readonly load: () => Promise<DevinInstance>;
  /** Whether `load` is running, so a call that arrives meanwhile waits for it rather than answering without it. */
  readonly isLoading: () => boolean;
  /** Pi's agent directory, which holds the global settings files. */
  readonly agentDir: () => string;
  readonly now: () => number;
}

export interface LazyProvider {
  /** The instance's own provider, which the routing provider reaches. */
  readonly provider: DevinProvider;
  /**
   * Lets a loaded instance learn what this provider answered for it: Pi's latest refresh, offline, and the last OAuth session.
   * The list answered without the runtime stands until the instance publishes its own through Pi.
   */
  handOver(instance: DevinInstance): Promise<void>;
  /** Sends every later call to the instance. */
  activate(instance: DevinInstance): void;
}

/** Pi's display settings and Fusion choice, when every file reads cleanly and the display filter is off. */
function defaultDisplayFusion(agentDir: string): { fusion: FusionSelection | undefined } | undefined {
  const settings = readSettingsFile(devinSettingsPath(agentDir));
  if ("value" in settings ? preferencesFromFile(settings.value)?.recommendedOnly !== false : !settings.isMissing) return undefined;
  const fusion = readSettingsFile(fusionSettingsPath(agentDir));
  if (!("value" in fusion)) return fusion.isMissing ? { fusion: undefined } : undefined;
  const selection = fusionSelectionFromFile(fusion.value);
  return selection ? { fusion: selection } : undefined;
}

/** What a `ModelCatalog` that has verified no account yet would show after an offline restore. Undefined when only it can tell. */
interface ColdRestore { readonly models: readonly DevinModel[]; readonly credential?: Credential }

function coldRestore(context: RefreshModelsContext, agentDir: string): ColdRestore | undefined {
  // Without an OAuth credential the catalog shows nothing; a credential it would reject is left to it, so the failure is the same.
  if (context.credential?.type !== "oauth") return { models: [] };
  if (context.baseUrl !== undefined) return undefined;
  const checked = checkOAuthCredential(context.credential);
  if (!("credential" in checked)) return undefined;
  const display = defaultDisplayFusion(agentDir);
  if (!display) return undefined;
  const models = listRestoredAsStored(context.stored, checked.credential, display.fusion);
  return models && { models, credential: checked.credential };
}

/** An error result for a request whose runtime failed to load, as Pi's own lazy streams report setup failures. */
function loadFailure(model: Model<DevinAPI>, error: unknown, signal: AbortSignal | undefined): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
  };
}

/**
 * The instance's provider before its runtime loads. Pi refreshes and lists a provider as soon as it is registered, so this answers
 * offline refreshes, the model list, its filter and request auth without the runtime, but only where the result is provably what
 * the loaded `ModelCatalog` would give; it shares the catalog's own rules for that. Anything else loads the runtime first:
 * sign-in, the session check, streams, a refresh that needs the network, or a stored list it cannot vouch for.
 */
export function makeLazyProvider(options: LazyProviderOptions): LazyProvider {
  let instance: DevinInstance | undefined;
  let coldModels: readonly DevinModel[] = [];
  /** Pi's latest refresh of this instance, until Pi supersedes it. */
  let latest: RefreshModelsContext | undefined;
  /** The OAuth credential of the latest request auth answered without the runtime. */
  let pendingAuth: OAuthCredential | undefined;
  /** Whether the provider answered a refresh without the runtime, and whether the loaded instance has published since. */
  let hasAnsweredCold = false, isListedByInstance = false;

  const loaded = () => options.load();
  const lister = () => instance && isListedByInstance ? instance.provider : undefined;
  const coldFilter = (models: readonly Model<DevinAPI>[], credential: HostCredential | undefined) => {
    if (credential?.type !== "oauth") return [];
    const checked = checkOAuthCredential(credential);
    return "credential" in checked ? modelsInScope(models, checked.credential) : [];
  };
  // The instance's list replaces the one answered without it in the same update Pi accepts, so no caller sees a gap.
  const listingFromInstance = (context: RefreshModelsContext): RefreshModelsContext => ({ ...context,
    publish: (publication) => context.publish({ ...publication, update: () => { publication.update?.(); isListedByInstance = true; } }) });
  const delegated = async (context: RefreshModelsContext) => {
    const target = instance ?? await loaded();
    await target.provider.refreshModels(isListedByInstance ? context : listingFromInstance(context));
  };
  const refreshModels = async (context: RefreshModelsContext) => {
    if (instance || options.isLoading()) return delegated(context);
    latest = context;
    context.signal.addEventListener("abort", () => { if (latest === context) latest = undefined; }, { once: true });
    const restored = coldRestore(context, options.agentDir());
    if (!restored) return delegated(context);
    const isAccepted = await context.publish({ update: () => { coldModels = restored.models; hasAnsweredCold = true; } });
    if (!isAccepted || !context.allowNetwork || !restored.credential) return;
    // The catalog looks a list up again only when it has none or it is older than the freshness window.
    if (!context.force && restored.models.length > 0 && isFresh(storedCheckedAtMs(context.stored, options.now()), options.now())) return;
    return delegated(context);
  };
  const proxyStream = (model: Model<DevinAPI>, start: (target: DevinInstance) => AssistantMessageEventStream, signal: AbortSignal | undefined) => {
    if (instance) return start(instance);
    const outer = createAssistantMessageEventStream();
    loaded().then(async (target) => {
      const inner = start(target);
      for await (const event of inner) outer.push(event);
      outer.end(await inner.result());
    }).catch((error: unknown) => {
      const message = loadFailure(model, error, signal);
      outer.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
      outer.end(message);
    });
    return outer;
  };

  const provider: DevinProvider = {
    id: "devin", name: "Devin",
    auth: {
      oauth: {
        name: "Devin account",
        login: async (interaction, loginOptions) => (instance ?? await loaded()).provider.auth.oauth!.login(interaction, loginOptions),
        refresh: async (credential, signal) => (instance ?? await loaded()).provider.auth.oauth!.refresh(credential, signal),
        toAuth: async (credential) => {
          if (instance || options.isLoading()) return (instance ?? await loaded()).provider.auth.oauth!.toAuth(credential);
          const checked = checkOAuthCredential(credential);
          if (!("credential" in checked)) return (await loaded()).provider.auth.oauth!.toAuth(credential);
          pendingAuth = credential;
          return { apiKey: checked.credential.sessionToken, baseUrl: checked.credential.apiServerURL };
        },
      },
    },
    getModels: () => lister()?.getModels() ?? coldModels,
    filterModels: (models, credential) => {
      const target = lister();
      return target ? target.filterModels!(models, credential) : coldFilter(models, credential);
    },
    refreshModels,
    stream: (model, context, streamOptions) => proxyStream(model, (target) => target.provider.stream(model, context, streamOptions), streamOptions?.signal),
    streamSimple: (model, context, streamOptions) => proxyStream(model, (target) => target.provider.streamSimple(model, context, streamOptions), streamOptions?.signal),
  };

  return {
    provider,
    handOver: async (target) => {
      // A failed or rejected hand-over leaves the instance without a list; its requests wait for Pi's next refresh, as a new instance's do.
      if (pendingAuth) await target.provider.auth.oauth!.toAuth(pendingAuth).catch(() => {});
      pendingAuth = undefined;
      const refresh = latest;
      if (!refresh || refresh.signal.aborted) return;
      await target.provider.refreshModels(listingFromInstance({ ...refresh, allowNetwork: false, force: undefined })).catch(() => {});
    },
    activate: (target) => {
      instance = target;
      latest = undefined;
      if (!hasAnsweredCold) isListedByInstance = true;
    },
  };
}
