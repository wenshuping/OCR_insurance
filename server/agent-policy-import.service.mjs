import crypto from 'node:crypto';

const TASK_STATUSES = new Set(['uploading', 'recognizing', 'field_completion', 'candidate_selection', 'member_binding', 'final_confirmation', 'saving', 'completed', 'cancelled', 'failed']);
const PROCESSING_STATUSES = new Set(['uploading', 'recognizing', 'saving']);
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const DOCUMENT_STATUSES = new Set(['received', 'scanning', 'recognized', 'failed', 'removed']);
const TARGET_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const EDITABLE_FIELDS = new Set(['company', 'name', 'insured', 'applicant', 'date', 'paymentPeriod', 'coveragePeriod', 'amount', 'firstPremium', 'policyNumber', 'insuredIdNumber', 'mobile']);
const REQUIRED_FIELDS = ['company', 'name', 'insured'];
const ID_NUMBER_PATTERN = /(?<!\d)\d{17}[0-9Xx](?!\d)/gu;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const MAX_DOCUMENTS = 50;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_OPTIONS = 100;
const MAX_EVENTS = 200;
const MAX_PLANS = 100;
const MAX_TEXT = 160;
const MAX_EVIDENCE_CANDIDATES = 40;
const PRODUCT_RESOLUTIONS = new Set(['trusted_match', 'selected', 'manual_confirmed']);

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function scalarString(value, { field = 'value', max = MAX_TEXT, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (!allowEmpty) fail('INVALID_FIELD_VALUE', `${field} 不能为空`);
    return '';
  }
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    fail('INVALID_FIELD_VALUE', `${field} 必须是标量`);
  }
  const text = String(value).trim().slice(0, max);
  if (!allowEmpty && !text) fail('INVALID_FIELD_VALUE', `${field} 不能为空`);
  return text;
}

function boundedIdentifier(value, field, max = 80) {
  const text = scalarString(value, { field, max: max + 1, allowEmpty: false });
  if (text.length > max) fail('INVALID_FIELD_VALUE', `${field} 超过长度限制`);
  return text;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code, '标识符必须是正安全整数');
  return value;
}

function redact(value) {
  return scalarString(value).replace(ID_NUMBER_PATTERN, '[身份证号已脱敏]').replace(MOBILE_PATTERN, '[手机号已脱敏]');
}

function maskName(value) {
  const text = redact(value);
  if (!text) return '';
  return text.length === 1 ? '*' : `${text[0]}${'*'.repeat(Math.min(2, text.length - 1))}`;
}

function maskTail(value, visible = 4) {
  const text = scalarString(value);
  if (!text) return '';
  return `${'*'.repeat(Math.max(4, text.length - visible))}${text.slice(-visible)}`;
}

function normalizeTargetAgent(value) {
  const target = scalarString(value, { max: 40 }).toLowerCase();
  return TARGET_AGENTS.has(target) ? target : 'sales_champion';
}

function normalizeDraft(value = {}) {
  const source = isPlainObject(value?.data) ? value.data : value;
  if (!isPlainObject(source)) fail('INVALID_DRAFT', '保单草稿必须是对象');
  const draft = {};
  for (const field of EDITABLE_FIELDS) {
    if (source[field] !== undefined && source[field] !== null && source[field] !== '') {
      const normalized = scalarString(source[field], { field });
      if (normalized) draft[field] = normalized;
    }
  }
  if (source.productId !== undefined) draft.productId = normalizeOptionValue(source.productId, 'productId');
  for (const role of ['insured', 'applicant']) {
    const key = `${role}MemberId`;
    if (source[key] !== undefined) draft[key] = normalizeOptionValue(source[key], key);
  }
  if (source.plans !== undefined && !Array.isArray(source.plans)) fail('INVALID_PLANS', 'plans 必须是数组');
  if ((source.plans?.length || 0) > MAX_PLANS) fail('PLAN_LIMIT_EXCEEDED', 'plans 数量超过限制');
  draft.plans = Array.from({ length: source.plans?.length || 0 }, () => ({}));
  return draft;
}

