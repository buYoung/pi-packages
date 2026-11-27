import { readFileSync } from "node:fs";
import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import type { Credential, JsonObject } from "../../../core/types.ts";
import { CATALOG_VERSION, DEVIN_API } from "./constants.ts";
import { catalogScope } from "./scope.ts";
import type { DevinModel, FusionSelection, StoredBy } from "./types.ts";

/*
 * Rules about the catalog entry Pi stores for this provider, free of Effect: `ModelCatalog` restores through them, and the
 * extension entry uses them to answer Pi before it loads the runtime.
 */

/** A catalog checked this recently is not looked up again unless the refresh is forced. */
export const FRESHNESS_MS = 5 * 60_000;
const ACCOUNT_HASH = /^[a-f0-9]{64}$/;
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface StoredConfigs { configs: JsonObject[]; scope: unknown; account: unknown }

/** Every stored entry's configs when the whole store belongs to one scope and one account; anything mixed or edited is ignored. */
export function storedConfigs(stored: Readonly<ModelsStoreEntry>, credential: Credential): StoredConfigs | undefined {
  const configs = new Map<string, JsonObject>();
  let storedScope: unknown, storedAccount: unknown;
  for (const [index, model] of stored.models.entries()) {
    const metadata = (model as DevinModel).devin as unknown;
    if (!isObject(metadata)) return undefined;
    if ((model.type !== undefined && model.type !== "chat") || model.provider !== "devin" || model.api !== DEVIN_API || model.baseUrl !== credential.apiServerURL
      || metadata.version !== CATALOG_VERSION || typeof metadata.scope !== "string") return undefined;
    if (metadata.account !== undefined && (typeof metadata.account !== "string" || !ACCOUNT_HASH.test(metadata.account))) return undefined;
    if (index === 0) { storedScope = metadata.scope; storedAccount = metadata.account; }
    else if (metadata.scope !== storedScope || metadata.account !== storedAccount) return undefined;
    if (!Array.isArray(metadata.configs)) return undefined;
    for (const value of [...metadata.configs, ...(Array.isArray(metadata.unavailable) ? metadata.unavailable : [])]) {
      if (!isObject(value) || typeof value.modelUid !== "string") return undefined;
      const config = value as JsonObject;
      const previous = configs.get(value.modelUid);
      if (previous && JSON.stringify(previous) !== JSON.stringify(config)) return undefined;
      configs.set(value.modelUid, config);
    }
  }
  return { configs: [...configs.values()], scope: storedScope, account: storedAccount };
}

/** When the stored catalog was checked, if that is a time not in the future; 0 otherwise. */
export function storedCheckedAtMs(stored: Readonly<ModelsStoreEntry> | undefined, nowMs: number): number {
  const checkedAt = stored?.checkedAt;
  return typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt >= 0 && checkedAt <= nowMs ? checkedAt : 0;
}

export function isFresh(checkedAtMs: number, nowMs: number): boolean {
  const ageMs = nowMs - checkedAtMs;
  return checkedAtMs > 0 && ageMs >= 0 && ageMs < FRESHNESS_MS;
}

/** The mark a lead puts on the list it stores, built with `fusion` as the saved Fusion choice. */
export function storedBy(fusion: FusionSelection | undefined): StoredBy {
  return { version: PACKAGE_VERSION, fusion: fusion ? { leadID: fusion.leadID, sidekickID: fusion.sidekickID } : null };
}

/**
 * The list a `ModelCatalog` that has verified no account yet shows after restoring `stored` for `credential`, with the
 * default display settings and `fusion` saved, when the stored entry alone proves it: none for a store of another session
 * or one that is mixed or edited, and the stored list itself when a lead of this package version stored it with the same
 * Fusion choice. Undefined when only a restore can tell.
 */
export function listRestoredAsStored(stored: Readonly<ModelsStoreEntry> | undefined, credential: Credential, fusion: FusionSelection | undefined): readonly DevinModel[] | undefined {
  if (!stored?.models.length) return [];
  const entries = storedConfigs(stored, credential);
  if (!entries || entries.scope !== catalogScope(credential)) return [];
  const expected = JSON.stringify(storedBy(fusion));
  const models = stored.models as readonly DevinModel[];
  if (!models.every((model) => JSON.stringify(model.devin.storedBy) === expected)) return undefined;
  return models.map(({ devin: { storedBy: _mark, ...devin }, ...model }) => ({ ...model, devin }));
}
