import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentPolicyImportMatchesOwner,
  appendAgentPolicyImportDocuments,
  assertAgentPolicyImportExpectedVersion,
  buildAgentPolicyImportContext,
  createAgentPolicyImportTask,
  normalizeAgentPolicyImportTask,
  updateAgentPolicyImportTask,
} from '../server/agent-policy-import.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';
const image = (sha256, name = 'policy.jpg', size = 100) => ({
  sha256,
  name,
  type: 'image/jpeg',
  size,
});

function create(overrides = {}) {
  return createAgentPolicyImportTask({
    id: 10,
    familyId: 8,
    owner: { userId: 7 },
    channel: 'dingtalk',
    targetAgent: 'insurance_expert',
    now: NOW,
    ...overrides,
  });
}

test('creates a channel-neutral private task with a privacy manifest', () => {
  const task = create();
  assert.equal(task.status, 'uploading');
  assert.equal(task.stateVersion, 1);
  assert.deepEqual(task.documents, []);
  assert.equal(task.privacyManifest.classification, 'customer_sensitive');
  assert.equal(task.privacyManifest.wukongMemory.originalDocuments, 'forbidden');
  assert.equal(task.privacyManifest.wukongMemory.ocrText, 'forbidden');
  assert.equal(task.privacyManifest.externalSharing, 'redacted_only');
  assert.deepEqual(task.events[0], { action: 'created', status: 'uploading', stateVersion: 1, createdAt: NOW });
});

test('appends two images using stable safe document metadata', () => {
  const task = create();
  const result = appendAgentPolicyImportDocuments(task, {
    stateVersion: 1,
    documents: [image('a'.repeat(64), 'one.jpg'), image('b'.repeat(64), 'two.jpg')],
    now: '2026-07-12T08:01:00.000Z',
  });
  assert.equal(result.added.length, 2);
  assert.equal(task.documents.length, 2);
  assert.equal(task.status, 'recognizing');
  assert.equal(task.stateVersion, 2);
  assert.match(task.documents[0].documentId, /^doc_[a-f0-9]{16,32}$/u);
  assert.deepEqual(Object.keys(task.documents[0]).sort(), ['documentId', 'mediaType', 'name', 'sha256', 'size', 'status'].sort());
});

test('deduplicates SHA-256 without incrementing the version', () => {
  const task = create();
  appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] });
  const result = appendAgentPolicyImportDocuments(task, { stateVersion: 2, documents: [image('a'.repeat(64), 'copy.jpg')] });
  assert.equal(result.added.length, 0);
  assert.equal(result.existing[0].documentId, task.documents[0].documentId);
  assert.equal(task.stateVersion, 2);
});

test('rejects PDF mixing and configurable count and size limits', () => {
  const pdf = { ...image('c'.repeat(64), 'policy.pdf'), type: 'application/pdf' };
  const pdfTask = create();
  appendAgentPolicyImportDocuments(pdfTask, { stateVersion: 1, documents: [pdf] });
  assert.equal(pdfTask.documents.length, 1);
  assert.throws(() => appendAgentPolicyImportDocuments(create(), { stateVersion: 1, documents: [pdf, image('d'.repeat(64))] }), (error) => error.code === 'MIXED_DOCUMENT_TYPES');
  assert.throws(() => appendAgentPolicyImportDocuments(pdfTask, { stateVersion: 2, documents: [{ ...pdf, sha256: 'd'.repeat(64), name: 'second.pdf' }] }), (error) => error.code === 'MIXED_DOCUMENT_TYPES');
  assert.throws(() => appendAgentPolicyImportDocuments(create(), { stateVersion: 1, documents: [image('a'.repeat(64)), image('b'.repeat(64))], maxDocuments: 1 }), (error) => error.code === 'DOCUMENT_LIMIT_EXCEEDED');
  assert.throws(() => appendAgentPolicyImportDocuments(create(), { stateVersion: 1, documents: [image('a'.repeat(64), 'big.jpg', 101)], maxDocumentBytes: 100 }), (error) => error.code === 'DOCUMENT_SIZE_EXCEEDED');
  assert.throws(() => appendAgentPolicyImportDocuments(create(), { stateVersion: 1, documents: [image('a'.repeat(64), 'one.jpg', 60), image('b'.repeat(64), 'two.jpg', 60)], maxTotalBytes: 100 }), (error) => error.code === 'DOCUMENT_TOTAL_SIZE_EXCEEDED');
});

