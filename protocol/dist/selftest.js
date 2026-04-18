/**
 * Protocol v1 self-test
 *
 * Run via `npm run test` at the repo root or `npm run test -w
 * @stablepiggy-napoleon/protocol`. Exits with code 0 on success, 1 on any
 * failure.
 *
 * This is a minimal hand-rolled test harness — no Jest, no Vitest, no ts-node.
 * The protocol is small enough that a single file of assertions gives us the
 * coverage we need for Step 1. We'll move to Vitest if the contract grows
 * beyond what one file can comfortably hold.
 *
 * Test cases cover:
 *   - Envelope validation (version, id, ts, kind, payload required)
 *   - Each message kind's payload validation (valid + invalid cases)
 *   - Error code correctness (validation_failed vs protocol_mismatch vs
 *     unknown_kind)
 *   - makeMessage() helper produces messages that validate cleanly
 *   - makeMessageId() produces 16-char alphanumeric IDs
 */
import { PROTOCOL_VERSION, ProtocolError, makeMessage, makeMessageId, validateMessage, } from "./index.js";
// ============================================================================
// Test harness
// ============================================================================
let passed = 0;
let failed = 0;
function pass(name) {
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name, reason) {
    failed++;
    // eslint-disable-next-line no-console
    console.error(`  \x1b[31m✗\x1b[0m ${name}`);
    // eslint-disable-next-line no-console
    console.error(`    ${reason}`);
}
function assertAccepts(name, input) {
    try {
        validateMessage(input);
        pass(name);
    }
    catch (err) {
        fail(name, `expected to validate but threw: ${err.message}`);
    }
}
function assertRejects(name, input, expectedCode) {
    try {
        validateMessage(input);
        fail(name, "expected to throw but returned successfully");
    }
    catch (err) {
        if (!(err instanceof ProtocolError)) {
            fail(name, `expected ProtocolError but got ${err.name}`);
            return;
        }
        if (err.code !== expectedCode) {
            fail(name, `expected code "${expectedCode}" but got "${err.code}": ${err.message}`);
            return;
        }
        pass(name);
    }
}
function section(name) {
    // eslint-disable-next-line no-console
    console.log(`\n\x1b[1m${name}\x1b[0m`);
}
// ============================================================================
// Fixture builders
// ============================================================================
function validHelloPayload() {
    return {
        protocolVersion: PROTOCOL_VERSION,
        authToken: "dev-test-secret-do-not-ship",
        worldId: "blood-lords-test",
        gmUserId: "user-abc123",
        isPrimaryGM: true,
        moduleVersion: "0.0.1",
        capabilities: {
            chatCreate: true,
            actorCreate: true,
            journalCreate: true,
            systemId: "pf2e",
            systemVersion: "7.12.1",
            foundryVersion: "13.351",
        },
    };
}
function validQueryPayload() {
    return {
        sessionId: "session-xyz",
        query: "what does grapple do",
        context: {
            sceneId: null,
            selectedActorIds: [],
            inCombat: false,
            recentChat: [],
        },
    };
}
function validChatCreatePayload() {
    return {
        correlationId: null,
        speaker: { alias: "Napoleon" },
        content: "<p>The grapple action...</p>",
        type: "whisper",
        whisperTo: ["user-abc123"],
    };
}
function validActorCreatePayload() {
    return {
        correlationId: null,
        actor: { name: "Test NPC", type: "npc" },
    };
}
function validJournalCreatePayload() {
    return {
        correlationId: null,
        name: "Session 1 Prep",
        pages: [
            {
                name: "Overview",
                type: "text",
                text: { content: "<p>Session overview.</p>", format: 1 },
            },
        ],
    };
}
// ============================================================================
// Tests
// ============================================================================
// eslint-disable-next-line no-console
console.log("\n\x1b[1mProtocol v1 self-test\x1b[0m");
section("Envelope validation");
{
    assertRejects("rejects null input", null, "validation_failed");
    assertRejects("rejects non-object input", "a string", "validation_failed");
    assertRejects("rejects array input", [], "validation_failed");
    assertRejects("rejects wrong protocol version", { v: 99, id: "x", ts: 0, kind: "ping", payload: {} }, "protocol_mismatch");
    assertRejects("rejects empty id", { v: 1, id: "", ts: 0, kind: "ping", payload: {} }, "validation_failed");
    assertRejects("rejects non-numeric ts", { v: 1, id: "x", ts: "now", kind: "ping", payload: {} }, "validation_failed");
    assertRejects("rejects missing kind", { v: 1, id: "x", ts: 0, payload: {} }, "validation_failed");
    assertRejects("rejects missing payload", { v: 1, id: "x", ts: 0, kind: "ping" }, "validation_failed");
    assertRejects("rejects unknown kind", { v: 1, id: "x", ts: 0, kind: "mystery.kind", payload: {} }, "unknown_kind");
}
section("ping / pong");
{
    assertAccepts("ping with empty payload", makeMessage("ping", {}));
    assertAccepts("pong with pingId", makeMessage("pong", { pingId: "abc" }));
    assertRejects("pong missing pingId", makeMessage("pong", { pingId: "" }), "validation_failed");
}
section("client.hello");
{
    assertAccepts("valid hello", makeMessage("client.hello", validHelloPayload()));
    const missingWorldId = validHelloPayload();
    delete missingWorldId.worldId;
    assertRejects("rejects hello missing worldId", makeMessage("client.hello", missingWorldId), "validation_failed");
    const missingAuthToken = validHelloPayload();
    delete missingAuthToken.authToken;
    assertRejects("rejects hello missing authToken", makeMessage("client.hello", missingAuthToken), "validation_failed");
    const emptyAuthToken = validHelloPayload();
    assertRejects("rejects hello with empty authToken", makeMessage("client.hello", { ...emptyAuthToken, authToken: "" }), "validation_failed");
    const wrongProtocolVersion = validHelloPayload();
    assertRejects("rejects hello with mismatched protocol version in payload", makeMessage("client.hello", { ...wrongProtocolVersion, protocolVersion: 99 }), "validation_failed");
    const badCapabilities = validHelloPayload();
    assertRejects("rejects hello with non-boolean capability", makeMessage("client.hello", {
        ...badCapabilities,
        capabilities: { ...badCapabilities.capabilities, chatCreate: "yes" },
    }), "validation_failed");
}
section("relay.welcome");
{
    assertAccepts("valid welcome", makeMessage("relay.welcome", {
        protocolVersion: PROTOCOL_VERSION,
        relayVersion: "0.0.1",
        backendAvailable: true,
        serverTime: Date.now(),
    }));
}
section("client.query");
{
    assertAccepts("valid query", makeMessage("client.query", validQueryPayload()));
    const emptyQuery = validQueryPayload();
    assertRejects("rejects empty query string", makeMessage("client.query", { ...emptyQuery, query: "" }), "validation_failed");
    const badContext = validQueryPayload();
    assertRejects("rejects query with non-array selectedActorIds", makeMessage("client.query", {
        ...badContext,
        context: { ...badContext.context, selectedActorIds: "not-an-array" },
    }), "validation_failed");
}
section("backend.chat.create");
{
    assertAccepts("valid chat.create", makeMessage("backend.chat.create", validChatCreatePayload()));
    const badType = validChatCreatePayload();
    assertRejects("rejects chat.create with invalid type", makeMessage("backend.chat.create", {
        ...badType,
        type: "shout",
    }), "validation_failed");
}
section("backend.actor.create");
{
    assertAccepts("valid actor.create", makeMessage("backend.actor.create", validActorCreatePayload()));
    assertRejects("rejects actor.create with non-object actor", makeMessage("backend.actor.create", {
        correlationId: null,
        actor: "not-an-actor",
    }), "validation_failed");
}
section("backend.journal.create");
{
    assertAccepts("valid journal.create", makeMessage("backend.journal.create", validJournalCreatePayload()));
    const emptyPages = validJournalCreatePayload();
    assertRejects("rejects journal.create with empty pages array", makeMessage("backend.journal.create", { ...emptyPages, pages: [] }), "validation_failed");
    const wrongFormat = validJournalCreatePayload();
    assertRejects("rejects journal.create with non-HTML page format", makeMessage("backend.journal.create", {
        ...wrongFormat,
        pages: [
            {
                name: "Bad",
                type: "text",
                text: { content: "x", format: 2 },
            },
        ],
    }), "validation_failed");
}
section("error");
{
    assertAccepts("valid error message", makeMessage("error", { code: "validation_failed", message: "test error" }));
    assertAccepts("valid error message with correlationId", makeMessage("error", {
        code: "rate_limited",
        message: "too many queries",
        correlationId: "original-id",
    }));
}
section("makeMessage / makeMessageId helpers");
{
    const id1 = makeMessageId();
    const id2 = makeMessageId();
    if (id1.length === 16 && id2.length === 16 && id1 !== id2 && /^[A-Za-z0-9]+$/.test(id1)) {
        pass("makeMessageId produces 16-char alphanumeric, non-colliding");
    }
    else {
        fail("makeMessageId produces 16-char alphanumeric, non-colliding", `id1=${id1} id2=${id2}`);
    }
    const msg = makeMessage("ping", {});
    if (msg.v === PROTOCOL_VERSION && typeof msg.ts === "number" && msg.kind === "ping") {
        pass("makeMessage populates envelope correctly");
    }
    else {
        fail("makeMessage populates envelope correctly", JSON.stringify(msg));
    }
}
// ============================================================================
// Summary
// ============================================================================
// eslint-disable-next-line no-console
console.log(`\n\x1b[1mResults:\x1b[0m ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
    process.exit(1);
}
//# sourceMappingURL=selftest.js.map