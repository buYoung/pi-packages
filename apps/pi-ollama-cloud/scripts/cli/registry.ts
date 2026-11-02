import { authFeature } from "./auth.ts";
import { budgetsFeature } from "./budgets.ts";
import { catalogFeature } from "./catalog.ts";
import { coreFeature } from "./core.ts";
import { generatedFeature } from "./generated.ts";
import { modelsFeature } from "./models.ts";
import { renderFeature } from "./render.ts";
import { sharingFeature } from "./sharing.ts";
import { usageFeature } from "./usage.ts";
import type { VerificationFeature } from "./verification.ts";
import { webFeature } from "./web.ts";

// Static imports, deferred access: the core diagnostic also exercises the CLI runner.
export const DIAGNOSTICS: { id: string; name: string; feature: () => VerificationFeature }[] = [
  { id: "01-core-cli", name: "Shared paths and CLI", feature: () => coreFeature },
  { id: "02-auth", name: "Auth references and cancellation", feature: () => authFeature },
  { id: "03-model-metadata", name: "Model metadata and reasoning", feature: () => modelsFeature },
  { id: "04-catalog-cache", name: "Catalog restore and retry", feature: () => catalogFeature },
  { id: "05-fetch-recovery", name: "Page failure and recovery", feature: () => webFeature },
  { id: "06-tool-renderer", name: "Result renderer", feature: () => renderFeature },
  { id: "07-cache-budgets", name: "Retention, return size, and continued reads", feature: () => budgetsFeature },
  { id: "08-cache-sharing", name: "Concurrent requests and process merge", feature: () => sharingFeature },
  { id: "09-usage-cancel", name: "Usage refresh cancellation", feature: () => usageFeature },
  { id: "10-generators", name: "Generated data transactions", feature: () => generatedFeature },
];
export const MENU_CHOICES = [
  { name: "List models", value: "models" },
  { name: "Show model metadata and sources (public API)", value: "metadata" },
  { name: "Choose a model for a 1+1 chat", value: "chat" },
  { name: "Enter a model ID for a 1+1 chat", value: "manual" },
  { name: "Per-feature verification (offline)", value: "diagnostics" },
  { name: "Full feature and package verification (offline)", value: "verify" },
  { name: "Exit", value: "exit" },
];
