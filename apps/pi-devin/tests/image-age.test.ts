import { expect, test } from "vitest";
import { normalizeContext, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { TOOL_IMAGE_RESPONSES, withoutOldToolImages } from "../src/pi/features/inference/image-age.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const response = (stopReason: AssistantMessage["stopReason"] = "toolUse", calls: { id: string; name: string; path?: string }[] = []): AssistantMessage => ({
  role: "assistant", api: "devin-connect", provider: "devin", model: "m", usage, stopReason, timestamp: 1,
  content: calls.length ? calls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: (call.path ? { path: call.path } : {}) as Record<string, string> })) : [{ type: "text", text: "ok" }],
});
const result = (toolCallId: string, toolName: string, content: ToolResultMessage["content"]): ToolResultMessage => ({ role: "toolResult", toolCallId, toolName, content, isError: false, timestamp: 1 });
const responses = (count: number, stopReason?: AssistantMessage["stopReason"]) => Array.from({ length: count }, () => response(stopReason));
const sent = (messages: Message[]) => withoutOldToolImages(normalizeContext({ messages })).messages;
const toolResultContent = (messages: Message[], toolCallId: string) => (messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId) as ToolResultMessage).content;

const readShot: Message[] = [
  { role: "user", content: "look", timestamp: 1 },
  response("toolUse", [{ id: "read_1", name: "read", path: "/work/shot.png" }]),
  result("read_1", "read", [{ type: "text", text: "Read image file [image/png]" }, image("SHOT")]),
];

test(`a read image is sent for ${TOOL_IMAGE_RESPONSES} responses, then replaced with a note that keeps its path`, () => {
  expect(TOOL_IMAGE_RESPONSES).toBe(5);
  const recent = [...readShot, ...responses(TOOL_IMAGE_RESPONSES - 1)];
  expect(toolResultContent(sent(recent), "read_1")).toStrictEqual(readShot[2].content);
  const old = [...readShot, ...responses(TOOL_IMAGE_RESPONSES)];
  expect(toolResultContent(sent(old), "read_1")).toStrictEqual([
    { type: "text", text: "Read image file [image/png]" },
    { type: "text", text: "(image omitted after 5 responses to save tokens: /work/shot.png. Read the file again to see it.)" },
  ]);
  // Pi's own history keeps the image.
  expect((readShot[2] as ToolResultMessage).content[1]).toStrictEqual(image("SHOT"));
});

test("failed and aborted responses are not counted, because they are not sent", () => {
  const messages = [...readShot, ...responses(TOOL_IMAGE_RESPONSES - 1), response("error"), response("aborted")];
  expect(toolResultContent(sent(messages), "read_1")[1]).toStrictEqual(image("SHOT"));
});

test("other tools' images get a note without a path, several images become one note, and user images stay", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "match this" }, image("USER")], timestamp: 1 },
    response("toolUse", [{ id: "shot_1", name: "screenshot" }]),
    result("shot_1", "screenshot", [image("A"), { type: "text", text: "two screens" }, image("B")]),
    ...responses(TOOL_IMAGE_RESPONSES),
  ];
  const fitted = sent(messages);
  expect(toolResultContent(fitted, "shot_1")).toStrictEqual([
    { type: "text", text: "(image omitted after 5 responses to save tokens)" }, { type: "text", text: "two screens" },
  ]);
  expect(fitted.find((message) => message.role === "user")).toStrictEqual(messages[0]);
});

test("a history without old tool images is returned as it is", () => {
  const context = normalizeContext({ messages: [...readShot, ...responses(2)] });
  expect(withoutOldToolImages(context)).toBe(context);
});
