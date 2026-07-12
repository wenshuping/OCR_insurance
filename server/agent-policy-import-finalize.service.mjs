import { agentPolicyImportMatchesOwner, updateAgentPolicyImportTask } from './agent-policy-import.service.mjs';

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function text(value) {
  return String(value ?? '').trim();
}

function publicResult(record = {}, task = {}) {
  return {
    taskId: Number(record.taskId || task.id),
    policyId: Number(record.formalPolicyId),
    summary: {
      company: text(task.draft?.company),
      productName: text(task.draft?.name),
      insured: text(task.draft?.insured) ? `${[...text(task.draft.insured)][0]}**` : '',
    },
    completedAt: text(record.completedAt),
  };
}

function assertReady({ state, task, family, owner, stateVersion }) {
  if (!task || !family || Number(task.familyId) !== Number(family.id) || !agentPolicyImportMatchesOwner(task, owner)) fail('POLICY_IMPORT_NOT_FOUND', '保单录入任务不存在', 404);
  if (!owner?.userId || Number(task.ownerUserId) !== Number(owner.userId)) fail('POLICY_IMPORT_USER_REQUIRED', '正式保存需要已验证的内部用户', 403);
  if (String(family.status || 'active') !== 'active') fail('FAMILY_NOT_FOUND', '家庭档案不存在', 404);
  if (Number(stateVersion) !== Number(task.stateVersion)) fail('STALE_INTERACTION', '任务状态已更新，请刷新后重试', 409);
  if (task.status !== 'saving') fail('FINAL_CONFIRMATION_REQUIRED', '请先明确确认最终保单摘要', 409);
  if (!Array.isArray(task.events) || !task.events.some((event) => event.action === 'confirm' && Number(event.stateVersion) === Number(task.stateVersion))) fail('FINAL_CONFIRMATION_REQUIRED', '缺少有效的最终确认动作', 409);
  if (!task.draft?.company || !task.draft?.name || !task.draft?.insured) fail('POLICY_IMPORT_INCOMPLETE', '保单信息尚未补充完整', 409);
  if (task.fieldConflicts?.length) fail('POLICY_IMPORT_CONFLICT', '保单字段仍有冲突', 409);
  if (!task.documents?.length || task.documents.some((document) => !['recognized', 'removed'].includes(document.status))) fail('POLICY_IMPORT_DOCUMENTS_PENDING', '附件仍在处理或存在失败', 409);
  if (!['trusted_match', 'selected', 'manual_confirmed'].includes(task.productResolution) || (task.productResolution !== 'manual_confirmed' && !task.draft.productId)) fail('POLICY_IMPORT_PRODUCT_UNRESOLVED', '产品尚未确认', 409);
  const product = (state.knowledgeRecords || []).find((row) => String(row.canonicalProductId || row.productId || row.id) === String(task.draft.productId));
  if (task.productResolution !== 'manual_confirmed' && (!product || text(product.productName || product.name) !== text(task.draft.name))) fail('POLICY_IMPORT_PRODUCT_CHANGED', '已确认产品不再可用', 409);
  for (const role of ['insured', 'applicant']) {
    const memberId = task.draft?.[`${role}MemberId`];
    if (!memberId && (role === 'insured' || task.draft?.applicant)) fail('POLICY_IMPORT_MEMBER_UNRESOLVED', '家庭成员尚未确认', 409);
    if (!memberId) continue;
    const member = (state.familyMembers || []).find((row) => Number(row.id) === Number(memberId) && Number(row.familyId) === Number(family.id) && String(row.status || 'active') === 'active');
    if (!member) fail('POLICY_IMPORT_PERMISSION_CHANGED', '家庭成员或权限已变更', 403);
  }
}

export function createAgentPolicyImportFinalizer({
  state,
  reserve,
  complete,
  findRecord,
  failRecord,
  createPolicy,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const inFlight = new Map();
  async function run({ task, family, owner, requestId, stateVersion } = {}) {
    const stableRequestId = text(requestId);
    if (!stableRequestId || stableRequestId.length > 120) fail('INVALID_REQUEST_ID', 'requestId 无效');
    const prior = await findRecord?.({ ownerUserId: owner?.userId, taskId: task?.id, requestId: stableRequestId });
    if (prior?.status === 'completed') return publicResult(prior, task);
    const completedForTask = await findRecord?.({ ownerUserId: owner?.userId, taskId: task?.id });
    if (completedForTask?.status === 'completed') return publicResult(completedForTask, task);
    if (prior?.status === 'reserved' || prior?.status === 'failed_unknown') {
      const reconciledPolicy = (state.policies || []).find((policy) => Number(policy.sourcePolicyImportTaskId) === Number(task?.id) && Number(policy.userId) === Number(owner?.userId));
      if (!reconciledPolicy) fail('FINALIZATION_OUTCOME_UNKNOWN', '上次保存结果待核对，请稍后重试', 503);
      const next = structuredClone(task);
      updateAgentPolicyImportTask(next, { stateVersion: next.stateVersion, action: 'mark_saved', now: nowIso() });
      const record = { ...prior, status: 'completed', formalPolicyId: reconciledPolicy.id, completedAt: nowIso(), updatedAt: nowIso() };
      await complete({ state, task: next, record, policy: reconciledPolicy });
      Object.assign(task, next);
      return publicResult(record, next);
    }
    assertReady({ state, task, family, owner, stateVersion });
    const reservedTask = structuredClone(task);
    const record = await reserve({ state, task: reservedTask, ownerUserId: owner.userId, requestId: stableRequestId, expectedVersion: task.stateVersion });
    try {
      const policy = await createPolicy({ task: reservedTask, family, owner, requestId: stableRequestId });
      policy.sourcePolicyImportTaskId = reservedTask.id;
      policy.sourcePolicyImportRequestId = stableRequestId;
      const next = structuredClone(reservedTask);
      updateAgentPolicyImportTask(next, { stateVersion: next.stateVersion, action: 'mark_saved', now: nowIso() });
      const completed = { ...record, status: 'completed', formalPolicyId: policy.id, completedAt: nowIso(), updatedAt: nowIso() };
      await complete({ state, task: next, record: completed, policy });
      Object.assign(task, next);
      if (!(state.policies || []).some((row) => Number(row.id) === Number(policy.id))) state.policies.push(policy);
      return publicResult(completed, next);
    } catch (error) {
      await failRecord?.({ record, unknown: !error?.code });
      if (error?.code) throw error;
      fail('FINALIZATION_OUTCOME_UNKNOWN', '保存结果未知，系统将在重试时先核对', 503);
    }
  }
  return async function finalize(input = {}) {
    const key = `${Number(input.owner?.userId || 0)}\u0000${Number(input.task?.id || 0)}\u0000${text(input.requestId)}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = run(input).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };
}
