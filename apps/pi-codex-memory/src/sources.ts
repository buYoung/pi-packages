import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
    buildSessionProjection,
    type ExtensionContext,
    type SessionEntry,
    type SessionHeader,
    type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import type { MemorySettings } from "./config.js";
import { DEFAULT_SETTINGS, isSourceEligible } from "./config.js";
import { MemoryFailure } from "./failure.js";
import {
    observeRepository,
    type RepositoryObservation,
    repositoryPath,
    repositoryScope,
} from "./repositories.js";
import {
    canonicalCwd,
    digest,
    jsonStringBytes,
    truncateMiddleBytes,
    workspaceScope,
} from "./safety.js";
import { readSessionFile } from "./session-file.js";
import type { RolloutSource } from "./store.js";

export const ORIGIN_ENTRY = "pi-codex-memory.origin";
/** Version 2 records `exposure`; version-1 markers prove only that some memory context was received. */
export const RECALL_ENTRY = "pi-codex-memory.recall";
export type MemoryExposure = "local" | "external";
const COMPACTION_BOUNDARY = "pi-codex-memory.compaction-boundary";
/**
 * Rendered bytes packed into one conversation part. Fixed rather than taken from settings, so part
 * boundaries, and the memories keyed by them, stay put when the input budget changes.
 */
const PART_BYTES = DEFAULT_SETTINGS.maxInputBytes - 8192;
const HARNESS_TOOL = /(?:pi_codex_memory|subagent|contact_supervisor)/i;
const EXTERNAL_OMISSION =
    "Assistant text omitted because it received external repository memory context; not independent evidence and not evidence of task success or failure.";
