import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { GIF_UNAVAILABLE_MESSAGE } from "../dist/arguments.js";
import {
    IMAGE_GEN_DESCRIPTION,
    IMAGE_GEN_GIF_DESCRIPTION,
} from "../dist/description.js";
import imageGenExtension from "../dist/index.js";
import {
    createImageGenTool,
    IMAGE_GEN_GIF_SCHEMA,
    IMAGE_GEN_SCHEMA,
    imageGenTool,
} from "../dist/tool.js";

// Two one-pixel frames, red then blue, with a 200 ms frame duration (Codex's test fixture).
const GIF =
    "R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAQABAAAIBAABBAQAIfkEARQAAQAsAAAAAAEAAQCBAAD/AAAAAAAAAAAACAQAAQQEADs=";
const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/** First pixel of a non-interlaced 8-bit RGB/RGBA PNG whose first scanline is unfiltered. */
function firstPngPixel(base64) {
    const bytes = Buffer.from(base64, "base64");
    const colorType = bytes[25];
    const idat = [];
    for (let offset = 8; offset < bytes.length; ) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        if (type === "IDAT")
            idat.push(bytes.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(idat));
    assert.equal(raw[0], 0, "first scanline filter");
    const channels = colorType === 6 ? 4 : 3;
    return [...raw.subarray(1, 1 + channels)];
}

function fakeJwt() {
    const payload = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
        }),
    ).toString("base64url");
    return `e30.${payload}.sig`;
}

const ctx = {
    modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: fakeJwt() } }),
        getProvider: () => undefined,
    },
    sessionManager: { getSessionId: () => "session-1" },
};

async function agentDir(t, settings) {
    const root = await mkdtemp(join(tmpdir(), "pi-image-gen-tool-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
    });
    if (settings !== undefined) {
        await mkdir(join(root, "codex-image-gen"), { recursive: true });
        await writeFile(
            join(root, "codex-image-gen", "settings.json"),
            JSON.stringify(settings),
        );
    }
    return root;
}

function stubImagesBackend(t, b64) {
    const previous = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return new Response(
            JSON.stringify({ created: 1, data: [{ b64_json: b64 }] }),
            { status: 200 },
        );
    };
    t.after(() => {
        globalThis.fetch = previous;
    });
    return requests;
}

test("GIF output off: Codex's schema and description without gif", () => {
    const tool = createImageGenTool(false);
    assert.equal(tool.parameters, IMAGE_GEN_SCHEMA);
    assert.equal("gif" in tool.parameters.properties, false);
    assert.equal(tool.description, IMAGE_GEN_DESCRIPTION);
    assert.equal(imageGenTool.parameters, IMAGE_GEN_SCHEMA);
    assert.throws(() => tool.prepareArguments({ prompt: "x", gif: {} }), {
        message: GIF_UNAVAILABLE_MESSAGE,
    });
});

test("GIF output on: gif property first and GIF guidance appended", () => {
    const tool = createImageGenTool(true);
    assert.equal(tool.parameters, IMAGE_GEN_GIF_SCHEMA);
    assert.deepEqual(Object.keys(tool.parameters.properties), [
        "gif",
        "num_last_images_to_include",
        "prompt",
        "referenced_image_paths",
        "transparent_background",
    ]);
    assert.deepEqual(tool.parameters.properties.gif.type, ["object", "null"]);
    assert.deepEqual(tool.parameters.required, ["prompt"]);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(
        tool.description.startsWith(`${IMAGE_GEN_DESCRIPTION}\nGIF guidelines:\n`),
    );
    assert.equal(tool.description, IMAGE_GEN_GIF_DESCRIPTION);
    assert.deepEqual(tool.prepareArguments({ prompt: "x", gif: {} }), {
        prompt: "x",
        gif: {},
        transparent_background: false,
    });
});

