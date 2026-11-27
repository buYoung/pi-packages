import { dirname } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ImageRequestPlan } from "./arguments.js";
import {
    type GeneratedImageFormat,
    imageGenerationOutputHint,
} from "./artifact.js";
import { boundErrorText } from "./error-output.js";

/** Small, base64-free details attached to every result (FDD §11.4). */
export interface ImageGenDetails {
    operation: "generate" | "edit";
    background: "transparent" | "opaque";
    /** Encoded format of the generated image; set on successful results only. */
    format?: GeneratedImageFormat;
    savedPath?: string;
}

export function detailsForPlan(plan: ImageRequestPlan): ImageGenDetails {
    return {
        operation: plan.kind === "generate" ? "generate" : "edit",
        background: plan.background,
    };
}

export function errorResult(
    message: string,
    details: ImageGenDetails,
): AgentToolResult<ImageGenDetails> {
    return {
        content: [{ type: "text", text: boundErrorText(message) }],
        details,
        isError: true,
    };
}

/**
 * `GeneratedImageOutput::to_response_item` in Codex `tool.rs`: the PNG, then the hint. For a GIF
 * the PNG is a still preview of its first frame, as Codex replays it to the model, and is
 * omitted when no preview could be made; the animation stays in the saved file.
 */
export function generatedImageResult(
    plan: ImageRequestPlan,
    format: GeneratedImageFormat,
    base64Png: string | undefined,
    savedPath: string | undefined,
): AgentToolResult<ImageGenDetails> {
    const details = detailsForPlan(plan);
    details.format = format;
    const content: AgentToolResult<ImageGenDetails>["content"] = [];
    if (base64Png !== undefined) {
        content.push({ type: "image", data: base64Png, mimeType: "image/png" });
    }
    if (savedPath !== undefined) {
        details.savedPath = savedPath;
        const hint = imageGenerationOutputHint(dirname(savedPath), savedPath);
        if (hint !== undefined) {
            content.push({ type: "text", text: hint });
        }
    }
    return { content, details };
}
