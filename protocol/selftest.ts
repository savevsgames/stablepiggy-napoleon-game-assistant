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

import {
  PROTOCOL_VERSION,
  ProtocolError,
  makeMessage,
  makeMessageId,
  validateMessage,
} from "./index.js";
import type {
  ClientHelloPayload,
  ClientQueryPayload,
  BackendChatCreatePayload,
  BackendActorCreatePayload,
  BackendJournalCreatePayload,
  BackendWallCreatePayload,
  BackendLightCreatePayload,
  BackendSceneUpdatePayload,
  BackendModuleContentRequestPayload,
  ClientModuleContentResponsePayload,
  ClientAdventureIngestionRequestPayload,
  ClientAdventureIngestionDeclineRequestPayload,
  WorldContent,
} from "./index.js";

// ============================================================================
// Test harness
// ============================================================================

let passed = 0;
let failed = 0;

function pass(name: string): void {
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function fail(name: string, reason: string): void {
  failed++;
  // eslint-disable-next-line no-console
  console.error(`  \x1b[31m✗\x1b[0m ${name}`);
  // eslint-disable-next-line no-console
  console.error(`    ${reason}`);
}

function assertAccepts(name: string, input: unknown): void {
  try {
    validateMessage(input);
    pass(name);
  } catch (err) {
    fail(name, `expected to validate but threw: ${(err as Error).message}`);
  }
}

function assertRejects(
  name: string,
  input: unknown,
  expectedCode: string
): void {
  try {
    validateMessage(input);
    fail(name, "expected to throw but returned successfully");
  } catch (err) {
    if (!(err instanceof ProtocolError)) {
      fail(name, `expected ProtocolError but got ${(err as Error).name}`);
      return;
    }
    if (err.code !== expectedCode) {
      fail(name, `expected code "${expectedCode}" but got "${err.code}": ${err.message}`);
      return;
    }
    pass(name);
  }
}

function section(name: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

// ============================================================================
// Fixture builders
// ============================================================================

function validHelloPayload(): ClientHelloPayload {
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

function validQueryPayload(): ClientQueryPayload {
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

function validWorldContent(): WorldContent {
  return {
    actors: [
      { id: "actor-1", name: "Drowned Guard", type: "npc", level: 2, folder: "Chapter 2" },
      { id: "actor-2", name: "GM Notes", type: "loot" },
    ],
    scenes: [
      { id: "scene-1", name: "A1 — Gauntlight Keep", active: true, folder: "Chapter 1" },
      { id: "scene-2", name: "B3 — The Drowned Hall", active: false },
    ],
    journals: [
      { id: "journal-1", name: "Chapter 1 Overview", folder: "Chapter 1", pageCount: 4 },
      { id: "journal-2", name: "Errata Notes" },
    ],
    items: [
      { id: "item-1", name: "+1 Striking Rapier", type: "weapon" },
      { id: "item-2", name: "Healing Potion", type: "consumable", folder: "Loot" },
    ],
    modules: [
      { id: "pf2e.abomination-vaults", title: "Pathfinder Adventure Path: Abomination Vaults", active: true, version: "2.1.0" },
      { id: "pf2e", title: "Pathfinder 2e", active: true },
    ],
  };
}

function validChatCreatePayload(): BackendChatCreatePayload {
  return {
    correlationId: null,
    speaker: { alias: "Napoleon" },
    content: "<p>The grapple action...</p>",
    type: "whisper",
    whisperTo: ["user-abc123"],
  };
}

function validActorCreatePayload(): BackendActorCreatePayload {
  return {
    correlationId: null,
    actor: { name: "Test NPC", type: "npc" },
  };
}

function validJournalCreatePayload(): BackendJournalCreatePayload {
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

function validWallCreatePayload(): BackendWallCreatePayload {
  return {
    correlationId: null,
    c: [100, 200, 100, 400],
    move: 1,
    sense: 1,
    sound: 0,
    door: 0,
  };
}

function validLightCreatePayload(): BackendLightCreatePayload {
  return {
    correlationId: null,
    x: 500,
    y: 500,
    dim: 200,
    bright: 100,
  };
}

function validSceneUpdatePayload(): BackendSceneUpdatePayload {
  return {
    correlationId: null,
    globalLight: false,
    darkness: 0.5,
    tokenVision: true,
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
  assertRejects(
    "rejects wrong protocol version",
    { v: 99, id: "x", ts: 0, kind: "ping", payload: {} },
    "protocol_mismatch"
  );
  assertRejects(
    "rejects empty id",
    { v: 1, id: "", ts: 0, kind: "ping", payload: {} },
    "validation_failed"
  );
  assertRejects(
    "rejects non-numeric ts",
    { v: 1, id: "x", ts: "now", kind: "ping", payload: {} },
    "validation_failed"
  );
  assertRejects(
    "rejects missing kind",
    { v: 1, id: "x", ts: 0, payload: {} },
    "validation_failed"
  );
  assertRejects(
    "rejects missing payload",
    { v: 1, id: "x", ts: 0, kind: "ping" },
    "validation_failed"
  );
  assertRejects(
    "rejects unknown kind",
    { v: 1, id: "x", ts: 0, kind: "mystery.kind", payload: {} },
    "unknown_kind"
  );
}

section("ping / pong");
{
  assertAccepts("ping with empty payload", makeMessage("ping", {}));
  assertAccepts("pong with pingId", makeMessage("pong", { pingId: "abc" }));
  assertRejects(
    "pong missing pingId",
    makeMessage("pong", { pingId: "" }),
    "validation_failed"
  );
}

section("client.hello");
{
  assertAccepts("valid hello", makeMessage("client.hello", validHelloPayload()));

  const missingWorldId = validHelloPayload() as unknown as Record<string, unknown>;
  delete missingWorldId.worldId;
  assertRejects(
    "rejects hello missing worldId",
    makeMessage("client.hello", missingWorldId as unknown as ClientHelloPayload),
    "validation_failed"
  );

  const missingAuthToken = validHelloPayload() as unknown as Record<string, unknown>;
  delete missingAuthToken.authToken;
  assertRejects(
    "rejects hello missing authToken",
    makeMessage("client.hello", missingAuthToken as unknown as ClientHelloPayload),
    "validation_failed"
  );

  const emptyAuthToken = validHelloPayload();
  assertRejects(
    "rejects hello with empty authToken",
    makeMessage("client.hello", { ...emptyAuthToken, authToken: "" }),
    "validation_failed"
  );

  const wrongProtocolVersion = validHelloPayload();
  assertRejects(
    "rejects hello with mismatched protocol version in payload",
    makeMessage("client.hello", { ...wrongProtocolVersion, protocolVersion: 99 as unknown as typeof PROTOCOL_VERSION }),
    "validation_failed"
  );

  const badCapabilities = validHelloPayload();
  assertRejects(
    "rejects hello with non-boolean capability",
    makeMessage("client.hello", {
      ...badCapabilities,
      capabilities: { ...badCapabilities.capabilities, chatCreate: "yes" as unknown as boolean },
    }),
    "validation_failed"
  );
}

section("relay.welcome");
{
  assertAccepts(
    "valid welcome",
    makeMessage("relay.welcome", {
      protocolVersion: PROTOCOL_VERSION,
      relayVersion: "0.0.1",
      backendAvailable: true,
      serverTime: Date.now(),
    })
  );
}

section("client.query");
{
  assertAccepts("valid query", makeMessage("client.query", validQueryPayload()));

  const emptyQuery = validQueryPayload();
  assertRejects(
    "rejects empty query string",
    makeMessage("client.query", { ...emptyQuery, query: "" }),
    "validation_failed"
  );

  const badContext = validQueryPayload();
  assertRejects(
    "rejects query with non-array selectedActorIds",
    makeMessage("client.query", {
      ...badContext,
      context: { ...badContext.context, selectedActorIds: "not-an-array" as unknown as readonly string[] },
    }),
    "validation_failed"
  );

  // V2 Phase 4 — worldContent
  const queryWithWorld = validQueryPayload();
  assertAccepts(
    "valid query with populated worldContent",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: { ...queryWithWorld.context, worldContent: validWorldContent() },
    })
  );
  assertAccepts(
    "valid query with worldContent: null (no Foundry session)",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: { ...queryWithWorld.context, worldContent: null },
    })
  );
  assertAccepts(
    "valid query with empty worldContent arrays",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: { actors: [], scenes: [], journals: [], items: [], modules: [] },
      },
    })
  );
  assertRejects(
    "rejects worldContent.actors with missing id",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          actors: [{ name: "Nameless", type: "npc" } as unknown as WorldContent["actors"][number]],
        },
      },
    }),
    "validation_failed"
  );
  assertRejects(
    "rejects worldContent.actors with non-numeric level",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          actors: [{ id: "a1", name: "Bad Level", type: "npc", level: "two" as unknown as number }],
        },
      },
    }),
    "validation_failed"
  );
  assertRejects(
    "rejects worldContent.scenes with non-boolean active",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          scenes: [{ id: "s1", name: "Bad Active", active: "yes" as unknown as boolean }],
        },
      },
    }),
    "validation_failed"
  );
  assertRejects(
    "rejects worldContent missing the journals array",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          actors: [],
          scenes: [],
          items: [],
          modules: [],
        } as unknown as WorldContent,
      },
    }),
    "validation_failed"
  );
  assertRejects(
    "rejects worldContent.modules with missing title",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          modules: [{ id: "pf2e.av", active: true } as unknown as WorldContent["modules"][number]],
        },
      },
    }),
    "validation_failed"
  );
  // V2 Phase 4 Commit 5e — module.version is optional but must be a string when present.
  assertAccepts(
    "valid worldContent with module.version present",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          modules: [{ id: "pf2e.av", title: "AV", active: true, version: "3.0.0" }],
        },
      },
    })
  );
  assertAccepts(
    "valid worldContent with module.version omitted",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          modules: [{ id: "pf2e.av", title: "AV", active: true }],
        },
      },
    })
  );
  assertRejects(
    "rejects worldContent.modules with non-string version",
    makeMessage("client.query", {
      ...queryWithWorld,
      context: {
        ...queryWithWorld.context,
        worldContent: {
          ...validWorldContent(),
          modules: [{ id: "pf2e.av", title: "AV", active: true, version: 3 as unknown as string }],
        },
      },
    }),
    "validation_failed"
  );
}

