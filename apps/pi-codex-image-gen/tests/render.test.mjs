import assert from "node:assert/strict";
import { test } from "node:test";
import { renderImageGenCall, renderImageGenResult } from "../dist/render.js";

const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const theme = { fg: (_color, text) => text, bold: (text) => text };

test("the call summary marks GIF requests", () => {
    const lines = renderImageGenCall(
        { prompt: "p", gif: {}, transparent_background: true },
        theme,
        { expanded: false },
    ).render(80);
    assert.equal(lines[0], "image_gen Generate · GIF · transparent background");
    const still = renderImageGenCall({ prompt: "p", gif: null }, theme, {
        expanded: false,
    }).render(80);
    assert.equal(still[0], "image_gen Generate");
});

test("the result heading names a GIF and uses its preview size", () => {
    const lines = renderImageGenResult(
        {
            content: [{ type: "image", data: PNG, mimeType: "image/png" }],
            details: {
                operation: "edit",
                background: "opaque",
                format: "gif",
                savedPath: "/tmp/generated_images/s/c.gif",
            },
        },
        { isPartial: false, expanded: false },
        theme,
        { isError: false, state: {}, showImages: false, invalidate() {} },
    ).render(80);
    assert.equal(lines[1], "Edited GIF · 1×1");
    assert.ok(lines[2].includes("c.gif"));
});