function missingFields(draft) {
  return REQUIRED_FIELDS.filter((field) => !draft[field]);
}

function workflowStatus(task) {
  if (task.documents.some((document) => document.status === 'received' || document.status === 'scanning')) return 'recognizing';
  const missing = missingFields(task.draft);
  if (!task.resolutionRequired) {
    if (missing.includes('name') && task.productOptions.length) return 'candidate_selection';
    if (missing.includes('insured') && task.memberOptions.length) return 'member_binding';
    return missing.length ? 'field_completion' : 'final_confirmation';
  }
  if (task.fieldConflicts.length) return 'field_completion';
  if (missing.length) return 'field_completion';
  if (task.resolutionRequired && !PRODUCT_RESOLUTIONS.has(task.productResolution)) return 'candidate_selection';
  if (task.resolutionRequired && (!task.draft.insuredMemberId || (task.draft.applicant && !task.draft.applicantMemberId))) return 'member_binding';
  return 'final_confirmation';
}

function normalizeOptionValue(value, field) {
  if (typeof value === 'number') return positiveInteger(value, 'INVALID_OPTION');
  return boundedIdentifier(value, field);
}

function normalizeOptions(value, kind) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) fail('INVALID_OPTION', '选项列表无效');
  const seen = new Set();
  return value.map((option) => {
    if (!isPlainObject(option)) fail('INVALID_OPTION', '选项必须是普通对象');
    const allowed = new Set(['optionId', 'label', kind === 'product' ? 'productId' : 'memberId']);
    if (Reflect.ownKeys(option).some((key) => typeof key !== 'string' || !allowed.has(key))) fail('INVALID_OPTION', '选项包含未知字段');
    const optionId = boundedIdentifier(option.optionId, 'optionId');
    if (seen.has(optionId)) fail('INVALID_OPTION', '选项 ID 重复');
    seen.add(optionId);
    const idKey = kind === 'product' ? 'productId' : 'memberId';
    if (option[idKey] === undefined) fail('INVALID_OPTION', `${idKey} 缺失`);
    return { optionId, label: redact(scalarString(option.label, { field: 'label', max: 120, allowEmpty: false })), [idKey]: normalizeOptionValue(option[idKey], idKey) };
  });
}

function normalizeEvents(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('INVALID_EVENTS', '事件列表无效');
  return value.slice(-MAX_EVENTS).map((event) => {
    if (!isPlainObject(event)) fail('INVALID_EVENTS', '事件无效');
    const status = TASK_STATUSES.has(event.status) ? event.status : 'failed';
    const version = Number.isSafeInteger(event.stateVersion) && event.stateVersion > 0 ? event.stateVersion : 1;
    return {
      action: redact(scalarString(event.action, { max: 60 })) || 'unknown',
      status,
      stateVersion: version,
      createdAt: redact(scalarString(event.createdAt, { max: 40 })),
    };
  });
}