section("backend.chat.create");
{
  assertAccepts("valid chat.create", makeMessage("backend.chat.create", validChatCreatePayload()));

  const badType = validChatCreatePayload();
  assertRejects(
    "rejects chat.create with invalid type",
    makeMessage("backend.chat.create", {
      ...badType,
      type: "shout" as unknown as "ic",
    }),
    "validation_failed"
  );
}

section("backend.actor.create");
{
  assertAccepts("valid actor.create", makeMessage("backend.actor.create", validActorCreatePayload()));

  assertRejects(
    "rejects actor.create with non-object actor",
    makeMessage("backend.actor.create", {
      correlationId: null,
      actor: "not-an-actor" as unknown as Record<string, unknown>,
    }),
    "validation_failed"
  );
}

section("backend.journal.create");
{
  assertAccepts("valid journal.create", makeMessage("backend.journal.create", validJournalCreatePayload()));

  const emptyPages = validJournalCreatePayload();
  assertRejects(
    "rejects journal.create with empty pages array",
    makeMessage("backend.journal.create", { ...emptyPages, pages: [] }),
    "validation_failed"
  );

  const wrongFormat = validJournalCreatePayload();
  assertRejects(
    "rejects journal.create with non-HTML page format",
    makeMessage("backend.journal.create", {
      ...wrongFormat,
      pages: [
        {
          name: "Bad",
          type: "text",
          text: { content: "x", format: 2 as unknown as 1 },
        },
      ],
    }),
    "validation_failed"
  );
}