function strongerExposure(
    current: MemoryExposure | undefined,
    next: MemoryExposure | undefined,
): MemoryExposure | undefined {
    return current === "external" || next === "external"
        ? "external"
        : (current ?? next);
}
/** Identifies the delivered foreign result structure, never a substring inside local memory content. */
function isForeignMemoryResult(message: ToolResultMessage): boolean {
    const tool = /^pi_codex_memory_(list|read|search)$/.exec(
        message.toolName,
    )?.[1];
    if (!tool || message.isError) return false;
    let value: unknown = message.details;
    if (value === undefined) {
        try {
            value = JSON.parse(
                message.content
                    .map((part) => (part.type === "text" ? part.text : ""))
                    .join(""),
            );
        } catch {
            return false;
        }
    }
    const result = (value && typeof value === "object" ? value : {}) as Record<
        string,
        unknown
    > & { repository?: { id?: unknown } };
    if (tool === "list" && Array.isArray(result.repositories))
        return (
            typeof result.current_scope === "string" &&
            typeof result.truncated === "boolean" &&
            (result.repositories as ({ id?: unknown } | null)[]).some(
                (item) =>
                    typeof item?.id === "string" &&
                    item.id !== result.current_scope,
            )
        );
    const hasPayload =
        tool === "read"
            ? typeof result.content === "string"
            : Array.isArray(
                  tool === "search" ? result.matches : result.entries,
              );
    if (
        !hasPayload ||
        typeof result.path !== "string" ||
        !result.path.startsWith("repositories/")
    )
        return false;
    try {
        return repositoryPath(result.path)?.scope === result.repository?.id;
    } catch {
        return false;
    }
}
function entryExposure(entry: SessionEntry): MemoryExposure | undefined {
    if (entry.type === "custom" && entry.customType === RECALL_ENTRY)
        return (entry.data as { exposure?: unknown } | undefined)?.exposure ===
            "external"
            ? "external"
            : "local";
    return entry.type === "message" &&
        entry.message.role === "toolResult" &&
        isForeignMemoryResult(entry.message)
        ? "external"
        : undefined;
}
type SessionEntryLookup = ExtensionContext["sessionManager"]["getEntry"];
/** Inspect provenance only; never add abandoned-branch messages to extraction input. */
function externalSummaryIds(
    branch: readonly SessionEntry[],
    getEntry?: SessionEntryLookup,
): Set<string> {
    const byId = new Map(branch.map((entry) => [entry.id, entry]));
    const lookup = getEntry ?? ((id: string) => byId.get(id));
    const summaries = new Set<string>(),
        safe = new Set<string>();
    for (const summary of branch) {
        if (summary.type !== "branch_summary") continue;
        const pending = [{ id: summary.fromId, isExit: false }],
            visiting = new Set<string>();
        while (pending.length) {
            const frame = pending.pop()!;
            if (frame.isExit) {
                visiting.delete(frame.id);
                safe.add(frame.id);
                continue;
            }
            if (safe.has(frame.id)) continue;
            const entry = lookup(frame.id);
            // Forked/exported histories may omit summary ancestors. Unknown/cyclic
            // provenance is not sufficient to treat a generated summary as local.
            if (
                !entry ||
                visiting.has(frame.id) ||
                entryExposure(entry) === "external"
            ) {
                summaries.add(summary.id);
                break;
            }
            visiting.add(frame.id);
            pending.push({ id: frame.id, isExit: true });
            if (entry.parentId !== null)
                pending.push({ id: entry.parentId, isExit: false });
            if (entry.type === "branch_summary")
                pending.push({ id: entry.fromId, isExit: false });
        }
    }
    return summaries;
}
/** Earlier exposure includes the provenance of summaries carried over from abandoned branches. */
export function branchExposure(
    branch: readonly SessionEntry[],
    getEntry?: SessionEntryLookup,
): MemoryExposure | undefined {
    if (externalSummaryIds(branch, getEntry).size) return "external";
    let exposure: MemoryExposure | undefined;
    for (const entry of branch)
        exposure = strongerExposure(exposure, entryExposure(entry));
    return exposure;
}
/** One rendered message; `entryIndex` is its entry's position in the projection. */
interface RenderItem {
    entryIndex: number;
    header: string;
    content: string;
    priority: number;
    sizeBytes: number;
    isIncluded: boolean;
    isEvidence: boolean;
}
/** The JSON-escaped "\n\n" between rendered items. */
const SEPARATOR_BYTES = 4;
function itemBytes(items: readonly RenderItem[]): number {
    return (
        items.reduce((total, item) => total + item.sizeBytes, 0) +
        SEPARATOR_BYTES * Math.max(0, items.length - 1)
    );
}
/** The projection's messages as rendered items in order; memory exposure carries across every entry. */
function renderItems(
    projection: SessionProjection,
    recalledEntries: ReadonlyMap<string, MemoryExposure>,
): RenderItem[] {
    const items: RenderItem[] = [];
    let exposure: MemoryExposure | undefined;
    let entryIndex = 0;
    const add = (
        header: string,
        content: string,
        priority: number,
        isEvidence: boolean,
    ) => {
        items.push({
            entryIndex,
            header,
            content,
            priority,
            sizeBytes: jsonStringBytes(header + content),
            isIncluded: true,
            isEvidence,
        });
    };
    for (const [
        index,
        { sourceEntry, messages },
    ] of projection.entries.entries()) {
        entryIndex = index;
        if (sourceEntry.type === "custom")
            exposure = strongerExposure(exposure, entryExposure(sourceEntry));
        if (
            sourceEntry.type === "custom_message" ||
            sourceEntry.type === "custom"
        )
            continue;
        for (const message of messages) {
            if (
                message.role !== "user" &&
                message.role !== "assistant" &&
                message.role !== "toolResult" &&
                message.role !== "compactionSummary" &&
                message.role !== "branchSummary"
            )
                continue;
            if (
                message.role === "user" &&
                sourceEntry.type === "message" &&
                exposure !== "external"
            )
                exposure = undefined;
            if (
                message.role === "toolResult" &&
                /^pi_codex_memory_(read|search)$/.test(message.toolName) &&
                !message.isError
            )
                exposure = strongerExposure(exposure, "local");
            if (message.role === "toolResult" && isForeignMemoryResult(message))
                exposure = "external";
            if (
                message.role === "toolResult" &&
                HARNESS_TOOL.test(message.toolName)
            )
                continue;
            const responseExposure = strongerExposure(
                exposure,
                recalledEntries.get(sourceEntry.id),
            );
            if (
                (message.role === "compactionSummary" ||
                    message.role === "branchSummary") &&
                responseExposure === "external"
            ) {
                exposure = "external";
                add(
                    `[entry=${sourceEntry.id}; harness omission notice, NOT source testimony]\n`,
                    "Generated summary omitted because its provenance may include external repository memory; not independent evidence.",
                    0,
                    false,
                );
                continue;
            }
            if (
                message.role === "assistant" &&
                responseExposure === "external"
            ) {
                // Foreign context can shape tool-use turns too. Ordinary tool requests stay as separate,
                // low-priority evidence; their arguments do not show that the call succeeded.
                const calls = message.content
                    .flatMap((part) =>
                        part.type === "toolCall" &&
                        !HARNESS_TOOL.test(part.name)
                            ? [
                                  JSON.stringify({
                                      tool: part.name,
                                      arguments: part.arguments,
                                  }),
                              ]
                            : [],
                    )
                    .join("\n");
                if (
                    message.content.some(
                        (part) => part.type === "text" && part.text.trim(),
                    )
                )
                    add(
                        `[entry=${sourceEntry.id}; harness omission notice, NOT source testimony]\n`,
                        EXTERNAL_OMISSION,
                        0,
                        false,
                    );
                if (calls)
                    add(
                        `[entry=${sourceEntry.id}; assistant; outcome=${message.stopReason}]\n`,
                        calls,
                        0,
                        true,
                    );
                continue;
            }
            // Explain the omission without recycling the response or implying task completion.
            const isRecallResponse =
                message.role === "assistant" &&
                message.stopReason === "stop" &&
                !!responseExposure;
            const isGenerated =
                message.role === "compactionSummary" ||
                message.role === "branchSummary" ||
                sourceEntry.type === "compaction" ||
                sourceEntry.type === "branch_summary";
            const isAnswer =
                message.role === "toolResult" &&
                message.toolName === "ask_user_question";
            const content = isRecallResponse
                ? "Assistant response omitted because it received memory context; not independent evidence and not evidence of task success or failure."
                : message.role === "compactionSummary" ||
                    message.role === "branchSummary"
                  ? message.summary
                  : typeof message.content === "string"
                    ? message.content
                    : message.content
                          .filter(
                              (part) =>
                                  part.type === "text" ||
                                  part.type === "toolCall",
                          )
                          .map((part) =>
                              part.type === "text"
                                  ? part.text
                                  : part.type === "toolCall" &&
                                      !HARNESS_TOOL.test(part.name)
                                    ? JSON.stringify({
                                          tool: part.name,
                                          arguments: part.arguments,
                                      })
                                    : "",
                          )
                          .join("\n");
            if (!content.trim()) continue;
            const provenance = isRecallResponse
                ? "harness omission notice, NOT source testimony"
                : isGenerated
                  ? `${message.role}: generated summary, NOT direct human testimony`
                  : message.role === "user"
                    ? "human user"
                    : isAnswer
                      ? "toolResult tool=ask_user_question; reported human answer, scoped to this task"
                      : message.role === "toolResult"
                        ? `toolResult tool=${message.toolName}`
                        : message.role;
            const status = isRecallResponse
                ? ""
                : message.role === "assistant"
                  ? `; outcome=${message.stopReason}`
                  : message.role === "toolResult"
                    ? `; isError=${message.isError}`
                    : "";
            const header = `[entry=${sourceEntry.id}; ${provenance}${status}]\n`;
            const priority = isRecallResponse
                ? 0
                : (message.role === "user" && !isGenerated) || isAnswer
                  ? 3
                  : isGenerated ||
                      (message.role === "assistant" &&
                          message.stopReason === "stop")
                    ? 2
                    : message.role === "toolResult" &&
                        Buffer.byteLength(content) <= 1024
                      ? 1
                      : 0;
            add(header, content, priority, !isRecallResponse);
        }
    }
    return items;
}
export function renderProjection(
    projection: SessionProjection,
    maxBytes: number,
    recalledEntries: ReadonlyMap<string, MemoryExposure> = new Map(),
): string {
    return fitItems(renderItems(projection, recalledEntries), maxBytes);
}
/** Joins items within maxBytes, shortening and then omitting the least important first. */
function fitItems(source: readonly RenderItem[], maxBytes: number): string {
    // Fitting rewrites items, so each part is fitted on its own copies.
    const items = source.map((item) => ({ ...item }));
    if (!items.some((item) => item.isEvidence)) return "";
    let totalBytes = itemBytes(items);
    const render = () =>
        items
            .filter((item) => item.isIncluded)
            .map((item) => item.header + item.content)
            .join("\n\n");
    if (totalBytes <= maxBytes) return render();
    const marker =
        "[History budget: tool/assistant evidence was shortened or omitted. Missing evidence is unknown; never infer refusal or permission.]\n\n";
    const availableBytes = maxBytes - jsonStringBytes(marker);
    if (availableBytes < 0) throw new MemoryFailure("input_budget");
    let count = items.length;
    const shorten = (index: number, limitBytes: number) => {
        const item = items[index]!;
        const content = truncateMiddleBytes(item.content, limitBytes);
        const sizeBytes = jsonStringBytes(item.header + content);
        totalBytes += sizeBytes - item.sizeBytes;
        item.content = content;
        item.sizeBytes = sizeBytes;
    };
    const omit = (index: number) => {
        const item = items[index]!;
        totalBytes -= item.sizeBytes + (count > 1 ? 4 : 0);
        item.isIncluded = false;
        count--;
    };
    // Prefer retaining both chronological endpoints within each lower-priority class.
    const middleFirst = items
        .map((_, index) => index)
        .sort(
            (a, b) =>
                Math.abs(a - (items.length - 1) / 2) -
                Math.abs(b - (items.length - 1) / 2),
        );
    for (const priority of [0, 1]) {
        for (const index of middleFirst) {
            if (totalBytes <= availableBytes) break;
            if (items[index]!.priority === priority) shorten(index, 2048);
        }
        for (const index of middleFirst) {
            if (totalBytes <= availableBytes) break;
            if (items[index]!.priority === priority) omit(index);
        }
    }
    for (const index of middleFirst) {
        if (totalBytes <= availableBytes) break;
        if (items[index]!.priority === 2) shorten(index, 2048);
    }
    for (const index of middleFirst) {
        if (totalBytes <= availableBytes) break;
        if (items[index]!.priority === 2) omit(index);
    }
    // Do not silently erase human decisions when even the protected inputs exceed the budget.
    if (totalBytes > availableBytes) throw new MemoryFailure("input_budget");
    return marker + render();
}
function extractionProjection(
    branch: readonly SessionEntry[],
): SessionProjection {
    const editedIds = new Set(
        branch
            .filter((entry) => entry.type === "context_edit")
            .map((entry) => entry.targetId),
    );
    // This is a request-local view, not a rewritten session graph. Keep every id/parent
    // link and let the public SDK apply branch-local context edits. An edited
    // compaction remains a barrier, including in imported/hand-edited session files.
    const entries = branch.map(
        (entry): SessionEntry =>
            entry.type === "compaction" && !editedIds.has(entry.id)
                ? {
                      type: "custom",
                      id: entry.id,
                      parentId: entry.parentId,
                      timestamp: entry.timestamp,
                      customType: COMPACTION_BOUNDARY,
                  }
                : entry,
    );
    return buildSessionProjection(entries, branch.at(-1)?.id ?? null);
}
/** A session's repository binding and, when it was attached to a conversation already under way, where it starts. */
interface SessionBinding {
    repository: RepositoryObservation;
    /** The origin entry the binding applies from; undefined when it covers the whole session. */
    attachmentId?: string;
}
function sessionBinding(
    branch: readonly SessionEntry[],
): SessionBinding | undefined {
    for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== ORIGIN_ENTRY)
            continue;
        const data = entry.data as
            | {
                  version?: number;
                  isInteractiveRoot?: boolean;
                  repository?: RepositoryObservation;
              }
            | undefined;
        if (data?.version !== 3 || data.isInteractiveRoot !== true) continue;
        const value = data.repository;
        if (
            (value?.binding === "session_start" ||
                value?.binding === "attached") &&
            typeof value.scope === "string" &&
            /^repository-[a-f0-9]{24}$/.test(value.scope) &&
            typeof value.commonDirectory === "string" &&
            typeof value.worktreeRoot === "string" &&
            Number.isSafeInteger(value.capturedAtMs) &&
            (value.branchAtCapture === null ||
                typeof value.branchAtCapture === "string") &&
            repositoryScope(value.commonDirectory) === value.scope
        )
            return {
                repository: {
                    scope: value.scope,
                    commonDirectory: value.commonDirectory,
                    worktreeRoot: value.worktreeRoot,
                    branchAtCapture: value.branchAtCapture,
                    capturedAtMs: value.capturedAtMs,
                    binding: value.binding,
                },
                ...(value.binding === "attached"
                    ? { attachmentId: entry.id }
                    : {}),
            };
    }
    return undefined;
}
export function sourceScope(
    source: Pick<RolloutSource, "cwd" | "repository">,
): string {
    return source.repository?.scope ?? workspaceScope(source.cwd);
}
/** Fingerprints exclude checkout state, so a source that moved to another scope is compared separately. */
export function isSameSource(
    latest: RolloutSource | null,
    source: RolloutSource,
): boolean {
    return (
        !!latest &&
        latest.fingerprint === source.fingerprint &&
        sourceScope(latest) === sourceScope(source)
    );
}
/** A contiguous range of projection entries rendered as one extraction input. */
interface ConversationPart {
    /** The boundary entry the part starts at; null for the start of the branch. */
    start: SessionEntry | null;
    /** The boundary entry that starts the next part; null for the latest part. */
    end: SessionEntry | null;
    /** Projection entry indexes [from, to). */
    from: number;
    to: number;
    items: RenderItem[];
    sizeBytes: number;
}
function entryKey(entry: SessionEntry | null): string {
    return entry ? `${entry.id}@${entry.timestamp}` : "root";
}
/**
 * Splits the projection at compaction boundaries and at `attachmentId`, then packs consecutive
 * pieces into parts of at most PART_BYTES, so a conversation within that budget stays one part.
 * Packing runs from the start, so earlier parts keep their boundaries as the conversation grows.
 * A binding attached mid-conversation always starts a new part.
 */
