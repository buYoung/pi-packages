import { randomUUID } from "node:crypto";
import { arch, release, type as osType } from "node:os";
import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { assertCanInfer } from "../core/auth/access.ts";
import { CLIENT_VERSION, type DevinClient } from "../core/client.ts";
import { isAuthenticationError, type DevinError, type DevinFailure } from "../core/errors.ts";
import { applyTeamModelPolicy } from "../core/models/access.ts";
import { commandOutput, fromPlatformError } from "../core/platform.ts";
import { safeError } from "../core/redaction.ts";
import type { JsonObject, ModelInfo } from "../core/types.ts";
import { failWith } from "../core/validation.ts";
import { credentialPath, isAlreadyExists, privateDirectory } from "./credentials.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A random installation ID created once. Concurrent first runs agree through an exclusive hard link. */
export function installationId(): Effect.Effect<string, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(dirname(credentialPath()), "installation-id");
    yield* privateDirectory(dirname(path));
    const temporary = `${path}.${randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, randomUUID() + "\n", { flag: "wx", mode: 0o600 }).pipe(
      Effect.andThen(fs.link(temporary, path).pipe(Effect.catch((error) => isAlreadyExists(error) ? Effect.void : Effect.fail(error)))),
      Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
      Effect.mapError(fromPlatformError),
    );
    const info = yield* fs.stat(path).pipe(Effect.mapError(fromPlatformError));
    if (Number(info.size) > 128) return yield* failWith("Invalid installation ID file.");
    const value = (yield* fs.readFileString(path).pipe(Effect.mapError(fromPlatformError))).trim();
    if (!UUID.test(value)) return yield* failWith("Invalid installation ID format.");
    return value;
  });
}

export function initializeClient(client: DevinClient, options: {
  expectedUserId?: string; expectedOwnerHash?: string;
  onWarning?: (message: string) => Effect.Effect<void>;
} = {}): Effect.Effect<{ models: ModelInfo[]; status: JsonObject; auxiliary: JsonObject }, DevinFailure> {
  return Effect.gen(function* () {
    const status = yield* client.status({ expectedUserId: options.expectedUserId });
    yield* assertCanInfer(status);
    if (options.expectedOwnerHash && (yield* client.accountIdentityHash) !== options.expectedOwnerHash) return yield* failWith("A session of a different account cannot be sent.");
    const catalog = yield* client.models;
    const models = applyTeamModelPolicy(catalog, yield* client.teamSettings);
    const auxiliary: JsonObject = {};
    const lookups: [string, Effect.Effect<unknown, DevinFailure>][] = [["managedPlugins", client.managedPlugins], ["self", client.self], ["integrations", client.integrations]];
    for (const [name, fetch] of lookups) {
      auxiliary[name] = yield* fetch.pipe(Effect.map((value) => value !== undefined), Effect.catch((error) => {
        if (isAuthenticationError(error)) return Effect.fail(error);
        return Effect.as(options.onWarning?.(`Failed to fetch ${name}: ${safeError(error, [client.credential.sessionToken])}`) ?? Effect.void, false);
      }));
    }
    return { models, status, auxiliary };
  });
}

let osVersion: string | undefined;
const analyticsOSVersion: Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> = Effect.suspend(() => {
  if (osVersion !== undefined) return Effect.succeed(osVersion);
  const kernel = release();
  // On unsupported environments, only the kernel version is reported.
  const product = process.platform === "darwin"
    ? commandOutput("/usr/bin/sw_vers", ["-productVersion"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 3000, maxOutputBytes: 1024 }).pipe(
      Effect.map((output) => output.trim()), Effect.orElseSucceed(() => kernel))
    : Effect.succeed(kernel);
  return Effect.map(product, (value) => osVersion = value);
});

/** Builds only session/message/tool events that actually happened. Installation or external agent detection events are never faked. */
export function analyticsEvent(client: DevinClient, name: "SESSION_CREATED" | "USER_MESSAGE_SENT" | "AGENT_TOOL_CALLED", options: {
  installationId: string; model: string; toolName?: string;
}): Effect.Effect<JsonObject, DevinError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const isTool = name === "AGENT_TOOL_CALLED";
    return {
      eventName: name,
      ...(!isTool ? { installationId: options.installationId } : {}),
      ideName: isTool ? "devin-cli" : "chisel",
      ...(isTool ? { ideType: "chisel" } : {}),
      os: process.platform === "darwin" ? "mac" : process.platform,
      ideVersion: CLIENT_VERSION,
      deviceFingerprint: yield* client.fingerprint.device,
      extra: {
        os_name: osType(), os_version: yield* analyticsOSVersion, os_arch: arch(), terminal_type: process.env.TERM ?? "unknown",
        model_name: options.model,
        ...(name === "SESSION_CREATED" ? { headless: "true" } : {}),
        ...(name === "USER_MESSAGE_SENT" ? { mode: "normal" } : {}),
        ...(isTool ? { tool_name: options.toolName ?? "", auto_approved: "true" } : {}),
      },
    };
  });
}
