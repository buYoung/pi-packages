import { getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";

/**
 * Successful model responses that still see an image a tool returned. In past sessions most images were not mentioned
 * again after the response that read them, and mentions slowed down after about three responses.
 */
export const TOOL_IMAGE_RESPONSES = 5;

type ContextMessage = TranscriptContext["messages"][number];

function omittedNote(path: string | undefined): string {
  return path
    ? `(image omitted after ${TOOL_IMAGE_RESPONSES} responses to save tokens: ${path}. Read the file again to see it.)`
    : `(image omitted after ${TOOL_IMAGE_RESPONSES} responses to save tokens)`;
}

/**
 * The index of the latest system message that changes the system prompt or the tools Devin receives, or -1. Devin gets
 * every system message folded into one prompt ahead of the conversation, so the first request after such a message
 * starts with an empty prompt cache anyway.
 */
function latestPromptChange(messages: readonly ContextMessage[]): number {
  let latest = -1;
  let header: string | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "system") return;
    const upTo = messages.slice(0, index + 1);
    const current = JSON.stringify([getCurrentSystemPrompt(upTo), getCurrentTools(upTo).map((tool) => [tool.name, tool.description, tool.parameters])]);
    if (header !== undefined && current !== header) latest = index;
    header = current;
  });
  return latest;
}

/**
 * The history with a tool result's images replaced by a note once the model had answered `TOOL_IMAGE_RESPONSES` times
 * after it by the latest change of the system prompt or tools. That request rebuilds the prompt cache anyway, and later
 * requests make the same choice from the same history, so leaving images out never breaks a cached prefix. An image from
 * `read` keeps its path in the note, so the model can read it again. Images the user attached stay, because the model
 * cannot get them back. Pi's messages are not changed; without such images the same context returns.
 */
export function withoutOldToolImages(context: TranscriptContext): TranscriptContext {
  const { messages } = context;
  const change = latestPromptChange(messages);
  if (change < 0) return context;
  const readPaths = new Map<string, string>();
  for (const message of messages.slice(0, change)) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string") readPaths.set(block.id, block.arguments.path);
    }
  }
  let responses = 0;
  let result: ContextMessage[] | undefined;
  for (let index = change - 1; index >= 0; index--) {
    const message = messages[index];
    // Failed and aborted responses are not sent to Devin, so they do not count.
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") responses++;
    if (message.role !== "toolResult" || responses < TOOL_IMAGE_RESPONSES || !message.content.some((block) => block.type === "image")) continue;
    const note = omittedNote(message.toolName === "read" ? readPaths.get(message.toolCallId) : undefined);
    const firstImage = message.content.findIndex((block) => block.type === "image");
    result ??= [...messages];
    result[index] = {
      ...message,
      content: message.content.flatMap((block, position) => block.type !== "image" ? [block] : position === firstImage ? [{ type: "text" as const, text: note }] : []),
    };
  }
  return result ? { ...context, messages: result } : context;
}
