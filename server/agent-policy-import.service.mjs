import crypto from 'node:crypto';

const TASK_STATUSES = new Set([
  'uploading',
  'recognizing',
  'field_completion',
  'candidate_selection',
  'member_binding',
  'final_confirmation',
  'saving',
  'completed',
  'cancelled',
  'failed',
]);
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const DOCUMENT_STATUSES = new Set(['received', 'scanning', 'recognized', 'failed', 'removed']);
const TARGET_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const EDITABLE_FIELDS = new Set([
  'company', 'name', 'insured', 'applicant', 'date', 'paymentPeriod',
  'coveragePeriod', 'amount', 'firstPremium', 'policyNumber', 'insuredIdNumber', 'mobile',
]);
const REQUIRED_FIELDS = ['company', 'name', 'insured'];
const ID_NUMBER_PATTERN = /(?<!\d)\d{17}[0-9Xx](?!\d)/gu;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

function trim(value) {
  return String(value ?? '').trim();
}

function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

function maskName(value) {
  const text = trim(value);
  if (!text) return '';
  return text.length === 1 ? '*' : `${text[0]}${'*'.repeat(Math.min(2, text.length - 1))}`;
}

function maskTail(value, visible = 4) {
  const text = trim(value);
  if (!text) return '';
  return `${'*'.repeat(Math.max(4, text.length - visible))}${text.slice(-visible)}`;
}

function redactDirectIdentifiers(value) {
  return trim(value).replace(ID_NUMBER_PATTERN, '[身份证号已脱敏]').replace(MOBILE_PATTERN, '[手机号已脱敏]');
}

function normalizeTargetAgent(value) {
  const target = trim(value).toLowerCase();
  return TARGET_AGENTS.has(target) ? target : 'sales_champion';
}

function normalizeDraft(value = {}) {
  const source = value?.data && typeof value.data === 'object' ? value.data : value;
  const draft = {};
  for (const field of EDITABLE_FIELDS) {
    if (source?.[field] !== undefined && trim(source[field])) draft[field] = source[field];
  }
  draft.plans = Array.isArray(source?.plans) ? source.plans : [];
  return draft;
}

function missingFields(draft = {}) {
  return REQUIRED_FIELDS.filter((field) => !trim(draft[field]));
}

function workflowStatus(task) {
  const missing = missingFields(task.draft);
  if (missing.includes('name') && task.productOptions.length) return 'candidate_selection';
  if (missing.includes('insured') && task.memberOptions.length) return 'member_binding';
  return missing.length ? 'field_completion' : 'final_confirmation';
}

function normalizeOption(option = {}) {
  return {
    optionId: trim(option.optionId),
    label: redactDirectIdentifiers(option.label).slice(0, 120),
    ...(option.productId !== undefined ? { productId: option.productId } : {}),
    ...(option.memberId !== undefined ? { memberId: option.memberId } : {}),
  };
}

function privacyManifest() {
  return {
    classification: 'customer_sensitive',
    wukongMemory: { originalDocuments: 'forbidden', ocrText: 'forbidden' },
    externalSharing: 'redacted_only',
  };
}

function assertVersion(task, version) {
  if (Number(version) !== Number(task.stateVersion)) fail('STALE_INTERACTION', '任务状态已更新，请刷新后重试', 409);
}

function assertOpen(task) {
  if (CLOSED_STATUSES.has(task.status)) fail('AGENT_POLICY_IMPORT_CLOSED', '录入任务已经结束', 409);
}

function assertActionPhase(task, action) {
  const allowedStatuses = {
    set_field: new Set(['field_completion', 'final_confirmation']),
    select_product: new Set(['candidate_selection']),
    bind_member: new Set(['member_binding']),
    confirm: new Set(['final_confirmation']),
    mark_saved: new Set(['saving']),
  };
  const allowed = allowedStatuses[action];
  if (allowed && !allowed.has(task.status)) fail('ACTION_NOT_ALLOWED_IN_PHASE', '当前任务阶段不允许该操作', 409);
}

function recordMutation(task, action, now) {
  task.stateVersion += 1;
  task.updatedAt = now;
  task.events.push({ action, status: task.status, stateVersion: task.stateVersion, createdAt: now });
}