function conversationParts(
    projection: SessionProjection,
    items: readonly RenderItem[],
    attachmentId: string | undefined,
): ConversationPart[] {
    const pieces: (ConversationPart & { isHard: boolean })[] = [];
    let itemIndex = 0;
    projection.entries.forEach(({ sourceEntry }, index) => {
        const isHard = sourceEntry.id === attachmentId;
        const isBoundary =
            isHard ||
            sourceEntry.type === "compaction" ||
            (sourceEntry.type === "custom" &&
                sourceEntry.customType === COMPACTION_BOUNDARY);
        if (!pieces.length || (isBoundary && index > 0))
            pieces.push({
                start: pieces.length ? sourceEntry : null,
                end: null,
                from: index,
                to: index,
                items: [],
                sizeBytes: 0,
                isHard,
            });
        const piece = pieces.at(-1)!;
        piece.to = index + 1;
        while (items[itemIndex]?.entryIndex === index)
            piece.items.push(items[itemIndex++]!);
    });
    const parts: ConversationPart[] = [];
    for (const piece of pieces) {
        piece.sizeBytes = itemBytes(piece.items);
        const last = parts.at(-1);
        const joinedBytes = last
            ? last.sizeBytes +
              piece.sizeBytes +
              (last.items.length && piece.items.length ? SEPARATOR_BYTES : 0)
            : 0;
        if (
            last &&
            !piece.isHard &&
            (!last.items.length || joinedBytes <= PART_BYTES)
        ) {
            for (const item of piece.items) last.items.push(item);
            last.sizeBytes = joinedBytes;
            last.to = piece.to;
        } else
            parts.push({
                start: piece.start,
                end: null,
                from: piece.from,
                to: piece.to,
                items: piece.items,
                sizeBytes: piece.sizeBytes,
            });
    }
    for (let index = 0; index + 1 < parts.length; index++)
        parts[index]!.end = parts[index + 1]!.start;
    // A part with nothing to render, such as history before an attached binding that has none, is not counted.
    return parts.filter((part) => part.items.length);
}
/**
 * The latest part of a session is keyed by the session, and by the session ID alone when it is
 * the only part, as before sessions had parts. A closed part is keyed by the entries that bound
 * it, so a fork that copied it shares its memory.
 */
