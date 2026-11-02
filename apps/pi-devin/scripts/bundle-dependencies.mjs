#!/usr/bin/env node
// Replaces pnpm's links for the bundled dependencies with physical copies before packing, and restores the links after.
//
// Pi installs packages with `npm install --legacy-peer-deps`, so a hoisted `@effect/platform-node` would use whichever
// `effect` and `@effect/platform-node-shared` another package left at the top of Pi's npm root. Bundling them keeps them
// next to this package's own `effect`. npm does not install the dependencies of bundled packages, so the bundle carries
// what they load at run time.
//
// Only runtime files are copied: starting from this package's own imports of the bundled packages, every JavaScript file
// reached through static imports, literal dynamic imports and require calls, plus each reached package's package.json and
// license. Type declarations, type-only packages, source maps, sources and documentation stay out, and so does any
// dependency this package never loads. `effect` is a peer and stays out too. Versions come from pnpm's install.
//
// usage: node scripts/bundle-dependencies.mjs [--restore]
import assert from "node:assert/strict";
import { copyFileSync, existsSync, globSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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
for (const name of bundled) {
  assert.ok(lstatSync(join(nodeModules, name)).isSymbolicLink(), `${name} is not a pnpm link; run pnpm install before packing`);
  assert.equal(manifest.dependencies[name], readManifest(join(nodeModules, name)).version, `${name} must be installed at its pinned version; run pnpm install`);
}

const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const isBuiltin = (specifier) => specifier.startsWith("node:") || builtinModules.includes(packageName(specifier));

function packageDirectoryOf(file) {
  for (let directory = dirname(file); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json")) && readManifest(directory).name) return directory;
  }
  throw new Error(`No package.json above ${file}`);
}

function findPackage(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (directory === dirname(directory)) return undefined;
  }
}

function exportTarget(value, conditions) {
  if (typeof value === "string" || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => exportTarget(entry, conditions)).find(Boolean);
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "default" || conditions.includes(condition)) {
      const resolved = exportTarget(target, conditions);
      if (resolved) return resolved;
    }
  }
}

function packageEntry(directory, subpath, conditions) {
  const { exports, main } = readManifest(directory);
  let target;
  if (exports === undefined) target = subpath === "." ? (main ?? "index.js") : subpath;
  else if (typeof exports === "string" || Array.isArray(exports) || !Object.keys(exports).some((key) => key.startsWith("."))) target = subpath === "." ? exportTarget(exports, conditions) : undefined;
  else if (subpath in exports) target = exportTarget(exports[subpath], conditions);
  else {
    for (const [pattern, value] of Object.entries(exports)) {
      const [prefix, suffix] = pattern.split("*");
      if (pattern.includes("*") && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
        target = exportTarget(value, conditions)?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length));
        break;
      }
    }
  }
  assert.ok(target, `${readManifest(directory).name} does not export ${subpath}`);
  return resolveFile(join(directory, target));
}

function resolveFile(path) {
  for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Runtime file not found: ${path}`);
}

// Static imports and re-exports, literal dynamic imports, and require calls. Comments are removed first.
const importPattern = /(?:\bimport|\bexport)\s*(?:[\w*{}\s,]*?\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
function importsOf(file) {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...source.matchAll(importPattern)].map((match) => ({ specifier: match[1] ?? match[2] ?? match[3], isRequire: match[3] !== undefined }));
}

// file -> its package directory, for every runtime file reached.
const reached = new Map();
function visit(file) {
  if (reached.has(file)) return;
  const owner = packageDirectoryOf(file);
  reached.set(file, owner);
  const ownerManifest = readManifest(owner);
  for (const { specifier, isRequire } of importsOf(file)) {
    if (isBuiltin(specifier)) continue;
    if (specifier.startsWith(".")) { visit(resolveFile(resolve(dirname(file), specifier))); continue; }
    const name = packageName(specifier);
    if (name === "effect") continue;
    const directory = findPackage(name, dirname(file));
    if (!directory) {
      // Optional peers such as ws's bufferutil are loaded inside try/catch and are not installed.
      const isOptionalPeer = ownerManifest.peerDependenciesMeta?.[name]?.optional === true || (ownerManifest.peerDependencies?.[name] && !ownerManifest.dependencies?.[name]);
      assert.ok(isOptionalPeer, `${ownerManifest.name} loads ${name}, which is not installed`);
      continue;
    }
    visit(packageEntry(directory, "." + specifier.slice(name.length), isRequire ? ["node", "require"] : ["node", "import"]));
  }
}

const sourceFiles = ["index.ts", ...globSync("src/{core,pi}/**/*.ts", { cwd: packageDirectory })].map((file) => join(packageDirectory, file));
for (const file of sourceFiles) {
  for (const { specifier } of importsOf(file)) {
    const name = packageName(specifier);
    if (bundled.includes(name)) visit(packageEntry(realpathSync(join(nodeModules, name)), "." + specifier.slice(name.length), ["node", "import"]));
  }
}

// Bundled packages keep their place. Any other reached package goes into the node_modules of the bundled package that
// loads it, where Node finds it from that package's files.
const bundledDirectories = new Map(bundled.map((name) => [realpathSync(join(nodeModules, name)), name]));
const packages = new Map([...new Set(reached.values())].map((directory) => [directory, readManifest(directory).name]));
const staging = join(nodeModules, ".pi-devin-bundle");
function targetOf(directory) {
  const name = packages.get(directory);
  if (bundledDirectories.has(directory)) return join(staging, name);
  const loader = [...reached].find(([file, owner]) => bundledDirectories.has(owner) && importsOf(file).some(({ specifier }) => packageName(specifier) === name));
  assert.ok(loader, `${name} is loaded only by another non-bundled package; nested bundles are not supported`);
  return join(staging, bundledDirectories.get(loader[1]), "node_modules", name);
}

const links = {};
rmSync(staging, { recursive: true, force: true });
try {
  const copied = new Map();
  for (const [file, directory] of reached) {
    const target = targetOf(directory);
    copied.set(directory, target);
    mkdirSync(dirname(join(target, relative(directory, file))), { recursive: true });
    copyFileSync(file, join(target, relative(directory, file)));
  }
  for (const [directory, target] of copied) {
    for (const extra of ["package.json", ...globSync("{LICEN[CS]E,LICEN[CS]E.*,licen[cs]e,LICEN[CS]E.md}", { cwd: directory })]) {
      if (existsSync(join(directory, extra))) copyFileSync(join(directory, extra), join(target, extra));
    }
  }
  for (const name of bundled) links[name] = readlinkSync(join(nodeModules, name));
  writeFileSync(stateFile, JSON.stringify(links, null, 2));
  for (const name of bundled) {
    rmSync(join(nodeModules, name), { force: true });
    renameSync(join(staging, name), join(nodeModules, name));
  }
  const files = [...reached.keys()].length;
  console.error(`Bundled ${bundled.join(", ")} with ${[...packages.values()].filter((name) => !bundled.includes(name)).join(", ") || "no other packages"}: ${files} runtime files`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
