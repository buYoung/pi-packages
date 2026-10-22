import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { modelCallLimit } from "./src/pi/lifecycle.ts";
import { registerDevinExtension } from "./src/pi/extension.ts";
import { devinSettingsPath, fileDevinSettings } from "./src/pi/settings/devin-settings.ts";
import { fileFusionSettings, fusionSettingsPath } from "./src/pi/settings/fusion-settings.ts";
import { accountUsagePath, fileAccountUsageStore } from "./src/pi/settings/usage-store.ts";
import { FUSION_CHILD_ENV } from "./src/pi/sidekick/prompts.ts";

/** Pi's entry point. An invalid `PI_DEVIN_MAX_MODEL_CALLS` stops loading with its error. */
export default function devinExtension(pi: ExtensionAPI): void {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  const maxModelCalls = Effect.runSync(modelCallLimit(process.env.PI_DEVIN_MAX_MODEL_CALLS));
  registerDevinExtension(pi, {
    maxModelCalls,
    isFusionChild,
    // The sidekick child records its quota too, so the lead's status shows what the sidekick used.
    accountUsage: fileAccountUsageStore(accountUsagePath(getAgentDir())),
    fusionSettings: isFusionChild ? undefined : fileFusionSettings(fusionSettingsPath(getAgentDir())),
    devinSettings: isFusionChild ? undefined : fileDevinSettings(devinSettingsPath(getAgentDir())),
  });
}
