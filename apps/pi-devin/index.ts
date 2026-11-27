import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDevinExtension } from "./src/pi/adapters/pi/registration.ts";
import type { DevinInstance } from "./src/pi/adapters/pi/types.ts";
import { FUSION_CHILD_ENV } from "./src/pi/features/sidekick/prompts.ts";

/**
 * Pi's entry point. It imports nothing that loads Effect, `@effect/platform-node` or protobufjs: the lead loads its runtime on
 * first use. The Fusion sidekick child exists only to run Devin requests, so it loads at once.
 */
export default async function devinExtension(pi: ExtensionAPI): Promise<void> {
  const isFusionChild = process.env[FUSION_CHILD_ENV] === "1";
  const load = async (): Promise<DevinInstance> => {
    const [{ makeDevinInstance }, { productionEnvironment }] = await Promise.all([
      import("./src/pi/adapters/pi/instance.ts"), import("./src/pi/app/environment.ts"),
    ]);
    return makeDevinInstance(pi, productionEnvironment({ isFusionChild }));
  };
  registerDevinExtension(pi, { isFusionChild, instance: isFusionChild ? await load() : load, agentDir: getAgentDir });
}