test('rejects append to closed tasks and stale mutations', () => {
  const task = create();
  task.status = 'completed';
  assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] }), (error) => error.code === 'AGENT_POLICY_IMPORT_CLOSED');
  const open = create();
  assert.throws(() => appendAgentPolicyImportDocuments(open, { stateVersion: 0, documents: [image('a'.repeat(64))] }), (error) => error.code === 'INVALID_STATE_VERSION');
});

test('enforces legal product and member options through confirmation', () => {
  const task = create({
    draft: { company: '测试保险', name: '', insured: '' },
    productOptions: [{ optionId: 'product-1', productId: 31, label: '安心保' }],
    memberOptions: [{ optionId: 'member-1', memberId: 21, label: '张*' }],
  });
  assert.throws(() => updateAgentPolicyImportTask(task, { stateVersion: 1, action: 'select_product', optionId: 'invented' }), (error) => error.code === 'INVALID_OPTION');
  updateAgentPolicyImportTask(task, { stateVersion: 1, action: 'select_product', optionId: 'product-1' });
  assert.throws(() => updateAgentPolicyImportTask(task, { stateVersion: 2, action: 'bind_member', optionId: 'invented', role: 'insured' }), (error) => error.code === 'INVALID_OPTION');
  updateAgentPolicyImportTask(task, { stateVersion: 2, action: 'bind_member', optionId: 'member-1', role: 'insured' });
  assert.equal(task.status, 'final_confirmation');
  updateAgentPolicyImportTask(task, { stateVersion: 3, action: 'confirm' });
  assert.equal(task.status, 'saving');
  assert.equal(task.events.at(-1).action, 'confirm');
  assert.doesNotMatch(JSON.stringify(task.events), /测试保险|安心保|张/u);
  updateAgentPolicyImportTask(task, { stateVersion: 4, action: 'mark_saved' });
  assert.equal(task.status, 'completed');
});

test('enforces the controlled phase and action matrix', () => {
  for (const status of ['uploading', 'recognizing', 'saving']) {
    const task = create({ draft: { company: 'A', name: 'B', insured: 'C' } });
    task.status = status;
    for (const action of ['set_field', 'select_product', 'bind_member', 'confirm']) {
      assert.throws(
        () => updateAgentPolicyImportTask(task, { stateVersion: 1, action, field: 'company', value: 'D', optionId: 'product-1' }),
        (error) => error.code === 'ACTION_NOT_ALLOWED_IN_PHASE',
      );
    }
    const context = buildAgentPolicyImportContext(task);
    assert.ok(context.nextInteraction === null || context.nextInteraction.type === 'progress');
    assert.notEqual(context.nextInteraction?.type, 'confirm');
  }

  const candidate = create({
    draft: { company: 'A', insured: 'C' },
    productOptions: [{ optionId: 'product-1', productId: 1, label: 'B' }],
  });
  assert.equal(candidate.status, 'candidate_selection');
  assert.throws(() => updateAgentPolicyImportTask(candidate, { stateVersion: 1, action: 'set_field', field: 'name', value: 'B' }), (error) => error.code === 'ACTION_NOT_ALLOWED_IN_PHASE');

  const finalTask = create({ draft: { company: 'A', name: 'B', insured: 'C' } });
  assert.equal(finalTask.status, 'final_confirmation');
  assert.throws(() => updateAgentPolicyImportTask(finalTask, { stateVersion: 1, action: 'mark_saved' }), (error) => error.code === 'ACTION_NOT_ALLOWED_IN_PHASE');
  updateAgentPolicyImportTask(finalTask, { stateVersion: 1, action: 'confirm' });
  assert.equal(finalTask.status, 'saving');
  assert.equal(buildAgentPolicyImportContext(finalTask).nextInteraction?.type, 'progress');
  updateAgentPolicyImportTask(finalTask, { stateVersion: 2, action: 'mark_saved' });
  assert.equal(finalTask.status, 'completed');
});

