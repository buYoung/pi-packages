import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, FileSystem, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { DevinError } from "../core/errors.ts";
import { fromPlatformError } from "../core/platform.ts";
import { endpoint } from "../core/protocol/endpoint.ts";
import type { Credential } from "../core/types.ts";
import { failWith, object, requiredString } from "../core/validation.ts";

export function credentialPath(): string {
  const directory = process.env.DEVIN_POC_STATE_DIR ?? join(homedir(), ".local", "share", "devin-protocol-poc");
  return join(directory, "credentials.json");
}

export const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";
export const isAlreadyExists = (error: PlatformError) => error.reason._tag === "AlreadyExists";

/** Creates the directory with private permissions, also tightening an existing one. */
export function privateDirectory(path: string): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path, { recursive: true, mode: 0o700 });
    yield* fs.chmod(path, 0o700);
  }).pipe(Effect.mapError(fromPlatformError));
}

/** Writes a private file through a temporary sibling and a rename, so readers never see a partial file. */
export function writePrivateFile(file: string, text: string): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, file)),
      Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
      Effect.mapError(fromPlatformError),
    );
  });
}

export function saveCredential(credential: Credential, file = credentialPath()): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.andThen(privateDirectory(dirname(file)), writePrivateFile(file, JSON.stringify(credential, null, 2) + "\n"));
}

export function readCredential(file = credentialPath()): Effect.Effect<Credential, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.mapError((error) => isNotFound(error)
      ? new DevinError({ message: "No PoC credential found. Run login." }) : fromPlatformError(error)));
    const value = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined }).pipe(
      Effect.flatMap((parsed) => object(parsed, "credential")),
      Effect.mapError(() => new DevinError({ message: "Invalid PoC credential file format." })),
    );
    if (value.version !== 1) return yield* failWith("Unsupported credential version.");
    const fingerprint = Predicate.isString(value.fingerprint) ? value.fingerprint : undefined;
    return {
      version: 1,
      sessionToken: yield* requiredString(value.sessionToken, "sessionToken"),
      apiServerURL: yield* endpoint(yield* requiredString(value.apiServerURL, "apiServerURL")),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      createdAt: yield* requiredString(value.createdAt, "createdAt"),
    } satisfies Credential;
  });
}
