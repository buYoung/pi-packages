import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { IMAGE_MODEL, type ImageModel, isImageModel } from "./arguments.js";

/** Saved image settings after defaults: the model and the opt-in GIF output. */
export interface ImageGenSettings {
    model: ImageModel;
    /** `gif`, the counterpart of Codex's `features.image_generation_animation`; off by default. */
    isGifEnabled: boolean;
}

/** Stores the image model separately from Pi's chat model settings. */
export class ImageGenSettingsStore {
    constructor(
        readonly path = join(getAgentDir(), "codex-image-gen", "settings.json"),
    ) {}

    private async read(): Promise<Record<string, unknown>> {
        let raw: string;
        try {
            raw = await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
            throw error;
        }
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new Error("Image generation settings must be a JSON object.");
        const settings = value as Record<string, unknown>;
        if (settings.model !== undefined && !isImageModel(settings.model))
            throw new Error(
                "Image generation model must be gpt-image-2.5 or gpt-image-2.",
            );
        if (settings.gif !== undefined && typeof settings.gif !== "boolean")
            throw new Error(
                "Image generation gif setting must be true or false.",
            );
        return settings;
    }

    async load(): Promise<ImageGenSettings> {
        const settings = await this.read();
        return {
            model: isImageModel(settings.model) ? settings.model : IMAGE_MODEL,
            isGifEnabled: settings.gif === true,
        };
    }

    /** Preserves unrelated keys and atomically replaces the saved model. */
    async save(model: ImageModel): Promise<void> {
        if (!isImageModel(model))
            throw new Error("Unsupported image generation model.");
        const settings = { ...(await this.read()), model };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(settings, null, 2)}\n`,
                {
                    flag: "wx",
                    mode: 0o600,
                },
            );
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
