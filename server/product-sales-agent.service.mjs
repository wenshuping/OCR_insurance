import { assembleProductAgentContext } from './product-agent-context.service.mjs';
import { validateProductAgentResponse } from './product-agent-validator.service.mjs';

const text = (value) => String(value ?? '').trim();
function agentError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }

export function createProductSalesAgent(options = {}) {
  const { agentStore, ragService, modelAdapter } = options;
  async function runTurn(input = {}) {
    const tenantId = text(input.tenantId) || 'default'; const userId = text(input.userId); const threadId = text(input.threadId); const query = text(input.query);
    const thread = agentStore?.getThread({ tenantId, userId, threadId });
    if (!thread) throw agentError('AGENT_THREAD_NOT_FOUND', '销售建议会话不存在', 404);
    if (!query) throw agentError('AGENT_QUERY_REQUIRED', '请输入要咨询的问题', 400);
    if (typeof modelAdapter !== 'function') throw agentError('AGENT_MODEL_UNAVAILABLE', '销售建议模型暂不可用', 503);
    const userMessage = agentStore.appendMessage({ tenantId, userId, threadId, role: 'user', content: query });
    let taskState = agentStore.getTaskState({ tenantId, userId, threadId });
    if (!taskState) taskState = agentStore.saveTaskState({ tenantId, userId, threadId, taskType: 'product_sales' });
    const products = taskState.candidateProducts || [];
    const evidencePackage = ragService.retrieve({ tenantId, query, products, canonicalProductId: products.length === 1 ? text(products[0]?.canonicalProductId) : '' });
    const context = assembleProductAgentContext({
      query,
      messages: agentStore.listMessages({ tenantId, userId, threadId, limit: 100 }),
      taskState,
      confirmedMemories: agentStore.listMemories({ tenantId, userId, customerId: thread.customerId, status: 'confirmed' }),
      evidencePackage,
      characterBudget: input.characterBudget,
    });
    let proposed;
    try { proposed = await modelAdapter({ prompt: context.prompt, sections: context.sections, evidencePackage, taskState }); }
    catch { proposed = { answer: '', claims: [], citations: [] }; }
    const validation = validateProductAgentResponse({ response: proposed, evidencePackage, candidateProducts: products });
    const response = validation.valid ? proposed : validation.fallback;
    const run = agentStore.recordRecommendationRun({
      tenantId, threadId, status: validation.valid ? 'validated' : 'human_review_required',
      request: { query, userMessageId: userMessage.id, taskStateVersion: taskState.stateVersion },
      evidence: evidencePackage, response, validation,
      modelVersion: text(input.modelVersion) || 'adapter', promptVersion: 'product-agent-context-v1',
    });
    const assistantMessage = agentStore.appendMessage({
      tenantId, userId, threadId, role: 'assistant',
      content: text(response?.answer) || '现有证据不足，需要人工确认。',
      payload: { recommendationRunId: run.id, validation },
    });
    return { thread, taskState, evidencePackage, response, validation, run, assistantMessage };
  }
  return { runTurn };
}
