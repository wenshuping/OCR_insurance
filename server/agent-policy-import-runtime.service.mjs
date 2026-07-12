import crypto from 'node:crypto';
import {
  agentPolicyImportMatchesOwner,
  appendAgentPolicyImportDocuments,
  buildAgentPolicyImportContext,
  createAgentPolicyImportTask,
  normalizeAgentPolicyImportTask,
  updateAgentPolicyImportTask,
} from './agent-policy-import.service.mjs';

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function clone(value) {
  return structuredClone(value);
}

function bytesForUpload(uploadItem) {
  if (typeof uploadItem !== 'string' || !uploadItem) fail('INVALID_DOCUMENT', '附件内容无效');
  const comma = uploadItem.indexOf(',');
  if (uploadItem.startsWith('data:') && comma > 0) {
    const header = uploadItem.slice(0, comma);
    return header.endsWith(';base64') ? Buffer.from(uploadItem.slice(comma + 1), 'base64') : Buffer.from(decodeURIComponent(uploadItem.slice(comma + 1)));
  }
  return Buffer.from(uploadItem);
}

function mediaTypeFor(uploadItem, supplied) {
  const detected = /^data:([^;,]+)/u.exec(String(uploadItem || ''))?.[1]?.toLowerCase();
  const type = detected || String(supplied || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(type)) fail('UNSUPPORTED_DOCUMENT_TYPE', '附件类型不支持');
  return type;
}

function taskMembers(state, familyId) {
  return (state.familyMembers || [])
    .filter((member) => Number(member.familyId) === Number(familyId) && String(member.status || 'active') === 'active')
    .map((member) => ({ optionId: `member_${member.id}`, memberId: member.id, label: String(member.name || '家庭成员') }));
}

function taskProducts(state) {
  const seen = new Set();
  return (state.knowledgeRecords || []).flatMap((record) => {
    const productId = record.canonicalProductId || record.productId || record.id;
    const label = String(record.productName || record.name || '').trim();
    const key = String(productId || '');
    if (!key || !label || seen.has(key)) return [];
    seen.add(key);
    return [{ optionId: `product_${key}`, productId, label }];
  }).slice(0, 100);
}

function mergeScanDraft(task, scan) {
  const data = scan?.data && typeof scan.data === 'object' ? scan.data : scan;
  for (const field of ['company', 'name', 'insured', 'applicant', 'date', 'paymentPeriod', 'coveragePeriod', 'amount', 'firstPremium', 'policyNumber', 'insuredIdNumber', 'mobile']) {
    if (!task.draft[field] && data?.[field] != null && ['string', 'number', 'boolean'].includes(typeof data[field])) task.draft[field] = String(data[field]).trim();
  }
}

export function createAgentPolicyImportRuntime({ state, allocateId, persistTask, recognizePolicyInput, nowIso = () => new Date().toISOString() } = {}) {
  state.agentPolicyImportTasks = Array.isArray(state.agentPolicyImportTasks) ? state.agentPolicyImportTasks : [];

  function ownedTask(taskId, familyId, owner) {
    const task = state.agentPolicyImportTasks.find((candidate) => Number(candidate.id) === Number(taskId));
    if (!task || Number(task.familyId) !== Number(familyId) || !agentPolicyImportMatchesOwner(task, owner)) fail('POLICY_IMPORT_NOT_FOUND', '保单录入任务不存在', 404);
    return task;
  }

  async function commit(previous, next, expectedVersion) {
    await persistTask({ state, task: next, expectedVersion });
    if (!previous) state.agentPolicyImportTasks.push(next);
    else state.agentPolicyImportTasks.splice(state.agentPolicyImportTasks.indexOf(previous), 1, next);
    return buildAgentPolicyImportContext(next);
  }

  return {
    async start({ family, owner, channel = 'web' }) {
      const task = createAgentPolicyImportTask({
        id: allocateId(state), familyId: family.id, owner, channel,
        productOptions: taskProducts(state), memberOptions: taskMembers(state, family.id), now: nowIso(),
      });
      return commit(null, task, 0);
    },
    get({ familyId, taskId, owner }) {
      return buildAgentPolicyImportContext(ownedTask(taskId, familyId, owner));
    },
    async action({ familyId, taskId, owner, input }) {
      const current = ownedTask(taskId, familyId, owner);
      const next = clone(current);
      updateAgentPolicyImportTask(next, input);
      return commit(current, next, input.stateVersion);
    },
    async append({ familyId, taskId, owner, stateVersion, files }) {
      const current = ownedTask(taskId, familyId, owner);
      const next = clone(current);
      const inspected = (Array.isArray(files) ? files : []).map((file) => {
        const bytes = bytesForUpload(file?.uploadItem);
        return { bytes, uploadItem: file.uploadItem, name: file.name, mediaType: mediaTypeFor(file.uploadItem, file.mediaType || file.type) };
      });
      const appended = appendAgentPolicyImportDocuments(next, {
        stateVersion,
        documents: inspected.map(({ bytes, name, mediaType }) => ({ sha256: crypto.createHash('sha256').update(bytes).digest('hex'), name, mediaType, size: bytes.length })),
        now: nowIso(),
      });
      if (!appended.added.length) return buildAgentPolicyImportContext(current);
      await commit(current, next, stateVersion);
      let expectedVersion = next.stateVersion;
      for (const added of appended.added) {
        const document = next.documents.find((candidate) => candidate.documentId === added.documentId);
        const source = inspected.find(({ bytes }) => crypto.createHash('sha256').update(bytes).digest('hex') === added.sha256);
        document.status = 'scanning';
        next.status = 'recognizing';
        next.stateVersion += 1;
        next.updatedAt = nowIso();
        await commit(state.agentPolicyImportTasks.find((task) => task.id === next.id), clone(next), expectedVersion);
        expectedVersion = next.stateVersion;
        try {
          const scan = await recognizePolicyInput({ body: { uploadItem: source.uploadItem }, state });
          mergeScanDraft(next, scan);
          document.evidence = {
            fields: scan?.data && typeof scan.data === 'object' ? clone(scan.data) : {},
            fieldEvidence: scan?.fieldEvidence && typeof scan.fieldEvidence === 'object' ? clone(scan.fieldEvidence) : {},
          };
          document.status = 'recognized';
        } catch {
          document.status = 'failed';
        }
        next.status = next.documents.some((candidate) => candidate.status === 'scanning') ? 'recognizing' : (next.draft.company && next.draft.name && next.draft.insured ? 'final_confirmation' : 'field_completion');
        next.stateVersion += 1;
        next.updatedAt = nowIso();
        await commit(state.agentPolicyImportTasks.find((task) => task.id === next.id), clone(normalizeAgentPolicyImportTask(next)), expectedVersion);
        expectedVersion = next.stateVersion;
      }
      return buildAgentPolicyImportContext(next);
    },
  };
}