function normalizeStoredDocument(value) {
  if (!isPlainObject(value)) fail('INVALID_DOCUMENT', '附件记录无效');
  const sha256 = scalarString(value.sha256, { max: 65 }).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) fail('INVALID_DOCUMENT_HASH', '附件哈希无效');
  const documentId = scalarString(value.documentId, { max: 80, allowEmpty: false });
  const mediaType = scalarString(value.mediaType || value.type, { max: 40 }).toLowerCase();
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mediaType)) fail('UNSUPPORTED_DOCUMENT_TYPE', '附件类型不支持');
  if (!Number.isSafeInteger(value.size) || value.size < 0) fail('INVALID_DOCUMENT_SIZE', '附件大小无效');
  const candidates = Array.isArray(value.evidence?.candidates) ? value.evidence.candidates.slice(0, MAX_EVIDENCE_CANDIDATES).map((candidate) => {
    if (!isPlainObject(candidate) || !EDITABLE_FIELDS.has(candidate.field)) fail('INVALID_EVIDENCE', '识别证据无效');
    const confidence = candidate.confidence == null ? undefined : Number(candidate.confidence);
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) fail('INVALID_EVIDENCE', '识别置信度无效');
    const page = candidate.page == null ? undefined : Number(candidate.page);
    if (page !== undefined && (!Number.isSafeInteger(page) || page < 0 || page > 10000)) fail('INVALID_EVIDENCE', '识别页码无效');
    return { field: candidate.field, value: scalarString(candidate.value, { field: candidate.field, max: MAX_TEXT, allowEmpty: false }), documentId, sha256, ...(confidence === undefined ? {} : { confidence }), ...(page === undefined ? {} : { page }) };
  }) : [];
  const evidence = candidates.length ? { candidates } : undefined;
  const scanAttempt = Number.isSafeInteger(value.scanAttempt) && value.scanAttempt >= 0 ? value.scanAttempt : 0;
  const scanLeaseUntil = scalarString(value.scanLeaseUntil, { max: 40 });
  const queueLeaseUntil = scalarString(value.queueLeaseUntil, { max: 40 });
  const queuedAt = scalarString(value.queuedAt, { max: 40 });
  const queueAttempt = Number.isSafeInteger(value.queueAttempt) && value.queueAttempt >= 0 ? value.queueAttempt : 0;
  const errorCode = scalarString(value.errorCode, { max: 60 });
  return { documentId, sha256, name: redact(scalarString(value.name || '上传文件', { max: 120 })), mediaType, size: value.size, status: DOCUMENT_STATUSES.has(value.status) ? value.status : 'received', scanAttempt, queueAttempt, ...(scanLeaseUntil ? { scanLeaseUntil } : {}), ...(queueLeaseUntil ? { queueLeaseUntil } : {}), ...(queuedAt ? { queuedAt } : {}), ...(errorCode ? { errorCode } : {}), ...(evidence ? { evidence } : {}) };
}

function normalizeStoredDocuments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) fail('INVALID_DOCUMENT_LIST', '附件列表无效');
  const documents = value.map(normalizeStoredDocument);
  const ids = new Set();
  const activeHashes = new Set();
  for (const document of documents) {
    if (ids.has(document.documentId)) fail('DUPLICATE_DOCUMENT_ID', '附件 ID 重复');
    ids.add(document.documentId);
    if (document.status !== 'removed') {
      if (activeHashes.has(document.sha256)) fail('DUPLICATE_DOCUMENT_HASH', '有效附件哈希重复');
      activeHashes.add(document.sha256);
    }
  }
  return documents;
}

function normalizePrivacyManifest() {
  return { classification: 'customer_sensitive', wukongMemory: { originalDocuments: 'forbidden', ocrText: 'forbidden' }, externalSharing: 'redacted_only' };
}

function canonicalTask(input) {
  if (!isPlainObject(input)) fail('INVALID_TASK', '任务必须是对象');
  const id = positiveInteger(input.id, 'INVALID_TASK_ID');
  const familyId = positiveInteger(input.familyId, 'INVALID_FAMILY_ID');
  const ownerUserId = input.ownerUserId == null ? null : positiveInteger(input.ownerUserId, 'INVALID_OWNER_ID');
  const ownerGuestId = ownerUserId ? '' : scalarString(input.ownerGuestId, { field: 'ownerGuestId', max: 120, allowEmpty: false });
  const documents = normalizeStoredDocuments(input.documents);
  const task = {
    id,
    familyId,
    ownerUserId,
    ownerGuestId,
    channel: redact(scalarString(input.channel || 'web', { max: 40 })) || 'web',
    targetAgent: normalizeTargetAgent(input.targetAgent),
    status: TASK_STATUSES.has(input.status) ? input.status : '',
    stateVersion: input.stateVersion === undefined ? 1 : positiveInteger(input.stateVersion, 'INVALID_STATE_VERSION'),
    documents,
    draft: normalizeDraft(input.draft || input.scan || {}),
    productOptions: normalizeOptions(input.productOptions, 'product'),
    memberOptions: normalizeOptions(input.memberOptions, 'member'),
    fieldConflicts: Array.isArray(input.fieldConflicts) ? [...new Set(input.fieldConflicts.filter((field) => EDITABLE_FIELDS.has(field)))].slice(0, EDITABLE_FIELDS.size) : [],
    resolutionRequired: input.resolutionRequired === true,
    productResolution: PRODUCT_RESOLUTIONS.has(input.productResolution) ? input.productResolution : '',
    privacyManifest: normalizePrivacyManifest(),
    events: normalizeEvents(input.events),
    createdAt: redact(scalarString(input.createdAt, { max: 40 })),
    updatedAt: redact(scalarString(input.updatedAt, { max: 40 })),
  };
  if (input.formalPolicyId != null) task.formalPolicyId = positiveInteger(input.formalPolicyId, 'INVALID_POLICY_ID');
  if (input.completedAt) task.completedAt = redact(scalarString(input.completedAt, { max: 40 }));
  if (!task.status) task.status = documents.length ? 'recognizing' : workflowStatus(task);
  else if (!PROCESSING_STATUSES.has(task.status) && !CLOSED_STATUSES.has(task.status)) task.status = workflowStatus(task);
  return task;
}

