import type { Credential as HostCredential, Model, ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { toDevinFailure, type DevinError, type DevinFailure } from "../../core/errors.ts";
import type { ModelCatalog } from "../../core/models/catalog.ts";
import { modelIDForUID, projectModelVariants, resolveBackendSelection, type BackendModelSelection, type EffectiveThinkingLevel, type VariantProjection } from "../../core/models/variants.ts";
import { endpoint } from "../../core/protocol/endpoint.ts";
import type { Credential } from "../../core/types.ts";
import { failWith } from "../../core/validation.ts";
import { DEVIN_API, isFusionModelID, type FusionChoices, type FusionSelection } from "./constants.ts";
import { fusionChoices } from "./fusion.ts";
import { isUsable, publicModelIDs } from "./ids.ts";
import { catalogScope, modelsFromProjection, type DevinModel } from "./projection.ts";
import { restoredCatalog } from "./restore.ts";

const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export interface DevinModelSource {
  getModels(): readonly DevinModel[];
  filterModels(models: readonly Model<typeof DEVIN_API>[], credential: HostCredential | undefined): readonly Model<typeof DEVIN_API>[];
  refreshModels(context: RefreshModelsContext): Effect.Effect<void, DevinFailure>;
  resolve(modelID: string, level: EffectiveThinkingLevel, credential: Credential): Effect.Effect<BackendModelSelection, DevinError>;
  /** Resolves a catalog UID chosen by a payload hook at that variant's thinking level, including UIDs hidden from the list. */
  resolveUID(uid: string, credential: Credential): Effect.Effect<BackendModelSelection, DevinError>;
  getUnsupported(): readonly { uid: string; reason: string }[];
  /** Thinking level of a usable exact UID in the current catalog, including hidden ones. */
  exactLevel(uid: string): EffectiveThinkingLevel | undefined;
  /** Fusion candidates of the current catalog. undefined without a catalog or when the source has Fusion disabled. */
  getFusionChoices(): FusionChoices | undefined;
  /** Rebuilds the model list from the current catalog without network after a saved choice or setting changes. */
  readonly rebuildModels: Effect.Effect<void>;
  /** Scope of the credential seen by the last model refresh, even before its catalog loads. Undefined after logout or sign-in. */
  currentScope(): string | undefined;
  readonly invalidate: Effect.Effect<void>;
}

export interface DevinModelSourceOptions {
  credentialFromHost: (credential: HostCredential | undefined) => Effect.Effect<Credential | undefined, DevinError>;
  fetchCatalog: (credential: Credential) => Effect.Effect<ModelCatalog, DevinFailure>;
  now?: () => number;
  freshnessMs?: number;
  /** Reads the saved Fusion choice. false creates no Fusion entry. */
  fusion?: false | Effect.Effect<FusionSelection | undefined>;
  /** Reads the saved recommended filter setting. */
  recommendedOnly?: Effect.Effect<boolean>;
  /** Also lists exact UIDs that a group already covers. Used only by the sidekick child Pi. */
  listsAllExactModels?: boolean;
  /** Account identity hash this process verified for the credential, if any. */
  accountOf?: (credential: Credential) => string | undefined;
}

const publish = (context: RefreshModelsContext, publication: ModelsPublication) =>
  Effect.tryPromise({ try: () => context.publish(publication), catch: toDevinFailure });

export function createDevinModelSource(options: DevinModelSourceOptions): Effect.Effect<DevinModelSource, DevinError> {
  const now = options.now ?? Date.now, freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  if (!Number.isSafeInteger(freshnessMs) || freshnessMs < 0) return failWith("The model cache check interval must be an integer of 0 or more.");
  const readFusion = options.fusion;
  // The stored list is shared by every Pi process that uses the lead's agent directory. Only the default list is stored,
  // without display filters or the sidekick-only exact list. It still holds every catalog config, so each process rebuilds its own list after restore.
  const build = (next: VariantProjection, credential: Credential, account: string | undefined, isForStorage = false) => Effect.gen(function* () {
    const fusion = readFusion === false ? false : readFusion ? yield* readFusion : undefined;
    const recommendedOnly = !isForStorage && options.recommendedOnly !== undefined && (yield* options.recommendedOnly);
    return modelsFromProjection(next, credential, { fusion, recommendedOnly, listsAllExactModels: !isForStorage && options.listsAllExactModels === true, account });
  });
  let models: DevinModel[] = [], projection: VariantProjection | undefined, scope: string | undefined, catalogAccount: string | undefined;
  let checkedAtMs = 0, endpointOverride: string | undefined, modelCredential: Credential | undefined, credentialScope: string | undefined;
  const clear = () => {
    models = []; projection = undefined; scope = undefined; catalogAccount = undefined; checkedAtMs = 0; modelCredential = undefined; credentialScope = undefined;
  };
  const currentProjection = (credential: Credential) => !projection || scope !== catalogScope(credential)
    ? failWith("No Devin model list matches the current account and endpoint. Refresh the model list.") : Effect.succeed(projection);
  const effectiveCredential = (credential: HostCredential | undefined, baseUrl?: string) => Effect.flatMap(options.credentialFromHost(credential), (resolved) => resolved
    ? Effect.map(endpoint(baseUrl ?? resolved.apiServerURL), (apiServerURL): Credential | undefined => ({ ...resolved, apiServerURL })) : Effect.succeed(undefined));

  const refreshModels = (context: RefreshModelsContext) => Effect.gen(function* () {
    const credential = yield* effectiveCredential(context.credential, context.baseUrl);
    if (!credential) {
      yield* publish(context, { update: clear });
      return;
    }
    const expectedScope = catalogScope(credential);
    // A bad cache is never used as run data, whatever is wrong with it. The current good state is kept.
    const restored = yield* restoredCatalog(context.stored, credential, options.accountOf?.(credential)).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (restored && (scope !== expectedScope || !projection || (context.stored?.checkedAt ?? 0) > checkedAtMs)) {
      const { projection: restoredProjection, account: restoredAccount, isSameSession } = restored;
      const restoredModels = yield* build(restoredProjection, credential, restoredAccount);
      const checkedAt = context.stored?.checkedAt;
      const restoredAtMs = typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt >= 0 && checkedAt <= now() ? checkedAt : 0;
      const accepted = yield* publish(context, {
        // A catalog reused for a new session of the same account is stored under the new session, so a restart restores it too.
        ...(isSameSession ? {} : { persist: { models: yield* build(restoredProjection, credential, restoredAccount, true), checkedAt: restoredAtMs } }),
        update: () => {
          projection = restoredProjection; models = restoredModels; scope = expectedScope; catalogAccount = restoredAccount; modelCredential = credential;
          checkedAtMs = restoredAtMs; endpointOverride = context.baseUrl; credentialScope = expectedScope;
        },
      });
      if (!accepted) return;
    } else if (scope !== expectedScope || endpointOverride !== context.baseUrl || credentialScope !== expectedScope) {
      const accepted = yield* publish(context, { update: () => {
        if (scope !== expectedScope || endpointOverride !== context.baseUrl) clear();
        endpointOverride = context.baseUrl; credentialScope = expectedScope;
      } });
      if (!accepted) return;
    }
    if (!context.allowNetwork) return;
    const ageMs = now() - checkedAtMs;
    if (!context.force && scope === expectedScope && projection && checkedAtMs > 0 && ageMs >= 0 && ageMs < freshnessMs) return;
    const catalog = yield* options.fetchCatalog(credential);
    const nextProjection = yield* projectModelVariants(catalog);
    // Known after an account check in this process, or carried over from this same session's catalog.
    const nextAccount = options.accountOf?.(credential) ?? (scope === expectedScope ? catalogAccount : undefined);
    const nextModels = yield* build(nextProjection, credential, nextAccount);
    const checkedAt = now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) return yield* failWith("Invalid model cache check time.");
    yield* publish(context, {
      persist: { models: yield* build(nextProjection, credential, nextAccount, true), checkedAt },
      update: () => {
        projection = nextProjection; models = nextModels; scope = expectedScope; catalogAccount = nextAccount; modelCredential = credential;
        checkedAtMs = checkedAt; endpointOverride = context.baseUrl; credentialScope = expectedScope;
      },
    });
  });

  return Effect.succeed({
    getModels: () => models,
    getUnsupported: () => projection?.unsupported ?? [],
    exactLevel: (uid) => projection?.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level,
    getFusionChoices: () => projection && readFusion !== false ? fusionChoices(projection) : undefined,
    rebuildModels: Effect.suspend(() => projection && modelCredential
      ? Effect.map(build(projection, modelCredential, catalogAccount), (next) => { models = next; }) : Effect.void),
    currentScope: () => credentialScope,
    invalidate: Effect.sync(clear),
    filterModels(candidates, credential) {
      return Effect.runSync(Effect.map(effectiveCredential(credential, endpointOverride), (resolved) => {
        if (!resolved) return [];
        const expected = catalogScope(resolved);
        return candidates.filter((model) => model.provider === "devin" && model.api === DEVIN_API && model.baseUrl === resolved.apiServerURL && (model as DevinModel).devin?.scope === expected);
      }).pipe(Effect.catchCause(() => Effect.succeed([]))));
    },
    resolve: (modelID, level, credential) => Effect.gen(function* () {
      const current = yield* currentProjection(credential);
      let wanted = modelID;
      if (isFusionModelID(modelID)) {
        // Fusion lead requests use the same UID and thinking level as the selected lead group.
        const fusion = models.find((model) => model.id === modelID)?.devin.fusion;
        if (!fusion) return yield* failWith(`Fusion model unavailable: ${modelID}`);
        wanted = fusion.leadID;
      }
      const target = publicModelIDs(current).targets.get(wanted);
      if (!target) return yield* failWith(`Model or thinking level unavailable: ${modelID} (${level})`);
      return yield* resolveBackendSelection(current, "group" in target ? target.group.id : modelIDForUID(target.variant.model.id), level);
    }),
    resolveUID: (uid, credential) => Effect.gen(function* () {
      const current = yield* currentProjection(credential);
      const level = current.variants.find((variant) => variant.model.id === uid && isUsable(variant))?.level;
      if (!level) return yield* failWith(`Model UID unavailable: ${uid}`);
      return yield* resolveBackendSelection(current, modelIDForUID(uid), level);
    }),
    refreshModels,
  });
}
