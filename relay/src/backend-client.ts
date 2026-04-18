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

export interface BackendActorUpdatePayload {
  readonly correlationId: string | null;
  readonly actorName: string;
  readonly updates: Readonly<Record<string, unknown>>;
}

export interface BackendRollTableCreatePayload {
  readonly correlationId: string | null;
  readonly name: string;
  readonly formula: string;
  readonly results: ReadonlyArray<{ text: string; range: [number, number]; weight?: number }>;
}

export type BackendCommand =
  | { kind: "backend.chat.create"; payload: BackendChatCreatePayload }
  | { kind: "backend.actor.create"; payload: BackendActorCreatePayload }
  | { kind: "backend.actor.update"; payload: BackendActorUpdatePayload }
  | { kind: "backend.journal.create"; payload: BackendJournalCreatePayload }
  | { kind: "backend.rolltable.create"; payload: BackendRollTableCreatePayload };

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
  //
  // systemId is lifted from the authenticated hello's capabilities block
  // (stored on connection state in server.ts::handleHello) and forwarded
  // so the backend's foundry-mode loader can compose the correct system
  // profile (foundry/{systemId}.md) on top of foundry-base.md. Prior to
  // this wiring, the backend fell back to SYSTEM_ID_DEFAULT='pf2e' with
  // a warning log on every first query — the fallback path is still in
  // place as a safety net but production traffic now always carries an
  // explicit systemId and no longer trips the warning.
  const body = {
    sessionId: query.sessionId,
    identityId: connection.identityId,
    worldId: connection.worldId,
    query: query.query,
    context: query.context,
    systemId: connection.capabilities?.systemId,
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

// ── Identity resolution (M2.1) ──────────────────────────────────────────
//
// When a GM authenticates with a StablePiggy API key (any `authToken` in
// client.hello starting with `dv-`), the relay calls this function to
// resolve the key to a real identity via the backend's identity endpoint.
// The backend runs its standard `authenticate()` path — the same code
// that guards every MCP tool call — and returns the canonical identity
// ID on success or 401 on failure.
//
// The request sends the GM's raw API key as the relay's own
// Authorization: Bearer header. The relay's service token
// (RELAY_BACKEND_TOKEN) is NOT involved here — the identity endpoint is
// API-key authenticated, not service authenticated, because any holder
// of a valid dv- key can already identify themselves via the MCP path.
// See dashboard/routes/foundry-identity.ts in the platform repo for the
// full rationale.

export interface ResolvedRemoteIdentity {
  identityId: string;
  role: string;
  orgId: string | null;
}

/**
 * Call the backend's identity endpoint to resolve a StablePiggy API key
 * to an identity. Throws on any failure — callers in the hello handler
 * should catch and close the socket with 1008.
 */
export async function resolveIdentityFromApiKey(
  apiKey: string,
  config: Config,
  log: Logger
): Promise<ResolvedRemoteIdentity> {
  if (!config.backendIdentityUrl) {
    throw new Error(
      "backend identity URL is not configured (set RELAY_BACKEND_URL or RELAY_BACKEND_IDENTITY_URL)"
    );
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(config.backendIdentityUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${apiKey}`,
        "X-Relay-Version": RELAY_VERSION,
      },
      // The endpoint ignores the body but some HTTP stacks complain
      // about POST without a Content-Length, so send an empty JSON
      // object to keep everyone happy.
      body: "{}",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown fetch error";
    throw new Error(`identity endpoint unreachable: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;

  if (response.status === 401) {
    throw new Error("invalid api key");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `identity endpoint returned HTTP ${response.status} in ${durationMs}ms: ${text.slice(
        0,
        200
      )}`
    );
  }

  const parsed = (await response.json()) as {
    identityId?: unknown;
    role?: unknown;
    orgId?: unknown;
  };
  if (typeof parsed.identityId !== "string" || parsed.identityId.length === 0) {
    throw new Error("identity endpoint returned malformed body (no identityId)");
  }

  log.debug(
    {
      identityId: parsed.identityId,
      role: parsed.role,
      durationMs,
    },
    "identity resolved from api key"
  );

  return {
    identityId: parsed.identityId,
    role: typeof parsed.role === "string" ? parsed.role : "unknown",
    orgId: typeof parsed.orgId === "string" ? parsed.orgId : null,
  };
}
