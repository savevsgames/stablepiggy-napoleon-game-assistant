/**
 * `/napoleon` chat command integration — the GM's entry point into the
 * StablePiggy Napoleon Game Assistant.
 *
 * ## What this file does
 *
 * Registers a `chatMessage` Foundry hook. When the GM types `/napoleon
 * <query>` in the chat input and hits Enter, this handler:
 *
 *   1. Intercepts the message before Foundry's default chat dispatch runs
 *   2. Extracts the query text after the `/napoleon ` prefix
 *   3. Immediately creates a "Napoleon is thinking…" placeholder chat
 *      message so the GM sees instant feedback (within ~50ms of pressing
 *      Enter, not after the backend responds)
 *   4. Sends a `client.query` to the relay via `RelayClient.sendQuery()`
 *      and registers the placeholder under the returned message id so the
 *      inbound `backend.chat.create` can replace it
 *   5. Starts a 15-second timeout that replaces the placeholder with an
 *      error message if the backend never responds — keeps the GM from
 *      staring at a silently stuck "thinking…" forever
 *   6. Returns `false` from the hook to suppress Foundry's default
 *      dispatch (so the raw `/napoleon ...` text never echoes in the chat
 *      log)
 *
 * The placeholder-replacement flow is the star of M5: the whole point is
 * that the GM never sees a silent gap between typing the command and
 * getting the response. When `RelayClient.handleChatCreate()` receives a
 * `backend.chat.create` whose `correlationId` matches a registered
 * placeholder, it calls `message.update()` on the placeholder instead of
 * creating a new chat entry — so the content flips from "thinking…" to
 * the real response in place.
 *
 * ## Tier 1 vs Tier 2 scope
 *
 * **Tier 1 (current).** The command is GM-only. Players who type
 * `/napoleon` in chat see no effect — the hook checks `game.user.isGM`
 * and bails out if false. The placeholder is always whispered to
 * `game.user.id` (the GM themselves) so no table chatter pollution.
 *
 * **Tier 2 (future).** When we open Napoleon to per-player features we'll
 * revisit: players may be allowed to run `/napoleon` with a scoped
 * permission, placeholders may be whispered to the sender rather than
 * blanket-to-GM, and the dispatch may route via a per-player session
 * instead of the shared GM connection. None of that lands until the
 * product supports it — Tier 1 is a GM tool and this file reflects that.
 *
 * ## Conversation session id
 *
 * Each `/napoleon` query carries a `sessionId` that the backend uses to
 * maintain conversation context across multiple turns. For Tier 1 we
 * derive a stable id from the Foundry world id + GM user id, computed
 * once at command registration time. Every query in the same Foundry
 * session reuses that id, which matches the "sessionId is reused across
 * every query in the same connection" contract in BACKEND-API-SPEC.md
 * §2.5 and phase2-tier1-plan.md §3.
 *
 * Typed against Foundry VTT v13.351. The hand-rolled declares cover
 * only the surface this file touches — the `chatMessage` hook
 * signature, `ChatMessage.create()`, `game.user`, and `ui.notifications`.
 * Duplicate declarations with other files (e.g. relay-client.ts) are
 * deliberate per docs/foundry-conventions.md §2.
 */

import type { RelayClient } from "./relay-client.js";
import { info, warn, error as logError, debug } from "./log.js";

const MODULE_ID = "stablepiggy-napoleon-game-assistant";
const COMMAND_PREFIX = "/napoleon ";

/** How long (ms) to wait for a backend response before replacing the
 *  placeholder with an error message. 15 seconds is generous enough for
 *  the real LLM call (M6/P3) while still feeling responsive. */
const RESPONSE_TIMEOUT_MS = 15_000;

// ── Foundry globals used by this file ──────────────────────────────────
// Typed against Foundry VTT v13.351. See docs/foundry-conventions.md §2.

