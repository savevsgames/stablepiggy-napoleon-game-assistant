/**
 * WebSocket server for the StablePiggy Napoleon Game Assistant relay.
 *
 * Responsibilities (M2.1 scope):
 *   - Accept all WebSocket upgrade requests without auth (browsers cannot
 *     set custom headers on the upgrade, so auth moved into the protocol
 *     message layer — see auth.ts for the rationale)
 *   - Start a 2-second grace timer on every new connection; close with
 *     code 1008 if a valid hello has not arrived by then
 *   - Parse inbound frames as JSON, validate via the M1 protocol runtime guard
 *   - Dispatch messages to per-kind handlers
 *   - In the hello handler, verify `authToken` via one of two paths:
 *       * tokens starting with `dv-`: call the backend identity endpoint
 *         to resolve the real StablePiggy identity ID
 *       * any other non-empty string: compare against `RELAY_SHARED_SECRET`
 *         in constant time and synthesize `anon:<worldId>:<gmUserId>`
 *   - Reject (close 1008) on: malformed hello, auth token verification
 *     failure, API-key resolution failure, or `RELAY_REQUIRE_API_KEY=true`
 *     combined with a non-dv token
 *   - Maintain per-connection state (identityId/worldId/capabilities/authMode)
 *   - Respond to client.hello with relay.welcome on success
 *   - Respond to ping with pong
 *   - Forward client.query to the backend HTTP client (stub or live)
 *   - Reject queries on connections that have not completed hello
 *   - Emit a /health JSON endpoint on the same HTTP server for liveness checks
 *
 * Out of scope for M2.1 (deferred to later steps):
 *   - Offline message queueing (M7 / Tier 2)
 *   - Rate limiting at the relay layer (Tier 2)
 *   - Per-user issued session tokens (Tier 2)
 *   - Server-initiated pings (application-level keepalive, currently
 *     client-initiated only)
 *   - Reconnection state recovery (Tier 2)
 */

import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  validateMessage,
  makeMessage,
  ProtocolError,
  type ProtocolMessage,
  type ClientHelloMessage,
  type ClientQueryMessage,
  type ClientSessionEventMessage,
  type PingMessage,
  type ErrorCode,
} from "@stablepiggy-napoleon/protocol";

import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { verifyHelloToken, looksLikeApiKey } from "./auth.js";
import {
  registerConnection,
  unregisterConnection,
  connectionCount,
  type ConnectionState,
} from "./connection-state.js";
import {
  forwardQueryToBackend,
  resolveIdentityFromApiKey,
} from "./backend-client.js";
import {
  pushEvent,
  flushOnDisconnect,
  cleanupBuffer,
} from "./session-buffer.js";

const RELAY_VERSION = "0.0.1";

/**
 * How long a pending connection has to send a valid client.hello before
 * the relay closes it with 1008. Deliberately short — the GM's client
 * will normally send hello within the first millisecond after the
 * WebSocket opens, so 2 seconds is generous. Attackers get no useful
 * work out of a connection in this window.
 */
const HELLO_GRACE_MS = 2000;

export interface ServerHandle {
  close(): Promise<void>;
}

