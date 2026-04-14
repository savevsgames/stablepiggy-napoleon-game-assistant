/**
 * WebSocket client for the StablePiggy Napoleon Game Assistant relay.
 *
 * The module side of the protocol. Opens a WebSocket to the configured
 * relay endpoint, sends `client.hello` with the auth token from the
 * module settings, processes inbound protocol messages, and exposes an
 * outbound `sendQuery` method for the chat command integration that
 * lands in M5.
 *
 * ## Lifecycle
 *
 * The client is constructed once in the `ready` hook (GM-only — players
 * don't connect) and `connect()` is called. The client tracks its own
 * connection status via an internal state enum:
 *
 *   - "disconnected" — initial state and terminal state after shutdown()
 *   - "connecting"   — waiting for the WebSocket to open
 *   - "handshaking"  — WebSocket open, waiting for relay.welcome
 *   - "connected"    — handshake complete, sending queries and pings
 *   - "reconnecting" — the socket died, waiting on the backoff timer
 *
 * ## Reconnect behavior
 *
 * On any unexpected close (not triggered by shutdown), the client waits
 * via exponential backoff and retries: 1s, 2s, 4s, 8s, 16s, then capped
 * at 30s. A small amount of jitter is added on each attempt to prevent
 * thundering-herd reconnects when the relay comes back after a
 * maintenance window. The backoff resets to 1s after a successful
 * handshake.
 *
 * ## Ping loop
 *
 * Once the handshake completes, the client sends a `ping` message every
 * 30 seconds and expects a matching `pong` back. The relay already
 * handles ping/pong from M2, so this just exercises the keepalive path.
 * If a pong doesn't arrive within the ping interval, the client assumes
 * the connection is dead and closes it (which triggers the normal
 * reconnect path).
 *
 * ## Inbound message dispatch
 *
 * Valid `relay.welcome` completes the handshake. `pong` is tracked for
 * the ping loop. `backend.chat.create` (M4) calls Foundry's
 * `ChatMessage.create()` to render the message in the world chat log.
 * `backend.actor.create` / `backend.journal.create` are still stubs —
 * full handlers land in M7 alongside the pf2e NPC schema validation.
 * `error` messages from the relay are logged at warn level. Anything
 * else is logged as unexpected.
 *
 * ## Whisper target mapping (M4)
 *
 * The backend puts the GM's StablePiggy identity id in
 * `backend.chat.create.whisperTo` because that's the only identifier
 * the relay/backend side knows about. Foundry's `ChatMessage.create()`
 * `whisper` field expects Foundry **user** ids, which live only on the
 * client. The `chat.create` handler remaps any whisperTo entry that
 * isn't a known Foundry user id to the current GM's `game.user.id`.
 * In Tier 1 this is always the same user (GM-only connection), but
 * the heuristic is written to be robust to Tier 2 multi-user
 * scenarios — unknown ids funnel to the current user rather than
 * being silently dropped.
 *
 * ## Out of scope for M4
 *
 *   - `/napoleon` chat command (M5 adds this in chat-command.ts)
 *   - "Napoleon is thinking..." placeholder rendering (M5)
 *   - Correlation id tracking for in-flight queries (M4/M5 — tracked
 *     via the correlationId field on the payload, but M4 doesn't
 *     dedupe or replace placeholders yet)
 *   - Calling Actor.create / JournalEntry.create on inbound commands (M7)
 *   - Test Connection button in the settings panel (M7)
 *
 * Typed against Foundry VTT v13.351. The `ChatMessage`, `game.users`,
 * and `CONST` declarations at the bottom of this file cover only what
 * the chat.create handler touches — extend in place for new Foundry
 * calls in M5/M7 per docs/foundry-conventions.md §2.
 */

import {
  PROTOCOL_VERSION,
  makeMessage,
  validateMessage,
  ProtocolError,
  type ProtocolMessage,
  type ClientHelloPayload,
  type ClientQueryPayload,
  type BackendChatCreatePayload,
} from "@stablepiggy-napoleon/protocol";

import { info, warn, error as logError, debug } from "./log.js";
import { getAuthToken, getRelayEndpoint } from "./settings.js";

// ── Foundry globals used by the chat.create handler ────────────────────
// Typed against Foundry VTT v13.351. Kept minimal per
// docs/foundry-conventions.md §2 — extend in place as more Foundry API
// calls land in future milestones.

