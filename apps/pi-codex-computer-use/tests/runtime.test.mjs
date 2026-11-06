import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { composeEnvironment } from "../dist/connection.js";
import { discoverRuntime, pluginCacheDir } from "../dist/runtime.js";
import { catalogKey } from "../dist/tool-catalog.js";

const browserAccessWrapper =
    'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"';
const platform = {
    supported: true,
    platform: "darwin",
    label: "macOS",
    verification: "verified",
    isSimulated: false,
};

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "pi-cua-runtime-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const codexHome = join(root, "codex");
    const appPath = join(root, "ChatGPT.app");
    const runtimeRoot = join(appPath, "Contents", "Resources", "cua_node");
    const command = join(runtimeRoot, "bin", "node_repl");
    const nodeModules = join(runtimeRoot, "lib", "node_modules");
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, "");
    const env = {
        NODE_REPL_NODE_PATH: join(runtimeRoot, "bin", "node"),
        NODE_REPL_NODE_MODULE_DIRS: nodeModules,
        NODE_REPL_JS_BANNER: 'await import("@oai/cua/tinyskyAlt");\n',
        NODE_REPL_TRUSTED_SERVICES: JSON.stringify({
            browser: "@oai/browser-desktop/service",
            sky: "@oai/sky/service",
        }),
        BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab,mcpapps",
    };
    return {
        command,
        appPath,
        runtimeRoot,
        nodeModules,
        env,
        async config(version, server) {
            const path = join(pluginCacheDir(codexHome), version, ".mcp.json");
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify({
                mcpServers: { cua_repl: { enabled: true, env, ...server } },
            }));
            return path;
        },
        discover: () => discoverRuntime({ env: { CODEX_HOME: codexHome }, platform }),
    };
}

function wrapped(command, args = []) {
    return {
        command: "/bin/sh",
        args: ["-c", browserAccessWrapper, "cua-repl", command, ...args],
        env_vars: [
            "BROWSER_USE_ACCESS_EXECUTOR_ID",
            "BROWSER_USE_ACCESS_PIPE_PATH",
            "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
        ],
    };
}

test("discovers the actual executable behind Desktop's browser-access wrapper", async (t) => {
    const f = await fixture(t);
    const configPath = await f.config("26.1103.31037", wrapped(f.command, ["--help"]));
    const plan = await f.discover();
    assert.equal(plan.kind, "plan");
    assert.equal(plan.source, "plugin-cache");
    assert.equal(plan.command, f.command);
    assert.deepEqual(plan.args, ["--help"]);
    assert.equal(plan.runtimeRoot, f.runtimeRoot);
    assert.equal(plan.appPath, f.appPath);
    assert.equal(plan.nodeModules, f.nodeModules);
    assert.equal(plan.configPath, configPath);
    assert.equal(plan.appVersion, "26.1103.31037");
    assert.deepEqual(plan.env, f.env);
});

test("skips a wrapped executable that is missing instead of accepting the shell", async (t) => {
    const f = await fixture(t);
    await f.config("26.1103.31037", wrapped(join(f.runtimeRoot, "bin", "missing")));
    const previous = await f.config("26.930.31730", { command: f.command, args: [] });
    const plan = await f.discover();
    assert.equal(plan.configPath, previous);
    assert.equal(plan.command, f.command);
});

test("preserves legacy launches and removes only the browser-access preload", async (t) => {
    const f = await fixture(t);
    await f.config("26.930.31730", {
        command: f.command,
        args: [
            "--import", "/runtime/require-browser-access.mjs",
            "--import", "/runtime/other.mjs",
            "/runtime/cua-repl.mjs",
        ],
    });
    const plan = await f.discover();
    assert.equal(plan.command, f.command);
    assert.deepEqual(plan.args, ["--import", "/runtime/other.mjs", "/runtime/cua-repl.mjs"]);
    assert.equal(plan.runtimeRoot, f.runtimeRoot);
});

test("does not unwrap a shell script with additional behavior", async (t) => {
    const f = await fixture(t);
    const args = ["-c", `${browserAccessWrapper}; echo extra`, "cua-repl", f.command];
    await f.config("26.1103.31037", { command: "/bin/sh", args });
    const plan = await f.discover();
    assert.equal(plan.command, "/bin/sh");
    assert.deepEqual(plan.args, args);
});

test("keeps the host environment isolated and applies feature flags after discovery", async (t) => {
    const f = await fixture(t);
    await f.config("26.1103.31037", wrapped(f.command));
    const plan = await f.discover();
    const { env } = composeEnvironment(plan, { computerUse: false, browserUse: true }, {
        HOME: "/home/example",
        BROWSER_USE_ACCESS_EXECUTOR_ID: "desktop-executor",
        BROWSER_USE_ACCESS_PIPE_PATH: "/desktop/pipe",
        BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "desktop-identity",
        SECRET: "must-not-reach-the-runtime",
    });
    assert.equal(env.HOME, "/home/example");
    assert.equal(env.SECRET, undefined);
    for (const key of wrapped(f.command).env_vars) assert.equal(env[key], undefined);
    assert.equal(env.CUA_REPL_ENABLED_SURFACES, "browser");
    assert.equal(env.BROWSER_USE_AVAILABLE_BACKENDS, "chrome");
    assert.deepEqual(JSON.parse(env.NODE_REPL_TRUSTED_SERVICES), {
        browser: "@oai/browser-desktop/service",
    });
});

test("invalidates the tool catalog when a wrapped launch is normalized", async (t) => {
    const f = await fixture(t);
    const server = wrapped(f.command);
    await f.config("26.1103.31037", server);
    const plan = await f.discover();
    const state = { computerUse: true, browserUse: true };
    const oldPlan = { ...plan, command: server.command, args: server.args, runtimeRoot: "/", appPath: undefined };
    assert.notEqual(catalogKey(plan, state), catalogKey(oldPlan, state));
});
