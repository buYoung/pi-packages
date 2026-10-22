import type { EffectiveThinkingLevel } from "../../core/models/variants.ts";

export const DEVIN_API = "devin-connect";
export const CATALOG_VERSION = 1;
/** Default sidekick when nothing is saved or the saved one is gone. The default lead is the group this UID belongs to. */
export const FUSION_SIDEKICK_UID = "swe-2-medium";
/** The single Fusion entry shown in `/model`. Lead and sidekick follow the global `/devin-fusion` choice. */
export const FUSION_MODEL_ID = "fusion";

/** The lead is a published group model ID; the sidekick is an exact variant model ID. Both come from `publicModelIDs`. */
export interface FusionSelection { leadID: string; sidekickID: string }
export interface FusionChoices {
  leads: { id: string; name: string; recommended?: true }[];
  /** `level` is the thinking level of this UID. It is passed to the sidekick child Pi as is. */
  sidekicks: { id: string; name: string; groupName: string; level: EffectiveThinkingLevel; recommended?: true }[];
}

export function isFusionModelID(id: string): boolean { return id === FUSION_MODEL_ID; }
