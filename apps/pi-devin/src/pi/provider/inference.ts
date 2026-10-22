import { clampThinkingLevel, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { Cause, Effect, Stream } from "effect";
import { assertCanInfer } from "../../core/auth/access.ts";
import { abortWith, type Cancellation } from "../../core/cancellation.ts";
import { Cancelled, isAuthenticationError, isTransientConnectionFailure, RPCError, toDevinFailure, type DevinFailure } from "../../core/errors.ts";
import { ChatAccumulator } from "../../core/inference/accumulator.ts";
import { chatRequest } from "../../core/inference/request.ts";
import type { BackendModelSelection, EffectiveThinkingLevel } from "../../core/models/variants.ts";
import { endpoint } from "../../core/protocol/endpoint.ts";
import { CHAT_METHOD } from "../../core/protocol/protobuf.ts";
import { safeError } from "../../core/redaction.ts";
import type { Credential, JsonObject } from "../../core/types.ts";
import { failWith, object, requiredString, tokenCount } from "../../core/validation.ts";
import type { DevinAccountAuth } from "../auth/account-auth.ts";
import type { DevinLifecycle } from "../lifecycle.ts";
import { toDevinTranscript } from "../messages.ts";
import { hasExtendedPromptCacheRetention, isFusionModelID, type DEVIN_API, type DevinModelSource } from "../models.ts";
import { FUSION_LEAD_GUIDANCE } from "../sidekick/prompts.ts";
import { DevinResponseStream } from "../stream.ts";
import type { AccountBook } from "./accounts.ts";
import type { ClientRegistry } from "./clients.ts";

export interface InferenceDependencies {
  auth: DevinAccountAuth;
  source: DevinModelSource;
  lifecycle: DevinLifecycle;
  clients: ClientRegistry;
  accounts: AccountBook;
  lifetime: () => Cancellation;
}

/** Node and Connect report these failures as codes ("read ECONNRESET", "unavailable: …") that Pi's host retry does not match. */
function hostRetryableMessage(error: unknown, message: string): string {
  return isTransientConnectionFailure(error) ? `Connection error (${message})` : message;
}

/** Like Pi's built-in providers: the caller option wins; otherwise only PI_CACHE_RETENTION=long (provider env first) means long retention. */
function resolveCacheRetention(options: SimpleStreamOptions): NonNullable<SimpleStreamOptions["cacheRetention"]> {
  if (options.cacheRetention) return options.cacheRetention;
  return (options.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}

/** A host hook may return a value or a promise and may throw; it is withdrawn when the request stops. */
const hook = <A>(evaluate: () => A | PromiseLike<A>) => Effect.tryPromise({ try: async () => await evaluate(), catch: toDevinFailure });

/** Only a confirmed 401 of the same login generation invalidates the credential. */
export function authenticationFailed(auth: DevinAccountAuth, credential: Credential, error: unknown, generation: number): Effect.Effect<void> {
  return isAuthenticationError(error) ? auth.invalidate(credential, error, generation) : Effect.void;
}

/** Returns Pi's event stream at once and runs one Devin request behind it. */
export function streamInference(deps: InferenceDependencies, model: Model<typeof DEVIN_API>, context: TranscriptContext, requestOptions: SimpleStreamOptions = {}): AssistantMessageEventStream {
  const effectiveLevel = (requestOptions.reasoning ?? clampThinkingLevel(model, "off")) as EffectiveThinkingLevel;
  const response = new DevinResponseStream(model, "");
  const accumulator = new ChatAccumulator();
  const generation = deps.auth.generation;
  let credential: Credential | undefined, actualUID = "", isRedacted = false;

  const run = Effect.gen(function* () {
    const current: Credential = {
      version: 1, sessionToken: yield* requiredString(requestOptions.apiKey, "Devin account authentication (/login required)"),
      apiServerURL: yield* endpoint(model.baseUrl), createdAt: new Date().toISOString(),
    };
    credential = current;
    // Pi can override the OAuth value with an apiKey in models.json or a caller option. Only OAuth sessions are accepted.
    yield* deps.auth.assertOAuthSession(current);
    yield* deps.auth.assertUsable(current);
    let selected = yield* deps.source.resolve(model.id, effectiveLevel, current);
    actualUID = selected.uid;
    response.message.providerThinkingLevel = actualUID;
    if (requestOptions.maxRetries !== undefined && requestOptions.maxRetries !== 0) return yield* failWith("Devin uses Pi host retries. Only provider maxRetries 0 is supported.");
    if (requestOptions.transport && !["auto", "sse"].includes(requestOptions.transport)) return yield* failWith("Devin supports HTTP Connect streams only.");
    const cacheRetention = resolveCacheRetention(requestOptions);
    const assertCacheRetention = (selection: BackendModelSelection) => cacheRetention === "long" && !hasExtendedPromptCacheRetention(selection.variant)
      ? failWith("Long cache lifetime is not confirmed for this Devin model. Long retention is supported only for models whose catalog Prompt Cache Retention is 24h.")
      : Effect.void;
    yield* assertCacheRetention(selected);

    // The per-request account check (permission and quota) runs here, outside Pi's shared credential lock.
    const known = deps.accounts.get(current);
    yield* Effect.scoped(Effect.gen(function* () {
      const probe = yield* deps.clients.client(current, { profile: "login", fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs });
      const status = yield* probe.status();
      if (generation !== deps.auth.generation) return yield* Effect.fail(new Cancelled({ message: "The Devin authentication generation changed." }));
      yield* deps.auth.assertUsable(current);
      yield* deps.accounts.remember(current, yield* requiredString(yield* probe.accountIdentityHash, "Devin account scope"), status);
    })).pipe(
      // A check that cannot reach the server keeps the last known account; the model request reports its own failure.
      Effect.catch((error) => known && isTransientConnectionFailure(error) ? Effect.void : Effect.fail(error)),
    );
    const account = deps.accounts.get(current);
    if (!account) return yield* failWith("The Devin account check was interrupted.");
    yield* assertCanInfer(account.status);

    const lease = yield* Effect.acquireRelease(deps.lifecycle.acquire(account.ownerHash), (acquired) => acquired.release);
    const transcript = yield* toDevinTranscript(context, selected.model);
    if (isFusionModelID(model.id)) transcript.systemPrompt = [transcript.systemPrompt, FUSION_LEAD_GUIDANCE].filter(Boolean).join("\n\n");
    const maximum = requestOptions.maxTokens === undefined ? selected.model.maxOutputTokens : yield* tokenCount(requestOptions.maxTokens, "maxTokens");
    if (maximum < 1 || maximum > selected.model.maxOutputTokens) return yield* failWith("The output limit is outside the selected Devin model range.");
    const client = yield* deps.clients.client(current, { fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs,
      onRequest: (attempt) => attempt.isMetered ? lease.consume : Effect.void,
    });
    yield* lease.addCleanup(client.close);
    const request = chatRequest({ metadata: yield* client.metadata(), model: selected.uid, ...transcript, maxTokens: maximum,
      cascadeId: lease.cascadeId, trajectoryId: lease.trajectoryId, stepIndex: lease.stepIndex,
      executionId: lease.executionId, clientSessionId: requestOptions.sessionId ?? lease.sessionId,
      isAuxiliary: lease.isAuxiliary, isRecovery: lease.isRecovery, includeContext: false,
    });
    if (requestOptions.temperature !== undefined) {
      if (!Number.isFinite(requestOptions.temperature) || requestOptions.temperature < 0) return yield* failWith("temperature must be a finite value of 0 or more.");
      (yield* object(request.configuration, "configuration")).temperature = requestOptions.temperature;
    }
    if (cacheRetention === "none") for (const prompt of request.chatMessagePrompts as JsonObject[]) delete prompt.promptCacheOptions;
    const identity = JSON.stringify([request.cascadeId, request.trajectoryReference, request.executionId, request.clientSessionId]);

    const frames = client.transport.stream(CHAT_METHOD, request, {
      headers: requestOptions.headers,
      onPayload: (payload) => Effect.gen(function* () {
        const replacement = requestOptions.onPayload ? yield* hook(() => requestOptions.onPayload!(payload, model)) : undefined;
        const finalPayload = replacement === undefined ? payload : yield* object(replacement, "provider payload");
        if (JSON.stringify([finalPayload.cascadeId, finalPayload.trajectoryReference, finalPayload.executionId, finalPayload.clientSessionId]) !== identity) {
          return yield* failWith("A payload hook cannot change the owned run, session or step identifiers.");
        }
        actualUID = yield* requiredString(finalPayload.chatModelUid, "chatModelUid");
        if (actualUID !== selected.uid) {
          // An exact UID hidden from the list is re-resolved at that UID's level when the current catalog has it.
          if (!deps.source.exactLevel(actualUID)) return yield* failWith("A payload hook selected an unavailable model UID.");
          selected = yield* deps.source.resolveUID(actualUID, current);
          yield* toDevinTranscript(context, selected.model); // A model change re-checks existing image and tool limits.
          yield* assertCacheRetention(selected);
        }
        const outputLimit = yield* tokenCount((yield* object(finalPayload.configuration, "configuration")).maxTokens, "maxTokens");
        if (outputLimit < 1 || outputLimit > selected.model.maxOutputTokens) return yield* failWith("The payload hook output limit is outside the model range.");
        response.message.providerThinkingLevel = actualUID;
        return finalPayload;
      }),
      onResponse: (info) => Effect.gen(function* () {
        if (info.status === 401) yield* authenticationFailed(deps.auth, current, RPCError.make("unauthenticated", "HTTP 401", 401), generation);
        if (requestOptions.onResponse) yield* hook(() => requestOptions.onResponse!(info, model));
      }),
      onFrame: (frame) => Effect.gen(function* () {
        if (requestOptions.onProviderStreamEvent) yield* hook(() => requestOptions.onProviderStreamEvent!(structuredClone(frame.data), model));
        if (frame.isEnd && frame.data.error) return; // Connect error classification belongs to the transport.
        if (frame.data.redact === true) { isRedacted = true; yield* response.redact; }
        yield* accumulator.accept(frame.data, frame.isEnd);
        if (!frame.isEnd) yield* response.accept(frame.data, accumulator);
      }),
    });
    yield* lease.cancellation.guard(Stream.runDrain(frames));
    const result = yield* accumulator.finish;
    result.message.modelUid = actualUID;
    yield* response.finish(result);
  });

  // The scope encloses the failure report as well, so Pi sees the terminal event before the client closes and the lease lets the next request in.
  const settled = Effect.scoped(deps.lifetime().guard(run).pipe(
    abortWith(requestOptions.signal),
    // Every ending, including a defect, closes Pi's stream with exactly one terminal event.
    Effect.catchCause((cause) => Effect.gen(function* () {
      const error: DevinFailure = Cause.hasInterruptsOnly(cause) ? new Cancelled({ message: "The Devin request was interrupted." }) : toDevinFailure(Cause.squash(cause));
      if (credential) yield* authenticationFailed(deps.auth, credential, error, generation);
      accumulator.message.modelUid = actualUID || undefined;
      yield* response.fail(hostRetryableMessage(error, safeError(error, credential ? [credential.sessionToken] : [])),
        error.name === "AbortError", isRedacted ? undefined : accumulator.message);
    })),
  ));
  Effect.runFork(settled);
  return response.stream;
}