test('public context masks identifiers and exposes only safe progress and legal choices', () => {
  const task = create({
    draft: { company: '测试保险', name: '安心保', insured: '张小明', policyNumber: 'POLICY12345678', insuredIdNumber: '330106199001011234', mobile: '13812345678' },
    productOptions: [{ optionId: 'product-1', productId: 31, label: '安心保' }],
  });
  appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] });
  const context = buildAgentPolicyImportContext(task);
  assert.equal(context.documentSummary.count, 1);
  assert.deepEqual(context.documentSummary.statuses, { received: 1 });
  assert.equal(context.policyDraft.insured, '张**');
  assert.match(context.policyDraft.policyNumber, /5678$/u);
  assert.match(context.policyDraft.insuredIdNumber, /1234$/u);
  assert.match(context.policyDraft.mobile, /5678$/u);
  assert.deepEqual(context.legalOptions.products, [{ optionId: 'product-1', label: '安心保' }]);
  assert.equal(context.stateVersion, 2);
  assert.ok(context.nextInteraction);
  assert.doesNotMatch(JSON.stringify(context), /data:image|"ocrText"\s*:|\/private\/|330106199001011234|POLICY12345678|13812345678/u);
});

test('normalizes legacy tasks missing document and status state', () => {
  const legacy = normalizeAgentPolicyImportTask({ id: 2, familyId: 3, ownerGuestId: 'g', draft: { company: 'A', name: 'B', insured: 'C' } });
  assert.deepEqual(legacy.documents, []);
  assert.equal(legacy.status, 'final_confirmation');
  assert.equal(legacy.stateVersion, 1);
  assert.equal(legacy.privacyManifest.externalSharing, 'redacted_only');
});

test('matches only the exact task owner identity', () => {
  const userTask = create();
  assert.equal(agentPolicyImportMatchesOwner(userTask, { userId: 7 }), true);
  assert.equal(agentPolicyImportMatchesOwner(userTask, { userId: 8 }), false);
  const guestTask = create({ owner: { guestId: 'guest-1' } });
  assert.equal(agentPolicyImportMatchesOwner(guestTask, { guestId: 'guest-1' }), true);
  assert.equal(agentPolicyImportMatchesOwner(guestTask, { guestId: 'guest-2' }), false);
});

test('failed mutations are atomic and reject untrusted document metadata', () => {
  const task = create({ draft: { company: '', name: '', insured: '' } });
  const before = structuredClone(task);
  assert.throws(
    () => appendAgentPolicyImportDocuments(task, {
      stateVersion: 1,
      documents: [{ ...image('a'.repeat(64)), documentId: 'caller-id', status: 'recognized', dataUrl: 'secret' }],
    }),
    (error) => error.code === 'UNTRUSTED_DOCUMENT_METADATA',
  );
  assert.deepEqual(task, before);
  assert.throws(() => updateAgentPolicyImportTask(task, { stateVersion: 1, action: 'set_field', field: 'company', value: { secret: 'x' } }), (error) => error.code === 'INVALID_FIELD_VALUE');
  assert.deepEqual(task, before);
});

