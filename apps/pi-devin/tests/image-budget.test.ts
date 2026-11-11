import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { Effect } from "effect";
import type { ChatMessage, ImageData } from "../src/core/types.ts";
import { fitImages, OMITTED_IMAGE_NOTE, REQUEST_TOO_LARGE_MESSAGE } from "../src/pi/features/inference/image-budget.ts";
import { ImageCompressor, PiImageCompressor, REDUCED_MAX_BASE64_BYTES, REDUCED_MAX_EDGE } from "../src/pi/features/inference/image-compressor.ts";
import type { ImageCompressorShape, ReducedImage } from "../src/pi/features/inference/types.ts";
import { run } from "./helpers.ts";

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
  compressor, measure: (candidate) => Effect.sync(() => { const bytes = sizeOf(candidate); measured.push(bytes); return bytes; }),
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

test("over the request limit, the oldest images are reduced first and the newest stays as it was", async () => {
  const { compressor, calls } = fakeCompressor(NEARLY_MiB);
  // Six 3 MiB images: reducing the five oldest to about 1 MiB brings 18 MiB down to 8 MiB.
  const messages = Array.from({ length: 6 }, (_, index) => user(`m${index + 1}`, image(`i${index + 1}`, 3 * MiB)));
  const fitted = await fit(messages, compressor);
  expect(calls).toStrictEqual(["i1", "i2", "i3", "i4", "i5"]);
  expect(labels(fitted)).toStrictEqual(["r1", "r2", "r3", "r4", "r5", "i6"]);
  expect(fitted[0].prompt).toBe("m1\n[Image scaled from 2000x1000 to 1000x500 to fit the Devin request size limit. Multiply coordinates by 2.00 to map to the 2000x1000 image.]");
  expect(fitted[5]).toBe(messages[5]);
});

test("when reducing every image is not enough, the oldest are left out with a note", async () => {
  const { compressor } = fakeCompressor(NEARLY_MiB);
  // Ten 3 MiB images reduce to about 10 MiB, so the two oldest are left out.
  const messages = Array.from({ length: 10 }, (_, index) => user(`m${index + 1}`, image(`i${index}`, 3 * MiB)));
  const fitted = await fit(messages, compressor);
  expect(labels(fitted)).toStrictEqual(["", "", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
  expect(fitted[0].prompt).toBe(`m1\n${OMITTED_IMAGE_NOTE}`);
  expect(fitted[0].images).toBe(undefined);
});

test("the request is measured again only after at least 1 MiB is freed, so the boundary moves in steps", async () => {
  const { compressor, calls } = fakeCompressor(MiB / 8);
  // 6.5 MiB of text and six 0.5 MiB images: four reductions would fit, but the size is checked after the third and the sixth.
  const messages = [user("t".repeat(6.5 * MiB)), ...Array.from({ length: 6 }, (_, index) => user(`m${index}`, image(`i${index}`, MiB / 2)))];
  const measured: number[] = [];
  const fitted = await fit(messages, compressor, measured);
  expect(calls.length).toBe(6);
  expect(measured.length).toBe(3);
  expect(labels(fitted).slice(1).every((label) => label.startsWith("r"))).toBe(true);
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
  // Three 2.4 MiB Base64 images decode to 5.4 MiB in one message; the request itself fits.
  const fitted = await fit([user("a", image("i1", 2.4 * MiB), image("i2", 2.4 * MiB), image("i3", 2.4 * MiB))], compressor);
  expect(calls).toStrictEqual(["i1"]);
  expect(labels(fitted)).toStrictEqual(["r1,i2,i3"]);
});

test("a request still too large without images fails in words Pi treats as a context overflow", async () => {
  const { compressor } = fakeCompressor(MiB);
  await expect(fit([user("t".repeat(7 * MiB), image("i1", 2 * MiB)), user("t".repeat(2 * MiB))], compressor)).rejects.toThrow(REQUEST_TOO_LARGE_MESSAGE);
  const failed = { role: "assistant", content: [], api: "devin-connect", provider: "devin", model: "m", stopReason: "error", errorMessage: REQUEST_TOO_LARGE_MESSAGE, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } satisfies AssistantMessage;
  expect(isContextOverflow(failed)).toBe(true);
});

/** A PNG of deterministic noise, which compresses poorly, as photos and busy screenshots do. */
function noisePng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let seed = 1;
  for (let index = 0; index < rows.length; index++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    rows[index] = index % (width * 3 + 1) === 0 ? 0 : seed & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("Pi's resizer scales to the edge limit, stays under the Base64 limit and returns the same copy for the same image", { timeout: 30_000 }, async () => {
  const original: ImageData = { mimeType: "image/png", base64Data: noisePng(1800, 600).toString("base64") };
  expect(original.base64Data.length).toBeGreaterThan(3 * MiB);
  const compressor = await run(Effect.gen(function* () { return yield* ImageCompressor; }).pipe(Effect.provide(PiImageCompressor)));
  const reduced = await run(compressor.reduce(original));
  expect(reduced).toMatchObject({ originalWidth: 1800, originalHeight: 600, width: REDUCED_MAX_EDGE });
  expect(reduced!.image.base64Data.length).toBeLessThan(REDUCED_MAX_BASE64_BYTES);
  expect(["image/png", "image/jpeg"]).toContain(reduced!.image.mimeType);
  expect(await run(compressor.reduce(original))).toBe(reduced);
  expect(await run(compressor.reduce({ mimeType: "image/png", base64Data: Buffer.from("89504e470d0a1a0a00", "hex").toString("base64") }))).toBe(undefined);
});
