# Relay Service

The relay is a small Node.js WebSocket service that bridges the Foundry VTT client module and the AI backend. It handles authentication, command routing, queueing, and rate limiting.

## Status

**Pre-alpha stub.** The functional relay implementation lands in Tier 1 (0.1.0).

## What It Does

When a GM opens a Foundry world with the StablePiggy Napoleon Game Assistant module enabled, the module opens a persistent WebSocket connection to the configured relay endpoint. The relay:

1. **Authenticates** the connection via a shared secret or platform-issued token
2. **Routes messages** bidirectionally between the Foundry client and the AI backend
3. **Queues messages** when either side is offline so delivery resumes on reconnect
4. **Rate-limits** both sides to prevent floods
5. **Enforces the command whitelist** — only protocol v1 commands pass through

The relay does not contain AI logic. It is a transport layer. See [`../docs/architecture.md`](../docs/architecture.md) for the full architecture.

## Deployment

The relay is designed to be deployable as a standalone container. Target deployment environments:

- **StablePiggy platform** — the recommended default; the module's default relay endpoint will point here after launch
- **Self-hosted** — any server that can run Node.js and has a public TCP endpoint for the WebSocket connection
- **Docker container** — a Dockerfile will ship with the Tier 1 release

## Planned Structure

```
relay/
├── README.md           (this file)
├── package.json        (Node.js dependencies, build scripts)
├── Dockerfile          (container build)
├── src/
│   ├── index.js        (entry point, config loading, signal handlers)
│   ├── server.js       (WebSocket server setup)
│   ├── auth.js         (token verification)
│   ├── router.js       (command routing and whitelist enforcement)
│   ├── queue.js        (offline message queueing)
│   └── protocol.js     (command protocol v1 definitions)
└── test/
    └── (Tier 1 tests)
```

## Command Protocol

See [`../docs/architecture.md`](../docs/architecture.md) §Command protocol.

## Configuration

The Tier 1 relay will be configured via environment variables:

| Variable | Purpose |
|----------|---------|
| `RELAY_PORT` | TCP port to bind (default: 8080) |
| `RELAY_SHARED_SECRET` | Shared secret for client authentication |
| `RELAY_BACKEND_URL` | URL of the AI backend this relay proxies to |
| `RELAY_BACKEND_TOKEN` | Authentication token for the backend |
| `RELAY_LOG_LEVEL` | `debug`, `info`, `warn`, `error` (default: `info`) |
| `RELAY_MAX_QUEUE_SIZE` | Maximum queued messages per connection (default: 100) |

No TLS is handled by the relay directly — deploy behind a reverse proxy (Caddy, Nginx, Cloudflare) that terminates TLS and forwards to the relay's plain WebSocket port.

## Security Notes

- The relay **never stores world data** beyond transient message queues. Queued messages are dropped on disconnect if they cannot be delivered within a configurable TTL.
- **Authentication is mandatory** on both sides of the relay. Neither the Foundry client nor the AI backend can connect without a valid token.
- **The command whitelist is enforced at the relay layer**, not just at the module or backend. This is a defense-in-depth measure to prevent a compromised client from executing unintended commands.
- See [`../SECURITY.md`](../SECURITY.md) for how to report a vulnerability.

## Development

Tier 1 development will happen in this directory. Current files are stubs; functional code lands as Tier 1 work progresses.

To run the stub (once Node.js is installed):

```bash
cd relay
node src/index.js
```

The stub logs a "relay service — pre-alpha stub" message and exits. Functional behavior lands in 0.1.0.
