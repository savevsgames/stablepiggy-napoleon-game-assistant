# Foundry Module Conventions

Decisions and patterns used in the `scripts/` codebase (the Foundry
module side of the StablePiggy Napoleon Game Assistant). This file
exists so that six months from now you can debug a weird-looking
choice without having to guess at the original reasoning.

Keep this up to date as conventions evolve. If you find yourself
fighting one of these rules, flag it as a topic for rethinking rather
than silently working around it.

---

## 1. Target versions

These are the versions this module was written and tested against:

| Surface | Version |
| --- | --- |
| Foundry VTT core | **13.351** |
| pf2e system | **7.12.1** |
| Node (build only) | 22.x |
| Vite | 6.x |
| TypeScript | 5.x strict |

The `module.json` manifest declares `compatibility.verified: 13.351`
and `relationships.systems.pf2e.compatibility.verified: 7.12.1`. Bump
these together when upgrading — and re-verify every `declare const`
block in the `scripts/` files, because Foundry occasionally renames or
restructures globals between core versions.

---

## 2. Typing Foundry globals

**We hand-roll minimal `declare const` blocks per file rather than
depending on the community `@league-of-foundry-developers/foundry-vtt-types`
package.**

Why:

- The community types package is ~50MB of definitions for the entire
  Foundry API. Through M3 we touch maybe a dozen identifiers across
  all files combined. Pulling in the full package trades a line of
  build time and a big transitive dependency for coverage we don't use.
- The community types have a history of lagging behind Foundry core
  releases. On Foundry v13.351 + pf2e 7.12.1 (post-remaster),
  mismatches are real and would produce noise-that-looks-like-signal
  in build errors.
- A hand-rolled declaration is exactly as accurate as the code that
  reads from it — you can see the surface you depend on at a glance.

How:

- Each file that touches a Foundry global declares the minimum subset
  it needs at the top of the file, right under the imports.
- Declarations are **per-file**, not pulled from a shared `.d.ts`.
  This keeps every file's Foundry surface explicit and avoids a
  single-giant-types-file that slowly grows unchecked.
- Every file that adds declarations MUST include the version comment
  at the top: `// Typed against Foundry VTT v13.351`. When the target
  Foundry version bumps, that comment is the cue to re-verify.
- If two files both need the same declaration, that is fine — copying
  three lines is cheaper than introducing a shared types file that
  couples them. Duplicate declarations are NOT a smell in this codebase.

Example:

```ts
// Typed against Foundry VTT v13.351
declare const Hooks: {
  once(event: string, callback: () => void): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
};

declare const game: {
  user: { readonly id: string; readonly isGM: boolean };
  world: { readonly id: string };
};
```

When a new milestone adds Foundry API calls (e.g., `ChatMessage.create()`
in M4, `Actor.create()` in M7), extend the declaration block in that
file. Don't preemptively declare things you're not using yet.

---

## 3. Module ID and namespacing

The module ID is `stablepiggy-napoleon-game-assistant`. It appears in:

- `module.json` → `id`
- `scripts/main.ts` and `scripts/settings.ts` → `MODULE_ID` const
- Foundry settings registration calls → first argument
- `CONFIG.debug.stablepiggy-napoleon-game-assistant` — the debug flag
  used by `log.ts` to gate verbose output
- Chat message flags — future M5 work uses
  `flags.stablepiggy-napoleon-game-assistant.correlationId` to tag
  the "Napoleon is thinking..." placeholder

If this ever changes, grep for the literal string and bump everything
in one commit — the string is deliberately unique enough that a
lossless find/replace is safe.