section("backend.wall.create (V2 Phase 3)");
{
  assertAccepts("valid wall.create", makeMessage("backend.wall.create", validWallCreatePayload()));

  const badCoords = validWallCreatePayload();
  assertRejects(
    "rejects wall.create with c of wrong length",
    makeMessage("backend.wall.create", { ...badCoords, c: [1, 2, 3] as unknown as readonly [number, number, number, number] }),
    "validation_failed"
  );

  assertRejects(
    "rejects wall.create with move=2 (only 0 or 1 allowed)",
    makeMessage("backend.wall.create", { ...validWallCreatePayload(), move: 2 }),
    "validation_failed"
  );

  assertRejects(
    "rejects wall.create with door=3 (only 0, 1, or 2 allowed)",
    makeMessage("backend.wall.create", { ...validWallCreatePayload(), door: 3 }),
    "validation_failed"
  );
}

section("backend.light.create (V2 Phase 3)");
{
  assertAccepts("valid light.create", makeMessage("backend.light.create", validLightCreatePayload()));

  assertRejects(
    "rejects light.create with bright > dim",
    makeMessage("backend.light.create", { ...validLightCreatePayload(), dim: 50, bright: 100 }),
    "validation_failed"
  );

  assertRejects(
    "rejects light.create with negative dim",
    makeMessage("backend.light.create", { ...validLightCreatePayload(), dim: -10 }),
    "validation_failed"
  );

  assertRejects(
    "rejects light.create with angle > 360",
    makeMessage("backend.light.create", { ...validLightCreatePayload(), angle: 361 }),
    "validation_failed"
  );
}

