import type { AuthInteraction, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { Duration, Effect, type Scope } from "effect";
import { loginAccount, type LoginOptions } from "../../core/auth/index.ts";
import { abortWith, makeCancellation, type Cancellation } from "../../core/cancellation.ts";
import { makeDevinClient, type DevinClient } from "../../core/client.ts";
import { isAuthenticationError, isTransientConnectionFailure, RPCError, toDevinFailure, type DevinError, type DevinFailure } from "../../core/errors.ts";
import type { Credential, JsonObject } from "../../core/types.ts";
import { failWith, requiredString } from "../../core/validation.ts";
import { credentialFromOAuth, credentialKey, evictOldest, OAUTH_ONLY_MESSAGE, SESSION_CHECK_INTERVAL_MS, sessionKey } from "./credential.ts";

/** Upper bound of the account check right after sign-in. Sign-in succeeds even when this check fails. */
const LOGIN_CHECK_TIMEOUT_MS = 15_000;

export interface DevinAccountAuth extends OAuthAuth {
  readonly generation: number;
  assertUsable(credential: Credential): Effect.Effect<void, RPCError>;
  /** Converts the OAuth credential stored by Pi into the shared credential and remembers it as this process's OAuth session. */
  credentialFromHost(credential: OAuthCredential): Effect.Effect<Credential, DevinError>;
  /** Rejects sessions that did not come from an OAuth login or stored credential (API keys etc.) before any network request. */
  assertOAuthSession(credential: Credential): Effect.Effect<void, DevinError>;
  /** Remembers only authentication failures confirmed in the same auth generation. The credential file is never deleted. */
  invalidate(credential: Credential, error: unknown, generation: number): Effect.Effect<void>;
}

export interface DevinAccountAuthOptions {
  loginOptions?: Omit<LoginOptions, "onURL" | "promptCode" | "flow" | "encoding">;
  createClient?: (credential: Credential) => Effect.Effect<DevinClient, DevinError, Scope.Scope>;
  onLogin?: Effect.Effect<void>;
  onValidated?: (credential: Credential, ownerHash: string, status: JsonObject) => Effect.Effect<void>;
  onInvalidated?: (credential: Credential, error: RPCError) => Effect.Effect<void>;
  /** The provider's lifetime; sign-in and checks stop when it ends. */
  lifetime?: () => Cancellation;
  /** The account was already checked in this process; each model request checks it again outside Pi's credential lock. */
  isAccountChecked?: (credential: Credential) => boolean;
  now?: () => number;
}

/** A host prompt that is withdrawn, through its signal, when the waiting effect is interrupted. */
const prompt = <A>(request: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: request, catch: toDevinFailure });