/**
 * Minimal subset of Foundry's ChatMessage data we actually populate.
 * `CONST.CHAT_MESSAGE_STYLES` is a runtime enum that maps our protocol
 * chat kinds to Foundry's internal type ids (OOC, IC, EMOTE, WHISPER).
 * In v13 the values are 0, 1, 2, 4 respectively.
 */
interface FoundryChatMessageData {
  content: string;
  style: number;
  speaker?: { alias?: string; actor?: string };
  whisper?: readonly string[];
  flavor?: string;
  flags?: Record<string, Record<string, unknown>>;
}

declare const ChatMessage: {
  create(
    data: FoundryChatMessageData,
    options?: Record<string, unknown>
  ): Promise<unknown>;
};

declare const CONST: {
  CHAT_MESSAGE_STYLES: {
    OTHER: number;
    OOC: number;
    IC: number;
    EMOTE: number;
  };
};

declare const game: {
  users: {
    get(id: string): { id: string; isGM: boolean } | undefined;
  };
  user: { readonly id: string };
};

const MODULE_VERSION = "0.0.1";

/** Ping interval in ms. Matches the relay's default RELAY_PING_INTERVAL_SECONDS=30. */
const PING_INTERVAL_MS = 30_000;

/** Initial reconnect backoff in ms. Doubled on each failed attempt, capped. */
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "handshaking"
  | "connected"
  | "reconnecting";

export interface RelayClientContext {
  /** Foundry world ID — from `game.world.id`. */
  worldId: string;
  /** GM user ID — from `game.user.id`, used as gmUserId in hello. */
  gmUserId: string;
  /** True if this user is the primary/only GM — Tier 1 assumes true. */
  isPrimaryGM: boolean;
  /** Foundry core version string, e.g. "13.351". */
  foundryVersion: string;
  /** Game system id, e.g. "pf2e". */
  systemId: string;
  /** Game system version, e.g. "7.12.1". */
  systemVersion: string;
}

export class RelayClient {
  private readonly ctx: RelayClientContext;
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private shuttingDown = false;

  /** Current reconnect backoff — resets to BACKOFF_INITIAL_MS after successful handshake. */
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ping loop handle. Cleared on disconnect. */
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** ID of the most recent ping we sent — cleared when the matching pong arrives. */
  private pendingPingId: string | null = null;

  constructor(ctx: RelayClientContext) {
    this.ctx = ctx;
  }

  /**
   * Open a new connection to the configured relay. Called once from the
   * Foundry `ready` hook. If the settings are missing, logs a warning
   * and stays disconnected — the GM can set them in the settings panel
   * and reload the world.
   */
  connect(): void {
    if (this.shuttingDown) {
      debug("connect() called after shutdown — ignoring");
      return;
    }
    if (this.socket && this.status !== "disconnected" && this.status !== "reconnecting") {
      debug(`connect() called while status=${this.status} — ignoring`);
      return;
    }

    const endpoint = getRelayEndpoint();
    const authToken = getAuthToken();

    if (!endpoint) {
      warn(
        "relay endpoint not configured — open the module settings and set " +
          "'Relay endpoint' to your relay's WebSocket URL, then reload the world"
      );
      return;
    }
    if (!authToken) {
      warn(
        "auth token not configured — open the module settings and paste " +
          "your StablePiggy API key (or a shared secret), then reload the world"
      );
      return;
    }

    info(`connecting to ${endpoint}`);
    this.status = "connecting";

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
    } catch (err) {
      logError("failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;

    ws.addEventListener("open", () => this.onOpen(authToken));
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", (ev) => this.onClose(ev));
    ws.addEventListener("error", (ev) => {
      // The browser WebSocket `error` event carries no detail — all we
      // can do is log that it happened. The close event fires right
      // after with the real reason.
      logError("websocket error event", ev);
    });
  }

  /**
   * Tear down the connection permanently. Called from the page unload
   * path or from a future "Disconnect" settings button. After this the
   * client will not auto-reconnect even if told to.
   */
  shutdown(): void {
    this.shuttingDown = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1000, "client shutdown");
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.status = "disconnected";
  }

  /**
   * Send a `client.query` to the relay. Returns false if the client is
   * not in the connected state (the caller should surface an error to
   * the GM rather than queuing — offline queuing is a Tier 2 feature).
   *
   * M3 includes this method for completeness and smoke-test use, but
   * the full query path from the GM's `/napoleon` command lands in M5.
   */
  sendQuery(payload: ClientQueryPayload): boolean {
    if (this.status !== "connected" || !this.socket) {
      warn(`sendQuery called while status=${this.status} — dropping`);
      return false;
    }
    const msg = makeMessage("client.query", payload);
    this.socket.send(JSON.stringify(msg));
    debug(`→ client.query (sessionId=${payload.sessionId})`);
    return true;
  }

