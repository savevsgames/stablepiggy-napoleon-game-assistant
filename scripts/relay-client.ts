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
} from "@stablepiggy-napoleon/protocol";

import { info, warn, error as logError, debug } from "./log.js";
import { getAuthToken, getRelayEndpoint } from "./settings.js";

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
