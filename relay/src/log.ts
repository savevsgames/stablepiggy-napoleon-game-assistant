/**
 * Structured logger for the relay service.
 *
 * Wraps pino with a dev-friendly pretty-print transport when NODE_ENV is not
 * "production". In production we emit JSON to stdout for log aggregation.
 */

import pino from "pino";
import type { Logger as PinoLogger } from "pino";

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    return pino({ level });
  }

  return pino({
    level,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    },
  });
}
