const ALLOWED_SOURCES = new Set(['user_explicit', 'verified_business_record', 'human_review']);
const FORBIDDEN_SOURCES = new Set(['assistant_answer', 'generated_summary', 'retrieved_marketing_claim', 'model_inference']);
const text = (value) => String(value ?? '').trim();

function gateError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }

export function createProductAgentMemoryService({ store } = {}) {
  function propose(input = {}) {
    const sourceType = text(input.sourceType);
    if (FORBIDDEN_SOURCES.has(sourceType) || !ALLOWED_SOURCES.has(sourceType)) {
      throw gateError('AGENT_MEMORY_SOURCE_REJECTED', '该来源不能写入长期记忆候选');
    }
    if (!text(input.tenantId) || !text(input.userId) || !text(input.memoryType) || !input.content) {
      throw gateError('AGENT_MEMORY_INVALID', '长期记忆候选缺少必要字段');
    }
    if (input.sourceCustomerId && text(input.sourceCustomerId) !== text(input.customerId)) {
      throw gateError('AGENT_MEMORY_CUSTOMER_SCOPE_MISMATCH', '不能把其他客户的信息写入当前客户记忆', 403);
    }
    return store.createMemory({ ...input, sourceType });
  }
  function decide(input = {}) {
    if (!['confirmed', 'rejected', 'expired'].includes(text(input.status))) throw gateError('AGENT_MEMORY_STATUS_INVALID', '记忆审核状态无效');
    if (!text(input.actor)) throw gateError('AGENT_MEMORY_ACTOR_REQUIRED', '记忆审核必须记录操作人');
    return store.transitionMemory(input);
  }
  return { decide, propose };
}
