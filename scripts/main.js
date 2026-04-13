/**
 * StablePiggy Napoleon Game Assistant — module entry point
 *
 * This file is a pre-alpha stub. Tier 1 implementation lands here:
 *   - Foundry hook registration
 *   - WebSocket client connection to the configured relay
 *   - /napoleon chat command registration
 *   - Command protocol handlers (chat.create, actor.create, journal.create)
 *   - Settings registration for relay endpoint and auth token
 *
 * See docs/architecture.md for the module ↔ relay ↔ backend design.
 */

/* globals Hooks, game, CONFIG */

const MODULE_ID = "stablepiggy-napoleon-game-assistant";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init (pre-alpha 0.0.1 — functional behavior lands in 0.1.0 Tier 1)`);
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  console.log(`${MODULE_ID} | ready (GM session detected; relay connection TBD in Tier 1)`);
});