test('strict versions and invalid limit configuration fail closed without mutation', () => {
  const task = create();
  const before = structuredClone(task);
  for (const stateVersion of [Infinity, 1.5, 0, '1']) {
    assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion, documents: [] }), (error) => error.code === 'INVALID_STATE_VERSION' || error.code === 'STALE_INTERACTION');
    assert.deepEqual(task, before);
  }
  for (const maxDocuments of [0, Infinity, 1.5, 10_000]) {
    assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [], maxDocuments }), (error) => error.code === 'INVALID_DOCUMENT_LIMIT');
    assert.deepEqual(task, before);
  }
  assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: {}, maxDocuments: 2 }), (error) => error.code === 'INVALID_DOCUMENT_LIST');
  assert.deepEqual(task, before);
  assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(65))] }), (error) => error.code === 'INVALID_DOCUMENT_HASH');
  assert.deepEqual(task, before);
  assert.equal(assertAgentPolicyImportExpectedVersion(task, 1), true);
  assert.throws(() => assertAgentPolicyImportExpectedVersion(task, 2), (error) => error.code === 'STALE_INTERACTION');
  const corruptVersion = { ...task, stateVersion: Infinity };
  const corruptBefore = structuredClone(corruptVersion);
  assert.throws(() => appendAgentPolicyImportDocuments(corruptVersion, { stateVersion: 1, documents: [] }), (error) => error.code === 'INVALID_STATE_VERSION');
  assert.deepEqual(corruptVersion, corruptBefore);
});

test('server generates document IDs and always starts documents as received', () => {
  const task = create();
  let sequence = 0;
  appendAgentPolicyImportDocuments(task, {
    stateVersion: 1,
    documents: [image('a'.repeat(64))],
    generateDocumentId: () => `doc_test_${++sequence}`,
  });
  assert.equal(task.documents[0].documentId, 'doc_test_1');
  assert.equal(task.documents[0].status, 'received');
});

test('creation validates canonical IDs, option schemas, and scalar draft fields', () => {
  for (const id of [0, -1, 1.2, Infinity, '10']) {
    assert.throws(() => create({ id }), (error) => error.code === 'INVALID_TASK_ID');
  }
  assert.throws(() => create({ familyId: 0 }), (error) => error.code === 'INVALID_FAMILY_ID');
  assert.throws(() => create({ owner: { userId: 1.5 } }), (error) => error.code === 'INVALID_OWNER_ID');
  assert.throws(() => create({ draft: { company: ['not scalar'] } }), (error) => error.code === 'INVALID_FIELD_VALUE');
  assert.throws(() => create({ productOptions: [{ optionId: 'p', label: 'P' }] }), (error) => error.code === 'INVALID_OPTION');
  assert.throws(() => create({ memberOptions: [{ optionId: 'm', label: 'M' }] }), (error) => error.code === 'INVALID_OPTION');
  assert.throws(() => create({ productOptions: [{ optionId: 'p', productId: 1, label: 'P' }, { optionId: 'p', productId: 2, label: 'Q' }] }), (error) => error.code === 'INVALID_OPTION');
});

test('legacy active phases are rederived while processing and closed phases remain stable', () => {
  const base = { id: 1, familyId: 2, ownerGuestId: 'guest', stateVersion: 1, draft: { company: '', name: '', insured: '' } };
  assert.equal(normalizeAgentPolicyImportTask({ ...base, status: 'candidate_selection' }).status, 'field_completion');
  assert.equal(normalizeAgentPolicyImportTask({ ...base, status: 'recognizing' }).status, 'recognizing');
  assert.equal(normalizeAgentPolicyImportTask({ ...base, status: 'completed' }).status, 'completed');
});

test('deep public serialization redacts identifiers and drops unknown graphs', () => {
  const task = create({
    draft: {
      company: '保险 13812345678',
      name: '产品 330106199001011234',
      insured: '张小明',
      amount: '金额 13812345678',
      firstPremium: 1234,
      plans: [{ nested: { raw: 'DEEP_SECRET' } }],
      unknown: { raw: 'UNKNOWN_SECRET' },
    },
    productOptions: [{ optionId: 'p1', productId: 1, label: '候选 13812345678' }],
    memberOptions: [{ optionId: 'm1', memberId: 2, label: '李四 330106199001011234' }],
  });
  const serialized = JSON.stringify(buildAgentPolicyImportContext(task));
  assert.doesNotMatch(serialized, /13812345678|330106199001011234|DEEP_SECRET|UNKNOWN_SECRET/u);
  assert.equal(typeof buildAgentPolicyImportContext(task).policyDraft.amount, 'string');
  assert.equal(typeof buildAgentPolicyImportContext(task).policyDraft.firstPremium, 'string');
});

