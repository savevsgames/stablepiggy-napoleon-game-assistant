const PROTOCOL_VERSION = 1;
class ProtocolError extends Error {
  code;
  correlationId;
  name = "ProtocolError";
  constructor(code, message, correlationId) {
    super(message);
    this.code = code;
    this.correlationId = correlationId;
  }
}
function makeMessageId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += chars[bytes[i] % 62];
  }
  return id;
}
function makeMessage(kind, payload) {
  const msg = {
    v: PROTOCOL_VERSION,
    id: makeMessageId(),
    ts: Date.now(),
    kind,
    payload
  };
  return msg;
}
function assert(condition, field, expected, correlationId) {
  if (!condition) {
    throw new ProtocolError("validation_failed", `${field}: expected ${expected}`, correlationId);
  }
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function validateEnvelope(input) {
  assert(isPlainObject(input), "message", "an object");
  const raw = input;
  if (raw.v !== PROTOCOL_VERSION) {
    throw new ProtocolError("protocol_mismatch", `expected protocol version ${PROTOCOL_VERSION}, got ${String(raw.v)}`, typeof raw.id === "string" ? raw.id : void 0);
  }
  assert(isNonEmptyString(raw.id), "id", "a non-empty string");
  assert(isFiniteNumber(raw.ts), "ts", "a finite number");
  assert(isNonEmptyString(raw.kind), "kind", "a non-empty string", raw.id);
  assert(isPlainObject(raw.payload), "payload", "an object", raw.id);
  return {
    v: PROTOCOL_VERSION,
    id: raw.id,
    ts: raw.ts,
    kind: raw.kind,
    payload: raw.payload
  };
}
function validateCapabilities(value, correlationId) {
  assert(isPlainObject(value), "payload.capabilities", "an object", correlationId);
  const c = value;
  assert(typeof c.chatCreate === "boolean", "capabilities.chatCreate", "boolean", correlationId);
  assert(typeof c.actorCreate === "boolean", "capabilities.actorCreate", "boolean", correlationId);
  assert(typeof c.journalCreate === "boolean", "capabilities.journalCreate", "boolean", correlationId);
  assert(isNonEmptyString(c.systemId), "capabilities.systemId", "non-empty string", correlationId);
  assert(isNonEmptyString(c.systemVersion), "capabilities.systemVersion", "non-empty string", correlationId);
  assert(isNonEmptyString(c.foundryVersion), "capabilities.foundryVersion", "non-empty string", correlationId);
}
function validateHelloPayload(payload, correlationId) {
  assert(payload.protocolVersion === PROTOCOL_VERSION, "payload.protocolVersion", `equals ${PROTOCOL_VERSION}`, correlationId);
  assert(isNonEmptyString(payload.authToken), "payload.authToken", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.worldId), "payload.worldId", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.gmUserId), "payload.gmUserId", "non-empty string", correlationId);
  assert(typeof payload.isPrimaryGM === "boolean", "payload.isPrimaryGM", "boolean", correlationId);
  assert(isNonEmptyString(payload.moduleVersion), "payload.moduleVersion", "non-empty string", correlationId);
  validateCapabilities(payload.capabilities, correlationId);
}
function validateWelcomePayload(payload, correlationId) {
  assert(payload.protocolVersion === PROTOCOL_VERSION, "payload.protocolVersion", `equals ${PROTOCOL_VERSION}`, correlationId);
  assert(isNonEmptyString(payload.relayVersion), "payload.relayVersion", "non-empty string", correlationId);
  assert(typeof payload.backendAvailable === "boolean", "payload.backendAvailable", "boolean", correlationId);
  assert(isFiniteNumber(payload.serverTime), "payload.serverTime", "finite number", correlationId);
}
function validateQueryContext(value, correlationId) {
  assert(isPlainObject(value), "payload.context", "an object", correlationId);
  const ctx = value;
  assert(ctx.sceneId === null || typeof ctx.sceneId === "string", "context.sceneId", "string or null", correlationId);
  assert(isStringArray(ctx.selectedActorIds), "context.selectedActorIds", "string array", correlationId);
  assert(typeof ctx.inCombat === "boolean", "context.inCombat", "boolean", correlationId);
  assert(isStringArray(ctx.recentChat), "context.recentChat", "string array", correlationId);
}
function validateQuerySnapshot(value, correlationId) {
  assert(isPlainObject(value), "payload.snapshot", "an object", correlationId);
  const snap = value;
  assert(isNonEmptyString(snap.dataUrl), "snapshot.dataUrl", "non-empty string", correlationId);
  assert(typeof snap.dataUrl === "string" && snap.dataUrl.startsWith("data:image/"), "snapshot.dataUrl", "data URL with image/ media type", correlationId);
  assert(typeof snap.width === "number" && snap.width > 0, "snapshot.width", "positive number", correlationId);
  assert(typeof snap.height === "number" && snap.height > 0, "snapshot.height", "positive number", correlationId);
  assert(typeof snap.gridSize === "number" && snap.gridSize > 0, "snapshot.gridSize", "positive number", correlationId);
  assert(isNonEmptyString(snap.sceneId), "snapshot.sceneId", "non-empty string", correlationId);
  assert(isNonEmptyString(snap.sceneName), "snapshot.sceneName", "non-empty string", correlationId);
}
function validateQueryPayload(payload, correlationId) {
  assert(isNonEmptyString(payload.sessionId), "payload.sessionId", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.query), "payload.query", "non-empty string", correlationId);
  validateQueryContext(payload.context, correlationId);
  if (payload.snapshot !== void 0) {
    validateQuerySnapshot(payload.snapshot, correlationId);
  }
}
function validateChatCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isPlainObject(payload.speaker), "payload.speaker", "an object", correlationId);
  const speaker = payload.speaker;
  if ("alias" in speaker) {
    assert(typeof speaker.alias === "string", "speaker.alias", "string when present", correlationId);
  }
  if ("actorId" in speaker) {
    assert(typeof speaker.actorId === "string", "speaker.actorId", "string when present", correlationId);
  }
  assert(isNonEmptyString(payload.content), "payload.content", "non-empty string", correlationId);
  assert(payload.type === "ic" || payload.type === "ooc" || payload.type === "whisper" || payload.type === "emote", "payload.type", "one of ic|ooc|whisper|emote", correlationId);
  assert(isStringArray(payload.whisperTo), "payload.whisperTo", "string array", correlationId);
  if ("flavor" in payload) {
    assert(typeof payload.flavor === "string", "payload.flavor", "string when present", correlationId);
  }
}
function validateActorCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isPlainObject(payload.actor), "payload.actor", "an object", correlationId);
  if ("folderId" in payload) {
    assert(typeof payload.folderId === "string", "payload.folderId", "string when present", correlationId);
  }
}
function validateActorUpdatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isNonEmptyString(payload.actorName), "payload.actorName", "non-empty string", correlationId);
  assert(isPlainObject(payload.updates), "payload.updates", "an object", correlationId);
}
function validateRollTableCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isNonEmptyString(payload.name), "payload.name", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.formula), "payload.formula", "non-empty string", correlationId);
  assert(Array.isArray(payload.results), "payload.results", "an array", correlationId);
  assert(payload.results.length > 0, "payload.results", "non-empty array", correlationId);
}
function validateTokenCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isNonEmptyString(payload.actorName), "payload.actorName", "non-empty string", correlationId);
  assert(typeof payload.x === "number" && Number.isFinite(payload.x), "payload.x", "finite number", correlationId);
  assert(typeof payload.y === "number" && Number.isFinite(payload.y), "payload.y", "finite number", correlationId);
  if ("coordMode" in payload) {
    assert(payload.coordMode === "grid" || payload.coordMode === "px", "payload.coordMode", "'grid' or 'px' when present", correlationId);
  }
  if ("sceneId" in payload) {
    assert(typeof payload.sceneId === "string", "payload.sceneId", "string when present", correlationId);
  }
  if ("disposition" in payload) {
    assert(payload.disposition === -1 || payload.disposition === 0 || payload.disposition === 1, "payload.disposition", "-1, 0, or 1 when present", correlationId);
  }
  if ("hidden" in payload) {
    assert(typeof payload.hidden === "boolean", "payload.hidden", "boolean when present", correlationId);
  }
}
function validateSceneCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isNonEmptyString(payload.name), "payload.name", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.img), "payload.img", "non-empty string", correlationId);
  assert(typeof payload.width === "number" && payload.width > 0, "payload.width", "positive number", correlationId);
  assert(typeof payload.height === "number" && payload.height > 0, "payload.height", "positive number", correlationId);
  if ("gridSize" in payload) {
    assert(typeof payload.gridSize === "number" && payload.gridSize > 0, "payload.gridSize", "positive number when present", correlationId);
  }
  if ("gridDistance" in payload) {
    assert(typeof payload.gridDistance === "number" && payload.gridDistance > 0, "payload.gridDistance", "positive number when present", correlationId);
  }
  if ("gridUnits" in payload) {
    assert(typeof payload.gridUnits === "string", "payload.gridUnits", "string when present", correlationId);
  }
  if ("navigation" in payload) {
    assert(typeof payload.navigation === "boolean", "payload.navigation", "boolean when present", correlationId);
  }
  if ("openAfterCreate" in payload) {
    assert(typeof payload.openAfterCreate === "boolean", "payload.openAfterCreate", "boolean when present", correlationId);
  }
}
function validateJournalCreatePayload(payload, correlationId) {
  assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
  assert(isNonEmptyString(payload.name), "payload.name", "non-empty string", correlationId);
  assert(Array.isArray(payload.pages), "payload.pages", "an array", correlationId);
  assert(payload.pages.length > 0, "payload.pages", "non-empty array", correlationId);
  for (const [index, page] of payload.pages.entries()) {
    assert(isPlainObject(page), `pages[${index}]`, "an object", correlationId);
    const p = page;
    assert(isNonEmptyString(p.name), `pages[${index}].name`, "non-empty string", correlationId);
    assert(p.type === "text", `pages[${index}].type`, `"text"`, correlationId);
    assert(isPlainObject(p.text), `pages[${index}].text`, "an object", correlationId);
    const text = p.text;
    assert(typeof text.content === "string", `pages[${index}].text.content`, "string", correlationId);
    assert(text.format === 1, `pages[${index}].text.format`, "1 (HTML)", correlationId);
  }
  if ("folderId" in payload) {
    assert(typeof payload.folderId === "string", "payload.folderId", "string when present", correlationId);
  }
}
const VALID_SESSION_EVENT_TYPES = /* @__PURE__ */ new Set([
  "roll",
  "napoleon_exchange",
  "combat",
  "gm_whisper"
]);
function validateSessionEventPayload(payload, correlationId) {
  assert(typeof payload.eventType === "string" && VALID_SESSION_EVENT_TYPES.has(payload.eventType), "payload.eventType", "one of roll|napoleon_exchange|combat|gm_whisper", correlationId);
  assert(isFiniteNumber(payload.timestamp), "payload.timestamp", "finite number", correlationId);
  assert(isNonEmptyString(payload.speaker), "payload.speaker", "non-empty string", correlationId);
  assert(typeof payload.content === "string", "payload.content", "string", correlationId);
  assert(isPlainObject(payload.metadata), "payload.metadata", "an object", correlationId);
  const meta = payload.metadata;
  assert(isNonEmptyString(meta.worldId), "metadata.worldId", "non-empty string", correlationId);
  if ("sceneId" in meta) {
    assert(typeof meta.sceneId === "string", "metadata.sceneId", "string when present", correlationId);
  }
  if ("combatRound" in meta) {
    assert(isFiniteNumber(meta.combatRound), "metadata.combatRound", "finite number when present", correlationId);
  }
}
function validatePongPayload(payload, correlationId) {
  assert(isNonEmptyString(payload.pingId), "payload.pingId", "non-empty string", correlationId);
}
function validateErrorPayload(payload, correlationId) {
  assert(isNonEmptyString(payload.code), "payload.code", "non-empty string", correlationId);
  assert(isNonEmptyString(payload.message), "payload.message", "non-empty string", correlationId);
  if ("correlationId" in payload) {
    assert(typeof payload.correlationId === "string", "payload.correlationId", "string when present", correlationId);
  }
}
function validateMessage(input) {
  const envelope = validateEnvelope(input);
  const { kind, payload, id } = envelope;
  switch (kind) {
    case "client.hello":
      validateHelloPayload(payload, id);
      break;
    case "relay.welcome":
      validateWelcomePayload(payload, id);
      break;
    case "client.query":
      validateQueryPayload(payload, id);
      break;
    case "client.session_event":
      validateSessionEventPayload(payload, id);
      break;
    case "backend.chat.create":
      validateChatCreatePayload(payload, id);
      break;
    case "backend.actor.create":
      validateActorCreatePayload(payload, id);
      break;
    case "backend.actor.update":
      validateActorUpdatePayload(payload, id);
      break;
    case "backend.journal.create":
      validateJournalCreatePayload(payload, id);
      break;
    case "backend.rolltable.create":
      validateRollTableCreatePayload(payload, id);
      break;
    case "backend.scene.create":
      validateSceneCreatePayload(payload, id);
      break;
    case "backend.token.create":
      validateTokenCreatePayload(payload, id);
      break;
    case "ping":
      break;
    case "pong":
      validatePongPayload(payload, id);
      break;
    case "error":
      validateErrorPayload(payload, id);
      break;
    default: {
      const exhaustive = kind;
      throw new ProtocolError("unknown_kind", `unknown message kind: ${String(exhaustive)}`, id);
    }
  }
  return input;
}
const MODULE_ID$3 = "stablepiggy-napoleon-game-assistant";
const PREFIX = `[stablepiggy-napoleon]`;
function debugEnabled() {
  try {
    return CONFIG?.debug?.[MODULE_ID$3] === true;
  } catch {
    return false;
  }
}
function info(message, ...rest) {
  console.log(`${PREFIX} ${message}`, ...rest);
}
function warn(message, ...rest) {
  console.warn(`${PREFIX} ${message}`, ...rest);
}
function error(message, ...rest) {
  console.error(`${PREFIX} ${message}`, ...rest);
}
function debug(message, ...rest) {
  if (!debugEnabled()) return;
  console.debug(`${PREFIX} ${message}`, ...rest);
}
const MODULE_ID$2 = "stablepiggy-napoleon-game-assistant";
const SETTING_RELAY_ENDPOINT = "relayEndpoint";
const SETTING_AUTH_TOKEN = "authToken";
function registerSettings() {
  game.settings.register(MODULE_ID$2, SETTING_RELAY_ENDPOINT, {
    name: "Relay endpoint",
    hint: "WebSocket URL of the StablePiggy Napoleon relay service. For local development use ws://localhost:8080. Changes take effect on the next world reload.",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:8080",
    requiresReload: true
  });
  game.settings.register(MODULE_ID$2, SETTING_AUTH_TOKEN, {
    name: "Auth token",
    hint: "Your StablePiggy API key (starts with dv-) for full account features, or a shared secret for anonymous/self-hosted mode. Stored locally in this browser only — not synced to other users.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    requiresReload: true
  });
  info("settings registered");
}
function getRelayEndpoint() {
  const raw = game.settings.get(MODULE_ID$2, SETTING_RELAY_ENDPOINT);
  return typeof raw === "string" ? raw : "";
}
function getAuthToken() {
  const raw = game.settings.get(MODULE_ID$2, SETTING_AUTH_TOKEN);
  return typeof raw === "string" ? raw : "";
}
function escapeHtml$1(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const MODULE_VERSION$1 = "0.0.1";
const PING_INTERVAL_MS = 3e4;
const BACKOFF_INITIAL_MS = 1e3;
const BACKOFF_MAX_MS = 3e4;
class RelayClient {
  ctx;
  socket = null;
  status = "disconnected";
  shuttingDown = false;
  /** Current reconnect backoff — resets to BACKOFF_INITIAL_MS after successful handshake. */
  backoffMs = BACKOFF_INITIAL_MS;
  reconnectTimer = null;
  /** Ping loop handle. Cleared on disconnect. */
  pingTimer = null;
  /** ID of the most recent ping we sent — cleared when the matching pong arrives. */
  pendingPingId = null;
  /**
   * Outstanding placeholder chat messages keyed by the correlationId
   * the backend will echo back on the matching `backend.chat.create`.
   * When a chat.create arrives with a known correlationId, the handler
   * calls `message.update()` on the stored Foundry message id instead
   * of creating a new chat entry — so the "Napoleon is thinking…"
   * placeholder from chat-command.ts gets replaced in place. See
   * chat-command.ts and the `handleChatCreate` method below.
   */
  pendingPlaceholders = /* @__PURE__ */ new Map();
  constructor(ctx) {
    this.ctx = ctx;
  }
  /**
   * Open a new connection to the configured relay. Called once from the
   * Foundry `ready` hook. If the settings are missing, logs a warning
   * and stays disconnected — the GM can set them in the settings panel
   * and reload the world.
   */
  connect() {
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
        "relay endpoint not configured — open the module settings and set 'Relay endpoint' to your relay's WebSocket URL, then reload the world"
      );
      return;
    }
    if (!authToken) {
      warn(
        "auth token not configured — open the module settings and paste your StablePiggy API key (or a shared secret), then reload the world"
      );
      return;
    }
    info(`connecting to ${endpoint}`);
    this.status = "connecting";
    let ws;
    try {
      ws = new WebSocket(endpoint);
    } catch (err) {
      error("failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.addEventListener("open", () => this.onOpen(authToken));
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", (ev) => this.onClose(ev));
    ws.addEventListener("error", (ev) => {
      error("websocket error event", ev);
    });
  }
  /**
   * Tear down the connection permanently. Called from the page unload
   * path or from a future "Disconnect" settings button. After this the
   * client will not auto-reconnect even if told to.
   */
  shutdown() {
    this.shuttingDown = true;
    this.clearTimers();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(1e3, "client shutdown");
      } catch {
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
  sendQuery(payload) {
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
  sendSessionEvent(payload) {
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
  registerPlaceholder(correlationId, foundryMessageId) {
    this.pendingPlaceholders.set(correlationId, foundryMessageId);
  }
  /**
   * Remove a placeholder registration. Called by chat-command.ts's
   * timeout path when it wants to claim the placeholder and replace
   * its content with an error, preventing a race with a late-
   * arriving real response.
   */
  unregisterPlaceholder(correlationId) {
    this.pendingPlaceholders.delete(correlationId);
  }
  /** True if a placeholder is still registered for this correlationId. */
  hasPlaceholder(correlationId) {
    return this.pendingPlaceholders.has(correlationId);
  }
  /** Current connection status — useful for the future settings panel indicator. */
  getStatus() {
    return this.status;
  }
  // ── Lifecycle handlers ──────────────────────────────────────────────
  onOpen(authToken) {
    debug("websocket open — sending client.hello");
    this.status = "handshaking";
    const helloPayload = {
      protocolVersion: PROTOCOL_VERSION,
      authToken,
      worldId: this.ctx.worldId,
      gmUserId: this.ctx.gmUserId,
      isPrimaryGM: this.ctx.isPrimaryGM,
      moduleVersion: MODULE_VERSION$1,
      capabilities: {
        chatCreate: true,
        actorCreate: true,
        actorUpdate: true,
        journalCreate: true,
        rolltableCreate: true,
        sceneCreate: true,
        tokenCreate: true,
        systemId: this.ctx.systemId,
        systemVersion: this.ctx.systemVersion,
        foundryVersion: this.ctx.foundryVersion
      }
    };
    const hello = makeMessage("client.hello", helloPayload);
    this.socket?.send(JSON.stringify(hello));
  }
  onMessage(ev) {
    let message;
    try {
      const parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
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
      case "backend.token.create":
        void this.handleTokenCreate(message.payload);
        break;
      case "error":
        warn(
          `relay sent error (code=${message.payload.code}): ${message.payload.message}`
        );
        break;
      case "ping":
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
    }
  }
  onClose(ev) {
    this.clearTimers();
    const wasConnected = this.status === "connected";
    this.status = this.shuttingDown ? "disconnected" : "reconnecting";
    this.socket = null;
    info(`websocket closed (code=${ev.code}, reason="${ev.reason}")`);
    if (this.shuttingDown) {
      return;
    }
    if (wasConnected) {
      this.backoffMs = BACKOFF_INITIAL_MS;
    }
    this.scheduleReconnect();
  }
  onWelcome() {
    this.status = "connected";
    this.backoffMs = BACKOFF_INITIAL_MS;
    info("relay handshake complete");
    this.startPingLoop();
  }
  onPong(pingId) {
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
  async handleChatCreate(payload) {
    const style = this.mapChatStyle(payload.type);
    const whisper = payload.type === "whisper" ? this.remapWhisperTargets(payload.whisperTo) : [];
    if (payload.correlationId && this.pendingPlaceholders.has(payload.correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(payload.correlationId);
      this.pendingPlaceholders.delete(payload.correlationId);
      const placeholder = game.messages.get(placeholderId);
      if (placeholder) {
        try {
          await placeholder.update({
            content: payload.content,
            ...payload.flavor ? { flavor: payload.flavor } : {}
          });
          info(
            `replaced placeholder ${placeholderId} with response (correlationId=${payload.correlationId})`
          );
          return;
        } catch (err) {
          error(
            `placeholder update failed, falling back to new message: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
      } else {
        debug(
          `placeholder ${placeholderId} no longer exists (deleted?) — creating a new chat message`
        );
      }
    }
    const data = {
      content: payload.content,
      style,
      speaker: { ...payload.speaker.alias ? { alias: payload.speaker.alias } : {} },
      ...whisper.length > 0 ? { whisper } : {},
      ...payload.flavor ? { flavor: payload.flavor } : {},
      flags: {
        "stablepiggy-napoleon-game-assistant": {
          ...payload.correlationId ? { correlationId: payload.correlationId } : {}
        }
      }
    };
    try {
      await ChatMessage.create(data);
      info(
        `rendered backend.chat.create (type=${payload.type}, whisper=${whisper.length}, correlationId=${payload.correlationId ?? "none"})`
      );
    } catch (err) {
      error(
        `ChatMessage.create failed for backend.chat.create: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
  mapChatStyle(type) {
    switch (type) {
      case "ic":
        return CONST.CHAT_MESSAGE_STYLES.IC;
      case "ooc":
        return CONST.CHAT_MESSAGE_STYLES.OOC;
      case "emote":
        return CONST.CHAT_MESSAGE_STYLES.EMOTE;
      case "whisper":
        return CONST.CHAT_MESSAGE_STYLES.OTHER;
    }
  }
  remapWhisperTargets(whisperTo) {
    const selfId = this.ctx.gmUserId;
    const result = [];
    let substituted = 0;
    for (const entry of whisperTo) {
      if (game.users.get(entry)) {
        result.push(entry);
        continue;
      }
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
  async handleActorCreate(payload) {
    const actor = payload.actor;
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
        `<p>⚠️ Napoleon NPC generation failed: actor type is "${escapeHtml$1(String(actor.type))}", expected "npc".</p>`
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
    let created;
    try {
      const createOptions = payload.folderId ? { folder: payload.folderId } : void 0;
      created = await Actor.create(
        actor,
        createOptions
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(
        `Actor.create threw for backend.actor.create: ${msg}`,
        err
      );
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Napoleon NPC creation failed: Foundry rejected the actor (${escapeHtml$1(msg)}).</p>`
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
    const confirmContent = `<p>✓ Created @UUID[Actor.${created.id}]</p>`;
    await this.renderActorFeedback(payload.correlationId, confirmContent, {
      actorId: created.id
    });
    info(
      `handleActorCreate: created NPC "${name}" id=${created.id} (correlationId=${payload.correlationId ?? "none"})`
    );
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
  async handleActorUpdate(payload) {
    const { actorName, updates } = payload;
    const actor = game.actors.getName(actorName);
    if (!actor) {
      warn(`handleActorUpdate: no actor found with name "${actorName}"`);
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Could not update actor "${escapeHtml$1(actorName)}" — not found in the Actors sidebar.</p>`
      );
      return;
    }
    try {
      await actor.update(updates);
      info(`handleActorUpdate: updated actor "${actorName}" (id=${actor.id}, fields: ${Object.keys(updates).join(", ")})`);
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>✓ Updated @UUID[Actor.${actor.id}] — ${Object.keys(updates).join(", ")}</p>`,
        { actorId: actor.id }
      );
      try {
        actor.sheet.render(false);
      } catch {
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Actor.update threw for "${actorName}": ${msg}`, err);
      await this.renderActorFeedback(
        payload.correlationId,
        `<p>⚠️ Failed to update actor "${escapeHtml$1(actorName)}": ${escapeHtml$1(msg)}</p>`
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
  async renderActorFeedback(correlationId, content, extraFlags) {
    if (correlationId && this.pendingPlaceholders.has(correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(correlationId);
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
          error(
            `placeholder update failed for actor feedback, falling back to new whisper: ${err instanceof Error ? err.message : String(err)}`,
            err
          );
        }
      } else {
        debug(
          `placeholder ${placeholderId} no longer exists (deleted?) — creating new whisper`
        );
      }
    }
    try {
      await ChatMessage.create({
        content,
        style: CONST.CHAT_MESSAGE_STYLES.OTHER,
        whisper: [this.ctx.gmUserId],
        flags: {
          "stablepiggy-napoleon-game-assistant": {
            ...correlationId ? { correlationId } : {},
            ...extraFlags ?? {}
          }
        }
      });
    } catch (err) {
      error(
        `ChatMessage.create failed for actor feedback whisper: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
  async handleJournalCreate(payload) {
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
    let created;
    try {
      const createData = {
        name,
        pages: payload.pages.map((p) => ({
          name: p.name,
          type: p.type,
          text: { content: p.text.content, format: p.text.format }
        }))
      };
      const createOptions = payload.folderId ? { folder: payload.folderId } : void 0;
      created = await JournalEntry.create(createData, createOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(
        `JournalEntry.create threw for backend.journal.create: ${msg}`,
        err
      );
      await this.renderJournalFeedback(
        payload.correlationId,
        `<p>⚠️ Napoleon journal creation failed: Foundry rejected the entry (${escapeHtml$1(msg)}).</p>`
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
  async renderJournalFeedback(correlationId, content) {
    if (correlationId && this.pendingPlaceholders.has(correlationId)) {
      const placeholderId = this.pendingPlaceholders.get(correlationId);
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
          error(
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
            ...correlationId ? { correlationId } : {}
          }
        }
      });
    } catch (err) {
      error(
        `ChatMessage.create failed for journal feedback whisper: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }
  /**
   * Handle a `backend.rolltable.create` payload: create a RollTable
   * document in Foundry's sidebar.
   */
  async handleRollTableCreate(payload) {
    const { name, formula, results } = payload;
    if (!name || !formula || !results || results.length === 0) {
      warn("handleRollTableCreate: invalid payload — missing name, formula, or results");
      return;
    }
    try {
      const tableData = {
        name,
        formula,
        results: results.map((r) => ({
          text: r.text,
          range: r.range,
          weight: r.weight ?? 1,
          type: 0,
          // RESULT_TYPES.TEXT
          drawn: false
        }))
      };
      const created = await RollTable.create(tableData);
      if (created?.id) {
        info(`handleRollTableCreate: created "${name}" (id=${created.id})`);
        try {
          await ChatMessage.create({
            content: `<p>✓ Created RollTable: <strong>${escapeHtml$1(name)}</strong> (${formula}, ${results.length} entries)</p>`,
            style: CONST.CHAT_MESSAGE_STYLES.OTHER,
            whisper: [this.ctx.gmUserId]
          });
        } catch {
        }
      } else {
        warn(`RollTable.create returned no document for "${name}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`RollTable.create threw for "${name}": ${msg}`, err);
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
  async handleSceneCreate(payload) {
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
      const sceneData = {
        name,
        navigation,
        background: { src: img, fit: "fill" },
        width,
        height,
        padding: 0.25,
        backgroundColor: "#999999",
        grid: {
          type: 1,
          // square grid
          size: gridSize,
          style: "solidLines",
          thickness: 1,
          color: "#000000",
          alpha: 0.2,
          distance: gridDistance,
          units: gridUnits
        },
        // Minimal-defaults policy: GM shouldn't need to configure anything
        // to use the scene. Tokens are universally visible, no fog, global
        // light on. When Phase C walls land, these defaults shift for
        // scenes marked combat/exploration.
        tokenVision: false,
        fog: { exploration: false },
        environment: {
          darknessLevel: 0,
          globalLight: { enabled: true, alpha: 0.5 }
        },
        drawings: [],
        tokens: [],
        lights: [],
        notes: [],
        sounds: [],
        regions: [],
        templates: [],
        tiles: [],
        walls: []
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
          warn(
            `scene created but view() failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      try {
        await ChatMessage.create({
          content: `<p>✓ Created Scene: <strong>${escapeHtml$1(name)}</strong> (${width}×${height}px, grid ${gridSize}px / ${gridDistance}${gridUnits})</p>`,
          style: CONST.CHAT_MESSAGE_STYLES.OTHER,
          whisper: [this.ctx.gmUserId]
        });
      } catch {
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Scene.create threw for "${name}": ${msg}`, err);
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
  async handleTokenCreate(payload) {
    const { actorName, x, y } = payload;
    const coordMode = payload.coordMode ?? "grid";
    const disposition = payload.disposition ?? 0;
    const hidden = payload.hidden ?? false;
    if (!actorName) {
      warn("handleTokenCreate: missing actorName");
      return;
    }
    const scene = payload.sceneId ? game.scenes.get(payload.sceneId) : game.scenes.active;
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
            content: `<p>✓ Placed token: <strong>${escapeHtml$1(actorName)}</strong> on <em>${escapeHtml$1(scene.name ?? "active scene")}</em> at grid (${Math.round(pxX / cellSize)}, ${Math.round(pxY / cellSize)}) · ${dispLabel}</p>`,
            style: CONST.CHAT_MESSAGE_STYLES.OTHER,
            whisper: [this.ctx.gmUserId]
          });
        } catch {
        }
      } else {
        warn(`createEmbeddedDocuments returned no token for "${actorName}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Token placement threw for "${actorName}": ${msg}`, err);
    }
  }
  // ── Timers ──────────────────────────────────────────────────────────
  startPingLoop() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }
  sendPing() {
    if (this.status !== "connected" || !this.socket) return;
    if (this.pendingPingId !== null) {
      warn("previous ping got no pong — forcing reconnect");
      try {
        this.socket.close(4e3, "ping timeout");
      } catch {
      }
      return;
    }
    const ping = makeMessage("ping", {});
    this.pendingPingId = ping.id;
    this.socket.send(JSON.stringify(ping));
    debug(`→ ping (${ping.id})`);
  }
  scheduleReconnect() {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const jitter = this.backoffMs * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.max(100, Math.round(this.backoffMs + jitter));
    info(`reconnecting in ${delay}ms (backoff=${this.backoffMs}ms)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      this.connect();
    }, delay);
  }
  clearTimers() {
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
const MAX_DIM = 2048;
const DEFAULT_QUALITY = 0.85;
async function captureViewportSnapshot() {
  const scene = canvas.scene;
  if (!scene) {
    debug("snapshot: no active scene — skipping capture");
    return null;
  }
  const app = canvas.app;
  if (!app || !app.renderer || typeof app.renderer.extract?.base64 !== "function") {
    warn("snapshot: canvas.app.renderer.extract.base64 unavailable — skipping capture");
    return null;
  }
  const target = canvas.stage ?? app.stage;
  if (!target) {
    warn("snapshot: canvas.stage unavailable — skipping capture");
    return null;
  }
  try {
    const started = Date.now();
    let dataUrl = await app.renderer.extract.base64(target, "image/jpeg", DEFAULT_QUALITY);
    const [viewW, viewH] = canvas.screenDimensions ?? [0, 0];
    let width = viewW || scene.dimensions?.width || 0;
    let height = viewH || scene.dimensions?.height || 0;
    if (width > MAX_DIM || height > MAX_DIM) {
      const downscaled = await downscaleDataUrl(dataUrl, MAX_DIM, DEFAULT_QUALITY);
      if (downscaled) {
        dataUrl = downscaled.dataUrl;
        width = downscaled.width;
        height = downscaled.height;
      }
    }
    const durationMs = Date.now() - started;
    const approxBytes = Math.floor(dataUrl.length * 3 / 4);
    debug(`snapshot: captured scene="${scene.name}" ${width}x${height} (~${approxBytes}B, ${durationMs}ms)`);
    return {
      dataUrl,
      width: width || MAX_DIM,
      height: height || MAX_DIM,
      gridSize: scene.grid.size,
      sceneId: scene.id,
      sceneName: scene.name
    };
  } catch (err) {
    warn(`snapshot: extract.base64 failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
async function downscaleDataUrl(dataUrl, maxDim, quality) {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvasEl = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : (() => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    })();
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvasEl instanceof OffscreenCanvas ? await canvasEl.convertToBlob({ type: "image/jpeg", quality }) : await new Promise((resolve) => {
      canvasEl.toBlob(resolve, "image/jpeg", quality);
    });
    if (!out) return null;
    const reader = new FileReader();
    const dataUrlOut = await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(out);
    });
    return { dataUrl: dataUrlOut, width: w, height: h };
  } catch (err) {
    warn(`snapshot: downscale failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}
const MODULE_ID$1 = "stablepiggy-napoleon-game-assistant";
const RESPONSE_TIMEOUT_MS = 18e4;
function registerChatCommand(client) {
  const sessionId = computeSessionId();
  const proto = ui.chat.constructor.prototype;
  const original = proto.processMessage;
  if (typeof original !== "function") {
    error(
      "could not locate ChatLog.prototype.processMessage — /napoleon command will not be available"
    );
    return;
  }
  proto.processMessage = async function(message, options) {
    const trimmed = typeof message === "string" ? message.trim() : "";
    const bare = "/napoleon";
    const isBare = trimmed === bare;
    const hasQuery = trimmed.startsWith(bare + " ") || trimmed.startsWith(bare + "	");
    if (!isBare && !hasQuery) {
      return original.call(this, message, options);
    }
    if (!game.user.isGM) {
      return original.call(this, message, options);
    }
    const query = isBare ? "" : trimmed.slice(bare.length).trim();
    if (query.length === 0) {
      ui.notifications.warn("Napoleon: query text was empty");
      return void 0;
    }
    await handleNapoleonQuery(client, sessionId, query);
    return void 0;
  };
  info(`chat command registered (sessionId=${sessionId})`);
}
async function handleNapoleonQuery(client, sessionId, query) {
  if (client.getStatus() !== "connected") {
    warn(
      `/napoleon typed while relay is ${client.getStatus()} — rendering error`
    );
    await renderErrorChat(
      "Napoleon is not connected to the relay. Check the module settings and reload the world."
    );
    return;
  }
  const placeholder = await ChatMessage.create({
    content: "<p><em>Napoleon is thinking…</em></p>",
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    speaker: { alias: "Napoleon" },
    whisper: [game.user.id],
    flags: {
      [MODULE_ID$1]: { placeholder: true }
    }
  });
  if (!placeholder?.id) {
    error("ChatMessage.create for placeholder returned no id");
    ui.notifications.error("Napoleon: failed to render placeholder message");
    return;
  }
  const snapshot = await captureViewportSnapshot();
  const queryId = client.sendQuery({
    sessionId,
    query,
    context: {
      // Tier 1 leaves these empty. M5 could plumb through game.scenes
      // .current?.id and selected actors, but the plan doesn't require
      // it and the backend stub doesn't use them yet.
      sceneId: null,
      selectedActorIds: [],
      inCombat: false,
      recentChat: []
    },
    ...snapshot ? { snapshot } : {}
  });
  if (queryId === null) {
    await safeUpdate(placeholder.id, {
      content: "<p><em>Napoleon: the relay dropped the query. Try again in a moment.</em></p>"
    });
    return;
  }
  client.registerPlaceholder(queryId, placeholder.id);
  debug(`placeholder registered: correlationId=${queryId}, msgId=${placeholder.id}`);
  setTimeout(() => {
    void expireIfPending(client, queryId, placeholder.id);
  }, RESPONSE_TIMEOUT_MS);
}
async function expireIfPending(client, correlationId, placeholderMsgId) {
  if (!client.hasPlaceholder(correlationId)) {
    return;
  }
  client.unregisterPlaceholder(correlationId);
  warn(`/napoleon query timed out after ${RESPONSE_TIMEOUT_MS}ms (correlationId=${correlationId})`);
  await safeUpdate(placeholderMsgId, {
    content: `<p><em>Napoleon: no response from the backend within ${Math.round(RESPONSE_TIMEOUT_MS / 1e3)} seconds. The relay or backend may be down, or your LLM provider is very slow — try a faster model via Pig Chat settings.</em></p>`
  });
}
async function renderErrorChat(text) {
  try {
    await ChatMessage.create({
      content: `<p><em>${escapeHtml(text)}</em></p>`,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      speaker: { alias: "Napoleon" },
      whisper: [game.user.id]
    });
  } catch (err) {
    error(
      `failed to render error chat: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
async function safeUpdate(messageId, data) {
  try {
    const msg = game.messages.get(messageId);
    if (!msg) {
      debug(`safeUpdate: message ${messageId} not found (deleted?)`);
      return;
    }
    await msg.update(data);
  } catch (err) {
    error(
      `safeUpdate failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function computeSessionId() {
  return `napoleon-${game.world.id}-${game.user.id}`;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const SEND_ATTR = "data-napoleon-send";
const PREFILL_ATTR = "data-napoleon-prefill";
const WIRED_FLAG = "napoleonWired";
function registerChatButtonHandlers(_client) {
  Hooks.on("renderChatMessageHTML", (_msg, html) => {
    const el = html;
    if (!el || typeof el.querySelectorAll !== "function") return;
    wireButtons(el);
  });
  info("chat button handlers registered");
}
function wireButtons(root) {
  const buttons = root.querySelectorAll(
    `[${SEND_ATTR}], [${PREFILL_ATTR}]`
  );
  if (buttons.length === 0) return;
  buttons.forEach((btn) => {
    if (btn.dataset[WIRED_FLAG] === "true") return;
    btn.dataset[WIRED_FLAG] = "true";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void handleClick(btn);
    });
  });
}
async function handleClick(btn) {
  const send = btn.getAttribute(SEND_ATTR);
  if (send !== null && send.length > 0) {
    debug(
      `napoleon-send click → /napoleon ${send.slice(0, 60)}${send.length > 60 ? "..." : ""}`
    );
    try {
      await ui.chat.constructor.prototype.processMessage.call(
        ui.chat,
        `/napoleon ${send}`
      );
    } catch (err) {
      error(
        `napoleon-send dispatch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }
  const prefill = btn.getAttribute(PREFILL_ATTR);
  if (prefill !== null && prefill.length > 0) {
    debug(`napoleon-prefill click → populating chat input`);
    const input = document.querySelector(
      "#chat-message"
    );
    if (!input) {
      error("napoleon-prefill: could not find chat input #chat-message");
      return;
    }
    input.value = `/napoleon ${prefill}`;
    input.focus();
    if ("setSelectionRange" in input) {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }
}
const NAPOLEON_ALIASES = /* @__PURE__ */ new Set(["napoleon", "napoleon (m2 stub)"]);
const MAX_CONTENT_LENGTH = 500;
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}
function classifyEvent(msg) {
  const speakerAlias = (msg.speaker?.alias ?? "").toLowerCase();
  const content = stripHtml(msg.content);
  if (content.startsWith("(") || content.toUpperCase().startsWith("[OOC]")) {
    return null;
  }
  if (NAPOLEON_ALIASES.has(speakerAlias)) {
    return "napoleon_exchange";
  }
  const isGM = msg.user?.isGM ?? false;
  if (isGM && msg.whisper.length > 0) {
    if (content.length > 0) {
      return "gm_whisper";
    }
    return null;
  }
  if (isGM && msg.isRoll) {
    const flavor = msg.flavor ?? "";
    if (content.length === 0 && flavor.length === 0) {
      return null;
    }
    return "roll";
  }
  if (isGM && game.combat?.active) {
    if (content.length > 0) {
      return "combat";
    }
  }
  return null;
}
function registerSessionCapture(client) {
  Hooks.on("createChatMessage", (rawMsg) => {
    const msg = rawMsg;
    const eventType = classifyEvent(msg);
    if (!eventType) return;
    const content = stripHtml(msg.content).slice(0, MAX_CONTENT_LENGTH);
    const speaker = msg.speaker?.alias ?? "Unknown";
    const payload = {
      eventType,
      timestamp: msg.timestamp ?? Date.now(),
      speaker,
      content,
      metadata: {
        worldId: game.world.id,
        ...game.scenes?.active?.id ? { sceneId: game.scenes.active.id } : {},
        ...game.combat?.active ? { combatRound: game.combat.round } : {}
      }
    };
    debug(`session capture: ${eventType} from ${speaker} (${content.slice(0, 40)}...)`);
    client.sendSessionEvent(payload);
  });
}
const MODULE_ID = "stablepiggy-napoleon-game-assistant";
const MODULE_VERSION = "0.0.1";
let relayClient = null;
Hooks.once("init", () => {
  info(
    `init (v${MODULE_VERSION}, protocol v${PROTOCOL_VERSION}) — registering settings`
  );
  registerSettings();
});
Hooks.once("ready", () => {
  if (!game.user.isGM) {
    debug("player session detected — relay connection is GM-only, skipping");
    return;
  }
  const foundryVersion = typeof game.version === "string" && game.version || typeof CONFIG?.Game?.version === "string" && CONFIG.Game.version || "unknown";
  const ctx = {
    worldId: game.world.id,
    gmUserId: game.user.id,
    // Tier 1 assumes a single GM per world — the `isPrimaryGM` flag in
    // the protocol exists for Tier 2+ multi-GM scenarios. For now we
    // always send true since only one GM connects.
    isPrimaryGM: true,
    foundryVersion,
    systemId: game.system.id,
    systemVersion: game.system.version
  };
  info(
    `ready (GM session) — worldId=${ctx.worldId}, system=${ctx.systemId}@${ctx.systemVersion}, foundry=${ctx.foundryVersion}`
  );
  relayClient = new RelayClient(ctx);
  relayClient.connect();
  registerChatCommand(relayClient);
  registerChatButtonHandlers();
  registerSessionCapture(relayClient);
});
Hooks.on("closeGame", () => {
  if (relayClient) {
    info("closeGame — shutting down relay client");
    relayClient.shutdown();
    relayClient = null;
  }
});
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("beforeunload", () => {
    if (relayClient) {
      relayClient.shutdown();
      relayClient = null;
    }
  });
}
globalThis.stablepiggyNapoleon = {
  moduleId: MODULE_ID,
  moduleVersion: MODULE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  getClient: () => relayClient
};
//# sourceMappingURL=main.js.map