Log prefix is `[stablepiggy-napoleon]` (shortened — the full module ID
is noisy for every log line, and the prefix only needs to be
distinguishable from other modules' log lines in the F12 console).

---

## 4. Settings scope tradeoffs

Foundry offers two scopes for module settings:

- `scope: "world"` — stored in the world database, visible to every
  connected client in that world, editable only by GMs.
- `scope: "client"` — stored in the browser's localStorage, per-user,
  per-browser.

We use both:

- **`relayEndpoint` is world-scoped.** All GMs sharing a world should
  connect to the same relay (in Tier 1 there's only one GM anyway).
  The URL is not sensitive, and keeping it world-scoped means the GM
  configures it once per campaign rather than once per machine.

- **`authToken` is client-scoped.** This one holds a secret — either
  a StablePiggy API key (`dv-*`) or a shared relay secret. Storing
  secrets in world scope would sync them to every connected player,
  which is unacceptable. Client scope keeps the secret in the GM's
  browser only. localStorage is not a great secret store — it's
  accessible to any script running on the same origin, and any
  extension with broad host permissions can read it — but it's the
  only Foundry-provided option short of prompting the GM every
  session, which would drive users away.

Mitigations for the localStorage tradeoff:

- Only GMs use Foundry settings at all; players never see or enter
  this token.
- StablePiggy API keys can be rotated from the web dashboard, and the
  dashboard surfaces `last_used_at` for every key so suspicious
  activity is visible.
- If a GM's machine is compromised, rotating the key at the dashboard
  invalidates the stolen one within one auth cache TTL cycle.

This tradeoff is documented here so future-you doesn't burn time
re-deriving it. It is NOT a bug that this module uses localStorage
for a secret — it is a constraint of the Foundry platform.

---

## 5. Logging

`scripts/log.ts` exports `info`, `warn`, `error`, and `debug`
functions. Rules:

- Always use these rather than raw `console.log`. Rationale: one
  consistent prefix, one place to tweak log formatting later, and one
  place to add structured logging / file export if we ever want to.
- `info` is the default verbosity. It's for lifecycle events (connect,
  disconnect, hello sent, welcome received, settings changed).
- `warn` is for things the user should probably know about but which
  don't break functionality (auth missing, relay unreachable, etc.).
- `error` is for things that break functionality (WebSocket
  construction failure, malformed inbound message).
- `debug` is for verbose tracing and is OFF by default. Enable at
  runtime via the F12 console:

  ```js
  CONFIG.debug["stablepiggy-napoleon-game-assistant"] = true;
  ```

  No rebuild required. The debug check is per-call (not cached), so
  flipping the flag takes effect on the next log line.

Don't write log lines that will be spammy during normal play. If in
doubt, put it behind `debug()` — a GM who's debugging will turn the
flag on and see it; a GM who's playing won't be drowned in output.

---

## 6. Reconnect behavior

The relay client uses exponential backoff with jitter on disconnect:

- Initial backoff: **1 second**
- Doubled on each failed attempt: 1s → 2s → 4s → 8s → 16s → 30s
- Cap: **30 seconds**
- Jitter: **±25%** of current backoff, to prevent thundering-herd
  reconnects after the relay returns from maintenance
- Reset to initial after a successful hello handshake completes

Why these numbers:

- **1s start** is aggressive enough that a brief network blip
  (flipping wifi networks, VPN renegotiation) doesn't leave the GM
  disconnected for multiple seconds.
- **30s cap** is long enough that a sustained outage doesn't burn
  power constantly hammering the relay, but short enough that a
  recovered relay is noticed within half a minute.
- **±25% jitter** is the standard "reasonable amount" for avoiding
  synchronized retries — larger jitter is unnecessary with only one
  GM per relay in Tier 1.

The backoff resets only on a successful *handshake*, not on a
successful socket open. This matters because a socket can open
against a relay that then rejects the hello (e.g., bad auth) —
that's not a "good enough" connection to reset the backoff, and
treating it as one would mask a persistent config error as a
flapping one.

---

## 7. Ping loop

Once the handshake completes, the client pings the relay every 30
seconds. Matches the relay's `RELAY_PING_INTERVAL_SECONDS` default,
which is not a coincidence — both sides picked 30s independently as
"fast enough to notice dead connections within a reasonable window,
slow enough to be invisible in normal operation."

If a ping goes unanswered by the time the next ping is due (i.e., an
entire 30s interval with no pong), the client closes the socket with
code 4000 ("ping timeout"). This triggers the normal reconnect path.
The relay's keepalive on its end is handled at the WebSocket frame
level by the `ws` package; we don't rely on that for detecting dead
connections because proxies can sometimes hold a socket open without
forwarding frames.

Application-level ping/pong messages are the source of truth for
"is this connection actually passing data both ways."

---

## 8. Connection is GM-only

The relay client is created and connected ONLY when `game.user.isGM`
is true. Players never open a WebSocket to the relay, never see the
auth token, and never participate in the `/napoleon` command flow
(M5 adds the command, but it dispatches only if `game.user.isGM`).

In Tier 1 this is a hard assumption: one GM per table, one relay
connection per GM. Multi-GM worlds technically work with Foundry but
all but one GM would see the module doing nothing. Tier 2 revisits
this with a "primary GM" handshake in the relay (currently the
protocol has `isPrimaryGM: boolean` in the hello payload but the
relay doesn't enforce single-primary yet).

Players benefit from Napoleon indirectly: the GM runs queries, the
results appear as chat messages / actors / journal entries in the
shared world, and every player sees the outputs through Foundry's
normal sync layer. No player-side auth, no per-player account, no
per-player metering. That's a deliberate design choice that keeps
onboarding frictionless — a GM who wants Napoleon can get it without
asking every player to sign up for anything.

---

## 9. When to add to this file

Add a new section when you make a decision that:

- Future-you might reasonably disagree with on first read.
- Is a tradeoff between two legitimate options (rather than one
  obviously-correct answer).
- Is informed by a constraint that isn't visible in the code itself
  (a Foundry limitation, a browser limitation, a third-party
  package's behavior, a past incident, etc.).

Don't add a section for conventions that are self-explanatory from
the code (e.g., "we use TypeScript strict mode") or that are covered
by community norms (e.g., "we use ESM imports"). This file is for
the decisions that WOULD surprise a reader, not the ones that wouldn't.
