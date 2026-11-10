import { expect, test } from "vitest";
import { normalizeContext, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { toDevinTranscript } from "../src/pi/adapters/pi/transcript.ts";
import { model, runSync } from "./helpers.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", api: "devin-connect", provider: "devin", model: model.id,
  content: [{ type: "toolCall", id, name: "fixture_add", arguments: { a: 1, b: 2 } }], stopReason, usage, timestamp: 1 });
const transcript = (messages: Message[], supportsImages = true) => runSync(toDevinTranscript(normalizeContext({ messages }), { ...model, supportsImages }));

test("a failed response that reuses a call ID leaves the earlier successful result in the history", () => {
  const { messages } = transcript([
    { role: "user", content: "first", timestamp: 1 }, assistant("call_0", "toolUse"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "text", text: "earlier result" }], isError: false, timestamp: 1 },
    { role: "user", content: "next", timestamp: 1 }, assistant("call_0", "error"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "text", text: "result of the failed call" }], isError: true, timestamp: 1 },
    { role: "user", content: "again", timestamp: 1 },
  ]);
  expect(messages.map((message) => message.prompt)).toStrictEqual(["first", "", "earlier result", "next", "again"]);
});

test("a replayed call without a result gets Pi's error result before the next turn and at the end of the history", () => {
  const twoCalls: AssistantMessage = { ...assistant("call_a", "toolUse"), content: [
    { type: "toolCall", id: "call_a", name: "fixture_add", arguments: {} }, { type: "toolCall", id: "call_b", name: "fixture_add", arguments: {} },
  ] };
  const results = (messages: ReturnType<typeof transcript>["messages"]) =>
    messages.map((message) => [message.source, message.toolCallId ?? null, message.prompt, message.toolResultIsError ?? null]);
  // call_b has no result before the next user turn; call_c has none at the end of the history.
  expect(results(transcript([
    { role: "user", content: "first", timestamp: 1 }, twoCalls,
    { role: "toolResult", toolCallId: "call_a", toolName: "fixture_add", content: [{ type: "text", text: "3" }], isError: false, timestamp: 1 },
    { role: "user", content: "next", timestamp: 1 }, assistant("call_c", "toolUse"),
  ]).messages)).toStrictEqual([
    ["CHAT_MESSAGE_SOURCE_USER", null, "first", null], ["CHAT_MESSAGE_SOURCE_SYSTEM", null, "", null],
    ["CHAT_MESSAGE_SOURCE_TOOL", "call_a", "3", false], ["CHAT_MESSAGE_SOURCE_TOOL", "call_b", "No result provided", true],
    ["CHAT_MESSAGE_SOURCE_USER", null, "next", null], ["CHAT_MESSAGE_SOURCE_SYSTEM", null, "", null],
    ["CHAT_MESSAGE_SOURCE_TOOL", "call_c", "No result provided", true],
  ]);
  // A failed assistant's calls are not replayed, so they get no result either.
  expect(results(transcript([{ role: "user", content: "first", timestamp: 1 }, assistant("call_0", "error")]).messages))
    .toStrictEqual([["CHAT_MESSAGE_SOURCE_USER", null, "first", null]]);
});

test("a text-only model gets a note for earlier user and tool images instead of failing the request", () => {
  const history: Message[] = [
    { role: "user", content: [{ type: "text", text: "look: " }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 1 },
    assistant("call_0", "toolUse"),
    { role: "toolResult", toolCallId: "call_0", toolName: "fixture_add", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: 1 },
    { role: "user", content: "text only", timestamp: 1 },
  ];
  const textOnly = transcript(history, false).messages;
  expect(textOnly.map((message) => message.prompt)).toStrictEqual(["look: (image omitted: model does not support images)", "",
    "(tool image omitted: model does not support images)", "text only"]);
  expect(textOnly.some((message) => message.images)).toBe(false);
  expect(transcript(history).messages[0].images?.length).toBe(2);
});
