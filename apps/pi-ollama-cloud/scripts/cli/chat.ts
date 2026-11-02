import { CHAT_PROMPT, completeOllamaChat } from "../../src/pi/chat.ts";

export async function runChat(modelId: string, signal: AbortSignal): Promise<void> {
  console.log(`\nModel: ${modelId}\nPrompt: ${CHAT_PROMPT}\nWaiting for a response...`);
  const result = await completeOllamaChat(modelId, signal);
  console.log(`Response:\n${result.answer}\n`);
  if (result.truncated) console.warn("The response reached the output token limit and may be truncated.");
}