test("a GIF is saved as .gif and the model gets a first-frame PNG", async (t) => {
    const root = await agentDir(t, { model: "gpt-image-2", gif: true });
    const requests = stubImagesBackend(t, GIF);
    const result = await createImageGenTool(true).execute(
        "call-1",
        { prompt: "pixel", gif: { frame_count: 2, frame_duration_ms: 200 } },
        undefined,
        undefined,
        ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.output_format, "gif");
    assert.equal(requests[0].body.frame_count, 2);
    assert.equal(requests[0].body.model, "gpt-image-2");
    const savedPath = join(root, "generated_images", "session-1", "call-1.gif");
    assert.deepEqual(result.details, {
        operation: "generate",
        background: "opaque",
        format: "gif",
        savedPath,
    });
    assert.deepEqual(await readFile(savedPath), Buffer.from(GIF, "base64"));
    const [image, hint] = result.content;
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(firstPngPixel(image.data).slice(0, 3), [255, 0, 0]);
    assert.equal(hint.type, "text");
    assert.ok(hint.text.includes(savedPath));
    assert.equal(
        result.content.some((block) => block.mimeType === "image/gif"),
        false,
    );
});

test("an undecodable GIF returns the saved path without an image block", async (t) => {
    const root = await agentDir(t, { gif: true });
    const broken = Buffer.from("GIF89a-not-really-a-gif").toString("base64");
    stubImagesBackend(t, broken);
    const result = await createImageGenTool(true).execute(
        "call-5",
        { prompt: "pixel", gif: {} },
        undefined,
        undefined,
        ctx,
    );
    const savedPath = join(root, "generated_images", "session-1", "call-5.gif");
    assert.equal(result.isError, undefined);
    assert.equal(result.details.savedPath, savedPath);
    assert.deepEqual(
        result.content.map((block) => block.type),
        ["text"],
    );
    assert.ok(result.content[0].text.includes(savedPath));
});

test("a PNG result keeps its bytes and .png path", async (t) => {
    const root = await agentDir(t, { gif: true });
    stubImagesBackend(t, PNG);
    const result = await createImageGenTool(true).execute(
        "call-2",
        { prompt: "still" },
        undefined,
        undefined,
        ctx,
    );
    assert.equal(result.content[0].data, PNG);
    assert.equal(result.details.format, "png");
    assert.equal(
        result.details.savedPath,
        join(root, "generated_images", "session-1", "call-2.png"),
    );
});

test("execution rejects gif when the saved setting is off", async (t) => {
    await agentDir(t, { gif: false });
    const requests = stubImagesBackend(t, GIF);
    const result = await createImageGenTool(true).execute(
        "call-3",
        { prompt: "pixel", gif: {} },
        undefined,
        undefined,
        ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, GIF_UNAVAILABLE_MESSAGE);
    assert.equal(requests.length, 0);
});

test("a non-boolean gif setting fails the request like a bad model", async (t) => {
    await agentDir(t, { gif: "yes" });
    const requests = stubImagesBackend(t, PNG);
    const result = await createImageGenTool(false).execute(
        "call-4",
        { prompt: "still" },
        undefined,
        undefined,
        ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(
        result.content[0].text,
        "image generation failed: unable to load model settings: Image generation gif setting must be true or false.",
    );
    assert.equal(requests.length, 0);
});

function fakePi() {
    const registered = [];
    const handlers = new Map();
    return {
        registered,
        handlers,
        registerTool: (tool) => registered.push(tool),
        registerCommand: () => {},
        on: (event, handler) => handlers.set(event, handler),
        getAllTools: () => [],
        getActiveTools: () => [],
        setActiveTools: () => {},
        appendEntry: () => {},
    };
}

test("session start registers the GIF schema only when the setting is on", async (t) => {
    const root = await agentDir(t);
    const pi = fakePi();
    imageGenExtension(pi);
    assert.equal(pi.registered.length, 1);
    assert.equal(pi.registered[0].parameters, IMAGE_GEN_SCHEMA);

    await pi.handlers.get("session_start")({}, { mode: "print" });
    assert.equal(pi.registered.length, 1);

    await mkdir(join(root, "codex-image-gen"), { recursive: true });
    const settingsPath = join(root, "codex-image-gen", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ gif: true }));
    await pi.handlers.get("session_start")({}, { mode: "print" });
    assert.equal(pi.registered.length, 2);
    assert.equal(pi.registered[1].parameters, IMAGE_GEN_GIF_SCHEMA);

    await writeFile(settingsPath, "not json");
    await pi.handlers.get("session_start")({}, { mode: "print" });
    assert.equal(pi.registered.length, 3);
    assert.equal(pi.registered[2].parameters, IMAGE_GEN_SCHEMA);
});
