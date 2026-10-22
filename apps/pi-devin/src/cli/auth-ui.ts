import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { toDevinFailure, type DevinError, type DevinFailure } from "../core/errors.ts";
import { fromPlatformError } from "../core/platform.ts";
import { failWith } from "../core/validation.ts";

/** Opens the URL with the macOS `open` command. Other systems show the URL for the user to open. */
export function openLoginURL(url: string): Effect.Effect<void, DevinError, ChildProcessSpawner.ChildProcessSpawner> {
  if (process.platform !== "darwin") return failWith("Opening the browser automatically is supported on macOS only. Open the shown URL yourself.");
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("/usr/bin/open", [url], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: false }))
      .pipe(Effect.mapError(fromPlatformError));
    if (exitCode !== 0) return yield* failWith("Could not open the browser. Open the shown URL yourself.");
  });
}

/** Does not echo input. The code value never goes into logs, errors or structured events. */
export const readAuthorizationCode: Effect.Effect<string, DevinFailure> = Effect.suspend(() => {
  if (process.stdin.readableEnded) return failWith("Authorization code input ended.");
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      process.stderr.write("Paste the authorization code or callback URL from the browser (input is hidden): ");
      const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      return { silentOutput, input: createInterface({ input: process.stdin, output: silentOutput, terminal: Boolean(process.stdin.isTTY) }) };
    }),
    ({ input }) => Effect.callback<string, DevinFailure>((resume, signal) => {
      const onClose = () => resume(failWith("Authorization code input ended."));
      input.once("close", onClose);
      input.question("", { signal }).then((value) => resume(Effect.succeed(value)), (error: unknown) => resume(Effect.fail(toDevinFailure(error))));
      return Effect.sync(() => input.off("close", onClose));
    }),
    ({ input, silentOutput }) => Effect.sync(() => {
      input.close();
      silentOutput.end();
      process.stderr.write("\n");
    }),
  );
});
