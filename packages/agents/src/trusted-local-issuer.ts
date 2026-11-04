/**
 * Restricted entry point (`@ai-agent-manager/agents/trusted-local-issuer`).
 *
 * Exposes the once-per-process capability to register Trusted Local authorizations with the
 * launch boundary. Only the orchestrator's Trusted Local gate may import it; ESLint forbids it
 * everywhere else. It is deliberately not part of the main entry point. See
 * `trusted-local-issuance.ts` for the guarantees and the in-process scope of this mechanism.
 */
export {
  claimTrustedLocalIssuer,
  type TrustedLocalIssuer,
  type TrustedLocalRunBinding,
} from './trusted-local-issuance.js';
