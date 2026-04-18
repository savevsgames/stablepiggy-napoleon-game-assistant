/**
 * Inline chat-message button handlers — wires click handlers for
 * `[data-napoleon-send]` and `[data-napoleon-prefill]` buttons that
 * Napoleon places in follow-up messages (e.g. the NPC portrait
 * buttons rendered after actor creation).
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
 * Precedence: if both attributes are present on a button, `-send` wins
 * and `-prefill` is ignored. The backend should never produce both on
 * the same element, but the precedence guarantees a deterministic
 * outcome.
 *
 * Typed against Foundry VTT v13.351. Uses the `renderChatMessageHTML`
 * hook (v13+ — arg 2 is a raw HTMLElement, not jQuery).
 */

import type { RelayClient } from "./relay-client.js";
import { info, debug, error as logError } from "./log.js";

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
};

const SEND_ATTR = "data-napoleon-send";
const PREFILL_ATTR = "data-napoleon-prefill";
const WIRED_FLAG = "napoleonWired";

export function registerChatButtonHandlers(_client: RelayClient): void {
  Hooks.on("renderChatMessageHTML", (_msg: unknown, html: unknown) => {
    const el = html as HTMLElement | null;
    if (!el || typeof el.querySelectorAll !== "function") return;
    wireButtons(el);
  });
  info("chat button handlers registered");
}

function wireButtons(root: HTMLElement): void {
  const buttons = root.querySelectorAll<HTMLElement>(
    `[${SEND_ATTR}], [${PREFILL_ATTR}]`,
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
