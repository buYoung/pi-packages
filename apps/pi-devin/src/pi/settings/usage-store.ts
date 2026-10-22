import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { DevinError } from "../../core/errors.ts";
import type { AccountUsage } from "../usage.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

const SCHEMA_VERSION = 1;

/**
 * Last account quota received by any Pi process that shares the agent directory, such as subagents and the Fusion sidekick.
 * Keyed by the credential scope hash. No token, account ID or raw response is stored.
 */
export interface AccountUsageStore {
  /** Never fails: a missing or unreadable record reads as none. */
  read(scope: string): Effect.Effect<AccountUsage | undefined>;
  /** Replaces the record unless the stored one for the same scope was fetched later. */
  write(scope: string, usage: AccountUsage): Effect.Effect<void, DevinError>;
}

const Percent = Schema.optionalKey(Schema.Finite);
const UsageRecord = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  scope: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  usage: Schema.Struct({
    fetchedAtMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    billingStrategy: Schema.optionalKey(Schema.String),
    dailyRemainingPercent: Percent,
    weeklyRemainingPercent: Percent,
    dailyResetAtMs: Percent,
    weeklyResetAtMs: Percent,
  }),
});

export function accountUsagePath(agentDir: string): string {
  return join(agentDir, "pi-devin", "account-usage.json");
}

const isNotOlder = (current: AccountUsage | undefined, next: AccountUsage) => !current || next.fetchedAtMs >= current.fetchedAtMs;

/** Default store so SDK callers and tests never write to the real agent directory. */
export function memoryAccountUsageStore(): AccountUsageStore {
  let record: { scope: string; usage: AccountUsage } | undefined;
  return {
    read: (scope) => Effect.sync(() => record?.scope === scope ? { ...record.usage } : undefined),
    write: (scope, usage) => Effect.sync(() => {
      if (record?.scope !== scope || isNotOlder(record.usage, usage)) record = { scope, usage: { ...usage } };
    }),
  };
}

/** An unreadable or malformed file reads as no record and is not repaired by reading. Writes are replaced atomically within the same directory. */
export function fileAccountUsageStore(path: string): AccountUsageStore {
  const readRecord = readJsonFile(path, UsageRecord);
  return {
    read: (scope) => Effect.map(readRecord, (record) => Option.isSome(record) && record.value.scope === scope ? { ...record.value.usage } : undefined),
    write: (scope, usage) => Effect.flatMap(readRecord, (current) => Option.isSome(current) && current.value.scope === scope && !isNotOlder(current.value.usage, usage)
      ? Effect.void : writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, scope, usage })),
  };
}
