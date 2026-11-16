import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type CacheStore, defaultCache } from "../cache/storage.ts";
import { createRenderResult } from "../render/result.ts";
import { FAIL_TTL_MINUTES, READ_CHUNK, SNIPPET_LIMIT, SUCCESS_TTL_HOURS } from "../web/constants.ts";
import { executeWebFetch, type FetchParams } from "../web/fetch.ts";
import { executeWebSearch, type SearchParams } from "../web/search.ts";
import { type AccountRequestRunner, singleAccountRunner } from "./account-requests.ts";

type ToolSchema = ToolDefinition["parameters"];

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query to execute" },
    max_results: {
      type: "integer",
      description: "Maximum number of search results to return (default: 5, max: 10)",
      default: 5,
      minimum: 1,
      maximum: 10,
    },
    refresh: {
      type: "boolean",
      description:
        "Bypass the cached search and re-call the API (default: false). The fresh result replaces the cache entry.",
      default: false,
    },
    offset: {
      type: "integer",
      description:
        "UTF-16 character offset in the expanded result, or in the formatted result list when expand is omitted. Use the returned nextOffset.",
      default: 0,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    expand: {
      type: "integer",
      description:
        "Read a bounded page of this result (1-based index) instead of snippets. " +
        "Use offset to continue; no API call only while the original search remains cached.",
      minimum: 1,
    },
  },
  required: ["query"],
} as unknown as ToolSchema;

const WEB_FETCH_PARAMETERS = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch and extract content from", format: "uri" },
    offset: {
      type: "integer",
      description: "Start reading from this UTF-16 character index (default: 0); prefer the returned nextOffset.",
      default: 0,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    full: {
      type: "boolean",
      description:
        "Return the largest page within Pi output limits (default: false). Continue using nextOffset until the source is complete.",
      default: false,
    },
    refresh: {
      type: "boolean",
      description:
        "Bypass the cached page (or cached failure) and re-call the API (default: false). The fresh result replaces the cache entry.",
      default: false,
    },
  },
  required: ["url"],
} as unknown as ToolSchema;

export function registerWebSearchTool(
  pi: ExtensionAPI,
  cacheStore: CacheStore = defaultCache,
  runWithAccount: AccountRequestRunner = singleAccountRunner,
) {
  pi.registerTool({
    name: "ollama_web_search",
    label: "Ollama Web Search",
    description:
      "Search the web for real-time information using Ollama Cloud's web search API. " +
      `Returns up to max_results results (default 5, max 10; title, URL, ${SNIPPET_LIMIT}-char snippet; [truncated] means the source is longer — ` +
      "pass expand=<index> to read that result in bounded pages; use offset from the response to continue). " +
      `Results are cached for up to ${SUCCESS_TTL_HOURS}h. Reuse costs 0 API calls only while the entry is fresh and retained. ` +
      "Eviction or expiry may require another API call. Title, URL and details fields are bounded previews. " +
      "Pass refresh=true to bypass the cache and re-call the API (e.g. results look stale). " +
      "Requires an Ollama Cloud API key.",
    parameters: WEB_SEARCH_PARAMETERS,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as SearchParams;
      return runWithAccount(ctx, signal, (resolveApiKey) =>
        executeWebSearch(params, signal, resolveApiKey, cacheStore, ctx.modelRegistry),
      );
    },
    renderCall(rawArgs, theme, _context) {
      const args = rawArgs as Partial<SearchParams>;
      const display = args.query ? `ollama_web_search("${args.query}")` : "ollama_web_search";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}

export function registerWebFetchTool(
  pi: ExtensionAPI,
  cacheStore: CacheStore = defaultCache,
  runWithAccount: AccountRequestRunner = singleAccountRunner,
) {
  pi.registerTool({
    name: "ollama_web_fetch",
    label: "Ollama Web Fetch",
    description:
      "Fetch and extract text content from a web page URL using Ollama Cloud's web fetch API. " +
      `Returns the page title, a ${READ_CHUNK}-char slice of the content, and links. Pages are cached for ${SUCCESS_TTL_HOURS}h. ` +
      "Pass offset=N to continue reading from char N (the output tells you the next offset), or " +
      `full=true to request the largest bounded page, not unlimited content. Eviction or expiry can require another API call. A cacheable failed URL is cached for ${FAIL_TTL_MINUTES} min ` +
      `— retrying it within the failure TTL (${FAIL_TTL_MINUTES} min) costs 0 API calls and fails the same way; pass refresh=true to ` +
      "force a live retry. Requires an Ollama Cloud API key.",
    parameters: WEB_FETCH_PARAMETERS,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as FetchParams;
      return runWithAccount(ctx, signal, (resolveApiKey) =>
        executeWebFetch(params, signal, resolveApiKey, cacheStore, ctx.modelRegistry),
      );
    },
    renderCall(rawArgs, theme, _context) {
      const args = rawArgs as Partial<FetchParams>;
      const display = args.url ? `ollama_web_fetch("${args.url}")` : "ollama_web_fetch";
      return new Text(theme.fg("toolTitle", display), 0, 0);
    },
    renderResult: createRenderResult(),
  });
}