section("backend.scene.update (V2 Phase 3)");
{
  assertAccepts("valid scene.update", makeMessage("backend.scene.update", validSceneUpdatePayload()));

  assertAccepts(
    "valid scene.update with only sceneName + single field",
    makeMessage("backend.scene.update", { correlationId: null, sceneName: "market-square", darkness: 0.3 })
  );

  assertRejects(
    "rejects scene.update with no update fields (no-op guard)",
    makeMessage("backend.scene.update", { correlationId: null }),
    "validation_failed"
  );

  assertRejects(
    "rejects scene.update with darkness > 1",
    makeMessage("backend.scene.update", { ...validSceneUpdatePayload(), darkness: 1.5 }),
    "validation_failed"
  );
}

function validModuleContentRequestPayload(): BackendModuleContentRequestPayload {
  return {
    correlationId: "ingest-correl-1",
    adventureId: "abomination-vaults",
    packKeys: ["pf2e-abomination-vaults.av", "pf2e.abomination-vaults-bestiary"],
    versionManifestId: "pf2e-abomination-vaults",
  };
}

function validModuleContentResponsePayload(): ClientModuleContentResponsePayload {
  return {
    correlationId: "ingest-correl-1",
    adventureId: "abomination-vaults",
    journals: [
      {
        id: "j1",
        name: "Volume 1: Ruins of Gauntlight",
        folder: "Abomination Vaults",
        pages: [
          { id: "p1", name: "A01. Tarwynn Bridge", contentHtml: "<p>...</p>", sort: 100 },
          { id: "p10", name: "A10. Mudlicker Throne Room", contentHtml: "<p>...</p>", sort: 1000 },
        ],
      },
    ],
    items: [
      { id: "i1", name: "+1 Striking Rapier", type: "weapon", descriptionHtml: "<p>...</p>", folder: "Loot" },
    ],
    scenes: [
      { id: "s1", name: "A — Gauntlight Ruins", folder: "Chapter 1" },
    ],
    version: "2.1.0",
    counts: { journalEntries: 1, journalPages: 2, items: 1, scenes: 1 },
  };
}

section("backend.module_content.request (V2 Phase 4 Commit 5b)");
{
  assertAccepts(
    "valid module_content.request",
    makeMessage("backend.module_content.request", validModuleContentRequestPayload())
  );

  assertRejects(
    "rejects module_content.request with empty packKeys",
    makeMessage("backend.module_content.request", { ...validModuleContentRequestPayload(), packKeys: [] }),
    "validation_failed"
  );

  assertRejects(
    "rejects module_content.request with non-string packKey entry",
    makeMessage("backend.module_content.request", {
      ...validModuleContentRequestPayload(),
      packKeys: ["valid.pack", 42 as unknown as string],
    }),
    "validation_failed"
  );

  assertRejects(
    "rejects module_content.request with missing versionManifestId",
    makeMessage("backend.module_content.request", {
      correlationId: "c1",
      adventureId: "abomination-vaults",
      packKeys: ["pf2e-abomination-vaults.av"],
    } as unknown as BackendModuleContentRequestPayload),
    "validation_failed"
  );
}

