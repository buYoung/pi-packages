#!/usr/bin/env node
// Source-only: writes the published extension to dist/. esbuild bundles index.ts with the npm packages it reaches into ES
// modules split at its dynamic imports; Pi's own packages stay external. The build fails when dist/index.js would load
// Effect or protobufjs before the instance loads, and dist/THIRD_PARTY_LICENSES.txt carries the bundled packages' licenses.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = "dist";
const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8"));
const HOST_PACKAGES = Object.keys(manifest.peerDependencies);
/** What index.ts leaves to the instance it loads on first use. */
const DEFERRED_INPUT = /(?:^|\/)node_modules\/(?:effect|@effect\/[^/]+|protobufjs|@protobufjs\/[^/]+)\//;
const PACKAGE_DIR = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i;

rmSync(join(APP_ROOT, OUT_DIR), { recursive: true, force: true });
const result = await build({
  absWorkingDir: APP_ROOT,
  entryPoints: ["index.ts"],
  // Every output stays directly in dist/, one level below the root like src/, which src/package.ts relies on.
  outdir: OUT_DIR,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: manifest.engines.node.replace(/^>=/, "node"),
  minify: true,
  legalComments: "none",
  external: HOST_PACKAGES.flatMap((name) => [name, `${name}/*`]),
  // CommonJS dependencies (protobufjs, ws) call require for Node modules, which an ES module does not define.
  banner: { js: 'import{createRequire as __piDevinRequire}from"node:module";var require=__piDevinRequire(import.meta.url);' },
  metafile: true,
  logLevel: "warning",
});

const outputs = result.metafile.outputs;
const entry = `${OUT_DIR}/index.js`;
const eager = new Set();
for (const queue = [entry]; queue.length > 0;) {
  const output = queue.pop();
  if (eager.has(output)) continue;
  eager.add(output);
  for (const imported of outputs[output].imports) if (imported.kind === "import-statement" && !imported.external) queue.push(imported.path);
}
const early = [...eager].flatMap((output) => Object.keys(outputs[output].inputs)).filter((input) => DEFERRED_INPUT.test(input));
if (early.length > 0) throw new Error(`${entry} loads modules the instance should load on first use:\n${early.slice(0, 10).join("\n")}`);

const packages = new Map();
for (const output of Object.values(outputs)) {
  for (const input of Object.keys(output.inputs)) {
    const directory = PACKAGE_DIR.exec(input)?.[1];
    if (directory && !packages.has(directory)) packages.set(directory, join(APP_ROOT, directory));
  }
}
const notices = [...packages.values()].map((directory) => {
  const { name, version, license } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const file = readdirSync(directory).find((entryName) => LICENSE_FILE.test(entryName));
  if (!file) throw new Error(`No license file in the bundled package ${name}@${version}.`);
  return { name, text: `${name}@${version} (${license})\n\n${readFileSync(join(directory, file), "utf8").trim()}\n` };
}).sort((left, right) => left.name.localeCompare(right.name));
writeFileSync(join(APP_ROOT, OUT_DIR, "THIRD_PARTY_LICENSES.txt"), `${notices.map((notice) => notice.text).join(`\n${"-".repeat(80)}\n\n`)}`);

const sizes = Object.entries(outputs).map(([path, output]) => `${path} ${Math.round(output.bytes / 1024)} KB`);
console.log(`Built ${sizes.length} files (${notices.length} bundled packages):\n${sizes.join("\n")}`);
