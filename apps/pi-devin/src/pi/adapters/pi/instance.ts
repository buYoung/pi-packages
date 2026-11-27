import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, type Layer } from "effect";
import { ExtensionConfig } from "../../app/config.ts";
import type { ExtensionEnvironment } from "../../app/layer.ts";
import { makeExtensionRuntime, type ExtensionServices } from "../../app/runtime.ts";
import { attachSession, shutdownProvider } from "../../app/session.ts";
import { fusionOf } from "../../features/catalog/fusion.ts";
import { ModelCatalog } from "../../features/catalog/service.ts";
import { DEVIN_STATE_ENTRY } from "../../features/runs/entry.ts";
import { Runs } from "../../features/runs/service.ts";
import { SIDEKICK_TOOL_NAME } from "../../features/sidekick/prompts.ts";
import { Sidekicks } from "../../features/sidekick/service.ts";
import { runDevinCommand } from "./devin-command.ts";
import { runFusionCommand } from "./fusion-command.ts";
import { makeDevinProvider } from "./provider.ts";
import { PiSidekickHost, sidekickTool } from "./sidekick-tool.ts";
import type { DevinInstance, RunEvent } from "./types.ts";
import { UsageStatus } from "./usage-status.ts";

/**
 * Builds one extension instance: its runtime and services and the behavior the registration calls. It registers nothing with Pi.
 * Pi's event handlers run their effects synchronously and return after the services finished, so the next event sees the result.
 * A failed layer build throws here.
 */
export function makeDevinInstance(pi: ExtensionAPI, environment: Layer.Layer<ExtensionEnvironment>): DevinInstance {
  const runtime = makeExtensionRuntime(environment, PiSidekickHost(pi));
  const run = <A, E>(effect: Effect.Effect<A, E, ExtensionServices>) => runtime.runSync(effect);
  const { isFusionChild } = run(ExtensionConfig);
  const isLead = !isFusionChild;
  const catalog = run(ModelCatalog), runs = run(Runs), sidekicks = run(Sidekicks), status = run(UsageStatus);
  const provider = makeDevinProvider(runtime);
  // Enables the sidekick only for the Fusion model and leaves other extensions' and the user's active tools alone.
  const syncSidekick = (model: Model<any> | undefined) => {
    if (!isLead) return;
    const active = pi.getActiveTools(), isActive = active.includes(SIDEKICK_TOOL_NAME);
    const shouldBeActive = fusionOf(run(catalog.models), model) !== undefined;
    if (shouldBeActive && !isActive) pi.setActiveTools([...active, SIDEKICK_TOOL_NAME]);
    else if (!shouldBeActive && isActive) pi.setActiveTools(active.filter((name) => name !== SIDEKICK_TOOL_NAME));
  };
  const runEvent = (event: RunEvent) => {
    switch (event.type) {
      case "before_agent_start": return runs.begin("agent");
      case "agent_start": return runs.agentStarted;
      case "agent_settled": return runs.finish;
      case "session_before_compact": return runs.beforeCompaction(event.reason);
      case "session_compact": case "session_compact_failed": return runs.afterCompaction(event.reason);
      case "session_before_tree": return runs.beforeTree;
      case "session_tree": return runs.treeChanged;
    }
  };
  return {
    runtime, provider,
    isInAuxiliaryPhase: () => run(runs.isInAuxiliaryPhase),
    sidekickTool: isLead ? sidekickTool(runtime) : undefined,
    devinCommand: (args, context) => runDevinCommand(args, context, runtime),
    fusionCommand: (args, context) => runFusionCommand(args, context, pi, runtime),
    attachSession: (context) => run(attachSession({
      getSessionId: () => context.sessionManager.getSessionId(),
      getBranch: () => context.sessionManager.getBranch(),
      append: (data) => pi.appendEntry(DEVIN_STATE_ENTRY, data),
    })),
    sessionStarted: (context) => {
      if (isLead) run(sidekicks.sessionStarted(context.sessionManager.getSessionId()));
      syncSidekick(context.model);
      run(Effect.andThen(status.bind(context), status.update(context)));
    },
    // Pi sets the new model before this event, so the status line follows it at once.
    modelSelected: (model, context) => {
      syncSidekick(model);
      run(status.update(context));
    },
    userInput: (source) => { if (isLead) run(sidekicks.userInput(source)); },
    messageEnded: (message, context) => { run(status.update(context, message)); },
    updateStatus: (context) => { run(status.update(context)); },
    applyRunEvent: (event) => { run(runEvent(event)); },
    sessionEnding: () => {
      run(status.bind(undefined));
      if (isLead) run(sidekicks.reset);
    },
    shutdown: () => { run(shutdownProvider); },
  };
}
