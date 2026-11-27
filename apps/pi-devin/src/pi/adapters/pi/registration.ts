import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEVIN_STATE_ENTRY } from "../../features/runs/entry.ts";
import { SIDEKICK_TOOL_NAME } from "../../features/sidekick/prompts.ts";
import { makeLazyProvider } from "./lazy-provider.ts";
import { DEVIN_COMMAND_DESCRIPTION, DEVIN_COMMAND_NAME, FUSION_COMMAND_DESCRIPTION, FUSION_COMMAND_NAME, SIDEKICK_TOOL } from "./manifest.ts";
import { isSessionRoutingProvider, makeSessionRouting } from "./session-routing.ts";
import type { DevinInstance, DevinProvider, RunEvent } from "./types.ts";

const COLLISION_MESSAGE = "The Devin provider ID collides with another registration. Remove the duplicate extension and reload.";

export interface RegistrationOptions {
  readonly isFusionChild: boolean;
  /** The instance, or how to load it on first use. */
  readonly instance: DevinInstance | (() => Promise<DevinInstance>);
  /** Pi's agent directory, which holds the global settings files. */
  readonly agentDir: () => string;
  readonly now?: () => number;
}

/** A registered extension instance: the provider Pi holds and the instance behind it once loaded. */
export interface DevinRegistration {
  readonly provider: DevinProvider;
  readonly loaded: () => DevinInstance | undefined;
  readonly load: () => Promise<DevinInstance>;
}

const isDevinModel = (model: { provider?: string } | undefined) => model?.provider === "devin";

/**
 * Registers one extension instance with Pi: the provider and, for the lead, the sidekick tool, `/devin` and `/devin-fusion`.
 * The registered provider sends each call to the instance of the session that made it, as sessions sharing a model runtime require.
 *
 * This module and what it imports are free of Effect. The instance behind the registrations, with its runtime, loads on first
 * use: a session that starts on a Devin model or carries a Devin run state, a switch to a Devin model, a command, the tool,
 * sign-in, the session check, a request, or a model refresh the provider cannot answer itself. Until then the events that move
 * a session's run state are kept and replayed once it loads, so it reaches the state it would have had from the start.
 */
