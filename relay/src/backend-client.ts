/**
 * HTTP client for the StablePiggy backend's Foundry query endpoint.
 *
 * M2 SCOPE (current): this client operates in TWO modes:
 *
 *   - **Stub mode** (activated when `RELAY_BACKEND_URL` is empty): returns a
 *     canned `backend.chat.create` command that echoes the query back to the
 *     caller. Lets M2 be smoke-tested with wscat without needing the
 *     backend running.
 *
 *   - **Live mode** (activated when `RELAY_BACKEND_URL` is set): makes a real
 *     HTTP POST to the configured endpoint with the service token as
 *     `Authorization: Bearer`. Used once Platform Track P2 has delivered the
 *     backend route (even as a stub). The relay and the backend meet here.
 *
 * M6 SCOPE (future): extend the live-mode error handling, add retries with
 * backoff on transient failures, add per-identity metering hooks.
 *
 * See BACKEND-API-SPEC.md in the platform repo for the HTTP contract.
 */

import type {
  ClientQueryPayload,
  BackendChatCreatePayload,
  BackendActorCreatePayload,
  BackendJournalCreatePayload,
} from "@stablepiggy-napoleon/protocol";

import type { ConnectionState } from "./connection-state.js";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

const RELAY_VERSION = "0.0.1";

export type BackendCommand =
  | { kind: "backend.chat.create"; payload: BackendChatCreatePayload }
  | { kind: "backend.actor.create"; payload: BackendActorCreatePayload }
  | { kind: "backend.journal.create"; payload: BackendJournalCreatePayload };

export interface BackendResponse {
  commands: BackendCommand[];
  meta: {
    tokensUsed: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    };
    modelUsed: string;
    durationMs: number;
    correlationId?: string;
  };
}

/**
 * Forward a client.query message to the backend (or return a stub response
 * if the backend URL is not configured). Throws on any failure — callers
 * should catch and emit a protocol `error` message to the client.
 */
export async function forwardQueryToBackend(
  connection: ConnectionState,
  query: ClientQueryPayload,
  queryMessageId: string,
  config: Config,
  log: Logger
): Promise<BackendResponse> {
  if (!connection.identityId || !connection.worldId) {
    throw new Error(
      "connection state missing identityId/worldId — client.hello was not completed"
    );
  }

  // ── Stub mode ──
  // When the relay is running without a backend URL (M2 standalone dev),
  // return a canned response that echoes the query. The module receives a
  // real chat.create command and can exercise its whole rendering path
  // without needing the backend online.
  if (!config.backendUrl) {
    log.debug(
      { queryMessageId, queryPreview: query.query.slice(0, 80) },
      "backend URL unset — returning M2 stub response"
    );
    return {
      commands: [
        {
          kind: "backend.chat.create",
          payload: {
            correlationId: queryMessageId,
            speaker: { alias: "Napoleon (M2 stub)" },
            content: `<p><em>M2 stub response — the real backend lands in M6.</em></p><p>You asked: <strong>${escapeHtml(
              query.query
            )}</strong></p><p>Session: ${escapeHtml(
              query.sessionId
            )}, World: ${escapeHtml(connection.worldId)}</p>`,
            type: "whisper",
            whisperTo: [connection.identityId],
          },
        },
      ],
      meta: {
        tokensUsed: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        modelUsed: "m2-stub",
        durationMs: 0,
        correlationId: queryMessageId,
      },
    };
  }

  // ── Live mode ──
  // Real HTTP call to the backend's POST /api/my/foundry/query endpoint.
  // Request shape is defined in BACKEND-API-SPEC.md §2.2. The backend token
  // is shipped as Authorization: Bearer per BACKEND-API-SPEC.md §3.
  const body = {
    sessionId: query.sessionId,
    identityId: connection.identityId,
    worldId: connection.worldId,
    query: query.query,
    context: query.context,
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(config.backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.backendToken}`,
        "X-Correlation-Id": queryMessageId,
        "X-Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown fetch error";
    throw new Error(`backend unreachable: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `backend returned HTTP ${response.status} in ${durationMs}ms: ${text.slice(
        0,
        200
      )}`
    );
  }

  const parsed = (await response.json()) as BackendResponse;
  log.debug(
    {
      queryMessageId,
      commandCount: parsed.commands.length,
      durationMs,
    },
    "backend responded"
  );
  return parsed;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
