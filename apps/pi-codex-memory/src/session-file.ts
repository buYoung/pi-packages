import { createReadStream } from "node:fs";
import type {
    SessionEntry,
    SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** One entry this large is beyond any extraction budget; such a file is not read. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const MEMORY_TOOL = /^pi_codex_memory_/;
const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** How Pi writes an image content part; its base64 payload follows. */
const IMAGE_DATA = Buffer.from('"type":"image","data":"');

/**
 * Empties base64 image payloads before the line is decoded, so a screenshot is never held as a
 * string. Base64 has no quote or backslash; a payload with either is left for JSON.parse.
 */
function withoutImageData(line: Buffer): Buffer {
    let index = line.indexOf(IMAGE_DATA);
    if (index === -1) return line;
    const pieces: Buffer[] = [];
    let start = 0;
    while (index !== -1) {
        const valueStart = index + IMAGE_DATA.length;
        const valueEnd = line.indexOf(QUOTE, valueStart);
        if (valueEnd === -1) return line;
        if (line.subarray(valueStart, valueEnd).includes(BACKSLASH))
            return line;
        pieces.push(line.subarray(start, valueStart));
        start = valueEnd;
        index = line.indexOf(IMAGE_DATA, valueEnd);
    }
    pieces.push(line.subarray(start));
    return Buffer.concat(pieces);
}

export interface SessionFile {
    header: SessionHeader;
    entries: SessionEntry[];
}

/**
 * Drops content extraction never reads, so a session's memory use follows its text rather than
 * its file size: images, assistant thinking, other tools' details, extension state other than
 * `keptCustomTypes`, and custom message content, which never reaches extraction.
 */
function compactEntry(
    entry: SessionEntry,
    keptCustomTypes: ReadonlySet<string>,
): SessionEntry {
    if (entry.type === "custom")
        return keptCustomTypes.has(entry.customType)
            ? entry
            : { ...entry, data: undefined };
    if (entry.type === "custom_message")
        return { ...entry, content: "", details: undefined };
    if (entry.type !== "message" || !entry.message) return entry;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content))
        return {
            ...entry,
            message: {
                ...message,
                content: message.content.filter(
                    (part) =>
                        part?.type === "text" || part?.type === "toolCall",
                ),
            },
        };
    if (message.role === "user" && Array.isArray(message.content))
        return {
            ...entry,
            message: {
                ...message,
                content: message.content.filter(
                    (part) => part?.type !== "image",
                ),
            },
        };
    if (message.role === "toolResult")
        return {
            ...entry,
            message: {
                ...message,
                content: Array.isArray(message.content)
                    ? message.content.filter((part) => part?.type !== "image")
                    : message.content,
                details: MEMORY_TOOL.test(message.toolName)
                    ? message.details
                    : undefined,
            },
        };
    return entry;
}

/**
 * Reads a JSONL session file one line at a time. Returns null for a file that is not a complete
 * session, a partially written or invalid line, a missing header or an entry without a type or
 * ID, and for one whose header `acceptHeader` rejects, without reading further.
 */
export async function readSessionFile(
    path: string,
    signal: AbortSignal,
    keptCustomTypes: ReadonlySet<string>,
    acceptHeader: (header: SessionHeader) => boolean = () => true,
): Promise<SessionFile | null> {
    let header: SessionHeader | undefined;
    const entries: SessionEntry[] = [];
    /** Parses one line; false means the file is not a complete session. */
    const accept = (line: Buffer): boolean => {
        const text = withoutImageData(line).toString("utf8");
        if (!text.trim()) return true;
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            return false;
        }
        if (!header) {
            const candidate = value as SessionHeader | undefined;
            if (
                candidate?.type !== "session" ||
                typeof candidate.id !== "string" ||
                typeof candidate.cwd !== "string" ||
                !acceptHeader(candidate)
            )
                return false;
            header = candidate;
            return true;
        }
        const entry = value as SessionEntry | null;
        if (
            !entry ||
            typeof entry.type !== "string" ||
            typeof entry.id !== "string"
        )
            return false;
        entries.push(compactEntry(entry, keptCustomTypes));
        return true;
    };
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const chunk of createReadStream(path, {
        signal,
        highWaterMark: 1024 * 1024,
    }) as AsyncIterable<Buffer>) {
        let start = 0;
        for (
            let index = chunk.indexOf(NEWLINE);
            index !== -1;
            index = chunk.indexOf(NEWLINE, start)
        ) {
            const piece = chunk.subarray(start, index);
            const line = pending.length
                ? Buffer.concat([...pending, piece])
                : piece;
            pending = [];
            pendingBytes = 0;
            if (line.length > MAX_LINE_BYTES || !accept(line)) return null;
            start = index + 1;
        }
        if (start < chunk.length) {
            pending.push(chunk.subarray(start));
            pendingBytes += chunk.length - start;
            if (pendingBytes > MAX_LINE_BYTES) return null;
        }
    }
    signal.throwIfAborted();
    if (pendingBytes && !accept(Buffer.concat(pending))) return null;
    return header ? { header, entries } : null;
}
