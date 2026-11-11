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
/** A later system message, as Pi adds when instructions or tools change. */
const instruction = (content: string): Message => ({ role: "system", content, timestamp: 1 });
const sent = (messages: Message[]) => withoutOldToolImages(normalizeContext({ systemPrompt: "base", messages })).messages;
const toolResultContent = (messages: Message[], toolCallId: string) => (messages.find((message) => message.role === "toolResult" && message.toolCallId === toolCallId) as ToolResultMessage).content;

const readShot: Message[] = [
  { role: "user", content: "look", timestamp: 1 },
  response("toolUse", [{ id: "read_1", name: "read", path: "/work/shot.png" }]),
  result("read_1", "read", [{ type: "text", text: "Read image file [image/png]" }, image("SHOT")]),
];
const OMITTED_READ = { type: "text", text: "(image omitted after 5 responses to save tokens: /work/shot.png. Read the file again to see it.)" };

test("without a change of the system prompt or tools, images stay however many responses follow", () => {
  expect(TOOL_IMAGE_RESPONSES).toBe(5);
  const context = normalizeContext({ systemPrompt: "base", messages: [...readShot, ...responses(40)] });
  expect(withoutOldToolImages(context)).toBe(context);
});

test(`at a prompt change, a read image with ${TOOL_IMAGE_RESPONSES} responses before it becomes a note with its path`, () => {
  const old = [...readShot, ...responses(TOOL_IMAGE_RESPONSES), instruction("new rule")];
  expect(toolResultContent(sent(old), "read_1")).toStrictEqual([{ type: "text", text: "Read image file [image/png]" }, OMITTED_READ]);
  // Pi's own history keeps the image.
  expect((readShot[2] as ToolResultMessage).content[1]).toStrictEqual(image("SHOT"));
  // Fewer responses before the change: the image stays, also after many more responses.
  const recent = [...readShot, ...responses(TOOL_IMAGE_RESPONSES - 1), instruction("new rule"), ...responses(30)];
  expect(toolResultContent(sent(recent), "read_1")[1]).toStrictEqual(image("SHOT"));
});

test("a system message that changes neither the prompt nor the tools leaves images in place", () => {
  const same = [...readShot, ...responses(TOOL_IMAGE_RESPONSES), { role: "system", content: [], timestamp: 1 } as Message];
  expect(toolResultContent(sent(same), "read_1")[1]).toStrictEqual(image("SHOT"));
});

test("between prompt changes, every request leaves out the same images, so earlier messages never change", () => {
  // The image ages past five responses, then a change comes, then the conversation keeps going.
  const history = [...readShot, ...responses(3), instruction("first"), ...responses(3), instruction("second"), ...responses(6)];
  const states: string[] = [];
  for (let length = readShot.length; length <= history.length; length++) {
    const content = toolResultContent(sent(history.slice(0, length)), "read_1");
    states.push(content.some((block) => block.type === "image") ? "image" : "note");
  }
  // Only at the second change (after six responses) does the image become a note, and it never comes back.
  const first = states.indexOf("note");
  const second = history.findIndex((message) => message.role === "system" && message.content === "second");
  // states[k] is the request with the first readShot.length + k messages; the change is in it from length second + 1.
  expect(first).toBe(second + 1 - readShot.length);
  expect(states.slice(first).every((state) => state === "note")).toBe(true);
  expect(states.slice(0, first).every((state) => state === "image")).toBe(true);
});

test("failed and aborted responses are not counted, because they are not sent", () => {
  const messages = [...readShot, ...responses(TOOL_IMAGE_RESPONSES - 1), response("error"), response("aborted"), instruction("new rule")];
  expect(toolResultContent(sent(messages), "read_1")[1]).toStrictEqual(image("SHOT"));
});

test("other tools' images get a note without a path, several images become one note, and user images stay", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "match this" }, image("USER")], timestamp: 1 },
    response("toolUse", [{ id: "shot_1", name: "screenshot" }]),
    result("shot_1", "screenshot", [image("A"), { type: "text", text: "two screens" }, image("B")]),
    ...responses(TOOL_IMAGE_RESPONSES), instruction("new rule"),
  ];
  const fitted = sent(messages);
  expect(toolResultContent(fitted, "shot_1")).toStrictEqual([
    { type: "text", text: "(image omitted after 5 responses to save tokens)" }, { type: "text", text: "two screens" },
  ]);
  expect(fitted.find((message) => message.role === "user")).toStrictEqual(messages[0]);
});
