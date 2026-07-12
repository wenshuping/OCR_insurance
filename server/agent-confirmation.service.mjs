import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';

const TRANSFER_ACTION = 'transfer_policy_between_families';
const CONFIRMATION_TTL_MS = 5 * 60_000;

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function interaction(type, text, extra = {}) {
  return { interaction: { type, text, ...extra }, ...extra };
}

function safeFailure(code, text = '当前无法执行该操作，请重新选择后再试。') {
  return { ...interaction('clarification', text), code };
}

function ownedActiveFamilies(state, userId) {
  return (state.familyProfiles || []).filter((family) =>
    Number(family?.ownerUserId) === Number(userId) && String(family?.status || 'active') !== 'archived',
  );
}

function resolveFamily(families, hint) {
  const key = normalized(hint);
  const exact = families.filter((family) => normalized(family.familyName) === key);
  if (exact.length === 1) return { value: exact[0] };
  const fuzzy = families.filter((family) => normalized(family.familyName).includes(key) || key.includes(normalized(family.familyName)));
  return fuzzy.length === 1 ? { ambiguous: true } : { ambiguous: true };
}

function resolvePolicy(policies, hint) {
  const key = normalized(hint);
  const exact = policies.filter((policy) => [policy.policyNo, policy.policyNumber, policy.name, policy.productName]
    .some((value) => normalized(value) === key));
  if (exact.length === 1) return { value: exact[0] };
  if (exact.length > 1) return { ambiguous: true };
  const fuzzy = policies.filter((policy) => [policy.policyNo, policy.policyNumber, policy.name, policy.productName]
    .some((value) => normalized(value).includes(key) || key.includes(normalized(value))));
  return fuzzy.length === 1 ? { ambiguous: true } : { ambiguous: true };
}