export function createDevinAccountAuth(options: DevinAccountAuthOptions = {}): DevinAccountAuth {
  const now = options.now ?? Date.now;
  const lifetime = options.lifetime ?? (() => makeCancellation());
  const createClient = options.createClient ?? ((credential: Credential) => makeDevinClient(credential, { profile: "login" }));
  const invalid = new Set<string>();
  // Remembers only a hash, never the token. Pi calls toAuth on every request, so the session in use moves back to the front.
  const oauthSessions = new Set<string>();
  let generation = 0;
  const assertUsable = (credential: Credential): Effect.Effect<void, RPCError> => Effect.suspend(() => invalid.has(credentialKey(credential))
    ? Effect.fail(RPCError.make("unauthenticated", "Authentication failed for this session. Sign in again with /login.")) : Effect.void);
  const rememberOAuth = (credential: Credential) => Effect.sync(() => {
    const key = sessionKey(credential);
    oauthSessions.delete(key);
    evictOldest(oauthSessions, 64);
    oauthSessions.add(key);
    return credential;
  });
  const checkAccount = (credential: Credential, expectedGeneration: number): Effect.Effect<void, DevinFailure> => Effect.scoped(Effect.gen(function* () {
    const client = yield* createClient(credential);
    const status = yield* client.status();
    if (expectedGeneration === generation && options.onValidated) {
      yield* options.onValidated(credential, yield* requiredString(yield* client.accountIdentityHash, "Devin account scope"), status);
    }
  }));
  const invalidate: DevinAccountAuth["invalidate"] = (credential, error, expectedGeneration) => Effect.suspend(() => {
    if (expectedGeneration !== generation || !isAuthenticationError(error)) return Effect.void;
    const key = credentialKey(credential);
    if (invalid.has(key)) return Effect.void;
    evictOldest(invalid, 64);
    invalid.add(key);
    return options.onInvalidated?.(credential, error) ?? Effect.void;
  });
  /** Stops the work when the caller's signal or the provider's lifetime at the start of the host call ends, failing with that reason. */
  const stoppable = (signal: AbortSignal | undefined) => {
    const current = lifetime();
    return <A, E>(effect: Effect.Effect<A, E>) => current.guard(effect).pipe(abortWith(signal));
  };

  const login = (interaction: AuthInteraction) => Effect.gen(function* () {
    const stop = stoppable(interaction.signal);
    const { choice, credential } = yield* stop(signIn(interaction));
    invalid.delete(credentialKey(credential));
    yield* rememberOAuth(credential);
    generation++;
    if (options.onLogin) yield* options.onLogin;
    // Records the new session's account and quota so the same account's model list and usage are available at once.
    // Sign-in is not a permission check: a failure here, including cancellation, is left to the first model request.
    if (options.onValidated) {
      yield* stop(checkAccount(credential, generation)).pipe(
        Effect.timeoutOrElse({ duration: Duration.millis(LOGIN_CHECK_TIMEOUT_MS), orElse: () => Effect.void }),
        Effect.ignore,
      );
    }
    interaction.notify({ type: "info", message: "Signed in to the Devin account. The server expiry time and refresh grant are unknown. If authentication fails, sign in again with /login." });
    return {
      type: "oauth", access: credential.sessionToken, refresh: "", expires: now() + SESSION_CHECK_INTERVAL_MS,
      devin: { version: 1, apiServerURL: credential.apiServerURL, createdAt: credential.createdAt, flow: choice },
    } satisfies OAuthCredential;
  });

  const signIn = (interaction: AuthInteraction) => Effect.gen(function* () {
    const choice = yield* prompt((signal) => interaction.prompt({ type: "select", signal, message: "Devin account sign-in method", options: [
      { id: "browser", label: "Browser sign-in", description: "Choose an account, then return through a loopback callback." },
      { id: "manual", label: "Manual authorization code", description: "Enter a one-time code using the Devin CLI manual flow. This is not an API key prompt." },
    ] }));
    if (choice !== "browser" && choice !== "manual") return yield* failWith("Unsupported Devin sign-in method.");
    const credential = yield* loginAccount({
      ...options.loginOptions, flow: choice,
      onURL: (url) => Effect.sync(() => interaction.notify({ type: "auth_url", url, instructions: "Return to the terminal after signing in. Signing in does not guarantee CLI access or quota." })),
      promptCode: prompt((signal) => interaction.prompt({ type: "manual_code", message: "Paste the authorization code or callback URL. Do not enter an API key or session token.", signal })),
    });
    return { choice, credential };
  });

  const refresh = (current: OAuthCredential) => Effect.gen(function* () {
    const credential = yield* credentialFromOAuth(current);
    yield* assertUsable(credential);
    yield* rememberOAuth(credential);
    // Pi calls this while holding the shared auth.json lock once the check interval has passed, and saves the result.
    // The new expiry only schedules the next check; the token is never renewed.
    const checked = (): OAuthCredential => ({ ...current, expires: now() + SESSION_CHECK_INTERVAL_MS });
    // Model requests already check the account outside the lock, so a process that checked it does not wait on the network.
    if (options.isAccountChecked?.(credential)) return checked();
    const expectedGeneration = generation;
    return yield* checkAccount(credential, expectedGeneration).pipe(
      Effect.map(checked),
      Effect.catch((error) => Effect.andThen(invalidate(credential, error, expectedGeneration),
        // An unreachable check must not block the request: keep the stored session unchanged so the model request
        // succeeds or reports its own retryable transport error, and the next use checks again.
        isTransientConnectionFailure(error) ? Effect.succeed(current) : Effect.fail(error))),
    );
  });

  return {
    name: "Devin account",
    get generation() { return generation; },
    assertUsable,
    credentialFromHost: (current) => Effect.flatMap(credentialFromOAuth(current), rememberOAuth),
    // Kept as a plain error so it does not invalidate authentication or cancel a running request.
    assertOAuthSession: (credential) => Effect.suspend(() => oauthSessions.has(sessionKey(credential)) ? Effect.void : failWith(OAUTH_ONLY_MESSAGE)),
    invalidate,
    login: (interaction) => Effect.runPromise(login(interaction)),
    refresh: (current, signal) => Effect.runPromise(stoppable(signal)(refresh(current))),
    toAuth: (current) => Effect.runPromise(Effect.gen(function* () {
      const credential = yield* credentialFromOAuth(current);
      yield* assertUsable(credential);
      yield* rememberOAuth(credential);
      // apiKey is only ModelAuth's transport field; the sign-in/storage auth type is always oauth.
      return { apiKey: credential.sessionToken, baseUrl: credential.apiServerURL };
    })),
  };
}
