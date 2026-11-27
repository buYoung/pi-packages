import assert from "node:assert/strict";
import { test } from "node:test";
import { parseImageGenArguments } from "../dist/arguments.js";

const parse = (args) => parseImageGenArguments(args, "gpt-image-2");

test("gif deserialization errors use Codex's messages", () => {
    assert.throws(() => parseImageGenArguments({ prompt: "x", gif: 3 }), {
        message: "invalid type: integer `3`, expected struct GifOptions",
    });
});

test("null gif counts as omitted", () => {
    const { arguments: normalized, plan } = parseImageGenArguments({
        prompt: "x",
        gif: null,
    });
    assert.deepEqual(normalized, { prompt: "x", transparent_background: false });
    assert.equal(plan.gif, undefined);
});

test("empty gif options keep the Images API defaults", () => {
    const { arguments: normalized, plan } = parse({ prompt: "x", gif: {} });
    assert.deepEqual(normalized.gif, {});
    assert.deepEqual(plan.gif, {});
    assert.equal(plan.kind, "generate");
});

test("gif controls reach the plan for generation and edits", () => {
    const gif = { frame_count: 2, frame_duration_ms: 200 };
    assert.deepEqual(parse({ prompt: "x", gif }).plan.gif, gif);
    const edit = parse({
        prompt: "x",
        gif: { frame_count: 4 },
        referenced_image_paths: ["/tmp/sheet.png"],
    }).plan;
    assert.equal(edit.kind, "edit-paths");
    assert.deepEqual(edit.gif, { frame_count: 4 });
    const history = parse({
        prompt: "x",
        gif: {},
        num_last_images_to_include: 1,
    }).plan;
    assert.equal(history.kind, "edit-history");
    assert.deepEqual(history.gif, {});
});

test("null controls are omitted and unknown gif fields are ignored like serde", () => {
    const { arguments: normalized } = parse({
        prompt: "x",
        gif: { frame_count: null, frame_duration_ms: 50, loop: true },
    });
    assert.deepEqual(normalized.gif, { frame_duration_ms: 50 });
});

test("ranges are left to the Images API, as in Codex", () => {
    const { plan } = parse({
        prompt: "x",
        gif: { frame_count: 40, frame_duration_ms: 1 },
    });
    assert.deepEqual(plan.gif, { frame_count: 40, frame_duration_ms: 1 });
});

test("gif controls must be u32 integers", () => {
    assert.throws(() => parse({ prompt: "x", gif: { frame_count: 2.5 } }), {
        message: "invalid type: floating point `2.5`, expected u32",
    });
    assert.throws(() => parse({ prompt: "x", gif: { frame_count: "2" } }), {
        message: 'invalid type: string "2", expected u32',
    });
    assert.throws(
        () => parse({ prompt: "x", gif: { frame_duration_ms: -1 } }),
        { message: "invalid value: integer `-1`, expected u32" },
    );
    assert.throws(
        () => parse({ prompt: "x", gif: { frame_count: 2 ** 32 } }),
        { message: "invalid value: integer `4294967296`, expected u32" },
    );
    assert.throws(() => parse({ prompt: "x", gif: [2, 200] }), {
        message: "invalid type: sequence, expected struct GifOptions",
    });
});

test("the unknown-field message lists gif in Codex field order", () => {
    assert.throws(() => parse({ prompt: "x", frames: 2 }), {
        message:
            "unknown field `frames`, expected one of `prompt`, `gif`, `transparent_background`, `referenced_image_paths`, `num_last_images_to_include`",
    });
});

test("reference limits still apply to GIF edits", () => {
    assert.throws(
        () =>
            parse({
                prompt: "x",
                gif: {},
                num_last_images_to_include: 6,
            }),
        { message: "`num_last_images_to_include` must be between 1 and 5" },
    );
});
