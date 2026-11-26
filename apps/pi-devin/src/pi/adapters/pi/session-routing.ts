import type { DevinProvider } from "./types.ts";

/**
 * Pi keeps one provider per ID in a model runtime, and the extension instance that registered it last receives every call.
 * Sessions that share a model runtime, such as in-process subagents, each load their own instance, whose runs and lifetime
 * belong to that session. So the provider each instance registers sends a call to the instance of the session that made it.
 *
 * The instances of the process are listed in a table on `globalThis` under a versioned key, because Pi loads every instance
 * with its own copy of this module; a copy with another key version neither reads nor joins the table. Each instance adds
 * its route when it registers, attaches it at `session_start` and marks it shut down at `session_shutdown`. The table holds
 * routes weakly, so an instance Pi no longer references, such as one of a session disposed without `session_shutdown`,
 * leaves it once collected. Nothing else stays in the table.
 */
const ROUTES_KEY = Symbol.for("@buyong/pi-devin/session-routes/v1");
const PROVIDER_ID = "devin";

/** The part of Pi's model registry that tells which provider object the session's model runtime calls. */
export interface ProviderRegistry {
  getRegisteredNativeProvider(providerId: string): unknown;
}

/** One instance in the table. Its fields are the contract every copy of key version 1 shares. */
interface Route {
  /** The instance's own provider, which serves calls itself. */
  readonly provider: DevinProvider;
  /** Whether the instance's session is compacting or summarizing a branch. */
  readonly isAuxiliary: () => boolean;
  sessionId?: () => string;
  registry?: ProviderRegistry;
  isShutDown: boolean;
  /** Order of the instance's latest attach in the process; lower is older. */
  attachOrder: number;
}

type RefreshContext = Parameters<DevinProvider["refreshModels"]>[0];

interface RouteTable {
  readonly routes: Set<WeakRef<Route>>;
  attaches: number;
  /** The newest refresh inputs Pi gave any instance, with the newest stored list, for the instances it never refreshed. */
  latestRefresh?: Pick<RefreshContext, "credential" | "stored" | "baseUrl">;
}

function routeTable(): RouteTable {
  const host = globalThis as { [ROUTES_KEY]?: RouteTable };
  return host[ROUTES_KEY] ??= { routes: new Set(), attaches: 0 };
}

/** Attached instances whose model runtime calls `registered`, oldest first. */
function sharingRoutes(table: RouteTable, registered: DevinProvider): Route[] {
  const sharing: Route[] = [];
  for (const reference of table.routes) {
    const route = reference.deref();
    if (!route) table.routes.delete(reference);
    else if (!route.isShutDown && route.sessionId && route.registry?.getRegisteredNativeProvider(PROVIDER_ID) === registered) sharing.push(route);
  }
  return sharing.sort((left, right) => left.attachOrder - right.attachOrder);
}

export interface SessionRouting {
  /** The provider to register with Pi. */
  readonly provider: DevinProvider;
  /** Sends the session's calls to this instance. Both arguments must stay usable after Pi invalidates the event context. */
  attach(sessionId: () => string, registry: ProviderRegistry): void;
  /** Stops sending calls to this instance until it attaches again. */
  detach(): void;
}

export function makeSessionRouting(own: DevinProvider, isAuxiliary: () => boolean): SessionRouting {
  const table = routeTable();
  const self: Route = { provider: own, isAuxiliary, isShutDown: false, attachOrder: 0 };
  table.routes.add(new WeakRef(self));
  // Calls of no particular session stay with this instance until it shuts down, then go to the oldest one still attached.
  const owner = (): Route => self.isShutDown ? sharingRoutes(table, provider)[0] ?? self : self;
  const forSession = (sessionId: string | undefined): Route => {
    const sharing = sharingRoutes(table, provider);
    const attached = sessionId === undefined ? undefined : sharing.find((route) => route.sessionId!() === sessionId);
    if (attached) return attached;
    // Pi gives compaction and branch summary requests a new session ID; their session's instance is then in that phase.
    const auxiliary = sharing.filter((route) => route.isAuxiliary());
    return auxiliary.length === 1 ? auxiliary[0] : owner();
  };
  // Pi refreshes only the provider registered last, after an await, so an instance another one replaced before that refresh
  // never gets its first one: it never sees the OAuth session and never ends its wait for the first refresh. Such an instance
  // restores its list offline, for itself only, from the newest refresh inputs Pi gave any instance.
  const restoreIfNeverRefreshed = (route: Route) => {
    const latest = table.latestRefresh;
    if (!latest?.stored?.models.length || route.provider.getModels().length > 0) return;
    void route.provider.refreshModels({ ...latest, allowNetwork: false, force: false, signal: new AbortController().signal,
      publish: async (publication) => { publication.update?.(); return true; } }).catch(() => {});
  };
  const oauth = own.auth.oauth!;
  const provider: DevinProvider = {
    ...own,
    auth: {
      oauth: {
        ...oauth,
        login: (interaction, options) => owner().provider.auth.oauth!.login(interaction, options),
        refresh: (credential, signal) => owner().provider.auth.oauth!.refresh(credential, signal),
        toAuth: (credential) => owner().provider.auth.oauth!.toAuth(credential),
      },
    },
    // A new instance has no list until Pi's refresh restores it, and Pi may check the list before it sends a call, so the list
    // of another attached instance stands in until then.
    getModels: () => {
      const own = owner().provider.getModels();
      if (own.length > 0) return own;
      for (const route of sharingRoutes(table, provider)) {
        const models = route.provider.getModels();
        if (models.length > 0) return models;
      }
      return own;
    },
    filterModels: (models, credential) => owner().provider.filterModels!(models, credential),
    refreshModels: async (context) => {
      // The stored entry is the list before this refresh; a list this refresh persists replaces it.
      const stored = context.stored?.models.length ? context.stored : table.latestRefresh?.stored;
      table.latestRefresh = { credential: context.credential, stored, baseUrl: context.baseUrl };
      const publish: RefreshContext["publish"] = async (publication) => {
        const accepted = await context.publish(publication);
        if (accepted && publication.persist?.models.length) table.latestRefresh = { ...table.latestRefresh, stored: publication.persist };
        return accepted;
      };
      try { await owner().provider.refreshModels({ ...context, publish }); }
      finally { for (const route of sharingRoutes(table, provider)) if (route !== owner()) restoreIfNeverRefreshed(route); }
    },
    stream: (model, context, options) => forSession(options?.sessionId).provider.stream(model, context, options),
    streamSimple: (model, context, options) => forSession(options?.sessionId).provider.streamSimple(model, context, options),
  };
  Object.defineProperty(provider, ROUTES_KEY, { value: true });
  return {
    provider,
    attach: (sessionId, registry) => {
      Object.assign(self, { sessionId, registry, isShutDown: false, attachOrder: ++table.attaches });
      restoreIfNeverRefreshed(self);
    },
    detach: () => { self.isShutDown = true; },
  };
}

/** Whether a registered provider object routes through the table of this key version. A copy of it does not. */
export function isSessionRoutingProvider(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { [ROUTES_KEY]?: unknown })[ROUTES_KEY] === true;
}
