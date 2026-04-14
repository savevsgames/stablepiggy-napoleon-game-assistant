#!/usr/bin/env node
/**
 * M2.1 + P2.1 smoke test — drives the full transport chain in three modes:
 *
 *   this script → local relay (ws://localhost:8080)
 *                    → VPS backend
 *                    → P2 stub response → back through the relay → printed here
 *
 * Three modes, selected via --mode flag:
 *
 *   --mode=anon     (default) send hello with shared-secret authToken, expect
 *                   round-trip success with a synthetic anon:<world>:<gm>
 *                   identity visible in the echoed stub response.
 *
 *   --mode=apikey   send hello with a StablePiggy API key (requires
 *                   STABLEPIGGY_API_KEY env var). Expect round-trip success
 *                   with the real identity ID visible in the stub response.
 *
 *   --mode=bad      send hello with a deliberately wrong shared secret.
 *                   Expect the relay to close the socket with code 1008
 *                   within 3 seconds.
 *
 * Prerequisites:
 *   1. Relay running locally: `cd relay && npm run build && npm start`
 *   2. relay/.env has RELAY_BACKEND_URL, RELAY_BACKEND_TOKEN, and
 *      RELAY_SHARED_SECRET set
 *   3. VPS deployed with the P2 + P2.1 routes
 *   4. For --mode=apikey: STABLEPIGGY_API_KEY exported in this shell
 *
 * Usage examples:
 *   RELAY_SHARED_SECRET=... node scripts/p2-smoke-test.mjs --mode=anon
 *   RELAY_SHARED_SECRET=... STABLEPIGGY_API_KEY=dv-... node scripts/p2-smoke-test.mjs --mode=apikey
 *   RELAY_SHARED_SECRET=... node scripts/p2-smoke-test.mjs --mode=bad
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";

// ── Arg parsing ─────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const MODE = args.mode ?? "anon";
if (!["anon", "apikey", "bad"].includes(MODE)) {
  console.error(`FATAL: invalid --mode=${MODE}, expected anon|apikey|bad`);
  process.exit(1);
}

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8080";
const SHARED_SECRET = process.env.RELAY_SHARED_SECRET;
const API_KEY = process.env.STABLEPIGGY_API_KEY;

if (MODE !== "apikey" && !SHARED_SECRET) {
  console.error("FATAL: RELAY_SHARED_SECRET env var must be set");
  process.exit(1);
}
if (MODE === "apikey" && !API_KEY) {
  console.error("FATAL: STABLEPIGGY_API_KEY env var must be set for --mode=apikey");
  process.exit(1);
}

const TEST_GM_USER_ID = process.env.TEST_GM_USER_ID ?? "smoke-test-gm";
const TEST_WORLD_ID = process.env.TEST_WORLD_ID ?? "smoke-test-world";
const TEST_SESSION_ID = `smoke-${Date.now()}`;

// ── Mode-specific setup ─────────────────────────────────────────────────

let authToken;
let expectClose1008 = false;
let expectSuccess = false;

switch (MODE) {
  case "anon":
    authToken = SHARED_SECRET;
    expectSuccess = true;
    break;
  case "apikey":
    authToken = API_KEY;
    expectSuccess = true;
    break;
  case "bad":
    authToken = "this-is-not-a-valid-token-at-all-1234567890";
    expectClose1008 = true;
    break;
}

console.log(`[smoke] mode=${MODE}, relay=${RELAY_URL}`);

// ── Message helpers ─────────────────────────────────────────────────────

function makeMessage(kind, payload) {
  return {
    v: 1,
    id: randomUUID(),
    ts: Date.now(),
    kind,
    payload,
  };
}

// ── Test driver ─────────────────────────────────────────────────────────

const ws = new WebSocket(RELAY_URL);
const startedAt = Date.now();

let gotWelcome = false;
let gotResponse = false;
let gotClose1008 = false;

const timeout = setTimeout(() => {
  console.error("\nFAIL: timed out after 15s");
  process.exit(1);
}, 15000);

ws.on("open", () => {
  console.log(`[${Date.now() - startedAt}ms] connected`);
  const hello = makeMessage("client.hello", {
    protocolVersion: 1,
    authToken,
    worldId: TEST_WORLD_ID,
    gmUserId: TEST_GM_USER_ID,
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
  });
  console.log(`[${Date.now() - startedAt}ms] → client.hello`);
  ws.send(JSON.stringify(hello));
});

ws.on("message", (raw) => {
  const elapsed = Date.now() - startedAt;
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.error(`[${elapsed}ms] FAIL: non-JSON message:`, raw.toString());
    process.exit(1);
  }

  console.log(`[${elapsed}ms] ← ${msg.kind}`);

  if (msg.kind === "relay.welcome") {
    gotWelcome = true;
    if (!expectSuccess) {
      console.error("FAIL: got relay.welcome in a mode that was supposed to be rejected");
      process.exit(1);
    }
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
    console.log(`[${elapsed}ms] → client.query`);
    ws.send(JSON.stringify(query));
    return;
  }

  if (msg.kind === "backend.chat.create") {
    gotResponse = true;
    console.log("\n=== backend.chat.create payload ===");
    console.log(JSON.stringify(msg.payload, null, 2));
    console.log("===================================\n");
    console.log(`PASS (${MODE}): full round-trip in ${elapsed}ms`);
    clearTimeout(timeout);
    ws.close(1000, "smoke test complete");
    return;
  }

  if (msg.kind === "error") {
    // In "bad" mode, we expect an error message followed by a 1008 close.
    // In "anon" / "apikey" modes, any error is a failure.
    if (expectClose1008) {
      console.log(`[${elapsed}ms] expected error payload:`, msg.payload);
      return;
    }
    console.error(`FAIL: unexpected relay error:`, msg.payload);
    clearTimeout(timeout);
    process.exit(1);
  }
});

ws.on("close", (code, reason) => {
  const elapsed = Date.now() - startedAt;
  console.log(
    `[${elapsed}ms] close (code=${code}, reason="${reason.toString("utf8")}")`
  );

  if (expectClose1008) {
    if (code === 1008) {
      console.log(`PASS (bad): relay closed with 1008 in ${elapsed}ms`);
      gotClose1008 = true;
      clearTimeout(timeout);
      process.exit(0);
    }
    console.error(`FAIL: expected close code 1008, got ${code}`);
    process.exit(1);
  }

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
});
