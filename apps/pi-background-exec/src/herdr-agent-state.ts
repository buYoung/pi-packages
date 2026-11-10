// Derived from Herdr's Pi integration (`src/integration/assets/pi/herdr-agent-state.ts`, integration version 9,
// Herdr 0.9.5), licensed under the Apache License, Version 2.0. Changed for this package: typed state kept per
// extension instance, inactive while Herdr's own Pi integration is installed, and `working` kept while
// session-owned background work will wake the agent again.

/**
 * Report this Pi pane's agent state to Herdr. Herdr keeps one reporter per pane and drops a report whose sequence
 * is not newer than the last one from the same source, so this extension must be the only `herdr:pi` reporter.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasPendingBackgroundWork } from "./background-work.ts";

/** Herdr gives full lifecycle authority, which replaces its screen detection, only to this source for agent `pi`. */
const source = "herdr:pi";

type AgentState = "working" | "blocked" | "idle";

/** Herdr's installer writes its Pi integration here; a second `herdr:pi` reporter would drop its reports. */
function isHerdrPiIntegrationInstalled(): boolean {
  try {
    const file = path.join(getAgentDir(), "extensions", "herdr-agent-state.ts");
    return readFileSync(file, "utf8").includes("HERDR_INTEGRATION_ID=pi");
  } catch {
    return false;
  }
}

function sendRequestAttempt(endpoint: string, request: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };
    const socket = net.createConnection(endpoint);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(endpoint: string, request: unknown): Promise<void> {
  if (await sendRequestAttempt(endpoint, request, 500)) return;
  await sendRequestAttempt(endpoint, request, 1500);
}

export default function (pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !socketPath || !paneId || isHerdrPiIntegrationInstalled()) return;
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  // Microsecond-scale, as in Herdr's own integration, so either one's reports stay newer after switching between them.
  let reportSeq = Date.now() * 1000;
  let sessionId: string | undefined;
  let sessionPath: string | undefined;
  let sendInFlight = false;
  let queuedState: { state: AgentState; message?: string; seq: number } | undefined;

  let rootSession = false;
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;

  function nextReportSeq(): number {
    reportSeq += 1;
    return reportSeq;
  }

  function updateSessionRef(ctx: ExtensionContext): void {
    try {
      const file = ctx.sessionManager.getSessionFile();
      sessionPath =
        typeof file === "string" && (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) ? file : undefined;
    } catch {
      sessionPath = undefined;
    }
    try {
      const id = ctx.sessionManager.getSessionId();
      sessionId = typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
      sessionId = undefined;
    }
  }

  function sessionRef(): Record<string, string> | undefined {
    if (sessionPath) return { agent_session_path: sessionPath };
    if (sessionId) return { agent_session_id: sessionId };
    return undefined;
  }

  function reportSession(sessionStartSource?: string): Promise<void> {
    const ref = sessionRef();
    if (!ref) return Promise.resolve();
    return sendRequest(endpoint, {
      id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method: "pane.report_agent_session",
      params: {
        pane_id: paneId,
        source,
        agent: "pi",
        seq: nextReportSeq(),
        session_start_source: sessionStartSource,
        ...ref,
      },
    });
  }

  async function drainStateQueue(): Promise<void> {
    if (sendInFlight) return;
    sendInFlight = true;
    try {
      while (queuedState) {
        const next = queuedState;
        queuedState = undefined;
        await sendRequest(endpoint, {
          id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
          method: "pane.report_agent",
          params: {
            pane_id: paneId,
            source,
            agent: "pi",
            state: next.state,
            message: next.message,
            seq: next.seq,
            ...sessionRef(),
          },
        });
      }
    } finally {
      sendInFlight = false;
      if (queuedState) void drainStateQueue();
    }
  }

  function publishState(force = false): void {
    const state: AgentState = blockedCount > 0 ? "blocked" : agentActive ? "working" : "idle";
    const message = blockedCount > 0 ? blockedMessage : undefined;
    if (!force && state === lastState && message === lastMessage) return;
    lastState = state;
    lastMessage = message;
    // Only the latest state matters; one sent in the meantime would be stale.
    queuedState = { state, message, seq: nextReportSeq() };
    void drainStateQueue();
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    const event = data as { active?: unknown; label?: string } | undefined;
    if (!event?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
      publishState();
      return;
    }
    blockedCount += 1;
    blockedMessage = event.label;
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC, JSON, and print modes have no pane Herdr can display, and RPC still reports hasUI.
    if (ctx.mode !== "tui") return;
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event.reason);
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = !ctx.isIdle();
    publishState(true);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    updateSessionRef(ctx);
    void reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!rootSession || !ctx.isIdle()) return;
    // Pending work starts another run when it finishes, which settles this state; an abort hands control back now.
    if (!event.aborted && hasPendingBackgroundWork(pi, ctx.sessionManager.getSessionId())) return;
    agentActive = false;
    publishState();
  });
}
