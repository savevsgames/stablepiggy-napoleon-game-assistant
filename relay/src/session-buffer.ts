/**
 * Session event buffer — holds notable events per connection and flushes
 * them to the backend in batches.
 *
 * Flush triggers:
 *   - Every FLUSH_THRESHOLD events (default 10)
 *   - On client disconnect (ConnectionState cleanup)
 *   - On idle timeout (IDLE_FLUSH_MS with no new events, default 30min)
 *
 * Dedup: before flushing, events with identical (timestamp, speaker,
 * content) tuples are collapsed — the module may occasionally fire
 * duplicate hooks for the same chat message.
 *
 * Content truncation: enforces MAX_CONTENT_LENGTH as defense in depth
 * (the module already truncates, but the relay doesn't trust it).
 */

import type { SessionEventPayload } from "@stablepiggy-napoleon/protocol";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

const FLUSH_THRESHOLD = 10;
const IDLE_FLUSH_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONTENT_LENGTH = 500;

interface BufferEntry {
  events: SessionEventPayload[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  identityId: string;
  worldId: string;
}

const buffers = new Map<string, BufferEntry>();

export function pushEvent(
  connectionId: string,
  identityId: string,
  worldId: string,
  event: SessionEventPayload,
  config: Config,
  log: Logger
): void {
  let entry = buffers.get(connectionId);
  if (!entry) {
    entry = { events: [], idleTimer: null, identityId, worldId };
    buffers.set(connectionId, entry);
  }

  // Truncate content as defense in depth
  const truncated: SessionEventPayload = event.content.length > MAX_CONTENT_LENGTH
    ? { ...event, content: event.content.slice(0, MAX_CONTENT_LENGTH) }
    : event;

  entry.events.push(truncated);

  // Reset idle timer
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    void flushBuffer(connectionId, config, log);
  }, IDLE_FLUSH_MS);

  // Flush if threshold reached
  if (entry.events.length >= FLUSH_THRESHOLD) {
    void flushBuffer(connectionId, config, log);
  }
}

export function flushOnDisconnect(
  connectionId: string,
  config: Config,
  log: Logger
): void {
  void flushBuffer(connectionId, config, log);
}

function dedupEvents(events: SessionEventPayload[]): SessionEventPayload[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = `${e.timestamp}:${e.speaker}:${e.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function flushBuffer(
  connectionId: string,
  config: Config,
  log: Logger
): Promise<void> {
  const entry = buffers.get(connectionId);
  if (!entry || entry.events.length === 0) {
    return;
  }

  // Take ownership of the events and clear the buffer
  const toFlush = dedupEvents(entry.events);
  entry.events = [];
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  if (toFlush.length === 0) return;

  if (!config.backendUrl) {
    log.debug(
      { connectionId, eventCount: toFlush.length },
      "session buffer flush skipped (no backend URL)"
    );
    return;
  }

  // Derive the events endpoint from the query URL
  const eventsUrl = config.backendUrl.replace(/\/query\/?$/, "/events");

  try {
    const response = await fetch(eventsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.backendToken}`,
      },
      body: JSON.stringify({
        identityId: entry.identityId,
        worldId: entry.worldId,
        events: toFlush,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      log.warn(
        { connectionId, status: response.status, body: text.slice(0, 200) },
        "session buffer flush failed"
      );
      return;
    }

    log.info(
      { connectionId, flushed: toFlush.length },
      "session buffer flushed to backend"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    log.warn(
      { connectionId, err: msg },
      "session buffer flush error (non-blocking)"
    );
  }
}

export function cleanupBuffer(connectionId: string): void {
  const entry = buffers.get(connectionId);
  if (entry?.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  buffers.delete(connectionId);
}
