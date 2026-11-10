import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import backgroundExec from "../src/background-exec.ts";
import { hasPendingBackgroundWork } from "../src/background-work.ts";
import { createContext, createFakePi } from "./fake-pi.ts";

const SESSION_ID = "session-1";
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-background-exec-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function start(options: { mode?: string; isIdle?: () => boolean } = {}) {
  const fake = createFakePi();
  backgroundExec(fake.pi);
  const ctx = createContext({ sessionId: SESSION_ID, sessionDir: directory, cwd: directory, ...options });
  const run = (command: string) =>
    fake.tools.get("background_exec").execute("call", { command }, undefined, undefined, ctx);
  const job = (jobId: string, action: "status" | "cancel") =>
    fake.tools.get("background_job").execute("call", { jobId, action }, undefined, undefined, ctx);
  return { ...fake, ctx, run, job };
}

function savedResult(result: { details: { resultPath: string } }) {
  return JSON.parse(readFileSync(result.details.resultPath, "utf8"));
}

describe("background_exec", () => {
  test("wakes an idle session with the job's status and log tail", async () => {
    const pi = start();
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);

    const launched = await pi.run("printf 'one\\ntwo\\n'");
    expect(launched.details.status).toBe("running");

    await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
    const { message, options } = pi.messages[0];
    expect(message.customType).toBe("background-job-finished");
    expect(message.details).toMatchObject({ jobId: launched.details.jobId, status: "succeeded", exitCode: 0 });
    expect(message.content).toContain('"logTail":"one\\ntwo\\n"');
    expect(message.content).toContain('"remainingJobs":0');
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(savedResult(launched)).toMatchObject({ status: "succeeded", exitCode: 0 });
  });

  test("reports pending work until its result message is delivered", async () => {
    const pi = start();
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);

    await pi.run("sleep 0.2");
    expect(hasPendingBackgroundWork(pi.pi, SESSION_ID)).toBe(true);
    expect(hasPendingBackgroundWork(pi.pi, "other-session")).toBe(false);

    await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
    expect(hasPendingBackgroundWork(pi.pi, SESSION_ID)).toBe(true);

    await pi.emit("message_end", { message: { role: "custom", ...pi.messages[0].message } }, pi.ctx);
    expect(hasPendingBackgroundWork(pi.pi, SESSION_ID)).toBe(false);
  });

  test("holds results during a run and sends them together at the turn boundary", async () => {
    const pi = start({ isIdle: () => false });
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);
    await pi.emit("agent_start", {}, pi.ctx);

    const succeeded = await pi.run("true");
    const failed = await pi.run("exit 3");
    await vi.waitFor(() => {
      expect(savedResult(succeeded).status).toBe("succeeded");
      expect(savedResult(failed).status).toBe("failed");
    });
    expect(pi.messages).toHaveLength(0);

    await pi.emit("turn_end", {}, pi.ctx);
    expect(pi.messages).toHaveLength(1);
    const { message } = pi.messages[0];
    expect(message.customType).toBe("background-jobs-finished");
    expect(message.details.jobs.map((job: { status: string; exitCode: number }) => [job.status, job.exitCode])).toEqual(
      [
        ["succeeded", 0],
        ["failed", 3],
      ],
    );
  });

  test("background_job cancels a running job", async () => {
    const pi = start();
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);

    const launched = await pi.run("sleep 30");
    const status = await pi.job(launched.details.jobId, "status");
    expect(status.details.status).toBe("running");

    const cancelled = await pi.job(launched.details.jobId, "cancel");
    expect(cancelled.details.status).toBe("cancelled");
    expect(savedResult(launched).status).toBe("cancelled");
  });

  test("session shutdown cancels running jobs without waking the agent", async () => {
    const pi = start();
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);

    const launched = await pi.run("sleep 30");
    await pi.emit("session_shutdown", { reason: "quit" }, pi.ctx);

    expect(savedResult(launched)).toMatchObject({ status: "cancelled", error: "Session quit" });
    expect(pi.messages).toHaveLength(0);
    expect(hasPendingBackgroundWork(pi.pi, SESSION_ID)).toBe(false);
  });

  test("refuses to start outside TUI and RPC sessions", async () => {
    const pi = start({ mode: "print" });
    await pi.emit("session_start", { reason: "startup" }, pi.ctx);

    await expect(pi.run("true")).rejects.toThrow("requires a long-lived interactive or RPC session");
  });
});
