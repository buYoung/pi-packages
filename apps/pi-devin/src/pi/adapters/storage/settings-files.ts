import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FusionSelection } from "../../features/catalog/types.ts";
import type { DevinPreferences } from "../../features/settings/types.ts";

/*
 * Where the global settings files live and how their contents read, free of Effect: the file stores use these rules, and the
 * extension entry reads the same files to tell whether it can show the stored model list before it loads the runtime.
 */

export const SETTINGS_SCHEMA_VERSION = 1;

export const fusionSettingsPath = (agentDir: string) => join(agentDir, "pi-devin", "fusion.json");
export const devinSettingsPath = (agentDir: string) => join(agentDir, "pi-devin", "settings.json");
export const accountUsagePath = (agentDir: string) => join(agentDir, "pi-devin", "account-usage.json");

/** A file's parsed JSON, or whether it is missing or failed to read or parse. */
export type SettingsFileRead = { readonly value: unknown } | { readonly isMissing: true } | { readonly isMissing: false };

export function readSettingsFile(path: string): SettingsFileRead {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { return { isMissing: (error as { code?: unknown }).code === "ENOENT" }; }
  try { return { value: JSON.parse(text) }; } catch { return { isMissing: false }; }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// Legacy IDs (`family:…`, `uid:…`) are read as is. `effectiveFusion` maps them to the current catalog's IDs.
const isModelID = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** The saved Fusion pair of a `fusion.json` value, or undefined for anything malformed. */
export function fusionSelectionFromFile(value: unknown): FusionSelection | undefined {
  if (!isObject(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION || !isModelID(value.leadID) || !isModelID(value.sidekickID)) return undefined;
  return { leadID: value.leadID, sidekickID: value.sidekickID };
}

/** The display settings of a `settings.json` value, or undefined for anything malformed. */
export function preferencesFromFile(value: unknown): DevinPreferences | undefined {
  if (!isObject(value) || value.schemaVersion !== SETTINGS_SCHEMA_VERSION || typeof value.recommendedOnly !== "boolean" || typeof value.showUsageStatus !== "boolean") return undefined;
  return { recommendedOnly: value.recommendedOnly, showUsageStatus: value.showUsageStatus };
}