section("client.module_content.response (V2 Phase 4 Commit 5b)");
{
  assertAccepts(
    "valid module_content.response (full AV-shaped payload)",
    makeMessage("client.module_content.response", validModuleContentResponsePayload())
  );

  assertAccepts(
    "valid module_content.response with empty arrays",
    makeMessage("client.module_content.response", {
      correlationId: "c1",
      adventureId: "abomination-vaults",
      journals: [],
      items: [],
      scenes: [],
      version: "1.0.0",
      counts: { journalEntries: 0, journalPages: 0, items: 0, scenes: 0 },
    })
  );

  assertRejects(
    "rejects response with non-array journals",
    makeMessage("client.module_content.response", {
      ...validModuleContentResponsePayload(),
      journals: "not an array" as unknown as ClientModuleContentResponsePayload["journals"],
    }),
    "validation_failed"
  );

  assertRejects(
    "rejects response with journal page missing sort",
    makeMessage("client.module_content.response", {
      ...validModuleContentResponsePayload(),
      journals: [
        {
          id: "j1",
          name: "Vol 1",
          pages: [{ id: "p1", name: "A01", contentHtml: "" } as unknown as ClientModuleContentResponsePayload["journals"][number]["pages"][number]],
        },
      ],
    }),
    "validation_failed"
  );

  assertRejects(
    "rejects response with negative count",
    makeMessage("client.module_content.response", {
      ...validModuleContentResponsePayload(),
      counts: { journalEntries: -1, journalPages: 0, items: 0, scenes: 0 },
    }),
    "validation_failed"
  );

  assertRejects(
    "rejects response with item missing type",
    makeMessage("client.module_content.response", {
      ...validModuleContentResponsePayload(),
      items: [{ id: "i1", name: "Mystery Item" } as unknown as ClientModuleContentResponsePayload["items"][number]],
    }),
    "validation_failed"
  );
}

function validAdventureIngestionRequest(): ClientAdventureIngestionRequestPayload {
  return {
    correlationId: "ingest-button-1",
    adventureId: "abomination-vaults",
    campaignId: "savevsgreg-av",
  };
}

function validAdventureIngestionDecline(): ClientAdventureIngestionDeclineRequestPayload {
  return {
    correlationId: "decline-button-1",
    adventureId: "abomination-vaults",
    campaignId: "savevsgreg-av",
  };
}

section("client.adventure_ingestion_request (V2 Phase 4 Commit 5d)");
{
  assertAccepts(
    "valid adventure_ingestion_request",
    makeMessage("client.adventure_ingestion_request", validAdventureIngestionRequest())
  );

  assertRejects(
    "rejects with empty adventureId",
    makeMessage("client.adventure_ingestion_request", { ...validAdventureIngestionRequest(), adventureId: "" }),
    "validation_failed"
  );

  assertRejects(
    "rejects with missing campaignId",
    makeMessage("client.adventure_ingestion_request", {
      correlationId: "c1",
      adventureId: "abomination-vaults",
    } as unknown as ClientAdventureIngestionRequestPayload),
    "validation_failed"
  );
}

section("client.adventure_ingestion_decline_request (V2 Phase 4 Commit 5d)");
{
  assertAccepts(
    "valid adventure_ingestion_decline_request",
    makeMessage("client.adventure_ingestion_decline_request", validAdventureIngestionDecline())
  );

  assertRejects(
    "rejects with empty correlationId",
    makeMessage("client.adventure_ingestion_decline_request", { ...validAdventureIngestionDecline(), correlationId: "" }),
    "validation_failed"
  );

  assertRejects(
    "rejects with non-string campaignId",
    makeMessage("client.adventure_ingestion_decline_request", {
      ...validAdventureIngestionDecline(),
      campaignId: 42 as unknown as string,
    }),
    "validation_failed"
  );
}

section("error");
{
  assertAccepts(
    "valid error message",
    makeMessage("error", { code: "validation_failed", message: "test error" })
  );
  assertAccepts(
    "valid error message with correlationId",
    makeMessage("error", {
      code: "rate_limited",
      message: "too many queries",
      correlationId: "original-id",
    })
  );
}

section("makeMessage / makeMessageId helpers");
{
  const id1 = makeMessageId();
  const id2 = makeMessageId();
  if (id1.length === 16 && id2.length === 16 && id1 !== id2 && /^[A-Za-z0-9]+$/.test(id1)) {
    pass("makeMessageId produces 16-char alphanumeric, non-colliding");
  } else {
    fail(
      "makeMessageId produces 16-char alphanumeric, non-colliding",
      `id1=${id1} id2=${id2}`
    );
  }

  const msg = makeMessage("ping", {});
  if (msg.v === PROTOCOL_VERSION && typeof msg.ts === "number" && msg.kind === "ping") {
    pass("makeMessage populates envelope correctly");
  } else {
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
