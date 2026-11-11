import { expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { Effect } from "effect";
import type { ChatMessage, ImageData } from "../src/core/types.ts";
import { fitImages, OMITTED_IMAGE_NOTE, REQUEST_TOO_LARGE_MESSAGE } from "../src/pi/features/inference/image-budget.ts";
import { ImageCompressor, PiImageCompressor, REDUCED_MAX_BASE64_BYTES, REDUCED_MAX_EDGE } from "../src/pi/features/inference/image-compressor.ts";
import type { ImageCompressorShape, ReducedImage } from "../src/pi/features/inference/types.ts";
import { noisePng, run } from "./helpers.ts";

const MiB = 1024 * 1024;
/** Base64 of this many characters; the budget reads sizes from the Base64 alone. */
const image = (label: string, base64Bytes: number): ImageData => ({ mimeType: "image/png", base64Data: label + "A".repeat(base64Bytes - label.length) });
const user = (prompt: string, ...images: ImageData[]): ChatMessage => ({ messageId: prompt, source: "CHAT_MESSAGE_SOURCE_USER", prompt, ...(images.length ? { images } : {}) });

/** Reduces every image to `base64Bytes` and records which ones it was asked for, in order. */
function fakeCompressor(base64Bytes: number, fail: (image: ImageData) => boolean = () => false) {
  const calls: string[] = [];
  const compressor: ImageCompressorShape = { reduce: (original) => Effect.sync((): ReducedImage | undefined => {
    calls.push(original.base64Data.slice(0, 2));
    if (fail(original)) return undefined;
    return { image: image("r" + original.base64Data[1], base64Bytes), originalWidth: 2000, originalHeight: 1000, width: 1000, height: 500 };
  }) };
  return { compressor, calls };
}

/** Prompt and image Base64 characters, standing in for the encoded request. */
function sizeOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.prompt.length + (message.images ?? []).reduce((total, item) => total + item.base64Data.length, 0), 0);
}
const fit = (messages: ChatMessage[], compressor: ImageCompressorShape, measured: number[] = []) => run(fitImages(messages, {
  compressor, headerBytes: 0, measure: (candidate) => Effect.sync(() => { const bytes = sizeOf(candidate); measured.push(bytes); return bytes; }),
}));
const labels = (messages: ChatMessage[]) => messages.map((message) => (message.images ?? []).map((item) => item.base64Data.slice(0, 2)).join(","));

test("a request within the limits is sent as it is, without compressing anything", async () => {
  const { compressor, calls } = fakeCompressor(10);
  const messages = [user("a", image("i1", MiB)), user("b", image("i2", MiB))];
  const fitted = await fit(messages, compressor);
  expect(fitted[0]).toBe(messages[0]); expect(fitted[1]).toBe(messages[1]);
  expect(calls).toStrictEqual([]);
});

// Reduced copies are a little under 1 MiB, so the notes added to the prompts still fit.
const NEARLY_MiB = MiB - 1024;

test("once the request passes 6 MiB, each new image is reduced when first sent and earlier images stay as they were", async () => {
  const { compressor, calls } = fakeCompressor(NEARLY_MiB);
  // Six 3 MiB images: the first two would reach exactly 6 MiB, so with the message text the second already passes it.
  // It and every later image are reduced to about 1 MiB.
  const messages = Array.from({ length: 6 }, (_, index) => user(`m${index + 1}`, image(`i${index + 1}`, 3 * MiB)));
  const fitted = await fit(messages, compressor);
  expect(calls).toStrictEqual(["i2", "i3", "i4", "i5", "i6"]);
  expect(labels(fitted)).toStrictEqual(["i1", "r2", "r3", "r4", "r5", "r6"]);
  expect(fitted[0]).toBe(messages[0]);
  expect(fitted[1].prompt).toBe("m2\n[Image scaled from 2000x1000 to 1000x500 to fit the Devin request size limit. Multiply coordinates by 2.00 to map to the 2000x1000 image.]");
});

/** Fits every prefix of a growing conversation, as consecutive requests would send it, and lists the sent messages that changed. */
async function grow(messages: ChatMessage[], compressor: ImageCompressorShape) {
  const results: ChatMessage[][] = [];
  const changes: { request: number; message: number }[] = [];
  const rank = (message: ChatMessage) => message.prompt.includes(OMITTED_IMAGE_NOTE) ? 2 : message.prompt.includes("[Image scaled") ? 1 : 0;
  for (let length = 1; length <= messages.length; length++) {
    const fitted = await fit(messages.slice(0, length), compressor);
    const previous = results.at(-1) ?? [];
    previous.forEach((message, index) => {
      if (JSON.stringify(message) === JSON.stringify(fitted[index])) return;
      changes.push({ request: length, message: index });
      // A sent image may only move on: original, then reduced, then left out. Going back would break the cache again.
      expect(rank(fitted[index])).toBeGreaterThan(rank(message));
    });
    results.push(fitted);
  }
  return { results, changes };
}