function replaceOwnEnumerable(target, value) {
  for (const key of Reflect.ownKeys(target)) delete target[key];
  Object.defineProperties(target, Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, {
    value: entryValue,
    enumerable: true,
    writable: true,
    configurable: true,
  }])));
}

function assertSafeCommitTarget(target) {
  if (!isPlainObject(target) || !Object.isExtensible(target)) fail('UNSAFE_TASK_TARGET', '任务对象不支持安全原地更新', 409);
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor) || !descriptor.configurable || !descriptor.writable) {
      fail('UNSAFE_TASK_TARGET', '任务对象不支持安全原地更新', 409);
    }
  }
}

function validateExpectedVersion(task, expectedVersion) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) fail('INVALID_STATE_VERSION', '状态版本必须是正安全整数');
  if (expectedVersion !== task.stateVersion) fail('STALE_INTERACTION', '任务状态已更新，请刷新后重试', 409);
}

export function assertAgentPolicyImportExpectedVersion(input, expectedVersion) {
  // Task 2 persistence must use this expected version in a compare-and-swap write;
  // this pure guard intentionally does not claim persistence atomicity.
  const task = canonicalTask(input);
  validateExpectedVersion(task, expectedVersion);
  return true;
}

function assertOpen(task) {
  if (CLOSED_STATUSES.has(task.status)) fail('AGENT_POLICY_IMPORT_CLOSED', '录入任务已经结束', 409);
}

function assertActionPhase(task, action) {
  const allowed = {
    set_field: new Set(['field_completion', 'final_confirmation']),
    select_product: new Set(['candidate_selection']),
    confirm_product_manual: new Set(['candidate_selection']),
    bind_member: new Set(['member_binding']),
    confirm: new Set(['final_confirmation']),
    mark_saved: new Set(['saving']),
  }[action];
  if (allowed && !allowed.has(task.status)) fail('ACTION_NOT_ALLOWED_IN_PHASE', '当前任务阶段不允许该操作', 409);
}

function recordMutation(task, action, now) {
  if (task.stateVersion >= Number.MAX_SAFE_INTEGER) fail('INVALID_STATE_VERSION', '状态版本已达到上限');
  task.stateVersion += 1;
  task.updatedAt = redact(scalarString(now, { max: 40 }));
  task.events = [...task.events, { action, status: task.status, stateVersion: task.stateVersion, createdAt: task.updatedAt }].slice(-MAX_EVENTS);
}

function validatedLimit(value, fallback, ceiling) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > ceiling) fail('INVALID_DOCUMENT_LIMIT', '附件限制配置无效');
  return candidate;
}

