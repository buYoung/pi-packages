/**
 * Pi tool definitions of MCP tools: the input schema and annotations the server declares, an output
 * schema of the `CallToolResult` scripts receive, and the `_meta` other extensions read.
 */

import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolAnnotations, ToolDefinition, ToolNamespace } from "@earendil-works/pi-coding-agent";
import {
  type CallToolResult,
  createMcpResultSchema,
  type McpRequestOptions,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { Effect } from "effect";
import { isMaxOutputBytes, type McpExposure, toToolExposure } from "../config/schema.ts";
import type { ToolMeta } from "./meta.ts";
import { convertMcpResult, type McpToolDetails } from "./output.ts";
import { createMcpToolRenderers } from "./render.ts";
import { READ_MCP_RESOURCE_TOOL } from "./resources.ts";

export type ToolSchema = ToolDefinition["parameters"];

/**
 * Key in the `_meta` of a tool's `tools/list` entry with the bytes of model-facing text the tool's
 * results may have. It takes precedence over the configured `maxOutputBytes`.
 */
const MAX_OUTPUT_BYTES_META_KEY = "pi/maxOutputBytes";

/**
 * A registered MCP tool. `meta` is not sent to the model; it is the `_meta` of the tool's `tools/list`
 * entry, for other extensions (see meta.ts).
 */
export type McpToolDefinition = ToolDefinition<ToolSchema, McpToolDetails> & { meta?: ToolMeta };

export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions,
  ): Effect.Effect<CallToolResult, unknown>;
}

/** What a server's tools need of the server, read each time a call runs. */
export interface ToolTarget {
  /** The connection to call `tool` on. Fails when the server or the tool is no longer available. */
  caller(tool: string): Effect.Effect<McpToolCaller, Error>;
  /** Whether `read_mcp_resource` reaches the server's resources. */
  hasReadableResources(): boolean;
  /** The configured `maxOutputBytes` of the server's results, used when the tool's `_meta` declares none. */
  maxOutputBytes(): number | undefined;
}

/**
 * Tool input schemas must be objects. MCP servers may omit `type`, and some providers reject object
 * schemas without `properties`.
 */
function toParameters(schema: Record<string, unknown>): ToolSchema {
  return {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  } as unknown as ToolSchema;
}

const ANNOTATION_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an MCP tool's annotations, or undefined when it has none. */
function toToolAnnotations(tool: McpTool): ToolAnnotations | undefined {
  const annotations: ToolAnnotations = {};
  for (const hint of ANNOTATION_HINTS) {
    const value = tool.annotations?.[hint];
    if (typeof value === "boolean") annotations[hint] = value;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function createMcpToolDefinition(options: {
  server: string;
  tool: McpTool;
  name: string;
  exposure: McpExposure;
  namespace: ToolNamespace;
  timeoutMs: number;
  target: ToolTarget;
}): McpToolDefinition {
  const { server, tool, target } = options;
  const title = tool.title ?? tool.annotations?.title;
  const annotations = toToolAnnotations(tool);
  const declared = tool._meta?.[MAX_OUTPUT_BYTES_META_KEY];
  const declaredMaxOutputBytes = isMaxOutputBytes(declared) ? declared : undefined;
  // Passed on to extensions as the server sent it. The type is not checked when the list arrives;
  // it arrived as JSON, so the values of an object are JSON values.
  const meta =
    typeof tool._meta === "object" && tool._meta !== null && !Array.isArray(tool._meta)
      ? (tool._meta as Record<string, JsonValue>)
      : undefined;
  const label = `${server}/${tool.name}`;
  return {
    name: options.name,
    label,
    description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
    parameters: toParameters(tool.inputSchema),
    outputSchema: createMcpResultSchema(tool.outputSchema) as unknown as ToolSchema,
    exposure: toToolExposure(options.exposure),
    namespace: options.namespace,
    ...(annotations ? { annotations } : {}),
    ...(meta ? { meta } : {}),
    ...createMcpToolRenderers(label),
    // Pi's abort signal goes to the MCP request, which fails with the client's own error.
    execute: (_toolCallId, params, signal, onUpdate) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* target.caller(tool.name);
          const result = yield* client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
            signal,
            timeoutMs: options.timeoutMs,
            onProgress: (progress) => {
              const total = progress.total === undefined ? "" : `/${progress.total}`;
              const text = progress.message ?? `Progress ${progress.progress}${total}`;
              onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
            },
          });
          return yield* convertMcpResult(server, tool.name, result, {
            resourceReaderTool: target.hasReadableResources() ? READ_MCP_RESOURCE_TOOL : undefined,
            maxOutputBytes: declaredMaxOutputBytes ?? target.maxOutputBytes(),
          });
        }),
      ),
  };
}
