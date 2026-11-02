import assert from "node:assert/strict";
import { createUsageStatusRefreshGuard } from "../../src/usage/status.ts";
import {
  createUsageStatusController,
  USAGE_REFRESH_MS,
  type UsageStatusTarget,
} from "../../src/usage/status-controller.ts";
import { withMockFetch } from "./mock-transport.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const usageFeature: VerificationFeature = {
  id: "09-usage-cancel",
  cli: "scripts/cli/usage.ts",
  shared: ["src/usage/status.ts", "src/usage/status-controller.ts"],
  consumers: ["src/pi/lifecycle.ts"],
  async verify({ check }) {
    await check("Shared controller timer, deduplication, stop/restart, non-TUI, and final fetch signal", async () => {
      const requests: { signal: AbortSignal; finish: () => void }[] = [];
      let onStart = () => {};
      let onStatus = (_text: string | undefined) => {};
      let timer: (() => void) | undefined;
      let timerCount = 0;
      const controller = createUsageStatusController({
        now: () => 1_000_000,
        schedule(callback, intervalMs) {
          assert.equal(intervalMs, USAGE_REFRESH_MS);
          timer = callback;
          timerCount += 1;
          return () => {
            timerCount -= 1;
          };
        },
      });
      const target: UsageStatusTarget = {
        isTUI: true,
        isCurrent: () => true,
        resolveApiKey: async () => "fixture",
        format: () => "fresh status",
        setStatus: (text) => onStatus(text),
      };
      try {
        await withMockFetch(
          async (_url, init) =>
            new Promise<Response>((resolve, reject) => {
              const signal = init?.signal;
              assert.ok(signal);
              const abort = () => reject(new DOMException("fixture cancellation", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              requests.push({
                signal,
                finish: () => {
                  signal.removeEventListener("abort", abort);
                  resolve(Response.json({ included: { monthly: { remaining_percent: 80 } } }));
                },
              });
              onStart();
            }),
          async () => {
            await new Promise<void>((resolve) => {
              onStart = resolve;
              controller.start(target);
            });
            timer?.();
            await controller.afterTurn(target);
            assert.equal(requests.length, 1);
            controller.stop();
            assert.equal(requests[0].signal.aborted, true);
            assert.equal(timerCount, 0);
            await new Promise<void>((resolve) => {
              onStart = resolve;
              controller.start(target);
            });
            await new Promise<void>((resolve) => {
              onStatus = (text) => {
                if (text === "fresh status") resolve();
              };
              requests[1].finish();
            });
            controller.stop();
            controller.start({ ...target, isTUI: false });
            assert.equal(timerCount, 0);
            assert.equal(requests.length, 2);
          },
        );
      } finally {
        controller.stop();
      }
    });
    await check("Stopping cancels the in-flight request signal and discards late results", async () => {
      const guard = createUsageStatusRefreshGuard();
      let observedSignal: AbortSignal | undefined;
      let finish: (text: string) => void = () => {
        throw new Error("Request did not start");
      };
      const statuses: (string | undefined)[] = [];
      const task = guard.run(
        () => true,
        (_current, signal?: AbortSignal) => {
          observedSignal = signal;
          return new Promise<string>((resolve) => {
            finish = resolve;
          });
        },
        (text) => statuses.push(text),
      );
      try {
        guard.invalidate();
        assert.equal(observedSignal?.aborted, true);
      } finally {
        finish("stale");
        await task;
      }
      assert.deepEqual(statuses, []);
    });
    await check("A new generation runs and concurrent triggers do not send duplicate requests", async () => {
      const guard = createUsageStatusRefreshGuard();
      let calls = 0;
      let finish: (text: string) => void = () => {
        throw new Error("Request did not start");
      };
      const statuses: (string | undefined)[] = [];
      const refresh = async () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      };
      const first = guard.run(
        () => true,
        refresh,
        (text) => statuses.push(text),
      );
      await guard.run(
        () => true,
        refresh,
        (text) => statuses.push(text),
      );
      assert.equal(calls, 1);
      finish("first");
      await first;
      guard.invalidate();
      const second = guard.run(
        () => true,
        refresh,
        (text) => statuses.push(text),
      );
      finish("second");
      await second;
      assert.deepEqual(statuses, ["first", "second"]);
      assert.equal(calls, 2);
    });
  },
};
runFeature(import.meta.url, usageFeature);
