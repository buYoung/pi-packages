import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import backgroundExec from "../src/background-exec.ts";
import { trackBackgroundWork } from "../src/background-work.ts";
import herdrAgentState from "../src/herdr-agent-state.ts";
import { createContext, createFakePi } from "./fake-pi.ts";

const SESSION_ID = "session-1";
const PANE_ID = "w1:p1";
const ENV_KEYS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;

let directory: string;
let server: net.Server;
let requests: any[];
let savedEnv: Record<string, string | undefined>;

/** A Herdr socket that records each request and acknowledges it as Herdr does. */
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "pi-herdr-state-"));
  requests = [];
  server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(request);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
      }
    });
  });
  const socketPath = join(directory, "herdr.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: PANE_ID,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
  });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

function states() {
  return requests
    .filter((request) => request.method === "pane.report_agent")
    .map((request) => [request.params.state, request.params.message ?? null]);
}

function start(options: { mode?: string; isIdle?: () => boolean } = {}) {
  const fake = createFakePi();
  const ctx = createContext({ sessionId: SESSION_ID, sessionDir: directory, cwd: directory, ...options });
  return { ...fake, ctx };
}

describe("Herdr agent state", () => {
  test("stays working while a background job runs and goes idle after its result is handled", async () => {
    let idle = true;
    const pi = start({ isIdle: () => idle });
    backgroundExec(pi.pi);
    herdrAgentState(pi.pi);
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);
    await vi.waitFor(() => expect(states()).toEqual([["idle", null]]));

    idle = false;
    await pi.emit("before_agent_start", {}, pi.ctx);
    await pi.emit("agent_start", {}, pi.ctx);
    await pi.tools.get("background_exec").execute("call", { command: "sleep 0.2" }, undefined, undefined, pi.ctx);
    idle = true;
    await pi.emit("agent_settled", { aborted: false }, pi.ctx);

    // The finished job wakes the agent; its run delivers the result and settles.
    await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
    idle = false;
    await pi.emit("agent_start", {}, pi.ctx);
    await pi.emit("message_end", { message: { role: "custom", ...pi.messages[0].message } }, pi.ctx);
    idle = true;
    await pi.emit("agent_settled", { aborted: false }, pi.ctx);

    await vi.waitFor(() =>
      expect(states()).toEqual([
        ["idle", null],
        ["working", null],
        ["idle", null],
      ]),
    );
    const report = requests.find((request) => request.method === "pane.report_agent");
    expect(report.params).toMatchObject({
      pane_id: PANE_ID,
      source: "herdr:pi",
      agent: "pi",
      agent_session_path: `${directory}/${SESSION_ID}.jsonl`,
    });
    const stateSeqs = requests
      .filter((request) => request.method === "pane.report_agent")
      .map((request) => request.params.seq);
    expect(stateSeqs).toEqual([...stateSeqs].sort((a, b) => a - b));
    expect(new Set(requests.map((request) => request.params.seq)).size).toBe(requests.length);
  });

  test("an aborted run goes idle even while background work is pending", async () => {
    const pi = start();
    herdrAgentState(pi.pi);
    trackBackgroundWork(pi.pi, SESSION_ID, () => true);
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);
    await pi.emit("agent_start", {}, pi.ctx);
    // States queued while a report is in flight collapse to the latest one.
    await vi.waitFor(() => expect(states()).toHaveLength(2));
    await pi.emit("agent_settled", { aborted: true }, pi.ctx);

    await vi.waitFor(() =>
      expect(states()).toEqual([
        ["idle", null],
        ["working", null],
        ["idle", null],
      ]),
    );
  });

  test("reports blocked with its label until the prompt closes", async () => {
    const pi = start({ isIdle: () => false });
    herdrAgentState(pi.pi);
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);
    await vi.waitFor(() => expect(states()).toEqual([["working", null]]));

    pi.pi.events.emit("herdr:blocked", { active: true, label: "Approve command?" });
    await vi.waitFor(() => expect(states().at(-1)).toEqual(["blocked", "Approve command?"]));
    pi.pi.events.emit("herdr:blocked", { active: false });
    await vi.waitFor(() =>
      expect(states()).toEqual([
        ["working", null],
        ["blocked", "Approve command?"],
        ["working", null],
      ]),
    );
  });

  test("stays inactive while Herdr's own Pi integration is installed", async () => {
    mkdirSync(join(directory, "agent", "extensions"), { recursive: true });
    writeFileSync(join(directory, "agent", "extensions", "herdr-agent-state.ts"), "// HERDR_INTEGRATION_ID=pi\n");
    const pi = start();
    herdrAgentState(pi.pi);

    expect(pi.handlers.size).toBe(0);
  });

  test("reports nothing outside a TUI session", async () => {
    const pi = start({ mode: "rpc" });
    herdrAgentState(pi.pi);
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);
    await pi.emit("agent_start", {}, pi.ctx);
    await pi.emit("agent_settled", { aborted: false }, pi.ctx);
    pi.pi.events.emit("herdr:blocked", { active: true, label: "Approve command?" });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toHaveLength(0);
  });
});