export function startServer(config: Config, log: Logger): ServerHandle {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  // ── HTTP upgrade: accept unconditionally ──
  //
  // Auth used to live here as a Bearer-header check, but browser WebSocket
  // clients cannot set custom headers on the upgrade request. The relay
  // now accepts every upgrade and enforces auth via the inbound
  // client.hello message (see handleHello). A grace timer on each
  // connection prevents clients from sitting in the pending state forever.

  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  // ── Connection lifecycle ──

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    const state = registerConnection(socket, remoteAddress);
    const connLog = log.child({ connId: state.id, remoteAddress });

    // Start the pending-auth grace timer. If hello doesn't land in time,
    // close with 1008. Successful hello clears this timer inside the
    // handleHello path.
    state.helloGraceTimer = setTimeout(() => {
      if (!state.helloCompleted) {
        connLog.warn(
          { graceMs: HELLO_GRACE_MS },
          "no client.hello received within grace window — closing"
        );
        try {
          state.socket.close(1008, "auth required");
        } catch {
          // socket may already be closing; ignore
        }
      }
    }, HELLO_GRACE_MS);

    connLog.info({ totalConnections: connectionCount() }, "client connected (pending auth)");

    socket.on("message", (data: Buffer) => {
      state.lastActivityAt = Date.now();
      void handleMessage(state, data, config, connLog);
    });

    socket.on("close", (code, reason) => {
      flushOnDisconnect(state.id, config, connLog);
      cleanupBuffer(state.id);
      unregisterConnection(state.id);
      connLog.info(
        {
          code,
          reason: reason.toString("utf8"),
          totalConnections: connectionCount(),
          helloCompleted: state.helloCompleted,
        },
        "client disconnected"
      );
    });

    socket.on("error", (err) => {
      connLog.error({ err: err.message }, "websocket error");
    });
  });

  // ── Non-upgrade HTTP routes: health check ──

  httpServer.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify({
        status: "ok",
        version: RELAY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        connections: connectionCount(),
        uptime: Math.round(process.uptime()),
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body).toString(),
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  // ── Start listening ──

  httpServer.listen(config.port, config.bindAddress, () => {
    log.info(
      {
        port: config.port,
        bindAddress: config.bindAddress,
        backendUrl: config.backendUrl || "(stub mode)",
        backendIdentityUrl: config.backendIdentityUrl || "(none)",
        sharedSecretMode: config.sharedSecret.length > 0 && !config.requireApiKey,
        requireApiKey: config.requireApiKey,
        version: RELAY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      "relay listening"
    );
  });

  return {
    close: async (): Promise<void> => {
      log.info("shutting down relay");
      wss.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

// ── Message dispatch ──

async function handleMessage(
  state: ConnectionState,
  data: Buffer,
  config: Config,
  log: Logger
): Promise<void> {
  let message: ProtocolMessage;
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    message = validateMessage(parsed);
  } catch (err) {
    const code: ErrorCode =
      err instanceof ProtocolError ? err.code : "validation_failed";
    const msg = err instanceof Error ? err.message : "invalid JSON";
    log.warn({ err: msg, code }, "rejected malformed message");
    sendError(state, code, msg);
    return;
  }

  log.debug({ kind: message.kind, id: message.id }, "received message");

  try {
    switch (message.kind) {
      case "client.hello":
        await handleHello(state, message, config, log);
        break;
      case "ping":
        handlePing(state, message);
        break;
      case "client.query":
        await handleQuery(state, message, config, log);
        break;
      case "client.session_event":
        handleSessionEvent(state, message, config, log);
        break;
      case "pong":
        // Clients sending pongs is rare in M2 (relay doesn't initiate pings
        // yet). Log and ignore.
        log.debug({ pingId: message.payload.pingId }, "received pong");
        break;
      case "error":
        log.warn(
          { errorCode: message.payload.code, errorMessage: message.payload.message },
          "client sent error message"
        );
        break;
      case "relay.welcome":
      case "backend.chat.create":
      case "backend.actor.create":
      case "backend.actor.update":
      case "backend.journal.create":
      case "backend.rolltable.create":
        // Server-to-client message kinds — rejecting if a client sends one
        // catches confused clients or replay attacks.
        sendError(
          state,
          "validation_failed",
          `kind ${message.kind} is server-to-client only and cannot be received from a client`,
          message.id
        );
        break;
      default: {
        // Exhaustiveness check — TypeScript errors here if a new kind is
        // added to the protocol without a case in this switch.
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown handler error";
    log.error({ err: msg, kind: message.kind }, "handler threw");
    sendError(state, "internal_error", msg, message.id);
  }
}

// ── Per-kind handlers ──

async function handleHello(
  state: ConnectionState,
  message: ClientHelloMessage,
  config: Config,
  log: Logger
): Promise<void> {
  if (message.payload.protocolVersion !== PROTOCOL_VERSION) {
    log.warn(
      {
        clientVersion: message.payload.protocolVersion,
        relayVersion: PROTOCOL_VERSION,
      },
      "protocol version mismatch — closing connection"
    );
    sendError(
      state,
      "protocol_mismatch",
      `client speaks v${message.payload.protocolVersion}, relay speaks v${PROTOCOL_VERSION}`,
      message.id
    );
    state.socket.close(1008, "protocol_mismatch");
    return;
  }

  const { authToken, worldId, gmUserId, isPrimaryGM, moduleVersion, capabilities } =
    message.payload;

  // ── Dual-mode auth: API key or shared secret ──
  //
  // The token prefix discriminates. `dv-` tokens are StablePiggy API
  // keys and get resolved via the backend identity endpoint, unlocking
  // vault/memory/metering for the real identity. Anything else is
  // treated as a shared secret and matched against config.sharedSecret
  // in constant time, producing a synthetic anonymous identity.
  //
  // Hosted relay deployments can set RELAY_REQUIRE_API_KEY=true to
  // force the API-key path and reject shared-secret auth at hello time.

  let resolvedIdentityId: string;
  let authMode: "apikey" | "anonymous";

  if (looksLikeApiKey(authToken)) {
    // API-key path: ask the backend who owns this key.
    try {
      const resolved = await resolveIdentityFromApiKey(authToken, config, log);
      resolvedIdentityId = resolved.identityId;
      authMode = "apikey";
      log.info(
        { identityId: resolvedIdentityId, role: resolved.role, orgId: resolved.orgId },
        "api-key auth succeeded"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown identity error";
      log.warn({ err: msg }, "api-key auth failed — closing connection");
      sendError(state, "unauthorized", `api key rejected: ${msg}`, message.id);
      state.socket.close(1008, "unauthorized");
      return;
    }
  } else {
    // Shared-secret path: reject outright if the operator has locked
    // this relay to API keys only, or if no secret is configured.
    if (config.requireApiKey) {
      log.warn("shared-secret auth attempted on api-key-only relay — closing");
      sendError(
        state,
        "unauthorized",
        "this relay requires a StablePiggy API key (tokens must start with dv-)",
        message.id
      );
      state.socket.close(1008, "unauthorized");
      return;
    }
    if (!verifyHelloToken(authToken, config.sharedSecret)) {
      log.warn("shared-secret auth failed — closing");
      sendError(state, "unauthorized", "invalid shared secret", message.id);
      state.socket.close(1008, "unauthorized");
      return;
    }
    resolvedIdentityId = `anon:${worldId}:${gmUserId}`;
    authMode = "anonymous";
    log.info({ identityId: resolvedIdentityId }, "shared-secret auth succeeded");
  }

  // Auth cleared — clear the grace timer and populate the full
  // connection state. From here on this connection is authenticated
  // and can accept queries.
  if (state.helloGraceTimer) {
    clearTimeout(state.helloGraceTimer);
    state.helloGraceTimer = undefined;
  }

  state.helloCompleted = true;
  state.authMode = authMode;
  state.identityId = resolvedIdentityId;
  state.worldId = worldId;
  state.isPrimaryGM = isPrimaryGM;
  state.moduleVersion = moduleVersion;
  state.capabilities = capabilities;

  log.info(
    {
      identityId: state.identityId,
      authMode: state.authMode,
      worldId: state.worldId,
      moduleVersion: state.moduleVersion,
      isPrimaryGM: state.isPrimaryGM,
      systemId: state.capabilities?.systemId,
      systemVersion: state.capabilities?.systemVersion,
      foundryVersion: state.capabilities?.foundryVersion,
    },
    "hello received, connection authenticated"
  );

  const welcome = makeMessage("relay.welcome", {
    protocolVersion: PROTOCOL_VERSION,
    relayVersion: RELAY_VERSION,
    // Report true if the backend URL is configured, false otherwise.
    // A future milestone can replace this with a real health check.
    backendAvailable: config.backendUrl.length > 0,
    serverTime: Date.now(),
  });
  sendMessage(state, welcome);
}

function handlePing(state: ConnectionState, message: PingMessage): void {
  const pong = makeMessage("pong", { pingId: message.id });
  sendMessage(state, pong);
}

async function handleQuery(
  state: ConnectionState,
  message: ClientQueryMessage,
  config: Config,
  log: Logger
): Promise<void> {
  // Gate: hello must be completed before queries are accepted. Per
  // BACKEND-API-SPEC.md §2.5, the backend cannot process a query without
  // knowing which identity to scope it to.
  if (!state.helloCompleted) {
    log.warn({ queryId: message.id }, "rejected query on hello-less connection");
    sendError(
      state,
      "validation_failed",
      "client.hello required before client.query",
      message.id
    );
    return;
  }

  try {
    const response = await forwardQueryToBackend(
      state,
      message.payload,
      message.id,
      config,
      log
    );

    // Wrap each backend command as a full protocol message (adds envelope)
    // and send to the client in order.
    for (const command of response.commands) {
      const wrapped = makeMessage(command.kind, command.payload as never);
      sendMessage(state, wrapped);
    }

    log.info(
      {
        queryId: message.id,
        commandCount: response.commands.length,
        durationMs: response.meta.durationMs,
        model: response.meta.modelUsed,
        tokens: response.meta.tokensUsed,
      },
      "query processed"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown backend error";
    log.error({ err: msg, queryId: message.id }, "query forwarding failed");
    sendError(
      state,
      "backend_unreachable",
      `backend call failed: ${msg}`,
      message.id
    );
  }
}

function handleSessionEvent(
  state: ConnectionState,
  message: ClientSessionEventMessage,
  config: Config,
  log: Logger
): void {
  if (!state.helloCompleted || !state.identityId || !state.worldId) {
    sendError(
      state,
      "validation_failed",
      "client.hello required before client.session_event",
      message.id
    );
    return;
  }

  pushEvent(state.id, state.identityId, state.worldId, message.payload, config, log);
  log.debug(
    { eventType: message.payload.eventType, speaker: message.payload.speaker },
    "session event buffered"
  );
}

// ── Send helpers ──

function sendMessage(state: ConnectionState, message: ProtocolMessage): void {
  if (state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify(message));
}

function sendError(
  state: ConnectionState,
  code: ErrorCode,
  msg: string,
  correlationId?: string
): void {
  const errorMsg = makeMessage("error", {
    code,
    message: msg,
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
  sendMessage(state, errorMsg);
}
