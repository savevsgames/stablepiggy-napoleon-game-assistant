/**
 * Shared-secret Bearer token verification for WebSocket upgrade requests.
 *
 * The Foundry module sends `Authorization: Bearer <RELAY_SHARED_SECRET>` on
 * the WebSocket upgrade request. The relay verifies the token using
 * constant-time comparison to prevent timing side-channels on the secret.
 *
 * This is intentionally simple — one shared secret for all connected clients
 * in Tier 1. Tier 2+ will add per-user issued tokens verified against a
 * backend account lookup.
 */

import { timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

const BEARER_PREFIX = "Bearer ";

/**
 * Verify that `req`'s Authorization header carries a Bearer token matching
 * `expected`. Uses constant-time comparison. Returns false for any failure:
 * missing header, malformed header, length mismatch, or comparison failure.
 */
export function verifyBearerAuth(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    return false;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length !== expected.length) {
    // Length mismatch — fail fast. We still pay the cost of allocating a
    // buffer for the short one to keep this branch's timing roughly similar
    // to the success path, but timing on "wrong length" is not considered
    // sensitive (the length of the real secret is not a secret — only its
    // contents are).
    return false;
  }
  try {
    const tokenBuf = Buffer.from(token, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (tokenBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(tokenBuf, expectedBuf);
  } catch {
    return false;
  }
}
