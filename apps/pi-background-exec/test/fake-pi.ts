import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;

/** A Pi API stub that records handlers, tools, and sent messages, with Pi's real event bus. */
export function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const messages: { message: any; options: any }[] = [];
  const pi = {
    events: createEventBus(),
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool: (tool: any) => {
      tools.set(tool.name, tool);
    },
    sendMessage: (message: any, options: any) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  /** Runs every handler for `name` in registration order, as Pi does. */
  async function emit(name: string, event: Record<string, unknown>, ctx: unknown): Promise<void> {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
  }

  return { pi, handlers, tools, messages, emit };
}

export function createContext(options: {
  sessionId: string;
  sessionDir: string;
  cwd: string;
  mode?: string;
  isIdle?: () => boolean;
}) {
  return {
    mode: options.mode ?? "tui",
    cwd: options.cwd,
    isIdle: options.isIdle ?? (() => true),
    sessionManager: {
      getSessionId: () => options.sessionId,
      getSessionDir: () => options.sessionDir,
      getSessionFile: () => `${options.sessionDir}/${options.sessionId}.jsonl`,
    },
  };
}
