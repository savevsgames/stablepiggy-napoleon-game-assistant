/**
 * V2 Phase 4 Commit 5b — Module-Aware Napoleon: Adventure Path content
 * enumerator.
 *
 * Walks the GM's installed compendium packs filtered by pack key
 * (full `<packageName>.<packName>` format) and produces the structured
 * payload the backend's ingestion engine consumes (journals + pages,
 * items + descriptions, scene summaries). Long-running on the client
 * side; expect ~10-30s for AV-class adventures.
 *
 * IMPORTANT: pack-key filtering, NOT manifest-packageName filtering.
 * AV's bestiary lives at `pf2e.abomination-vaults-bestiary` — a
 * subpack inside the pf2e system module — not in the AV module
 * itself. See `local/specs/FOUNDRY-MODULE-INGESTION-SPEC.md` L10/L15.
 *
 * Sequential enumeration only (NOT Promise.all across packs) per
 * spec §7.2 implementation constraint #1: parallel `getDocuments()`
 * calls would spike client memory and freeze the GM's browser tab
 * for 10-30s on multi-volume APs. One pack at a time keeps the tab
 * responsive.
 *
 * Pre-enumeration GM whisper per spec §7.2 implementation constraint
 * #2 — the GM gets a "reading module content" notice before the
 * first `pack.getDocuments()` call so a stuttering tab is explained
 * rather than alarming.
 */

import type {
  ModuleJournalEntry,
  ModuleJournalPage,
  ModuleItem,
  ModuleSceneSummary,
} from "@stablepiggy-napoleon/protocol";

// ── Narrow Foundry type declarations (per-file pattern; matches the
//    rest of the module — no global Foundry types installed) ─────────

interface FoundryFolder {
  readonly name?: string;
}

interface FoundryDocument {
  readonly id?: string;
  readonly name?: string;
  readonly folder?: FoundryFolder | null;
}

interface FoundryJournalPage extends FoundryDocument {
  readonly text?: { readonly content?: string };
  readonly sort?: number;
}

interface FoundryJournalEntry extends FoundryDocument {
  readonly pages: { [Symbol.iterator](): IterableIterator<FoundryJournalPage> };
}

interface FoundryItemDoc extends FoundryDocument {
  readonly type?: string;
  readonly system?: { readonly description?: { readonly value?: string } };
}

interface FoundrySceneDoc extends FoundryDocument {
  readonly flags?: Record<string, { readonly description?: string } | undefined>;
}

interface FoundryPack {
  readonly metadata?: {
    readonly id?: string;
    readonly packageName?: string;
  };
  readonly collection?: string;
  readonly documentName?: string;
  getDocuments(): Promise<readonly FoundryDocument[]>;
}

interface FoundryGame {
  readonly packs: Iterable<FoundryPack>;
  readonly modules: { get(id: string): { version?: string } | undefined };
  readonly user: { id: string };
}

declare const game: FoundryGame;
declare const ChatMessage: {
  create(data: { whisper?: string[]; content: string }): Promise<unknown>;
};

// ── Helpers ──────────────────────────────────────────────────────────────

function getFolderName(doc: FoundryDocument): string | undefined {
  const f = doc.folder;
  if (!f) return undefined;
  return typeof f.name === "string" && f.name.length > 0 ? f.name : undefined;
}

function packKey(pack: FoundryPack): string | undefined {
  return pack.metadata?.id ?? pack.collection ?? undefined;
}

// ── Public API ───────────────────────────────────────────────────────────

export interface EnumerateAdventureContentOptions {
  /**
   * Compendium pack keys (`<package>.<pack>` format) to enumerate.
   * Comes from the AP's `contentPackKeys` in the backend's
   * foundry-ap-registry.
   */
  readonly packKeys: readonly string[];
  /**
   * Primary detection manifest used to capture the version
   * (`game.modules.get(...)?.version`). Stored on
   * `foundry_campaigns.module_ingested_version`.
   */
  readonly versionManifestId: string;
}

export interface EnumeratedContent {
  readonly journals: readonly ModuleJournalEntry[];
  readonly items: readonly ModuleItem[];
  readonly scenes: readonly ModuleSceneSummary[];
  readonly version: string;
}

/**
 * Walk the matching compendium packs and return their full structured
 * content. Sequential, GM-whispered, defensively-typed against the
 * variety of Foundry document shapes in the wild.
 */
