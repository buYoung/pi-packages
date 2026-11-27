import assert from "node:assert/strict";
import { test } from "node:test";
import {
    GIF_UNAVAILABLE_MESSAGE,
    parseImageGenArguments,
} from "../dist/arguments.js";

const enabled = (args) =>
    parseImageGenArguments(args, "gpt-image-2", /*isGifEnabled*/ true);

test("gif is rejected with Codex's message while GIF output is off", () => {
    assert.throws(
        () => parseImageGenArguments({ prompt: "x", gif: {} }),
        { message: GIF_UNAVAILABLE_MESSAGE },
    );
    assert.equal(
        GIF_UNAVAILABLE_MESSAGE,
        "GIF output is unavailable in this session.",
    );
});

test("gif deserialization errors come before the availability check", () => {
    assert.throws(() => parseImageGenArguments({ prompt: "x", gif: 3 }), {
        message: "invalid type: integer `3`, expected struct GifOptions",
    });
});

test("null gif counts as omitted even while GIF output is off", () => {
    const { arguments: normalized, plan } = parseImageGenArguments({
        prompt: "x",
        gif: null,
    });
    assert.deepEqual(normalized, { prompt: "x", transparent_background: false });
    assert.equal(plan.gif, undefined);
});

test("empty gif options keep the Images API defaults", () => {
    const { arguments: normalized, plan } = enabled({ prompt: "x", gif: {} });
    assert.deepEqual(normalized.gif, {});
    assert.deepEqual(plan.gif, {});
    assert.equal(plan.kind, "generate");
});

test("gif controls reach the plan for generation and edits", () => {
    const gif = { frame_count: 2, frame_duration_ms: 200 };
    assert.deepEqual(enabled({ prompt: "x", gif }).plan.gif, gif);
    const edit = enabled({
        prompt: "x",
        gif: { frame_count: 4 },
        referenced_image_paths: ["/tmp/sheet.png"],
    }).plan;
    assert.equal(edit.kind, "edit-paths");
    assert.deepEqual(edit.gif, { frame_count: 4 });
    const history = enabled({
        prompt: "x",
        gif: {},
        num_last_images_to_include: 1,
    }).plan;
    assert.equal(history.kind, "edit-history");
    assert.deepEqual(history.gif, {});
});

test("null controls are omitted and unknown gif fields are ignored like serde", () => {
    const { arguments: normalized } = enabled({
        prompt: "x",
        gif: { frame_count: null, frame_duration_ms: 50, loop: true },
    });
    assert.deepEqual(normalized.gif, { frame_duration_ms: 50 });
});

test("ranges are left to the Images API, as in Codex", () => {
    const { plan } = enabled({
        prompt: "x",
        gif: { frame_count: 40, frame_duration_ms: 1 },
    });
    assert.deepEqual(plan.gif, { frame_count: 40, frame_duration_ms: 1 });
});

test("gif controls must be u32 integers", () => {
    assert.throws(() => enabled({ prompt: "x", gif: { frame_count: 2.5 } }), {
        message: "invalid type: floating point `2.5`, expected u32",
    });
    assert.throws(() => enabled({ prompt: "x", gif: { frame_count: "2" } }), {
        message: 'invalid type: string "2", expected u32',
    });
    assert.throws(
        () => enabled({ prompt: "x", gif: { frame_duration_ms: -1 } }),
        { message: "invalid value: integer `-1`, expected u32" },
    );
    assert.throws(
        () => enabled({ prompt: "x", gif: { frame_count: 2 ** 32 } }),
        { message: "invalid value: integer `4294967296`, expected u32" },
    );
    assert.throws(() => enabled({ prompt: "x", gif: [2, 200] }), {
        message: "invalid type: sequence, expected struct GifOptions",
    });
});

test("the unknown-field message lists gif in Codex field order", () => {
    assert.throws(() => enabled({ prompt: "x", frames: 2 }), {
        message:
            "unknown field `frames`, expected one of `prompt`, `gif`, `transparent_background`, `referenced_image_paths`, `num_last_images_to_include`",
    });
});

test("reference limits still apply to GIF edits", () => {
    assert.throws(
        () =>
            enabled({
                prompt: "x",
                gif: {},
                num_last_images_to_include: 6,
            }),
        { message: "`num_last_images_to_include` must be between 1 and 5" },
    );
});
