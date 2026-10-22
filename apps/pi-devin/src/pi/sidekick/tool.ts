import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Exit, Predicate } from "effect";
import { toDevinFailure, type DevinFailure } from "../../core/errors.ts";
import { NodePlatformLayer } from "../../core/platform.ts";
import { failWith } from "../../core/validation.ts";
import { DEVIN_API, type DevinModel } from "../models.ts";
import type { DevinProvider } from "../provider.ts";
import type { SidekickLaunch } from "./command.ts";
import { FUSION_CHILD_ENV, SIDEKICK_REPORT_MESSAGE, SIDEKICK_SYSTEM_PROMPT, SIDEKICK_TOOL_NAME } from "./prompts.ts";
import { boundReport, type BoundedReport } from "./report.ts";
import { SidekickRuntime, type Handoff, type HandoffReport, type SidekickRuntimeOptions } from "./runtime.ts";

export interface SidekickDetails {
  sidekickModel: string;
  handoffId: string;
  status: HandoffReport["status"] | "running" | "background";
  toolCalls: number;
  durationMs?: number;
  isSteer: boolean;
  /** Complete report saved when the text the lead received was cut. */
  fullReportPath?: string;
}

export interface SidekickToolOptions {
  /** Pi agent directory that holds sidekick session files. */
  agentDir: () => string;
  /** Lets tests replace how the child is started. */
  runtime?: Omit<SidekickRuntimeOptions, "childEnv" | "onProgress">;
}

/** The host may copy model objects in its settings layer, so Fusion data is looked up by id in the provider's current list. */
export function fusionOf(provider: Pick<DevinProvider, "getModels">, model: Model<any> | undefined): NonNullable<DevinModel["devin"]["fusion"]> | undefined {
  if (model?.provider !== "devin" || model.api !== DEVIN_API) return undefined;
  return (provider.getModels() as readonly DevinModel[]).find((candidate) => candidate.id === model.id)?.devin.fusion;
}

const launchKey = (launch: SidekickLaunch) => JSON.stringify([launch.cwd, launch.modelID, launch.thinking, launch.sessionFile, launch.tools]);
const shortID = (id: string) => id.slice(0, 8);
const reportPath = (fullReportPath: string | undefined) => fullReportPath ? { fullReportPath } : {};
const nextMicrotask = Effect.promise(() => Promise.resolve());
/** Stops before work starts when the call was already cancelled, as `signal.throwIfAborted()` does. */
const checkAborted = (signal: AbortSignal | undefined): Effect.Effect<void, DevinFailure> => signal?.aborted ? Effect.fail(toDevinFailure(signal.reason)) : Effect.void;

/** Bound and preserve the complete report, including status, errors and any background delivery heading. */
function reportText(report: HandoffReport, heading = ""): Effect.Effect<BoundedReport> {
  const body = report.text.trim();
  const reason = report.error ?? (report.status === "aborted" ? "cancelled." : "failed.");
  const text = report.status === "completed" ? body || "(The sidekick finished without a report.)"
    : [`The sidekick task ${report.status === "aborted" ? "stopped" : "failed"}: ${reason}`, body].filter(Boolean).join("\n\n");
  return boundReport(heading + text).pipe(Effect.provide(NodePlatformLayer));
}

interface ReportDelivery {
  owner: "background" | "blocking" | "delivered";
  scheduled: boolean;
}

type WaitOutcome = "done" | "aborted" | "interrupted";

/**
 * The lead's `devin_sidekick` tool. The sidekick runs as one child Pi process per lead session and uses the lead's active tools.
 * By default it waits for the report; with `block: false`, or when a user message arrives while waiting, it moves to the background and delivers the report once.
 */
