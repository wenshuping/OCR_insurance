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
  findPolicyBySource,
  loadTask,
  createPolicy,
  nowIso = () => new Date().toISOString(),
  claimLeaseMs = 60_000,
  waitIntervalMs = 25,
  waitTimeoutMs = 60_000,
  waitNowMs = Date.now,
} = {}) {
  const sleep = (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('保存等待已取消'), { code: 'FINALIZE_WAIT_ABORTED', status: 499 }));
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('保存等待已取消'), { code: 'FINALIZE_WAIT_ABORTED', status: 499 }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  async function reconcile({ task, owner, record, policy }) {
    const claimedTask = await loadTask?.(task.id);
    const next = structuredClone(claimedTask || task);
    updateAgentPolicyImportTask(next, { stateVersion: next.stateVersion, action: 'mark_saved', now: nowIso() });
    const completed = { ...record, status: 'completed', formalPolicyId: policy.id, completedAt: nowIso(), updatedAt: nowIso() };
    try {
      await complete({ state, task: next, record: completed, policy });
    } catch (error) {
      const original = await findRecord?.({ ownerUserId: owner.userId, taskId: task.id });
      if (original?.status === 'completed') return publicResult(original, task);
      throw error;
    }
    Object.assign(task, next);
    return publicResult(completed, next);
  }

  async function waitForDurableResult({ task, owner, requestId, signal }) {
    const deadline = Number(waitNowMs()) + Math.min(60_000, Math.max(1, Number(waitTimeoutMs) || 60_000));
    while (Number(waitNowMs()) < deadline) {
      const completed = await findRecord?.({ ownerUserId: owner.userId, taskId: task.id });
      if (completed?.status === 'completed') return publicResult(completed, task);
      const durableTask = await loadTask?.(task.id);
      const activeRequestId = text(durableTask?.finalizeRequestId || requestId);
      const active = activeRequestId ? await findRecord?.({ ownerUserId: owner.userId, taskId: task.id, requestId: activeRequestId }) : null;
      const policy = await findPolicyBySource?.({ ownerUserId: owner.userId, taskId: task.id, requestId: activeRequestId });
      if (policy && active) return reconcile({ task, owner, record: active, policy });
      if (active?.status === 'failed_unknown') fail('FINALIZATION_OUTCOME_UNKNOWN', '上次保存结果未知，需要人工核对', 503);
      if (durableTask?.status === 'final_confirmation') fail('FINALIZE_RETRY_REQUIRED', '上次保存未提交，请重新确认后重试', 409);
      await sleep(Math.max(1, Number(waitIntervalMs) || 25), signal);
    }
    fail('FINALIZE_WAIT_TIMEOUT', '等待保单保存结果超时，请稍后查询', 504);
  }

  async function run({ task, family, owner, requestId, stateVersion, signal } = {}) {
    const stableRequestId = text(requestId);
    if (!stableRequestId || stableRequestId.length > 120) fail('INVALID_REQUEST_ID', 'requestId 无效');
    const prior = await findRecord?.({ ownerUserId: owner?.userId, taskId: task?.id, requestId: stableRequestId });
    if (prior?.status === 'completed') return publicResult(prior, task);
    const completedForTask = await findRecord?.({ ownerUserId: owner?.userId, taskId: task?.id });
    if (completedForTask?.status === 'completed') return publicResult(completedForTask, task);
    if (prior?.status === 'reserved' || prior?.status === 'failed_unknown') {
      const policy = await findPolicyBySource?.({ ownerUserId: owner.userId, taskId: task.id, requestId: prior.requestId });
      if (policy) return reconcile({ task, owner, record: prior, policy });
      if (prior.status === 'failed_unknown') fail('FINALIZATION_OUTCOME_UNKNOWN', '上次保存结果未知，需要人工核对', 503);
      const now = nowIso();
      const leaseExpired = Number.isFinite(Date.parse(prior.leaseUntil)) && Date.parse(prior.leaseUntil) <= Date.parse(now);
      if (!leaseExpired) return waitForDurableResult({ task, owner, requestId: stableRequestId, signal });
      const expired = await reserve({ state, task, ownerUserId: owner.userId, requestId: stableRequestId, expectedVersion: task.stateVersion, now, leaseUntil: prior.leaseUntil });
      if (expired.outcome === 'completed') return publicResult(expired.record, task);
      fail('FINALIZATION_OUTCOME_UNKNOWN', '上次保存结果未知，需要人工核对', 503);
    }
    assertReady({ state, task, family, owner, stateVersion });
    const now = nowIso();
    const reservation = await reserve({ state, task, ownerUserId: owner.userId, requestId: stableRequestId, expectedVersion: task.stateVersion, now, leaseUntil: new Date(Date.parse(now) + claimLeaseMs).toISOString() });
    if (reservation.outcome === 'completed') return publicResult(reservation.record, task);
    if (reservation.outcome === 'unknown') fail('FINALIZATION_OUTCOME_UNKNOWN', '上次保存结果未知，需要人工核对', 503);
    if (reservation.outcome === 'in_progress') {
      return waitForDurableResult({ task, owner, requestId: stableRequestId, signal });
    }
    const record = reservation.record;
    const reservedTask = reservation.task;
    Object.assign(task, reservedTask);
    let policy;
    try {
      policy = await createPolicy({ task: reservedTask, family, owner, requestId: stableRequestId, reservedPolicyId: record.reservedPolicyId });
      policy.id = record.reservedPolicyId;
      policy.sourcePolicyImportTaskId = reservedTask.id;
      policy.sourcePolicyImportRequestId = stableRequestId;
    } catch (error) {
      const retryTask = await failRecord?.({ state, record, unknown: false, now: nowIso() });
      if (retryTask) Object.assign(task, retryTask);
      throw error;
    }
    try {
      const next = structuredClone(reservedTask);
      updateAgentPolicyImportTask(next, { stateVersion: next.stateVersion, action: 'mark_saved', now: nowIso() });
      const completed = { ...record, status: 'completed', formalPolicyId: policy.id, completedAt: nowIso(), updatedAt: nowIso() };
      await complete({ state, task: next, record: completed, policy });
      Object.assign(task, next);
      if (!(state.policies || []).some((row) => Number(row.id) === Number(policy.id))) state.policies.push(policy);
      return publicResult(completed, next);
    } catch {
      await failRecord?.({ state, record, unknown: true, now: nowIso() });
      fail('FINALIZATION_OUTCOME_UNKNOWN', '保存结果未知，系统将在重试时先核对', 503);
    }
  }
  return async function finalize(input = {}) {
    return run(input);
  };
}