interface FoundryChatMessage {
  readonly id: string;
  update(
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
}

interface FoundryChatMessageCreateData {
  content: string;
  style: number;
  speaker?: { alias?: string; actor?: string };
  whisper?: readonly string[];
  flags?: Record<string, Record<string, unknown>>;
}

declare const ChatMessage: {
  create(
    data: FoundryChatMessageCreateData,
    options?: Record<string, unknown>
  ): Promise<FoundryChatMessage | undefined>;
};

declare const CONST: {
  CHAT_MESSAGE_STYLES: {
    OTHER: number;
    OOC: number;
    IC: number;
    EMOTE: number;
  };
};

declare const game: {
  messages: {
    get(id: string): FoundryChatMessage | undefined;
  };
  user: {
    readonly id: string;
    readonly isGM: boolean;
  };
  world: { readonly id: string };
};

declare const ui: {
  notifications: {
    warn(message: string): void;
    error(message: string): void;
  };
};

declare const Hooks: {
  on(
    event: "chatMessage",
    callback: (
      chatLog: unknown,
      messageText: string,
      chatData: Record<string, unknown>
    ) => boolean | void
  ): void;
};

// ── Command registration ───────────────────────────────────────────────

/**
 * Register the `/napoleon` chat command hook. Call once from the
 * Foundry `ready` hook in main.ts, after the RelayClient has been
 * constructed. Safe to call multiple times — Foundry deduplicates
 * hook registrations by callback identity, which is stable across
 * imports because this file only declares the function once.
 */
export function registerChatCommand(client: RelayClient): void {
  const sessionId = computeSessionId();
  info(`chat command registered (sessionId=${sessionId})`);

  Hooks.on("chatMessage", (_chatLog, messageText, _chatData) => {
    if (typeof messageText !== "string" || !messageText.startsWith(COMMAND_PREFIX)) {
      return; // not our command, let Foundry handle it normally
    }

    // GM-only gate. Tier 1 is a GM tool; players typing /napoleon see
    // no effect. When/if we open this to per-player use in Tier 2 we
    // replace this check with a capability check against the sender.
    if (!game.user.isGM) {
      return; // fall through to normal chat so players see their own text
    }

    const query = messageText.slice(COMMAND_PREFIX.length).trim();
    if (query.length === 0) {
      ui.notifications.warn("Napoleon: query text was empty");
      return false; // suppress the bare /napoleon echo
    }

    // Don't await inside the hook callback — Foundry expects an
    // immediate boolean return. Kick off the async flow and return
    // false synchronously to suppress the default dispatch.
    void handleNapoleonQuery(client, sessionId, query);
    return false;
  });
}

// ── Query flow ─────────────────────────────────────────────────────────

async function handleNapoleonQuery(
  client: RelayClient,
  sessionId: string,
  query: string
): Promise<void> {
  if (client.getStatus() !== "connected") {
    warn(
      `/napoleon typed while relay is ${client.getStatus()} — rendering error`
    );
    await renderErrorChat(
      "Napoleon is not connected to the relay. Check the module settings and reload the world."
    );
    return;
  }

  // Create the placeholder FIRST so the GM sees instant feedback. The
  // content is italicized "thinking…" whispered to self. The flag
  // `stablepiggy-napoleon-game-assistant.placeholder = true` lets
  // future milestones (M7) find and clean up any orphaned placeholders
  // across world reloads.
  const placeholder = await ChatMessage.create({
    content: "<p><em>Napoleon is thinking…</em></p>",
    style: CONST.CHAT_MESSAGE_STYLES.OTHER,
    speaker: { alias: "Napoleon" },
    whisper: [game.user.id],
    flags: {
      [MODULE_ID]: { placeholder: true },
    },
  });

  if (!placeholder?.id) {
    logError("ChatMessage.create for placeholder returned no id");
    ui.notifications.error("Napoleon: failed to render placeholder message");
    return;
  }

  // Send the query. This returns the message id that the backend will
  // echo back as `correlationId` on the response — which is what we
  // key the placeholder replacement on.
  const queryId = client.sendQuery({
    sessionId,
    query,
    context: {
      // Tier 1 leaves these empty. M5 could plumb through game.scenes
      // .current?.id and selected actors, but the plan doesn't require
      // it and the backend stub doesn't use them yet.
      sceneId: null,
      selectedActorIds: [],
      inCombat: false,
      recentChat: [],
    },
  });

  if (queryId === null) {
    // sendQuery dropped the message (socket died between the status
    // check and the send). Convert the placeholder into an error.
    await safeUpdate(placeholder.id, {
      content:
        "<p><em>Napoleon: the relay dropped the query. Try again in a moment.</em></p>",
    });
    return;
  }

  client.registerPlaceholder(queryId, placeholder.id);
  debug(`placeholder registered: correlationId=${queryId}, msgId=${placeholder.id}`);

  // Timeout: if the backend is still silent after 15 seconds, replace
  // the placeholder with an error so the GM isn't staring at a stuck
  // "thinking…" forever. If the real response has already arrived by
  // then, the placeholder is no longer registered and this is a no-op.
  setTimeout(() => {
    void expireIfPending(client, queryId, placeholder.id);
  }, RESPONSE_TIMEOUT_MS);
}

async function expireIfPending(
  client: RelayClient,
  correlationId: string,
  placeholderMsgId: string
): Promise<void> {
  if (!client.hasPlaceholder(correlationId)) {
    return; // already replaced by the real response
  }
  client.unregisterPlaceholder(correlationId);
  warn(`/napoleon query timed out after ${RESPONSE_TIMEOUT_MS}ms (correlationId=${correlationId})`);
  await safeUpdate(placeholderMsgId, {
    content:
      "<p><em>Napoleon: no response from the backend within 15 seconds. The relay or backend may be down.</em></p>",
  });
}

async function renderErrorChat(text: string): Promise<void> {
  try {
    await ChatMessage.create({
      content: `<p><em>${escapeHtml(text)}</em></p>`,
      style: CONST.CHAT_MESSAGE_STYLES.OTHER,
      speaker: { alias: "Napoleon" },
      whisper: [game.user.id],
    });
  } catch (err) {
    logError(
      `failed to render error chat: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function safeUpdate(
  messageId: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const msg = game.messages.get(messageId);
    if (!msg) {
      debug(`safeUpdate: message ${messageId} not found (deleted?)`);
      return;
    }
    await msg.update(data);
  } catch (err) {
    logError(
      `safeUpdate failed for ${messageId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function computeSessionId(): string {
  return `napoleon-${game.world.id}-${game.user.id}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
