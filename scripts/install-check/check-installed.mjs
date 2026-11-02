// Audits an installed Pi npm root.
// 1. RANGE: every installed package's dependencies and required peers resolve to a satisfying version
//    (host-provided peers are checked against the installed Pi host).
// 2. IMPORT: every import in @buyong/* runtime files resolves to an existing file; host imports must be
//    one of Pi's extension aliases; named value imports must exist on the resolved module.
// usage: node check-installed.mjs <npm root> <pi host dir>   (run inside the container by scenario.sh)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const [root, host] = process.argv.slice(2);
const semver = createRequire("/usr/local/lib/node_modules/npm/")("semver");
const hostRequire = createRequire(join(host, "dist/core/extensions/loader.js"));
const hostVersion = (name) => {
  try { return JSON.parse(readFileSync(join(dirname(findPackageJson(hostRequire.resolve(name))), "package.json"), "utf8")).version; } catch { return undefined; }
};
function findPackageJson(file) {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    const p = join(dir, "package.json");
    if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).name) return p;
  }
}
// Pi's jiti aliases (dist/core/extensions/loader.js getAliases), resolved inside the host.
const HOST_ALIASES = {
  "@earendil-works/pi-coding-agent": join(host, "dist/index.js"),
  "@earendil-works/pi-agent-core": "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui": "@earendil-works/pi-tui",
  "@earendil-works/pi-ai/providers/all": "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-ai/compat": "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/models": "@earendil-works/pi-ai/models",
  "@earendil-works/pi-ai/oauth": "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai": "@earendil-works/pi-ai/compat",
  typebox: "typebox", "typebox/compile": "typebox/compile", "typebox/value": "typebox/value",
};
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "typebox"];
const hostPackageOf = (spec) => HOST_PACKAGES.find((p) => spec === p || spec.startsWith(p + "/"));
const hostTarget = (spec) => {
  const alias = HOST_ALIASES[spec];
  if (!alias) return undefined;
  if (alias.startsWith("/")) return alias;
  const base = alias.startsWith("@") ? alias.split("/").slice(0, 2).join("/") : alias.split("/")[0];
  const resolved = resolvePackage(host, base);
  return resolved && exportFile(resolved, "." + alias.slice(base.length));
};
// Resolves a subpath through package.json exports (import condition first), then main/module.
function exportFile(resolved, sub) {
  const exp = resolved.pkg.exports;
  let entry;
  if (typeof exp === "string") entry = sub === "." ? exp : undefined;
  else if (exp && (sub in exp)) entry = exp[sub];
  else if (exp && !Object.keys(exp).some((k) => k.startsWith("."))) entry = sub === "." ? exp : undefined;
  else if (exp) for (const [pattern, value] of Object.entries(exp)) {
    if (!pattern.includes("*")) continue;
    const [pre, post] = pattern.split("*");
    if (sub.startsWith(pre) && sub.endsWith(post)) { const star = sub.slice(pre.length, sub.length - post.length); entry = JSON.parse(JSON.stringify(value).replaceAll("*", star)); break; }
  }
  while (entry && typeof entry === "object") entry = entry.import ?? entry.node ?? entry.default ?? entry.require;
  if (!entry && !exp) entry = sub === "." ? (resolved.pkg.module ?? resolved.pkg.main ?? "index.js") : sub;
  if (!entry) return undefined;
  for (const c of [join(resolved.dir, entry), join(resolved.dir, entry) + ".js", join(resolved.dir, entry, "index.js")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return undefined;
}

const packages = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (name.startsWith("@")) { walk(full); continue; }
    const manifest = join(full, "package.json");
    if (existsSync(manifest)) {
      packages.push({ dir: full, pkg: JSON.parse(readFileSync(manifest, "utf8")) });
      walk(join(full, "node_modules"));
    }
  }
};
walk(join(root, "node_modules"));

function resolvePackage(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return { dir: dirname(candidate), pkg: JSON.parse(readFileSync(candidate, "utf8")) };
    if (dir === dirname(dir)) return undefined;
  }
}

const problems = [], notes = [];
// 1. RANGE
for (const { dir, pkg } of packages) {
  const optionalPeers = new Set(Object.entries(pkg.peerDependenciesMeta ?? {}).filter(([, m]) => m.optional).map(([n]) => n));
  const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));
  const check = (name, range, kind) => {
    if (/^(file|link|workspace|git|https?):/.test(range) || range.includes("/")) return;
    const hostName = hostPackageOf(name);
    if (kind === "peer" && hostName) {
      const v = resolvePackage(host, hostName)?.pkg.version;
      if (!v || !semver.satisfies(v, range, { includePrerelease: true })) problems.push(`HOSTPEER ${pkg.name}@${pkg.version} wants ${name}@${range}, host has ${v ?? "nothing"}`);
      return;
    }
    const resolved = resolvePackage(dir, name);
    if (!resolved) {
      if (kind === "peer" && optionalPeers.has(name)) return;
      if (optionalDeps.has(name)) return;
      (kind === "peer" ? notes : problems).push(`${kind === "peer" ? "PEER-NOT-INSTALLED" : "MISSING"} ${pkg.name}@${pkg.version} ${kind} ${name}@${range}`);
      return;
    }
    if (!semver.satisfies(resolved.pkg.version, range, { includePrerelease: true })) problems.push(`RANGE ${pkg.name}@${pkg.version} ${kind} ${name}@${range} resolves ${resolved.pkg.version} (${relative(root, resolved.dir)})`);
  };
  for (const [n, r] of Object.entries(pkg.dependencies ?? {})) check(n, r, "dep");
  for (const [n, r] of Object.entries(pkg.peerDependencies ?? {})) check(n, r, "peer");
}

