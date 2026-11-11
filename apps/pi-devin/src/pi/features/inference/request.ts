import { clampThinkingLevel, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Stream } from "effect";
import { assertCanInfer } from "../../../core/auth/access.ts";
import { abortWith } from "../../../core/cancellation.ts";
import { Cancelled, isTransientConnectionFailure, RPCError, toDevinFailure, type DevinFailure } from "../../../core/errors.ts";
import { ChatAccumulator } from "../../../core/inference/accumulator.ts";
import { chatRequest } from "../../../core/inference/request.ts";
import type { BackendModelSelection, EffectiveThinkingLevel } from "../../../core/models/variants.ts";
import { endpoint } from "../../../core/protocol/endpoint.ts";
import { CHAT_METHOD, chatRequestCodec } from "../../../core/protocol/protobuf.ts";
import { safeError } from "../../../core/redaction.ts";
import type { ChatMessage, Credential, JsonObject } from "../../../core/types.ts";
import { failWith, object, requiredString, tokenCount } from "../../../core/validation.ts";
import { DevinResponseStream } from "../../adapters/pi/response-stream.ts";
import { toDevinTranscript } from "../../adapters/pi/transcript.ts";
import type { AccountsShape } from "../accounts/types.ts";
import type { AuthStateShape, CredentialGuardShape } from "../auth/types.ts";
import { isFusionModelID } from "../catalog/constants.ts";
import { hasExtendedPromptCacheRetention } from "../catalog/projection.ts";
import type { DevinAPI, ModelCatalogShape } from "../catalog/types.ts";
import type { DevinClientsShape } from "../clients/types.ts";
import type { ProviderLifetimeShape } from "../lifetime/types.ts";
import type { DevinLifecycle } from "../runs/lifecycle.ts";
import { FUSION_LEAD_GUIDANCE } from "../sidekick/prompts.ts";
import { withoutOldToolImages } from "./image-age.ts";
import { fitImages } from "./image-budget.ts";
import type { ImageCompressorShape } from "./types.ts";

/** Services one request uses, resolved once when the inference service is built. */
export interface InferenceDependencies {
  images: ImageCompressorShape;
  auth: AuthStateShape;
  guard: CredentialGuardShape;
  catalog: ModelCatalogShape;
  accounts: AccountsShape;
  clients: DevinClientsShape;
  runs: DevinLifecycle;
  lifetime: ProviderLifetimeShape;
}

/** One provider call: Pi's event stream, returned at once, and the request that feeds it. */
export interface InferenceRequest {
  stream: AssistantMessageEventStream;
  /** Never fails: every ending closes the stream with exactly one terminal event. */
  run: Effect.Effect<void>;
}

/** Connect codes of passing server trouble, in the words Pi's host retry matches. */
const CONNECT_RETRY_LABELS: Readonly<Record<string, string>> = {
  resource_exhausted: "Rate limit", internal: "Internal error", deadline_exceeded: "Request timed out",
};

/**
 * Pi decides host retries from the message text alone. Node and Connect report failures as codes ("read ECONNRESET",
 * "resource_exhausted: …") and an error body replaces the HTTP status, so the status or code is kept in words Pi matches.
 * The original detail stays, so Pi's rules against retrying quota and billing errors still apply.
 */
function hostRetryableMessage(error: unknown, message: string): string {
  if (isTransientConnectionFailure(error)) return `Connection error (${message})`;
  if (!(error instanceof RPCError)) return message;
  if (error.httpStatus !== undefined && error.httpStatus >= 400) return message.includes(String(error.httpStatus)) ? message : `HTTP ${error.httpStatus} (${message})`;
  const label = CONNECT_RETRY_LABELS[error.code];
  return label ? `${label} (${message})` : message;
}

