const TASK_STATUSES = new Set(['field_completion', 'final_confirmation', 'completed', 'cancelled']);
const TARGET_AGENTS = new Set(['sales_champion', 'insurance_expert']);
const EDITABLE_FIELDS = new Set([
  'company',
  'name',
  'insured',
  'date',
  'paymentPeriod',
  'coveragePeriod',
  'amount',
  'firstPremium',
]);
const REQUIRED_FIELDS = ['company', 'name', 'insured'];
const CHINA_ID_NUMBER_PATTERN = /(?<!\d)\d{17}[0-9Xx](?!\d)/gu;
const MOBILE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;

function trim(value) {
  return String(value ?? '').trim();
}

function maskName(value = '') {
  const text = trim(value);
  if (!text) return '';
  if (text.length === 1) return '*';
  return `${text.slice(0, 1)}${'*'.repeat(Math.min(2, text.length - 1))}`;
}

function maskTail(value = '', visible = 4) {
  const text = trim(value);
  if (!text) return '';
  const tail = text.slice(-visible);
  return `${'*'.repeat(Math.max(4, text.length - tail.length))}${tail}`;
}

function sanitizeText(value = '') {
  return trim(value)
    .replace(CHINA_ID_NUMBER_PATTERN, '[身份证号已脱敏]')
    .replace(MOBILE_PATTERN, '[手机号已脱敏]');
}

function normalizeTargetAgent(value = '') {
  const target = trim(value).toLowerCase();
  return TARGET_AGENTS.has(target) ? target : 'sales_champion';
}

function normalizeDraft(scan = {}) {
  const data = scan?.data && typeof scan.data === 'object' && !Array.isArray(scan.data) ? scan.data : {};
  const draft = {};
  for (const field of EDITABLE_FIELDS) {
    const value = data[field];
    if (value !== undefined && value !== null && trim(value)) draft[field] = value;
  }
  if (trim(data.policyNumber)) draft.policyNumber = trim(data.policyNumber);
  if (trim(data.insuredIdNumber)) draft.insuredIdNumber = trim(data.insuredIdNumber);
  draft.plans = Array.isArray(data.plans) ? data.plans : [];
  return draft;
}

function missingFields(draft = {}) {
  return REQUIRED_FIELDS.filter((field) => !trim(draft[field]));
}

function nextStatus(draft = {}) {
  return missingFields(draft).length ? 'field_completion' : 'final_confirmation';
}

function nextInteraction(task = {}) {
  if (task.status === 'completed' || task.status === 'cancelled') return null;
  const missing = missingFields(task.draft);
  if (missing.length) {
    const field = missing[0];
    return {
      type: 'text_input',
      interactionId: `task_${task.id}_v${task.stateVersion}_${field}`,
      taskId: task.id,
      stateVersion: task.stateVersion,
      field,
      title: `请补充${field === 'company' ? '保险公司' : field === 'name' ? '产品名称' : '被保险人'}`,
    };
  }
  return {
    type: 'confirm',
    interactionId: `task_${task.id}_v${task.stateVersion}_confirm`,
    taskId: task.id,
    stateVersion: task.stateVersion,
    title: '请确认识别结果是否用于后续 Agent 分析',
    actions: ['confirm', 'edit', 'cancel'],
  };
}