function normalizeDocument(document = {}) {
  const sha256 = trim(document.sha256).toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) fail('INVALID_DOCUMENT_HASH', '附件哈希无效');
  const mediaType = trim(document.mediaType || document.type).toLowerCase();
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(mediaType)) fail('UNSUPPORTED_DOCUMENT_TYPE', '附件类型不支持');
  const size = Number(document.size);
  if (!Number.isSafeInteger(size) || size < 0) fail('INVALID_DOCUMENT_SIZE', '附件大小无效');
  const status = DOCUMENT_STATUSES.has(document.status) ? document.status : 'received';
  return {
    documentId: trim(document.documentId) || `doc_${crypto.createHash('sha256').update(sha256).digest('hex').slice(0, 16)}`,
    sha256,
    name: redactDirectIdentifiers(document.name || '上传文件').slice(0, 120),
    mediaType,
    size,
    status,
  };
}

export function normalizeAgentPolicyImportTask(task = {}) {
  task.documents = Array.isArray(task.documents) ? task.documents.map(normalizeDocument) : [];
  task.draft = normalizeDraft(task.draft || task.scan || {});
  task.productOptions = Array.isArray(task.productOptions) ? task.productOptions.map(normalizeOption).filter((item) => item.optionId) : [];
  task.memberOptions = Array.isArray(task.memberOptions) ? task.memberOptions.map(normalizeOption).filter((item) => item.optionId) : [];
  task.stateVersion = Math.max(1, Number(task.stateVersion) || 1);
  task.events = Array.isArray(task.events) ? task.events : [];
  task.privacyManifest = privacyManifest();
  task.channel = trim(task.channel) || 'web';
  task.targetAgent = normalizeTargetAgent(task.targetAgent);
  if (!TASK_STATUSES.has(task.status)) task.status = task.documents.length ? 'recognizing' : workflowStatus(task);
  return task;
}

export function createAgentPolicyImportTask({
  id,
  familyId,
  owner = {},
  channel = 'web',
  targetAgent = 'sales_champion',
  draft,
  scan,
  productOptions = [],
  memberOptions = [],
  now = new Date().toISOString(),
} = {}) {
  const task = normalizeAgentPolicyImportTask({
    id: Number(id),
    familyId: Number(familyId),
    ownerUserId: Number(owner.userId || 0) || null,
    ownerGuestId: Number(owner.userId || 0) ? '' : trim(owner.guestId),
    channel,
    targetAgent,
    status: 'uploading',
    stateVersion: 1,
    documents: [],
    draft: draft || scan || {},
    productOptions,
    memberOptions,
    events: [],
    createdAt: now,
    updatedAt: now,
  });
  if (draft || scan) task.status = workflowStatus(task);
  task.events.push({ action: 'created', status: task.status, stateVersion: 1, createdAt: now });
  return task;
}

export function appendAgentPolicyImportDocuments(task, {
  stateVersion,
  documents = [],
  maxDocuments = 20,
  maxDocumentBytes = 20 * 1024 * 1024,
  maxTotalBytes = 60 * 1024 * 1024,
  now = new Date().toISOString(),
} = {}) {
  normalizeAgentPolicyImportTask(task);
  assertVersion(task, stateVersion);
  assertOpen(task);
  const incoming = documents.map(normalizeDocument);
  if (incoming.some((item) => item.size > maxDocumentBytes)) fail('DOCUMENT_SIZE_EXCEEDED', '单个附件超过大小限制');
  const existingByHash = new Map(task.documents.map((item) => [item.sha256, item]));
  const added = [];
  const existing = [];
  for (const document of incoming) {
    const duplicate = existingByHash.get(document.sha256);
    if (duplicate) existing.push(duplicate);
    else {
      added.push(document);
      existingByHash.set(document.sha256, document);
    }
  }
  const activeDocuments = [...task.documents.filter((item) => item.status !== 'removed'), ...added];
  const allTypes = activeDocuments.map((item) => item.mediaType);
  if (allTypes.includes('application/pdf') && allTypes.length > 1) fail('MIXED_DOCUMENT_TYPES', 'PDF 不能与其他附件混合上传');
  if (task.documents.filter((item) => item.status !== 'removed').length + added.length > maxDocuments) fail('DOCUMENT_LIMIT_EXCEEDED', '附件数量超过限制');
  const totalBytes = task.documents.filter((item) => item.status !== 'removed').reduce((sum, item) => sum + item.size, 0) + added.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > maxTotalBytes) fail('DOCUMENT_TOTAL_SIZE_EXCEEDED', '附件总大小超过限制');
  if (added.length) {
    task.documents.push(...added);
    task.status = 'recognizing';
    recordMutation(task, 'documents_appended', now);
  }
  return { task, added, existing };
}

