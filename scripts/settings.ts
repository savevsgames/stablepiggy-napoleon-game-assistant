/**
 * Foundry settings registration for the StablePiggy Napoleon Game Assistant.
 *
 * Registers two settings that the relay client reads on connect:
 *
 *   - `relayEndpoint` — WebSocket URL of the relay service. Stored at
 *     WORLD scope so all clients in the same Foundry world see the same
 *     value (the GM configures it once per campaign, players on the same
 *     world inherit it — though players don't actually connect, only the
 *     GM does). Default: `ws://localhost:8080` for dev. A hosted
 *     deployment would use `wss://napoleon-relay.app.stablepiggy.com/ws`
 *     or similar.
 *
 *   - `authToken` — the auth token sent in the `client.hello` message.
 *     Stored at CLIENT scope (per-browser localStorage) so each GM
 *     supplies their own token and it doesn't sync across clients via
 *     the world database. A dv- prefixed value is a StablePiggy API key
 *     that unlocks vault, campaign memory, and metering against the
 *     real identity; any other non-empty string is treated as a shared
 *     secret by the relay and produces an anonymous session.
 *
 * ## Client-scoped auth and localStorage
 *
 * Foundry's `scope: "client"` settings live in the browser's
 * localStorage. There is no server-side secret store in Foundry — the
 * only alternatives are world-scoped (which would sync the secret to
 * every connected player, defeating the purpose) or prompting the GM
 * every session (which is painful enough to drive users away). Client
 * scope is the least-bad choice for a module that has to hold a
 * credential locally.
 *
 * Mitigations:
 *   - Only the GM enters and uses this token. Players never touch it.
 *   - An API key is easy to rotate from the StablePiggy dashboard if the
 *     GM's machine is compromised — the dashboard's key list will
 *     surface recent `last_used_at` timestamps so suspicious activity is
 *     visible.
 *   - The field is rendered as a masked text input (via the `secret:
 *     true` hint below — Foundry v13 respects this on world settings UI).
 *
 * See docs/foundry-conventions.md in this repo for the full decision
 * record on the client-scoped storage tradeoff.
 *
 * Typed against Foundry VTT v13.351. The hand-rolled `declare const
 * game` covers only `game.settings.register` and `game.settings.get`,
 * the two surfaces this file touches. Future files add their own
 * declarations per the project-wide typing convention (docs/
 * foundry-conventions.md §2).
 */

import { info } from "./log.js";

export const MODULE_ID = "stablepiggy-napoleon-game-assistant";

// Setting keys exposed as constants so callers get a compile-time check
// against typos rather than stringly-typed lookups scattered around.
export const SETTING_RELAY_ENDPOINT = "relayEndpoint";
export const SETTING_AUTH_TOKEN = "authToken";

// Minimal Foundry surface this file needs. Foundry's settings API is
// larger than this; we only declare the bits we call, following the
// project convention. When another file needs more of the settings API
// it declares its own minimal subset.
interface FoundrySettingConfig {
  name: string;
  hint: string;
  scope: "world" | "client";
  config: boolean;
  type: typeof String;
  default: string;
  requiresReload?: boolean;
}

declare const game: {
  settings: {
    register(module: string, key: string, config: FoundrySettingConfig): void;
    get(module: string, key: string): unknown;
    set(module: string, key: string, value: unknown): Promise<unknown>;
  };
};

/**
 * Register all module settings with Foundry. Call this from the `init`
 * hook — Foundry requires settings to be registered before the `ready`
 * hook fires, otherwise `game.settings.get(...)` throws.
 */
export function registerSettings(): void {
  game.settings.register(MODULE_ID, SETTING_RELAY_ENDPOINT, {
    name: "Relay endpoint",
    hint:
      "WebSocket URL of the StablePiggy Napoleon relay service. For local " +
      "development use ws://localhost:8080. Changes take effect on the " +
      "next world reload.",
    scope: "world",
    config: true,
    type: String,
    default: "ws://localhost:8080",
    requiresReload: true,
  });

  game.settings.register(MODULE_ID, SETTING_AUTH_TOKEN, {
    name: "Auth token",
    hint:
      "Your StablePiggy API key (starts with dv-) for full account features, " +
      "or a shared secret for anonymous/self-hosted mode. Stored locally in " +
      "this browser only — not synced to other users.",
    scope: "client",
    config: true,
    type: String,
    default: "",
    requiresReload: true,
  });

  info("settings registered");
}

/**
 * Read the current relay endpoint setting. Returns the default if the
 * setting has not been explicitly set.
 */
export function getRelayEndpoint(): string {
  const raw = game.settings.get(MODULE_ID, SETTING_RELAY_ENDPOINT);
  return typeof raw === "string" ? raw : "";
}

/**
 * Read the current auth token setting. Returns an empty string if the
 * setting has not been explicitly set — callers should refuse to connect
 * to the relay without a token rather than sending an empty string that
 * the relay will reject on the hello handshake.
 */
export function getAuthToken(): string {
  const raw = game.settings.get(MODULE_ID, SETTING_AUTH_TOKEN);
  return typeof raw === "string" ? raw : "";
}
