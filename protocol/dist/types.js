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
/**
 * Categories used under `Data/worlds/<world>/napoleon/<category>/` for
 * persisted Foundry world data (Phase B.4). Bounded set — if the GM has
 * content that doesn't fit the named slots, it goes in `gm/` as a
 * catch-all. Napoleon browses this tree via `worldFiles` on every query.
 */
export const WORLD_FILE_CATEGORIES = [
    "npcs",
    "scenes",
    "maps",
    "items",
    "journals",
    "gm",
];
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
    // sceneName is optional — older modules don't include it. Accept any
    // string or null when present; reject other types.
    if ("sceneName" in ctx && ctx.sceneName !== undefined) {
        assert(ctx.sceneName === null || typeof ctx.sceneName === "string", "context.sceneName", "string or null when present", correlationId);
    }
    // sceneDimensions is optional. When present + not null, all 7 numeric
    // fields must be finite. Omitted / null is the no-active-scene case.
    if ("sceneDimensions" in ctx && ctx.sceneDimensions !== undefined && ctx.sceneDimensions !== null) {
        assert(isPlainObject(ctx.sceneDimensions), "context.sceneDimensions", "an object", correlationId);
        const dims = ctx.sceneDimensions;
        for (const field of ["imageX", "imageY", "imageWidth", "imageHeight", "totalWidth", "totalHeight", "gridSize"]) {
            assert(typeof dims[field] === "number" && Number.isFinite(dims[field]), `context.sceneDimensions.${field}`, "finite number", correlationId);
        }
    }
    // worldContent is optional (V2 Phase 4). When present + not null, all
    // five summary arrays must exist with the correct entry shapes.
    // Module-side enumeration enforces the per-type soft caps; the
    // protocol layer only checks structure.
    if ("worldContent" in ctx && ctx.worldContent !== undefined && ctx.worldContent !== null) {
        validateWorldContent(ctx.worldContent, correlationId);
    }
    assert(isStringArray(ctx.selectedActorIds), "context.selectedActorIds", "string array", correlationId);
    assert(typeof ctx.inCombat === "boolean", "context.inCombat", "boolean", correlationId);
    assert(isStringArray(ctx.recentChat), "context.recentChat", "string array", correlationId);
}
function validateWorldContent(value, correlationId) {
    assert(isPlainObject(value), "context.worldContent", "an object", correlationId);
    const wc = value;
    assert(Array.isArray(wc.actors), "context.worldContent.actors", "array", correlationId);
    for (let i = 0; i < wc.actors.length; i++) {
        const a = wc.actors[i];
        assert(isPlainObject(a), `context.worldContent.actors[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(a.id), `context.worldContent.actors[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(a.name), `context.worldContent.actors[${i}].name`, "non-empty string", correlationId);
        assert(isNonEmptyString(a.type), `context.worldContent.actors[${i}].type`, "non-empty string", correlationId);
        if ("level" in a && a.level !== undefined) {
            assert(typeof a.level === "number" && Number.isFinite(a.level), `context.worldContent.actors[${i}].level`, "finite number when present", correlationId);
        }
        if ("folder" in a && a.folder !== undefined) {
            assert(typeof a.folder === "string", `context.worldContent.actors[${i}].folder`, "string when present", correlationId);
        }
    }
    assert(Array.isArray(wc.scenes), "context.worldContent.scenes", "array", correlationId);
    for (let i = 0; i < wc.scenes.length; i++) {
        const s = wc.scenes[i];
        assert(isPlainObject(s), `context.worldContent.scenes[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(s.id), `context.worldContent.scenes[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(s.name), `context.worldContent.scenes[${i}].name`, "non-empty string", correlationId);
        assert(typeof s.active === "boolean", `context.worldContent.scenes[${i}].active`, "boolean", correlationId);
        if ("folder" in s && s.folder !== undefined) {
            assert(typeof s.folder === "string", `context.worldContent.scenes[${i}].folder`, "string when present", correlationId);
        }
    }
    assert(Array.isArray(wc.journals), "context.worldContent.journals", "array", correlationId);
    for (let i = 0; i < wc.journals.length; i++) {
        const j = wc.journals[i];
        assert(isPlainObject(j), `context.worldContent.journals[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(j.id), `context.worldContent.journals[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(j.name), `context.worldContent.journals[${i}].name`, "non-empty string", correlationId);
        if ("folder" in j && j.folder !== undefined) {
            assert(typeof j.folder === "string", `context.worldContent.journals[${i}].folder`, "string when present", correlationId);
        }
        if ("pageCount" in j && j.pageCount !== undefined) {
            assert(typeof j.pageCount === "number" && Number.isFinite(j.pageCount), `context.worldContent.journals[${i}].pageCount`, "finite number when present", correlationId);
        }
    }
    assert(Array.isArray(wc.items), "context.worldContent.items", "array", correlationId);
    for (let i = 0; i < wc.items.length; i++) {
        const it = wc.items[i];
        assert(isPlainObject(it), `context.worldContent.items[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(it.id), `context.worldContent.items[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(it.name), `context.worldContent.items[${i}].name`, "non-empty string", correlationId);
        assert(isNonEmptyString(it.type), `context.worldContent.items[${i}].type`, "non-empty string", correlationId);
        if ("folder" in it && it.folder !== undefined) {
            assert(typeof it.folder === "string", `context.worldContent.items[${i}].folder`, "string when present", correlationId);
        }
    }
    assert(Array.isArray(wc.modules), "context.worldContent.modules", "array", correlationId);
    for (let i = 0; i < wc.modules.length; i++) {
        const m = wc.modules[i];
        assert(isPlainObject(m), `context.worldContent.modules[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(m.id), `context.worldContent.modules[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(m.title), `context.worldContent.modules[${i}].title`, "non-empty string", correlationId);
        assert(typeof m.active === "boolean", `context.worldContent.modules[${i}].active`, "boolean", correlationId);
        // V2 Phase 4 Commit 5e — version is optional. When present it
        // must be a string; format is up to the module's manifest.
        if ("version" in m && m.version !== undefined) {
            assert(typeof m.version === "string", `context.worldContent.modules[${i}].version`, "string when present", correlationId);
        }
    }
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
const VALID_WORLD_FILE_CATEGORIES = new Set(WORLD_FILE_CATEGORIES);
function validateWorldFiles(value, correlationId) {
    assert(Array.isArray(value), "payload.worldFiles", "array", correlationId);
    assert(value.length <= 1000, "payload.worldFiles.length", "<= 1000 (module truncates beyond this)", correlationId);
    for (let i = 0; i < value.length; i++) {
        const f = value[i];
        assert(isPlainObject(f), `worldFiles[${i}]`, "an object", correlationId);
        assert(isNonEmptyString(f.path), `worldFiles[${i}].path`, "non-empty string", correlationId);
        assert(typeof f.category === "string" && VALID_WORLD_FILE_CATEGORIES.has(f.category), `worldFiles[${i}].category`, "one of npcs|scenes|maps|items|journals|gm", correlationId);
        assert(isNonEmptyString(f.slug), `worldFiles[${i}].slug`, "non-empty string", correlationId);
        assert(typeof f.sizeBytes === "number" && f.sizeBytes >= 0, `worldFiles[${i}].sizeBytes`, "non-negative number", correlationId);
    }
}
function validateQueryPayload(payload, correlationId) {
    assert(isNonEmptyString(payload.sessionId), "payload.sessionId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.query), "payload.query", "non-empty string", correlationId);
    validateQueryContext(payload.context, correlationId);
    if (payload.snapshot !== undefined) {
        validateQuerySnapshot(payload.snapshot, correlationId);
    }
    if (payload.worldFiles !== undefined) {
        validateWorldFiles(payload.worldFiles, correlationId);
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
function validateWallCreatePayload(payload, correlationId) {
    assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
    assert(Array.isArray(payload.c), "payload.c", "array of 4 numbers", correlationId);
    const c = payload.c;
    assert(c.length === 4, "payload.c", "array of exactly 4 numbers", correlationId);
    for (let i = 0; i < 4; i++) {
        assert(typeof c[i] === "number" && Number.isFinite(c[i]), `payload.c[${i}]`, "finite number", correlationId);
    }
    for (const flag of ["move", "sense", "sound", "door"]) {
        assert(typeof payload[flag] === "number" && Number.isInteger(payload[flag]) && payload[flag] >= 0, `payload.${flag}`, "non-negative integer", correlationId);
    }
    // Sanity bounds — Foundry's actual flags are 0/1 (or 0/1/2 for door);
    // anything higher is meaningless. Reject early so a malformed backend
    // doesn't bloat scene documents with junk values.
    assert(payload.move <= 1, "payload.move", "0 or 1", correlationId);
    assert(payload.sense <= 1, "payload.sense", "0 or 1", correlationId);
    assert(payload.sound <= 1, "payload.sound", "0 or 1", correlationId);
    assert(payload.door <= 2, "payload.door", "0, 1, or 2", correlationId);
    if ("coordMode" in payload && payload.coordMode !== undefined) {
        assert(payload.coordMode === "image" || payload.coordMode === "scene", "payload.coordMode", "'image' or 'scene' when present", correlationId);
    }
    if ("sceneName" in payload) {
        assert(typeof payload.sceneName === "string", "payload.sceneName", "string when present", correlationId);
    }
}
function validateLightCreatePayload(payload, correlationId) {
    assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
    for (const field of ["x", "y", "dim", "bright"]) {
        assert(typeof payload[field] === "number" && Number.isFinite(payload[field]), `payload.${field}`, "finite number", correlationId);
    }
    assert(payload.dim >= 0, "payload.dim", "non-negative", correlationId);
    assert(payload.bright >= 0, "payload.bright", "non-negative", correlationId);
    assert(payload.bright <= payload.dim, "payload.bright", "<= payload.dim (bright is the inner fully-lit radius, dim is the outer dim-light radius)", correlationId);
    if ("angle" in payload) {
        assert(typeof payload.angle === "number" && Number.isFinite(payload.angle) && payload.angle >= 0 && payload.angle <= 360, "payload.angle", "number in [0, 360]", correlationId);
    }
    if ("rotation" in payload) {
        assert(typeof payload.rotation === "number" && Number.isFinite(payload.rotation), "payload.rotation", "finite number", correlationId);
    }
    if ("color" in payload) {
        assert(payload.color === null || typeof payload.color === "string", "payload.color", "string or null when present", correlationId);
    }
    if ("coordMode" in payload && payload.coordMode !== undefined) {
        assert(payload.coordMode === "image" || payload.coordMode === "scene", "payload.coordMode", "'image' or 'scene' when present", correlationId);
    }
    if ("sceneName" in payload) {
        assert(typeof payload.sceneName === "string", "payload.sceneName", "string when present", correlationId);
    }
}
function validateSceneUpdatePayload(payload, correlationId) {
    assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
    if ("sceneName" in payload) {
        assert(typeof payload.sceneName === "string", "payload.sceneName", "string when present", correlationId);
    }
    if ("globalLight" in payload) {
        assert(typeof payload.globalLight === "boolean", "payload.globalLight", "boolean when present", correlationId);
    }
    if ("darkness" in payload) {
        assert(typeof payload.darkness === "number" && Number.isFinite(payload.darkness) && payload.darkness >= 0 && payload.darkness <= 1, "payload.darkness", "number in [0, 1]", correlationId);
    }
    if ("tokenVision" in payload) {
        assert(typeof payload.tokenVision === "boolean", "payload.tokenVision", "boolean when present", correlationId);
    }
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
    // Reject no-op updates — every field missing means the backend emitted
    // a dead command. Self-correcting error instead of a silent no-op.
    const updateKeys = ["globalLight", "darkness", "tokenVision", "gridSize", "gridDistance", "gridUnits", "navigation"];
    const hasUpdate = updateKeys.some((k) => k in payload);
    assert(hasUpdate, "payload", `one of [${updateKeys.join(", ")}] to be present`, correlationId);
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
// ── Data upload validators (Phase B.4) ────────────────────────────────
/**
 * Validate a follow-up command nested inside `backend.data.upload`.
 * Dispatches to the same per-kind validators used at the envelope level
 * so we can't construct an invalid follow-up.
 */
function validateFollowUpCommand(value, correlationId) {
    assert(isPlainObject(value), "payload.followUp", "an object", correlationId);
    const f = value;
    assert(isNonEmptyString(f.kind), "followUp.kind", "non-empty string", correlationId);
    assert(isPlainObject(f.payload), "followUp.payload", "an object", correlationId);
    const fp = f.payload;
    switch (f.kind) {
        case "backend.chat.create":
            validateChatCreatePayload(fp, correlationId);
            break;
        case "backend.actor.create":
            validateActorCreatePayload(fp, correlationId);
            break;
        case "backend.actor.update":
            validateActorUpdatePayload(fp, correlationId);
            break;
        case "backend.journal.create":
            validateJournalCreatePayload(fp, correlationId);
            break;
        case "backend.rolltable.create":
            validateRollTableCreatePayload(fp, correlationId);
            break;
        case "backend.scene.create":
            validateSceneCreatePayload(fp, correlationId);
            break;
        case "backend.token.create":
            validateTokenCreatePayload(fp, correlationId);
            break;
        default:
            throw new ProtocolError("validation_failed", `followUp.kind: invalid backend command (got ${String(f.kind)})`, correlationId);
    }
}
function validateDataUploadPayload(payload, correlationId) {
    assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
    assert(isNonEmptyString(payload.signedUrl), "payload.signedUrl", "non-empty string", correlationId);
    assert(typeof payload.signedUrl === "string" && /^https?:\/\//.test(payload.signedUrl), "payload.signedUrl", "http(s) URL", correlationId);
    assert(isNonEmptyString(payload.targetPath), "payload.targetPath", "non-empty string", correlationId);
    assert(typeof payload.targetPath === "string" && payload.targetPath.startsWith("worlds/"), "payload.targetPath", "starts with 'worlds/' (per §4 path convention)", correlationId);
    if (payload.followUp !== undefined) {
        validateFollowUpCommand(payload.followUp, correlationId);
    }
}
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALID_TARGET_TYPES = new Set(["actor", "scene", "token", "journal", "save_only"]);
const VALID_TARGET_ACTIONS = new Set(["create", "update"]);
function validateBackendModuleContentRequestPayload(payload, correlationId) {
    assert(isNonEmptyString(payload.correlationId), "payload.correlationId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.adventureId), "payload.adventureId", "non-empty string", correlationId);
    assert(Array.isArray(payload.packKeys), "payload.packKeys", "array", correlationId);
    const packKeys = payload.packKeys;
    assert(packKeys.length > 0, "payload.packKeys.length", "non-empty array", correlationId);
    for (let i = 0; i < packKeys.length; i++) {
        assert(isNonEmptyString(packKeys[i]), `payload.packKeys[${i}]`, "non-empty string", correlationId);
    }
    assert(isNonEmptyString(payload.versionManifestId), "payload.versionManifestId", "non-empty string", correlationId);
}
function validateClientModuleContentResponsePayload(payload, correlationId) {
    assert(isNonEmptyString(payload.correlationId), "payload.correlationId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.adventureId), "payload.adventureId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.version), "payload.version", "non-empty string", correlationId);
    // Journals — array of entry-with-pages
    assert(Array.isArray(payload.journals), "payload.journals", "array", correlationId);
    for (let i = 0; i < payload.journals.length; i++) {
        const j = payload.journals[i];
        assert(isPlainObject(j), `payload.journals[${i}]`, "an object", correlationId);
        const jr = j;
        assert(isNonEmptyString(jr.id), `payload.journals[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(jr.name), `payload.journals[${i}].name`, "non-empty string", correlationId);
        if ("folder" in jr && jr.folder !== undefined) {
            assert(typeof jr.folder === "string", `payload.journals[${i}].folder`, "string when present", correlationId);
        }
        assert(Array.isArray(jr.pages), `payload.journals[${i}].pages`, "array", correlationId);
        for (let k = 0; k < jr.pages.length; k++) {
            const p = jr.pages[k];
            assert(isPlainObject(p), `payload.journals[${i}].pages[${k}]`, "an object", correlationId);
            const pr = p;
            assert(isNonEmptyString(pr.id), `payload.journals[${i}].pages[${k}].id`, "non-empty string", correlationId);
            assert(isNonEmptyString(pr.name), `payload.journals[${i}].pages[${k}].name`, "non-empty string", correlationId);
            assert(typeof pr.contentHtml === "string", `payload.journals[${i}].pages[${k}].contentHtml`, "string", correlationId);
            assert(typeof pr.sort === "number" && Number.isFinite(pr.sort), `payload.journals[${i}].pages[${k}].sort`, "finite number", correlationId);
        }
    }
    // Items
    assert(Array.isArray(payload.items), "payload.items", "array", correlationId);
    for (let i = 0; i < payload.items.length; i++) {
        const it = payload.items[i];
        assert(isPlainObject(it), `payload.items[${i}]`, "an object", correlationId);
        const ir = it;
        assert(isNonEmptyString(ir.id), `payload.items[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(ir.name), `payload.items[${i}].name`, "non-empty string", correlationId);
        assert(isNonEmptyString(ir.type), `payload.items[${i}].type`, "non-empty string", correlationId);
        if ("descriptionHtml" in ir && ir.descriptionHtml !== undefined) {
            assert(typeof ir.descriptionHtml === "string", `payload.items[${i}].descriptionHtml`, "string when present", correlationId);
        }
        if ("folder" in ir && ir.folder !== undefined) {
            assert(typeof ir.folder === "string", `payload.items[${i}].folder`, "string when present", correlationId);
        }
    }
    // Scenes (with optional pins per V2 Phase 4 Commit 6)
    assert(Array.isArray(payload.scenes), "payload.scenes", "array", correlationId);
    for (let i = 0; i < payload.scenes.length; i++) {
        const s = payload.scenes[i];
        assert(isPlainObject(s), `payload.scenes[${i}]`, "an object", correlationId);
        const sr = s;
        assert(isNonEmptyString(sr.id), `payload.scenes[${i}].id`, "non-empty string", correlationId);
        assert(isNonEmptyString(sr.name), `payload.scenes[${i}].name`, "non-empty string", correlationId);
        if ("description" in sr && sr.description !== undefined) {
            assert(typeof sr.description === "string", `payload.scenes[${i}].description`, "string when present", correlationId);
        }
        if ("folder" in sr && sr.folder !== undefined) {
            assert(typeof sr.folder === "string", `payload.scenes[${i}].folder`, "string when present", correlationId);
        }
        if ("pins" in sr && sr.pins !== undefined) {
            assert(Array.isArray(sr.pins), `payload.scenes[${i}].pins`, "array when present", correlationId);
            for (let k = 0; k < sr.pins.length; k++) {
                const p = sr.pins[k];
                assert(isPlainObject(p), `payload.scenes[${i}].pins[${k}]`, "an object", correlationId);
                const pr = p;
                assert(isNonEmptyString(pr.id), `payload.scenes[${i}].pins[${k}].id`, "non-empty string", correlationId);
                assert(isNonEmptyString(pr.entryId), `payload.scenes[${i}].pins[${k}].entryId`, "non-empty string", correlationId);
                if ("pageId" in pr && pr.pageId !== undefined) {
                    assert(typeof pr.pageId === "string", `payload.scenes[${i}].pins[${k}].pageId`, "string when present", correlationId);
                }
                if ("label" in pr && pr.label !== undefined) {
                    assert(typeof pr.label === "string", `payload.scenes[${i}].pins[${k}].label`, "string when present", correlationId);
                }
                if ("x" in pr && pr.x !== undefined) {
                    assert(typeof pr.x === "number" && Number.isFinite(pr.x), `payload.scenes[${i}].pins[${k}].x`, "finite number when present", correlationId);
                }
                if ("y" in pr && pr.y !== undefined) {
                    assert(typeof pr.y === "number" && Number.isFinite(pr.y), `payload.scenes[${i}].pins[${k}].y`, "finite number when present", correlationId);
                }
            }
        }
    }
    // Actors (V2 Phase 4 Commit 6 — bestiary lore, optional for backwards compat)
    if ("actors" in payload && payload.actors !== undefined) {
        assert(Array.isArray(payload.actors), "payload.actors", "array when present", correlationId);
        for (let i = 0; i < payload.actors.length; i++) {
            const a = payload.actors[i];
            assert(isPlainObject(a), `payload.actors[${i}]`, "an object", correlationId);
            const ar = a;
            assert(isNonEmptyString(ar.id), `payload.actors[${i}].id`, "non-empty string", correlationId);
            assert(isNonEmptyString(ar.name), `payload.actors[${i}].name`, "non-empty string", correlationId);
            assert(isNonEmptyString(ar.type), `payload.actors[${i}].type`, "non-empty string", correlationId);
            if ("descriptionHtml" in ar && ar.descriptionHtml !== undefined) {
                assert(typeof ar.descriptionHtml === "string", `payload.actors[${i}].descriptionHtml`, "string when present", correlationId);
            }
            if ("folder" in ar && ar.folder !== undefined) {
                assert(typeof ar.folder === "string", `payload.actors[${i}].folder`, "string when present", correlationId);
            }
        }
    }
    // Counts
    assert(isPlainObject(payload.counts), "payload.counts", "an object", correlationId);
    const counts = payload.counts;
    for (const field of ["journalEntries", "journalPages", "items", "scenes"]) {
        assert(typeof counts[field] === "number" && Number.isFinite(counts[field]) && counts[field] >= 0, `payload.counts.${field}`, "non-negative finite number", correlationId);
    }
    // counts.actors optional for backwards compat
    if ("actors" in counts && counts.actors !== undefined) {
        assert(typeof counts.actors === "number" && Number.isFinite(counts.actors) && counts.actors >= 0, "payload.counts.actors", "non-negative finite number when present", correlationId);
    }
}
/**
 * Shared validator for the two consent-flow payloads — both have the
 * same shape (correlationId + adventureId + campaignId).
 */
function validateAdventureConsentPayload(payload, correlationId) {
    assert(isNonEmptyString(payload.correlationId), "payload.correlationId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.adventureId), "payload.adventureId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.campaignId), "payload.campaignId", "non-empty string", correlationId);
}
function validateWorldSaveRequestPayload(payload, correlationId) {
    if ("correlationId" in payload && payload.correlationId !== undefined) {
        assert(typeof payload.correlationId === "string", "payload.correlationId", "string when present", correlationId);
    }
    assert(isNonEmptyString(payload.sessionId), "payload.sessionId", "non-empty string", correlationId);
    assert(isNonEmptyString(payload.barnPath), "payload.barnPath", "non-empty string", correlationId);
    assert(typeof payload.barnPath === "string" && !payload.barnPath.includes("..") && !payload.barnPath.startsWith("/"), "payload.barnPath", "Barn-relative path (no leading / and no '..')", correlationId);
    assert(typeof payload.category === "string" && VALID_WORLD_FILE_CATEGORIES.has(payload.category), "payload.category", "one of npcs|scenes|maps|items|journals|gm", correlationId);
    assert(typeof payload.slug === "string" && SLUG_PATTERN.test(payload.slug), "payload.slug", "kebab-case string (lowercase, digits, hyphens only)", correlationId);
    assert(typeof payload.targetType === "string" && VALID_TARGET_TYPES.has(payload.targetType), "payload.targetType", "one of actor|scene|token|journal|save_only", correlationId);
    assert(typeof payload.targetAction === "string" && VALID_TARGET_ACTIONS.has(payload.targetAction), "payload.targetAction", "one of create|update", correlationId);
    if ("params" in payload && payload.params !== undefined) {
        assert(isPlainObject(payload.params), "payload.params", "an object when present", correlationId);
    }
}
function validateDataUploadAckPayload(payload, correlationId) {
    assert(payload.correlationId === null || typeof payload.correlationId === "string", "payload.correlationId", "string or null", correlationId);
    assert(isNonEmptyString(payload.targetPath), "payload.targetPath", "non-empty string", correlationId);
    assert(typeof payload.ok === "boolean", "payload.ok", "boolean", correlationId);
    if ("error" in payload && payload.error !== undefined) {
        assert(typeof payload.error === "string", "payload.error", "string when present", correlationId);
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
        case "backend.scene.create":
            validateSceneCreatePayload(payload, id);
            break;
        case "backend.scene.update":
            validateSceneUpdatePayload(payload, id);
            break;
        case "backend.token.create":
            validateTokenCreatePayload(payload, id);
            break;
        case "backend.wall.create":
            validateWallCreatePayload(payload, id);
            break;
        case "backend.light.create":
            validateLightCreatePayload(payload, id);
            break;
        case "backend.data.upload":
            validateDataUploadPayload(payload, id);
            break;
        case "client.data_upload_ack":
            validateDataUploadAckPayload(payload, id);
            break;
        case "client.world_save_request":
            validateWorldSaveRequestPayload(payload, id);
            break;
        case "backend.module_content.request":
            validateBackendModuleContentRequestPayload(payload, id);
            break;
        case "client.module_content.response":
            validateClientModuleContentResponsePayload(payload, id);
            break;
        case "client.adventure_ingestion_request":
            validateAdventureConsentPayload(payload, id);
            break;
        case "client.adventure_ingestion_decline_request":
            validateAdventureConsentPayload(payload, id);
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