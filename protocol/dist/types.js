/**
 * Protocol v1 — message types and runtime validation
 *
 * This file is the SINGLE source of truth for the WebSocket message contract
 * between the StablePiggy Napoleon Game Assistant Foundry module and the
 * relay service. Both packages import from here. Adding a new message kind
 * requires updating this file and implementing handlers in BOTH the module
 * (../scripts) and the relay (../relay/src). TypeScript's discriminated
 * union narrowing will catch any drift between them at compile time.
 *
 * Wire format: each message is a single JSON object matching the
 * `ProtocolMessage` discriminated union. The union is keyed on `kind` so
 * handlers can narrow the type with a `switch (msg.kind)` statement.
 *
 * Runtime validation: the relay calls `validateMessage(input)` on every
 * inbound WebSocket frame after JSON parsing. Invalid messages throw a
 * `ProtocolError` with a specific code; the relay catches these and sends
 * back an `error` message with the same code and the correlation id of the
 * offending message.
 *
 * See planning/phase2-tier1-plan.md §3 for the full protocol specification.
 */
// ============================================================================
// Protocol version
// ============================================================================
/**
 * The current protocol version. Both the module and the relay declare this
 * version on connect via `client.hello` / `relay.welcome`. Version mismatches
 * are fatal — the relay rejects the connection with a `protocol_mismatch`
 * error, and the module shows a "please update" notice in its settings panel.
 */
export const PROTOCOL_VERSION = 1;
/**
 * Structured protocol error. Thrown by `validateMessage()` and by relay
 * handlers when they need to report a failure back to the client as a
 * protocol `error` message. The `correlationId` field points at the message
 * that caused the error, if any.
 */
export class ProtocolError extends Error {
    code;
    correlationId;
    name = "ProtocolError";
    constructor(code, message, correlationId) {
        super(message);
        this.code = code;
        this.correlationId = correlationId;
    }
}
// ============================================================================
// Message construction helpers
// ============================================================================
/**
 * Generate a 16-character alphanumeric message ID using a cryptographically
 * strong random source (Web Crypto API, available in Node 18+ and all modern
 * browsers). The ID space is 62^16 ≈ 4.77e28, collision probability is
 * negligible for any realistic session length.
 */
export function makeMessageId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let id = "";
    for (let i = 0; i < 16; i++) {
        // Modulo bias is negligible (62 / 256 ≈ 4% per byte, no security impact).
        id += chars[bytes[i] % 62];
    }
    return id;
}
/**
 * Construct a protocol message with a fresh ID and current timestamp. The
 * generic parameter `K` is narrowed from the `kind` argument, so the
 * `payload` parameter is checked against the correct payload type at
 * compile time.
 *
 * @example
 * const msg = makeMessage("ping", {});
 * const hello = makeMessage("client.hello", {
 *   protocolVersion: PROTOCOL_VERSION,
 *   authToken: "dv-...",           // or shared secret
 *   worldId: "my-world",
 *   gmUserId: "user-123",
 *   isPrimaryGM: true,
 *   moduleVersion: "0.1.0",
 *   capabilities: { ... }
 * });
 */
export function makeMessage(kind, payload) {
    const msg = {
        v: PROTOCOL_VERSION,
        id: makeMessageId(),
        ts: Date.now(),
        kind,
        payload,
    };
    // Cast is safe because `kind` narrows `PayloadFor<K>`, so the constructed
    // object satisfies the narrowed union variant by construction.
    return msg;
}
// ============================================================================
// Runtime validation
// ============================================================================
/**
 * Internal assertion helper. Throws a `ProtocolError` with `validation_failed`
 * if `condition` is false.
 */
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
/**
 * Validate the envelope fields shared by all messages. Throws on failure.
 * Returns the raw message cast to the envelope shape for further validation.
 */
function validateEnvelope(input) {
    assert(isPlainObject(input), "message", "an object");
    const raw = input;
    if (raw.v !== PROTOCOL_VERSION) {
        throw new ProtocolError("protocol_mismatch", `expected protocol version ${PROTOCOL_VERSION}, got ${String(raw.v)}`, typeof raw.id === "string" ? raw.id : undefined);
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
        payload: raw.payload,
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
function validateQueryPayload(payload, correlationId) {
    assert(isNonEmptyString(payload.sessionId), "payload.sessionId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.query), "payload.query", "non-empty string", correlationId);
    validateQueryContext(payload.context, correlationId);
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
    assert(payload.type === "ic" ||
        payload.type === "ooc" ||
        payload.type === "whisper" ||
        payload.type === "emote", "payload.type", "one of ic|ooc|whisper|emote", correlationId);
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
const VALID_SESSION_EVENT_TYPES = new Set([
    "roll",
    "napoleon_exchange",
    "combat",
    "gm_whisper",
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
/**
 * Validate an arbitrary value (usually the result of `JSON.parse()` on a
 * WebSocket frame) against the protocol v1 message contract. Throws a
 * `ProtocolError` with a specific code on failure; returns the input
 * narrowed to `ProtocolMessage` on success.
 *
 * The relay calls this on every inbound frame after JSON parsing. Errors
 * produced by this function are converted by the relay's error handler
 * into outbound `error` messages sent back to the offending client.
 *
 * @throws {ProtocolError} with `code: "validation_failed"` for structural
 *   errors, `"protocol_mismatch"` for version errors, or `"unknown_kind"`
 *   for unknown message kinds.
 */
export function validateMessage(input) {
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
        case "ping":
            // PingPayload is empty — no further validation needed.
            break;
        case "pong":
            validatePongPayload(payload, id);
            break;
        case "error":
            validateErrorPayload(payload, id);
            break;
        default: {
            // Exhaustiveness check: if a new MessageKind is added to the union
            // without a case here, TypeScript will fail to compile because `kind`
            // will not be `never`.
            const exhaustive = kind;
            throw new ProtocolError("unknown_kind", `unknown message kind: ${String(exhaustive)}`, id);
        }
    }
    return input;
}
//# sourceMappingURL=types.js.map