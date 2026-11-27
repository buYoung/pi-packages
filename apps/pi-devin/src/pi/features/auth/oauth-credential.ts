import type { OAuthCredential } from "@earendil-works/pi-ai";
import { checkEndpoint } from "../../../core/protocol/origin.ts";
import type { Credential } from "../../../core/types.ts";

/** A Devin session from Pi's stored OAuth credential, or why it is not one; `cause` is set when the endpoint does not parse. */
export type OAuthCredentialCheck = { readonly credential: Credential } | { readonly problem: string; readonly cause?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const missingString = (value: unknown, label: string) => typeof value === "string" && value.length > 0 ? undefined : `${label}: a non-empty string is required.`;

/**
 * The only reading of Pi's stored OAuth credential, free of Effect so the extension entry can answer Pi before it loads
 * the runtime. `credentialFromOAuth` is the same check for the services.
 */
export function checkOAuthCredential(credential: OAuthCredential): OAuthCredentialCheck {
  // 0.1.4 and earlier stored `expires: 0`; Pi checks such a session again on its next use.
  if (credential.type !== "oauth" || credential.refresh !== "" || !Number.isSafeInteger(credential.expires) || credential.expires < 0) {
    return { problem: "Unsupported Devin account credential. Sign in again with /login." };
  }
  const metadata = credential.devin;
  if (!isObject(metadata)) return { problem: "Devin credential metadata: a JSON object is required." };
  if (metadata.version !== 1) return { problem: "The Devin account credential version differs. Sign in again with /login." };
  const tokenProblem = missingString(credential.access, "Devin credential access");
  if (tokenProblem) return { problem: tokenProblem };
  const serverProblem = missingString(metadata.apiServerURL, "Devin credential API server");
  if (serverProblem) return { problem: serverProblem };
  const server = checkEndpoint(metadata.apiServerURL as string);
  if (!("origin" in server)) return server;
  const createdProblem = missingString(metadata.createdAt, "Devin credential creation time");
  if (createdProblem) return { problem: createdProblem };
  return { credential: { version: 1, sessionToken: credential.access, apiServerURL: server.origin, createdAt: metadata.createdAt as string } };
}
