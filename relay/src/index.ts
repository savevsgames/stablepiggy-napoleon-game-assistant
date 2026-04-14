/**
 * StablePiggy Napoleon Game Assistant — relay service entry point
 *
 * Loads configuration from environment variables, starts the WebSocket
 * relay server, and installs graceful-shutdown handlers for SIGINT/SIGTERM.
 *
 * See planning/phase2-tier1-plan.md §4.1 Step 2 for the M2 scope and
 * smoke-test procedure. See relay/README.md for deployment notes and
 * relay/.env.example for the full list of supported environment variables.
 */

import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { startServer } from "./server.js";

const config = loadConfig();
const log = createLogger(config.logLevel);

log.info(
  {
    nodeVersion: process.version,
    logLevel: config.logLevel,
  },
  "relay starting"
);

const server = startServer(config, log);

// ── Graceful shutdown ──

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutdown signal received");
  try {
    await server.close();
    log.info("relay stopped cleanly");
    process.exit(0);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "shutdown failed"
    );
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("uncaughtException", (err) => {
  log.fatal(
    { err: err.message, stack: err.stack },
    "uncaught exception — exiting"
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.fatal(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    "unhandled promise rejection — exiting"
  );
  process.exit(1);
});
