/**
 * StablePiggy Napoleon Game Assistant — Foundry module entry point
 *
 * Pre-alpha stub (Step 0). Tier 1 build steps replace this with:
 *   - Step 3: settings registration (relay endpoint, auth token), WebSocket
 *     client connecting to the configured relay, ping/pong loop, reconnection
 *   - Step 4: `chat.create` command handler
 *   - Step 5: `/napoleon` chat command interceptor + "thinking" indicator
 *   - Step 6: real AI backend wiring (relay no longer uses fake backend)
 *   - Step 7: `actor.create` and `journal.create` handlers, error handling,
 *     Test Connection button in settings
 *
 * See planning/phase2-tier1-plan.md §4.1 for the full Module Track build
 * sequence.
 */

import { PROTOCOL_VERSION } from "@stablepiggy-napoleon/protocol";

// Minimal Foundry global declarations for Step 0. Step 3 replaces these with
// the community-maintained @league-of-foundry-developers/foundry-vtt-types
// package once we know which v13/v14 types release matches our Foundry target.
declare const Hooks: {
  once(event: string, callback: () => void): void;
};

declare const game: {
  user: { isGM: boolean };
};

const MODULE_ID = "stablepiggy-napoleon-game-assistant";

Hooks.once("init", () => {
  // eslint-disable-next-line no-console
  console.log(
    `${MODULE_ID} | init (pre-alpha 0.0.1, protocol v${PROTOCOL_VERSION})`
  );
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  // eslint-disable-next-line no-console
  console.log(
    `${MODULE_ID} | ready (GM session detected; relay connection lands in Tier 1 Step 3)`
  );
});
