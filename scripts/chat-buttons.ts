/**
 * Inline chat-message button handlers — wires click handlers for
 * `[data-napoleon-send]`, `[data-napoleon-prefill]`, and
 * `[data-napoleon-world-save]` buttons that Napoleon places in follow-up
 * messages.
 *
 * `data-napoleon-send` — click dispatches `/napoleon <value>` immediately,
 *   re-entering the patched `ChatLog.processMessage` so the full query
 *   flow (placeholder → sendQuery → placeholder replacement) runs
 *   exactly as if the GM had typed the command.
 *
 * `data-napoleon-prefill` — click populates the chat input with
 *   `/napoleon <value>` and focuses it so the GM can edit before
 *   pressing Enter.
 *
 * `data-napoleon-world-save` (Phase B.4) — click triggers the
 *   Barn → Data persist flow. Sends a `client.world_save_request` to
 *   the relay with the button's data attributes (barn-path, category,
 *   slug, target-type, target-action, params). The relay forwards to
 *   the backend's `/my/foundry/world-save` endpoint and pushes the
 *   resulting `backend.data.upload` (+ optional follow-up) back over
 *   the WebSocket. The module's existing handler dispatch picks them
 *   up from there — the button click is fire-and-forget.
 *
 * Precedence: checked in order — send → world-save → prefill. Backend
 * should never produce multiple on the same element, but the order
 * guarantees a deterministic outcome.
 *
 * Typed against Foundry VTT v13.351. Uses the `renderChatMessageHTML`
 * hook (v13+ — arg 2 is a raw HTMLElement, not jQuery).
 */

import type { RelayClient } from "./relay-client.js";
import { info, debug, warn, error as logError } from "./log.js";

declare const Hooks: {
  on(event: string, callback: (...args: unknown[]) => void): void;
};

declare const ui: {
  chat: {
    constructor: {
      prototype: {
        processMessage: (this: unknown, message: string) => Promise<unknown>;
      };
    };
  };
  notifications: {
    error(message: string): void;
    info(message: string): void;
  };
};

const SEND_ATTR = "data-napoleon-send";
const PREFILL_ATTR = "data-napoleon-prefill";
const WORLD_SAVE_ATTR = "data-napoleon-world-save";
const WIRED_FLAG = "napoleonWired";

// Module-level ref to the relay client so world-save buttons can send
// without re-plumbing through the hook callback each time.
let relayClientRef: RelayClient | null = null;

export function registerChatButtonHandlers(client: RelayClient): void {
  relayClientRef = client;
  Hooks.on("renderChatMessageHTML", (_msg: unknown, html: unknown) => {
    const el = html as HTMLElement | null;
    if (!el || typeof el.querySelectorAll !== "function") return;
    wireButtons(el);
  });
  info("chat button handlers registered");
}

function wireButtons(root: HTMLElement): void {
  const buttons = root.querySelectorAll<HTMLElement>(
    `[${SEND_ATTR}], [${PREFILL_ATTR}], [${WORLD_SAVE_ATTR}]`,
  );
  if (buttons.length === 0) return;
  buttons.forEach((btn) => {
    if (btn.dataset[WIRED_FLAG] === "true") return;
    btn.dataset[WIRED_FLAG] = "true";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void handleClick(btn);
    });
  });
}

async function handleClick(btn: HTMLElement): Promise<void> {
  const send = btn.getAttribute(SEND_ATTR);
  if (send !== null && send.length > 0) {
    debug(
      `napoleon-send click → /napoleon ${send.slice(0, 60)}${send.length > 60 ? "..." : ""}`,
    );
    try {
      await ui.chat.constructor.prototype.processMessage.call(
        ui.chat,
        `/napoleon ${send}`,
      );
    } catch (err) {
      logError(
        `napoleon-send dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (btn.hasAttribute(WORLD_SAVE_ATTR)) {
    await handleWorldSaveClick(btn);
    return;
  }

  const prefill = btn.getAttribute(PREFILL_ATTR);
  if (prefill !== null && prefill.length > 0) {
    debug(`napoleon-prefill click → populating chat input`);
    const input = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      "#chat-message",
    );
    if (!input) {
      logError("napoleon-prefill: could not find chat input #chat-message");
      return;
    }
    input.value = `/napoleon ${prefill}`;
    input.focus();
    if ("setSelectionRange" in input) {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }
}

/**
 * Handle a click on a `data-napoleon-world-save` button. Reads the
 * data-* attributes the backend emitted via `emit_chat_preview_with_save`,
 * parses the `data-params` JSON (ignoring malformed input with a GM
 * notification), and sends a `client.world_save_request` via the relay.
 *
 * Disables the button briefly so repeat-clicks don't double-fire. The
 * backend.data.upload response lands via the normal handler dispatch;
 * on failure the GM sees a `ui.notifications.error` from the
 * handleDataUpload path. Either way the button re-enables shortly for
 * retry.
 */
async function handleWorldSaveClick(btn: HTMLElement): Promise<void> {
  if (!relayClientRef) {
    logError("napoleon-world-save click but relayClientRef is unset");
    ui.notifications.error("Save to World: module not fully initialized yet. Try again.");
    return;
  }

  const barnPath = btn.getAttribute("data-barn-path");
  const category = btn.getAttribute("data-category");
  const slug = btn.getAttribute("data-slug");
  const targetType = btn.getAttribute("data-target-type");
  const targetAction = btn.getAttribute("data-target-action");
  const paramsRaw = btn.getAttribute("data-params");

  if (!barnPath || !category || !slug || !targetType || !targetAction) {
    logError(
      `napoleon-world-save click missing required data-* attrs (barn=${barnPath}, category=${category}, slug=${slug}, targetType=${targetType}, targetAction=${targetAction})`,
    );
    ui.notifications.error("Save to World: button is malformed (missing data attributes).");
    return;
  }

  let params: Record<string, unknown> = {};
  if (paramsRaw && paramsRaw.length > 0) {
    try {
      const parsed = JSON.parse(paramsRaw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        warn(`napoleon-world-save: data-params parsed to non-object, ignoring`);
      }
    } catch (err) {
      logError(
        `napoleon-world-save: data-params is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      ui.notifications.error("Save to World: button has invalid params JSON.");
      return;
    }
  }

  // Disable the button briefly. We re-enable after 2s regardless of outcome
  // — even if the save succeeds, the GM might want to click Regenerate
  // next, and stuck-disabled state is worse than a brief window of
  // retry-clickability.
  const buttonEl = btn as HTMLButtonElement;
  const originalText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Saving…";
  setTimeout(() => {
    buttonEl.disabled = false;
    buttonEl.textContent = originalText;
  }, 2000);

  debug(
    `napoleon-world-save click → category=${category}, slug=${slug}, targetType=${targetType}, targetAction=${targetAction}`,
  );

  const msgId = relayClientRef.sendWorldSaveRequest({
    barnPath,
    category: category as "npcs" | "scenes" | "maps" | "items" | "journals" | "gm",
    slug,
    targetType: targetType as "actor" | "scene" | "token" | "journal" | "save_only",
    targetAction: targetAction as "create" | "update",
    params,
  });

  if (msgId === null) {
    ui.notifications.error("Save to World: relay is not connected.");
  }
}
