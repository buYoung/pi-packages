import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { Effect } from "effect";
import type { ImageData } from "../../../core/types.ts";
import type { DevinAPI } from "../catalog/types.ts";

/** A smaller copy of an image, with its size before and after. */
export interface ReducedImage {
  image: ImageData;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

export interface ImageCompressorShape {
  /**
   * A copy small enough for the request budget, the same bytes every time for the same image, or undefined when the
   * image cannot be decoded or made that small. Never fails.
   */
  readonly reduce: (image: ImageData) => Effect.Effect<ReducedImage | undefined>;
}

export interface InferenceShape {
  /**
   * Returns Pi's event stream for one Devin request. Runs synchronously up to the first wait: the stream carries its
   * start event, and the request already holds its sign-in generation and provider lifetime. The request runs on in a fiber the service owns.
   */
  readonly start: (model: Model<DevinAPI>, context: TranscriptContext, options?: SimpleStreamOptions) => Effect.Effect<AssistantMessageEventStream>;
}
