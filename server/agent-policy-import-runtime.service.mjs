import crypto from 'node:crypto';
import {
  agentPolicyImportMatchesOwner,
  appendAgentPolicyImportDocuments,
  buildAgentPolicyImportContext,
  createAgentPolicyImportTask,
  normalizeAgentPolicyImportTask,
  reconcileAgentPolicyImportResolutions,
  updateAgentPolicyImportTask,
} from './agent-policy-import.service.mjs';

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function clone(value) {
  return structuredClone(value);
}

const DEFAULT_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_SCAN_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_QUEUE_LEASE_MS = 30 * 60 * 1000;
const LEGACY_RECEIVED_GRACE_MS = 15 * 60 * 1000;

function bytesForUpload(uploadItem, maxDocumentBytes) {
  if (typeof uploadItem !== 'string' || !uploadItem) fail('INVALID_DOCUMENT', '附件内容无效');
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(uploadItem);
  if (!match || match[2].length % 4 !== 0) fail('INVALID_DOCUMENT_DATA_URL', '附件必须是合法的 base64 data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2]) fail('INVALID_DOCUMENT_BASE64', '附件 base64 编码无效');
  if (bytes.length > maxDocumentBytes) fail('DOCUMENT_SIZE_EXCEEDED', '单个附件超过 16MiB 限制', 413);
  return { bytes, declaredType: match[1].toLowerCase() };
}

function sniffMediaType(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  fail('UNSUPPORTED_DOCUMENT_SIGNATURE', '附件签名不受支持');
}

function mediaTypeFor(bytes, declaredType, supplied) {
  const detected = sniffMediaType(bytes);
  for (const claimed of [declaredType, supplied && String(supplied).toLowerCase()].filter(Boolean)) {
    if (claimed !== detected) fail('DOCUMENT_TYPE_MISMATCH', '附件类型与内容不一致');
  }
  return detected;
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

function normalizedName(value) {
  return String(value || '').normalize('NFKC').replace(/[\s·•・（）()\-—_]/gu, '').toLowerCase();
}

function exactProductOptions(state, draft) {
  const name = normalizedName(draft.name);
  const company = normalizedName(draft.company);
  if (!name) return [];
  return taskProducts(state).filter((option) => {
    const record = (state.knowledgeRecords || []).find((candidate) => String(candidate.canonicalProductId || candidate.productId || candidate.id) === String(option.productId));
    return normalizedName(option.label) === name && (!company || !record?.company || normalizedName(record.company) === company);
  });
}

function exactMemberBindings(task) {
  const bindings = {};
  for (const role of ['insured', 'applicant']) {
    if (!task.draft[role]) continue;
    const matches = task.memberOptions.filter((option) => normalizedName(option.label) === normalizedName(task.draft[role]));
    if (matches.length === 1) bindings[role] = { memberId: matches[0].memberId };
  }
  return bindings;
}

function candidatesForScan(document, scan) {
  const data = scan?.data && typeof scan.data === 'object' ? scan.data : scan;
  return ['company', 'name', 'insured', 'applicant', 'date', 'paymentPeriod', 'coveragePeriod', 'amount', 'firstPremium', 'policyNumber', 'insuredIdNumber', 'mobile'].flatMap((field) => {
    if (data?.[field] == null || !['string', 'number', 'boolean'].includes(typeof data[field]) || !String(data[field]).trim()) return [];
    const confidence = Number(scan?.fieldConfidence?.[field]);
    return [{ field, value: String(data[field]).trim(), documentId: document.documentId, sha256: document.sha256, ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}) }];
  });
}

function mergeDocumentCandidates(task) {
  const candidates = task.documents.flatMap((document) => document.evidence?.candidates || []).sort((a, b) => (Number(b.confidence ?? 0) - Number(a.confidence ?? 0)) || a.sha256.localeCompare(b.sha256) || a.documentId.localeCompare(b.documentId));
  task.fieldConflicts = [];
  for (const field of new Set(candidates.map((candidate) => candidate.field))) {
    const values = candidates.filter((candidate) => candidate.field === field);
    const distinct = [...new Set(values.map((candidate) => candidate.value))];
    if (distinct.length > 1 && Number(values[0].confidence ?? 0) === Number(values[1].confidence ?? 0)) {
      task.fieldConflicts.push(field);
      delete task.draft[field];
    } else task.draft[field] = values[0].value;
  }
}

