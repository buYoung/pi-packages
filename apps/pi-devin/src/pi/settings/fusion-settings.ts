import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { DevinError } from "../../core/errors.ts";
import type { FusionSelection } from "../models.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

const SCHEMA_VERSION = 1;

/** Global store for the lead and sidekick chosen with `/devin-fusion`. Every session uses the same value. */
export interface FusionSettings {
  /** Never fails: a missing or unreadable store reads as no saved pair. */
  readonly read: Effect.Effect<FusionSelection | undefined>;
  write(selection: FusionSelection): Effect.Effect<void, DevinError>;
}

const ModelID = Schema.String.check(Schema.makeFilter((value: string) => value.trim() !== ""));
// Legacy IDs (`family:…`, `uid:…`) are read as is. `effectiveFusion` maps them to the current catalog's IDs.
const FusionFile = Schema.Struct({ schemaVersion: Schema.Literal(SCHEMA_VERSION), leadID: ModelID, sidekickID: ModelID });

export function fusionSettingsPath(agentDir: string): string {
  return join(agentDir, "pi-devin", "fusion.json");
}

/** Default store so SDK callers that register the extension directly, and tests, never write to the real agent directory. */
export function memoryFusionSettings(initial?: FusionSelection): FusionSettings {
  let current = initial;
  return {
    read: Effect.sync(() => current),
    write: (selection) => Effect.sync(() => { current = { ...selection }; }),
  };
}

/** An unreadable or malformed file reads as no saved value and is not overwritten. Writes are replaced atomically within the same directory. */
export function fileFusionSettings(path: string): FusionSettings {
  return {
    read: Effect.map(readJsonFile(path, FusionFile), Option.match({
      onNone: () => undefined,
      onSome: (value): FusionSelection => ({ leadID: value.leadID, sidekickID: value.sidekickID }),
    })),
    write: (selection) => writeJsonFile(path, { schemaVersion: SCHEMA_VERSION, leadID: selection.leadID, sidekickID: selection.sidekickID }),
  };
}