export function registerDevinExtension(pi: ExtensionAPI, options: RegistrationOptions): DevinRegistration {
  const isLead = !options.isFusionChild;
  const now = options.now ?? Date.now;
  let loaded = typeof options.instance === "function" ? undefined : options.instance;
  let loading: Promise<DevinInstance> | undefined;
  /** The attached session before the instance loaded, the run events since it started, and whether it is compacting or summarizing. */
  let coldSession: ExtensionContext | undefined, runLog: RunEvent[] = [], isColdAuxiliary = false, hasShutDown = false;

  const catchUp = (instance: DevinInstance) => {
    if (coldSession) {
      instance.attachSession(coldSession);
      instance.sessionStarted(coldSession);
      for (const event of runLog) instance.applyRunEvent(event);
    } else if (hasShutDown) instance.shutdown();
    coldSession = undefined; runLog = [];
  };
  const load = (): Promise<DevinInstance> => {
    if (loaded) return Promise.resolve(loaded);
    const source = options.instance as () => Promise<DevinInstance>;
    loading ??= source().then(async (instance) => {
      await lazy.handOver(instance);
      lazy.activate(instance);
      loaded = instance;
      catchUp(instance);
      return instance;
    }).finally(() => { loading = undefined; });
    return loading;
  };
  const lazy = makeLazyProvider({ load, isLoading: () => loading !== undefined, agentDir: options.agentDir, now });
  if (loaded) lazy.activate(loaded);
  const routing = makeSessionRouting(lazy.provider, () => loaded ? loaded.isInAuxiliaryPhase() : isColdAuxiliary);
  const { provider } = routing;
  pi.registerProvider(provider);
  if (isLead) {
    pi.registerCommand(DEVIN_COMMAND_NAME, { description: DEVIN_COMMAND_DESCRIPTION, handler: async (args, ctx) => (await load()).devinCommand(args, ctx) });
    pi.registerTool({ ...SIDEKICK_TOOL, execute: async (...args) => (await load()).sidekickTool!.execute(...args) });
    pi.registerCommand(FUSION_COMMAND_NAME, { description: FUSION_COMMAND_DESCRIPTION, handler: async (args, ctx) => (await load()).fusionCommand(args, ctx) });
  }
  // Before the instance loads, the session's model is no Devin model, so the sidekick, which only the Fusion model uses, is off.
  const disableSidekick = () => {
    if (!isLead) return;
    const active = pi.getActiveTools();
    if (active.includes(SIDEKICK_TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== SIDEKICK_TOOL_NAME));
  };
  /** Applies a run event to the loaded instance, or keeps it for the instance to replay. */
  const runEvent = (event: RunEvent, context: ExtensionContext | undefined) => {
    if (loaded) {
      loaded.applyRunEvent(event);
      if (context) loaded.updateStatus(context);
      return;
    }
    runLog.push(event);
    if (event.type === "session_before_compact" || event.type === "session_before_tree") isColdAuxiliary = true;
    else if (event.type === "session_compact" || event.type === "session_compact_failed") isColdAuxiliary = false;
    // A finished run or a new trajectory leaves nothing a later load has to replay.
    if (event.type === "agent_settled" || event.type === "session_tree") { runLog = []; isColdAuxiliary = false; }
  };

  pi.on("model_select", (event, context) => {
    if (loaded) return loaded.modelSelected(event.model, context);
    if (!isDevinModel(event.model)) return disableSidekick();
    return load().then((instance) => instance.modelSelected(event.model, context));
  });
  pi.on("input", (event) => { loaded?.userInput(event.source); });
  pi.on("session_start", (_event, context) => {
    const { modelRegistry, sessionManager } = context;
    // Another session's instance in the same model runtime registered its own routing provider, which reaches this one too.
    const registered = modelRegistry.getRegisteredNativeProvider("devin");
    if (registered !== provider && !isSessionRoutingProvider(registered)) {
      routing.detach();
      // An instance still loading starts shut down too.
      coldSession = undefined; runLog = []; hasShutDown = true;
      loaded?.shutdown();
      throw new Error(COLLISION_MESSAGE);
    }
    const start = (instance: DevinInstance) => {
      instance.attachSession(context);
      routing.attach(() => sessionManager.getSessionId(), modelRegistry);
      instance.sessionStarted(context);
    };
    hasShutDown = false;
    if (loaded) return start(loaded);
    const carriesRunState = sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === DEVIN_STATE_ENTRY);
    if (isDevinModel(context.model) || carriesRunState) {
      coldSession = undefined; runLog = [];
      return load().then(start);
    }
    coldSession = context; runLog = []; isColdAuxiliary = false;
    routing.attach(() => sessionManager.getSessionId(), modelRegistry);
    disableSidekick();
  });
  pi.on("message_end", (event, context) => {
    if (event.message.role === "assistant" && event.message.provider === "devin") loaded?.messageEnded(event.message, context);
  });
  // Subagents and other sessions record quota in the shared store; any model's turn picks it up.
  pi.on("turn_end", (_event, context) => { loaded?.updateStatus(context); });
  pi.on("before_agent_start", () => { runEvent({ type: "before_agent_start" }, undefined); });
  pi.on("agent_start", () => { runEvent({ type: "agent_start" }, undefined); });
  // Host retry or overflow recovery can continue after agent_end.
  pi.on("agent_settled", (_event, context) => { runEvent({ type: "agent_settled" }, context); });
  pi.on("session_before_compact", (event) => { runEvent({ type: "session_before_compact", reason: event.reason }, undefined); });
  pi.on("session_compact", (event) => { runEvent({ type: "session_compact", reason: event.reason }, undefined); });
  pi.on("session_compact_failed", (event) => { runEvent({ type: "session_compact_failed", reason: event.reason }, undefined); });
  pi.on("session_before_tree", (event) => { if (event.preparation.userWantsSummary) runEvent({ type: "session_before_tree" }, undefined); });
  pi.on("session_tree", (_event, context) => { runEvent({ type: "session_tree" }, context); });
  pi.on("cache_warming_decision", (_event, context) => context.model?.provider === "devin" ? { action: "stop" } : undefined);
  pi.on("session_shutdown", () => {
    hasShutDown = true;
    coldSession = undefined; runLog = []; isColdAuxiliary = false;
    loaded?.sessionEnding();
    routing.detach();
    loaded?.shutdown();
  });
  return { provider, loaded: () => loaded, load };
}
