import { createHash } from "node:crypto";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import type { ImageData } from "../../../core/types.ts";
import type { ImageCompressorShape, ReducedImage } from "./types.ts";

/** Makes images smaller when a Devin request would be too large. */
export class ImageCompressor extends Context.Service<ImageCompressor, ImageCompressorShape>()("pi-devin/ImageCompressor") {}

/** The longest edge many vision models work at; their services scale larger images down anyway. */
export const REDUCED_MAX_EDGE = 1568;
/** Each reduced image's Base64 stays under this, so several fit in one 10 MiB request. */
export const REDUCED_MAX_BASE64_BYTES = 1024 * 1024;
/** Reduced copies kept per runtime, so an image is reduced once and sends the same bytes in later requests. */
const CACHE_BASE64_BYTES = 64 * 1024 * 1024;
const WIRE_MIME_TYPES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Pi's own image resizer (Photon WASM in a worker thread), which `read` also uses: scales to the edge limit, keeps the
 * smaller of PNG and JPEG, then lowers JPEG quality and size until the Base64 fits. Results are cached by content.
 */
export const PiImageCompressor = Layer.sync(ImageCompressor, () => {
  const cache = new Map<string, ReducedImage | undefined>();
  let cachedBytes = 0;
  const remember = (key: string, value: ReducedImage | undefined) => {
    cache.set(key, value);
    cachedBytes += value?.image.base64Data.length ?? 0;
    for (const [oldest, entry] of cache) {
      if (cachedBytes <= CACHE_BASE64_BYTES || oldest === key) break;
      cache.delete(oldest);
      cachedBytes -= entry?.image.base64Data.length ?? 0;
    }
  };
  return {
    reduce: (image: ImageData) => Effect.gen(function* () {
      const key = createHash("sha256").update(image.mimeType).update("\0").update(image.base64Data).digest("hex");
      if (cache.has(key)) {
        const cached = cache.get(key);
        // The newest use moves to the end, so the least recently used copy is dropped first.
        cache.delete(key); cache.set(key, cached);
        return cached;
      }
      const resized = yield* Effect.tryPromise({
        try: () => resizeImage(Buffer.from(image.base64Data, "base64"), image.mimeType,
          { maxWidth: REDUCED_MAX_EDGE, maxHeight: REDUCED_MAX_EDGE, maxBytes: REDUCED_MAX_BASE64_BYTES }),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => null));
      const reduced: ReducedImage | undefined = resized && WIRE_MIME_TYPES.has(resized.mimeType)
        ? {
          image: { base64Data: resized.data, mimeType: resized.mimeType as ImageData["mimeType"] },
          originalWidth: resized.originalWidth, originalHeight: resized.originalHeight, width: resized.width, height: resized.height,
        }
        : undefined;
      remember(key, reduced);
      return reduced;
    }),
  } satisfies ImageCompressorShape;
});
