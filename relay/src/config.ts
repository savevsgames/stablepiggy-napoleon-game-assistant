/**
 * Environment configuration loader.
 *
 * All required env vars are validated at startup. Missing or malformed values
 * cause the process to exit with a clear error message — we fail fast rather
 * than let a misconfigured relay run and surface the problem later at first
 * request time.
 *
 * See ../.env.example for the full list of supported variables and their
 * semantics.
 */

import { exit } from "process";

export interface Config {
  /** TCP port the WebSocket server binds to. */
  readonly port: number;
  /** Bind address (default 0.0.0.0 for all interfaces). */
  readonly bindAddress: string;
  /**
   * Shared secret for anonymous auth. When set, clients can send any
   * matching string as `authToken` in their `client.hello` and connect as
   * a synthetic anonymous identity (no vault, no memory, no metering).
   * When empty, shared-secret mode is DISABLED — only StablePiggy API
   * keys (`dv-*`) are accepted. Hosted relay deployments should leave
   * this empty; self-hosted operators can set it to any non-empty string.
   */
  readonly sharedSecret: string;
  /**
   * When true, the relay refuses shared-secret auth even if sharedSecret
   * is set — any `authToken` that doesn't start with `dv-` is rejected at
   * hello time with a 1008 close. Set this on hosted deployments to force
   * StablePiggy account usage. Default: false (shared secrets allowed).
   */
  readonly requireApiKey: boolean;
  /**
   * URL of the StablePiggy backend's Foundry query endpoint. Optional in M2
   * (stub mode); required in M6 when the real backend integration lands.
   */
  readonly backendUrl: string;
  /**
   * URL of the backend's identity resolution endpoint. Called on hello when
   * the auth token looks like a StablePiggy API key. If empty, the relay
   * derives it from `backendUrl` by replacing the final `/query` segment
   * with `/identity` — which matches the default deployment layout. Set
   * this explicitly if your backend routes the two endpoints differently.
   */
  readonly backendIdentityUrl: string;
  /**
   * Bearer token the relay sends to the backend on every query. Optional in
   * M2 (stub mode); required alongside backendUrl in M6.
   */
  readonly backendToken: string;
  /** Pino log level: debug, info, warn, error, fatal. */
  readonly logLevel: string;
  /**
   * Application-level ping interval in milliseconds. Tier 1 sets this from
   * RELAY_PING_INTERVAL_SECONDS (default 30s). Not yet exercised in M2 — the
   * ping/pong handlers respond to client-initiated pings but the relay does
   * not currently send unsolicited pings.
   */
  readonly pingIntervalMs: number;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    // eslint-disable-next-line no-console
    console.error(`[relay] FATAL: env var ${name} must be an integer, got ${raw}`);
    exit(1);
  }
  return parsed;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) {
    return fallback;
  }
  const lowered = raw.trim().toLowerCase();
  if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
  if (lowered === "false" || lowered === "0" || lowered === "no") return false;
  // eslint-disable-next-line no-console
  console.error(`[relay] FATAL: env var ${name} must be a boolean, got ${raw}`);
  exit(1);
}

function deriveIdentityUrl(queryUrl: string): string {
  if (queryUrl.length === 0) return "";
  // Replace a trailing `/query` segment with `/identity`. Tolerate an
  // optional trailing slash. If the URL doesn't end in `/query` at all,
  // fall back to appending — the operator can override via
  // RELAY_BACKEND_IDENTITY_URL if the layout differs.
  const trimmed = queryUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/query")) {
    return trimmed.slice(0, -"/query".length) + "/identity";
  }
  return trimmed + "/identity";
}

export function loadConfig(): Config {
  const backendUrl = optional("RELAY_BACKEND_URL", "");
  const explicitIdentityUrl = optional("RELAY_BACKEND_IDENTITY_URL", "");
  return {
    port: parseIntEnv("RELAY_PORT", 8080),
    bindAddress: optional("RELAY_BIND_ADDRESS", "0.0.0.0"),
    // Shared secret is now optional. Empty string means shared-secret
    // mode is disabled — the relay will only accept dv- API keys.
    sharedSecret: optional("RELAY_SHARED_SECRET", ""),
    requireApiKey: parseBoolEnv("RELAY_REQUIRE_API_KEY", false),
    backendUrl,
    backendIdentityUrl: explicitIdentityUrl || deriveIdentityUrl(backendUrl),
    backendToken: optional("RELAY_BACKEND_TOKEN", ""),
    logLevel: optional("RELAY_LOG_LEVEL", "info"),
    pingIntervalMs: parseIntEnv("RELAY_PING_INTERVAL_SECONDS", 30) * 1000,
  };
}
