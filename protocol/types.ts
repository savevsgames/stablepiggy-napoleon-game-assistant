/**
 * Protocol v1 — message types
 *
 * Step 0 (current): ships the version constant and an empty type space so the
 * protocol package builds cleanly and the module and relay can import from it
 * without errors.
 *
 * Step 1 (next): fills in the full v1 message spec from
 * planning/phase2-tier1-plan.md §3 — MessageKind enum, ProtocolMessage<K>
 * envelope, payload interfaces for every kind, and the validateMessage()
 * runtime guard used by the relay to validate inbound messages.
 *
 * The contract must stay backward-compatible within v1. Breaking changes
 * require bumping PROTOCOL_VERSION and ensuring both module and relay handle
 * the version mismatch gracefully (the relay rejects unknown versions; the
 * module shows a "please update" notice in the GM's settings panel).
 */

/**
 * The current protocol version. Both the module and the relay declare this
 * version on connect; mismatches are treated as fatal connection errors.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Type alias for the protocol version constant.
 */
export type ProtocolVersion = typeof PROTOCOL_VERSION;
