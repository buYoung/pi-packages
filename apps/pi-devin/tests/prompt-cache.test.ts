// Consecutive requests of a growing conversation, as Devin receives them. A prompt cache can only reuse what a request
// shares from its start with the previous one, so earlier messages must reach Devin unchanged.
import { expect, test } from "vitest";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { CHAT_METHOD } from "../src/core/protocol/protobuf.ts";
import type { JsonObject } from "../src/core/types.ts";
import { OMITTED_IMAGE_NOTE } from "../src/pi/features/inference/image-budget.ts";
import type { ImageCompressorShape } from "../src/pi/features/inference/types.ts";
import { noisePng } from "./helpers.ts";
import { providerCredential, providerFixture } from "./provider-fixture.ts";

const MiB = 1024 * 1024;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
/** A PNG-signed image whose Base64 has `base64Bytes` characters and differs for every seed. */
const png = (seed: number, base64Bytes: number) => { const bytes = Buffer.alloc(base64Bytes * 3 / 4, seed); PNG_SIGNATURE.copy(bytes); return bytes.toString("base64"); };

const toolCall = (id: string, name: string, args: Record<string, string>): AssistantMessage => ({ role: "assistant", api: "devin-connect", provider: "devin", model: "m",
  content: [{ type: "thinking", thinking: `plan ${id}` }, { type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", usage, timestamp: 1 });
const readImage = (id: string, path: string, data: string): Message[] => [
  toolCall(id, "read", { path }),
  { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp: 1 },
];
const runCommand = (id: string, output: string): Message[] => [
  toolCall(id, "bash", { command: `step ${id}` }),
  { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: output }], isError: false, timestamp: 1 },
];
const instruction = (content: string): Message => ({ role: "system", content, timestamp: 1 });

/** What a prompt cache sees of a request: the prompt, the tools and each message, without per-request message IDs and cache marks. */
function cacheView(body: JsonObject) {
  return {
    header: JSON.stringify([body.prompt, body.tools]),
    messages: (body.chatMessagePrompts as JsonObject[]).map(({ messageId: _id, promptCacheOptions: _mark, ...rest }) => JSON.stringify(rest)),
  };
}

/** Sends the conversation as it stood before each model response and reports where a request stops sharing the previous one's start. */
async function sendGrowing(conversation: (Message | Message[])[], imageCompressor?: ImageCompressorShape) {
  const messages = conversation.flat();
  // A request is sent after a user message, a tool result or a system message, as Pi does before the next response.
  const ends = messages.flatMap((message, index) => message.role !== "assistant" && messages[index + 1]?.role !== "toolResult" && messages[index + 1]?.role !== "system" ? [index + 1] : []);
  const fixture = await providerFixture({ imageCompressor });
  try {
    for (const end of ends) {
      const stream = fixture.provider.streamSimple(fixture.model, normalizeContext({ systemPrompt: "base", messages: messages.slice(0, end) }),
        { apiKey: providerCredential.sessionToken, reasoning: "medium" });
      for await (const _event of stream) { /* drain */ }
      expect((await stream.result()).stopReason).toBe("stop");
    }
    const views = fixture.requests.filter((request) => request.method === CHAT_METHOD).map((request) => cacheView(request.body));
    const breaks: { request: number; message: number }[] = [];
    views.forEach((view, index) => {
      if (index === 0) return;
      const previous = views[index - 1];
      if (previous.header !== view.header) { breaks.push({ request: index, message: -1 }); return; }
      const at = previous.messages.findIndex((message, position) => message !== view.messages[position]);
      if (at >= 0) breaks.push({ request: index, message: at });
    });
    return { views, breaks };
  } finally { fixture.shutdown(); }
}

const agentLoop = (turns: number, imageBytes: number, start = 0) => Array.from({ length: turns }, (_, turn) => {
  const index = start + turn;
  return index % 3 === 2 ? readImage(`read_${index}`, `/work/shot_${index}.png`, png(index, imageBytes)) : runCommand(`bash_${index}`, `output ${index}\n`.repeat(200));
});

test("an agent loop with images within the limits sends every earlier message unchanged", { timeout: 60_000 }, async () => {
  const { views, breaks } = await sendGrowing([{ role: "user", content: "start", timestamp: 1 }, ...agentLoop(30, 64 * 1024)]);
  expect(views.length).toBe(31);
  expect(breaks).toStrictEqual([]);
});

test("old images are left out only with a change of the system prompt, which rebuilds the cache anyway", { timeout: 60_000 }, async () => {
  const { views, breaks } = await sendGrowing([
    { role: "user", content: "start", timestamp: 1 }, ...agentLoop(15, 64 * 1024), instruction("new rule"), ...agentLoop(15, 64 * 1024, 15),
  ]);
  // Request 15 is the first with the new system message, which changes the prompt; it is the only break.
  expect(breaks).toStrictEqual([{ request: 15, message: -1 }]);
  const notes = (view: { messages: string[] }) => view.messages.filter((message) => message.includes("image omitted after 5 responses")).length;
  expect(notes(views[14])).toBe(0);
  // The images with at least 5 responses before the change: turns 2, 5 and 8. Turns 11 and 14 stay until another change.
  expect(notes(views[15])).toBe(3);
  expect(notes(views.at(-1)!)).toBe(3);
  expect(views[15].messages.some((message) => message.includes("/work/shot_2.png. Read the file again to see it."))).toBe(true);
});

test("past 8 MiB, sent images change only when the request does not fit, oldest first, and stay changed", { timeout: 120_000 }, async () => {
  // Each image reduces to its own 1 MiB copy, the same every time like Pi's resizer, so the request keeps growing until
  // sent images must change.
  const copies = new Map<string, string>();
  const compressor: ImageCompressorShape = { reduce: (image) => Effect.sync(() => {
    if (!copies.has(image.base64Data)) copies.set(image.base64Data, png(200 + copies.size, MiB));
    return { image: { base64Data: copies.get(image.base64Data)!, mimeType: "image/png" as const }, originalWidth: 3000, originalHeight: 2000, width: 1568, height: 1045 };
  }) };
  const turns = Array.from({ length: 14 }, (_, index) => readImage(`read_${index}`, `/work/big_${index}.png`, png(index, 3 * MiB)));
  const { views, breaks } = await sendGrowing([{ role: "user", content: "start", timestamp: 1 }, ...turns], compressor);
  // First-send reduction keeps five images in 8 MiB. The 6th needs the oldest reduced; later breaks free at least 4 MiB,
  // so the next four images fit again: breaks at the 6th, 8th and 12th image only.
  expect(breaks.map((change) => change.request)).toStrictEqual([6, 8, 12]);
  expect(breaks.every((change) => change.message >= 0)).toBe(true);
  // Each image goes from original to reduced to left out and never back.
  const state = (message: string | undefined) => message === undefined ? -1 : message.includes(OMITTED_IMAGE_NOTE) ? 2 : message.includes("[Image scaled") ? 1 : 0;
  for (let request = 1; request < views.length; request++) {
    views[request - 1].messages.forEach((message, index) => expect(state(views[request].messages[index])).toBeGreaterThanOrEqual(state(message)));
  }
  expect(views.at(-1)!.messages.filter((message) => message.includes(OMITTED_IMAGE_NOTE)).length).toBeGreaterThan(0);
});

test("the same history sends the same request again, as after a failed response or a restart", { timeout: 60_000 }, async () => {
  // A real 4.3 MiB screenshot-like PNG passes 4 MiB of request, so Pi's resizer reduces it in both runs.
  const conversation = [{ role: "user", content: "start", timestamp: 1 } as Message, ...readImage("read_0", "/work/noise.png", noisePng(1800, 600).toString("base64"))];
  const first = await sendGrowing(conversation);
  const restarted = await sendGrowing(conversation);
  expect(first.views.at(-1)!.messages.at(-1)).toMatch(/Image scaled from 1800x600 to 1568x523/);
  expect(restarted.views).toStrictEqual(first.views);
});