function partId(
    sessionId: string,
    root: SessionEntry,
    part: ConversationPart,
): string {
    if (!part.end)
        return part.start
            ? `part-${digest(JSON.stringify([sessionId, entryKey(part.start)])).slice(0, 32)}`
            : sessionId;
    return `part-${digest(JSON.stringify([entryKey(root), entryKey(part.start), entryKey(part.end)])).slice(0, 32)}`;
}
export interface SourceOptions {
    /** Only parts that belong to this scope; global keeps every part. */
    expectedScope?: string;
    /** In a repository scope, only parts the session's own repository binding covers. */
    requireBinding?: boolean;
    /** Closed parts that ended earlier are left out; the latest part goes with its file. */
    oldestPartMs?: number;
}
/** The session's parts as sources, latest first. */
function sessionSources(
    header: SessionHeader,
    file: string,
    maxBytes: number,
    branch: readonly SessionEntry[],
    getEntry: SessionEntryLookup,
    fallbackTimeMs: number,
    options: SourceOptions & {
        fileSizeBytes?: number;
        fileModifiedAtMs?: number;
    } = {},
): RolloutSource[] {
    // Missing ancestry cannot establish which original evidence is safe to recover.
    if (!branch.length || branch[0]!.parentId !== null) return [];
    const binding = sessionBinding(branch),
        observed = observeRepository(header.cwd);
    // The current checkout only verifies membership; later checkouts must not rewrite recorded provenance.
    if (binding && observed && binding.repository.scope !== observed.scope)
        return [];
    const { expectedScope, requireBinding, oldestPartMs } = options;
    const isInScope = (repository: RepositoryObservation | undefined) =>
        !expectedScope ||
        expectedScope === "global" ||
        sourceScope({
            cwd: header.cwd,
            ...(repository ? { repository } : {}),
        }) === expectedScope;
    const canUseBound = !!binding && isInScope(binding.repository);
    const canUseUnbound =
        (!binding || !!binding.attachmentId) &&
        !(requireBinding && expectedScope?.startsWith("repository-")) &&
        isInScope(observed);
    // Nothing is rendered for a session no part of which can belong to the expected scope.
    if (!canUseBound && !canUseUnbound) return [];
    const projection = extractionProjection(branch);
    const recalledEntries = new Map<string, MemoryExposure>();
    const externalSummaries = externalSummaryIds(branch, getEntry);
    let exposure: MemoryExposure | undefined;
    for (const entry of branch) {
        if (
            entry.type === "message" &&
            entry.message.role === "user" &&
            exposure !== "external"
        )
            exposure = undefined;
        exposure = strongerExposure(
            exposure,
            externalSummaries.has(entry.id) ? "external" : entryExposure(entry),
        );
        if (
            exposure &&
            ((entry.type === "message" && entry.message.role === "assistant") ||
                entry.type === "branch_summary" ||
                entry.type === "compaction")
        )
            recalledEntries.set(entry.id, exposure);
    }
    const parts = conversationParts(
        projection,
        renderItems(projection, recalledEntries),
        binding?.attachmentId,
    );
    const attachmentIndex = binding?.attachmentId
        ? projection.entries.findIndex(
              ({ sourceEntry }) => sourceEntry.id === binding.attachmentId,
          )
        : -1;
    const partIds = parts.map((part) => partId(header.id, branch[0]!, part));
    const sources: RolloutSource[] = [];
    parts.forEach((part, index) => {
        const isBound =
            !!binding &&
            (!binding.attachmentId ||
                attachmentIndex < 0 ||
                part.from >= attachmentIndex);
        if (isBound ? !canUseBound : !canUseUnbound) return;
        let last: SessionEntry | undefined;
        for (
            let entryIndex = part.to - 1;
            entryIndex >= part.from;
            entryIndex--
        ) {
            const entry = projection.entries[entryIndex]!.sourceEntry;
            if (
                entry.type === "message" ||
                entry.type === "context_edit" ||
                entry.type === "branch_summary"
            ) {
                last = entry;
                break;
            }
        }
        const leafId = last?.id ?? null;
        const timeMs = last ? Date.parse(last.timestamp) : fallbackTimeMs;
        const updatedAtMs = Number.isFinite(timeMs) ? timeMs : fallbackTimeMs;
        if (
            part.end &&
            oldestPartMs !== undefined &&
            updatedAtMs < oldestPartMs
        )
            return;
        const text = fitItems(part.items, maxBytes);
        if (!text) return;
        const repository = isBound ? binding.repository : observed;
        sources.push({
            id: partIds[index]!,
            sessionId: header.id,
            cwd: canonicalCwd(header.cwd),
            file,
            leafId,
            updatedAtMs,
            fingerprint: digest(JSON.stringify({ version: 4, leafId, text })),
            text,
            ...(parts.length > 1
                ? { part: { number: index + 1, isLatest: !part.end } }
                : {}),
            partIds,
            ...(options.fileSizeBytes !== undefined &&
            options.fileModifiedAtMs !== undefined
                ? {
                      fileSizeBytes: options.fileSizeBytes,
                      fileModifiedAtMs: options.fileModifiedAtMs,
                  }
                : {}),
            ...(repository ? { repository } : {}),
        });
    });
    return sources.reverse();
}
/** The current session's parts, latest first. */
export function currentSources(
    manager: ExtensionContext["sessionManager"],
    maxBytes: number,
    nowMs = Date.now(),
): RolloutSource[] {
    const header = manager.getHeader();
    if (!header) return [];
    return sessionSources(
        header,
        manager.getSessionFile() ?? "",
        maxBytes,
        manager.getBranch(),
        (id) => manager.getEntry(id),
        nowMs,
    );
}
/** The latest part of the current session. */
export function currentSource(
    manager: ExtensionContext["sessionManager"],
    maxBytes: number,
    nowMs = Date.now(),
): RolloutSource | null {
    return currentSources(manager, maxBytes, nowMs)[0] ?? null;
}
const KEPT_CUSTOM_TYPES: ReadonlySet<string> = new Set([
    ORIGIN_ENTRY,
    RECALL_ENTRY,
]);
/** A session file's parts, latest first. */
export async function readSources(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
    options: SourceOptions & {
        requireOrigin: boolean;
        isCwdExcluded?: (cwd: string) => boolean;
    },
): Promise<RolloutSource[]> {
    signal.throwIfAborted();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const session = await readSessionFile(
        path,
        signal,
        KEPT_CUSTOM_TYPES,
        (header) => !options.isCwdExcluded?.(header.cwd),
    );
    if (!session) return [];
    const { header, entries } = session;
    signal.throwIfAborted();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    let current = entries.at(-1);
    const branch: SessionEntry[] = [];
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (
        options.requireOrigin &&
        !branch.some(
            (entry) =>
                entry.type === "custom" &&
                entry.customType === ORIGIN_ENTRY &&
                (entry.data as { isInteractiveRoot?: boolean } | undefined)
                    ?.isInteractiveRoot === true,
        )
    )
        return [];
    return sessionSources(
        header,
        path,
        maxBytes,
        branch.reverse(),
        (id) => byId.get(id),
        stat.mtimeMs,
        {
            ...options,
            requireBinding: options.requireBinding ?? options.requireOrigin,
            // Taken before reading, so content appended meanwhile shows as a change.
            fileSizeBytes: stat.size,
            fileModifiedAtMs: stat.mtimeMs,
        },
    );
}
/** The latest part of a session file. */
export async function readSource(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
    requireOrigin: boolean,
    expectedScope?: string,
    isCwdExcluded?: (cwd: string) => boolean,
): Promise<RolloutSource | null> {
    return (
        (
            await readSources(path, maxBytes, signal, {
                requireOrigin,
                expectedScope,
                isCwdExcluded,
            })
        )[0] ?? null
    );
}
export interface ScannedFile {
    path: string;
    sizeBytes: number;
    modifiedAtMs: number;
    /** The file's parts that this scan returned, including ones another file also holds. */
    sources: readonly RolloutSource[];
}
/**
 * Keeps the parts read from each session file until the file changes, so a file whose work is
 * pending is not parsed again on every scan. Owned by one Pi session's memory runtime.
 */
