#!/usr/bin/env node
// Replaces pnpm's links for the bundled dependencies with physical copies before packing, and restores the links after.
//
// Pi installs packages with `npm install --legacy-peer-deps`, so a hoisted `@effect/platform-node` would use whichever
// `effect` and `@effect/platform-node-shared` another package left at the top of Pi's npm root. Bundling them keeps them
// next to this package's own `effect`. npm does not install the dependencies of bundled packages, so each bundled
// package carries its own runtime dependencies (except `effect`, a peer, and the other bundled package) in a nested
// node_modules. Versions come from pnpm's install, so they follow the lockfile.
//
// usage: node scripts/bundle-dependencies.mjs [--restore]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const nodeModules = join(packageDirectory, "node_modules");
const stateFile = join(nodeModules, ".pi-devin-bundle.json");
const readManifest = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const manifest = readManifest(packageDirectory);
const bundled = manifest.bundleDependencies;

if (process.argv.includes("--restore")) {
  if (!existsSync(stateFile)) process.exit(0);
  const links = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const [name, target] of Object.entries(links)) {
    const location = join(nodeModules, name);
    rmSync(location, { recursive: true, force: true });
    symlinkSync(target, location, "junction");
  }
  rmSync(stateFile);
  process.exit(0);
}

assert.ok(Array.isArray(bundled) && bundled.length > 0, "package.json has no bundleDependencies");
for (const name of bundled) assert.equal(manifest.dependencies[name], readManifest(join(nodeModules, name)).version, `${name} must be installed at its pinned version; run pnpm install`);

function resolveDependency(name, directory) {
  for (let parent = directory; ; parent = dirname(parent)) {
    const candidate = join(parent, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (parent === dirname(parent)) throw new Error(`Runtime dependency not found: ${name} (from ${directory})`);
  }
}

// npm's own file set for a registry package, as `npm pack` would publish it.
function copyPackage(source, target) {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: source, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  for (const { path } of packed.files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    copyFileSync(join(source, path), join(target, path));
  }
}

// Copies the runtime dependency closure of a bundled package into its own node_modules.
function copyDependencies(sourceDirectory, targetDirectory, staged) {
  const dependency = readManifest(sourceDirectory);
  for (const name of Object.keys(dependency.dependencies ?? {})) {
    if (name === "effect" || bundled.includes(name) || staged.has(name)) continue;
    const source = resolveDependency(name, sourceDirectory);
    const target = join(targetDirectory, "node_modules", name);
    staged.add(name);
    copyPackage(source, target);
    copyDependencies(source, targetDirectory, staged);
  }
}

const links = {};
const staging = join(nodeModules, ".pi-devin-bundle");
rmSync(staging, { recursive: true, force: true });
try {
  for (const name of bundled) {
    const location = join(nodeModules, name);
    assert.ok(lstatSync(location).isSymbolicLink(), `${name} is not a pnpm link; run pnpm install before packing`);
    const source = realpathSync(location);
    const target = join(staging, name);
    copyPackage(source, target);
    copyDependencies(source, target, new Set());
    links[name] = readlinkSync(location);
  }
  writeFileSync(stateFile, JSON.stringify(links, null, 2));
  for (const name of bundled) {
    const location = join(nodeModules, name);
    rmSync(location, { force: true });
    renameSync(join(staging, name), location);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
