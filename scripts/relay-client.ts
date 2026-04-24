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
 * `backend.actor.create` (M7-A) validates the payload structurally,
 * calls `Actor.create()` to drop the generated NPC into the sidebar,
 * whispers a @UUID confirmation (replacing the pending "Napoleon is
 * thinking…" placeholder in place), and auto-opens the new actor's
 * sheet unless combat is active. `backend.journal.create` validates
 * the payload, calls `JournalEntry.create()`, whispers a @UUID
 * confirmation, and auto-opens the journal sheet. `error` messages from the relay are
 * logged at warn level. Anything else is logged as unexpected.
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
 *   - ~~Calling Actor.create on inbound actor.create commands~~ — shipped M7-A
 *   - ~~Calling JournalEntry.create on inbound journal.create commands~~ — shipped Phase 2
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
  type SessionEventPayload,
  type BackendChatCreatePayload,
  type BackendActorCreatePayload,
  type BackendActorUpdatePayload,
  type BackendJournalCreatePayload,
  type BackendRollTableCreatePayload,
  type BackendSceneCreatePayload,
  type BackendSceneUpdatePayload,
  type BackendTokenCreatePayload,
  type BackendWallCreatePayload,
  type BackendLightCreatePayload,
  type BackendDataUploadPayload,
  type ClientDataUploadAckPayload,
} from "@stablepiggy-napoleon/protocol";

import { info, warn, error as logError, debug } from "./log.js";
import { getAuthToken, getRelayEndpoint } from "./settings.js";
import { uploadToWorld } from "./world-files.js";

// ── Foundry globals used by the chat.create handler ────────────────────
// Typed against Foundry VTT v13.351. Kept minimal per
// docs/foundry-conventions.md §2 — extend in place as more Foundry API
// calls land in future milestones.

/**
 * Minimal subset of Foundry's ChatMessage data we actually populate.
 * In v13 there is no dedicated WHISPER style — a message is a whisper
 * iff its `whisper` array is non-empty. The numeric ids in
 * `CONST.CHAT_MESSAGE_STYLES` are the enum values for OTHER/OOC/IC/
 * EMOTE (0-3).
 */
interface FoundryChatMessageData {
  content: string;
  style: number;
  speaker?: { alias?: string; actor?: string };
  whisper?: readonly string[];
  flavor?: string;
  flags?: Record<string, Record<string, unknown>>;
}

