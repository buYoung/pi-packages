import { input, select } from "@inquirer/prompts";
import { fetchModelIds } from "../../src/models/api.ts";
import { OLLAMA_BASE } from "../../src/models/base.ts";
import { runChat } from "./chat.ts";
import { runDiagnostic } from "./diagnostics.ts";
import { showModelMetadata } from "./models.ts";
import { DIAGNOSTICS, MENU_CHOICES } from "./registry.ts";
import { packageFeature } from "./verify.ts";

export interface CliDependencies {
  select: (
    options: { message: string; choices: { name: string; value: string }[]; loop: boolean; pageSize?: number },
    context: { signal: AbortSignal },
  ) => Promise<string>;
  input: (
    options: { message: string; validate: (value: string) => boolean | string },
    context: { signal: AbortSignal },
  ) => Promise<string>;
  fetchModelIds: typeof fetchModelIds;
  runChat: typeof runChat;
  isTTY: boolean;
  runDiagnostic?: (id: string, signal: AbortSignal) => Promise<void>;
  showMetadata?: typeof showModelMetadata;
}
export async function runCLI(
  args = process.argv.slice(2),
  dependencies: CliDependencies = {
    select,
    input,
    fetchModelIds,
    runChat,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  },
): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`Ollama Cloud feature check CLI

Run: pnpm --filter @buyong/pi-ollama-cloud cli

- Model list: live lookup from ${OLLAMA_BASE}/v1/models
- Model metadata: capability and reasoning values from the public API, with the source of each value
- Per-feature/full verification: temporary fixtures and mocked transport; full verification also checks the real pnpm package
- 1+1 chat: choose from the list or enter a model ID directly (uses real API quota)
- Direct entry: valid IDs missing from the list, such as glm-5.3-flash:cloud, are sent as entered
- Authentication: the Ollama Cloud key saved in Pi's auth.json, otherwise OLLAMA_API_KEY
- Exit: choose Exit in the menu or press Ctrl+C

Run it in an interactive terminal in the monorepo after pnpm install.`);
    return;
  }
  if (args.length > 0) {
    throw new Error("Unsupported arguments. See pnpm --filter @buyong/pi-ollama-cloud cli --help.");
  }
  if (!dependencies.isTTY) {
    throw new Error(
      "An interactive terminal is required. Run pnpm --filter @buyong/pi-ollama-cloud cli in a terminal.",
    );
  }

  const controller = new AbortController();
  let exitCode = 130;
  const interrupt = () => controller.abort();
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  try {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    console.log("Ollama Cloud feature check\nThe model list comes from the public API. Chat uses real API quota.\n");

    while (!controller.signal.aborted) {
      try {
        const action = await dependencies.select(
          {
            message: "Choose a feature to check.",
            choices: MENU_CHOICES,
            loop: false,
          },
          { signal: controller.signal },
        );
        if (action === "exit") return;
        if (action === "metadata") {
          await (dependencies.showMetadata ?? showModelMetadata)(controller.signal);
          continue;
        }
        if (action === "diagnostics" || action === "verify") {
          const id =
            action === "verify"
              ? "all"
              : await dependencies.select(
                  {
                    message: "Choose an offline verification.",
                    choices: [
                      ...DIAGNOSTICS.map((item) => ({ name: item.name, value: item.id })),
                      { name: "Back", value: "" },
                    ],
                    loop: false,
                    pageSize: 12,
                  },
                  { signal: controller.signal },
                );
          if (!id) continue;
          if (dependencies.runDiagnostic) await dependencies.runDiagnostic(id, controller.signal);
          else {
            const feature = id === "all" ? packageFeature : DIAGNOSTICS.find((item) => item.id === id)?.feature();
            if (!feature) throw new Error("Unknown feature.");
            await runDiagnostic(feature, controller.signal);
          }
          continue;
        }
        if (action === "manual") {
          const modelId = await dependencies.input(
            {
              message: "Enter a model ID (for example, glm-5.3-flash:cloud).",
              validate: (value) => value.trim().length > 0 || "Enter a model ID.",
            },
            { signal: controller.signal },
          );
          await dependencies.runChat(modelId.trim(), controller.signal);
          continue;
        }

        console.log(`\nFetching the model list: ${OLLAMA_BASE}/v1/models`);
        const modelIds = [...new Set(await dependencies.fetchModelIds(controller.signal))].sort();
        if (modelIds.length === 0) {
          throw new Error("Ollama returned an empty model list. Try again later.");
        }
        if (action === "models") {
          console.log(`${modelIds.length} models\n${modelIds.map((id, index) => `${index + 1}. ${id}`).join("\n")}\n`);
          continue;
        }

        const modelId = await dependencies.select(
          {
            message: "Choose a model to send 1+1 to.",
            choices: [...modelIds.map((id) => ({ name: id, value: id })), { name: "Back", value: "" }],
            pageSize: 12,
            loop: false,
          },
          { signal: controller.signal },
        );
        if (modelId) await dependencies.runChat(modelId, controller.signal);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && ["ExitPromptError", "AbortPromptError"].includes(error.name))
        ) {
          console.log("\nExiting.");
          process.exitCode = exitCode;
          return;
        }
        console.error(`\nFeature check failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    process.exitCode = exitCode;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
