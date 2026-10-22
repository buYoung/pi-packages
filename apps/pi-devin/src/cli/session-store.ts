import { randomInt, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Effect, Exit, FileSystem, Option, Predicate, Scope } from "effect";
import { DevinError } from "../core/errors.ts";
import { MAX_STEP_INDEX } from "../core/inference/state.ts";
import { fromPlatformError } from "../core/platform.ts";
import type { ChatMessage } from "../core/types.ts";
import { failWith, object, requiredString } from "../core/validation.ts";
import { credentialPath, isAlreadyExists, isNotFound, privateDirectory } from "./credentials.ts";

const ADJECTIVES = "amber brisk calm clear cool crisp eager fair fresh gentle golden green happy kind lively lucid mild neat nimble quiet rapid sage silver smooth soft steady sunny swift tidy vivid warm wise".split(" ");
const NOUNS = "birch brook cedar cloud coral crane dawn elm fern field finch forest frost grove heron hill iris lake leaf maple meadow moon oak olive otter pine pond rain reed river star willow".split(" ");
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MESSAGE_SOURCES = new Set(["CHAT_MESSAGE_SOURCE_USER", "CHAT_MESSAGE_SOURCE_SYSTEM", "CHAT_MESSAGE_SOURCE_TOOL"]);

export interface SessionState {
  version: 1;
  id: string;
  cascadeId: string;
  trajectoryId: string;
  nextStepIndex: number;
  model: string;
  cwd: string;
  messages: ChatMessage[];
  title?: string;
  hasTitleAttempted?: boolean;
  ownerHash?: string;
}

export function createSession(model: string, cwd = process.cwd()): SessionState {
  return {
    version: 1, id: `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`,
    cascadeId: randomUUID(), trajectoryId: randomUUID(), nextStepIndex: 0,
    model, cwd, messages: [],
  };
}

function sessionPath(id: string): Effect.Effect<string, DevinError> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return failWith("Invalid session ID.");
  return Effect.succeed(join(dirname(credentialPath()), "sessions", `${id}.json`));
}

const existsError = (message: string) => new DevinError({ message, code: "EEXIST" });

export function loadSession(id: string): Effect.Effect<SessionState, DevinError, FileSystem.FileSystem> {
  return Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* sessionPath(id);
    const file = yield* fs.open(path, { flag: "r" }).pipe(Effect.mapError(fromPlatformError));
    const info = yield* file.stat.pipe(Effect.mapError(fromPlatformError));
    if (info.type !== "File" || Number(info.size) > MAX_SESSION_BYTES) return yield* failWith("Invalid session file size or format.");
    const parts: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = yield* file.readAlloc(READ_CHUNK_BYTES).pipe(Effect.mapError(fromPlatformError));
      if (Option.isNone(part)) break;
      bytes += part.value.length;
      if (bytes > MAX_SESSION_BYTES) return yield* failWith("The session file size limit was exceeded.");
      parts.push(part.value);
    }
    const parsed = yield* Effect.try({ try: () => JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown, catch: (cause) => new DevinError({ message: cause instanceof Error ? cause.message : String(cause) }) });
    const value = yield* object(parsed, "session");
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.messages)) return yield* failWith("Invalid session file.");
    for (const key of ["cascadeId", "trajectoryId", "model", "cwd"]) yield* requiredString(value[key], `session.${key}`);
    if (!Number.isSafeInteger(value.nextStepIndex) || Number(value.nextStepIndex) < 0 || Number(value.nextStepIndex) > MAX_STEP_INDEX) {
      return yield* failWith("Invalid session step.");
    }
    if (value.messages.length > 5000) return yield* failWith("The session message limit was exceeded.");
    for (const entry of value.messages) {
      const message = yield* object(entry, "session message");
      if (!MESSAGE_SOURCES.has(String(message.source)) || !Predicate.isString(message.prompt)) return yield* failWith("Invalid session message.");
    }
    return value as unknown as SessionState;
  }));
}

export function saveSession(state: SessionState): Effect.Effect<void, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* sessionPath(state.id);
    yield* privateDirectory(dirname(path));
    const json = JSON.stringify(state) + "\n";
    if (Buffer.byteLength(json) > MAX_SESSION_BYTES) return yield* failWith("The session save size limit was exceeded.");
    const temporary = `${path}.${randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, json, { mode: 0o600, flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, path)),
      Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
      Effect.mapError(fromPlatformError),
    );
  });
}

/** Holds an exclusive lock file for the session and returns its release. Release never deletes a lock another process replaced. */
export function lockSession(id: string, isNew: boolean): Effect.Effect<Effect.Effect<void, DevinError>, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* sessionPath(id);
    yield* privateDirectory(dirname(path));
    const lockPath = `${path}.lock`;
    const handleScope = yield* Scope.make();
    const file = yield* fs.open(lockPath, { flag: "wx", mode: 0o600 }).pipe(
      Scope.provide(handleScope),
      Effect.mapError((error) => isAlreadyExists(error) ? existsError("The session is in use or a lock file exists.") : fromPlatformError(error)),
    );
    const owned = yield* file.stat.pipe(Effect.mapError(fromPlatformError));
    let hasReleased = false;
    const release: Effect.Effect<void, DevinError> = Effect.suspend(() => {
      if (hasReleased) return Effect.void;
      hasReleased = true;
      return Effect.gen(function* () {
        yield* Scope.close(handleScope, Exit.void);
        const current = yield* fs.stat(lockPath).pipe(Effect.map(Option.some), Effect.catch((error) => isNotFound(error) ? Effect.succeed(Option.none()) : Effect.fail(fromPlatformError(error))));
        if (Option.isNone(current)) return;
        const isSameFile = Option.getOrUndefined(current.value.ino) === Option.getOrUndefined(owned.ino) && current.value.dev === owned.dev;
        if (!isSameFile) return yield* failWith("The lock file owner changed, so it is not deleted automatically.");
        yield* fs.remove(lockPath).pipe(Effect.mapError(fromPlatformError));
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    });
    if (!isNew) return release;
    const existing = yield* fs.stat(path).pipe(Effect.map(() => true), Effect.catch((error) => isNotFound(error) ? Effect.succeed(false) : Effect.fail(fromPlatformError(error))), Effect.onError(() => Effect.ignore(release)));
    if (!existing) return release;
    yield* Effect.ignore(release);
    return yield* Effect.fail(existsError("The session ID already exists."));
  });
}

export function openSession(model: string, resumeId?: string): Effect.Effect<{ state: SessionState; release: Effect.Effect<void, DevinError> }, DevinError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (resumeId) {
      const release = yield* lockSession(resumeId, false);
      const state = yield* loadSession(resumeId).pipe(Effect.onError(() => Effect.ignore(release)));
      return { state, release };
    }
    for (let attempt = 0; attempt < 64; attempt++) {
      const state = createSession(model);
      const locked = yield* lockSession(state.id, true).pipe(Effect.map(Option.some), Effect.catch((error) => error.code === "EEXIST" ? Effect.succeed(Option.none()) : Effect.fail(error)));
      if (Option.isSome(locked)) return { state, release: locked.value };
    }
    return yield* failWith("Could not create an available session name.");
  });
}

export { takeStep } from "../core/inference/state.ts";
