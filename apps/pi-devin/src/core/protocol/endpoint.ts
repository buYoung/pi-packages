import { Effect } from "effect";
import { toDevinError, type DevinError } from "../errors.ts";
import { failWith } from "../validation.ts";
import { checkEndpoint } from "./origin.ts";

/** The origin of an HTTPS endpoint, or of loopback HTTP for local verification, without credentials or a path. */
export function endpoint(value: string): Effect.Effect<string, DevinError> {
  return Effect.suspend(() => {
    const checked = checkEndpoint(value);
    if ("origin" in checked) return Effect.succeed(checked.origin);
    return checked.cause === undefined ? failWith(checked.problem) : Effect.fail(toDevinError(checked.cause));
  });
}