/** Like Pi's built-in providers: the caller option wins; otherwise only PI_CACHE_RETENTION=long (provider env first) means long retention. */
function resolveCacheRetention(options: SimpleStreamOptions): NonNullable<SimpleStreamOptions["cacheRetention"]> {
  if (options.cacheRetention) return options.cacheRetention;
  return (options.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}

/** A host hook may return a value or a promise and may throw; it is withdrawn when the request stops. */
const hook = <A>(evaluate: () => A | PromiseLike<A>) => Effect.tryPromise({ try: async () => await evaluate(), catch: toDevinFailure });

/** The margin Pi's own providers keep between the estimated input and the context window. */
const CONTEXT_SAFETY_TOKENS = 4096;

/**
 * Limits the output to the room the input leaves in the Pi model's window, as Pi's own providers do, so a full context ends
 * in a `length` stop that Pi recovers from by compacting. The input is estimated the way Pi's compaction does: the tokens
 * the latest usable response reported, plus an estimate of the messages after it.
 */
function outputLimitForContext(model: Model<DevinAPI>, context: TranscriptContext, requested: number): number {
  if (model.contextWindow <= 0) return requested;
  const { messages } = context;
  let tokens = 0, trailingStart = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
    const reported = calculateContextTokens(message.usage);
    if (reported > 0) { tokens = reported; trailingStart = index + 1; break; }
  }
  for (const message of messages.slice(trailingStart)) tokens += estimateTokens(message);
  return Math.min(requested, Math.max(1, model.contextWindow - tokens - CONTEXT_SAFETY_TOKENS));
}

/**
 * Prepares one request synchronously: the response stream (with its start event), the sign-in generation
 * and the provider lifetime current at the call. The returned `run` sends the request and reports into the stream.
 */
