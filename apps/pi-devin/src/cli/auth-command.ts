import { Effect, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { loginAccount, type LoginOptions } from "../core/auth/index.ts";
import type { DevinFailure } from "../core/errors.ts";
import { safeError } from "../core/redaction.ts";
import type { Credential, JsonObject } from "../core/types.ts";
import { openLoginURL, readAuthorizationCode } from "./auth-ui.ts";
import { credentialPath, saveCredential } from "./credentials.ts";

export function loginCommand(
  options: Omit<LoginOptions, "onURL" | "promptCode"> & { noBrowser?: boolean },
  ui: {
    emit: (event: string, data: JsonObject) => Effect.Effect<void>;
    onCredential: (credential: Credential) => Effect.Effect<void>;
    openURL?: typeof openLoginURL;
    promptCode?: Effect.Effect<string, DevinFailure>;
  },
): Effect.Effect<void, DevinFailure, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const { noBrowser, ...loginOptions } = options;
    const openURL = ui.openURL ?? openLoginURL;
    const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const credential = yield* loginAccount({
      ...loginOptions,
      promptCode: ui.promptCode ?? (options.flow === "manual" || process.stdin.isTTY ? readAuthorizationCode : undefined),
      onURL: (url) => Effect.gen(function* () {
        yield* ui.emit("auth_url", { url });
        if (noBrowser) return;
        yield* openURL(url).pipe(Effect.catch((error) => ui.emit("browser_open_failed", { message: safeError(error) })));
      }).pipe(Effect.provideContext(services)),
    });
    yield* ui.onCredential(credential);
    yield* saveCredential(credential);
    yield* ui.emit("logged_in", { credentialFile: credentialPath(), apiServerURL: credential.apiServerURL, createdAt: credential.createdAt });
  });
}
