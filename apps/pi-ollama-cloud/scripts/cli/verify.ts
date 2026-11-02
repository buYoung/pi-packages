import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TIMEOUT_MS, completeOllamaChat, MAX_RESPONSE_TOKENS } from "../../src/pi/chat.ts";
import { assertRuntimeBoundary, packArtifact, packageRoot, runtimeFiles } from "../lib/verification/artifact.ts";
import { verifyPackageConsumer } from "../lib/verification/consumer.ts";
import { withMockFetch } from "./mock-transport.ts";
import { DIAGNOSTICS } from "./registry.ts";
import { runFeature, type VerificationFeature } from "./verification.ts";

export const packageFeature: VerificationFeature = {
  id: "11-package-gates",
  cli: "scripts/cli/verify.ts",
  shared: [
    "scripts/cli/registry.ts",
    "scripts/lib/verification/artifact.ts",
    "scripts/lib/verification/consumer.ts",
    "test/fixtures/package-contract.ts",
    "test/fixtures/package-inventory.json",
  ],
  consumers: [".github/workflows/pi-packages.yml", "scripts/smoke-web-tools.ts"],
  async verify({ check }) {
    const temp = mkdtempSync(join(tmpdir(), "ollama-package-"));
    const names = ["PI_CODING_AGENT_DIR", "OLLAMA_API_KEY", "OLLAMA_API_BASE"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.PI_CODING_AGENT_DIR = join(temp, "diagnostic-agent");
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_BASE;
    try {
      await check("10 independent features with unique IDs in the static registry", async () => {
        assert.equal(DIAGNOSTICS.length, 10);
        assert.equal(new Set(DIAGNOSTICS.map((item) => item.id)).size, 10);
        for (const item of DIAGNOSTICS) assert.equal(item.id, item.feature().id);
      });
      for (const item of DIAGNOSTICS) {
        await item.feature().verify({ check: (name, run, inputs) => check(`${item.id}: ${name}`, run, inputs) });
      }
      await check("Shared chat path limits for the minimal live call, with no automatic retry", async () => {
        assert.equal(CHAT_TIMEOUT_MS, 120000);
        assert.equal(MAX_RESPONSE_TOKENS, 4096);
        let calls = 0;
        await withMockFetch(
          async (url) => {
            if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["tools"] });
            calls += 1;
            return new Response("fixture failure", { status: 500 });
          },
          async () => {
            await assert.rejects(
              completeOllamaChat("glm-5.3-flash:cloud", new AbortController().signal, async () => ({
                apiKey: "fixture",
                source: "auth.json",
              })),
            );
          },
        );
        assert.equal(calls, 1);
      });
      await check("Runtime dependency boundary and fixed file inventory", async () => {
        assertRuntimeBoundary();
        const inventory = JSON.parse(
          readFileSync(join(packageRoot, "test/fixtures/package-inventory.json"), "utf8"),
        ) as { requiredFiles: string[] };
        assert.deepEqual(runtimeFiles(), [...inventory.requiredFiles].sort());
      });
      const artifact = packArtifact(temp);
      await check("Real pnpm archive: all required files, identical bytes, production deps only", async () => {
        assert.ok(artifact.files.includes("src/generated/catalog.generated.ts"));
        assert.ok(artifact.dependencies.some((dependency) => dependency.name === "proper-lockfile"));
      });
      for (const profile of ["enabled", "soft-disabled", "hard-disabled"] as const) {
        await check(`source/artifact match: ${profile} inventory, commands, reload, real tools, payload`, async () => {
          const source = verifyPackageConsumer(packageRoot, join(temp, `source-${profile}`), profile);
          const packed = verifyPackageConsumer(artifact.root, join(temp, `packed-${profile}`), profile);
          assert.deepEqual(packed, source);
        });
      }
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(temp, { recursive: true, force: true });
    }
  },
};
runFeature(import.meta.url, packageFeature);
