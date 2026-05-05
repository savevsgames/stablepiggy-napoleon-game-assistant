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

// Foundry global: ui.notifications is the toast/notification surface
// shown to the user (GM by default; players see info-level only).
// Available once the world has loaded; access from earlier hooks (e.g.
// `init`) is unsafe. The optional-chained call shape + try/catch makes
// every usage non-throwing — if the API isn't available, we skip the
// notification and the console log still records the message.
declare const ui: {
  notifications?: {
    info(message: string, opts?: { permanent?: boolean }): void;
    warn(message: string, opts?: { permanent?: boolean }): void;
    error(message: string, opts?: { permanent?: boolean }): void;
  };
};

/**
 * Surface a message to the GM via Foundry's `ui.notifications`. Use for
 * problems the GM needs to act on (missing module settings, relay
 * rejecting auth, relay unreachable) — distinct from `info/warn/error`
 * above which only land in the F12 console.
 *
 * `persistent` defaults to `true` because the V2 loud-failure UX
 * (FOUNDRY-HARNESS-V2 §3.2) wants notifications that survive page
 * reload and require explicit dismissal — the default ~5 second toast
 * is too easy to miss during world-load chatter. Pass `false` for
 * non-blocking transient hints.
 *
 * Always also calls the matching console-log helper so the message
 * lands in F12 even if the notifications surface isn't available
 * (e.g. called too early in init, or stubbed in tests).
 */
export function notifyGm(
  level: "info" | "warn" | "error",
  message: string,
  persistent: boolean = true,
): void {
  // Mirror to console first — runs unconditionally, never throws.
  if (level === "error") error(message);
  else if (level === "warn") warn(message);
  else info(message);

  // Surface to user. Foundry's ui.notifications throws if called before
  // the world is ready; try/catch keeps callers stateless.
  try {
    const opts = persistent ? { permanent: true } : undefined;
    if (level === "error") ui?.notifications?.error(message, opts);
    else if (level === "warn") ui?.notifications?.warn(message, opts);
    else ui?.notifications?.info(message, opts);
  } catch {
    // ui.notifications unavailable — console log already happened above
  }
}
