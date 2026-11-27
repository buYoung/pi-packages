import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, type ManagedRuntime } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { SIDEKICK_REPORT_MESSAGE } from "../../features/sidekick/prompts.ts";
import { SidekickHost, Sidekicks } from "../../features/sidekick/service.ts";
import { SIDEKICK_TOOL } from "./manifest.ts";

/** The lead Pi as the sidekick sees it. */
export const PiSidekickHost = (pi: ExtensionAPI) => Layer.succeed(SidekickHost, {
  activeTools: Effect.sync(() => pi.getActiveTools()),
  deliverReport: (report) => Effect.sync(() => {
    pi.sendMessage({ customType: SIDEKICK_REPORT_MESSAGE, display: true, content: report.content, details: report.details }, { deliverAs: "followUp", triggerTurn: true });
  }),
});

/** The lead's `devin_sidekick` tool with its behavior. */
export function sidekickTool(runtime: ManagedRuntime.ManagedRuntime<Sidekicks, DevinError>): ToolDefinition {
  const sidekicks = runtime.runSync(Sidekicks);
  return {
    ...SIDEKICK_TOOL,
    execute: (_toolCallId, params, signal, onUpdate, ctx) => runtime.runPromise(sidekicks.handoff({
      params, model: ctx.model, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), isSessionSaved: Boolean(ctx.sessionManager.getSessionFile()), signal,
      onProgress: (text, details) => onUpdate?.({ content: [{ type: "text", text }], details }),
    })),
  };
}