export function createSidekickTool(pi: ExtensionAPI, provider: DevinProvider, options: SidekickToolOptions) {
  const runtimes = new Map<string, SidekickRuntime>();
  // Steers share the same report; completed handoffs must not be retained by delivery bookkeeping.
  const deliveries = new WeakMap<Deferred.Deferred<HandoffReport>, ReportDelivery>();
  const waits = new Set<() => void>();
  let progressListener: (() => void) | undefined;

  const deliverLater = (handoff: Handoff, runtime: SidekickRuntime, delivery: ReportDelivery) => {
    if (delivery.scheduled || delivery.owner === "delivered") return;
    delivery.scheduled = true;
    // A blocking call owns the report unless user input moves it back to the background.
    const canDeliver = () => delivery.owner === "background" && [...runtimes.values()].includes(runtime);
    Effect.runFork(Effect.gen(function* () {
      const report = yield* Deferred.await(handoff.done);
      if (report.status === "aborted" || !canDeliver()) return;
      const { text, fullReportPath } = yield* reportText(report, `Sidekick report for background handoff ${shortID(report.id)}:\n\n`);
      if (!canDeliver()) return;
      delivery.owner = "delivered";
      pi.sendMessage({
        customType: SIDEKICK_REPORT_MESSAGE, display: true, content: text,
        details: { sidekickModel: runtime.launch.modelID, handoffId: report.id, status: report.status, toolCalls: report.toolCalls, durationMs: report.durationMs, isSteer: false,
          ...reportPath(fullReportPath) } satisfies SidekickDetails,
      }, { deliverAs: "followUp", triggerTurn: true });
    }).pipe(Effect.ensuring(Effect.sync(() => { delivery.scheduled = false; }))));
  };

  const execute = (params: unknown, signal: AbortSignal | undefined, onUpdate: Parameters<ToolDefinition["execute"]>[3], ctx: Parameters<ToolDefinition["execute"]>[4]) => Effect.gen(function* () {
    yield* checkAborted(signal);
    const fusion = fusionOf(provider, ctx.model);
    if (!fusion) return yield* failWith("The sidekick is only available with the Devin Fusion model.");
    const input = Predicate.isObject(params) ? params as { message?: unknown; block?: unknown } : undefined;
    const message = Predicate.isString(input?.message) ? input.message.trim() : "";
    if (!message) return yield* failWith("A message for the sidekick is required.");
    // The lead list hides exact UIDs covered by groups, so the level comes from the Fusion candidates.
    const sidekickChoice = provider.getFusionChoices()?.sidekicks.find((item) => item.id === fusion.sidekickID);
    if (!sidekickChoice) return yield* failWith("The sidekick model is not in the current Devin model list. Refresh the model list.");
    const sessionId = ctx.sessionManager.getSessionId();
    const launch: SidekickLaunch = {
      cwd: ctx.cwd, modelID: fusion.sidekickID, thinking: sidekickChoice.level,
      sessionFile: ctx.sessionManager.getSessionFile() ? join(options.agentDir(), "pi-devin", "sidekick", `${sessionId}.jsonl`) : undefined,
      tools: pi.getActiveTools().filter((name) => name !== SIDEKICK_TOOL_NAME),
      systemPrompt: SIDEKICK_SYSTEM_PROMPT,
    };
    let runtime = runtimes.get(sessionId);
    // When the pair or tools change, only an idle process is restarted. Context continues through the same session file.
    if (runtime && !runtime.isBusy() && launchKey(runtime.launch) !== launchKey(launch)) { yield* runtime.close; runtime = undefined; }
    if (!runtime) {
      runtime = new SidekickRuntime(launch, { ...options.runtime, childEnv: { [FUSION_CHILD_ENV]: "1" }, onProgress: () => progressListener?.() });
      runtimes.set(sessionId, runtime);
    }
    const active = runtime;
    yield* checkAborted(signal);
    const handoff = yield* active.handoff(message);
    let delivery = deliveries.get(handoff.done);
    if (!delivery) {
      delivery = { owner: "background", scheduled: false };
      deliveries.set(handoff.done, delivery);
    }
    const owned = delivery;
    const details = (status: SidekickDetails["status"], report?: HandoffReport): SidekickDetails => ({
      sidekickModel: launch.modelID, handoffId: handoff.id, status, toolCalls: report?.toolCalls ?? active.progress()?.toolCalls ?? 0,
      ...(report ? { durationMs: report.durationMs } : {}), isSteer: handoff.isSteer,
    });
    const backgroundResult = (reason: string) => {
      deliverLater(handoff, active, owned);
      return { content: [{ type: "text" as const, text: `${reason} The report will arrive as a message. (handoff ${shortID(handoff.id)})` }], details: details("background") };
    };
    if (input?.block === false) {
      return backgroundResult(handoff.isSteer ? "Added instructions to the running sidekick task." : "The sidekick started working in the background.");
    }
    owned.owner = "blocking";
    // The first event decides the outcome. The report is observed one microtask after it settles, as a promise continuation
    // would, so user input in the same tick still moves the handoff to the background.
    const decided = Deferred.makeUnsafe<WaitOutcome>();
    const decide = (outcome: WaitOutcome) => () => { Deferred.doneUnsafe(decided, Exit.succeed(outcome)); };
    const interrupt = decide("interrupted"), abort = decide("aborted");
    const listen = Effect.sync(() => {
      waits.add(interrupt);
      signal?.addEventListener("abort", abort, { once: true });
      progressListener = () => {
        const progress = active.progress();
        if (progress) onUpdate?.({ content: [{ type: "text", text: `sidekick: ${progress.toolCalls} tool calls${progress.recentTools.length ? ` · ${progress.recentTools.join(", ")}` : ""}` }], details: details("running") });
      };
      if (signal?.aborted) abort();
      Effect.runFork(Deferred.await(handoff.done).pipe(Effect.andThen(nextMicrotask), Effect.andThen(Effect.sync(decide("done")))));
    });
    const stopListening = Effect.sync(() => {
      progressListener = undefined;
      waits.delete(interrupt);
      signal?.removeEventListener("abort", abort);
    });
    const outcome = yield* Effect.acquireUseRelease(listen, () => Deferred.await(decided), () => stopListening);
    if (outcome === "interrupted") {
      owned.owner = "background";
      return backgroundResult("A user message arrived, so the sidekick task moved to the background.");
    }
    owned.owner = "delivered";
    if (outcome === "aborted") {
      yield* active.abort;
      return yield* failWith("Cancelled the sidekick task.");
    }
    const report = yield* Deferred.await(handoff.done);
    const { text, fullReportPath } = yield* reportText(report);
    if (report.status !== "completed") return yield* failWith(text);
    return { content: [{ type: "text" as const, text }], details: { ...details(report.status, report), ...reportPath(fullReportPath) } };
  });

  const definition: ToolDefinition = {
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
    execute: (_toolCallId, params, signal, onUpdate, ctx) => Effect.runPromise(execute(params, signal, onUpdate, ctx)),
  };

  const closeAll = (entries: readonly [string, SidekickRuntime][]) => {
    for (const [id, runtime] of entries) { Effect.runSync(runtime.close); runtimes.delete(id); }
  };

  return {
    definition,
    /** On user input, a waiting handoff moves to the background. Input sent by extensions does not count. */
    onInput(source: string): void {
      if (source === "extension") return;
      for (const interrupt of [...waits]) interrupt();
    },
    /** Cleans up the sidekick of a different lead session. */
    onSessionStart(sessionId: string): void {
      closeAll([...runtimes].filter(([id]) => id !== sessionId));
    },
    reset(): void {
      closeAll([...runtimes]);
    },
  };
}