interface FoundryChatMessage {
  readonly id: string;
  update(
    data: Partial<FoundryChatMessageData>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

declare const ChatMessage: {
  create(
    data: FoundryChatMessageData,
    options?: Record<string, unknown>
  ): Promise<FoundryChatMessage | undefined>;
};

declare const CONST: {
  CHAT_MESSAGE_STYLES: {
    OTHER: number;
    OOC: number;
    IC: number;
    EMOTE: number;
  };
};

/**
 * Minimal subset of Foundry's Actor document we touch in the actor.create
 * handler. `Actor.create()` in Foundry v13 is a static method on the
 * document class that returns `Promise<Actor | undefined>`; the undefined
 * path happens when a pre-create hook rejects or the core validator
 * fails, so we must handle it explicitly before building a @UUID link
 * against the resulting id.
 */
interface FoundryActor {
  readonly id: string;
  readonly name?: string;
  readonly sheet: { render(force: boolean): void };
  update(data: Record<string, unknown>): Promise<unknown>;
  /** Prototype token document used as the template for new placed tokens. */
  readonly prototypeToken: {
    toObject(): Record<string, unknown>;
  };
}

declare const Actor: {
  create(
    data: Record<string, unknown>,
    options?: { folder?: string }
  ): Promise<FoundryActor | undefined>;
};

interface FoundryJournalEntry {
  readonly id: string;
  readonly name?: string;
  readonly sheet: { render(force: boolean): void };
}

declare const JournalEntry: {
  create(
    data: Record<string, unknown>,
    options?: { folder?: string }
  ): Promise<FoundryJournalEntry | undefined>;
};

declare const RollTable: {
  create(
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<{ id: string; name?: string } | undefined>;
};

/**
 * Minimal subset of Foundry's Scene document we use in scene.create.
 * `view()` activates the scene on the canvas — the GM sees the map
 * immediately without having to click it in the nav bar.
 */
interface FoundryScene {
  readonly id: string;
  readonly name?: string;
  readonly grid: { readonly size: number };
  view(): Promise<unknown>;
  createEmbeddedDocuments(
    type: "Token" | "Wall" | "AmbientLight",
    data: ReadonlyArray<Record<string, unknown>>,
    options?: Record<string, unknown>
  ): Promise<ReadonlyArray<{ readonly id: string }>>;
  update(data: Record<string, unknown>, options?: Record<string, unknown>): Promise<FoundryScene>;
}

declare const Scene: {
  create(
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<FoundryScene | undefined>;
};

declare const game: {
  users: {
    get(id: string): { id: string; isGM: boolean } | undefined;
  };
  messages: {
    get(id: string): FoundryChatMessage | undefined;
  };
  actors: {
    getName(name: string): FoundryActor | undefined;
  };
  scenes: {
    readonly active?: FoundryScene | null;
    get(id: string): FoundryScene | undefined;
    getName(name: string): FoundryScene | undefined;
  };
  user: { readonly id: string };
  /**
   * Currently-active Combat, or null/undefined if none. We only read
   * `combat?.active` from the actor.create handler to decide whether
   * to auto-open the newly-created NPC sheet — GMs mid-fight typically
   * want the actor in the sidebar for later without a popup stealing
   * focus.
   */
  combat?: { active?: boolean } | null;
};

/**
 * Escape a string for safe interpolation into a chat-message HTML body.
 * Used by the actor error-whisper path where exception messages (from
 * Actor.create failures or structural-validation rejects) may contain
 * arbitrary user text. NPC display names in the success path do NOT
 * flow through this helper because the success whisper uses the bare
 * `@UUID[Actor.<id>]` form — Foundry's enricher fetches the name from
 * the document itself, so no user text ever lands in the HTML string.
 *
 * Duplicated from `chat-command.ts::escapeHtml` rather than imported
 * to avoid coupling these two files; the function is seven lines and
 * has no dependencies.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

  /**
   * Outstanding placeholder chat messages keyed by the correlationId
   * the backend will echo back on the matching `backend.chat.create`.
   * When a chat.create arrives with a known correlationId, the handler
   * calls `message.update()` on the stored Foundry message id instead
   * of creating a new chat entry — so the "Napoleon is thinking…"
   * placeholder from chat-command.ts gets replaced in place. See
   * chat-command.ts and the `handleChatCreate` method below.
   */
  private readonly pendingPlaceholders = new Map<string, string>();

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
   * Send a `client.query` to the relay. Returns the generated message
   * id on success, or `null` if the client was not in the connected
   * state and the message had to be dropped. The caller uses the
   * returned id to register a placeholder under the same key — the
   * backend echoes this id back as `correlationId` on its response,
   * which is how M5's placeholder-replacement flow routes the inbound
   * `backend.chat.create` to the right pending chat message.
   */
  sendQuery(payload: ClientQueryPayload): string | null {
    if (this.status !== "connected" || !this.socket) {
      warn(`sendQuery called while status=${this.status} — dropping`);
      return null;
    }
    const msg = makeMessage("client.query", payload);
    this.socket.send(JSON.stringify(msg));
    debug(`→ client.query (sessionId=${payload.sessionId}, id=${msg.id})`);
    return msg.id;
  }

  /**
   * Send a `client.world_save_request` to the relay. The relay forwards
   * to the backend's /world-save endpoint, receives a list of commands
   * (typically a single backend.data.upload with an optional follow-up),
   * and pushes them back over the WebSocket. From this caller's
   * perspective: send-and-forget; the normal handler dispatch picks up
   * the inbound commands.
   *
   * Returns the message id on success, null if not connected.
   */
  sendWorldSaveRequest(
    payload: Omit<import("@stablepiggy-napoleon/protocol").ClientWorldSaveRequestPayload, "sessionId"> & { sessionId?: string }
  ): string | null {
    if (this.status !== "connected" || !this.socket) {
      warn(`sendWorldSaveRequest called while status=${this.status} — dropping`);
      return null;
    }
    // Compute the session ID the same way chat-command.ts does. The caller
    // can override by passing `sessionId`, but the default is the stable
    // `napoleon-<worldId>-<gmUserId>` value the module uses everywhere.
    const sessionId =
      payload.sessionId ?? `napoleon-${this.ctx.worldId}-${this.ctx.gmUserId}`;
    const msg = makeMessage("client.world_save_request", { ...payload, sessionId });
    this.socket.send(JSON.stringify(msg));
    debug(`→ client.world_save_request (slug=${payload.slug}, target=${payload.targetType})`);
    return msg.id;
  }

  /**
   * Send a `client.session_event` to the relay. Fire-and-forget — session
   * events are buffered relay-side and flushed in batches. Returns the
   * message id on success, null if not connected.
   */
  sendSessionEvent(payload: SessionEventPayload): string | null {
    if (this.status !== "connected" || !this.socket) {
      return null;
    }
    const msg = makeMessage("client.session_event", payload);
    this.socket.send(JSON.stringify(msg));
    debug(`→ client.session_event (type=${payload.eventType}, speaker=${payload.speaker})`);
    return msg.id;
  }

  /**
   * Register a Foundry chat message id as the placeholder for a
   * pending query. When the matching `backend.chat.create` arrives
   * (keyed by `correlationId === queryId`), `handleChatCreate` will
   * call `message.update()` on this id instead of creating a new
   * chat entry. Called by chat-command.ts right after `sendQuery`.
   */
  registerPlaceholder(correlationId: string, foundryMessageId: string): void {
    this.pendingPlaceholders.set(correlationId, foundryMessageId);
  }

  /**
   * Remove a placeholder registration. Called by chat-command.ts's
   * timeout path when it wants to claim the placeholder and replace
   * its content with an error, preventing a race with a late-
   * arriving real response.
   */
  unregisterPlaceholder(correlationId: string): void {
    this.pendingPlaceholders.delete(correlationId);
  }

  /** True if a placeholder is still registered for this correlationId. */
  hasPlaceholder(correlationId: string): boolean {
    return this.pendingPlaceholders.has(correlationId);
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
        actorUpdate: true,
        journalCreate: true,
        rolltableCreate: true,
        sceneCreate: true,
        sceneUpdate: true,
        tokenCreate: true,
        wallCreate: true,
        lightCreate: true,
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
        void this.handleActorCreate(message.payload);
        break;
      case "backend.actor.update":
        void this.handleActorUpdate(message.payload);
        break;
      case "backend.journal.create":
        void this.handleJournalCreate(message.payload);
        break;
      case "backend.rolltable.create":
        void this.handleRollTableCreate(message.payload);
        break;
      case "backend.scene.create":
        void this.handleSceneCreate(message.payload);
        break;
      case "backend.scene.update":
        void this.handleSceneUpdate(message.payload);
        break;
      case "backend.token.create":
        void this.handleTokenCreate(message.payload);
        break;
      case "backend.wall.create":
        void this.handleWallCreate(message.payload);
        break;
      case "backend.light.create":
        void this.handleLightCreate(message.payload);
        break;
      case "backend.data.upload":
        void this.handleDataUpload(message.payload, message.id);
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
      case "client.session_event":
      case "client.data_upload_ack":
      case "client.world_save_request":
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

    // If this response carries a correlationId that matches a pending
    // placeholder registered by chat-command.ts, replace the
    // placeholder in place via ChatMessage.update() rather than
    // creating a new chat entry. This is the M5 "Napoleon is
    // thinking…" → real answer flip.
    if (payload.correlationId && this.pendingPlaceholders.has(payload.correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(payload.correlationId)!;
      this.pendingPlaceholders.delete(payload.correlationId);
      const placeholder = game.messages.get(placeholderId);
      if (placeholder) {
        try {
          await placeholder.update({
            content: payload.content,
            ...(payload.flavor ? { flavor: payload.flavor } : {}),
          });
          info(
            `replaced placeholder ${placeholderId} with response (correlationId=${payload.correlationId})`
          );
          return;
        } catch (err) {
          logError(
            `placeholder update failed, falling back to new message: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
          // fall through to ChatMessage.create so the GM still sees
          // the response even if the in-place update blew up
        }
      } else {
        debug(
          `placeholder ${placeholderId} no longer exists (deleted?) — creating a new chat message`
        );
      }
    }

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

  /**
   * Handle a `backend.actor.create` payload: structurally validate the
   * actor document, call Foundry's `Actor.create()` to drop it into the
   * Actors sidebar, whisper a confirmation to the GM with a @UUID link,
   * and auto-open the new actor's sheet unless combat is active.
   *
   * ## Validation
   *
   * The backend already validated the full pf2e NPC schema via ajv
   * before emitting this command. The module-side validation here is
   * intentionally lightweight — we only check the structural fields
   * that would make `Actor.create` throw or misbehave downstream
   * (presence of `name`, `type === "npc"`, `system` object). This is
   * defense in depth, not a re-implementation of schema validation.
   *
   * ## Nullable return handling
   *
   * `Actor.create()` in Foundry v13 returns `Promise<Actor | undefined>`.
   * The undefined path happens when a pre-create hook rejects or the
   * core document validator fails. We check `created?.id` explicitly
   * before building the @UUID link — a null id produces a broken link
   * and silent failure, which is worse than surfacing the problem in
   * a visible whisper.
   *
   * ## Feedback rendering
   *
   * On success and on every failure path, we render a whisper-to-self
   * (or replace the pending "Napoleon is thinking…" placeholder if the
   * query's correlationId matches one) so the GM always sees the
   * outcome. See `renderActorFeedback` for the placeholder-replacement
   * mechanics, which mirror `handleChatCreate`'s inline version.
   *
   * ## Auto-open sheet
   *
   * Quality-of-life: after a successful create, render the actor's
   * sheet so the GM can review the generated NPC without having to
   * find it in the sidebar. Gated on `!game.combat?.active` — a GM
   * mid-fight typically just wants the NPC in the sidebar for later,
   * not a popup stealing focus. Fails silently if `sheet.render`
   * throws; the actor IS created either way, and the sheet is a
   * convenience not a required step.
   */
  private async handleActorCreate(
    payload: BackendActorCreatePayload
  ): Promise<void> {
    // ── Lightweight structural validation ─────────────────────────
    // Defense in depth on top of the backend's ajv pass. We check only
    // the fields that would make Actor.create throw or produce a
    // malformed document; the full schema check already ran server-
    // side and any failure there would have prevented this command
    // from being emitted.
    const actor = payload.actor as Record<string, unknown> | undefined;
    if (!actor || typeof actor !== "object") {
      await this.renderActorFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon NPC generation failed: backend sent a null or non-object actor payload.</p>"
      );
      return;
    }
    const name = actor.name;
    if (typeof name !== "string" || name.length === 0) {
      await this.renderActorFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon NPC generation failed: backend actor payload is missing a name.</p>"
      );
      return;
    }
    if (actor.type !== "npc") {
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Napoleon NPC generation failed: actor type is "${escapeHtml(String(actor.type))}", expected "npc".</p>`
      );
      return;
    }
    if (!actor.system || typeof actor.system !== "object") {
      await this.renderActorFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon NPC generation failed: backend actor payload is missing its system block.</p>"
      );
      return;
    }

    // ── Actor.create with nullable return handling ────────────────
    let created: FoundryActor | undefined;
    try {
      const createOptions = payload.folderId
        ? { folder: payload.folderId }
        : undefined;
      created = await Actor.create(
        actor as Record<string, unknown>,
        createOptions
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(
        `Actor.create threw for backend.actor.create: ${msg}`,
        err
      );
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Napoleon NPC creation failed: Foundry rejected the actor (${escapeHtml(msg)}).</p>`
      );
      return;
    }

    if (!created || !created.id) {
      warn(
        `Actor.create returned no document for backend.actor.create (name=${name}, correlationId=${payload.correlationId ?? "none"}) — a pre-create hook or internal validator likely rejected it`
      );
      await this.renderActorFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon NPC creation returned no document — a Foundry pre-create hook or internal validator likely rejected it. Check the Foundry console for details.</p>"
      );
      return;
    }

    // ── Success feedback ──────────────────────────────────────────
    // Use the bare @UUID[Actor.<id>] form (no display override). Foundry's
    // enricher fetches the display name from the document itself at
    // render time, so no user-input text is spliced into the HTML body.
    const confirmContent = `<p>✓ Created @UUID[Actor.${created.id}]</p>`;
    await this.renderActorFeedback(payload.correlationId, confirmContent, {
      actorId: created.id,
    });

    info(
      `handleActorCreate: created NPC "${name}" id=${created.id} (correlationId=${payload.correlationId ?? "none"})`
    );

    // ── Quality-of-life: auto-open the sheet unless combat is active ──
    if (!game.combat?.active) {
      try {
        created.sheet.render(true);
      } catch (err) {
        debug(
          `sheet.render failed for actor ${created.id} — silent fail-through: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      debug(
        `combat active — skipping auto-open of actor sheet for ${created.id}`
      );
    }
  }

  /**
   * Handle a `backend.actor.update` payload: look up the actor by name
   * and apply partial updates. Primary use case: assigning a generated
   * portrait image to an NPC's img and prototypeToken.texture.src fields.
   */
  private async handleActorUpdate(
    payload: BackendActorUpdatePayload
  ): Promise<void> {
    const { actorName, updates } = payload;

    const actor = game.actors.getName(actorName);
    if (!actor) {
      warn(`handleActorUpdate: no actor found with name "${actorName}"`);
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Could not update actor "${escapeHtml(actorName)}" — not found in the Actors sidebar.</p>`
      );
      return;
    }

    try {
      await actor.update(updates as Record<string, unknown>);
      info(`handleActorUpdate: updated actor "${actorName}" (id=${actor.id}, fields: ${Object.keys(updates).join(", ")})`);

      await this.renderActorFeedback(
        payload.correlationId,
        `<p>✓ Updated @UUID[Actor.${actor.id}] — ${Object.keys(updates).join(", ")}</p>`,
        { actorId: actor.id }
      );

      // Re-render the sheet if it's open so the GM sees the portrait immediately
      try {
        actor.sheet.render(false);
      } catch {
        // silent — sheet may not be open
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Actor.update threw for "${actorName}": ${msg}`, err);
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Failed to update actor "${escapeHtml(actorName)}": ${escapeHtml(msg)}</p>`
      );
    }
  }

  /**
   * Render feedback text for an actor.create command. If the supplied
   * correlationId matches a pending "Napoleon is thinking…" placeholder
   * (tracked in `pendingPlaceholders` by chat-command.ts when the GM
   * fires a query), replace that placeholder via `ChatMessage.update()`.
   * Otherwise create a new whisper-to-self.
   *
   * Used by both the success path (confirmation whisper with @UUID link)
   * and every error path (structural validation failures, Actor.create
   * failures, nullable-return failures) in `handleActorCreate`.
   *
   * Intentionally local to the actor handler rather than shared with
   * `handleChatCreate`'s inline placeholder-replacement — refactoring
   * the chat handler to use this helper would be scope creep for
   * Phase 4. If a third command kind needs the same pattern in the
   * future, lift both into a shared helper at that time.
   */
  private async renderActorFeedback(
    correlationId: string | null,
    content: string,
    extraFlags?: Record<string, unknown>
  ): Promise<void> {
    // Placeholder replacement path — mirrors handleChatCreate.
    if (correlationId && this.pendingPlaceholders.has(correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(correlationId)!;
      this.pendingPlaceholders.delete(correlationId);
      const placeholder = game.messages.get(placeholderId);
      if (placeholder) {
        try {
          await placeholder.update({ content });
          debug(
            `renderActorFeedback: replaced placeholder ${placeholderId} (correlationId=${correlationId})`
          );
          return;
        } catch (err) {
          logError(
            `placeholder update failed for actor feedback, falling back to new whisper: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
          // fall through to ChatMessage.create below — the GM still
          // gets feedback even if the in-place update blew up
        }
      } else {
        debug(
          `placeholder ${placeholderId} no longer exists (deleted?) — creating new whisper`
        );
      }
    }

    // New whisper path — either no correlation id, or the placeholder
    // was never registered, or the update path failed through.
    try {
      await ChatMessage.create({
        content,
        style: CONST.CHAT_MESSAGE_STYLES.OTHER,
        whisper: [this.ctx.gmUserId],
        flags: {
          "stablepiggy-napoleon-game-assistant": {
            ...(correlationId ? { correlationId } : {}),
            ...(extraFlags ?? {}),
          },
        },
      });
    } catch (err) {
      logError(
        `ChatMessage.create failed for actor feedback whisper: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  private async handleJournalCreate(
    payload: BackendJournalCreatePayload
  ): Promise<void> {
    const name = payload.name;
    if (typeof name !== "string" || name.length === 0) {
      await this.renderJournalFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon journal creation failed: backend sent a payload with no name.</p>"
      );
      return;
    }

    if (!Array.isArray(payload.pages) || payload.pages.length === 0) {
      await this.renderJournalFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon journal creation failed: backend sent a payload with no pages.</p>"
      );
      return;
    }

    let created: FoundryJournalEntry | undefined;
    try {
      const createData: Record<string, unknown> = {
        name,
        pages: payload.pages.map((p) => ({
          name: p.name,
          type: p.type,
          text: { content: p.text.content, format: p.text.format },
        })),
      };
      const createOptions = payload.folderId
        ? { folder: payload.folderId }
        : undefined;
      created = await JournalEntry.create(createData, createOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(
        `JournalEntry.create threw for backend.journal.create: ${msg}`,
        err
      );
      await this.renderJournalFeedback(
        payload.correlationId,
        `<p>⚠️ Napoleon journal creation failed: Foundry rejected the entry (${escapeHtml(msg)}).</p>`
      );
      return;
    }

    if (!created || !created.id) {
      warn(
        `JournalEntry.create returned no document for backend.journal.create (name=${name}, correlationId=${payload.correlationId ?? "none"})`
      );
      await this.renderJournalFeedback(
        payload.correlationId,
        "<p>⚠️ Napoleon journal creation returned no document — a Foundry pre-create hook or internal validator likely rejected it.</p>"
      );
      return;
    }

    const confirmContent = `<p>✓ Created @UUID[JournalEntry.${created.id}]</p>`;
    await this.renderJournalFeedback(payload.correlationId, confirmContent);

    info(
      `handleJournalCreate: created journal "${name}" id=${created.id} (correlationId=${payload.correlationId ?? "none"})`
    );

    try {
      created.sheet.render(true);
    } catch (err) {
      debug(
        `sheet.render failed for journal ${created.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async renderJournalFeedback(
    correlationId: string | null,
    content: string
  ): Promise<void> {
    if (correlationId && this.pendingPlaceholders.has(correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(correlationId)!;
      this.pendingPlaceholders.delete(correlationId);
      const placeholder = game.messages.get(placeholderId);
      if (placeholder) {
        try {
          await placeholder.update({ content });
          debug(
            `renderJournalFeedback: replaced placeholder ${placeholderId} (correlationId=${correlationId})`
          );
          return;
        } catch (err) {
          logError(
            `placeholder update failed for journal feedback: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
      }
    }

    try {
      await ChatMessage.create({
        content,
        style: CONST.CHAT_MESSAGE_STYLES.OTHER,
        whisper: [this.ctx.gmUserId],
        flags: {
          "stablepiggy-napoleon-game-assistant": {
            ...(correlationId ? { correlationId } : {}),
          },
        },
      });
    } catch (err) {
      logError(
        `ChatMessage.create failed for journal feedback whisper: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  /**
   * Handle a `backend.rolltable.create` payload: create a RollTable
   * document in Foundry's sidebar.
   */
  private async handleRollTableCreate(
    payload: BackendRollTableCreatePayload
  ): Promise<void> {
    const { name, formula, results } = payload;

    if (!name || !formula || !results || results.length === 0) {
      warn("handleRollTableCreate: invalid payload — missing name, formula, or results");
      return;
    }

    try {
      const tableData: Record<string, unknown> = {
        name,
        formula,
        results: results.map((r) => ({
          text: r.text,
          range: r.range,
          weight: r.weight ?? 1,
          type: 0, // RESULT_TYPES.TEXT
          drawn: false,
        })),
      };

      const created = await RollTable.create(tableData);
      if (created?.id) {
        info(`handleRollTableCreate: created "${name}" (id=${created.id})`);
        try {
          await ChatMessage.create({
            content: `<p>✓ Created RollTable: <strong>${escapeHtml(name)}</strong> (${formula}, ${results.length} entries)</p>`,
            style: CONST.CHAT_MESSAGE_STYLES.OTHER,
            whisper: [this.ctx.gmUserId],
          });
        } catch { /* non-blocking */ }
      } else {
        warn(`RollTable.create returned no document for "${name}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`RollTable.create threw for "${name}": ${msg}`, err);
    }
  }

  /**
   * Handle a `backend.scene.create` payload: create a Scene document with
   * the image as its background. Phase B.1 defaults are deliberately
   * minimal — no vision rules, no fog, global light on, no walls/lights/
   * tokens. The GM gets a usable scene with zero manual configuration.
   * Phase C will layer on vision/fog/walls; Phase D adds the atmospheric
   * layer (tinted darkness, weather, ambient sounds, regions).
   */
  private async handleSceneCreate(
    payload: BackendSceneCreatePayload
  ): Promise<void> {
    const { name, img, width, height } = payload;

    if (!name || !img || !width || !height) {
      warn("handleSceneCreate: invalid payload — missing name, img, width, or height");
      return;
    }

    const gridSize = payload.gridSize ?? 100;
    const gridDistance = payload.gridDistance ?? 5;
    const gridUnits = payload.gridUnits ?? "ft";
    const navigation = payload.navigation ?? true;
    const openAfterCreate = payload.openAfterCreate ?? true;

    try {
      const sceneData: Record<string, unknown> = {
        name,
        navigation,
        background: { src: img, fit: "fill" },
        width,
        height,
        padding: 0.25,
        backgroundColor: "#999999",
        grid: {
          type: 1, // square grid
          size: gridSize,
          style: "solidLines",
          thickness: 1,
          color: "#000000",
          alpha: 0.2,
          distance: gridDistance,
          units: gridUnits,
        },
        // Minimal-defaults policy: GM shouldn't need to configure anything
        // to use the scene. Tokens are universally visible, no fog, global
        // light on. When Phase C walls land, these defaults shift for
        // scenes marked combat/exploration.
        tokenVision: false,
        fog: { exploration: false },
        environment: {
          darknessLevel: 0,
          globalLight: { enabled: true, alpha: 0.5 },
        },
        drawings: [],
        tokens: [],
        lights: [],
        notes: [],
        sounds: [],
        regions: [],
        templates: [],
        tiles: [],
        walls: [],
      };

      const created = await Scene.create(sceneData);
      if (!created?.id) {
        warn(`Scene.create returned no document for "${name}"`);
        return;
      }
      info(`handleSceneCreate: created "${name}" (id=${created.id}, ${width}×${height}px)`);

      if (openAfterCreate) {
        try {
          await created.view();
        } catch (err) {
          // Non-fatal — the scene exists in the sidebar even if activation failed
          warn(
            `scene created but view() failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      try {
        await ChatMessage.create({
          content: `<p>✓ Created Scene: <strong>${escapeHtml(name)}</strong> (${width}×${height}px, grid ${gridSize}px / ${gridDistance}${gridUnits})</p>`,
          style: CONST.CHAT_MESSAGE_STYLES.OTHER,
          whisper: [this.ctx.gmUserId],
        });
      } catch { /* non-blocking confirmation whisper */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Scene.create threw for "${name}": ${msg}`, err);
    }
  }

  /**
   * Handle a `backend.token.create` payload: place a token of an existing
   * Actor onto a Scene. Defaults to the currently-active scene and grid
   * coordinates — the simplest form the LLM will reach for ("place the
   * goblin at grid 5,3 on this map"). The prototype token from the actor
   * is cloned so the token carries the actor's art, bar config, display
   * settings, etc. — we only override x/y/disposition/hidden.
   */
  private async handleTokenCreate(
    payload: BackendTokenCreatePayload
  ): Promise<void> {
    const { actorName, x, y } = payload;
    const coordMode = payload.coordMode ?? "grid";
    const disposition = payload.disposition ?? 0;
    const hidden = payload.hidden ?? false;

    if (!actorName) {
      warn("handleTokenCreate: missing actorName");
      return;
    }

    const scene = payload.sceneId
      ? game.scenes.get(payload.sceneId)
      : game.scenes.active;
    if (!scene) {
      warn(
        `handleTokenCreate: ${payload.sceneId ? `scene "${payload.sceneId}" not found` : "no active scene"} — cannot place token`
      );
      return;
    }

    const actor = game.actors.getName(actorName);
    if (!actor) {
      warn(`handleTokenCreate: no actor found with name "${actorName}"`);
      return;
    }

    const cellSize = scene.grid.size;
    const pxX = coordMode === "px" ? x : x * cellSize;
    const pxY = coordMode === "px" ? y : y * cellSize;

    try {
      const tokenData = actor.prototypeToken.toObject();
      tokenData.x = pxX;
      tokenData.y = pxY;
      tokenData.disposition = disposition;
      tokenData.hidden = hidden;
      // Ensure the placed token is linked to the source actor's id so
      // the token sheet opens the actor and updates reflect both ways.
      tokenData.actorId = actor.id;

      const created = await scene.createEmbeddedDocuments("Token", [tokenData]);
      const tokenId = created[0]?.id;
      if (tokenId) {
        info(
          `handleTokenCreate: placed "${actorName}" on scene "${scene.name ?? scene.id}" at ${coordMode} (${x},${y}) → px (${pxX},${pxY}), dispositon=${disposition}`
        );
        try {
          const dispLabel = disposition === -1 ? "hostile" : disposition === 1 ? "friendly" : "neutral";
          await ChatMessage.create({
            content: `<p>✓ Placed token: <strong>${escapeHtml(actorName)}</strong> on <em>${escapeHtml(scene.name ?? "active scene")}</em> at grid (${Math.round(pxX / cellSize)}, ${Math.round(pxY / cellSize)}) · ${dispLabel}</p>`,
            style: CONST.CHAT_MESSAGE_STYLES.OTHER,
            whisper: [this.ctx.gmUserId],
          });
        } catch { /* non-blocking */ }
      } else {
        warn(`createEmbeddedDocuments returned no token for "${actorName}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Token placement threw for "${actorName}": ${msg}`, err);
    }
  }

  /**
   * Resolve a scene by name (V2 Phase 3 helper). Looks up via
   * `game.scenes.getName(name)` first — that's the match GM-facing
   * tools should hit. Falls back to the active scene when `sceneName`
   * is omitted. Returns null (with a warn log) if neither path
   * produces a scene, and the caller skips rather than throwing —
   * same "warn and return" failure mode used by handleTokenCreate
   * when its scene lookup fails.
   */
  private resolveSceneByName(sceneName: string | undefined, caller: string): FoundryScene | null {
    if (sceneName !== undefined) {
      const byName = game.scenes.getName(sceneName);
      if (byName) return byName;
      warn(`${caller}: scene "${sceneName}" not found — no matching scene in game.scenes`);
      return null;
    }
    const active = game.scenes.active;
    if (!active) {
      warn(`${caller}: no scene_name given and no active scene — cannot resolve target`);
      return null;
    }
    return active;
  }

  /**
   * Handle a `backend.wall.create` payload (V2 Phase 3): place a single
   * wall segment on a Scene via `scene.createEmbeddedDocuments("Wall", ...)`.
   *
   * Foundry V13 Wall schema quirks the backend can't know about (these
   * shape the translation below):
   *   1. move/sight/sound use WALL_RESTRICTION_TYPES: NONE=0, LIMITED=10,
   *      NORMAL=20 — NOT the 0/1 our semantic payload carries. A raw
   *      `move: 1` trips V13's schema validator ("1 is not a valid
   *      choice") and the wall is rejected — exactly what happened on
   *      the 2026-04-23 Otari smoke test.
   *   2. The vision field is `sight` in V13, not `sense`. A `sense: 1`
   *      field is silently dropped by V13's strict schema (unknown
   *      property), so the wall would render without blocking vision
   *      even if move were fixed — a nasty silent-no-op class the
   *      smoke test almost missed.
   *
   * The protocol keeps semantic 0/1 values (portable across Foundry
   * versions) and `sense` as the payload name (matching the intent
   * "sense line-of-sight"). The version-specific translation lives here,
   * so a future V14 change touches only this handler.
   */
  private async handleWallCreate(payload: BackendWallCreatePayload): Promise<void> {
    const scene = this.resolveSceneByName(payload.sceneName, "handleWallCreate");
    if (!scene) return;

    const v13Restrict = (v: number) => (v > 0 ? 20 : 0);

    try {
      const wallData = {
        c: payload.c,
        move: v13Restrict(payload.move),
        sight: v13Restrict(payload.sense),
        sound: v13Restrict(payload.sound),
        door: payload.door,
      };
      const created = await scene.createEmbeddedDocuments("Wall", [wallData]);
      const wallId = created[0]?.id;
      if (wallId) {
        info(
          `handleWallCreate: placed wall ${JSON.stringify(payload.c)} on scene "${scene.name ?? scene.id}" (move=${payload.move}→${wallData.move} sense=${payload.sense}→sight=${wallData.sight} door=${payload.door})`
        );
      } else {
        warn(`handleWallCreate: createEmbeddedDocuments returned no id`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`handleWallCreate threw on scene "${scene.name ?? scene.id}": ${msg}`, err);
    }
  }

  /**
   * Handle a `backend.light.create` payload (V2 Phase 3): place an
   * AmbientLight on a Scene. Foundry V13 nests radius/cone fields under
   * `config` (distinct from the top-level x/y position), matching the
   * AmbientLight document schema — the payload's flat fields map into
   * that structure here at the handler.
   *
   * `color` at null/undefined falls through as undefined rather than an
   * explicit null, since Foundry treats "key missing" as default-white
   * but may render an explicit null as "no color" (blank).
   */
  private async handleLightCreate(payload: BackendLightCreatePayload): Promise<void> {
    const scene = this.resolveSceneByName(payload.sceneName, "handleLightCreate");
    if (!scene) return;

    try {
      const lightConfig: Record<string, unknown> = {
        dim: payload.dim,
        bright: payload.bright,
        angle: payload.angle ?? 360,
      };
      if (payload.color !== undefined && payload.color !== null) {
        lightConfig.color = payload.color;
      }
      const lightData: Record<string, unknown> = {
        x: payload.x,
        y: payload.y,
        rotation: payload.rotation ?? 0,
        config: lightConfig,
      };
      const created = await scene.createEmbeddedDocuments("AmbientLight", [lightData]);
      const lightId = created[0]?.id;
      if (lightId) {
        info(
          `handleLightCreate: placed light at (${payload.x},${payload.y}) on scene "${scene.name ?? scene.id}" (dim=${payload.dim} bright=${payload.bright} angle=${payload.angle ?? 360})`
        );
      } else {
        warn(`handleLightCreate: createEmbeddedDocuments returned no id`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`handleLightCreate threw on scene "${scene.name ?? scene.id}": ${msg}`, err);
    }
  }

  /**
   * Handle a `backend.scene.update` payload (V2 Phase 3): apply scene-
   * level setting changes. The payload uses flat camelCase fields so
   * the backend's tool-use boundary is a flat shape; Foundry V13
   * actually stores darkness/globalLight under `environment.*` and
   * grid fields under `grid.*`, so this handler maps each field
   * individually before calling `scene.update(...)`.
   *
   * Critical nesting (easy to get wrong, silent no-op if so):
   *   - darkness → environment.darknessLevel (0..1)
   *   - globalLight → environment.globalLight.enabled
   *   - gridSize → grid.size
   *   - gridDistance → grid.distance
   *   - gridUnits → grid.units
   *   - tokenVision → tokenVision (top-level)
   *   - navigation → navigation (top-level)
   *
   * `handleSceneCreate` already uses these exact paths at creation time —
   * same shapes at update time.
   */
  private async handleSceneUpdate(payload: BackendSceneUpdatePayload): Promise<void> {
    const scene = this.resolveSceneByName(payload.sceneName, "handleSceneUpdate");
    if (!scene) return;

    const updates: Record<string, unknown> = {};
    const env: Record<string, unknown> = {};
    const grid: Record<string, unknown> = {};

    if (payload.darkness !== undefined) env.darknessLevel = payload.darkness;
    if (payload.globalLight !== undefined) env.globalLight = { enabled: payload.globalLight };
    if (Object.keys(env).length > 0) updates.environment = env;

    if (payload.gridSize !== undefined) grid.size = payload.gridSize;
    if (payload.gridDistance !== undefined) grid.distance = payload.gridDistance;
    if (payload.gridUnits !== undefined) grid.units = payload.gridUnits;
    if (Object.keys(grid).length > 0) updates.grid = grid;

    if (payload.tokenVision !== undefined) updates.tokenVision = payload.tokenVision;
    if (payload.navigation !== undefined) updates.navigation = payload.navigation;

    if (Object.keys(updates).length === 0) {
      warn("handleSceneUpdate: payload reduced to no changes — skipping update()");
      return;
    }

    try {
      await scene.update(updates);
      info(
        `handleSceneUpdate: updated scene "${scene.name ?? scene.id}" — fields=[${Object.keys(updates).join(", ")}]`
      );
      try {
        const descParts: string[] = [];
        if (payload.darkness !== undefined) descParts.push(`darkness=${payload.darkness}`);
        if (payload.globalLight !== undefined) descParts.push(`globalLight=${payload.globalLight}`);
        if (payload.tokenVision !== undefined) descParts.push(`tokenVision=${payload.tokenVision}`);
        if (descParts.length > 0) {
          await ChatMessage.create({
            content: `<p>✓ Updated scene <em>${escapeHtml(scene.name ?? "active")}</em>: ${escapeHtml(descParts.join(", "))}</p>`,
            style: CONST.CHAT_MESSAGE_STYLES.OTHER,
            whisper: [this.ctx.gmUserId],
          });
        }
      } catch { /* non-blocking */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`handleSceneUpdate threw on scene "${scene.name ?? scene.id}": ${msg}`, err);
    }
  }

  /**
   * Handle a `backend.data.upload` payload: fetch the signed Barn URL,
   * upload the bytes to Foundry Data at `targetPath` via FilePicker,
   * then (if `followUp` is present) dispatch it through the normal
   * handler for that kind. Emits `client.data_upload_ack` with the
   * outcome for backend observability. On failure, surfaces the error
   * via ui.notifications.error — the chat preview button remains
   * clickable so the GM can retry.
   *
   * Fail loud per RFC Q4 — no automatic retry, GM decides.
   */
  private async handleDataUpload(
    payload: BackendDataUploadPayload,
    originatingMessageId: string
  ): Promise<void> {
    const { signedUrl, targetPath, followUp, correlationId } = payload;

    try {
      await uploadToWorld(signedUrl, targetPath);
      info(`handleDataUpload: uploaded to ${targetPath}`);

      this.sendDataUploadAck({
        correlationId,
        targetPath,
        ok: true,
      });

      // Dispatch follow-up command, if any. Backend pre-baked the Data
      // path into the relevant img/src fields (see buildFollowUp in
      // dashboard/routes/foundry.ts), so handlers execute verbatim.
      if (followUp) {
        switch (followUp.kind) {
          case "backend.chat.create":
            await this.handleChatCreate(followUp.payload);
            break;
          case "backend.actor.create":
            await this.handleActorCreate(followUp.payload);
            break;
          case "backend.actor.update":
            await this.handleActorUpdate(followUp.payload);
            break;
          case "backend.journal.create":
            await this.handleJournalCreate(followUp.payload);
            break;
          case "backend.rolltable.create":
            await this.handleRollTableCreate(followUp.payload);
            break;
          case "backend.scene.create":
            await this.handleSceneCreate(followUp.payload);
            break;
          case "backend.token.create":
            await this.handleTokenCreate(followUp.payload);
            break;
          default: {
            // Exhaustiveness — protocol union narrows this to never.
            const exhaustive: never = followUp;
            void exhaustive;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(
        `handleDataUpload failed for ${targetPath} (msgId=${originatingMessageId}): ${msg}`,
        err
      );
      try {
        // Foundry's global `ui.notifications` is available in module scope
        // but not declared locally in this file — reach it via globalThis
        // to avoid a duplicate `declare const ui` block.
        (globalThis as unknown as { ui?: { notifications?: { error(m: string): void } } })
          .ui?.notifications?.error(`Save to World failed: ${msg}`);
      } catch { /* notifications API unavailable — already logged */ }
      this.sendDataUploadAck({
        correlationId,
        targetPath,
        ok: false,
        error: msg,
      });
    }
  }

  /**
   * Emit a `client.data_upload_ack` over the socket. Fire-and-forget
   * telemetry — backend logs it but doesn't branch on the outcome.
   */
  private sendDataUploadAck(payload: ClientDataUploadAckPayload): void {
    if (this.status !== "connected" || !this.socket) {
      debug(`sendDataUploadAck skipped (status=${this.status}) for ${payload.targetPath}`);
      return;
    }
    const msg = makeMessage("client.data_upload_ack", payload);
    this.socket.send(JSON.stringify(msg));
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
