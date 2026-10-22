import type { Provider } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { abortWith, makeCancellation } from "../core/cancellation.ts";
import { Cancelled } from "../core/errors.ts";
import { applyTeamModelPolicy } from "../core/models/access.ts";
import type { FingerprintProvider } from "../core/protocol/fingerprint.ts";
import type { HTTPTransportOptions } from "../core/protocol/http.ts";
import type { Credential } from "../core/types.ts";
import { createDevinAccountAuth, type DevinAccountAuthOptions } from "./auth/account-auth.ts";
import { DevinLifecycle, type SessionBinding } from "./lifecycle.ts";
import { createDevinModelSource, type DEVIN_API, type FusionChoices, type FusionSelection } from "./models.ts";
import { AccountBook } from "./provider/accounts.ts";
import { ClientRegistry } from "./provider/clients.ts";
import { authenticationFailed, streamInference } from "./provider/inference.ts";
import { memoryAccountUsageStore, type AccountUsageStore } from "./settings/usage-store.ts";
import type { AccountUsage } from "./usage.ts";

export interface DevinProvider extends Provider<typeof DEVIN_API> {
  refreshModels: NonNullable<Provider<typeof DEVIN_API>["refreshModels"]>;
  readonly lifecycle: DevinLifecycle;
  /** Binds the provider to Pi's current session. Throws on a corrupt stored state, which stops the session. */
  attachSession(binding: SessionBinding): void;
  getFusionChoices(): FusionChoices | undefined;
  /** Rebuilds the model list from the current catalog without network after the saved Fusion choice or display settings change. */
  readonly rebuildModels: Effect.Effect<void>;
  /**
   * Newest quota received for the current credential by this process or another one sharing the usage store.
   * Makes no request; undefined if none was received or no credential is current.
   */
  getAccountUsage(): AccountUsage | undefined;
  shutdown(): void;
}

export interface DevinProviderOptions {
  fetch?: typeof fetch;
  fingerprint?: (credential: Credential) => FingerprintProvider;
  http?: HTTPTransportOptions;
  loginOptions?: DevinAccountAuthOptions["loginOptions"];
  maxModelCalls?: number;
  /** Reads the saved Fusion choice. false (sidekick process) creates no Fusion entry. */
  fusion?: false | Effect.Effect<FusionSelection | undefined>;
  /** Reads the saved recommended filter setting. */
  recommendedOnly?: Effect.Effect<boolean>;
  /** Also lists exact UIDs that a group already covers. Used only by the sidekick child Pi. */
  listsAllExactModels?: boolean;
  /** Shares the last account quota with other Pi processes using the same agent directory. Kept in memory only when omitted. */
  accountUsage?: AccountUsageStore;
  /** Called after the quota or the current credential may have changed, outside Pi event handlers. */
  onAccountUsage?: () => Effect.Effect<void>;
  now?: () => number;
}

/** The Devin provider Pi registers. Creating it performs no I/O; work starts with Pi's first refresh or request. */
export function createDevinProvider(options: DevinProviderOptions = {}): DevinProvider {
  const lifecycle = Effect.runSync(DevinLifecycle.make(options.maxModelCalls));
  let lifetime = makeCancellation();
  const now = options.now ?? Date.now;
  const clients = new ClientRegistry({ fetch: options.fetch, fingerprint: options.fingerprint, http: options.http });
  const accounts = new AccountBook({ store: options.accountUsage ?? memoryAccountUsageStore(), now, onChange: options.onAccountUsage, isActive: () => !lifetime.isCancelled() });
  const auth = createDevinAccountAuth({
    loginOptions: { ...options.loginOptions, fetch: options.loginOptions?.fetch ?? options.fetch },
    createClient: (credential) => clients.client(credential, { profile: "login" }),
    lifetime: () => lifetime,
    isAccountChecked: (credential) => accounts.get(credential) !== undefined,
    onValidated: (credential, ownerHash, status) => accounts.remember(credential, ownerHash, status),
    onInvalidated: (credential, error) => Effect.all([accounts.forget(credential), lifecycle.abort(error), accounts.changed], { discard: true }),
    onLogin: Effect.all([
      accounts.clear, clients.clearFingerprints, Effect.suspend(() => source.invalidate),
      lifecycle.abort(new Cancelled({ message: "The Devin account was re-authenticated." })), accounts.changed,
    ], { discard: true }),
    now,
  });
  const source = Effect.runSync(createDevinModelSource({
    fusion: options.fusion,
    recommendedOnly: options.recommendedOnly,
    listsAllExactModels: options.listsAllExactModels,
    credentialFromHost: (credential) => credential?.type === "oauth" ? auth.credentialFromHost(credential) : Effect.succeed(undefined),
    accountOf: (credential) => accounts.get(credential)?.ownerHash,
    fetchCatalog: (credential) => Effect.scoped(Effect.gen(function* () {
      const generation = auth.generation;
      yield* auth.assertUsable(credential);
      const client = yield* clients.client(credential);
      return yield* Effect.gen(function* () {
        const catalog = yield* client.catalog;
        return { ...catalog, models: applyTeamModelPolicy(catalog.models, yield* client.teamSettings) };
      }).pipe(Effect.tapError((error) => authenticationFailed(auth, credential, error, generation)));
    })),
  }));
  const deps = { auth, source, lifecycle, clients, accounts, lifetime: () => lifetime };
  return {
    id: "devin", name: "Devin", auth: { oauth: auth }, lifecycle,
    getModels: source.getModels, filterModels: source.filterModels,
    getFusionChoices: source.getFusionChoices, rebuildModels: source.rebuildModels,
    getAccountUsage: () => {
      const scope = source.currentScope();
      return scope ? accounts.usage(scope) : undefined;
    },
    // Sign-in, logout and restores change the current credential, which decides whose quota is shown.
    refreshModels: (context) => Effect.runPromise(lifetime.guard(source.refreshModels(context)).pipe(abortWith(context.signal), Effect.ensuring(accounts.changed))),
    stream: (model, context, requestOptions) => streamInference(deps, model, context, requestOptions),
    streamSimple: (model, context, requestOptions) => streamInference(deps, model, context, requestOptions),
    attachSession(binding) {
      if (lifetime.isCancelled()) lifetime = makeCancellation();
      Effect.runSync(lifecycle.attach(binding));
    },
    shutdown() {
      lifetime.cancelUnsafe(new Cancelled({ message: "The Devin provider shut down." }));
      Effect.runSync(Effect.all([lifecycle.shutdown, clients.closeAll, clients.clearFingerprints, accounts.clear], { discard: true }));
    },
  };
}
