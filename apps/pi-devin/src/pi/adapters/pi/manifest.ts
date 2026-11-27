import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SIDEKICK_TOOL_NAME } from "../../features/sidekick/prompts.ts";

/*
 * What the lead registers with Pi besides the provider, without the behavior behind it. Free of Effect, so the extension
 * entry registers it at load and loads the runtime only when one of them is used.
 */

export const DEVIN_COMMAND_NAME = "devin";
export const DEVIN_COMMAND_DESCRIPTION = "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally";
export const FUSION_COMMAND_NAME = "devin-fusion";
export const FUSION_COMMAND_DESCRIPTION = "Choose the lead and sidekick models for Devin Fusion (saved globally)";

/**
 * The lead's `devin_sidekick` tool. The sidekick runs as one child Pi process per lead session and uses the lead's active tools.
 * By default it waits for the report; with `block: false`, or when a user message arrives while waiting, it moves to the background and delivers the report once.
 */
export const SIDEKICK_TOOL: Omit<ToolDefinition, "execute"> = {
  name: SIDEKICK_TOOL_NAME,
  label: "Sidekick",
  description: "Delegate hands-on work to your persistent sidekick, a separate coding agent that shares this workspace and your tools. "
    + "Put the task context and done criteria in `message`. By default the call waits and returns the sidekick's report; "
    + "set `block` to false to continue while it works, and the report arrives later as a message. "
    + "Calling it while the sidekick is busy adds instructions to the running handoff.",
  promptSnippet: "Delegate hands-on work to a persistent sidekick agent and get its report",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Brief for the sidekick: context, the task, and done criteria." },
      block: { type: "boolean", description: "Wait for the report (default true). Use false to keep working while the sidekick runs." },
    },
    required: ["message"],
    additionalProperties: false,
  } as unknown as ToolDefinition["parameters"],
  defaultActive: false,
  executionMode: "sequential",
};
