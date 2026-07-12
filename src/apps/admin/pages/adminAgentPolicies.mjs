const ALLOWED = Object.freeze({
  decision: ['execute', 'propose', 'reject'],
  handler: ['system', 'insurance_expert', 'sales_champion'],
  operation: ['read', 'write'],
  confirmation: ['not_required', 'required'],
  outputMode: ['direct', 'structured', 'preview'],
  tool: [null, 'family_summary', 'coverage_report', 'sales_report', 'product_knowledge_search', 'create_upload_link', 'propose_memory', 'preview_transfer'],
});

const FALLBACKS = Object.freeze({
  unknown_read: { enabled: true, decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null },
  unknown_write: { enabled: true, decision: 'reject', handler: 'system', operation: 'write', confirmation: 'required', outputMode: 'direct', tool: null },
});

export function shouldDiscardDirty(dirty, confirmDiscard) {
  return !dirty || confirmDiscard('存在未保存草稿，确认丢弃这些修改吗？');
}

export function validatePolicyDraft(policies) {
  if (!Array.isArray(policies) || policies.length === 0) return ['至少需要一条策略。'];
  const errors = [];
  const keys = new Set();
  const intents = new Set();
  for (const policy of policies) {
    const label = String(policy?.key || '未命名策略');
    if (!policy?.key || !policy?.intent) errors.push(`${label} 缺少 key 或 intent。`);
    const normalizedKey = normalizePolicyIdentifier(policy?.key);
    const normalizedIntent = normalizePolicyIdentifier(policy?.intent);
    if (keys.has(normalizedKey)) errors.push(`${label} key 重复。`);
    if (intents.has(normalizedIntent)) errors.push(`${label} intent 重复。`);
    keys.add(normalizedKey);
    intents.add(normalizedIntent);
    for (const field of Object.keys(ALLOWED)) {
      if (!ALLOWED[field].includes(policy?.[field])) errors.push(`${label} 的 ${field} 不在允许范围内。`);
    }
    if (policy?.operation === 'write' && policy?.confirmation !== 'required') errors.push(`${label} 写操作必须确认。`);
    if (policy?.confidenceThreshold != null && (!Number.isFinite(policy.confidenceThreshold) || policy.confidenceThreshold < 0 || policy.confidenceThreshold > 1)) errors.push(`${label} 置信度阈值必须在 0 到 1 之间。`);
    const fallback = FALLBACKS[policy?.key];
    if (fallback) {
      for (const [field, value] of Object.entries(fallback)) {
        if ((field === 'enabled' ? policy?.enabled !== false : policy?.[field]) !== value) errors.push(`${label} 安全兜底字段 ${field === 'enabled' ? '启用状态 enabled' : field} 必须为 ${String(value)}。`);
      }
    }
  }
  for (const key of Object.keys(FALLBACKS)) {
    if (!policies.some((policy) => policy?.key === key)) errors.push(`缺少安全兜底策略 ${key}。`);
  }
  return [...new Set(errors)];
}

export function createRequestMutex() {
  let active = false;
  return {
    async run(request) {
      if (active) return undefined;
      active = true;
      try { return await request(); } finally { active = false; }
    },
  };
}

export function createLatestRequestController() {
  let generation = 0;
  let disposed = false;
  return {
    begin() {
      const current = ++generation;
      return {
        commit(update) {
          if (disposed || current !== generation) return false;
          update();
          return true;
        },
      };
    },
    invalidate() { generation += 1; },
    dispose() { disposed = true; generation += 1; },
  };
}

export function createLifecycleController() {
  let generation = 0;
  let activeToken = '';
  const scope = (token, capturedGeneration) => ({
    token,
    isCurrent: () => generation === capturedGeneration && activeToken === token,
    commit(update) {
      if (generation !== capturedGeneration || activeToken !== token) return false;
      update();
      return true;
    },
    run(action) {
      if (generation !== capturedGeneration || activeToken !== token) return false;
      action();
      return true;
    },
    invalidate() {
      if (generation === capturedGeneration) { generation += 1; activeToken = ''; }
    },
  });
  return {
    activate(token) {
      activeToken = String(token || '');
      generation += 1;
      return scope(activeToken, generation);
    },
    capture(token) { return scope(String(token || ''), generation); },
  };
}

export function normalizePolicyIdentifier(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_');
}

export function unknownQuestionViewModel(item) {
  return {
    id: Number(item?.id),
    userRef: String(item?.userRef || ''),
    category: String(item?.category || 'unrecognized_question'),
    fallbackDecision: String(item?.fallbackDecision || 'manual_review'),
    occurrenceCount: Math.max(1, Number(item?.occurrenceCount) || 1),
    status: String(item?.status || ''),
    createdAt: String(item?.createdAt || ''),
  };
}

export function simulationViewModel(response) {
  const decision = response?.decision || {};
  return {
    previewOnly: response?.previewOnly === true,
    intent: String(decision.intent || ''),
    policySource: String(decision.policySource || ''),
    familyResolved: decision.familyResolved === true,
    handler: String(decision.handler || ''),
    tool: decision.tool == null ? null : String(decision.tool),
    decision: String(decision.decision || ''),
    confirmationRequired: decision.confirmationRequired === true,
    outputMode: String(decision.outputMode || ''),
    result: String(decision.result || ''),
    explanation: String(decision.explanation || ''),
    lowConfidence: decision.result === 'low_confidence',
    writePreview: decision.result === 'write_preview',
  };
}

export function policyValidationViewModel({ loading, loadError, loaded = false, policies }) {
  if (loading || loadError || !loaded) return { ready: false, errors: [] };
  return { ready: true, errors: validatePolicyDraft(policies) };
}

export const fallbackPolicyKeys = Object.freeze(Object.keys(FALLBACKS));