export const prepareRequest = (deps: InferenceDependencies, model: Model<DevinAPI>, context: TranscriptContext, requestOptions: SimpleStreamOptions = {}): Effect.Effect<InferenceRequest> => Effect.gen(function* () {
  const effectiveLevel = (requestOptions.reasoning ?? clampThinkingLevel(model, "off")) as EffectiveThinkingLevel;
  const response = new DevinResponseStream(model, "");
  const accumulator = new ChatAccumulator();
  const generation = yield* deps.auth.generation;
  const lifetime = yield* deps.lifetime.current;
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
    let selected = yield* deps.catalog.resolve(model.id, effectiveLevel, current);
    actualUID = selected.uid;
    response.message.providerThinkingLevel = actualUID;
    // Retries belong to Pi and the only transport is a Connect stream, so `maxRetries` and `transport` preferences are ignored.
    const cacheRetention = resolveCacheRetention(requestOptions);
    const assertCacheRetention = (selection: BackendModelSelection) => cacheRetention === "long" && !hasExtendedPromptCacheRetention(selection.variant)
      ? failWith("Long cache lifetime is not confirmed for this Devin model. Long retention is supported only for models whose catalog Prompt Cache Retention is 24h.")
      : Effect.void;
    yield* assertCacheRetention(selected);

    // The per-request account check (permission and quota) runs here, outside Pi's shared credential lock.
    const known = yield* deps.accounts.get(current);
    yield* deps.accounts.check(current, {
      expectedGeneration: generation,
      connection: { fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs },
      beforeRecord: deps.auth.assertUsable(current),
    }).pipe(
      Effect.flatMap((outcome) => outcome === "stale" ? Effect.fail(new Cancelled({ message: "The Devin authentication generation changed." })) : Effect.void),
      // A check that cannot reach the server keeps the last known account; the model request reports its own failure.
      Effect.catch((error) => known && isTransientConnectionFailure(error) ? Effect.void : Effect.fail(error)),
    );
    const account = yield* deps.accounts.get(current);
    if (!account) return yield* failWith("The Devin account check was interrupted.");
    yield* assertCanInfer(account.status);

    const lease = yield* Effect.acquireRelease(deps.runs.acquire(account.ownerHash), (acquired) => acquired.release);
    const sent = withoutOldToolImages(context);
    const transcript = yield* toDevinTranscript(sent, selected.model);
    if (isFusionModelID(model.id)) transcript.systemPrompt = [transcript.systemPrompt, FUSION_LEAD_GUIDANCE].filter(Boolean).join("\n\n");
    const requested = requestOptions.maxTokens === undefined ? selected.model.maxOutputTokens : yield* tokenCount(requestOptions.maxTokens, "maxTokens");
    const maximum = outputLimitForContext(model, context, requested);
    if (maximum < 1 || maximum > selected.model.maxOutputTokens) return yield* failWith("The output limit is outside the selected Devin model range.");
    const client = yield* deps.clients.open(current, { fetch: requestOptions.fetch, timeoutMs: requestOptions.timeoutMs,
      onRequest: (attempt) => attempt.isMetered ? lease.assertAttempt : Effect.void,
    });
    yield* lease.addCleanup(client.close);
    const metadata = yield* client.metadata();
    const requestWith = (messages: ChatMessage[]) => chatRequest({ metadata, model: selected.uid, ...transcript, messages, maxTokens: maximum,
      cascadeId: lease.cascadeId, trajectoryId: lease.trajectoryId, stepIndex: lease.stepIndex,
      executionId: lease.executionId, clientSessionId: requestOptions.sessionId ?? lease.sessionId,
      isAuxiliary: lease.isAuxiliary, isRecovery: lease.isRecovery, includeContext: false,
    });
    const request = requestWith(yield* fitImages(transcript.messages, {
      compressor: deps.images,
      headerBytes: Buffer.byteLength(transcript.systemPrompt) + Buffer.byteLength(JSON.stringify(transcript.tools)),
      measure: (messages) => Effect.map(chatRequestCodec.encode(requestWith(messages)), (bytes) => bytes.byteLength),
    }));
    if (requestOptions.temperature !== undefined) {
      if (!Number.isFinite(requestOptions.temperature) || requestOptions.temperature < 0) return yield* failWith("temperature must be a finite value of 0 or more.");
      (yield* object(request.configuration, "configuration")).temperature = requestOptions.temperature;
    }
    // Like Pi's Anthropic provider, mark only the newest user or tool message: Claude honours a few cache breakpoints per
    // request and ignores later marks, so marking every message would stop the cached prefix from growing.
    const prompts = request.chatMessagePrompts as JsonObject[];
    const newestMark = cacheRetention === "none" ? -1 : prompts.findLastIndex((prompt) => prompt.promptCacheOptions !== undefined);
    prompts.forEach((prompt, index) => { if (index !== newestMark) delete prompt.promptCacheOptions; });
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
          if (!(yield* deps.catalog.exactLevel(actualUID))) return yield* failWith("A payload hook selected an unavailable model UID.");
          selected = yield* deps.catalog.resolveUID(actualUID, current);
          yield* toDevinTranscript(sent, selected.model); // A model change re-checks existing image and tool limits.
          yield* assertCacheRetention(selected);
        }
        const outputLimit = yield* tokenCount((yield* object(finalPayload.configuration, "configuration")).maxTokens, "maxTokens");
        if (outputLimit < 1 || outputLimit > selected.model.maxOutputTokens) return yield* failWith("The payload hook output limit is outside the model range.");
        response.message.providerThinkingLevel = actualUID;
        return finalPayload;
      }),
      onResponse: (info) => Effect.gen(function* () {
        if (info.status === 401) yield* deps.guard.reportFailure(current, RPCError.make("unauthenticated", "HTTP 401", 401), generation);
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
  const settled = Effect.scoped(lifetime.guard(run).pipe(
    abortWith(requestOptions.signal),
    // Every ending, including a defect, closes Pi's stream with exactly one terminal event.
    Effect.catchCause((cause) => Effect.gen(function* () {
      const error: DevinFailure = Cause.hasInterruptsOnly(cause) ? new Cancelled({ message: "The Devin request was interrupted." }) : toDevinFailure(Cause.squash(cause));
      if (credential) yield* deps.guard.reportFailure(credential, error, generation);
      accumulator.message.modelUid = actualUID || undefined;
      yield* response.fail(hostRetryableMessage(error, safeError(error, credential ? [credential.sessionToken] : [])),
        error.name === "AbortError", isRedacted ? undefined : accumulator.message);
    })),
  ));
  return { stream: response.stream, run: settled };
});
