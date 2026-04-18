/**
 * @stablepiggy-napoleon/protocol
 *
 * Shared TypeScript types for the StablePiggy Napoleon Game Assistant module
 * and relay service. Both packages import from this barrel and from ./types.
 *
 * The contract here is the single source of truth for what messages can flow
 * over the WebSocket connection between the Foundry module and the relay.
 * Adding a new message type means updating types.ts and implementing the
 * corresponding handler in BOTH the module (../scripts) and the relay
 * (../relay/src). TypeScript will catch any drift between them at compile
 * time.
 *
 * See planning/phase2-tier1-plan.md §3 for the protocol v1 specification.
 */
export * from "./types.js";
//# sourceMappingURL=index.d.ts.map