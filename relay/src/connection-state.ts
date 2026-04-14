/**
 * Per-connection state stored by the relay for every open WebSocket.
 *
 * ## Lifecycle
 *
 * A connection has two lifecycle phases:
 *
 *   1. **Pending** (`helloCompleted === false`). The WebSocket upgrade has
 *      succeeded but no valid `client.hello` has been processed yet. A 2-
 *      second grace timer runs in parallel; if it fires before hello
 *      arrives, the server closes the socket with code 1008 ("auth
 *      required"). During this phase `identityId`, `worldId`, etc. are
 *      undefined and no queries are accepted.
 *
 *   2. **Authenticated** (`helloCompleted === true`). The relay has
 *      received a valid hello, verified its `authToken`, and populated the
 *      identity/world/capabilities fields. The grace timer has been
 *      cleared. Queries are now accepted on this connection and forwarded
 *      to the backend with the stored `identityId`.
 *
 * The auth token verification in the hello handler determines `identityId`
 * in one of two ways:
 *
 *   - **API-key mode** (`authMode === "apikey"`): the token starts with
 *     `dv-`, the relay calls the backend's identity resolution endpoint,
 *     and the real StablePiggy identity ID comes back. This unlocks vault
 *     access, campaign memory, and metering on every query.
 *
 *   - **Anonymous mode** (`authMode === "anonymous"`): the token matches
 *     the relay's configured `RELAY_SHARED_SECRET`, and the relay
 *     synthesizes a synthetic identity (`anon:<worldId>:<gmUserId>`). The
 *     backend accepts any non-empty string for identityId and logs against
 *     it, but no vault, no memory, no per-user metering. The upgrade path
 *     to a real account is literally "paste a dv- key here instead."
 *
 * See BACKEND-API-SPEC.md §2.5 in the platform repo for the full contract.
 */

import type { WebSocket } from "ws";
import type { ClientCapabilities } from "@stablepiggy-napoleon/protocol";
import { makeMessageId } from "@stablepiggy-napoleon/protocol";

export type AuthMode = "apikey" | "anonymous";

export interface ConnectionState {
  /** Unique connection ID generated at accept time. Used as Map key. */
  readonly id: string;
  /** The underlying WebSocket. */
  readonly socket: WebSocket;
  /** Remote peer address for logging. */
  readonly remoteAddress: string;
  /** Timestamp when the connection was accepted. */
  readonly connectedAt: number;

  /** True once a valid `client.hello` has been processed and auth verified. */
  helloCompleted: boolean;
  /**
   * Handle for the pending-auth grace timer. Set at accept time, cleared
   * when hello is successfully processed, fires a 1008 close if hello does
   * not arrive in time.
   */
  helloGraceTimer?: ReturnType<typeof setTimeout>;
  /**
   * How this connection was authenticated. Undefined while pending, set
   * to "apikey" or "anonymous" after successful hello verification.
   */
  authMode?: AuthMode;
  /**
   * Identity ID used when forwarding queries to the backend. In API-key
   * mode this is the real StablePiggy identity. In anonymous mode this
   * is a synthetic value constructed from world and GM user IDs.
   */
  identityId?: string;
  /** Foundry world ID — populated from hello.payload.worldId. */
  worldId?: string;
  /** Primary-GM flag from hello.payload.isPrimaryGM. */
  isPrimaryGM?: boolean;
  /** Module version string from hello.payload.moduleVersion. */
  moduleVersion?: string;
  /** Client capabilities declaration from hello.payload.capabilities. */
  capabilities?: ClientCapabilities;

  /** Timestamp of the last message received or sent on this connection. */
  lastActivityAt: number;
}

const connections = new Map<string, ConnectionState>();

export function registerConnection(
  socket: WebSocket,
  remoteAddress: string
): ConnectionState {
  const state: ConnectionState = {
    id: makeMessageId(),
    socket,
    remoteAddress,
    connectedAt: Date.now(),
    helloCompleted: false,
    lastActivityAt: Date.now(),
  };
  connections.set(state.id, state);
  return state;
}

export function unregisterConnection(id: string): void {
  const state = connections.get(id);
  if (state?.helloGraceTimer) {
    clearTimeout(state.helloGraceTimer);
  }
  connections.delete(id);
}

export function getConnection(id: string): ConnectionState | undefined {
  return connections.get(id);
}

export function connectionCount(): number {
  return connections.size;
}