export function createAgentPolicyImportTask({
  id,
  familyId,
  owner = {},
  channel = 'web',
  targetAgent = 'sales_champion',
  scan,
  uploadItems = [],
  now = new Date().toISOString(),
} = {}) {
  const draft = normalizeDraft(scan);
  const task = {
    id: Number(id),
    familyId: Number(familyId),
    ownerUserId: Number(owner.userId || 0) || null,
    ownerGuestId: Number(owner.userId || 0) ? '' : trim(owner.guestId),
    channel: trim(channel) || 'web',
    targetAgent: normalizeTargetAgent(targetAgent),
    status: nextStatus(draft),
    stateVersion: 1,
    draft,
    scan,
    privacyManifest: {
      containsSensitiveData: true,
      externalModelPolicy: 'redacted_only',
      originalImageAllowedInHermesMemory: false,
      ocrTextAllowedInHermesMemory: false,
      uploadCount: Array.isArray(uploadItems) ? uploadItems.length : 0,
      uploadMetadata: (Array.isArray(uploadItems) ? uploadItems : []).map((item) => ({
        name: sanitizeText(item?.name || '上传文件').slice(0, 120),
        type: trim(item?.type),
        size: Number(item?.size || 0) || 0,
      })),
    },
    events: [{ type: 'created', stateVersion: 1, actorType: 'advisor', createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };
  return task;
}

export function updateAgentPolicyImportTask(task, {
  stateVersion,
  action = 'set_field',
  field = '',
  value = '',
  now = new Date().toISOString(),
} = {}) {
  if (!task || !TASK_STATUSES.has(trim(task.status))) throw Object.assign(new Error('录入任务不存在'), { code: 'AGENT_POLICY_IMPORT_NOT_FOUND', status: 404 });
  if (Number(stateVersion) !== Number(task.stateVersion)) {
    throw Object.assign(new Error('任务状态已更新，请使用最新卡片'), { code: 'STALE_INTERACTION', status: 409 });
  }
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw Object.assign(new Error('录入任务已经结束'), { code: 'AGENT_POLICY_IMPORT_CLOSED', status: 409 });
  }
  if (action === 'cancel') {
    task.status = 'cancelled';
  } else if (action === 'confirm') {
    if (missingFields(task.draft).length) throw Object.assign(new Error('仍有必填字段需要补充'), { code: 'AGENT_POLICY_IMPORT_INCOMPLETE', status: 409 });
    task.status = 'completed';
  } else {
    if (!EDITABLE_FIELDS.has(field)) throw Object.assign(new Error('不支持修改该字段'), { code: 'AGENT_POLICY_IMPORT_FIELD_NOT_ALLOWED', status: 400 });
    const cleanValue = sanitizeText(value).slice(0, 160);
    if (!cleanValue) throw Object.assign(new Error('字段内容不能为空'), { code: 'AGENT_POLICY_IMPORT_EMPTY_VALUE', status: 400 });
    task.draft[field] = cleanValue;
    task.status = nextStatus(task.draft);
  }
  task.stateVersion += 1;
  task.updatedAt = now;
  task.events = Array.isArray(task.events) ? task.events : [];
  task.events.push({ type: action, field: EDITABLE_FIELDS.has(field) ? field : '', stateVersion: task.stateVersion, actorType: 'advisor', createdAt: now });
  return task;
}

export function agentPolicyImportMatchesOwner(task = {}, owner = {}) {
  if (owner.userId) return Number(task.ownerUserId || 0) === Number(owner.userId);
  return !Number(task.ownerUserId || 0) && trim(task.ownerGuestId) === trim(owner.guestId);
}

export function buildAgentPolicyImportContext(task = {}) {
  const draft = task.draft || {};
  return {
    taskId: Number(task.id),
    familyId: Number(task.familyId),
    targetAgent: normalizeTargetAgent(task.targetAgent),
    status: trim(task.status),
    stateVersion: Number(task.stateVersion || 0),
    policyDraft: {
      company: trim(draft.company),
      productName: trim(draft.name),
      insured: maskName(draft.insured),
      date: trim(draft.date),
      paymentPeriod: trim(draft.paymentPeriod),
      coveragePeriod: trim(draft.coveragePeriod),
      amount: draft.amount ?? '',
      firstPremium: draft.firstPremium ?? '',
      policyNumber: maskTail(draft.policyNumber),
      insuredIdNumber: maskTail(draft.insuredIdNumber),
      planCount: Array.isArray(draft.plans) ? draft.plans.length : 0,
    },
    missingFields: missingFields(draft),
    interaction: nextInteraction(task),
    privacy: {
      maskedForChannel: true,
      containsSensitiveData: true,
      originalImageIncluded: false,
      ocrTextIncluded: false,
      hermesMemoryAllowed: false,
    },
  };
}
