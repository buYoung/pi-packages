import type { TranscriptContext } from "@earendil-works/pi-ai";

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
 * The history with each tool result's images replaced by a note once the model has answered `TOOL_IMAGE_RESPONSES` times
 * after it. An image from `read` keeps its path in the note, so the model can read it again. Images the user attached
 * stay, because the model cannot get them back. Pi's messages are not changed; without old images the same context returns.
 */
export function withoutOldToolImages(context: TranscriptContext): TranscriptContext {
  const { messages } = context;
  const readPaths = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && block.name === "read" && typeof block.arguments.path === "string") readPaths.set(block.id, block.arguments.path);
    }
  }
  let responses = 0;
  let result: ContextMessage[] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
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
