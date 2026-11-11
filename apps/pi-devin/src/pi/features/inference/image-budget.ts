import { Effect } from "effect";
import type { DevinError } from "../../../core/errors.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES_BYTES } from "../../../core/inference/images.ts";
import { MAX_FRAME_BYTES } from "../../../core/protocol/frames.ts";
import type { ChatMessage, ImageData } from "../../../core/types.ts";
import { failWith } from "../../../core/validation.ts";
import type { ImageCompressorShape, ReducedImage } from "./types.ts";

/** In words Pi's context overflow check matches, so Pi compacts the conversation and sends it again. */
export const REQUEST_TOO_LARGE_MESSAGE = `Context length exceeded: the Devin request is larger than ${MAX_FRAME_BYTES / (1024 * 1024)} MiB even without images.`;
export const OMITTED_IMAGE_NOTE = "(image omitted: Devin request size limit)";
/**
 * The request is measured again only after a step frees at least this much. Step boundaries then depend only on the images
 * before them, so the reduced and omitted part stays put while the conversation grows, and the cached prefix with it.
 */
const STEP_BASE64_BYTES = 1024 * 1024;

export interface ImageBudget {
  readonly compressor: ImageCompressorShape;
  /** The encoded size of the request with these messages. */
  readonly measure: (messages: ChatMessage[]) => Effect.Effect<number, DevinError>;
}

interface Slot {
  readonly messageIndex: number;
  readonly original: ImageData;
  /** `reduced` means reduction was tried; an image that cannot be made smaller stays as it was. */
  state: "original" | "reduced" | "omitted";
  current: ImageData;
  note?: string;
}

const decodedBytes = (image: ImageData) => {
  const data = image.base64Data;
  return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};

/** Like the note Pi's `read` adds, so coordinates the model reads from the image can be mapped back. */
function scaleNote(reduced: ReducedImage): string | undefined {
  const { originalWidth, originalHeight, width, height } = reduced;
  if (width === originalWidth && height === originalHeight) return undefined;
  return `[Image scaled from ${originalWidth}x${originalHeight} to ${width}x${height} to fit the Devin request size limit. `
    + `Multiply coordinates by ${(originalWidth / width).toFixed(2)} to map to the ${originalWidth}x${originalHeight} image.]`;
}

/**
 * Fits the images into Devin's limits: 4 MiB per image, 5 MiB per message and 8 MiB per encoded request. Older images give
 * way first. For the request limit every image is reduced before any is left out, so recent images stay longest; a
 * request that is still too large without images fails in words Pi treats as a context overflow.
 */
export function fitImages(messages: readonly ChatMessage[], budget: ImageBudget): Effect.Effect<ChatMessage[], DevinError> {
  return Effect.gen(function* () {
    const slots = messages.flatMap((message, messageIndex) =>
      (message.images ?? []).map((image): Slot => ({ messageIndex, original: image, state: "original", current: image })));
    const byMessage = Map.groupBy(slots, (slot) => slot.messageIndex);

    const build = (): ChatMessage[] => messages.map((message, messageIndex) => {
      const own = byMessage.get(messageIndex);
      if (!own?.some((slot) => slot.current !== slot.original || slot.state === "omitted")) return message;
      const { images: _images, ...rest } = message;
      const kept = own.filter((slot) => slot.state !== "omitted").map((slot) => slot.current);
      const notes = own.flatMap((slot) => slot.state === "omitted" ? [OMITTED_IMAGE_NOTE] : slot.note ? [slot.note] : []);
      return { ...rest, prompt: [message.prompt, ...notes].filter(Boolean).join("\n"), ...(kept.length ? { images: kept } : {}) };
    });
    const fits = Effect.suspend(() => budget.measure(build())).pipe(Effect.map((bytes) => bytes <= MAX_FRAME_BYTES));

    /** Returns the Base64 bytes it freed. */
    const reduce = (slot: Slot) => Effect.gen(function* () {
      if (slot.state !== "original") return 0;
      slot.state = "reduced";
      const reduced = yield* budget.compressor.reduce(slot.original);
      if (!reduced || reduced.image.base64Data.length >= slot.original.base64Data.length) return 0;
      slot.current = reduced.image;
      slot.note = scaleNote(reduced);
      return slot.original.base64Data.length - reduced.image.base64Data.length;
    });
    const omit = (slot: Slot) => Effect.sync(() => {
      if (slot.state === "omitted") return 0;
      slot.state = "omitted";
      return slot.current.base64Data.length;
    });

    for (const slot of slots) {
      if (decodedBytes(slot.current) <= MAX_IMAGE_BYTES) continue;
      yield* reduce(slot);
      if (decodedBytes(slot.current) > MAX_IMAGE_BYTES) yield* omit(slot);
    }
    for (const own of byMessage.values()) {
      const total = () => own.reduce((sum, slot) => sum + (slot.state === "omitted" ? 0 : decodedBytes(slot.current)), 0);
      for (const slot of own) { if (total() <= MAX_IMAGES_BYTES) break; yield* reduce(slot); }
      for (const slot of own) { if (total() <= MAX_IMAGES_BYTES) break; yield* omit(slot); }
    }
    if (yield* fits) return build();
    for (const step of [reduce, omit]) {
      let freed = 0;
      for (const [index, slot] of slots.entries()) {
        freed += yield* step(slot);
        if (freed < STEP_BASE64_BYTES && index < slots.length - 1) continue;
        freed = 0;
        if (yield* fits) return build();
      }
    }
    return yield* failWith(REQUEST_TOO_LARGE_MESSAGE);
  });
}