function stateHash(state) {
  const snapshot = {
    stateVersion: Number(state.stateVersion || 0),
    families: (state.familyProfiles || []).map(({ id, ownerUserId, status, updatedAt }) => ({ id, ownerUserId, status, updatedAt })),
    members: (state.familyMembers || []).map(({ id, familyId, status, updatedAt }) => ({ id, familyId, status, updatedAt })),
    policies: (state.policies || []).map(({ id, familyId, policyNo, policyNumber, applicantMemberId, insuredMemberId, status, transferStatus, updatedAt }) => ({ id, familyId, policyNo, policyNumber, applicantMemberId, insuredMemberId, status, transferStatus, updatedAt })),
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function policyTail(policy) {
  const value = String(policy.policyNo || policy.policyNumber || '');
  return value.slice(-4).padStart(4, '*');
}

function policyDuplicateKey(policy) {
  const policyNo = normalized(policy?.policyNo || policy?.policyNumber).replace(/[-_]/gu, '');
  const company = normalized(policy?.company || policy?.insurer);
  const product = normalized(policy?.productName || policy?.name);
  return { policyNo, companyProduct: company && product ? `${company}|${product}` : '' };
}

function targetLinks(input, policy) {
  const shared = Number(input.targetMemberId || 0) || null;
  return {
    applicantMemberId: Number(input.targetApplicantMemberId || shared || policy.targetApplicantMemberId || 0) || null,
    insuredMemberId: Number(input.targetInsuredMemberId || shared || policy.targetInsuredMemberId || 0) || null,
  };
}

export async function dispatchPendingTransferRegenerationJobs({ store, reportQueue, confirmationId, now = () => new Date().toISOString(), limit = 100, workerId = nodeRandomUUID(), leaseMs = 60_000 } = {}) {
  if (!store || typeof store.claimPendingTransferRegenerationJobs !== 'function') return { dispatched: 0, failed: 0 };
  if (!reportQueue || typeof reportQueue.enqueueUnique !== 'function') return { dispatched: 0, failed: 0, reason: 'enqueue_unique_required' };
  const jobs = await store.claimPendingTransferRegenerationJobs({ confirmationId, limit, workerId, leaseMs, now: new Date(now()).toISOString() });
  const results = await Promise.allSettled(jobs.map(async (job) => {
    try {
      await reportQueue.enqueueUnique({ familyId: job.familyId, type: job.type, userId: job.userId, dedupeKey: job.dedupeKey });
      await store.markPolicyTransferRegenerationJobDispatched({ id: job.id, claimToken: job.claimToken, dispatchedAt: new Date(now()).toISOString() });
      return 'dispatched';
    } catch (error) {
      await store.markPolicyTransferRegenerationJobFailed({
        id: job.id,
        claimToken: job.claimToken,
        attemptedAt: new Date(now()).toISOString(),
        error: String(error?.message || 'dispatch failed').slice(0, 500),
      });
      throw error;
    }
  }));
  return {
    dispatched: results.filter((row) => row.status === 'fulfilled').length,
    failed: results.filter((row) => row.status === 'rejected').length,
  };
}

export function startTransferRegenerationRecovery({ store, reportQueue, intervalMs = 30_000, disabled = false, setIntervalFn = setInterval, clearIntervalFn = clearInterval, onError = () => {}, ...dispatchOptions } = {}) {
  const drain = () => dispatchPendingTransferRegenerationJobs({ store, reportQueue, ...dispatchOptions });
  if (disabled) return { initialDrain: Promise.resolve({ dispatched: 0, failed: 0 }), drain, stop() {} };
  const initialDrain = drain().catch((error) => { onError(error); return { dispatched: 0, failed: 1 }; });
  const timer = setIntervalFn(() => { void drain().catch(onError); }, Math.max(1_000, Number(intervalMs) || 30_000));
  timer?.unref?.();
  return { initialDrain, drain, stop() { clearIntervalFn(timer); } };
}

export function createAgentConfirmationService({ store, loadState, reportQueue, now = () => new Date().toISOString(), randomUUID = nodeRandomUUID } = {}) {
  if (!store || typeof store.createAgentActionConfirmation !== 'function' || typeof store.transferPolicyBetweenFamilies !== 'function') {
    throw new TypeError('Agent confirmation store is required');
  }
  if (typeof loadState !== 'function') throw new TypeError('Agent confirmation state loader is required');

  async function previewPolicyTransfer(input = {}) {
    const userId = Number(input.userId || input.internalUserId || 0);
    const current = await loadState();
    const families = ownedActiveFamilies(current, userId);
    const sourceResult = resolveFamily(families, input.sourceFamilyName);
    const targetResult = resolveFamily(families, input.targetFamilyName);
    if (!sourceResult.value || !targetResult.value) return safeFailure('family_ambiguous', '请从您有权限的家庭中精确选择来源和目标家庭。');
    const source = sourceResult.value;
    const target = targetResult.value;
    if (Number(source.id) === Number(target.id)) return safeFailure('same_family', '来源家庭和目标家庭不能相同。');

    const policyResult = resolvePolicy((current.policies || []).filter((row) => Number(row.familyId) === Number(source.id)), input.policyHint);
    if (!policyResult.value) return safeFailure('policy_ambiguous', '请提供唯一匹配的保单名称或保单号尾号。');
    const policy = policyResult.value;
    if (['pending', 'processing', 'running'].includes(String(policy.transferStatus || '').toLowerCase())) return safeFailure('policy_busy');
    const links = targetLinks(input, policy);
    const activeTargetMemberIds = new Set((current.familyMembers || [])
      .filter((member) => Number(member.familyId) === Number(target.id) && String(member.status || 'active') !== 'archived')
      .map((member) => Number(member.id)));
    if (!links.applicantMemberId || !links.insuredMemberId || !activeTargetMemberIds.has(links.applicantMemberId) || !activeTargetMemberIds.has(links.insuredMemberId)) {
      return safeFailure('requires_web_member_link', '请先在网页中将投保人和被保人关联到目标家庭成员。');
    }
    const identity = policyDuplicateKey(policy);
    if ((current.policies || []).some((row) => {
      if (Number(row.id) === Number(policy.id) || Number(row.familyId) !== Number(target.id)) return false;
      const candidate = policyDuplicateKey(row);
      return (identity.policyNo && candidate.policyNo === identity.policyNo)
        || (!identity.policyNo && !candidate.policyNo && identity.companyProduct && candidate.companyProduct === identity.companyProduct);
    })) {
      return safeFailure('duplicate_policy', '目标家庭已存在疑似重复保单，请先核对。');
    }

    const createdAt = new Date(now()).toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + CONFIRMATION_TTL_MS).toISOString();
    const confirmationId = randomUUID();
    await store.createAgentActionConfirmation({
      id: confirmationId,
      userId,
      action: TRANSFER_ACTION,
      actor: 'agent_confirmation',
      createdAt,
      expiresAt,
      payload: {
        sourceFamilyId: Number(source.id), targetFamilyId: Number(target.id), policyId: Number(policy.id),
        targetApplicantMemberId: links.applicantMemberId, targetInsuredMemberId: links.insuredMemberId,
        stateVersion: Number(current.stateVersion || 0), stateHash: stateHash(current),
      },
    });
    const text = `确认将保单（尾号 ${policyTail(policy)}）转移到目标家庭？相关报告将重新计算。`;
    return interaction('confirmation', text, { confirmationId, summary: `转移保单尾号 ${policyTail(policy)}` });
  }

  async function confirm(input = {}) {
    const userId = Number(input.userId || input.internalUserId || 0);
    const result = await store.transferPolicyBetweenFamilies({
      confirmationId: String(input.confirmationId || ''), userId, consumedAt: new Date(now()).toISOString(),
    });
    if (result?.status === 'not_found') {
      throw Object.assign(new Error('Confirmation unavailable'), { status: 404, code: 'AGENT_CONFIRMATION_NOT_OWNED' });
    }
    if (result?.status === 'transferred' || result?.status === 'already_consumed') {
      await dispatchPendingTransferRegenerationJobs({ store, reportQueue, confirmationId: String(input.confirmationId || ''), now });
    }
    if (result?.status !== 'transferred') return { ...safeFailure(result?.status || 'transfer_rejected'), status: result?.status || 'rejected' };
    return { ...interaction('answer', '保单已转移，两个家庭的报告正在重新计算。'), ...result };
  }

  return {
    previewPolicyTransfer,
    confirm,
    startRecovery: (options = {}) => startTransferRegenerationRecovery({ store, reportQueue, ...options }),
  };
}
