# Changelog

All notable changes to the StablePiggy Napoleon Game Assistant module will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned for 0.1.0 (Tier 1 initial release)

- `module.json` manifest with full Foundry v13 compatibility declarations
- Relay service skeleton (Node.js WebSocket server, deployable as a container)
- Module WebSocket client (opens a persistent connection to the relay)
- `/napoleon` chat command for in-game rules lookups and narrative assists
- Command protocol v1: `chat.create`, `actor.create`, `journal.create`
- Auto-import of generated NPCs directly into the Actors sidebar

---

## [0.0.1] — 2026-04-13

### Added

- Repository scaffold and public submission stub
- `README.md` with project overview, requirements, installation placeholder, architecture diagram, and roadmap
- `LICENSE` (MIT) with third-party attribution to Paizo, Foundry Gaming, and Archives of Nethys
- `SECURITY.md` for private security issue reporting
- `CHANGELOG.md` (this file)
- `.gitignore` with Node.js, Foundry, and internal-planning exclusions
- `docs/architecture.md` — high-level architecture notes (module + relay + AI backend)
- `docs/installation.md` — installation placeholder pending Foundry package registry approval
- `docs/pf2e-schema.md` — public reference for the pf2e v7.12.1 NPC schema
- `schemas/pf2e-npc-v1.schema.json` — canonical JSON Schema for pf2e v7.12.1 NPC Actor documents (post-remaster)
- `schemas/example-npc.json` — reference example (level 5 custom humanoid antagonist) that validates against the schema
- Foundry module directory stubs: `scripts/main.js`, `styles/module.css`, `languages/en.json`
- `relay/` subdirectory with service README and entry point stub for the forthcoming relay build

### Notes

- This release is a **public submission stub only**. The module does not yet load a functional script into Foundry; the `module.json` manifest is not yet published.
- The pf2e schema and example NPC are independently useful as a reference for any Foundry module or external tool that needs to generate pf2e v7.12.1-canonical NPC JSON.
- Internal Phase 1 planning documentation and prompt templates are maintained in a separate private tree and are not part of the public repository surface.