function normalizeIncomingDocument(value, generateDocumentId) {
  if (!isPlainObject(value)) fail('INVALID_DOCUMENT', '附件记录无效');
  const allowed = new Set(['sha256', 'name', 'type', 'mediaType', 'size']);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key)) || ('type' in value && 'mediaType' in value)) fail('UNTRUSTED_DOCUMENT_METADATA', '附件包含未经信任的元数据');
  const sha256 = scalarString(value.sha256, { max: 65 }).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) fail('INVALID_DOCUMENT_HASH', '附件哈希无效');
  const mediaType = scalarString(value.mediaType || value.type, { max: 40 }).toLowerCase();
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mediaType)) fail('UNSUPPORTED_DOCUMENT_TYPE', '附件类型不支持');
  if (!Number.isSafeInteger(value.size) || value.size < 0) fail('INVALID_DOCUMENT_SIZE', '附件大小无效');
  const documentId = boundedIdentifier(generateDocumentId(), 'documentId');
  // sha256 is assumed to have been computed from bytes by the trusted intake service.
  return { documentId, sha256, name: redact(scalarString(value.name || '上传文件', { max: 120 })), mediaType, size: value.size, status: 'received' };
}

export function normalizeAgentPolicyImportTask(task = {}) {
  return canonicalTask(task);
}

export function createAgentPolicyImportTask({ id, familyId, owner = {}, channel = 'web', targetAgent = 'sales_champion', draft, scan, productOptions = [], memberOptions = [], resolutionRequired = false, now = new Date().toISOString() } = {}) {
  if (!isPlainObject(owner)) fail('INVALID_OWNER_ID', '所有者无效');
  const ownerUserId = owner.userId == null ? null : positiveInteger(owner.userId, 'INVALID_OWNER_ID');
  const task = canonicalTask({ id, familyId, ownerUserId, ownerGuestId: ownerUserId ? '' : owner.guestId, channel, targetAgent, status: 'uploading', stateVersion: 1, documents: [], draft: draft || scan || {}, productOptions, memberOptions, resolutionRequired, events: [], createdAt: now, updatedAt: now });
  if (draft || scan) task.status = workflowStatus(task);
  task.events.push({ action: 'created', status: task.status, stateVersion: 1, createdAt: task.createdAt });
  return task;
}

export function appendAgentPolicyImportDocuments(input, { stateVersion, documents, maxDocuments, maxDocumentBytes, maxTotalBytes, generateDocumentId = () => `doc_${crypto.randomUUID().replaceAll('-', '')}`, now = new Date().toISOString() } = {}) {
  const task = canonicalTask(input);
  validateExpectedVersion(task, stateVersion);
  assertOpen(task);
  const countLimit = validatedLimit(maxDocuments, 20, MAX_DOCUMENTS);
  const fileLimit = validatedLimit(maxDocumentBytes, 20 * 1024 * 1024, MAX_DOCUMENT_BYTES);
  const totalLimit = validatedLimit(maxTotalBytes, 60 * 1024 * 1024, MAX_TOTAL_BYTES);
  if (!Array.isArray(documents)) fail('INVALID_DOCUMENT_LIST', '附件列表无效');
  if (documents.length > countLimit || documents.length > MAX_DOCUMENTS) fail('DOCUMENT_LIMIT_EXCEEDED', '附件数量超过限制');
  const incoming = documents.map((document) => normalizeIncomingDocument(document, generateDocumentId));
  if (incoming.some((document) => document.size > fileLimit)) fail('DOCUMENT_SIZE_EXCEEDED', '单个附件超过大小限制');
  const byHash = new Map(task.documents.map((document) => [document.sha256, document]));
  const documentIds = new Set(task.documents.map((document) => document.documentId));
  const added = [];
  const existing = [];
  for (const document of incoming) {
    if (byHash.has(document.sha256)) existing.push(byHash.get(document.sha256));
    else {
      if (documentIds.has(document.documentId)) fail('DUPLICATE_DOCUMENT_ID', '附件 ID 重复');
      documentIds.add(document.documentId);
      added.push(document);
      byHash.set(document.sha256, document);
    }
  }
  const active = [...task.documents.filter((document) => document.status !== 'removed'), ...added];
  if (active.length > countLimit) fail('DOCUMENT_LIMIT_EXCEEDED', '附件数量超过限制');
  const types = active.map((document) => document.mediaType);
  if (types.includes('application/pdf') && types.length > 1) fail('MIXED_DOCUMENT_TYPES', 'PDF 不能与其他附件混合上传');
  if (active.reduce((sum, document) => sum + document.size, 0) > totalLimit) fail('DOCUMENT_TOTAL_SIZE_EXCEEDED', '附件总大小超过限制');
  if (added.length) {
    task.documents.push(...added);
    task.status = 'recognizing';
    recordMutation(task, 'documents_appended', now);
    assertSafeCommitTarget(input);
    replaceOwnEnumerable(input, task);
  }
  return { task: added.length ? input : task, added, existing };
}

