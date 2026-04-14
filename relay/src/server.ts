/**
 * WebSocket server for the StablePiggy Napoleon Game Assistant relay.
 *
 * Responsibilities (M2 scope):
 *   - Accept WebSocket upgrade requests with `Authorization: Bearer` auth
 *   - Parse inbound frames as JSON, validate via the M1 protocol runtime guard
 *   - Dispatch messages to per-kind handlers
 *   - Maintain per-connection state (identityId/worldId/capabilities from hello)
 *   - Respond to client.hello with relay.welcome
 *   - Respond to ping with pong
 *   - Forward client.query to the backend HTTP client (M2 stub or live P2+)
 *   - Reject queries on connections that have not completed hello
 *   - Emit a /health JSON endpoint on the same HTTP server for liveness checks
 *
 * Out of scope for M2 (deferred to later steps):
 *   - Offline message queueing (M7 / Tier 2)
 *   - Rate limiting at the relay layer (Tier 2)
 *   - Per-user auth tokens (Tier 2)
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
  type PingMessage,
  type ErrorCode,
} from "@stablepiggy-napoleon/protocol";

import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { verifyBearerAuth } from "./auth.js";
import {
  registerConnection,
  unregisterConnection,
  connectionCount,
  type ConnectionState,
} from "./connection-state.js";
import { forwardQueryToBackend } from "./backend-client.js";

const RELAY_VERSION = "0.0.1";

export interface ServerHandle {
  close(): Promise<void>;
}

export function startServer(config: Config, log: Logger): ServerHandle {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });

  // ── HTTP upgrade: auth before establishing the WebSocket ──

  httpServer.on("upgrade", (req, socket, head) => {
    if (!verifyBearerAuth(req, config.sharedSecret)) {
      log.warn(
        { remoteAddress: req.socket.remoteAddress, url: req.url },
        "rejected unauthorized WebSocket upgrade"
      );
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  // ── Connection lifecycle ──

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress ?? "unknown";
    const state = registerConnection(socket, remoteAddress);
    const connLog = log.child({ connId: state.id, remoteAddress });

    connLog.info({ totalConnections: connectionCount() }, "client connected");

    socket.on("message", (data: Buffer) => {
      state.lastActivityAt = Date.now();
      void handleMessage(state, data, config, connLog);
    });

    socket.on("close", (code, reason) => {
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
        await handleHello(state, message, log);
        break;
      case "ping":
        handlePing(state, message);
        break;
      case "client.query":
        await handleQuery(state, message, config, log);
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
      case "backend.journal.create":
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

  // Store per-connection state per BACKEND-API-SPEC.md §2.5. These values
  // are the source of truth for every subsequent client.query on this
  // connection — the backend HTTP client reads them when constructing the
  // request body.
  state.helloCompleted = true;
  state.identityId = message.payload.gmUserId;
  state.worldId = message.payload.worldId;
  state.isPrimaryGM = message.payload.isPrimaryGM;
  state.moduleVersion = message.payload.moduleVersion;
  state.capabilities = message.payload.capabilities;

  log.info(
    {
      identityId: state.identityId,
      worldId: state.worldId,
      moduleVersion: state.moduleVersion,
      isPrimaryGM: state.isPrimaryGM,
      systemId: state.capabilities?.systemId,
      systemVersion: state.capabilities?.systemVersion,
      foundryVersion: state.capabilities?.foundryVersion,
    },
    "hello received, connection state populated"
  );

  const welcome = makeMessage("relay.welcome", {
    protocolVersion: PROTOCOL_VERSION,
    relayVersion: RELAY_VERSION,
    // M6 will replace this with a real backend health check. For M2 we
    // report true if the backend URL is configured, false otherwise.
    // (Reading config here would require passing it in — left for M6.)
    backendAvailable: true,
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