// 2. IMPORT for @buyong/* runtime files
const SKIP_DIRS = new Set(["node_modules", "test", "tests", "__tests__", "docs", "ai-docs", "examples", "verification", "experiments"]);
const files = [];
const collect = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full);
    else if (/\.(m?js|cjs|ts|mts)$/.test(name) && !/\.d\.(m?ts|cts)$/.test(name) && !/\.(test|spec)\./.test(name)) files.push(full);
  }
};
const ours = packages.filter((p) => p.pkg.name.startsWith("@buyong/"));
for (const { dir, pkg } of ours) {
  // Only shipped runtime files; the CLI and dev-only sources of pi-devin are excluded from the archive already.
  collect(dir);
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const staticRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
const bareImportRe = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
const dynamicRe = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const named = new Map(); // target file -> Set(names) with origin
let importCount = 0;
const resolveSpec = (fromFile, spec) => {
  if (spec.startsWith("node:") || builtinModules.includes(spec.split("/")[0])) return { kind: "builtin" };
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = join(dirname(fromFile), spec);
    for (const c of [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), base + ".ts", base + ".js", base + ".mjs", join(base, "index.ts"), join(base, "index.js")]) if (existsSync(c) && statSync(c).isFile()) return { kind: "file", file: c };
    return { kind: "missing", why: "relative file not found" };
  }
  const hostName = hostPackageOf(spec);
  if (hostName) {
    const target = hostTarget(spec);
    return target ? { kind: "file", file: target, host: true } : { kind: "missing", why: "host specifier is not one of Pi's extension aliases (peers are not installed)" };
  }
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const resolved = resolvePackage(dirname(fromFile), base);
  if (!resolved) return { kind: "missing", why: `package ${base} not installed` };
  const sub = "." + spec.slice(base.length);
  const file = exportFile(resolved, sub);
  return file ? { kind: "file", file } : { kind: "missing", why: `subpath ${sub} not exported by ${base}@${resolved.pkg.version}` };
};
for (const file of files) {
  const text = stripComments(readFileSync(file, "utf8"));
  const where = relative(root, file);
  const record = (spec, clause, isType) => {
    importCount++;
    // Code strings run inside the Codex Desktop runtime, not resolved from npm.
    if (spec === "@oai/sky" && where.includes("pi-codex-computer-use/dist/install.js")) return;
    const r = resolveSpec(file, spec);
    if (r.kind === "missing") { if (!isType) problems.push(`IMPORT ${spec} from ${where}: ${r.why}`); return; }
    if (r.kind !== "file" || isType || !clause || spec.startsWith(".")) return;
    const names = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) for (const part of braces[1].split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      names.push(p.split(/\s+as\s+/)[0].trim());
    }
    const def = clause.replace(/\{[\s\S]*\}/, "").replace(/\*\s+as\s+\w+/, "").replace(/,/g, "").trim();
    if (def && !def.startsWith("*")) names.push("default");
    if (!names.length || /\.(ts|mts)$/.test(r.file)) return; // TS sources are checked by their own typecheck
    if (!named.has(r.file)) named.set(r.file, []);
    for (const n of names) named.get(r.file).push({ n, where, spec });
  };
  for (const m of text.matchAll(staticRe)) record(m[4], m[1] === "import" ? m[3] : undefined, Boolean(m[2]));
  for (const m of text.matchAll(bareImportRe)) record(m[1]);
  for (const m of text.matchAll(dynamicRe)) record(m[1]);
}
for (const [file, uses] of named) {
  let mod;
  try { mod = await import(pathToFileURL(file).href); }
  catch (error) { problems.push(`LOADFAIL ${relative(root, file)}: ${String(error.message).split("\n")[0]}`); continue; }
  for (const { n, where, spec } of uses) {
    if (n === "default" ? mod.default === undefined && !("default" in mod) : !(n in mod) && !(mod.default && typeof mod.default === "object" && n in mod.default)) {
      problems.push(`EXPORT ${spec} has no export "${n}" (imported by ${where})`);
    }
  }
}

console.log(`packages: ${packages.length} installed, ${ours.length} @buyong; files: ${files.length}; imports: ${importCount}; named-checked modules: ${named.size}`);
console.log(problems.length ? "PROBLEMS:\n  " + [...new Set(problems)].sort().join("\n  ") : "PROBLEMS: none");
console.log(notes.length ? "NOTES:\n  " + [...new Set(notes)].sort().join("\n  ") : "NOTES: none");
