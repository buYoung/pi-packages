import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntime } from "../../app/runtime.ts";
import type { DevinAPI } from "../../features/catalog/types.ts";

/** Pi's provider contract, and nothing else: extension features reach the services through the runtime. */
export interface DevinProvider extends Provider<DevinAPI> {
  refreshModels: NonNullable<Provider<DevinAPI>["refreshModels"]>;
}

/** A Pi event that moves the session's run state, as the registration records it before the runtime loads. */
export type RunEvent =
  | { readonly type: "before_agent_start" | "agent_start" | "agent_settled" | "session_before_tree" | "session_tree" }
  | { readonly type: "session_before_compact" | "session_compact" | "session_compact_failed"; readonly reason: "manual" | "threshold" | "overflow" };

/**
 * One extension instance's runtime and the behavior behind what the registration put in Pi: its own provider (which the
 * registered routing provider reaches), the tool and commands, and the event handlers. Each method runs its effects synchronously,
 * as Pi's event handlers require, except the command and tool bodies.
 */
export interface DevinInstance {
  readonly runtime: ExtensionRuntime;
  readonly provider: DevinProvider;
  readonly isInAuxiliaryPhase: () => boolean;
  /** Only in the lead. */
  readonly sidekickTool: ToolDefinition | undefined;
  readonly devinCommand: (args: string, context: ExtensionCommandContext) => Promise<void>;
  readonly fusionCommand: (args: string, context: ExtensionCommandContext) => Promise<void>;
  /** Binds the provider to the session's stored run state. Fails on a corrupt state. */
  readonly attachSession: (context: ExtensionContext) => void;
  /** After `attachSession`: the sidekick's session, the sidekick tool and the status line. */
  readonly sessionStarted: (context: ExtensionContext) => void;
  readonly modelSelected: (model: Model<any> | undefined, context: ExtensionContext) => void;
  readonly userInput: (source: "interactive" | "rpc" | "extension") => void;
  readonly messageEnded: (message: unknown, context: ExtensionContext) => void;
  readonly updateStatus: (context: ExtensionContext) => void;
  readonly applyRunEvent: (event: RunEvent) => void;
  /** The session's end before the routing stops reaching this instance: the status line and the sidekick. */
  readonly sessionEnding: () => void;
  /** Ends the provider lifetime; the instance stays usable for the next session. */
  readonly shutdown: () => void;
}