export function updateAgentPolicyImportTask(task, {
  stateVersion,
  action = 'set_field',
  field,
  value,
  optionId,
  role = 'insured',
  now = new Date().toISOString(),
} = {}) {
  normalizeAgentPolicyImportTask(task);
  assertVersion(task, stateVersion);
  assertOpen(task);
  assertActionPhase(task, action);
  if (action === 'cancel') {
    task.status = 'cancelled';
  } else if (action === 'confirm') {
    if (missingFields(task.draft).length) fail('AGENT_POLICY_IMPORT_INCOMPLETE', '仍有必填字段需要补充', 409);
    task.status = 'saving';
  } else if (action === 'mark_saved') {
    task.status = 'completed';
  } else if (action === 'set_field') {
    if (!EDITABLE_FIELDS.has(field)) fail('AGENT_POLICY_IMPORT_FIELD_NOT_ALLOWED', '不支持修改该字段');
    const cleanValue = trim(value).slice(0, 160);
    if (!cleanValue) fail('AGENT_POLICY_IMPORT_EMPTY_VALUE', '字段内容不能为空');
    task.draft[field] = cleanValue;
    task.status = workflowStatus(task);
  } else if (action === 'select_product') {
    const option = task.productOptions.find((item) => item.optionId === trim(optionId));
    if (!option) fail('INVALID_OPTION', '产品选项无效');
    task.draft.name = option.label;
    task.draft.productId = option.productId;
    task.status = workflowStatus(task);
  } else if (action === 'bind_member') {
    if (!['insured', 'applicant'].includes(role)) fail('INVALID_MEMBER_ROLE', '家庭成员角色无效');
    const option = task.memberOptions.find((item) => item.optionId === trim(optionId));
    if (!option) fail('INVALID_OPTION', '家庭成员选项无效');
    task.draft[role] = option.label;
    task.draft[`${role}MemberId`] = option.memberId;
    task.status = workflowStatus(task);
  } else {
    fail('UNSUPPORTED_ACTION', '不支持该操作');
  }
  recordMutation(task, action, now);
  return task;
}

export const applyAgentPolicyImportAction = updateAgentPolicyImportTask;

export function agentPolicyImportMatchesOwner(task = {}, owner = {}) {
  if (owner.userId) return Number(task.ownerUserId || 0) === Number(owner.userId);
  return !Number(task.ownerUserId || 0) && Boolean(trim(owner.guestId)) && trim(task.ownerGuestId) === trim(owner.guestId);
}

function nextInteraction(task) {
  if (CLOSED_STATUSES.has(task.status)) return null;
  if (['uploading', 'recognizing', 'saving'].includes(task.status)) {
    return { type: 'progress', status: task.status, stateVersion: task.stateVersion };
  }
  if (task.status === 'candidate_selection') return { type: 'select_product', stateVersion: task.stateVersion };
  if (task.status === 'member_binding') return { type: 'bind_member', stateVersion: task.stateVersion };
  const missing = missingFields(task.draft);
  if (missing.length) return { type: 'set_field', field: missing[0], stateVersion: task.stateVersion };
  return { type: 'confirm', stateVersion: task.stateVersion };
}

export function buildAgentPolicyImportContext(input = {}) {
  const task = normalizeAgentPolicyImportTask(input);
  const statusCounts = {};
  for (const document of task.documents) statusCounts[document.status] = (statusCounts[document.status] || 0) + 1;
  return {
    taskId: Number(task.id),
    familyId: Number(task.familyId),
    channel: task.channel,
    targetAgent: task.targetAgent,
    status: task.status,
    stateVersion: task.stateVersion,
    documentSummary: { count: task.documents.length, statuses: statusCounts },
    policyDraft: {
      company: trim(task.draft.company),
      productName: trim(task.draft.name),
      insured: maskName(task.draft.insured),
      applicant: maskName(task.draft.applicant),
      date: trim(task.draft.date),
      paymentPeriod: trim(task.draft.paymentPeriod),
      coveragePeriod: trim(task.draft.coveragePeriod),
      amount: task.draft.amount ?? '',
      firstPremium: task.draft.firstPremium ?? '',
      policyNumber: maskTail(task.draft.policyNumber),
      insuredIdNumber: maskTail(task.draft.insuredIdNumber),
      mobile: maskTail(task.draft.mobile),
      planCount: Array.isArray(task.draft.plans) ? task.draft.plans.length : 0,
    },
    missingFields: missingFields(task.draft),
    legalOptions: {
      products: task.productOptions.map(({ optionId, label }) => ({ optionId, label })),
      members: task.memberOptions.map(({ optionId, label }) => ({ optionId, label: maskName(label) })),
    },
    nextInteraction: nextInteraction(task),
    privacy: {
      classification: 'customer_sensitive',
      maskedForChannel: true,
      originalDocumentsIncluded: false,
      ocrTextIncluded: false,
      externalSharing: 'redacted_only',
    },
  };
}
