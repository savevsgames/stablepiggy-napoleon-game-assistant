# StablePiggy Napoleon Game Assistant

**An AI-assisted co-GM module for Foundry Virtual Tabletop.**

Status: **Pre-alpha (0.0.1)** — public submission stub. Active development toward Tier 1 (relay + basic commands). Not yet installable from the Foundry package registry.

---

## What It Does

StablePiggy Napoleon Game Assistant is a Foundry VTT add-on module that connects your game to an AI co-GM running on the StablePiggy platform. The AI helps with the parts of running a tabletop RPG that slow the table down — generating NPCs, remembering campaign lore across sessions, answering rules questions, and preparing session outlines on a schedule.

The module ships in three progressive tiers:

- **Tier 1 — Prep & Lookup.** A `/napoleon` chat command for in-game rules questions and narrative assists. Generated NPCs, scenes, and handouts can be imported into your world via drag-drop or direct command.
- **Tier 2 — Live Assistance.** NPC dialogue in character, tactical suggestions, whispered rules lookups, mid-session note-taking.
- **Tier 3 — Active Co-GM (stretch).** Tactical NPC combat, scene management, dynamic encounter pacing — all under GM oversight, all opt-in per capability.

Each tier is built on top of the previous one. You enable as much or as little as you want.

The module does not replace your GM. It replaces the **busywork** of running a campaign so your GM can focus on what only a human at the table can do.

---

## Current Capabilities

The pre-alpha release ships:

- **pf2e v7.12.1 NPC schema** — a canonical JSON schema for generating Pathfinder 2nd Edition NPC Actor documents compatible with Foundry v13 and the pf2e system module. See [`schemas/pf2e-npc-v1.schema.json`](./schemas/pf2e-npc-v1.schema.json) and the [pf2e NPC schema reference](./docs/pf2e-schema.md).
- **An example NPC** ([`schemas/example-npc.json`](./schemas/example-npc.json)) — a custom level 5 humanoid antagonist that validates against the schema and imports cleanly into any pf2e v7.12.1 world.

The module's client-side JavaScript, the relay service, and the Foundry chat command integration are under active development and will land in Tier 1 releases.

---

## Requirements

- **Foundry VTT:** v13.351 or later (v13 is the current supported major version; v14 compatibility tracks the upstream pf2e system module)
- **pf2e system module:** v7.12.1 or later (remaster-compatible)
- **A StablePiggy account** (for the AI backend) — signup at [app.stablepiggy.com](https://app.stablepiggy.com)

The module is designed to be usable without a StablePiggy account for the **schema and reference** portions (use the JSON schema to validate your own generated NPCs, or use the example NPC as a starting template). Tier 1+ features that require a live AI backend need the account link.

---

## Installation

**The module is pending submission review** to the Foundry package registry. Installation instructions will be published here once the package is approved.

For now, developers can clone this repository directly into their Foundry `Data/modules/` directory:

```bash
cd /path/to/foundrydata/Data/modules
git clone https://github.com/savevsgames/stablepiggy-napoleon-game-assistant.git
```

The module will appear in Foundry's Module Management panel for worlds running a compatible game system. Enable it there.

See [`docs/installation.md`](./docs/installation.md) for details.

---

## Architecture

At a high level:

```
  ┌─────────────────────┐     WebSocket     ┌──────────────────┐
  │  Foundry VTT        │ ◄───────────────► │  Relay service   │
  │  (GM's browser)     │                   │  (deployable)    │
  │                     │                   └────────┬─────────┘
  │  This module runs   │                            │
  │  client-side,       │                            │
  │  opens a connection │                            ▼
  │  to the relay       │                   ┌──────────────────┐
  │                     │                   │  AI backend      │
  │  /napoleon command  │                   │  (StablePiggy    │
  │  executes responses │                   │   platform)      │
  └─────────────────────┘                   └──────────────────┘
```

The module is client-side (runs in the GM's browser). The relay service is a small bridge that routes commands between the Foundry client and the AI backend. The AI backend is the StablePiggy platform — a remote AI-assistance environment for developers and creators.

You can deploy the relay anywhere: on your own server, on a StablePiggy environment, or eventually as a managed service. The module is agnostic to where the relay runs as long as the WebSocket endpoint is reachable.

See [`docs/architecture.md`](./docs/architecture.md) for the full architecture notes.

---

## Roadmap

**Tier 1 — Prep & Lookup (active development):**
- [x] pf2e v7.12.1 NPC schema + example
- [ ] `module.json` manifest + Foundry package submission
- [ ] Relay service skeleton
- [ ] Module WebSocket client (opens persistent connection to relay)
- [ ] `/napoleon` chat command for rules lookup and narrative assists
- [ ] Command protocol v1 (`chat.create`, `actor.create`, `journal.create`)

**Tier 2 — Live Assistance (planned):**
- [ ] NPC dialogue in character
- [ ] Tactical suggestions during combat
- [ ] Mid-session note-taking and session log generation
- [ ] Whispered rules lookups via `/napoleon`

**Tier 3 — Active Co-GM (stretch):**
- [ ] Tactical NPC combat automation (opt-in, per NPC)
- [ ] Scene management and pacing assists
- [ ] Dynamic encounter adjustment

---

## Game System Support

**Pathfinder 2nd Edition (pf2e)** is the primary supported system. The pre-alpha release ships a v7.12.1-canonical schema and example NPC.

Additional systems are planned after Tier 1 stabilizes:
- **Shadowdark RPG** — second target
- **D&D 5e** — tracked, deferred

Each system has its own schema + generator adapter. The module architecture is system-agnostic above the data layer.

---

## Content and Copyright

This module **does not include** any verbatim content from commercial Adventure Paths or any other copyrighted Pathfinder 2nd Edition products. NPCs, example characters, and documentation are original creations or use Open Roleplaying Creative License (ORC) public content from Archives of Nethys.

See [`LICENSE`](./LICENSE) for the third-party attribution and license notes.

**Users generating content via the AI backend are responsible for respecting the copyright of any source material they reference.** The AI backend is instructed to produce custom content rather than reproduce commercial AP characters, but final copyright compliance is the user's responsibility.

---

## Security

If you discover a security issue in this module or the relay service, please report it privately via the contact information in [`SECURITY.md`](./SECURITY.md). Do not open a public issue for security concerns.

---

## Contributing

The module is in pre-alpha and the internal architecture is still stabilizing. Pull requests for Tier 1 scope are welcome but please discuss significant changes via a GitHub issue first.

---

## License

MIT License. See [`LICENSE`](./LICENSE) for the full text and third-party attribution.

---

## Credits

- **Lead developer:** [Greg C. / savevsgames](https://github.com/savevsgames)
- **StablePiggy platform:** [app.stablepiggy.com](https://app.stablepiggy.com)
- **Foundry VTT:** [foundryvtt.com](https://foundryvtt.com)
- **Pathfinder 2e system module:** [github.com/foundryvtt/pf2e](https://github.com/foundryvtt/pf2e)
- **Archives of Nethys** (ORC-licensed Pathfinder reference): [2e.aonprd.com](https://2e.aonprd.com)

Pathfinder is a trademark of Paizo Inc. This module is not affiliated with, endorsed by, or sponsored by Paizo Inc.

Foundry Virtual Tabletop is a trademark of Foundry Gaming, LLC. This module is a community-contributed add-on package.
