/**
 * V2 Phase 4 — Module-Aware Napoleon: world-content enumerator.
 *
 * Walks Foundry's `game.actors`, `game.scenes`, `game.journal`,
 * `game.items`, and `game.modules` to produce the compact summary
 * payload that rides on every `client.query`'s `QueryContext.worldContent`.
 * The backend renders these summaries into a "## Current world contents"
 * block in Napoleon's user message so Napoleon answers GM questions
 * by referencing module-provided entities BY NAME instead of
 * hallucinating duplicates.
 *
 * Per-type caps (locked in `local/specs/FOUNDRY-MODULE-AWARE-SPEC.md`
 * §10 Q4): actors 300, scenes 75, journals 250, items 200, modules 50.
 * Hard truncation only — folder-level bucketing ("(N more in folder X)")
 * is a follow-up if Abomination Vaults testing reveals we hit caps in
 * practice. AV's totals (238 actors, 47 scenes, 89 journals, 156 items,
 * ~20 active modules) all sit comfortably under the caps, so straight
 * truncation suffices for the launch target.
 *
 * Returns `null` when `game.ready` is false (early hooks before world
 * load) so the caller can omit the field; backend treats omitted
 * worldContent the same as null worldContent and skips block injection.
 */

import type {
  WorldContent,
  WorldContentActor,
  WorldContentScene,
  WorldContentJournal,
  WorldContentItem,
  WorldContentModule,
} from "@stablepiggy-napoleon/protocol";

const CAPS = {
  actors: 300,
  scenes: 75,
  journals: 250,
  items: 200,
  modules: 50,
} as const;

// ── Narrow Foundry type declarations (per-file pattern matching the rest
//    of the module — no global Foundry types installed) ──────────────────

interface FoundryFolder {
  readonly name?: string;
}

interface FoundryDocument {
  readonly id?: string;
  readonly name?: string;
  readonly type?: string;
  readonly folder?: FoundryFolder | null;
  readonly system?: Record<string, unknown>;
}

interface FoundryActor extends FoundryDocument {}

interface FoundryScene extends FoundryDocument {
  readonly active?: boolean;
}

interface FoundryJournalPages {
  readonly size?: number;
  readonly length?: number;
}

interface FoundryJournalEntry extends FoundryDocument {
  readonly pages?: FoundryJournalPages;
}

interface FoundryItem extends FoundryDocument {}

interface FoundryModule {
  readonly id?: string;
  readonly title?: string;
  readonly active?: boolean;
}

interface FoundryCollection<T> {
  readonly contents?: readonly T[];
  readonly size?: number;
  values?(): IterableIterator<T>;
  [Symbol.iterator]?(): IterableIterator<T>;
}

declare const game: {
  readonly ready?: boolean;
  readonly actors?: FoundryCollection<FoundryActor>;
  readonly scenes?: FoundryCollection<FoundryScene>;
  readonly journal?: FoundryCollection<FoundryJournalEntry>;
  readonly items?: FoundryCollection<FoundryItem>;
  readonly modules?: Map<string, FoundryModule>;
};

// ── Helpers ──────────────────────────────────────────────────────────────

