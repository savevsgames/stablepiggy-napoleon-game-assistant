/**
 * Session capture — auto-capture notable Foundry chat events and send
 * them to the relay as `client.session_event` messages for Trough
 * persistence.
 *
 * Registered in main.ts inside the `ready` hook after RelayClient
 * construction. Listens on `Hooks.on("createChatMessage", ...)` which
 * fires for every chat message in Foundry (GM and player alike).
 *
 * ## Filter rules (client-side, first pass)
 *
 * IN:
 *   - GM dice rolls (attacks, saves, skill checks)
 *   - Napoleon exchanges (to/from Napoleon speaker alias)
 *   - Combat events (initiative, damage, conditions)
 *   - GM whispers to specific players
 *
 * OUT:
 *   - Player banter (non-GM, non-Napoleon)
 *   - OOC chat (messages starting with `(` or `[OOC]`)
 *   - Bare dice rolls with no label
 *   - Messages from non-GM users (unless Napoleon)
 *
 * The relay applies a second dedup/truncation pass before flushing to
 * the backend. See relay/src/session-buffer.ts.
 */

import type { SessionEventPayload, SessionEventType } from "@stablepiggy-napoleon/protocol";
import type { RelayClient } from "./relay-client.js";
import { debug } from "./log.js";

const NAPOLEON_ALIASES = new Set(["napoleon", "napoleon (m2 stub)"]);
const MAX_CONTENT_LENGTH = 500;

declare const Hooks: {
  on(event: string, callback: (...args: unknown[]) => void): void;
};

declare const game: {
  user: { readonly id: string; readonly isGM: boolean };
  world: { readonly id: string };
  combat: { readonly round: number; readonly active: boolean } | null;
  scenes: { readonly active: { readonly id: string } | null };
  users: { get(id: string): { readonly isGM: boolean } | undefined };
};

interface FoundryChatMessage {
  readonly id: string;
  readonly content: string;
  readonly timestamp: number;
  readonly speaker: {
    readonly alias?: string;
    readonly actor?: string;
  };
  readonly user: { readonly id: string; readonly isGM: boolean } | null;
  readonly whisper: readonly string[];
  readonly isRoll: boolean;
  readonly rolls: readonly unknown[];
  readonly flavor?: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

function classifyEvent(msg: FoundryChatMessage): SessionEventType | null {
  const speakerAlias = (msg.speaker?.alias ?? "").toLowerCase();
  const content = stripHtml(msg.content);

  // Filter OUT: OOC chat
  if (content.startsWith("(") || content.toUpperCase().startsWith("[OOC]")) {
    return null;
  }

  // Napoleon exchanges — always notable
  if (NAPOLEON_ALIASES.has(speakerAlias)) {
    return "napoleon_exchange";
  }

  const isGM = msg.user?.isGM ?? false;

  // GM whispers to specific players
  if (isGM && msg.whisper.length > 0) {
    // Only capture whispers that have actual content
    if (content.length > 0) {
      return "gm_whisper";
    }
    return null;
  }

  // GM dice rolls with labels or context
  if (isGM && msg.isRoll) {
    const flavor = msg.flavor ?? "";
    // Filter OUT bare dice with no label
    if (content.length === 0 && flavor.length === 0) {
      return null;
    }
    return "roll";
  }

  // Combat events from GM: initiative, damage narration
  if (isGM && game.combat?.active) {
    if (content.length > 0) {
      return "combat";
    }
  }

  // Filter OUT: player banter and anything else
  return null;
}

export function registerSessionCapture(client: RelayClient): void {
  Hooks.on("createChatMessage", (rawMsg: unknown) => {
    const msg = rawMsg as FoundryChatMessage;

    const eventType = classifyEvent(msg);
    if (!eventType) return;

    const content = stripHtml(msg.content).slice(0, MAX_CONTENT_LENGTH);
    const speaker = msg.speaker?.alias ?? "Unknown";

    const payload: SessionEventPayload = {
      eventType,
      timestamp: msg.timestamp ?? Date.now(),
      speaker,
      content,
      metadata: {
        worldId: game.world.id,
        ...(game.scenes?.active?.id ? { sceneId: game.scenes.active.id } : {}),
        ...(game.combat?.active ? { combatRound: game.combat.round } : {}),
      },
    };

    debug(`session capture: ${eventType} from ${speaker} (${content.slice(0, 40)}...)`);
    client.sendSessionEvent(payload);
  });
}
