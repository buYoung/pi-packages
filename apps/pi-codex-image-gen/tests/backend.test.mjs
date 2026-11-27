import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageGenArguments } from "../dist/arguments.js";
import { ImagesClient } from "../dist/backend.js";

const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const credentials = {
    apiKey: "token",
    headers: {},
    baseUrl: "https://example.test/backend-api/codex",
};

function recordingClient() {
    const requests = [];
    const client = new ImagesClient(credentials, {
        fetch: async (url, init) => {
            requests.push({ url, body: init.body });
            return new Response(
                JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }),
                { status: 200 },
            );
        },
    });
    return { client, requests };
}

function plan(args) {
    return parseImageGenArguments(args, "gpt-image-2").plan;
}

test("generation flattens GIF controls as Codex's ImageOutput::Gif", async () => {
    const { client, requests } = recordingClient();
    await client.generate(
        plan({ prompt: "p", gif: { frame_count: 2, frame_duration_ms: 200 } }),
    );
    assert.equal(
        requests[0].url,
        "https://example.test/backend-api/codex/images/generations",
    );
    assert.equal(
        requests[0].body,
        JSON.stringify({
            prompt: "p",
            output_format: "gif",
            frame_count: 2,
            frame_duration_ms: 200,
            background: "opaque",
            model: "gpt-image-2",
            quality: "auto",
            size: "auto",
        }),
    );
});

test("empty GIF options send only output_format", async () => {
    const { client, requests } = recordingClient();
    await client.edit(plan({ prompt: "p", gif: {} }), [
        { bytes: new Uint8Array([1]), mimeType: "image/png", fileName: "a.png" },
    ]);
    assert.equal(
        requests[0].url,
        "https://example.test/backend-api/codex/images/edits",
    );
    assert.equal(
        requests[0].body,
        JSON.stringify({
            images: [{ image_url: "data:image/png;base64,AQ==" }],
            prompt: "p",
            output_format: "gif",
            background: "opaque",
            model: "gpt-image-2",
            quality: "auto",
            size: "auto",
        }),
    );
});

test("still-image requests are unchanged", async () => {
    const { client, requests } = recordingClient();
    await client.generate(plan({ prompt: "p", transparent_background: true }));
    assert.equal(
        requests[0].body,
        JSON.stringify({
            prompt: "p",
            background: "transparent",
            model: "gpt-image-2",
            quality: "auto",
            size: "auto",
        }),
    );
});
