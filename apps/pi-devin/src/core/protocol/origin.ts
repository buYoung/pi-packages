const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** An endpoint's origin, or why it is not one; `cause` is set when the value does not parse as a URL. */
export type EndpointCheck = { readonly origin: string } | { readonly problem: string; readonly cause?: unknown };

/**
 * The origin of an HTTPS endpoint, or of loopback HTTP for local verification, without credentials or a path.
 * Free of Effect so the extension entry can check a stored credential before it loads the runtime.
 */
export function checkEndpoint(value: string): EndpointCheck {
  let url: URL;
  try { url = new URL(value); } catch (cause) { return { problem: cause instanceof Error ? cause.message : String(cause), cause }; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return { problem: "The endpoint must be HTTPS, or loopback HTTP for local verification." };
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return { problem: "The endpoint must not contain credentials, a path, a query, or a fragment." };
  }
  return { origin: url.origin };
}
