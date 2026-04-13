# Pathfinder 2e NPC Schema Reference

This document describes the canonical JSON shape for Pathfinder 2nd Edition NPC Actor documents as they exist in the Foundry VTT pf2e system module, version 7.12.1 (post-remaster). It is intended as a reference for anyone — human or tool — writing code that generates pf2e NPC JSON for import into Foundry.

The schema file is at [`../schemas/pf2e-npc-v1.schema.json`](../schemas/pf2e-npc-v1.schema.json). A reference example that validates against the schema is at [`../schemas/example-npc.json`](../schemas/example-npc.json).

---

## Scope

**In scope:**
- Foundry VTT v13.351 + pf2e system v7.12.1 NPC Actor documents
- Post-remaster canonical shape (pf2e rulebook revision that removed alignment)
- The minimum required fields for a document that imports cleanly into a pf2e v7.12.1 world without errors

**Out of scope:**
- PC (`type: "character"`) documents — different shape, different content block
- Familiar, hazard, loot, vehicle actor types — each has its own system block
- Compendium pack entries (handled by Foundry's own packing tools)
- Full field-by-field modeling of every pf2e system field (the schema is deliberately lenient)

---

## Design Philosophy

**The schema is lenient.** Every object permits `additionalProperties`. The goal is to catch **structural errors** (missing required fields, wrong enum values, malformed nested documents) without rejecting valid Foundry output that includes fields the schema doesn't know about.

Why lenient?

1. The pf2e system document has hundreds of fields, many of which are version-specific, undocumented, or present only under specific conditions.
2. Strictly modeling every field would produce a schema that rejects valid Foundry-exported documents.
3. Foundry itself is the authoritative validator — we trust Foundry's import code to catch anything we miss.
4. When the pf2e system upgrades to v8 or beyond, lenient schemas survive without rewrites.

The schema enforces what **must** be true for Foundry to accept the document, and documents what **should** be true for a well-formed NPC.

---

## Required Top-Level Fields

Every pf2e NPC Actor document must have all of these fields at the top level:

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Display name shown in the Actors sidebar |
| `type` | `"npc"` | Document type; must be exactly `"npc"` for this schema |
| `img` | string | Portrait image path; default `systems/pf2e/icons/default-icons/npc.svg` |
| `prototypeToken` | object | Token settings: size, vision, disposition, lighting. See §Token below. |
| `effects` | array | Active effects; usually `[]` for newly-created documents |
| `system` | object | The pf2e-specific system block. See §System below. |
| `items` | array | Embedded items (strikes, actions, spells, equipment). See §Items below. |
| `folder` | null or string | Parent folder ID; null for unfoldered documents |
| `flags` | object | Module flags; usually `{}` for plain NPCs |
| `_stats` | object | Foundry metadata (core version, system version, timestamps) |
| `ownership` | object | Permission level; `{ "default": 0 }` for GM-only NPCs |

**Missing any of these causes the Foundry drag-drop handler to silently reject the document.** This is a common pitfall: a document missing only `prototypeToken` or `_stats` fails with no error message at all.

---

## The System Block

`system` is the pf2e-specific block. In v7.12.1 it has the following required shape:

### `system.attributes`

| Field | Shape | Notes |
|-------|-------|-------|
| `hp` | `{ value, max, temp, details }` | HP with temporary HP tracker |
| `ac` | `{ value, details }` | Armor Class; `details` is free-text armor description |
| `allSaves` | `{ value }` | Free-text note on all saves (e.g. status bonuses vs certain damage types) |
| `speed` | `{ value, otherSpeeds, details }` | Land speed + additional movement modes |
| `immunities` | array of `{ type }` | Creature immunities (e.g. `[{type: "fire"}, {type: "paralyzed"}]`) |
| `weaknesses` | array of `{ type, value }` | Damage type weaknesses (e.g. `[{type: "cold-iron", value: 10}]`) |
| `resistances` | array of `{ type, value }` | Damage type resistances (e.g. `[{type: "cold", value: 10}]`) |

`otherSpeeds` is an array of `{ type, value }` where `type` is one of `"swim"`, `"fly"`, `"burrow"`, `"climb"` and `value` is the movement rate in feet.

### `system.initiative`

```json
{ "statistic": "perception" }
```

Most NPCs use Perception for initiative. Some use a skill (e.g. `"stealth"` for ambush predators).

### `system.details`

| Field | Shape | Notes |
|-------|-------|-------|
| `languages` | `{ value, details }` | Language list (NOT in `system.traits` — languages belong here) |
| `level` | `{ value }` | Creature level, integer |
| `blurb` | string | NPC subtitle shown under the name (e.g. `"Cultist of the Pallid Princess"`) |
| `publicNotes` | string (HTML) | Player-facing description. Wrap paragraphs in `<p>`. |
| `privateNotes` | string (HTML) | GM-only notes: tactics, motivations, secrets |
| `publication` | object | Source metadata: `{ title, authors, license, remaster }` |

**Important: pf2e v7 remaster removed alignment from the rules.** Older schemas had `system.details.alignment`; v7.12.1 does not. Creature traits that correspond to alignment flavor (`"chaotic"`, `"evil"`, `"good"`, `"lawful"`) survive as tags in `system.traits.value`, but alignment as a rules concept is gone.

Creature type (humanoid, undead, beast, etc.) is NOT a `system.details` field in v7. Creature type is expressed in `system.traits.value` as a tag (e.g. `"humanoid"`, `"undead"`, `"dragon"`).

### `system.resources`

```json
{}
```

Empty object for most NPCs. Focus-spell users add `{ focus: { max: 1, value: 1 } }`.

### `system._migration`

```json
{ "version": 0.955, "previous": null }
```

pf2e's internal migration version tracker. For v7.12.1, the current value is `0.955`. Omitting this field causes the Foundry import handler to fail without a specific error.

### `system.abilities`

```json
{
  "str": { "mod": 4 },
  "dex": { "mod": 2 },
  "con": { "mod": 4 },
  "int": { "mod": 2 },
  "wis": { "mod": 3 },
  "cha": { "mod": 5 }
}
```

All six abilities are required. Each has a `mod` field (the modifier, NOT the raw ability score). NPCs in v7 use ability modifiers directly; ability scores are a derived value.

### `system.perception`

```json
{
  "details": "",
  "mod": 22,
  "senses": [{ "type": "darkvision" }],
  "vision": true
}
```

Perception is a **top-level field of `system`**, not nested under `attributes`. Uses `mod` (not `value`). Includes a `senses` array of objects (not strings) and a `vision` boolean.

Common sense objects:
- `{ "type": "darkvision" }`
- `{ "type": "low-light-vision" }`
- `{ "type": "scent", "acuity": "imprecise", "range": 60 }`
- `{ "type": "tremorsense", "acuity": "imprecise", "range": 30 }`

### `system.saves`

```json
{
  "fortitude": { "value": 23, "saveDetail": "" },
  "reflex":    { "value": 20, "saveDetail": "" },
  "will":      { "value": 22, "saveDetail": "" }
}
```

All three saves required. `saveDetail` is a free-text note on situational modifiers.

### `system.skills`

```json
{
  "religion":     { "base": 24 },
  "intimidation": { "base": 22 },
  "deception":    { "base": 18 }
}
```

Keyed by canonical pf2e skill names. Each value is `{ base: N }` where `N` is the skill modifier.

**Canonical skill keys:** `acrobatics`, `arcana`, `athletics`, `crafting`, `deception`, `diplomacy`, `intimidation`, `medicine`, `nature`, `occultism`, `performance`, `religion`, `society`, `stealth`, `survival`, `thievery`.

Do **not** use `type: "lore"` items for these core skills — `lore` items are reserved for actual lore subskills like `"Dragon Lore"` or `"Korvosan Lore"`.

### `system.traits`

```json
{
  "value": ["human", "humanoid", "evil"],
  "rarity": "common",
  "size": { "value": "med" }
}
```

`value` is an array of string tags including:
- **Creature type**: `"humanoid"`, `"undead"`, `"dragon"`, `"beast"`, etc.
- **Ancestry**: `"human"`, `"elf"`, `"orc"`, `"goblin"`, etc.
- **Alignment flavor**: `"chaotic"`, `"evil"`, `"good"`, `"lawful"` (survive the remaster as trait tags, even though alignment-as-rules was removed)
- **Other descriptors**: `"aquatic"`, `"fire"`, `"cold"`, `"incorporeal"`, etc.

`rarity` is one of `"common"`, `"uncommon"`, `"rare"`, `"unique"`.

`size.value` uses enum abbreviations: `"tiny"`, `"sm"`, `"med"`, `"lg"`, `"huge"`, `"grg"` (gargantuan). Note the abbreviation pattern — these are not the full words.

---

## Items

Every embedded item in an NPC Actor is a full Foundry mini-document with its own envelope. The common item shape:

```json
{
  "_id": "16charAlphanumID",
  "img": "path/to/icon.svg",
  "name": "Item Name",
  "sort": 100000,
  "type": "melee",
  "system": { /* type-specific */ },
  "_stats": { /* core/system version */ },
  "effects": [],
  "folder": null,
  "flags": {},
  "ownership": { "default": 0 }
}
```

**`_id`** is a 16-character alphanumeric string that must be unique within the Actor. Items that are referenced by other items (for example, spells referenced by a `spellcastingEntry`'s slot configuration) must have an `_id` so the reference can link. Recommended for all items regardless.

**`sort`** is an integer controlling display order. Start at 100000 and increment by 100000 per item. Items without `sort` render in creation order, which is usually what you want if you build the items array in display order.

### Item types

Valid `type` values for items inside an NPC Actor:

| Type | Purpose |
|------|---------|
| `melee` | A natural weapon attack (claws, bite). Generates a strike entry on the actor sheet. |
| `weapon` | A manufactured weapon in the NPC's inventory. Also generates a strike entry. |
| `armor` | Worn armor (contributes to AC automatically if equipped) |
| `consumable` | Potion, scroll, ammunition |
| `equipment` | Miscellaneous gear (not armor, not weapon, not consumable) |
| `treasure` | Coin, gems, trinkets, lore items. Simplest shape for lootable inventory. |
| `action` | An active ability (`actionType: "action"`), reaction (`actionType: "reaction"`), free action (`actionType: "free"`), or passive trait (`actionType: "passive"`) |
| `spell` | An individual spell. Must reference a `spellcastingEntry` parent via `system.location.value` |
| `spellcastingEntry` | The parent container for a spellcaster's spell list. Holds tradition, spell DC, prepared mode, slot configuration. |
| `feat` | A class feat, ancestry feat, or general feat |
| `lore` | A lore subskill (e.g. `"Dragon Lore"`) — NOT for core skills |

### Strikes vs inventory weapons

If an NPC fights with natural weapons (claws, teeth, tentacles), use `type: "melee"` — this is the simple "NPC attack" format that generates a strike entry without tracking a physical weapon in inventory.

If an NPC wields a manufactured weapon they carry, you have two options:
- **Simple**: use `type: "melee"` for the strike profile. The weapon is not separately lootable.
- **Canonical**: use `type: "weapon"` for an inventory weapon that auto-generates the strike AND is lootable by the party. Slightly more complex system block, but matches how pf2e bestiary creatures typically model weapons.

### Spellcasting

pf2e organizes spells under a `spellcastingEntry` parent item. The entry holds the caster's tradition, key ability, spell DC, prepared/spontaneous mode, and slot configuration. Individual spells are separate items that reference the entry via `system.location.value = "<entry_id>"`, and the entry's `slots.slotN.prepared[]` arrays contain `{id: "<spell_id>"}` references back.

Example spellcasting entry:

```json
{
  "_id": "ExampleSCEntry01",
  "type": "spellcastingEntry",
  "name": "Divine Prepared Spells",
  "sort": 100000,
  "system": {
    "ability": { "value": "wis" },
    "spelldc": { "value": 22, "dc": 30, "mod": 0 },
    "tradition": { "value": "divine" },
    "prepared": { "value": "prepared", "flexible": false },
    "proficiency": { "value": 0 },
    "slots": {
      "slot0": { "prepared": [{"id": "ExampleCantrip01"}], "value": 1, "max": 1 },
      "slot1": { "prepared": [], "value": 0, "max": 0 },
      "slot6": { "prepared": [{"id": "ExampleSpell0601"}], "value": 1, "max": 1 }
    },
    "autoHeightenLevel": { "value": null }
  }
}
```

All 12 slots (`slot0` through `slot11`) must exist. Empty slots have `prepared: [], value: 0, max: 0`.

`prepared.value` is one of `"prepared"`, `"spontaneous"`, `"innate"`, `"focus"`.

Individual spell items use `system.location.value = "<spellcastingEntry _id>"` to link back. A spell item's `system.level.value` is the **rank the spell is cast at** (not its base rank), matching the slot it's prepared in.

See the [`schemas/example-npc.json`](../schemas/example-npc.json) for a working spellcaster reference, and the JSON Schema itself for the full spell item shape.

---

## Description HTML and Macros

Description fields (`system.details.publicNotes`, `system.details.privateNotes`, item descriptions) use HTML. Wrap paragraphs in `<p>` tags. Foundry parses the HTML and renders interactive elements from pf2e-specific macros:

- `@Damage[NdN[damageType]]` renders as a clickable damage roll button
- `@Check[stat|dc:N|basic]` renders as a clickable save button
- `@Template[cone|distance:30]` renders as a clickable area template
- `@UUID[Compendium.pf2e.conditionitems.Item.xxxx]{Label}` renders as a linked compendium item (conditions, spells, etc.)

Plain text still works but loses interactivity. Prefer the macro form for anything the GM will want to click.

---

## Common Pitfalls

1. **Missing envelope fields** — the most common silent-rejection cause. `prototypeToken`, `_stats`, `ownership`, `folder`, `flags`, `effects` are all required top-level even when effectively empty.
2. **Emitting `system.details.alignment`** — pf2e remaster removed this field entirely. Emit alignment-flavor traits in `system.traits.value` instead.
3. **Perception nested under `system.attributes`** — pre-v7 location. Move to top-level `system.perception` with `mod` (not `value`).
4. **Skills as `type: "lore"` items** — wrong for core skills. Use `system.skills` with canonical skill names as keys.
5. **Plain-string senses** — `senses` is an array of objects, not strings. `[{type: "darkvision"}]` not `["darkvision"]`.
6. **Empty immunities/weaknesses/resistances on creature-type NPCs** — canonical creature types usually have archetypal entries (hags take cold-iron damage, undead are immune to death effects, aquatic creatures resist cold). Only leave empty for plain humanoid characters that have no archetypal vulnerability.
7. **Size enum full words** — the enum uses abbreviations: `tiny`, `sm`, `med`, `lg`, `huge`, `grg`. Not `small`, `medium`, `large`, `gargantuan`.
8. **Missing `_id` on items that need to be referenced** — spellcastingEntry slots cannot link to a spell without the spell having an `_id`. Always generate `_id`s on spell items, and recommended on all items for debuggability.
9. **Empty inventory on significant NPCs** — a defeated NPC with no items has an empty loot pile. Use `type: "treasure"` items for gear, faction insignia, lore hooks, and coin so the party has something to harvest.
10. **Wrong pf2e system version target** — the pf2e system changes shape meaningfully between major versions. Always verify your target by exporting a sample NPC from the actual Foundry install you will be importing to, and diff.

---

## Schema File

The canonical JSON Schema is at [`../schemas/pf2e-npc-v1.schema.json`](../schemas/pf2e-npc-v1.schema.json). It is a JSON Schema Draft 2020-12 document and can be used with any JSON Schema validator (ajv, jsonschema, etc.).

A reference example that validates against the schema is at [`../schemas/example-npc.json`](../schemas/example-npc.json) — a level 5 custom humanoid antagonist with three items (a strike, a 2-action, a reaction). You can drag-drop this file into any pf2e v7.12.1 world to confirm compatibility, and use it as a starting template for your own NPCs.

---

## Version

This reference targets **pf2e system v7.12.1** on **Foundry VTT v13.351**. When the pf2e system upgrades, the shape will drift — schemas will be versioned (`pf2e-npc-v2.schema.json`, etc.) and this reference updated.

Report issues, corrections, or outdated information via a [GitHub issue](https://github.com/savevsgames/stablepiggy-napoleon-game-assistant/issues).
