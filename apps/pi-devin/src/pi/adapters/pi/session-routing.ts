import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { DevinProvider } from "./types.ts";

/**
 * Pi keeps one provider per ID in a model runtime, and the extension instance that registered it last receives every call.
 * Sessions that share a model runtime, such as in-process subagents, each load their own instance, whose runs and lifetime
 * belong to that session. So the provider each instance registers sends a call to the instance of the session that made it,
 * and lets every instance of the runtime learn the OAuth session and the model list, which Pi gives only that provider.
 *
 * The instances of the process are listed in a table on `globalThis` under a versioned key, because Pi loads every instance
 * with its own copy of this module; a copy with another key version neither reads nor joins the table. Each instance adds
 * its route when it registers, attaches it at `session_start` and marks it shut down at `session_shutdown`. The table holds
 * routes weakly, so an instance Pi no longer references, such as one of a session disposed without `session_shutdown`,
 * leaves it once collected. Besides the routes, it maps each registered provider weakly to the function that lets an
 * instance attaching later restore from that provider's latest refresh; the refresh itself, credential included, stays
 * with the registering instance until Pi's next refresh of it replaces it or Pi aborts it. Nothing else stays in the table.
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

interface RouteTable {
  readonly routes: Set<WeakRef<Route>>;
  attaches: number;
  /** Per registered provider, how an instance attaching to it restores from its latest refresh. Absent in tables of older copies. */
  joins?: WeakMap<object, (route: Route) => void>;
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

/** A refresh Pi gave the registered provider, with the list it stored last: the one Pi read for it, or the one it persisted since. */
interface Refresh {
  readonly context: RefreshModelsContext;
  stored: RefreshModelsContext["stored"];
}

/**
 * Lets an instance Pi did not call restore its own catalog from Pi's refresh: offline, from the refresh's credential and
 * stored list. Its publications go through Pi's own `publish`, so Pi still drops them once a newer refresh superseded this one,
 * but without `persist`: only the instance Pi called stores the list.
 */
function restoreFrom(route: Route, refresh: Refresh): Promise<void> {
  const { context } = refresh;
  return route.provider.refreshModels({
    credential: context.credential, stored: refresh.stored, allowNetwork: false, signal: context.signal, baseUrl: context.baseUrl,
    publish: (publication) => context.publish({ update: publication.update }),
  });
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
  /** Pi's latest refresh of this provider, until Pi's next refresh replaces it or Pi aborts it. */
  let latest: Refresh | undefined;
  /** Whether a refresh Pi did not supersede has reached this instance through this provider. */
  let hasRefreshed = false;
  // A new instance lists nothing until Pi's first refresh reaches it, and Pi checks the list before it sends some calls, for
  // example when models.json configures devin. Until then the oldest attached instance that lists models answers instead;
  // afterwards an empty list means signed out or no catalog, and no other instance's list stands in for it.
  const lister = (): Route => {
    const target = owner();
    if (target !== self || hasRefreshed || own.getModels().length > 0) return target;
    return sharingRoutes(table, provider).find((route) => route !== self && route.provider.getModels().length > 0) ?? target;
  };
  const refreshModels = async (context: RefreshModelsContext) => {
    const refresh: Refresh = { context, stored: context.stored };
    latest = refresh;
    context.signal.addEventListener("abort", () => { if (latest === refresh) latest = undefined; }, { once: true });
    const target = owner();
    const others = () => sharingRoutes(table, provider).filter((route) => route !== target);
    const publish: RefreshModelsContext["publish"] = async (publication) => {
      const isAccepted = await context.publish(publication);
      if (isAccepted && publication.persist !== undefined) refresh.stored = publication.persist ?? undefined;
      return isAccepted;
    };
    // The others restore what Pi stored at once, so a sign-in, logout or account switch reaches them without waiting for a fetch.
    // Only the called instance's outcome reaches Pi: a failed restore leaves another instance as it was, as on attach.
    const [outcome] = await Promise.allSettled([
      target.provider.refreshModels({ ...context, publish }),
      ...others().map((route) => restoreFrom(route, refresh)),
    ]);
    if (target === self && !context.signal.aborted) hasRefreshed = true;
    // A list the refresh fetched and stored reaches the others too, including instances that attached in the meantime.
    if (refresh.stored !== context.stored && !context.signal.aborted) {
      await Promise.allSettled(others().map((route) => restoreFrom(route, refresh)));
    }
    if (outcome.status === "rejected") throw outcome.reason;
  };
  const oauth = own.auth.oauth!;
  const provider: DevinProvider = {
    ...own,
    auth: {
      oauth: {
        ...oauth,
        login: (interaction, options) => owner().provider.auth.oauth!.login(interaction, options),
        refresh: (credential, signal) => owner().provider.auth.oauth!.refresh(credential, signal),
        // Every instance learns the session Pi authorizes a request with; the request's own instance still checks it.
        toAuth: async (credential) => {
          const target = owner();
          const others = sharingRoutes(table, provider).filter((route) => route !== target);
          const [auth] = await Promise.all([
            target.provider.auth.oauth!.toAuth(credential),
            Promise.allSettled(others.map((route) => route.provider.auth.oauth!.toAuth(credential))),
          ]);
          return auth;
        },
      },
    },
    getModels: () => lister().provider.getModels(),
    filterModels: (models, credential) => lister().provider.filterModels!(models, credential),
    refreshModels,
    stream: (model, context, options) => forSession(options?.sessionId).provider.stream(model, context, options),
    streamSimple: (model, context, options) => forSession(options?.sessionId).provider.streamSimple(model, context, options),
  };
  Object.defineProperty(provider, ROUTES_KEY, { value: true });
  // A failed or rejected restore leaves the instance as it was; its requests wait for Pi's next refresh, which reaches it.
  table.joins ??= new WeakMap();
  table.joins.set(provider, (route) => {
    if (latest && !latest.context.signal.aborted) restoreFrom(route, latest).catch(() => {});
  });
  return {
    provider,
    attach: (sessionId, registry) => {
      Object.assign(self, { sessionId, registry, isShutDown: false, attachOrder: ++table.attaches });
      // An instance that attaches to another instance's provider after Pi's latest refresh of it restores from that refresh.
      const registered = registry.getRegisteredNativeProvider(PROVIDER_ID);
      if (registered !== provider && typeof registered === "object" && registered !== null) table.joins?.get(registered)?.(self);
    },
    detach: () => { self.isShutDown = true; },
  };
}

/** Whether a registered provider object routes through the table of this key version. A copy of it does not. */
export function isSessionRoutingProvider(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { [ROUTES_KEY]?: unknown })[ROUTES_KEY] === true;
}
