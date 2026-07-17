import { projectAgentSemanticAuditPayload } from './agent-semantic-audit-contract.mjs';

export function createAgentSemanticAuditService({ store, clock = Date.now } = {}) {
  if (typeof store?.recordAgentSemanticAudit !== 'function') {
    throw new TypeError('store.recordAgentSemanticAudit is required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  return {
    async record({
      internalUserId,
      messageRef,
      runtime,
      fallbackReason = 'none',
      proposal = null,
      resolution = null,
      phase = 'semantic_resolution',
      errorCode = '',
    } = {}) {
      const nowValue = clock();
      const createdAt = nowValue instanceof Date ? nowValue.getTime() : nowValue;
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new TypeError('clock must return a safe timestamp');
      }
      const payload = projectAgentSemanticAuditPayload({
        runtime,
        fallbackReason,
        proposal,
        resolution,
        phase,
        errorCode,
      });
      return store.recordAgentSemanticAudit({
        userId: internalUserId,
        messageRef,
        runtime: payload.runtime,
        fallbackReason: payload.fallbackReason,
        intent: payload.intent,
        operation: payload.operation,
        decision: payload.decision,
        decisionReason: payload.decisionReason,
        createdAt,
        payload,
      });
    },
  };
}
