/**
 * StablePiggy Napoleon Game Assistant — Foundry module entry point.
 *
 * Wires the M3 plumbing together:
 *   - `init` hook: register module settings (see settings.ts)
 *   - `ready` hook: if the current user is a GM, construct a RelayClient
 *     with the Foundry world/user/system context and call connect()
 *   - `closeGame` (or unload) path: call client.shutdown() so the
 *     socket closes cleanly instead of timing out
 *
 * The relay client handles its own reconnect backoff and ping loop —
 * main.ts only owns lifecycle (create / connect / shutdown) and the
 * Foundry-global → client-context translation.
 *
 * ## Future milestones attached to this file
 *
 *   - M4: once backend.chat.create handlers land in relay-client.ts,
 *     main.ts doesn't need to change — the client wiring is the same.
 *   - M5: `/napoleon` chat command integration will register a new
 *     `chatMessage` hook in chat-command.ts and call
 *     `relayClient.sendQuery(...)` from there.
 *   - M7: Test Connection button in settings will import the client
 *     reference exposed below.
 *
 * Typed against Foundry VTT v13.351. The declared `Hooks` / `game`
 * surface here covers only what this file touches — sibling files
 * (settings.ts, relay-client.ts) declare their own subsets per the
 * project's per-file typing convention. See docs/foundry-conventions.md.
 */

import { PROTOCOL_VERSION } from "@stablepiggy-napoleon/protocol";

import { info, debug } from "./log.js";
import { registerSettings } from "./settings.js";
import { RelayClient, type RelayClientContext } from "./relay-client.js";
import { registerChatCommand } from "./chat-command.js";
import { registerChatButtonHandlers } from "./chat-buttons.js";
import { registerSessionCapture } from "./session-capture.js";

const MODULE_ID = "stablepiggy-napoleon-game-assistant";
const MODULE_VERSION = "0.0.1";

// Foundry globals this file touches. Kept minimal and hand-rolled per
// docs/foundry-conventions.md §2. When adding new Foundry API calls
// here, extend these interfaces in place.

declare const Hooks: {
  once(event: string, callback: () => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
};

declare const game: {
  user: {
    readonly id: string;
    readonly isGM: boolean;
  };
  world: {
    readonly id: string;
  };
  system: {
    readonly id: string;
    readonly version: string;
  };
  // Foundry v13 exposes the core version string here as a bare field.
  // Some older builds instead stash it under CONFIG.Game.version — see
  // the fallback logic in the ready hook below.
  readonly version?: string;
};

declare const CONFIG: {
  Game?: { version?: string };
};

// Module-scoped singleton so later milestones (M5 chat command, M7 test
// connection) can reach it without plumbing a reference through every
// hook registration.
let relayClient: RelayClient | null = null;

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

  const foundryVersion =
    (typeof game.version === "string" && game.version) ||
    (typeof CONFIG?.Game?.version === "string" && CONFIG.Game.version) ||
    "unknown";

  const ctx: RelayClientContext = {
    worldId: game.world.id,
    gmUserId: game.user.id,
    // Tier 1 assumes a single GM per world — the `isPrimaryGM` flag in
    // the protocol exists for Tier 2+ multi-GM scenarios. For now we
    // always send true since only one GM connects.
    isPrimaryGM: true,
    foundryVersion,
    systemId: game.system.id,
    systemVersion: game.system.version,
  };

  info(
    `ready (GM session) — worldId=${ctx.worldId}, system=${ctx.systemId}@${ctx.systemVersion}, foundry=${ctx.foundryVersion}`
  );

  relayClient = new RelayClient(ctx);
  relayClient.connect();

  registerChatCommand(relayClient);
  registerChatButtonHandlers(relayClient);
  registerSessionCapture(relayClient);
});

// Clean shutdown on Foundry world close / page unload. Foundry v13 fires
// `closeGame` when the user returns to the setup screen. We also
// listen to `beforeunload` as a belt-and-suspenders for hard page
// reloads (F5) where closeGame may not fire in time.
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

// Re-exported for debugging from the F12 console. Not part of any
// public API — future milestones may remove this when the settings
// panel gains proper status indicators.
(globalThis as unknown as { stablepiggyNapoleon?: unknown }).stablepiggyNapoleon =
  {
    moduleId: MODULE_ID,
    moduleVersion: MODULE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    getClient: () => relayClient,
  };