export function updateAgentPolicyImportTask(input, { stateVersion, action = 'set_field', field, value, optionId, role = 'insured', now = new Date().toISOString() } = {}) {
  const task = canonicalTask(input);
  validateExpectedVersion(task, stateVersion);
  assertOpen(task);
  if (action === 'confirm' && task.documents.some((document) => document.status === 'received' || document.status === 'scanning')) fail('POLICY_IMPORT_DOCUMENTS_PENDING', '仍有附件正在识别，请稍后重试', 409);
  assertActionPhase(task, action);
  if (action === 'cancel') task.status = 'cancelled';
  else if (action === 'confirm') {
    if (missingFields(task.draft).length) fail('AGENT_POLICY_IMPORT_INCOMPLETE', '仍有必填字段需要补充', 409);
    task.status = 'saving';
  } else if (action === 'mark_saved') task.status = 'completed';
  else if (action === 'set_field') {
    if (!EDITABLE_FIELDS.has(field)) fail('AGENT_POLICY_IMPORT_FIELD_NOT_ALLOWED', '不支持修改该字段');
    const normalized = scalarString(value, { field, allowEmpty: false });
    task.draft[field] = normalized;
    task.fieldConflicts = task.fieldConflicts.filter((candidate) => candidate !== field);
    if (field === 'name' || field === 'company') {
      task.productResolution = '';
      delete task.draft.productId;
    }
    if (field === 'insured' || field === 'applicant') delete task.draft[`${field}MemberId`];
    task.status = workflowStatus(task);
  } else if (action === 'select_product') {
    const option = task.productOptions.find((candidate) => candidate.optionId === scalarString(optionId, { max: 80 }));
    if (!option) fail('INVALID_OPTION', '产品选项无效');
    task.draft.name = option.label;
    task.draft.productId = option.productId;
    task.productResolution = 'selected';
    task.status = workflowStatus(task);
  } else if (action === 'confirm_product_manual') {
    if (!task.draft.name || task.productOptions.length) fail('INVALID_OPTION', '存在候选产品时必须选择合法选项');
    delete task.draft.productId;
    task.productResolution = 'manual_confirmed';
    task.status = workflowStatus(task);
  } else if (action === 'bind_member') {
    if (!['insured', 'applicant'].includes(role)) fail('INVALID_MEMBER_ROLE', '家庭成员角色无效');
    const option = task.memberOptions.find((candidate) => candidate.optionId === scalarString(optionId, { max: 80 }));
    if (!option) fail('INVALID_OPTION', '家庭成员选项无效');
    task.draft[role] = option.label;
    task.draft[`${role}MemberId`] = option.memberId;
    task.status = workflowStatus(task);
  } else fail('UNSUPPORTED_ACTION', '不支持该操作');
  recordMutation(task, action, now);
  assertSafeCommitTarget(input);
  replaceOwnEnumerable(input, task);
  return input;
}

export const applyAgentPolicyImportAction = updateAgentPolicyImportTask;

