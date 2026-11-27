import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    generatedImageFormat,
    imageGenerationArtifactPath,
    saveGeneratedImage,
} from "../dist/artifact.js";

// Two one-pixel frames, red then blue, with a 200 ms frame duration (Codex's test fixture).
const GIF =
    "R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAQABAAAIBAABBAQAIfkEARQAAQAsAAAAAAEAAQCBAAD/AAAAAAAAAAAACAQAAQQEADs=";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

async function saveRoot(t) {
    const root = await mkdtemp(join(tmpdir(), "pi-image-gen-artifact-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test("GIF87a and GIF89a headers are GIFs; everything else is PNG", () => {
    assert.equal(generatedImageFormat(GIF), "gif");
    assert.equal(generatedImageFormat(` ${GIF}\n`), "gif");
    assert.equal(generatedImageFormat(Buffer.from("GIF87a").toString("base64")), "gif");
    assert.equal(generatedImageFormat(PNG), "png");
    assert.equal(generatedImageFormat(Buffer.from("GIF90a").toString("base64")), "png");
});

test("artifact paths use the format's extension", () => {
    assert.equal(
        imageGenerationArtifactPath("/root", "../session", "../call", "gif"),
        join("/root", "generated_images", "___session", "___call.gif"),
    );
    assert.equal(
        imageGenerationArtifactPath("/root", "s", "c", "png"),
        join("/root", "generated_images", "s", "c.png"),
    );
});

test("a generated GIF is saved byte for byte as .gif", async (t) => {
    const root = await saveRoot(t);
    const path = await saveGeneratedImage(root, "session", "call", GIF);
    assert.equal(path, join(root, "generated_images", "session", "call.gif"));
    assert.deepEqual(await readFile(path), Buffer.from(GIF, "base64"));
});

test("a generated PNG is still saved as .png", async (t) => {
    const root = await saveRoot(t);
    const path = await saveGeneratedImage(root, "session", "call", PNG);
    assert.equal(path, join(root, "generated_images", "session", "call.png"));
    assert.deepEqual(await readFile(path), Buffer.from(PNG, "base64"));
});
