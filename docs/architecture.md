# Architecture Notes

This document describes the high-level architecture of the StablePiggy Napoleon Game Assistant module and its dependencies. For end-user installation and configuration, see [`installation.md`](./installation.md).

## Components

The module ships in three logical pieces that deploy independently:

```
┌─────────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  Foundry VTT        │ ──────► │  Relay service   │ ──────► │  AI backend      │
│  (GM's browser)     │         │  (configurable)  │         │  (StablePiggy    │
│                     │ ◄────── │                  │ ◄────── │   platform)      │
│  - This module      │         │  - WebSocket hub │         │                  │
│  - /napoleon cmd    │         │  - Auth + queue  │         │  - Content gen   │
│  - Command executor │         │  - ~50 LOC core  │         │  - Campaign mem  │
└─────────────────────┘         └──────────────────┘         └──────────────────┘
   Client-side code              Deployable service              Remote platform
   (this repo /scripts)         (this repo /relay)             (separate product)
```

### 1. Client module (this repo — `scripts/`, `styles/`, `languages/`)

Runs in the GM's browser as a Foundry VTT Add-on Module. Registers a `/napoleon` chat command, opens a WebSocket connection to the configured relay, and executes commands from the relay using Foundry's client-side API (`ChatMessage.create`, `Actor.create`, `JournalEntry.create`, etc.).

The module does **not** contain AI logic. It is a thin bridge that lets the AI backend issue commands into the GM's world and lets the GM issue requests back to the AI.

### 2. Relay service (this repo — `relay/`)

A small Node.js service that bridges the Foundry client (outbound WebSocket from the GM's browser) and the AI backend (inbound request from the platform). Responsibilities:

- **Authentication**: verifies both the Foundry module and the AI backend via shared secret or issued token
- **Routing**: forwards commands from the AI backend to the connected Foundry client, and state events from Foundry back to the backend
- **Queueing**: holds commands when the GM's browser is offline so they deliver on reconnect
- **Rate limiting**: prevents command floods and respects the backend's own limits

The relay is deployable as a standalone container. You can run it:
- On your own server
- In a StablePiggy environment (the recommended default)
- On any container host that can reach the AI backend over HTTPS

The relay does not contain AI logic either. It is a routing layer.

### 3. AI backend (separate product — the StablePiggy platform)

The AI backend is the remote environment that does the actual content generation, campaign memory storage, and rules-lookup reasoning. It is a separate product with its own development lifecycle.

The module is agnostic to where the AI backend runs as long as the relay can reach it. This design lets future versions of the module work with alternative backends (self-hosted, different providers) without needing to rewrite the client.

## Data flow: the `/napoleon` command

When a GM types `/napoleon how does grapple work` in Foundry chat:

1. The module catches the chat message, intercepts the `/napoleon` prefix
2. Wraps the query as a command envelope and sends it over the relay WebSocket
3. The relay forwards the command to the AI backend with appropriate auth
4. The AI backend processes the query (consulting cached rules references, then falling back to general knowledge)
5. The AI backend returns a response over the same relay connection
6. The module renders the response as a whispered chat message visible only to the GM

The flow is symmetric: the AI backend can also **push** commands to Foundry (e.g., to inject a generated NPC into the Actors sidebar during a scheduled prep run). The same WebSocket handles both directions.

## Command protocol

The command protocol is a JSON message format versioned via `relayProtocolVersion` in `module.json` flags. Protocol v1 (Tier 1) supports a minimal command set:

| Command | Direction | Purpose |
|---------|-----------|---------|
| `chat.create` | backend → client | Inject a chat message (IC narration, OOC rules answer, whispered hint) |
| `actor.create` | backend → client | Drop a generated NPC into the Actors sidebar |
| `journal.create` | backend → client | Drop a generated journal entry (scene outline, lore, handout) |
| `ping` | both | Keep-alive and latency check |
| `state.hello` | client → backend | Announce the client's world ID and capability flags on connect |

Protocol versions are forward-compatible: a newer backend talking to an older client will fall back to the client's declared capabilities. A newer client talking to an older backend will receive a warning and disable unsupported features.

The command protocol is documented in detail in [`relay/README.md`](../relay/README.md) as the relay implementation lands.

## Scoping and security

The module is **client-side only**. It cannot access:
- Files outside the Foundry world's own data directory
- Other Foundry worlds than the one currently open
- Any system-level resources on the host machine
- Any AI platform capabilities not explicitly granted via the command protocol

The relay service **must** enforce:
- Authentication on both inbound connections (the client and the backend)
- Command whitelisting — only the declared v1 commands are accepted
- Rate limiting on both sides
- No persistent storage of world data beyond message queuing

The AI backend enforces its own capability scoping separately (which AI tools are available in Foundry Mode, what the AI is allowed to read and write). That scoping is out of scope for this document and documented in the backend's own security model.

## Why not run the AI in the Foundry module directly?

Because AI inference costs money and API keys, and the module runs in the GM's browser. Asking every GM to paste an AI API key into Foundry is:
- A security risk (client-side key storage)
- A billing headache (each GM pays per-use directly)
- A configuration burden (different GMs use different providers)
- A capability limit (browser-side models are small)

The relay + backend split lets the AI run in a controlled environment with managed billing, proper key storage, and access to larger models. The module stays thin and free to install.

## Why WebSocket rather than HTTP polling?

Because bidirectional real-time communication is a first-class requirement. The AI backend needs to push commands (during prep runs, scheduled events) without the client having to poll constantly. WebSockets give:
- Instant delivery when the connection is live
- Server-side queuing for offline delivery
- One persistent connection instead of repeated HTTP overhead
- Natural fit for Foundry's own module socket pattern (the `socket` field in `module.json`)

## Why a separate relay at all?

Because the Foundry client's browser cannot maintain direct authenticated connections to multiple AI backends, and because the relay provides a clean single point for:
- Auth enforcement
- Command whitelisting
- Rate limiting and backpressure
- Backend substitution (you can swap backends without reconfiguring every GM's module)
- Offline queuing when the GM's browser is closed

The relay is small (Tier 1 target: under ~100 lines of core routing code) and optional in the sense that a GM could theoretically run their own relay on localhost if they wanted to self-host the whole stack. Most users will use the relay provided by the StablePiggy platform.

## Related documents

- [`installation.md`](./installation.md) — end-user installation and configuration
- [`pf2e-schema.md`](./pf2e-schema.md) — pf2e v7.12.1 NPC schema reference used by the backend's content generator
- [`../schemas/pf2e-npc-v1.schema.json`](../schemas/pf2e-npc-v1.schema.json) — the canonical schema itself
- [`../schemas/example-npc.json`](../schemas/example-npc.json) — a reference example NPC
- [`../relay/README.md`](../relay/README.md) — relay service build notes
