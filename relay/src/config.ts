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
   * Shared secret verified against the `Authorization: Bearer <token>` header
   * on WebSocket upgrade. REQUIRED — the relay refuses to start without it.
   */
  readonly sharedSecret: string;
  /**
   * URL of the StablePiggy backend's Foundry query endpoint. Optional in M2
   * (stub mode); required in M6 when the real backend integration lands.
   */
  readonly backendUrl: string;
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

function required(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.error(`[relay] FATAL: missing required env var ${name}`);
    exit(1);
  }
  return value;
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

export function loadConfig(): Config {
  return {
    port: parseIntEnv("RELAY_PORT", 8080),
    bindAddress: optional("RELAY_BIND_ADDRESS", "0.0.0.0"),
    sharedSecret: required("RELAY_SHARED_SECRET"),
    backendUrl: optional("RELAY_BACKEND_URL", ""),
    backendToken: optional("RELAY_BACKEND_TOKEN", ""),
    logLevel: optional("RELAY_LOG_LEVEL", "info"),
    pingIntervalMs: parseIntEnv("RELAY_PING_INTERVAL_SECONDS", 30) * 1000,
  };
}
