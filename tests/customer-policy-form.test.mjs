import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  if (nextName) assert.notEqual(end, -1, `${nextName} should exist`);
  return source.slice(start, end === -1 ? source.length : end);
}

async function loadCustomerPolicyFormModule() {
  const source = fs.readFileSync(new URL('../src/shared/customer-policy-form.ts', import.meta.url), 'utf8');
  const scanToFormSource = functionSource(source, 'scanToForm', 'canReuseParticipantMemberId');
  const canReuseParticipantMemberIdSource = functionSource(source, 'canReuseParticipantMemberId', 'mergeScanToForm');
  const mergeScanToFormSource = functionSource(source, 'mergeScanToForm', 'sanitizeAmount');
  const sanitizeAmountSource = functionSource(source, 'sanitizeAmount', 'hasRequiredText');
  const hasRequiredTextSource = functionSource(source, 'hasRequiredText', 'hasPlanPremiumEvidence');
  const hasPlanPremiumEvidenceSource = functionSource(source, 'hasPlanPremiumEvidence', 'hasConfirmedRelation');
  const hasConfirmedRelationSource = functionSource(source, 'hasConfirmedRelation', 'validatePolicyEntryForm');
  const validatePolicyEntryFormSource = functionSource(source, 'validatePolicyEntryForm', 'productLookupKey');
  const moduleSource = `
    type PolicyFormData = any;
    type PolicyScanResult = any;
    function normalizeBeneficiaryValue(value: unknown) {
      return String(value || '');
    }
    function normalizePolicyPlanRoleLabel(role: string) {
      if (role === 'main') return '主险';
      if (role === 'linked_account') return '万能账户';
      if (role === 'rider') return '附加险';
      return '未分类';
    }
    function normalizePolicyPlanListWithIndex(plans: unknown, company = '', options: { keepEmpty?: boolean; assignRolesByRecognizedOrder?: boolean } = {}) {
      return (Array.isArray(plans) ? plans : []).map((plan: any, index) => ({
        ...plan,
        role: options.assignRolesByRecognizedOrder ? (plan?.role || (index === 0 ? 'main' : 'rider')) : (plan?.role || (index === 0 ? 'main' : 'rider')),
        __originalIndex: index,
      }));
    }
    function normalizePolicyPlanList(plans: unknown, company = '', options: { keepEmpty?: boolean; assignRolesByRecognizedOrder?: boolean } = {}) {
      return normalizePolicyPlanListWithIndex(plans, company, options).map(({ __originalIndex, ...plan }) => plan);
    }
    ${scanToFormSource}
    ${canReuseParticipantMemberIdSource}
    ${mergeScanToFormSource}
    ${sanitizeAmountSource}
    ${hasRequiredTextSource}
    ${hasPlanPremiumEvidenceSource}
    ${hasConfirmedRelationSource}
    ${validatePolicyEntryFormSource}
    export { scanToForm, mergeScanToForm, validatePolicyEntryForm };
  `;
  const output = ts.transpileModule(moduleSource, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const encoded = Buffer.from(output, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

test('mergeScanToForm clears stale participant member ids when OCR changes participant names', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '投保人:温舒萍\n被保险人:温舒萍',
      data: {
        company: '新华保险',
        name: '新保单',
        applicant: '温舒萍',
        insured: '温舒萍',
      },
    },
    {
      company: '新华保险',
      name: '旧保单',
      applicant: '冯力',
      insured: '冯力',
      beneficiary: '法定',
      applicantRelation: '本人',
      insuredRelation: '本人',
      insuredBirthday: '',
      date: '',
      paymentPeriod: '',
      coveragePeriod: '',
      amount: '',
      firstPremium: '',
      familyId: 500693,
      applicantMemberId: 500714,
      insuredMemberId: 500714,
      applicantMemberName: '冯力',
      insuredMemberName: '冯力',
    },
  );

  assert.equal(merged.familyId, 500693);
  assert.equal(merged.applicantMemberId, null);
  assert.equal(merged.insuredMemberId, null);
  assert.equal(merged.applicantRelation, '');
  assert.equal(merged.insuredRelation, '');
});

test('mergeScanToForm keeps participant member ids when OCR keeps the same participant names', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '投保人:冯力\n被保险人:冯力',
      data: {
        company: '新华保险',
        name: '同一张保单',
        applicant: '冯力',
        insured: '冯力',
      },
    },
    {
      company: '新华保险',
      name: '旧保单',
      applicant: '冯力',
      insured: '冯力',
      beneficiary: '法定',
      applicantRelation: '本人',
      insuredRelation: '本人',
      insuredBirthday: '',
      date: '',
      paymentPeriod: '',
      coveragePeriod: '',
      amount: '',
      firstPremium: '',
      familyId: 500693,
      applicantMemberId: 500714,
      insuredMemberId: 500714,
      applicantMemberName: '冯力',
      insuredMemberName: '冯力',
    },
  );

  assert.equal(merged.applicantMemberId, 500714);
  assert.equal(merged.insuredMemberId, 500714);
});