  /** Current connection status — useful for the future settings panel indicator. */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  // ── Lifecycle handlers ──────────────────────────────────────────────

  private onOpen(authToken: string): void {
    debug("websocket open — sending client.hello");
    this.status = "handshaking";

    const helloPayload: ClientHelloPayload = {
      protocolVersion: PROTOCOL_VERSION,
      authToken,
      worldId: this.ctx.worldId,
      gmUserId: this.ctx.gmUserId,
      isPrimaryGM: this.ctx.isPrimaryGM,
      moduleVersion: MODULE_VERSION,
      capabilities: {
        chatCreate: true,
        actorCreate: true,
        journalCreate: true,
        systemId: this.ctx.systemId,
        systemVersion: this.ctx.systemVersion,
        foundryVersion: this.ctx.foundryVersion,
      },
    };
    const hello = makeMessage("client.hello", helloPayload);
    this.socket?.send(JSON.stringify(hello));
  }

  private onMessage(ev: MessageEvent): void {
    let message: ProtocolMessage;
    try {
      const parsed: unknown = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      message = validateMessage(parsed);
    } catch (err) {
      const code = err instanceof ProtocolError ? err.code : "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      warn(`rejected malformed inbound message (code=${code}): ${msg}`);
      return;
    }

    debug(`← ${message.kind}`);

    switch (message.kind) {
      case "relay.welcome":
        this.onWelcome();
        break;
      case "pong":
        this.onPong(message.payload.pingId);
        break;
      case "backend.chat.create":
        void this.handleChatCreate(message.payload);
        break;
      case "backend.actor.create":
      case "backend.journal.create":
        // M7 stubs — log receipt and drop. Full handlers land in M7
        // alongside the pf2e NPC schema validation.
        info(`received ${message.kind} (handler lands in M7)`);
        break;
      case "error":
        warn(
          `relay sent error (code=${message.payload.code}): ${message.payload.message}`
        );
        break;
      case "ping":
        // Unusual — the relay typically doesn't initiate pings in Tier 1,
        // but we respond anyway for correctness if it ever does.
        if (this.socket) {
          const pong = makeMessage("pong", { pingId: message.id });
          this.socket.send(JSON.stringify(pong));
        }
        break;
      case "client.hello":
      case "client.query":
        warn(
          `received ${message.kind} from relay — this kind is client→relay only`
        );
        break;
      default: {
        // Exhaustiveness — adding a new kind to the protocol without a
        // case here is a TypeScript error.
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  private onClose(ev: CloseEvent): void {
    this.clearTimers();
    const wasConnected = this.status === "connected";
    this.status = this.shuttingDown ? "disconnected" : "reconnecting";
    this.socket = null;

    info(`websocket closed (code=${ev.code}, reason="${ev.reason}")`);

    if (this.shuttingDown) {
      return;
    }

    // A clean 1000 close is unusual unless the relay initiated it.
    // Either way the reconnect path handles it. A 1008 close typically
    // means auth failed — keep reconnecting so the GM can fix their
    // settings and the module picks up the new values after reload.
    // (We don't auto-pick-up new settings without a reload — Foundry's
    // requiresReload hint tells the GM to reload on change.)

    // Reset backoff only if we had a successful session before this close.
    if (wasConnected) {
      this.backoffMs = BACKOFF_INITIAL_MS;
    }
    this.scheduleReconnect();
  }

  private onWelcome(): void {
    this.status = "connected";
    this.backoffMs = BACKOFF_INITIAL_MS;
    info("relay handshake complete");
    this.startPingLoop();
  }

  private onPong(pingId: string): void {
    if (this.pendingPingId === pingId) {
      this.pendingPingId = null;
      debug(`pong received for ${pingId}`);
    } else {
      debug(`pong received for unexpected id ${pingId}`);
    }
  }

  // ── Foundry command handlers ────────────────────────────────────────

  /**
   * Render a `backend.chat.create` payload as a Foundry ChatMessage.
   *
   * In Foundry v13 there is no dedicated WHISPER style — a message is
   * a whisper iff its `whisper` array is non-empty. We map the
   * protocol's `type` field like this:
   *
   *   - "ic"      → style: IC,    whisper: []
   *   - "ooc"     → style: OOC,   whisper: []
   *   - "emote"   → style: EMOTE, whisper: []
   *   - "whisper" → style: OTHER, whisper: [remapped user ids]
   *
   * ## Whisper target remapping
   *
   * The backend populates `whisperTo` with StablePiggy identity ids
   * (UUIDs for api-key auth, `anon:<world>:<gm>` strings for shared-
   * secret auth). Neither is a valid Foundry user id. We remap each
   * entry: if `game.users.get(entry)` resolves to a real Foundry user
   * we keep it (future-proofing for Tier 2); otherwise we assume the
   * backend is trying to whisper to this GM and substitute
   * `game.user.id`.
   *
   * If the remap produces an empty array we drop the whisper flag
   * entirely and send the message as OTHER-visible rather than ending
   * up with a whisper-to-nobody (which in Foundry silently drops the
   * message).
   *
   * Correlation id tracking for replacing the M5 "Napoleon is
   * thinking..." placeholder lands in M5. M4 just renders the
   * message directly.
   */
  private async handleChatCreate(
    payload: BackendChatCreatePayload
  ): Promise<void> {
    const style = this.mapChatStyle(payload.type);
    const whisper =
      payload.type === "whisper"
        ? this.remapWhisperTargets(payload.whisperTo)
        : [];

    const data: FoundryChatMessageData = {
      content: payload.content,
      style,
      speaker: { ...(payload.speaker.alias ? { alias: payload.speaker.alias } : {}) },
      ...(whisper.length > 0 ? { whisper } : {}),
      ...(payload.flavor ? { flavor: payload.flavor } : {}),
      flags: {
        "stablepiggy-napoleon-game-assistant": {
          ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
        },
      },
    };

    try {
      await ChatMessage.create(data);
      info(
        `rendered backend.chat.create (type=${payload.type}, whisper=${whisper.length}, correlationId=${payload.correlationId ?? "none"})`
      );
    } catch (err) {
      logError(
        `ChatMessage.create failed for backend.chat.create: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  private mapChatStyle(type: BackendChatCreatePayload["type"]): number {
    switch (type) {
      case "ic":
        return CONST.CHAT_MESSAGE_STYLES.IC;
      case "ooc":
        return CONST.CHAT_MESSAGE_STYLES.OOC;
      case "emote":
        return CONST.CHAT_MESSAGE_STYLES.EMOTE;
      case "whisper":
        // Whispers have no dedicated style in v13; OTHER + non-empty
        // whisper array is the canonical representation.
        return CONST.CHAT_MESSAGE_STYLES.OTHER;
    }
  }

  private remapWhisperTargets(whisperTo: readonly string[]): string[] {
    const selfId = this.ctx.gmUserId;
    const result: string[] = [];
    let substituted = 0;

    for (const entry of whisperTo) {
      // If the entry is a real Foundry user id, keep it as-is. Tier 2
      // multi-user flows will rely on this branch once the backend
      // starts emitting real Foundry user ids for per-player whispers.
      if (game.users.get(entry)) {
        result.push(entry);
        continue;
      }
      // Otherwise assume the backend sent a StablePiggy identity id
      // meant for the authenticated GM. Substitute this user's id.
      if (!result.includes(selfId)) {
        result.push(selfId);
      }
      substituted++;
    }

    if (substituted > 0) {
      debug(
        `whisper remap: substituted ${substituted} non-foundry ids with self (${selfId})`
      );
    }
    return result;
  }

  // ── Timers ──────────────────────────────────────────────────────────

  private startPingLoop(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendPing(): void {
    if (this.status !== "connected" || !this.socket) return;

    // If the previous ping never got a pong, the connection is dead
    // from our perspective. Close it and let the reconnect path take
    // over — we prefer a clean reset over living with a half-open pipe.
    if (this.pendingPingId !== null) {
      warn("previous ping got no pong — forcing reconnect");
      try {
        this.socket.close(4000, "ping timeout");
      } catch {
        // ignore
      }
      return;
    }

    const ping = makeMessage("ping", {});
    this.pendingPingId = ping.id;
    this.socket.send(JSON.stringify(ping));
    debug(`→ ping (${ping.id})`);
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    // Jitter in ±25% of the current backoff — keeps multiple clients
    // (or rapid-retrying single clients) from hammering the relay in
    // lockstep after a maintenance window.
    const jitter = this.backoffMs * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.max(100, Math.round(this.backoffMs + jitter));

    info(`reconnecting in ${delay}ms (backoff=${this.backoffMs}ms)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingPingId = null;
  }
}
