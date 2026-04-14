/**
 * Per-connection state stored by the relay for every open WebSocket.
 *
 * The `helloCompleted` flag gates query handling — queries arriving on a
 * connection that has not finished its hello handshake are rejected with a
 * protocol `error` message. `identityId`, `worldId`, and `capabilities` are
 * populated from `client.hello` and used by the backend HTTP client when
 * forwarding queries to the Foundry query endpoint.
 *
 * `sessionId` is NOT stored per-connection — it lives on each
 * `client.query` payload and is read/forwarded on a per-message basis. See
 * BACKEND-API-SPEC.md §2.5 in the platform repo for the full contract.
 */

import type { WebSocket } from "ws";
import type { ClientCapabilities } from "@stablepiggy-napoleon/protocol";
import { makeMessageId } from "@stablepiggy-napoleon/protocol";

export interface ConnectionState {
  /** Unique connection ID generated at accept time. Used as Map key. */
  readonly id: string;
  /** The underlying WebSocket. */
  readonly socket: WebSocket;
  /** Remote peer address for logging. */
  readonly remoteAddress: string;
  /** Timestamp when the connection was accepted. */
  readonly connectedAt: number;

  /** True once a valid `client.hello` has been processed. */
  helloCompleted: boolean;
  /** GM's StablePiggy identity ID — populated from hello.payload.gmUserId. */
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
  connections.delete(id);
}

export function getConnection(id: string): ConnectionState | undefined {
  return connections.get(id);
}

export function connectionCount(): number {
  return connections.size;
}
