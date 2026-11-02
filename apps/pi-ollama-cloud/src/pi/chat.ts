import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type CredentialResolver, resolveCredential } from "../auth/resolver.ts";
import { fetchModelDetailsEffect } from "../models/api.ts";
import { OLLAMA_BASE } from "../models/base.ts";
import { assembleModels } from "../models/metadata.ts";
import { fromPromise } from "../shared/effects.ts";

export const CHAT_TIMEOUT_MS = 120_000;
export const CHAT_PROMPT = "1+1";
export const MAX_RESPONSE_TOKENS = 4096;

/** The CLI owns its temporary host runtime and deadline; neither outlives this operation. */
export function completeOllamaChatEffect(
  modelId: string,
  signal: AbortSignal,
  resolveApiKey: CredentialResolver = resolveCredential,
  observePayload?: (payload: unknown) => void,
) {
  return Effect.gen(function* () {
    const { apiKey, env } = yield* fromPromise(() => resolveApiKey(signal));
    if (!apiKey) {
      throw new Error("Chat requires an API key. Add an Ollama Cloud key with Pi's /login or set OLLAMA_API_KEY.");
    }
    const details = yield* fetchModelDetailsEffect(modelId, signal);
    const [modelConfig] = assembleModels({ [modelId]: details });
    if (!modelConfig) {
      throw new Error(`${modelId} does not support the tool calling this extension requires. Choose another model.`);
    }
    signal.throwIfAborted();
    return yield* Effect.acquireUseRelease(
      fromPromise(() => mkdtemp(join(tmpdir(), "pi-ollama-cli-"))),
      (agentDir) =>
        Effect.gen(function* () {
          const runtime = yield* fromPromise(() =>
            ModelRuntime.create({
              authPath: join(agentDir, "auth.json"),
              modelsPath: null,
              modelsStorePath: join(agentDir, "models-cache.json"),
              refreshOnCreate: false,
              signal,
            }),
          );
          runtime.registerProvider("ollama-cloud", {
            name: "Ollama Cloud",
            api: "openai-completions",
            baseUrl: `${OLLAMA_BASE}/v1`,
            models: [modelConfig],
          });
          yield* fromPromise(() => runtime.setRuntimeApiKey("ollama-cloud", apiKey, { signal }));
          const model = runtime.getModel("ollama-cloud", modelId);
          if (!model || model.id !== modelId) {
            throw new Error(`Could not register the requested model ID with Pi: ${modelId}`);
          }
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
              return { controller, timer };
            }),
            ({ controller }) =>
              Effect.gen(function* () {
                const result = yield* fromPromise(() =>
                  runtime.completeSimple(
                    model,
                    { messages: [{ role: "user", content: CHAT_PROMPT, timestamp: Date.now() }] },
                    {
                      signal: AbortSignal.any([signal, controller.signal]),
                      maxTokens: Math.min(MAX_RESPONSE_TOKENS, model.maxTokens),
                      env,
                      onPayload: (payload) => {
                        observePayload?.(payload);
                        if (
                          payload === null ||
                          typeof payload !== "object" ||
                          Array.isArray(payload) ||
                          !("model" in payload) ||
                          payload.model !== modelId
                        ) {
                          throw new Error(
                            "Stopped the request because the model ID to send differs from the entered value.",
                          );
                        }
                      },
                    },
                  ),
                );
                signal.throwIfAborted();
                if (controller.signal.aborted) {
                  throw new Error(
                    "Chat timed out after 120 seconds and was stopped. Try again later or choose another model.",
                  );
                }
                if (result.stopReason === "error" || result.stopReason === "aborted") {
                  throw new Error(`Ollama chat failed: ${result.errorMessage ?? result.stopReason}`);
                }
                const answer = result.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("")
                  .trim();
                if (!answer) throw new Error("The model returned no text answer. Choose another model or try again.");
                return { answer, truncated: result.stopReason === "length" };
              }),
            ({ controller, timer }) =>
              Effect.sync(() => {
                clearTimeout(timer);
                controller.abort();
              }),
          );
        }),
      (agentDir) => fromPromise(() => rm(agentDir, { recursive: true, force: true })),
    );
  });
}

/** Preserve the Promise API used by the maintenance CLI and existing consumers. */
export function completeOllamaChat(
  ...args: Parameters<typeof completeOllamaChatEffect>
): Promise<{ answer: string; truncated: boolean }> {
  return Effect.runPromise(completeOllamaChatEffect(...args));
}
