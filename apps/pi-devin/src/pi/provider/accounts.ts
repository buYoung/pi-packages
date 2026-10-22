import { Effect } from "effect";
import type { Credential, JsonObject } from "../../core/types.ts";
import { evictOldest } from "../auth/credential.ts";
import { catalogScope } from "../models.ts";
import type { AccountUsageStore } from "../settings/usage-store.ts";
import { accountUsage, type AccountUsage } from "../usage.ts";

export interface AccountRecord { ownerHash: string; status: JsonObject }

export interface AccountBookOptions {
  store: AccountUsageStore;
  now: () => number;
  /** Runs after the quota or the current credential may have changed. Its failures never affect requests. */
  onChange?: () => Effect.Effect<void>;
  /** A stopped provider records nothing more. */
  isActive: () => boolean;
}

/** Accounts this process verified, by credential scope, and the newest quota they reported. */
export class AccountBook {
  private readonly options: AccountBookOptions;
  private readonly accounts = new Map<string, AccountRecord>();
  private latestUsage: { scope: string; usage: AccountUsage } | undefined;

  constructor(options: AccountBookOptions) {
    this.options = options;
  }

  get(credential: Credential): AccountRecord | undefined {
    return this.accounts.get(catalogScope(credential));
  }

  /** Notifies listeners; a display failure must not affect requests or refreshes. */
  get changed(): Effect.Effect<void> {
    return Effect.catchCause(this.options.onChange?.() ?? Effect.void, () => Effect.void);
  }

  remember(credential: Credential, ownerHash: string, status: JsonObject): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.options.isActive()) return Effect.void;
      const scope = catalogScope(credential);
      evictOldest(this.accounts, 16);
      this.accounts.set(scope, { ownerHash, status });
      const usage = accountUsage(status, this.options.now());
      this.latestUsage = { scope, usage };
      // Subagents and the Fusion sidekick run in other processes; a failed write only loses sharing.
      return Effect.andThen(Effect.ignore(this.options.store.write(scope, usage)), this.changed);
    });
  }

  forget(credential: Credential): Effect.Effect<void> {
    return Effect.sync(() => {
      this.accounts.delete(catalogScope(credential));
      this.latestUsage = undefined;
    });
  }

  get clear(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.accounts.clear();
      this.latestUsage = undefined;
    });
  }

  /** Newest quota for the scope, received here or by another process sharing the store. Makes no request. */
  usage(scope: string): AccountUsage | undefined {
    const local = this.latestUsage?.scope === scope ? this.latestUsage.usage : undefined;
    const shared = Effect.runSync(this.options.store.read(scope));
    const newest = shared && (!local || shared.fetchedAtMs > local.fetchedAtMs) ? shared : local;
    return newest ? { ...newest } : undefined;
  }
}