function toArray<T>(coll: FoundryCollection<T> | undefined): readonly T[] {
  if (!coll) return [];
  if (Array.isArray((coll as unknown as { contents?: unknown }).contents)) {
    return (coll as { contents: readonly T[] }).contents;
  }
  if (typeof coll.values === "function") {
    return Array.from(coll.values());
  }
  if (typeof (coll as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
    return Array.from(coll as Iterable<T>);
  }
  return [];
}

function getFolderName(doc: FoundryDocument): string | undefined {
  const f = doc.folder;
  if (!f) return undefined;
  return typeof f.name === "string" && f.name.length > 0 ? f.name : undefined;
}

/**
 * Best-effort actor level extraction. PF2e stores at
 * `system.details.level.value`; some systems store at `system.level`
 * directly; many systems have no level concept. Returns undefined when
 * the value isn't a finite number — caller omits the level field.
 */
function getActorLevel(actor: FoundryActor): number | undefined {
  const sys = actor.system;
  if (!sys) return undefined;
  const details = sys.details as { level?: unknown } | undefined;
  if (details && details.level !== undefined) {
    if (typeof details.level === "number" && Number.isFinite(details.level)) {
      return details.level;
    }
    if (typeof details.level === "object" && details.level !== null) {
      const inner = (details.level as { value?: unknown }).value;
      if (typeof inner === "number" && Number.isFinite(inner)) return inner;
    }
  }
  if (typeof sys.level === "number" && Number.isFinite(sys.level)) return sys.level;
  return undefined;
}

function getJournalPageCount(j: FoundryJournalEntry): number | undefined {
  const p = j.pages;
  if (!p) return undefined;
  const n = typeof p.size === "number" ? p.size : p.length;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

// ── Per-collection enumerators ───────────────────────────────────────────

function enumerateActors(): WorldContentActor[] {
  const out: WorldContentActor[] = [];
  for (const a of toArray(game.actors)) {
    if (typeof a.id !== "string" || !a.id) continue;
    if (typeof a.name !== "string" || !a.name) continue;
    if (typeof a.type !== "string" || !a.type) continue;
    const lvl = getActorLevel(a);
    const folder = getFolderName(a);
    out.push({
      id: a.id,
      name: a.name,
      type: a.type,
      ...(lvl !== undefined ? { level: lvl } : {}),
      ...(folder ? { folder } : {}),
    });
    if (out.length >= CAPS.actors) break;
  }
  return out;
}

function enumerateScenes(): WorldContentScene[] {
  const out: WorldContentScene[] = [];
  for (const s of toArray(game.scenes)) {
    if (typeof s.id !== "string" || !s.id) continue;
    if (typeof s.name !== "string" || !s.name) continue;
    const folder = getFolderName(s);
    out.push({
      id: s.id,
      name: s.name,
      active: s.active === true,
      ...(folder ? { folder } : {}),
    });
    if (out.length >= CAPS.scenes) break;
  }
  return out;
}

function enumerateJournals(): WorldContentJournal[] {
  const out: WorldContentJournal[] = [];
  for (const j of toArray(game.journal)) {
    if (typeof j.id !== "string" || !j.id) continue;
    if (typeof j.name !== "string" || !j.name) continue;
    const folder = getFolderName(j);
    const pages = getJournalPageCount(j);
    out.push({
      id: j.id,
      name: j.name,
      ...(folder ? { folder } : {}),
      ...(pages !== undefined ? { pageCount: pages } : {}),
    });
    if (out.length >= CAPS.journals) break;
  }
  return out;
}

function enumerateItems(): WorldContentItem[] {
  const out: WorldContentItem[] = [];
  for (const it of toArray(game.items)) {
    if (typeof it.id !== "string" || !it.id) continue;
    if (typeof it.name !== "string" || !it.name) continue;
    if (typeof it.type !== "string" || !it.type) continue;
    const folder = getFolderName(it);
    out.push({
      id: it.id,
      name: it.name,
      type: it.type,
      ...(folder ? { folder } : {}),
    });
    if (out.length >= CAPS.items) break;
  }
  return out;
}

function enumerateModules(): WorldContentModule[] {
  const collection = game.modules;
  if (!collection || typeof collection.entries !== "function") return [];
  const out: WorldContentModule[] = [];
  for (const [key, mod] of collection.entries()) {
    const id = typeof mod.id === "string" && mod.id ? mod.id : key;
    if (typeof id !== "string" || !id) continue;
    if (typeof mod.title !== "string" || !mod.title) continue;
    out.push({ id, title: mod.title, active: mod.active === true });
    if (out.length >= CAPS.modules) break;
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build the worldContent payload for the next `client.query`. Returns
 * null when `game.ready` is false (e.g. an early hook fires before the
 * world has loaded its collections) — the caller omits the field and
 * the backend skips block injection.
 *
 * Caps are applied per-type; iteration stops at the cap. No folder-
 * bucketing yet; if AV-class testing reveals real cap pressure, follow
 * up with first-N-per-folder + "(M more in folder X)" summarization.
 */
export function buildWorldContent(): WorldContent | null {
  if (!game?.ready) return null;
  return {
    actors: enumerateActors(),
    scenes: enumerateScenes(),
    journals: enumerateJournals(),
    items: enumerateItems(),
    modules: enumerateModules(),
  };
}
