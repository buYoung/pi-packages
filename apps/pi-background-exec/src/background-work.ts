import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Event-bus query for session-owned work that will wake the agent again after its run settles. Other packages
 * share this name and payload (pi-notify waits on it before "Ready for input"), so neither may change.
 */
const pendingWorkEvent = "background-work:query-pending";

/** Answer synchronous, session-scoped readiness queries without publishing stale snapshots. */
export function trackBackgroundWork(pi: ExtensionAPI, sessionId: string, hasPendingWork: () => boolean): () => void {
  return pi.events.on(pendingWorkEvent, (data) => {
    if (
      data &&
      typeof data === "object" &&
      "sessionId" in data &&
      data.sessionId === sessionId &&
      "pending" in data &&
      typeof data.pending === "boolean"
    ) {
      data.pending ||= hasPendingWork();
    }
  });
}

/** Whether any participating extension still has work in this session that will wake the agent. */
export function hasPendingBackgroundWork(pi: ExtensionAPI, sessionId: string): boolean {
  const query = { sessionId, pending: false };
  pi.events.emit(pendingWorkEvent, query);
  return query.pending;
}
