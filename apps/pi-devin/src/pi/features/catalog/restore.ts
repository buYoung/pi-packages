import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { restoreModelVariants, type VariantProjection } from "../../../core/models/variants.ts";
import type { Credential } from "../../../core/types.ts";
import { catalogScope } from "./scope.ts";
import { storedConfigs } from "./stored.ts";

export interface RestoredCatalog { projection: VariantProjection; account?: string; isSameSession: boolean }

/**
 * Restores the stored catalog of the same session, or of an earlier session of an account this process verified for `account`.
 * Every entry must share one scope and one account, so a mixed or edited cache is never partly applied. A bad cache yields none.
 */
export function restoredCatalog(stored: Readonly<ModelsStoreEntry> | undefined, credential: Credential, account: string | undefined): Effect.Effect<RestoredCatalog | undefined> {
  return Effect.suspend(() => {
    if (!stored?.models.length) return Effect.succeed(undefined);
    const entries = storedConfigs(stored, credential);
    if (!entries) return Effect.succeed(undefined);
    const isSameSession = entries.scope === catalogScope(credential);
    // Another session's catalog is used only for the same verified account; account changes and logout never expose it.
    if (!isSameSession && (account === undefined || entries.account !== account)) return Effect.succeed(undefined);
    return restoreModelVariants(entries.configs).pipe(
      Effect.map((projection): RestoredCatalog | undefined => ({ projection, account: account ?? entries.account as string | undefined, isSameSession })),
      Effect.orElseSucceed(() => undefined),
    );
  });
}
