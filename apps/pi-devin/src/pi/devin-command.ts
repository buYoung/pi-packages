import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { toDevinFailure, type DevinError, type DevinFailure } from "../core/errors.ts";
import { DevinPanel, PREFERENCE_ITEMS } from "./devin-panel.ts";
import type { DevinProvider } from "./provider.ts";
import type { DevinPreferences, DevinSettings } from "./settings/devin-settings.ts";
import { sessionUsage, usageReport, usageStatusText } from "./usage.ts";

export const DEVIN_COMMAND_NAME = "devin";
/** The only status key this package uses. */
export const USAGE_STATUS_KEY = "devin-usage";
const USAGE = "Usage: /devin, /devin recommended on|off, /devin status on|off";
const ARGUMENT_KEYS: Readonly<Record<string, keyof DevinPreferences>> = { recommended: "recommendedOnly", status: "showUsageStatus" };

/** Pi stores a message only after every `message_end` handler ran, so a just-finished response is counted explicitly. */
function branchWith(ctx: ExtensionContext, pendingMessage: unknown): readonly unknown[] {
  const branch = ctx.sessionManager.getBranch();
  if (!pendingMessage || branch.some((entry) => entry.type === "message" && entry.message === pendingMessage)) return branch;
  return [...branch, { type: "message", message: pendingMessage }];
}

/**
 * The status is used in the TUI only. Turning the toggle off clears only this package's key.
 * Values come only from the last account status and session records; `pendingMessage` is a response not stored yet.
 */
export function updateUsageStatus(ctx: ExtensionContext, provider: DevinProvider, settings: DevinSettings, pendingMessage?: unknown): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (ctx.mode !== "tui") return;
    const text = (yield* settings.read).showUsageStatus
      ? usageStatusText(provider.getAccountUsage(), sessionUsage(branchWith(ctx, pendingMessage)), (tone, segment) => ctx.ui.theme.fg(tone, segment)) : undefined;
    ctx.ui.setStatus(USAGE_STATUS_KEY, text);
  });
}

const onOff = (value: boolean) => value ? "on" : "off";

/** Saves the settings and applies them: a changed filter rebuilds Pi's model snapshots without network. Only a failed save fails. */
function applyPreferences(ctx: ExtensionCommandContext, provider: DevinProvider, settings: DevinSettings, next: DevinPreferences): Effect.Effect<void, DevinError> {
  return Effect.gen(function* () {
    const previous = yield* settings.read;
    // A list refresh failure after saving is reported as a warning so the screen and the saved value stay in sync.
    yield* settings.write(next);
    if (previous.recommendedOnly !== next.recommendedOnly) {
      yield* provider.rebuildModels;
      // Pi keeps model and availability snapshots. Rebuild them without network so `/model` and RPC lists update immediately.
      yield* Effect.tryPromise({ try: () => ctx.modelRegistry.refresh({ providers: ["devin"], allowNetwork: false }), catch: toDevinFailure }).pipe(
        Effect.catch((error) => Effect.sync(() => ctx.ui.notify(`Settings were saved, but the model list could not be rebuilt: ${error.message}`, "warning"))),
      );
      const model = ctx.model;
      if (model?.provider === "devin" && !provider.getModels().some((item) => item.id === model.id)) {
        ctx.ui.notify(`The current model ${model.name} is now hidden from the list but stays in use for this session. To restore it when reopening the session, pick a model from the list.`, "warning");
      }
    }
    yield* updateUsageStatus(ctx, provider, settings);
  });
}

function devinCommand(args: string, ctx: ExtensionCommandContext, provider: DevinProvider, settings: DevinSettings, now: () => number): Effect.Effect<void, DevinFailure> {
  return Effect.gen(function* () {
    const report = () => usageReport(provider.getAccountUsage(), sessionUsage(ctx.sessionManager.getBranch()), Effect.runSync(provider.lifecycle.budget), now());
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) {
      const key = ARGUMENT_KEYS[tokens[0]];
      if (tokens.length !== 2 || !key || (tokens[1] !== "on" && tokens[1] !== "off")) {
        ctx.ui.notify(`Unknown argument. ${USAGE}`, "error");
        return;
      }
      const value = tokens[1] === "on";
      yield* applyPreferences(ctx, provider, settings, { ...(yield* settings.read), [key]: value });
      ctx.ui.notify(`${PREFERENCE_ITEMS.find((item) => item.key === key)!.label}: ${onOff(value)} (saved globally)`, "info");
      return;
    }
    if (ctx.mode === "tui") {
      const preferences = yield* settings.read;
      yield* Effect.tryPromise({ try: () => ctx.ui.custom<void>((tui, theme, _keybindings, done) => new DevinPanel({
        theme, report, preferences, onChange: (next) => applyPreferences(ctx, provider, settings, next),
        requestRender: () => tui.requestRender(), done: () => done(),
      })), catch: toDevinFailure });
      return;
    }
    const preferences = yield* settings.read;
    const summary = PREFERENCE_ITEMS.map((item) => `${item.label} ${onOff(preferences[item.key])}`).join(" · ");
    ctx.ui.notify([...report().map((line) => line.text), `Settings: ${summary}`, USAGE].join("\n"), "info");
  });
}

/**
 * `/devin` shows usage details and display settings. Settings are saved globally and applied immediately.
 * The TUI gets a dedicated screen; other modes use arguments and notifications.
 */
export function registerDevinCommand(pi: ExtensionAPI, provider: DevinProvider, settings: DevinSettings, options: { now?: () => number } = {}): void {
  const now = options.now ?? Date.now;
  pi.registerCommand(DEVIN_COMMAND_NAME, {
    description: "Show Devin usage and change display settings (recommended models only, usage in the status line); saved globally",
    handler: (args, ctx) => Effect.runPromise(devinCommand(args, ctx, provider, settings, now)),
  });
}
