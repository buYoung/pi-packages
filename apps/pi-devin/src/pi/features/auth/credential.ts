import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { toDevinError, type DevinError } from "../../../core/errors.ts";
import type { Credential } from "../../../core/types.ts";
import { failWith } from "../../../core/validation.ts";
import { checkOAuthCredential } from "./oauth-credential.ts";

export const OAUTH_ONLY_MESSAGE = "Devin uses only the OAuth account session from /login. API key authentication is not supported.";
/**
 * Pi checks the stored session again after this interval. It is not a server TTL: the server expiry is unknown, no new token
 * is issued, and each model request still checks the account outside Pi's credential lock.
 */
export const SESSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function credentialFromOAuth(credential: OAuthCredential): Effect.Effect<Credential, DevinError> {
  return Effect.suspend(() => {
    const checked = checkOAuthCredential(credential);
    if ("credential" in checked) return Effect.succeed(checked.credential);
    return checked.cause === undefined ? failWith(checked.problem) : Effect.fail(toDevinError(checked.cause));
  });
}

export function credentialKey(credential: Credential): string {
  return createHash("sha256").update(credential.apiServerURL + "\0" + credential.sessionToken).digest("hex");
}

/** Endpoint mismatches are rejected separately by the model list scope. This only checks that the session came from OAuth. */
export function sessionKey(credential: Credential): string {
  return createHash("sha256").update(credential.sessionToken).digest("hex");
}
