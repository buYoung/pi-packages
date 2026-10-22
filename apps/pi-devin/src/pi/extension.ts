import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { failWith } from "../core/validation.ts";
import { registerDevinCommand, updateUsageStatus } from "./devin-command.ts";
import { registerFusionCommand } from "./fusion-command.ts";
import { DEVIN_STATE_ENTRY } from "./lifecycle.ts";
import { createDevinProvider, type DevinProvider, type DevinProviderOptions } from "./provider.ts";
import { memoryDevinSettings, type DevinSettings } from "./settings/devin-settings.ts";
import { memoryFusionSettings, type FusionSettings } from "./settings/fusion-settings.ts";
import { SIDEKICK_TOOL_NAME } from "./sidekick/prompts.ts";
import { createSidekickTool, fusionOf, type SidekickToolOptions } from "./sidekick/tool.ts";

export interface DevinExtensionOptions extends Omit<DevinProviderOptions, "fusion" | "listsAllExactModels" | "recommendedOnly" | "onAccountUsage"> {
  /** Store for the `/devin-fusion` choice. Kept in memory only when omitted. */
  fusionSettings?: FusionSettings;
  /** Store for the `/devin` display settings. Kept in memory only when omitted. */
  devinSettings?: DevinSettings;
  /** The child Pi started as the sidekick registers no Fusion model, tool or command, and no `/devin` or status line. */
  isFusionChild?: boolean;
  /** Overrides the sidekick session location and how the child starts. The default location is the Pi agent directory. */
  sidekick?: Partial<SidekickToolOptions>;
}

/** Runs a handler's effect inside Pi's synchronous event callback; a failure is reported to Pi as the handler's error. */
const runHandler = (effect: Effect.Effect<void, unknown>) => Effect.runSync(effect);

export function registerDevinExtension(pi: ExtensionAPI, options: DevinExtensionOptions = {}): DevinProvider {
  const { fusionSettings, devinSettings, isFusionChild, sidekick: sidekickOptions, ...providerOptions } = options;
  const settings = fusionSettings ?? memoryFusionSettings();
  const preferences = isFusionChild ? undefined : devinSettings ?? memoryDevinSettings();
  // Context of the current session, used to redraw the status when the quota changes outside event handlers.
  let statusContext: ExtensionContext | undefined;
  const refreshStatus = (context: ExtensionContext, pendingMessage?: unknown) => preferences ? updateUsageStatus(context, provider, preferences, pendingMessage) : Effect.void;
  // The child Pi runs on the exact UID the lead chose, so it lists every exact UID and ignores the recommended filter.
  const provider = createDevinProvider({
    ...providerOptions, fusion: isFusionChild ? false : settings.read, listsAllExactModels: isFusionChild === true,
    recommendedOnly: preferences ? Effect.map(preferences.read, (value) => value.recommendedOnly) : undefined,
    // The session may be replaced or reloaded meanwhile; its next session_start redraws.
    onAccountUsage: () => statusContext ? Effect.catchCause(refreshStatus(statusContext), () => Effect.void) : Effect.void,
  });
  pi.registerProvider(provider);
  if (preferences) registerDevinCommand(pi, provider, preferences);
  const sidekick = isFusionChild ? undefined
    : createSidekickTool(pi, provider, { agentDir: sidekickOptions?.agentDir ?? getAgentDir, runtime: sidekickOptions?.runtime });
  if (sidekick) {
    pi.registerTool(sidekick.definition);
    registerFusionCommand(pi, provider, settings);
  }
  // Enables the sidekick only for the Fusion model and leaves other extensions' and the user's active tools alone.
  const syncSidekick = (model: Model<any> | undefined) => {
    if (!sidekick) return;
    const active = pi.getActiveTools(), isActive = active.includes(SIDEKICK_TOOL_NAME);
    const shouldBeActive = fusionOf(provider, model) !== undefined;
    if (shouldBeActive && !isActive) pi.setActiveTools([...active, SIDEKICK_TOOL_NAME]);
    else if (!shouldBeActive && isActive) pi.setActiveTools(active.filter((name) => name !== SIDEKICK_TOOL_NAME));
  };
  pi.on("model_select", (event) => { syncSidekick(event.model); });
  pi.on("input", (event) => { sidekick?.onInput(event.source); });
  pi.on("session_start", (_event, context) => {
    if (context.modelRegistry.getRegisteredNativeProvider("devin") !== provider) {
      provider.shutdown();
      runHandler(failWith("The Devin provider ID collides with another registration. Remove the duplicate extension and reload."));
    }
    provider.attachSession({
      getSessionId: () => context.sessionManager.getSessionId(),
      getBranch: () => context.sessionManager.getBranch(),
      append: (data) => pi.appendEntry(DEVIN_STATE_ENTRY, data),
    });
    sidekick?.onSessionStart(context.sessionManager.getSessionId());
    syncSidekick(context.model);
    statusContext = context;
    runHandler(refreshStatus(context));
  });
  pi.on("message_end", (event, context) => {
    if (event.message.role === "assistant" && event.message.provider === "devin") runHandler(refreshStatus(context, event.message));
  });
  // Subagents and other sessions record quota in the shared store; any model's turn picks it up.
  pi.on("turn_end", (_event, context) => { runHandler(refreshStatus(context)); });
  pi.on("before_agent_start", () => { runHandler(provider.lifecycle.begin("agent")); });
  pi.on("agent_start", () => { runHandler(provider.lifecycle.agentStarted); });
  // Host retry or overflow recovery can continue after agent_end.
  pi.on("agent_settled", (_event, context) => { runHandler(Effect.andThen(provider.lifecycle.finish, refreshStatus(context))); });
  pi.on("session_before_compact", (event) => { runHandler(provider.lifecycle.beforeCompaction(event.reason)); });
  pi.on("session_compact", (event) => { runHandler(provider.lifecycle.afterCompaction(event.reason)); });
  pi.on("session_compact_failed", (event) => { runHandler(provider.lifecycle.afterCompaction(event.reason)); });
  pi.on("session_before_tree", (event) => { if (event.preparation.userWantsSummary) runHandler(provider.lifecycle.beforeTree); });
  pi.on("session_tree", (_event, context) => { runHandler(Effect.andThen(provider.lifecycle.treeChanged, refreshStatus(context))); });
  pi.on("cache_warming_decision", (_event, context) => context.model?.provider === "devin" ? { action: "stop" } : undefined);
  pi.on("session_shutdown", () => { statusContext = undefined; sidekick?.reset(); provider.shutdown(); });
  return provider;
}