export function createAgentPolicyImportRuntime({ state, allocateId, persistTask, loadTask, recognizePolicyInput, resolveProductCandidates, nowIso = () => new Date().toISOString(), maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES, scanLeaseMs = DEFAULT_SCAN_LEASE_MS, queueLeaseMs = DEFAULT_QUEUE_LEASE_MS } = {}) {
  state.agentPolicyImportTasks = Array.isArray(state.agentPolicyImportTasks) ? state.agentPolicyImportTasks : [];

  function ownedTask(taskId, familyId, owner) {
    const task = state.agentPolicyImportTasks.find((candidate) => Number(candidate.id) === Number(taskId));
    if (!task || Number(task.familyId) !== Number(familyId) || !agentPolicyImportMatchesOwner(task, owner)) fail('POLICY_IMPORT_NOT_FOUND', '保单录入任务不存在', 404);
    return task;
  }

  async function freshOwnedTask(taskId, familyId, owner) {
    const local = ownedTask(taskId, familyId, owner);
    if (typeof loadTask !== 'function') return local;
    const durable = await loadTask(local.id);
    if (durable && Number(durable.stateVersion) > Number(local.stateVersion)) {
      const normalized = normalizeAgentPolicyImportTask(durable);
      state.agentPolicyImportTasks.splice(state.agentPolicyImportTasks.indexOf(local), 1, normalized);
      return ownedTask(taskId, familyId, owner);
    }
    return local;
  }

  async function commit(previous, next, expectedVersion) {
    await persistTask({ state, task: next, expectedVersion });
    if (!previous) state.agentPolicyImportTasks.push(next);
    else state.agentPolicyImportTasks.splice(state.agentPolicyImportTasks.indexOf(previous), 1, next);
    return buildAgentPolicyImportContext(next);
  }

  async function recoverPending(task) {
    const now = Date.parse(nowIso());
    const taskAge = now - Date.parse(task.updatedAt);
    const stranded = task.documents.filter((document) => (
      document.status === 'received'
        ? (Number.isFinite(Date.parse(document.queueLeaseUntil)) ? Date.parse(document.queueLeaseUntil) <= now : taskAge >= LEGACY_RECEIVED_GRACE_MS)
        : document.status === 'scanning' && (!Number.isFinite(Date.parse(document.scanLeaseUntil)) || Date.parse(document.scanLeaseUntil) <= now)
    ));
    if (!stranded.length) return task;
    const next = clone(task);
    for (const document of next.documents) {
      if (!stranded.some((candidate) => candidate.documentId === document.documentId)) continue;
      const wasReceived = document.status === 'received';
      document.status = 'failed';
      document.errorCode = wasReceived ? 'QUEUED_UPLOAD_REQUIRED' : 'SCAN_LEASE_EXPIRED';
      delete document.scanLeaseUntil;
      delete document.queueLeaseUntil;
    }
    next.status = 'field_completion';
    next.stateVersion += 1;
    next.updatedAt = nowIso();
    await commit(task, normalizeAgentPolicyImportTask(next), task.stateVersion);
    return state.agentPolicyImportTasks.find((candidate) => candidate.id === task.id);
  }

  return {
    async start({ family, owner, channel = 'web' }) {
      const task = createAgentPolicyImportTask({
        id: allocateId(state), familyId: family.id, owner, channel,
        productOptions: [], memberOptions: taskMembers(state, family.id), resolutionRequired: true, now: nowIso(),
      });
      return commit(null, task, 0);
    },
    async get({ familyId, taskId, owner }) {
      return buildAgentPolicyImportContext(await recoverPending(await freshOwnedTask(taskId, familyId, owner)));
    },
    async action({ familyId, taskId, owner, input }) {
      const current = await recoverPending(await freshOwnedTask(taskId, familyId, owner));
      const next = clone(current);
      if (input.action === 'select_product') next.productOptions = exactProductOptions(state, next.draft);
      if (input.action === 'bind_member') next.memberOptions = taskMembers(state, next.familyId);
      updateAgentPolicyImportTask(next, input);
      return commit(current, next, input.stateVersion);
    },
    async append({ familyId, taskId, owner, stateVersion, files }) {
      const current = await recoverPending(await freshOwnedTask(taskId, familyId, owner));
      const next = clone(current);
      const inspected = (Array.isArray(files) ? files : []).map((file) => {
        const decoded = bytesForUpload(file?.uploadItem, maxDocumentBytes);
        return { bytes: decoded.bytes, uploadItem: file.uploadItem, name: file.name, mediaType: mediaTypeFor(decoded.bytes, decoded.declaredType, file.mediaType || file.type) };
      });
      const retryHashes = new Set(inspected.map(({ bytes }) => crypto.createHash('sha256').update(bytes).digest('hex')));
      next.documents = next.documents.filter((document) => !(['received', 'failed'].includes(document.status) && retryHashes.has(document.sha256)));
      const appended = appendAgentPolicyImportDocuments(next, {
        stateVersion,
        documents: inspected.map(({ bytes, name, mediaType }) => ({ sha256: crypto.createHash('sha256').update(bytes).digest('hex'), name, mediaType, size: bytes.length })),
        now: nowIso(),
      });
      if (!appended.added.length) return buildAgentPolicyImportContext(current);
      const queuedAt = nowIso();
      for (const document of next.documents) {
        if (document.status !== 'received') continue;
        document.queuedAt = queuedAt;
        document.queueAttempt = Number(document.queueAttempt || 0) + 1;
        document.queueLeaseUntil = new Date(Date.parse(queuedAt) + queueLeaseMs).toISOString();
      }
      await commit(current, next, stateVersion);
      let expectedVersion = next.stateVersion;
      for (const added of appended.added) {
        const document = next.documents.find((candidate) => candidate.documentId === added.documentId);
        const source = inspected.find(({ bytes }) => crypto.createHash('sha256').update(bytes).digest('hex') === added.sha256);
        document.status = 'scanning';
        delete document.queueLeaseUntil;
        document.scanAttempt = Number(document.scanAttempt || 0) + 1;
        document.scanLeaseUntil = new Date(Date.parse(nowIso()) + scanLeaseMs).toISOString();
        delete document.errorCode;
        const renewedQueueLease = new Date(Date.parse(nowIso()) + queueLeaseMs).toISOString();
        for (const queued of next.documents) if (queued.status === 'received') queued.queueLeaseUntil = renewedQueueLease;
        next.status = 'recognizing';
        next.stateVersion += 1;
        next.updatedAt = nowIso();
        await commit(state.agentPolicyImportTasks.find((task) => task.id === next.id), clone(next), expectedVersion);
        expectedVersion = next.stateVersion;
        try {
          const scan = await recognizePolicyInput({ body: { uploadItem: source.uploadItem }, state });
          document.evidence = { candidates: candidatesForScan(document, scan) };
          document.status = 'recognized';
          delete document.scanLeaseUntil;
          delete document.queueLeaseUntil;
          mergeDocumentCandidates(next);
          const resolvedOptions = typeof resolveProductCandidates === 'function'
            ? await resolveProductCandidates({ scan, draft: clone(next.draft), familyId: next.familyId })
            : exactProductOptions(state, next.draft);
          const productOptions = Array.isArray(resolvedOptions) ? resolvedOptions : [];
          reconcileAgentPolicyImportResolutions(next, {
            productOptions,
            productResolution: productOptions.length === 1 ? 'trusted_match' : '',
            productId: productOptions.length === 1 ? productOptions[0].productId : undefined,
            memberBindings: exactMemberBindings(next),
            now: nowIso(),
          });
        } catch (error) {
          document.status = 'failed';
          document.errorCode = String(error?.code || 'OCR_FAILED').slice(0, 60);
          delete document.scanLeaseUntil;
          delete document.queueLeaseUntil;
          mergeDocumentCandidates(next);
          const productOptions = exactProductOptions(state, next.draft);
          reconcileAgentPolicyImportResolutions(next, { productOptions, productResolution: next.productResolution || (productOptions.length === 1 ? 'trusted_match' : ''), productId: next.draft.productId || (productOptions.length === 1 ? productOptions[0].productId : undefined), memberBindings: exactMemberBindings(next), now: nowIso() });
        }
        try {
          await commit(state.agentPolicyImportTasks.find((task) => task.id === next.id), clone(normalizeAgentPolicyImportTask(next)), expectedVersion);
        } catch (error) {
          if (error?.code !== 'STALE_INTERACTION' || typeof loadTask !== 'function') throw error;
          const latest = normalizeAgentPolicyImportTask(await loadTask(next.id));
          const eligible = !['cancelled', 'completed', 'failed'].includes(latest.status) && latest.documents.find((candidate) => candidate.documentId === document.documentId && candidate.status === 'scanning' && candidate.scanAttempt === document.scanAttempt);
          if (!eligible) throw error;
          Object.assign(eligible, clone(document));
          mergeDocumentCandidates(latest);
          const latestExpectedVersion = latest.stateVersion;
          if (document.status === 'recognized') {
            const productOptions = exactProductOptions(state, latest.draft);
            reconcileAgentPolicyImportResolutions(latest, { productOptions, productResolution: productOptions.length === 1 ? 'trusted_match' : '', productId: productOptions.length === 1 ? productOptions[0].productId : undefined, memberBindings: exactMemberBindings(latest), now: nowIso() });
          } else {
            latest.status = 'field_completion';
            latest.stateVersion += 1;
            latest.updatedAt = nowIso();
          }
          await commit(state.agentPolicyImportTasks.find((task) => task.id === latest.id), latest, latestExpectedVersion);
          Object.assign(next, latest);
        }
        expectedVersion = next.stateVersion;
      }
      return buildAgentPolicyImportContext(next);
    },
  };
}
