#!/usr/bin/env node
/**
 * P2 smoke test — drives the full transport chain:
 *
 *   this script → local relay (ws://localhost:8080)
 *                    → VPS backend (https://app.stablepiggy.com/api/my/foundry/query)
 *                    → P2 stub response → back through the relay → printed here
 *
 * Prerequisites:
 *   1. Relay running locally: `cd relay && npm run build && npm start`
 *   2. Relay `.env` has RELAY_BACKEND_URL + RELAY_BACKEND_TOKEN set to the VPS
 *   3. VPS has DEVVAULT_FOUNDRY_RELAY_TOKEN set to the same value as RELAY_BACKEND_TOKEN
 *
 * Usage:
 *   RELAY_SHARED_SECRET=<secret> node scripts/p2-smoke-test.mjs
 *   (or export it in your shell first)
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8080";
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET;

if (!SHARED_SECRET) {
  console.error("FATAL: RELAY_SHARED_SECRET env var must be set (same value as relay/.env)");
  process.exit(1);
}

const TEST_IDENTITY_ID = process.env.TEST_IDENTITY_ID ?? "smoke-test-gm";
const TEST_WORLD_ID = process.env.TEST_WORLD_ID ?? "smoke-test-world";
const TEST_SESSION_ID = `smoke-${Date.now()}`;

function makeMessage(kind, payload) {
  return {
    protocolVersion: 1,
    messageId: randomUUID(),
    timestamp: Date.now(),
    kind,
    payload,
  };
}

const ws = new WebSocket(RELAY_URL, {
  headers: { Authorization: `Bearer ${SHARED_SECRET}` },
});

let gotWelcome = false;
let gotResponse = false;
const startedAt = Date.now();

const timeout = setTimeout(() => {
  console.error("\nFAIL: timed out after 15s without receiving a backend response");
  process.exit(1);
}, 15000);

ws.on("open", () => {
  console.log(`[${Date.now() - startedAt}ms] connected to ${RELAY_URL}`);
  const hello = makeMessage("client.hello", {
    identityId: TEST_IDENTITY_ID,
    worldId: TEST_WORLD_ID,
    capabilities: {
      chatCreate: true,
      actorCreate: true,
      journalCreate: true,
      systemId: "pf2e",
      systemVersion: "7.12.1",
      foundryVersion: "13.351",
    },
  });
  console.log(`[${Date.now() - startedAt}ms] → client.hello (identity=${TEST_IDENTITY_ID})`);
  ws.send(JSON.stringify(hello));
});

ws.on("message", (raw) => {
  const elapsed = Date.now() - startedAt;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (err) {
    console.error(`[${elapsed}ms] FAIL: non-JSON message from relay:`, raw.toString());
    process.exit(1);
  }

  console.log(`[${elapsed}ms] ← ${msg.kind}`);

  if (msg.kind === "relay.welcome") {
    gotWelcome = true;
    const query = makeMessage("client.query", {
      sessionId: TEST_SESSION_ID,
      query: "Smoke test: give me a 1-sentence scene description.",
      context: {
        sceneId: null,
        selectedActorIds: [],
        inCombat: false,
        recentChat: [],
      },
    });
    console.log(`[${elapsed}ms] → client.query (session=${TEST_SESSION_ID})`);
    ws.send(JSON.stringify(query));
    return;
  }

  if (msg.kind === "backend.chat.create") {
    gotResponse = true;
    console.log("\n=== backend.chat.create payload ===");
    console.log(JSON.stringify(msg.payload, null, 2));
    console.log("===================================\n");
    console.log(`PASS: full round-trip in ${elapsed}ms`);
    clearTimeout(timeout);
    ws.close(1000, "smoke test complete");
    return;
  }

  if (msg.kind === "error") {
    console.error(`\nFAIL: relay returned error:`, msg.payload);
    clearTimeout(timeout);
    process.exit(1);
  }
});

ws.on("close", (code, reason) => {
  console.log(`[${Date.now() - startedAt}ms] connection closed (code=${code}, reason="${reason}")`);
  if (!gotWelcome) {
    console.error("FAIL: never received relay.welcome");
    process.exit(1);
  }
  if (!gotResponse) {
    console.error("FAIL: never received backend.chat.create");
    process.exit(1);
  }
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`[${Date.now() - startedAt}ms] websocket error:`, err.message);
  process.exit(1);
});