export class SourceCache {
    readonly #files = new Map<
        string,
        {
            key: string;
            sizeBytes: number;
            modifiedAtMs: number;
            sources: RolloutSource[];
        }
    >();
    get(
        path: string,
        key: string,
        sizeBytes: number,
        modifiedAtMs: number,
    ): RolloutSource[] | undefined {
        const file = this.#files.get(path);
        return file?.key === key &&
            file.sizeBytes === sizeBytes &&
            file.modifiedAtMs === modifiedAtMs
            ? file.sources
            : undefined;
    }
    set(
        path: string,
        key: string,
        sizeBytes: number,
        modifiedAtMs: number,
        sources: RolloutSource[],
    ): void {
        this.#files.set(path, { key, sizeBytes, modifiedAtMs, sources });
    }
    /** Forgets files the last scan did not consider. */
    retain(paths: ReadonlySet<string>): void {
        for (const path of this.#files.keys())
            if (!paths.has(path)) this.#files.delete(path);
    }
}
export async function scanSources(options: {
    agentDir: string;
    cwd: string;
    sessionDir: string;
    scope: string;
    settings: MemorySettings;
    signal: AbortSignal;
    nowMs: number;
    allowUnmarked?: boolean;
    /** Also parts no repository binding covers, attributed by the session folder's current repository. */
    allowUnbound?: boolean;
    sessionDirectories?: readonly string[];
    isCwdExcluded?: (cwd: string) => boolean;
    /** Skips parsing a session file that cannot have new work, judged from its path, mtime and size. */
    shouldRead?: (path: string, mtimeMs: number, sizeBytes: number) => boolean;
    /** Reports every session file read or reused from the cache, with the parts it returned. */
    onFile?: (file: ScannedFile) => void;
    cache?: SourceCache;
}): Promise<RolloutSource[]> {
    const { agentDir, sessionDir, scope, settings, signal, nowMs } = options;
    const directories = new Set([
        sessionDir,
        ...(options.sessionDirectories ?? []),
    ]);
    if (scope === "global") {
        const root = join(agentDir, "sessions");
        try {
            for (const entry of (
                await readdir(root, { withFileTypes: true })
            ).slice(0, 1000)) {
                if (entry.isDirectory() && !entry.isSymbolicLink())
                    directories.add(join(root, entry.name));
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    const candidates: {
        path: string;
        updatedAtMs: number;
        sizeBytes: number;
    }[] = [];
    for (const directory of directories) {
        signal.throwIfAborted();
        try {
            if ((await lstat(directory)).isSymbolicLink()) continue;
            for (const entry of (
                await readdir(directory, { withFileTypes: true })
            ).slice(0, 5000)) {
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
                const path = join(directory, entry.name);
                const stat = await lstat(path);
                if (
                    isSourceEligible(stat.mtimeMs, nowMs, settings) &&
                    (options.shouldRead?.(path, stat.mtimeMs, stat.size) ??
                        true)
                )
                    candidates.push({
                        path,
                        updatedAtMs: stat.mtimeMs,
                        sizeBytes: stat.size,
                    });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const maxBytes = settings.maxInputBytes - 8192;
    const oldestPartMs = nowMs - settings.maxRolloutAgeDays * 86_400_000;
    const requireOrigin = !options.allowUnmarked;
    const requireBinding = requireOrigin && !options.allowUnbound;
    // The cutoff moves only forward, so parts read under an earlier one need only filtering again.
    const cacheKey = JSON.stringify([
        scope,
        requireOrigin,
        requireBinding,
        Number.isFinite(oldestPartMs),
        maxBytes,
    ]);
    const sources: RolloutSource[] = [];
    const seen = new Set<string>();
    const considered = new Set<string>();
    for (const candidate of candidates.slice(0, 5000)) {
        signal.throwIfAborted();
        considered.add(candidate.path);
        let read = options.cache?.get(
            candidate.path,
            cacheKey,
            candidate.sizeBytes,
            candidate.updatedAtMs,
        );
        if (!read) {
            try {
                read = await readSources(candidate.path, maxBytes, signal, {
                    requireOrigin,
                    requireBinding,
                    expectedScope: scope,
                    isCwdExcluded: options.isCwdExcluded,
                    oldestPartMs,
                });
            } catch (error) {
                // A session deleted after listing has no work.
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
                continue;
            }
            options.cache?.set(
                candidate.path,
                cacheKey,
                candidate.sizeBytes,
                candidate.updatedAtMs,
                read,
            );
        }
        const fileSources = read.filter(
            (source) =>
                !source.part ||
                source.part.isLatest ||
                source.updatedAtMs >= oldestPartMs,
        );
        options.onFile?.({
            path: candidate.path,
            sizeBytes: candidate.sizeBytes,
            modifiedAtMs: candidate.updatedAtMs,
            sources: fileSources,
        });
        for (const source of fileSources) {
            if (seen.has(source.id)) continue;
            seen.add(source.id);
            sources.push(source);
        }
    }
    options.cache?.retain(considered);
    return sources;
}
/** Whether the session folder's current repository still places the source in the same scope. */
function hasSameScope(source: RolloutSource): boolean {
    const observed = observeRepository(source.cwd);
    const bound =
        source.repository && source.repository.binding !== "current_location"
            ? source.repository
            : undefined;
    if (bound && observed && bound.scope !== observed.scope) return false;
    const repository = bound ?? observed;
    return (
        sourceScope({
            cwd: source.cwd,
            ...(repository ? { repository } : {}),
        }) === sourceScope(source)
    );
}
export async function isSourceUnchanged(
    source: RolloutSource,
    signal: AbortSignal,
    maxBytes: number,
): Promise<boolean> {
    if (!source.file) return true;
    const file = resolve(source.file);
    if (source.fileSizeBytes !== undefined) {
        signal.throwIfAborted();
        const stat = await lstat(file);
        // Session files only grow, so an unchanged size and mtime mean unchanged content.
        if (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size === source.fileSizeBytes &&
            stat.mtimeMs === source.fileModifiedAtMs
        )
            return hasSameScope(source);
    }
    const latest = await readSources(file, maxBytes, signal, {
        requireOrigin: false,
    });
    return isSameSource(
        latest.find((item) => item.id === source.id) ?? null,
        source,
    );
}
