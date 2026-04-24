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
  BackendSceneCreatePayload,
  BackendSceneUpdatePayload,
  BackendTokenCreatePayload,
  BackendWallCreatePayload,
  BackendLightCreatePayload,
} from "@stablepiggy-napoleon/protocol";
// BackendDataUploadPayload is declared locally below (line ~216) rather
// than imported — the relay's copy predates the protocol-level type and
// kept them intentionally distinct for M2-era backward compat.

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
  | { kind: "backend.rolltable.create"; payload: BackendRollTableCreatePayload }
  | { kind: "backend.scene.create"; payload: BackendSceneCreatePayload }
  | { kind: "backend.scene.update"; payload: BackendSceneUpdatePayload }
  | { kind: "backend.token.create"; payload: BackendTokenCreatePayload }
  | { kind: "backend.wall.create"; payload: BackendWallCreatePayload }
  | { kind: "backend.light.create"; payload: BackendLightCreatePayload }
  | { kind: "backend.data.upload"; payload: BackendDataUploadPayload };

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
    /**
     * V2 Phase 3 task decomposition. Present when the backend's
     * classifier decomposed a compound request into an ordered list
     * of atomic sub-tasks. Relay iterates this queue: fire task[0] as
     * a fresh /napoleon query, shift the queue, repeat. Each task is
     * its own classifier + exec-loop pass with its own summary chat.
     * Absent / empty = no more tasks, relay stops. Hard-capped at
     * MAX_TASKS entries by the backend.
     */
    taskQueue?: readonly string[];
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

// ── World save forwarding (Phase B.4) ─────────────────────────────────

/**
 * Shape of the follow-up command embedded in a backend.data.upload — widened
 * to carry any backend.* kind the backend might synthesize. The relay just
 * forwards it, doesn't interpret.
 */
export interface BackendDataUploadPayload {
  readonly correlationId: string | null;
  readonly signedUrl: string;
  readonly targetPath: string;
  readonly followUp?: {
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
  };
}

/**
 * Request shape for POST /my/foundry/world-save. The relay fills worldId,
 * sessionId, and identityId from authenticated connection state — the
 * module only supplies what identifies the Barn file and the Foundry
 * target.
 */
export interface WorldSaveRequest {
  readonly barnPath: string;
  readonly category: string;
  readonly slug: string;
  readonly targetType: string;
  readonly targetAction: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface WorldSaveResponse {
  readonly commands: ReadonlyArray<{
    readonly kind: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }>;
}

/**
 * Forward a world-save request to the backend. Reuses the relay's service
 * token (same auth as /my/foundry/query). Throws on any failure so the
 * server-side handler can surface a protocol `error` to the client.
 */
export async function forwardWorldSaveToBackend(
  connection: ConnectionState,
  request: WorldSaveRequest,
  sessionId: string,
  messageId: string,
  config: Config,
  log: Logger
): Promise<WorldSaveResponse> {
  if (!connection.identityId || !connection.worldId) {
    throw new Error(
      "connection state missing identityId/worldId — client.hello was not completed"
    );
  }

  if (!config.backendUrl) {
    throw new Error(
      "backend URL is not configured — cannot forward world-save request"
    );
  }

  // Derive the world-save URL from the query URL. `backendUrl` typically
  // points at `.../my/foundry/query`; the world-save endpoint is a
  // sibling at `.../my/foundry/world-save`. Simple path swap avoids a
  // new config knob.
  const worldSaveUrl = config.backendUrl.replace(/\/query$/, "/world-save");
  if (worldSaveUrl === config.backendUrl) {
    throw new Error(
      `cannot derive world-save URL: backendUrl does not end with /query (got "${config.backendUrl}")`
    );
  }

  const body = {
    worldId: connection.worldId,
    sessionId,
    identityId: connection.identityId,
    barnPath: request.barnPath,
    category: request.category,
    slug: request.slug,
    targetType: request.targetType,
    targetAction: request.targetAction,
    params: request.params ?? {},
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(worldSaveUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.backendToken}`,
        "X-Correlation-Id": messageId,
        "X-Relay-Version": RELAY_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown fetch error";
    throw new Error(`world-save backend unreachable: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(
      `world-save backend HTTP ${response.status} in ${durationMs}ms: ${text.slice(0, 200)}`
    );
  }

  const parsed = (await response.json()) as WorldSaveResponse;
  log.debug(
    {
      messageId,
      commandCount: parsed.commands.length,
      durationMs,
    },
    "world-save backend responded"
  );
  return parsed;
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
