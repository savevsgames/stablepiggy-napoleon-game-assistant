/**
 * Logging helper for the StablePiggy Napoleon Game Assistant Foundry module.
 *
 * Tiny wrapper around `console.*` that prepends a `[stablepiggy-napoleon]`
 * tag so log lines from this module are easy to spot in the F12 console
 * among Foundry core's own chatter. Info / warn / error always emit;
 * `debug` is gated on a Foundry convention:
 *
 *   CONFIG.debug["stablepiggy-napoleon-game-assistant"] = true
 *
 * A user (or a second instance of this module in a dev setup) can flip
 * that flag from the browser console at runtime to get verbose output
 * without having to rebuild the module. This matches how Foundry's own
 * debug toggles work (e.g., `CONFIG.debug.hooks`, `CONFIG.debug.mouse`).
 *
 * Typed against Foundry VTT v13.351. The hand-rolled `declare const
 * CONFIG` covers only the surface this file touches — future milestones
 * can extend it per file as they touch new pieces of the Foundry API,
 * rather than pulling in the community types package which is ~50MB of
 * definitions most of which we don't need until Tier 3.
 */

const MODULE_ID = "stablepiggy-napoleon-game-assistant";
const PREFIX = `[stablepiggy-napoleon]`;

// Foundry global: CONFIG.debug is a plain object of boolean flags keyed by
// module/subsystem. Writing to a key that doesn't exist is harmless — Foundry
// exposes it as a live object so modules and users can add their own entries.
declare const CONFIG: {
  debug: Record<string, boolean | undefined>;
};

function debugEnabled(): boolean {
  // Guard against CONFIG being undefined in edge cases (very early init,
  // tests that stub Foundry's globals, etc.). If CONFIG isn't there we
  // simply treat debug as off.
  try {
    return CONFIG?.debug?.[MODULE_ID] === true;
  } catch {
    return false;
  }
}

export function info(message: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`${PREFIX} ${message}`, ...rest);
}

export function warn(message: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(`${PREFIX} ${message}`, ...rest);
}

export function error(message: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(`${PREFIX} ${message}`, ...rest);
}

export function debug(message: string, ...rest: unknown[]): void {
  if (!debugEnabled()) return;
  // eslint-disable-next-line no-console
  console.debug(`${PREFIX} ${message}`, ...rest);
}