test('required scalar identifiers reject missing and null values', () => {
  for (const guestId of [undefined, null, '']) {
    assert.throws(() => create({ owner: { guestId } }), (error) => error.code === 'INVALID_FIELD_VALUE');
  }
  for (const optionId of [undefined, null, '']) {
    assert.throws(() => create({ productOptions: [{ optionId, productId: 1, label: 'P' }] }), (error) => error.code === 'INVALID_FIELD_VALUE');
  }
  for (const label of [undefined, null, '']) {
    assert.throws(() => create({ productOptions: [{ optionId: 'p', productId: 1, label }] }), (error) => error.code === 'INVALID_FIELD_VALUE');
  }
  const task = create();
  assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))], generateDocumentId: () => null }), (error) => error.code === 'INVALID_FIELD_VALUE');
  assert.throws(() => normalizeAgentPolicyImportTask({ ...task, documents: [{ ...image('a'.repeat(64)), mediaType: 'image/jpeg', documentId: null, status: 'received' }] }), (error) => error.code === 'INVALID_FIELD_VALUE');
});

test('a newly created task satisfies its own normalization invariants', () => {
  const task = create({ draft: { company: 'A', name: 'B', insured: 'C' } });
  assert.deepEqual(normalizeAgentPolicyImportTask(task), task);
});

test('document IDs and stored active hashes must be unique', () => {
  const task = create();
  appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))], generateDocumentId: () => 'doc_same' });
  const before = structuredClone(task);
  assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 2, documents: [image('b'.repeat(64))], generateDocumentId: () => 'doc_same' }), (error) => error.code === 'DUPLICATE_DOCUMENT_ID');
  assert.deepEqual(task, before);

  const duplicateId = { ...task, documents: [...task.documents, { ...task.documents[0], sha256: 'b'.repeat(64) }] };
  assert.throws(() => normalizeAgentPolicyImportTask(duplicateId), (error) => error.code === 'DUPLICATE_DOCUMENT_ID');
  const duplicateHash = { ...task, documents: [...task.documents, { ...task.documents[0], documentId: 'doc_other' }] };
  assert.throws(() => normalizeAgentPolicyImportTask(duplicateHash), (error) => error.code === 'DUPLICATE_DOCUMENT_HASH');
});

test('successful mutations reject unsafe in-place commit targets atomically', () => {
  for (const task of [Object.freeze(create()), Object.preventExtensions(create())]) {
    const before = structuredClone(task);
    assert.throws(() => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] }), (error) => error.code === 'UNSAFE_TASK_TARGET');
    assert.deepEqual(task, before);
  }
});

test('non-enumerable readonly task properties are rejected without descriptor changes', () => {
  const task = create();
  Object.defineProperty(task, 'status', {
    value: task.status,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const keysBefore = Reflect.ownKeys(task);
  const descriptorsBefore = Object.getOwnPropertyDescriptors(task);

  assert.throws(
    () => appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] }),
    (error) => error.code === 'UNSAFE_TASK_TARGET',
  );
  assert.deepEqual(Reflect.ownKeys(task), keysBefore);
  assert.deepEqual(Object.getOwnPropertyDescriptors(task), descriptorsBefore);
});

test('pending documents force recognizing and confirmation rejects corrupted lifecycle status', () => {
  const task = create({ draft: { company: 'A', name: 'B', insured: 'C' } });
  appendAgentPolicyImportDocuments(task, { stateVersion: 1, documents: [image('a'.repeat(64))] });
  task.status = 'final_confirmation';
  assert.equal(normalizeAgentPolicyImportTask(task).status, 'recognizing');
  assert.throws(() => updateAgentPolicyImportTask(task, { stateVersion: 2, action: 'confirm' }), (error) => error.code === 'POLICY_IMPORT_DOCUMENTS_PENDING');
});