export async function enumerateAdventureContent(
  opts: EnumerateAdventureContentOptions
): Promise<EnumeratedContent> {
  const journals: ModuleJournalEntry[] = [];
  const items: ModuleItem[] = [];
  const scenes: ModuleSceneSummary[] = [];

  // Filter packs first so the whisper-then-enumerate pattern only
  // fires when there's actually work to do. Filter by FULL pack key
  // (`pack.metadata.id`), NOT by `packageName` — see file header.
  const packKeySet = new Set(opts.packKeys);
  const matchingPacks = Array.from(game.packs).filter((pack) => {
    const key = packKey(pack);
    return key !== undefined && packKeySet.has(key);
  });

  if (matchingPacks.length === 0) {
    const version = game.modules.get(opts.versionManifestId)?.version ?? "unknown";
    return { journals, items, scenes, version };
  }

  // GM whisper before the first heavy load so a stuttering tab is
  // explained, not alarming. Best-effort — if ChatMessage.create
  // throws, continue ingestion regardless.
  try {
    await ChatMessage.create({
      whisper: [game.user.id],
      content:
        "<p><em>Napoleon: reading module content — this takes a moment for large adventures.</em></p>",
    });
  } catch {
    // Non-fatal; continue enumeration.
  }

  // Sequential, NOT parallel — see file header constraint #1.
  for (const pack of matchingPacks) {
    if (pack.documentName === "JournalEntry") {
      const docs = (await pack.getDocuments()) as readonly FoundryJournalEntry[];
      for (const j of docs) {
        if (typeof j.id !== "string" || !j.id) continue;
        if (typeof j.name !== "string" || !j.name) continue;
        const pages: ModuleJournalPage[] = [];
        for (const p of j.pages) {
          if (typeof p.id !== "string" || !p.id) continue;
          if (typeof p.name !== "string" || !p.name) continue;
          pages.push({
            id: p.id,
            name: p.name,
            contentHtml: p.text?.content ?? "",
            sort: typeof p.sort === "number" && Number.isFinite(p.sort) ? p.sort : 0,
          });
        }
        const folder = getFolderName(j);
        journals.push({
          id: j.id,
          name: j.name,
          ...(folder ? { folder } : {}),
          pages: pages.sort((a, b) => a.sort - b.sort),
        });
      }
    } else if (pack.documentName === "Item") {
      const docs = (await pack.getDocuments()) as readonly FoundryItemDoc[];
      for (const it of docs) {
        if (typeof it.id !== "string" || !it.id) continue;
        if (typeof it.name !== "string" || !it.name) continue;
        if (typeof it.type !== "string" || !it.type) continue;
        const description = it.system?.description?.value;
        const folder = getFolderName(it);
        items.push({
          id: it.id,
          name: it.name,
          type: it.type,
          ...(typeof description === "string" && description.length > 0
            ? { descriptionHtml: description }
            : {}),
          ...(folder ? { folder } : {}),
        });
      }
    } else if (pack.documentName === "Scene") {
      const docs = (await pack.getDocuments()) as readonly FoundrySceneDoc[];
      for (const s of docs) {
        if (typeof s.id !== "string" || !s.id) continue;
        if (typeof s.name !== "string" || !s.name) continue;
        // Best-effort scene description scrape — module-specific
        // flag namespaces vary; try the version manifest's namespace
        // first, then fall back to any flag bag with a description.
        let description: string | undefined;
        const directFlag = s.flags?.[opts.versionManifestId];
        if (directFlag && typeof directFlag.description === "string" && directFlag.description.length > 0) {
          description = directFlag.description;
        }
        const folder = getFolderName(s);
        scenes.push({
          id: s.id,
          name: s.name,
          ...(description ? { description } : {}),
          ...(folder ? { folder } : {}),
        });
      }
    }
    // Other document types in matched packs (Macros, RollTables, etc.)
    // are intentionally skipped — out of scope per spec L7. Future
    // commits can extend this dispatch as new content types are added
    // to the ingestion scope.
  }

  const version = game.modules.get(opts.versionManifestId)?.version ?? "unknown";
  return { journals, items, scenes, version };
}

/**
 * Compute the counts shape the protocol response expects. Pulled out
 * so the relay-client.ts dispatcher doesn't re-walk arrays. Inputs
 * are immutable readonly arrays; this is pure summing.
 */
export function summarizeCounts(content: EnumeratedContent): {
  readonly journalEntries: number;
  readonly journalPages: number;
  readonly items: number;
  readonly scenes: number;
} {
  let journalPages = 0;
  for (const j of content.journals) journalPages += j.pages.length;
  return {
    journalEntries: content.journals.length,
    journalPages,
    items: content.items.length,
    scenes: content.scenes.length,
  };
}
