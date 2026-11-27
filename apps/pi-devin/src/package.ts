import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package's manifest, found from both the sources in `src/` and the published bundle in `dist/`, which sit directly
 * below the package root. Code that reads package files resolves them here, because bundling moves the other modules.
 */
const MANIFEST_URL = new URL("../package.json", import.meta.url);

/** This package root. Passed to the child Pi with `-e` so it uses the same extension copy as the lead. Pi loads a path only once. */
export const PACKAGE_ROOT = dirname(fileURLToPath(MANIFEST_URL));
export const PACKAGE_VERSION = (JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as { version: string }).version;
