/**
 * Relay authentication helpers.
 *
 * ## Why the auth moved into the protocol message
 *
 * Earlier drafts of the relay verified a Bearer token in the HTTP upgrade
 * request's `Authorization` header. That worked for the Node-based smoke
 * test (the `ws` package supports custom headers on its client) but is
 * fundamentally broken for the Foundry module because the browser
 * WebSocket API **cannot set custom HTTP headers on the upgrade request**.
 * The only thing a browser can influence about the upgrade is the URL and
 * the subprotocol list — neither suitable for carrying a secret.
 *
 * M2.1 moved authentication into the first protocol message instead. The
 * relay now accepts all upgrades, starts a 2-second grace timer, and
 * verifies `authToken` in the inbound `client.hello` payload. If the hello
 * never arrives or the token is rejected, the relay closes the socket with
 * code 1008 ("policy violation"). The grace window is short enough that an
 * attacker gets essentially no free work out of the pending state, and
 * the connection has consumed no resources beyond a single Map entry and
 * a timer handle.
 *
 * The relay supports two auth paths, selected by token prefix in the hello
 * handler:
 *
 *   - **API key** (`dv-*`): forwarded to the backend's identity endpoint
 *     via HTTP. The backend runs the standard `authenticate()` path used
 *     by every MCP tool call and returns the real identity ID on success.
 *     See `resolveIdentityFromApiKey` in backend-client.ts.
 *
 *   - **Shared secret**: any other non-empty string. Compared in constant
 *     time against `config.sharedSecret` using the helper below. On match
 *     the relay synthesizes an anonymous identity from the hello payload.
 *
 * This file only owns the string-compare helper. The flow control (which
 * path to take, when to close the socket, how to set connection state) is
 * in server.ts::handleHello.
 */

import { timingSafeEqual } from "crypto";

/**
 * Constant-time compare of a user-supplied token against the relay's
 * configured shared secret. Returns false for any failure: empty input,
 * length mismatch, buffer allocation error, or non-match.
 *
 * Empty `expected` is treated as "shared-secret mode is disabled" — this
 * function always returns false, so shared-secret auth attempts fail
 * cleanly when the operator hasn't configured a secret. That's the right
 * posture for hosted relay deployments that only want to accept API keys.
 */
export function verifyHelloToken(token: string, expected: string): boolean {
  if (typeof token !== "string" || typeof expected !== "string") {
    return false;
  }
  if (expected.length === 0) {
    return false;
  }
  if (token.length !== expected.length) {
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

/**
 * True if the token looks like a StablePiggy API key. Used by the hello
 * handler to decide whether to route to the API-key path or the shared-
 * secret path. The relay does not validate the rest of the key format
 * here — the backend's `authenticate()` is authoritative. This is just
 * the routing discriminator.
 *
 * Keeping this as a function (not an inline check) so that if the API
 * key format ever changes the relay has one place to update.
 */
export function looksLikeApiKey(token: string): boolean {
  return typeof token === "string" && token.startsWith("dv-");
}
