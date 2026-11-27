// Derived from OpenAI Codex `codex-rs/ext/image-generation/imagegen_description.md`
// (Apache-2.0, Copyright 2025 OpenAI). Modified for Pi with the four edits listed in
// docs/FDD/codex-image-gen.md §9.3: the Pi tool name, Pi's `read` tool for inspecting local
// images, and removal of code-mode-only guidance and of the sentence about a tool Pi lacks.
const DESCRIPTION_LINES = [
    "The `image_gen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:",
    "",
    "- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.",
    "- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).",
    "",
    "Guidelines:",
    "- imagegen needs a few minutes to finish.",
    "- Set `transparent_background` to true when the request calls for a transparent background, including background removal or a cutout; set it to false otherwise. For edits, preserve existing transparency unless the user asks to change it.",
    "- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.",
    "- For edits, use `referenced_image_paths` when every target image has a local file path.",
    "- If you have not seen a local image yet, use `read` to inspect it before editing.",
    "- Use `num_last_images_to_include` only when at least one target image has no local file path.",
    "- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.",
    "- Never provide both `referenced_image_paths` and `num_last_images_to_include`.",
    "- If neither mechanism can include every target image, ask the user to attach the missing images again.",
    "- Directly generate the image without reconfirmation or clarification unless required images must be attached again.",
    "- Always use this tool for image editing unless the user explicitly requests otherwise.",
];

/** Model-facing description of the `image_gen` tool (Codex text with the FDD §9.3 edits). */
export const IMAGE_GEN_DESCRIPTION = `${DESCRIPTION_LINES.join("\n")}\n`;

// Verbatim from OpenAI Codex `codex-rs/ext/image-generation/imagegen_gif_description.md`
// (Apache-2.0, Copyright 2025 OpenAI), added in openai/codex#59073.
const GIF_DESCRIPTION_LINES = [
    "GIF guidelines:",
    "- Use imagegen only for simple GIFs with 2–16 frames. For more complex animations or more than 16 frames, use other tools instead.",
    "- Set `gif` to request GIF output. Use `{}` for the defaults (9 frames, 200 ms per frame), or set `frame_count` and `frame_duration_ms`.",
    "- To edit a previously generated GIF, first inspect its frames, then create a spritesheet with equal-sized cells in a regular grid. Pass that spritesheet through `referenced_image_paths` and set `gif` to generate the new GIF. Do not pass the GIF itself as an edit input.",
];

/** The description with GIF guidance appended the way Codex joins the two files when GIF output is on. */
export const IMAGE_GEN_GIF_DESCRIPTION = `${IMAGE_GEN_DESCRIPTION}\n${GIF_DESCRIPTION_LINES.join("\n")}\n`;