test("while a conversation grows past 10 MiB, sent images change only when the request does not fit, oldest first and never back", async () => {
  const { compressor } = fakeCompressor(NEARLY_MiB);
  const messages = Array.from({ length: 12 }, (_, index) => user(`m${index + 1}`, image(`i${"abcdefghijkl"[index]}`, 3 * MiB)));
  const { results, changes } = await grow(messages, compressor);
  // With first-send reduction, n images take 3 MiB + (n - 1) x 1 MiB. Up to seven fit under the limit just below 10 MiB.
  // The 8th needs the oldest image reduced. The 10th leaves out the five oldest (the first step that frees 4 MiB), so the
  // next images fit again without changing anything sent.
  expect(changes).toStrictEqual([{ request: 8, message: 0 },
    { request: 10, message: 0 }, { request: 10, message: 1 }, { request: 10, message: 2 }, { request: 10, message: 3 }, { request: 10, message: 4 }]);
  expect(labels(results.at(-1)!)).toStrictEqual(["", "", "", "", "", "rf", "rg", "rh", "ri", "rj", "rk", "rl"]);
  expect(results.at(-1)![0].prompt).toBe(`m1\n${OMITTED_IMAGE_NOTE}`);
});

test("a long conversation with growing text keeps every sent message as it was", async () => {
  const { compressor } = fakeCompressor(MiB / 4);
  // Text and half-MiB images alternate. Images past 6 MiB are reduced when first sent, so the request ends near 7.75 MiB
  // without changing anything sent.
  const messages = Array.from({ length: 24 }, (_, index) => index % 2 ? user(`m${index}`, image(`i${index % 10}`, MiB / 2)) : user("t".repeat(MiB / 4)));
  const { results, changes } = await grow(messages, compressor);
  expect(changes).toStrictEqual([]);
  expect(labels(results.at(-1)!).filter(Boolean).some((label) => label.startsWith("r"))).toBe(true);
});

test("an image over 4 MiB is reduced even when the request fits, and left out when it cannot be reduced", async () => {
  const { compressor, calls } = fakeCompressor(MiB, (original) => original.base64Data.startsWith("i2"));
  const messages = [user("a", image("i1", 6 * MiB)), user("b", image("i2", 6 * MiB)), user("c", image("i3", MiB))];
  const fitted = await fit(messages, compressor);
  expect(calls).toStrictEqual(["i1", "i2"]);
  expect(labels(fitted)).toStrictEqual(["r1", "", "i3"]);
  expect(fitted[1].prompt).toBe(`b\n${OMITTED_IMAGE_NOTE}`);
});

test("images over 5 MiB in one message are reduced oldest first within that message", async () => {
  const { compressor, calls } = fakeCompressor(MiB);
  // Three 2.4 MiB Base64 images decode to 5.4 MiB in one message, so the first is reduced. The request then stays under
  // 6 MiB, so the others are sent as they are.
  const fitted = await fit([user("a", image("i1", 2.4 * MiB), image("i2", 2.4 * MiB), image("i3", 2.4 * MiB))], compressor);
  expect(calls).toStrictEqual(["i1"]);
  expect(labels(fitted)).toStrictEqual(["r1,i2,i3"]);
});

test("a request still too large without images fails in words Pi treats as a context overflow", async () => {
  const { compressor } = fakeCompressor(MiB);
  // 10 MiB of text alone is over the limit just below 10 MiB.
  await expect(fit([user("t".repeat(8 * MiB), image("i1", 2 * MiB)), user("t".repeat(2 * MiB))], compressor)).rejects.toThrow(REQUEST_TOO_LARGE_MESSAGE);
  const failed = { role: "assistant", content: [], api: "devin-connect", provider: "devin", model: "m", stopReason: "error", errorMessage: REQUEST_TOO_LARGE_MESSAGE, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } satisfies AssistantMessage;
  expect(isContextOverflow(failed)).toBe(true);
});

test("Pi's resizer scales to the edge limit, stays under the Base64 limit and returns the same copy for the same image", { timeout: 30_000 }, async () => {
  const original: ImageData = { mimeType: "image/png", base64Data: noisePng(1800, 600).toString("base64") };
  expect(original.base64Data.length).toBeGreaterThan(3 * MiB);
  const compressor = await run(Effect.gen(function* () { return yield* ImageCompressor; }).pipe(Effect.provide(PiImageCompressor)));
  const reduced = await run(compressor.reduce(original));
  expect(reduced).toMatchObject({ originalWidth: 1800, originalHeight: 600, width: REDUCED_MAX_EDGE });
  expect(reduced!.image.base64Data.length).toBeLessThan(REDUCED_MAX_BASE64_BYTES);
  expect(["image/png", "image/jpeg"]).toContain(reduced!.image.mimeType);
  expect(await run(compressor.reduce(original))).toBe(reduced);
  // After a restart the cache is empty; the copy must have the same bytes, or the cached prefix would break.
  const restarted = await run(Effect.gen(function* () { return yield* ImageCompressor; }).pipe(Effect.provide(PiImageCompressor)));
  expect(await run(restarted.reduce(original))).toStrictEqual(reduced);
  expect(await run(compressor.reduce({ mimeType: "image/png", base64Data: Buffer.from("89504e470d0a1a0a00", "hex").toString("base64") }))).toBe(undefined);
});
