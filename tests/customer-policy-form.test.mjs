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
  const isValidDateInputPartsSource = functionSource(source, 'isValidDateInputParts', 'normalizeDateInputValue');
  const normalizeDateInputValueSource = functionSource(source, 'normalizeDateInputValue', 'shareBirthdayForSameName');
  const shareBirthdayForSameNameSource = functionSource(source, 'shareBirthdayForSameName', 'sharePolicyPersonInfo');
  const sharePolicyPersonInfoSource = functionSource(source, 'sharePolicyPersonInfo', 'normalizePolicyPlanListWithIndex');
  const scanToFormSource = functionSource(source, 'scanToForm', 'canReuseParticipantMemberId');
  const canReuseParticipantMemberIdSource = functionSource(source, 'canReuseParticipantMemberId', 'mergeScanToForm');
  const mergeScanToFormSource = functionSource(source, 'mergeScanToForm', 'sanitizeAmount');
  const sanitizeAmountSource = functionSource(source, 'sanitizeAmount', 'hasRequiredText');
  const hasRequiredTextSource = functionSource(source, 'hasRequiredText', 'hasPlanPremiumEvidence');
  const hasPlanPremiumEvidenceSource = functionSource(source, 'hasPlanPremiumEvidence', 'hasConfirmedRelation');
  const hasConfirmedRelationSource = functionSource(source, 'hasConfirmedRelation', 'resolveBoundParticipantRelation');
  const resolveBoundParticipantRelationSource = functionSource(source, 'resolveBoundParticipantRelation', 'validatePolicyEntryForm');
  const validatePolicyEntryFormSource = functionSource(source, 'validatePolicyEntryForm', 'productLookupKey');
  const syncMainPolicyPlanFieldsSource = functionSource(source, 'syncMainPolicyPlanFields', 'syncMainPolicyPlanAmount');
  const buildPolicyUpdateDataSource = functionSource(source, 'buildPolicyUpdateData', 'scanToForm');
  const moduleSource = `
    type PolicyFormData = any;
    type PolicyScanResult = any;
    type MainPolicyPlanFieldSync = any;
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
    ${isValidDateInputPartsSource}
    ${normalizeDateInputValueSource}
    ${shareBirthdayForSameNameSource}
    ${sharePolicyPersonInfoSource}
    ${syncMainPolicyPlanFieldsSource}
    ${buildPolicyUpdateDataSource}
    ${scanToFormSource}
    ${canReuseParticipantMemberIdSource}
    ${mergeScanToFormSource}
    ${sanitizeAmountSource}
    ${hasRequiredTextSource}
    ${hasPlanPremiumEvidenceSource}
    ${hasConfirmedRelationSource}
    ${resolveBoundParticipantRelationSource}
    ${validatePolicyEntryFormSource}
    export { scanToForm, mergeScanToForm, resolveBoundParticipantRelation, validatePolicyEntryForm, buildPolicyUpdateData, normalizeDateInputValue, sharePolicyPersonInfo };
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

test('buildPolicyUpdateData normalizes slash date values before saving policy edits', async () => {
  const { buildPolicyUpdateData, normalizeDateInputValue } = await loadCustomerPolicyFormModule();
  assert.equal(normalizeDateInputValue('1987/12/02'), '1987-12-02');
  assert.equal(normalizeDateInputValue('2024年12月05日'), '2024-12-05');

  const updated = buildPolicyUpdateData(
    { company: '新华保险', name: '旧产品', canonicalProductId: 'xinhua-old' },
    {
      company: '新华保险',
      name: '旧产品',
      canonicalProductId: 'xinhua-old',
      applicant: '张三',
      applicantBirthday: '',
      beneficiary: '法定',
      beneficiaryRelation: '',
      beneficiaryBirthday: '2020/01/03',
      applicantRelation: '配偶',
      insured: '李四',
      insuredRelation: '配偶',
      insuredIdNumber: '',
      insuredBirthday: '1987/12/02',
      date: '2024/12/05',
      paymentPeriod: '20年交',
      coveragePeriod: '至60岁',
      amount: '100000',
      firstPremium: '12000',
      plans: [],
    },
  );

  assert.equal(updated.insuredBirthday, '1987-12-02');
  assert.equal(updated.beneficiaryBirthday, '2020-01-03');
  assert.equal(updated.date, '2024-12-05');
});

test('buildPolicyUpdateData syncs editable top-level fields into the main plan', async () => {
  const { buildPolicyUpdateData } = await loadCustomerPolicyFormModule();
  const updated = buildPolicyUpdateData(
    { company: '中国平安', name: '旧产品', canonicalProductId: 'old-id' },
    {
      company: '中国平安',
      name: '旧产品',
      canonicalProductId: 'old-id',
      applicant: '张三',
      applicantBirthday: '',
      beneficiary: '法定',
      beneficiaryRelation: '',
      beneficiaryBirthday: '',
      applicantRelation: '本人',
      insured: '张三',
      insuredRelation: '本人',
      insuredIdNumber: '',
      insuredBirthday: '',
      date: '2024-12-05',
      paymentPeriod: '10年交',
      coveragePeriod: '至70岁',
      amount: '1000',
      firstPremium: '888',
      plans: [
        {
          company: '中国平安',
          role: 'main',
          name: '旧产品',
          matchedProductName: '旧产品',
          amount: '3',
          premium: '2',
          coveragePeriod: '旧保障期间',
          paymentPeriod: '旧缴费期间',
        },
        {
          company: '中国平安',
          role: 'rider',
          name: '附加险',
          matchedProductName: '附加险',
          amount: '200',
          premium: '20',
          coveragePeriod: '20年',
          paymentPeriod: '3年交',
        },
      ],
    },
  );

  assert.equal(updated.plans[0].amount, '1000');
  assert.equal(updated.plans[0].premium, '888');
  assert.equal(updated.plans[0].coveragePeriod, '至70岁');
  assert.equal(updated.plans[0].paymentPeriod, '10年交');
  assert.equal(updated.plans[1].amount, '200');
  assert.equal(updated.plans[1].premium, '20');
});

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

test('mergeScanToForm shares birthday across same-name policy people', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '投保人:秦国英\n被保险人:秦国英\n生日:1970/01/06',
      data: {
        company: '中国平安',
        name: '测试保单',
        applicant: '秦国英',
        insured: '秦国英',
        beneficiary: '秦国英',
        applicantRelation: '母亲',
        insuredBirthday: '1970-01-06',
      },
    },
    {
      company: '中国平安',
      name: '旧保单',
      applicant: '秦国英',
      insured: '秦国英',
      beneficiary: '秦国英',
      applicantBirthday: '',
      beneficiaryBirthday: '',
      insuredBirthday: '',
      date: '',
      paymentPeriod: '',
      coveragePeriod: '',
      amount: '',
      firstPremium: '',
    },
  );

  assert.equal(merged.applicantBirthday, '1970-01-06');
  assert.equal(merged.insuredBirthday, '1970-01-06');
  assert.equal(merged.beneficiaryBirthday, '1970-01-06');
  assert.equal(merged.beneficiaryRelation, '母亲');
});

test('mergeScanToForm clears stale beneficiary details when OCR changes beneficiary name', async () => {
  const { mergeScanToForm } = await loadCustomerPolicyFormModule();
  const merged = mergeScanToForm(
    {
      ocrText: '受益人:故意杀害',
      data: {
        company: '中国平安保险',
        name: '终身寿险',
        applicant: '在投保时可选择以',
        insured: '因意外伤害事故身',
        beneficiary: '故意杀害',
      },
    },
    {
      company: '中国平安保险',
      name: '世纪天使（906）',
      applicant: '余贵祥',
      insured: '张正涛',
      beneficiary: '张正涛',
      beneficiaryRelation: '子女',
      beneficiaryBirthday: '2005-10-05',
      applicantRelation: '本人',
      insuredRelation: '子女',
      date: '2008-11-28',
      paymentPeriod: '20年交',
      coveragePeriod: '终身',
      amount: '50000',
      firstPremium: '7357.81',
    },
  );

  assert.equal(merged.beneficiary, '故意杀害');
  assert.equal(merged.beneficiaryRelation, '');
  assert.equal(merged.beneficiaryBirthday, '');
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
    applicantBirthday: '',
    beneficiaryBirthday: '',
    insuredBirthday: '',
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
  assert.ok(!errors.includes('投保人生日'));
  assert.ok(!errors.includes('受益人生日'));
  assert.ok(!errors.includes('被保险人生日'));
});

test('validatePolicyEntryForm can allow first save before a family profile exists', async () => {
  const { validatePolicyEntryForm } = await loadCustomerPolicyFormModule();
  const form = {
    familyId: null,
    company: '新华保险',
    name: '学生平安意外伤害保险',
    applicant: '楼媛媛',
    beneficiary: '法定',
    applicantRelation: '本人',
    insured: '王後曦',
    insuredRelation: '子女',
    applicantBirthday: '',
    beneficiaryBirthday: '',
    insuredBirthday: '',
    date: '2024-08-16',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    amount: '80000',
    firstPremium: '298',
    plans: [],
  };

  assert.ok(validatePolicyEntryForm(form).includes('选择家庭档案'));
  assert.ok(!validatePolicyEntryForm(form, { requireFamily: false }).includes('选择家庭档案'));
});

test('validatePolicyEntryForm can allow pending top-pillar relations before core member is set', async () => {
  const { validatePolicyEntryForm } = await loadCustomerPolicyFormModule();
  const form = {
    familyId: 1,
    company: '新华保险',
    name: '学生平安意外伤害保险',
    applicant: '楼媛媛',
    beneficiary: '法定',
    applicantRelation: '待确认',
    insured: '王後曦',
    insuredRelation: '待确认',
    applicantBirthday: '',
    beneficiaryBirthday: '',
    insuredBirthday: '',
    date: '2024-08-16',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    amount: '80000',
    firstPremium: '298',
    plans: [],
  };

  const strictErrors = validatePolicyEntryForm(form);
  assert.ok(strictErrors.includes('投保人与顶梁柱的关系'));
  assert.ok(strictErrors.includes('被保险人与顶梁柱的关系'));

  const relaxedErrors = validatePolicyEntryForm(form, { requireParticipantRelations: false });
  assert.ok(!relaxedErrors.includes('投保人与顶梁柱的关系'));
  assert.ok(!relaxedErrors.includes('被保险人与顶梁柱的关系'));
});

test('validatePolicyEntryForm allows saving without a beneficiary relation', async () => {
  const { validatePolicyEntryForm } = await loadCustomerPolicyFormModule();
  const form = {
    familyId: 1,
    company: '新华保险',
    name: '学生平安意外伤害保险',
    applicant: '楼媛媛',
    applicantRelation: '本人',
    insured: '王後曦',
    insuredRelation: '子女',
    beneficiary: '张三',
    beneficiaryRelation: '待确认',
    date: '2024-08-16',
    paymentPeriod: '趸交',
    coveragePeriod: '至2025年08月15日',
    amount: '80000',
    firstPremium: '298',
    plans: [],
  };

  assert.ok(!validatePolicyEntryForm(form).includes('受益人与顶梁柱的关系'));
  assert.ok(!validatePolicyEntryForm({ ...form, beneficiaryRelation: '配偶' }).includes('受益人与顶梁柱的关系'));
  assert.ok(!validatePolicyEntryForm({ ...form, beneficiary: '法定' }).includes('受益人与顶梁柱的关系'));
});

test('sharePolicyPersonInfo copies a matching participant relation to a named beneficiary', async () => {
  const { sharePolicyPersonInfo } = await loadCustomerPolicyFormModule();

  assert.equal(sharePolicyPersonInfo({
    applicant: '张三',
    applicantRelationLabel: '本人',
    insured: '李四',
    insuredRelationLabel: '配偶',
    beneficiary: '李四',
    beneficiaryRelation: '',
  }).beneficiaryRelation, '配偶');
});

test('manual participant relation is not overwritten by a bound member awaiting confirmation', async () => {
  const { resolveBoundParticipantRelation } = await loadCustomerPolicyFormModule();

  assert.equal(resolveBoundParticipantRelation('配偶', '待确认'), '配偶');
  assert.equal(resolveBoundParticipantRelation('待确认', '母亲'), '母亲');
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