test('mergeScanToForm clears already-mismatched saved participant ids even when the scanned name stays the same', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '投保人:温舒萍\n被保险人:温舒萍',
      data: {
        company: '新华保险',
        name: '当前保单',
        applicant: '温舒萍',
        insured: '温舒萍',
      },
    },
    {
      company: '新华保险',
      name: '旧保单',
      applicant: '温舒萍',
      insured: '温舒萍',
      beneficiary: '法定',
      applicantRelation: '本人',
      insuredRelation: '本人',
      insuredBirthday: '',
      date: '',
      paymentPeriod: '',
      coveragePeriod: '',
      amount: '',
      firstPremium: '',
      familyId: 500693,
      applicantMemberId: 500714,
      insuredMemberId: 500714,
      applicantMemberName: '冯力',
      insuredMemberName: '冯力',
    },
  );

  assert.equal(merged.applicantMemberId, null);
  assert.equal(merged.insuredMemberId, null);
});

test('mergeScanToForm clears stale insured identity fields when OCR changes the insured name', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '投保人:温舒萍\n被保险人:小明',
      data: {
        company: '新华保险',
        name: '当前保单',
        applicant: '温舒萍',
        insured: '小明',
        insuredBirthday: '',
        insuredIdNumber: '',
      },
    },
    {
      company: '新华保险',
      name: '旧保单',
      applicant: '温舒萍',
      insured: '温舒萍',
      beneficiary: '法定',
      applicantRelation: '本人',
      insuredRelation: '本人',
      insuredBirthday: '1988-12-16',
      insuredIdNumber: '310101198812160922',
      date: '',
      paymentPeriod: '',
      coveragePeriod: '',
      amount: '',
      firstPremium: '',
      familyId: 500693,
      applicantMemberId: 500689,
      insuredMemberId: 500689,
      applicantMemberName: '温舒萍',
      insuredMemberName: '温舒萍',
    },
  );

  assert.equal(merged.insuredRelation, '');
  assert.equal(merged.insuredBirthday, '');
  assert.equal(merged.insuredIdNumber, '');
  assert.equal(merged.insuredMemberId, null);
});

test('validatePolicyEntryForm accepts riders when OCR proves only total premium is printed', async () => {
  const { validatePolicyEntryForm } = await loadCustomerPolicyFormModule();
  const errors = validatePolicyEntryForm({
    familyId: 1,
    company: '新华保险',
    name: '学生平安意外伤害保险',
    applicant: '楼媛媛',
    beneficiary: '法定',
    applicantRelation: '本人',
    insured: '王後曦',
    insuredRelation: '子女',
    insuredBirthday: '2009-06-08',
    date: '2024-08-16',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    amount: '80000',
    firstPremium: '298',
    plans: [
      {
        role: 'main',
        name: '学生平安意外伤害保险',
        amount: '80000',
        premium: '',
        premiumText: '整单合计保费：298；保单未列逐险种保费',
        coveragePeriod: '至2025年08月15日',
        paymentPeriod: '趸交',
      },
      {
        role: 'rider',
        name: '附加学生平安A款定期寿险',
        amount: '80000',
        premium: '',
        premiumText: '整单合计保费：298；保单未列逐险种保费',
        coveragePeriod: '至2025年08月15日',
        paymentPeriod: '趸交',
      },
    ],
  });

  assert.ok(!errors.includes('附加险1保费'));
});

test('scanToForm preserves linked account role from visual OCR plans', async () => {
  const { scanToForm } = await loadCustomerPolicyFormModule();
  const form = scanToForm({
    ocrText: '保险利益表\n荣耀鑫享赢家版终身寿险\n金利瑞享终身寿险（万能型）',
    data: {
      company: '新华保险',
      name: '荣耀鑫享赢家版终身寿险',
      plans: [
        { role: 'main', name: '荣耀鑫享赢家版终身寿险' },
        { role: 'linked_account', name: '金利瑞享终身寿险（万能型）', productType: '万能账户' },
      ],
    },
  });

  assert.equal(form.plans[0].role, 'main');
  assert.equal(form.plans[1].role, 'linked_account');
});

test('policy form normalization consults metadata-like plan filtering before showing OCR riders', () => {
  const source = fs.readFileSync(new URL('../src/shared/customer-policy-form.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/policy-plan-filter\.mjs'/);
  assert.match(source, /if \(!keepEmpty && !shouldKeepPolicyPlan\(plan\)\) return;/);
});
