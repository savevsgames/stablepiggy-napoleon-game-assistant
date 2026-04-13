# Installation

**The module is pending submission review to the Foundry package registry.** Once approved, it will be installable via Foundry's built-in module browser. Until then, follow the developer installation instructions below.

---

## Developer Installation (manual)

This is the current supported path for early testers and developers who want to try the module before the Foundry package listing goes live.

### Requirements

- **Foundry VTT v13.351 or later.** Earlier Foundry v13 builds may work but are not tested. Foundry v14 is not yet supported (tracking upstream pf2e system compatibility).
- **pf2e system module v7.12.1 or later.** The module targets the remaster-compatible v7 line.
- **A Git client** installed on the machine running Foundry.
- **Optional: a StablePiggy account** for Tier 1+ AI features. The pre-alpha release does not require one.

### Steps

1. **Find your Foundry modules directory.** On most platforms:
   - **Windows:** `%localappdata%\FoundryVTT\Data\modules\`
   - **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/`
   - **Linux:** `~/.local/share/FoundryVTT/Data/modules/`
   - **Self-hosted / container:** the path configured as `dataPath` in your Foundry `options.json`

2. **Clone the repository** into that directory:

   ```bash
   cd /path/to/foundrydata/Data/modules
   git clone https://github.com/savevsgames/stablepiggy-napoleon-game-assistant.git
   ```

   This will create a `stablepiggy-napoleon-game-assistant/` subdirectory containing the module's `module.json` manifest.

3. **Restart Foundry VTT** if it was already running. Foundry scans the modules directory on startup.

4. **Launch a world** that uses the **Pathfinder 2nd Edition (pf2e)** system. The module is compatible with other systems only at the schema-reference level; Tier 1 features require pf2e.

5. **Enable the module** in the world's Module Management panel:
   - Open the world
   - Click **Game Settings** (gear icon) → **Manage Modules**
   - Find **StablePiggy Napoleon Game Assistant** in the list
   - Check the box to enable it
   - Click **Save Module Settings**
   - Accept the world reload prompt

The module is now loaded. In the pre-alpha release this does not yet produce any visible in-game behavior beyond the schema and example NPC being available as reference files.

---

## What Works Right Now

The **pre-alpha release (0.0.1)** is a submission stub. The module loads into Foundry without errors, but does not yet add functional in-game features. What you get:

- **Schema reference file** at `schemas/pf2e-npc-v1.schema.json` — usable as a JSON Schema validator input for any tool that generates pf2e v7.12.1 NPC JSON
- **Example NPC** at `schemas/example-npc.json` — a custom level 5 humanoid antagonist you can drag-drop into a test world to confirm your Foundry + pf2e version is compatible with the schema target

The functional `/napoleon` chat command, the relay connection, and auto-import of AI-generated content land in **0.1.0 (Tier 1)**.

---

## Tier 1 Configuration (Future)

Once Tier 1 ships, the module will need to know:

1. **The relay endpoint** — a WebSocket URL the module connects to on world load
2. **Authentication credentials** — either a shared secret or a StablePiggy-issued token
3. **Foundry Mode context** — which tools the AI backend is allowed to invoke on your world

These will be configured via a settings panel in Foundry's Module Settings dialog. Tier 1 installation instructions will be added to this document when the feature lands.

---

## Uninstalling

To remove the module:

1. Disable it in the world's Module Management panel
2. Exit Foundry
3. Delete the `stablepiggy-napoleon-game-assistant/` directory from your Foundry `Data/modules/` folder

The module does not persist any data outside the Foundry world itself. Uninstalling removes all traces.

---

## Troubleshooting

**The module doesn't appear in Module Management.**
- Confirm the clone succeeded and `module.json` exists at `modules/stablepiggy-napoleon-game-assistant/module.json`
- Confirm Foundry's `Data/modules/` directory is the one Foundry is actually reading (check `options.json`)
- Restart Foundry fully, not just the world

**Foundry shows a compatibility warning.**
- Check your Foundry version — must be v13.351+. Check your pf2e system version — must be v7.12.1+.
- The module will still load on older compatible versions but may misbehave; report any issues.

**The example NPC doesn't import cleanly.**
- Confirm your world is using the pf2e system (not D&D 5e or another system)
- Confirm the pf2e system version matches the schema target (v7.12.1+)
- See the [pf2e schema reference](./pf2e-schema.md) for details on the expected document shape

**I don't have a StablePiggy account. Can I still use the schema and example?**
- Yes. The `schemas/` directory is independently useful. You can reference the JSON Schema from any tool that generates pf2e NPC JSON and use the example NPC as a starting template.

---

## Questions

Open a [GitHub issue](https://github.com/savevsgames/stablepiggy-napoleon-game-assistant/issues) for bugs, feature requests, or installation help. For security concerns, see [`SECURITY.md`](../SECURITY.md).