export function reconcileAgentPolicyImportResolutions(input, { productOptions, productResolution, productId, memberBindings = {}, now = new Date().toISOString() } = {}) {
  const task = canonicalTask(input);
  assertOpen(task);
  if (productOptions !== undefined) task.productOptions = normalizeOptions(productOptions, 'product');
  task.productResolution = PRODUCT_RESOLUTIONS.has(productResolution) ? productResolution : '';
  if (productId !== undefined) task.draft.productId = normalizeOptionValue(productId, 'productId');
  else if (!task.productResolution) delete task.draft.productId;
  for (const role of ['insured', 'applicant']) {
    const binding = memberBindings[role];
    if (!binding) continue;
    const option = task.memberOptions.find((candidate) => candidate.memberId === binding.memberId);
    if (!option) fail('INVALID_OPTION', '家庭成员选项无效');
    task.draft[`${role}MemberId`] = option.memberId;
  }
  task.status = workflowStatus(task);
  recordMutation(task, 'resolutions_reconciled', now);
  assertSafeCommitTarget(input);
  replaceOwnEnumerable(input, task);
  return input;
}

export function agentPolicyImportMatchesOwner(input = {}, owner = {}) {
  let task;
  try { task = canonicalTask(input); } catch { return false; }
  if (Number.isSafeInteger(owner.userId) && owner.userId > 0) return task.ownerUserId === owner.userId;
  if (typeof owner.guestId !== 'string') return false;
  return !task.ownerUserId && task.ownerGuestId === owner.guestId.trim();
}

function nextInteraction(task) {
  if (CLOSED_STATUSES.has(task.status)) return null;
  if (PROCESSING_STATUSES.has(task.status)) return { type: 'progress', status: task.status, stateVersion: task.stateVersion };
  if (task.status === 'candidate_selection') return { type: task.productOptions.length ? 'select_product' : 'confirm_product_manual', stateVersion: task.stateVersion };
  if (task.status === 'member_binding') return { type: 'bind_member', stateVersion: task.stateVersion };
  const missing = missingFields(task.draft);
  if (missing.length) return { type: 'set_field', field: missing[0], stateVersion: task.stateVersion };
  return { type: 'confirm', stateVersion: task.stateVersion };
}

export function buildAgentPolicyImportContext(input = {}) {
  const task = canonicalTask(input);
  const statuses = {};
  for (const document of task.documents) statuses[document.status] = (statuses[document.status] || 0) + 1;
  const publicText = (value) => redact(scalarString(value));
  return {
    taskId: task.id,
    familyId: task.familyId,
    channel: publicText(task.channel),
    targetAgent: task.targetAgent,
    status: task.status,
    stateVersion: task.stateVersion,
    documentSummary: { count: task.documents.length, statuses },
    intakeLimits: { maxDocumentBytes: 16 * 1024 * 1024, transport: 'base64_data_url' },
    policyDraft: {
      company: publicText(task.draft.company), productName: publicText(task.draft.name), insured: maskName(task.draft.insured), applicant: maskName(task.draft.applicant),
      date: publicText(task.draft.date), paymentPeriod: publicText(task.draft.paymentPeriod), coveragePeriod: publicText(task.draft.coveragePeriod),
      amount: publicText(task.draft.amount), firstPremium: publicText(task.draft.firstPremium), policyNumber: maskTail(task.draft.policyNumber),
      insuredIdNumber: maskTail(task.draft.insuredIdNumber), mobile: maskTail(task.draft.mobile), planCount: task.draft.plans.length,
    },
    missingFields: missingFields(task.draft),
    resolution: {
      product: task.productResolution || 'pending',
      insuredMember: task.draft.insuredMemberId ? 'resolved' : 'pending',
      applicantMember: !task.draft.applicant ? 'not_required' : (task.draft.applicantMemberId ? 'resolved' : 'pending'),
    },
    legalOptions: {
      products: task.productOptions.map(({ optionId, label }) => ({ optionId: publicText(optionId), label: publicText(label) })),
      members: task.memberOptions.map(({ optionId, label }) => ({ optionId: publicText(optionId), label: maskName(label) })),
    },
    nextInteraction: nextInteraction(task),
    ...(task.status === 'completed' && Number(task.formalPolicyId) > 0
      ? { completedResult: { policyId: task.formalPolicyId, completedAt: publicText(task.completedAt) } }
      : {}),
    privacy: { classification: 'customer_sensitive', maskedForChannel: true, originalDocumentsIncluded: false, ocrTextIncluded: false, externalSharing: 'redacted_only' },
  };
}
