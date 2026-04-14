/**
 * StablePiggy Napoleon Game Assistant — relay service entry point
 *
 * Pre-alpha stub (Step 0). Tier 1 build steps replace this with:
 *   - Step 2: WebSocket server (`ws` package), authentication middleware
 *     (Bearer token verification), ping/pong handling, hello/welcome handshake,
 *     structured logging via pino
 *   - Step 4: HTTP admin endpoint for the temporary fake backend
 *     (`POST /admin/inject-chat`) that lets us smoke-test command routing
 *     before the real AI backend is wired in
 *   - Step 6: replace fake backend with real HTTP calls to the StablePiggy
 *     platform's `POST /api/foundry/query` endpoint (delivered by the
 *     parallel Platform Track — see planning/phase2-tier1-plan.md §4.2)
 *   - Step 7: structured error handling, message queuing for offline clients,
 *     rate limiting per connection
 *   - Step 8a: Dockerfile and deployment artifacts
 *
 * See planning/phase2-tier1-plan.md §4.1 for the full Module Track build
 * sequence and §4.2 for the parallel Platform Track that delivers the
 * backend endpoint this relay calls.
 */

import { PROTOCOL_VERSION } from "@stablepiggy-napoleon/protocol";

// eslint-disable-next-line no-console
console.log(
  `[relay] stablepiggy-napoleon-game-assistant relay service — pre-alpha stub (protocol v${PROTOCOL_VERSION})`
);
// eslint-disable-next-line no-console
console.log(
  "[relay] functional WebSocket server lands in Tier 1 Step 2 — see relay/README.md"
);

process.exit(0);
