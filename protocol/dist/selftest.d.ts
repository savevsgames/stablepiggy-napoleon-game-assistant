/**
 * Protocol v1 self-test
 *
 * Run via `npm run test` at the repo root or `npm run test -w
 * @stablepiggy-napoleon/protocol`. Exits with code 0 on success, 1 on any
 * failure.
 *
 * This is a minimal hand-rolled test harness — no Jest, no Vitest, no ts-node.
 * The protocol is small enough that a single file of assertions gives us the
 * coverage we need for Step 1. We'll move to Vitest if the contract grows
 * beyond what one file can comfortably hold.
 *
 * Test cases cover:
 *   - Envelope validation (version, id, ts, kind, payload required)
 *   - Each message kind's payload validation (valid + invalid cases)
 *   - Error code correctness (validation_failed vs protocol_mismatch vs
 *     unknown_kind)
 *   - makeMessage() helper produces messages that validate cleanly
 *   - makeMessageId() produces 16-char alphanumeric IDs
 */
export {};
//# sourceMappingURL=selftest.d.ts.map