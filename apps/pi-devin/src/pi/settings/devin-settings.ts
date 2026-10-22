import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { DevinError } from "../../core/errors.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

const SCHEMA_VERSION = 1;

/** Display settings toggled by `/devin`. Both default to off and never change how models are used or requested. */
export interface DevinPreferences {
  /** Lists only the models that have a variant the catalog marks as recommended. */
  recommendedOnly: boolean;
  /** Shows quota and session usage in the TUI status line. */
  showUsageStatus: boolean;
}

export const DEFAULT_PREFERENCES: DevinPreferences = { recommendedOnly: false, showUsageStatus: false };

export interface DevinSettings {
  /** Never fails: a missing or unreadable store reads as the defaults. */
  readonly read: Effect.Effect<DevinPreferences>;
  write(preferences: DevinPreferences): Effect.Effect<void, DevinError>;
}

const SettingsFile = Schema.Struct({ schemaVersion: Schema.Literal(SCHEMA_VERSION), recommendedOnly: Schema.Boolean, showUsageStatus: Schema.Boolean });

export function devinSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-devin", "settings.json");
}

/** Default store so SDK callers and tests never write to the real agent directory. */
export function memoryDevinSettings(initial: Partial<DevinPreferences> = {}): DevinSettings {
  let current: DevinPreferences = { ...DEFAULT_PREFERENCES, ...initial };
  return {
    read: Effect.sync(() => ({ ...current })),
    write: (preferences) => Effect.sync(() => { current = { ...preferences }; }),
  };
}

/** An unreadable or malformed file reads as the defaults and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileDevinSettings(path: string): DevinSettings {
  return {
    read: Effect.map(readJsonFile(path, SettingsFile), Option.match({
      onNone: () => ({ ...DEFAULT_PREFERENCES }),
      onSome: (value) => ({ recommendedOnly: value.recommendedOnly, showUsageStatus: value.showUsageStatus }),
    })),
    write: (preferences) => writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, ...preferences }),
  };
}
