/**
 * Restricted entry point (`@ai-agent-manager/agents/conversation-issuer`). ESLint allows it only
 * in the orchestrator's conversation gate, which claims the issuer once when it loads.
 */
export {
  claimConversationIssuer,
  type ConversationIssuer,
  type ConversationTurnBinding,
} from './conversation-issuance.js';
