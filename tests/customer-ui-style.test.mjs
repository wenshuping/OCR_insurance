import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appShellSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const customerAppSource = fs.readFileSync(new URL('../src/apps/customer/CustomerApp.tsx', import.meta.url), 'utf8');
const adminAppSource = fs.readFileSync(new URL('../src/apps/admin/AdminApp.tsx', import.meta.url), 'utf8');
const sharedReportUiSource = fs.readFileSync(new URL('../src/shared/policy-report-ui.tsx', import.meta.url), 'utf8');
const customerPolicyFormSource = fs.readFileSync(new URL('../src/shared/customer-policy-form.ts', import.meta.url), 'utf8');
const customerCashValueSource = fs.readFileSync(new URL('../src/shared/customer-cash-value.ts', import.meta.url), 'utf8');
const customerPolicyComponentsSource = fs.readFileSync(new URL('../src/shared/customer-policy-components.tsx', import.meta.url), 'utf8');
const customerPolicyListSource = fs.readFileSync(new URL('../src/shared/customer-policy-list.tsx', import.meta.url), 'utf8');
const familyProfileSource = fs.readFileSync(new URL('../src/features/family-profile/FamilyProfileManager.tsx', import.meta.url), 'utf8');
const policyEntrySource = fs.readFileSync(new URL('../src/features/policy-entry/UploadPolicyPage.tsx', import.meta.url), 'utf8');
const policyDetailSource = fs.readFileSync(new URL('../src/features/policy-detail/PolicyDetailSheet.tsx', import.meta.url), 'utf8');
const responsibilityAssistantSource = fs.readFileSync(new URL('../src/features/responsibility-assistant/ResponsibilityAssistant.tsx', import.meta.url), 'utf8');
const normalizedCustomerAppSource = customerAppSource.replaceAll("from '../../", "from './");
const normalizedAdminAppSource = adminAppSource.replaceAll("from '../../", "from './");
const normalizedCustomerPolicyFormSource = customerPolicyFormSource.replaceAll("from '../", "from './");
const normalizedCustomerCashValueSource = customerCashValueSource.replaceAll("from '../", "from './");
const normalizedCustomerPolicyComponentsSource = customerPolicyComponentsSource.replaceAll("from '../", "from './");
const normalizedCustomerPolicyListSource = customerPolicyListSource.replaceAll("from '../", "from './");
const normalizedCustomerPolicySharedSource = [
  normalizedCustomerPolicyFormSource,
  normalizedCustomerCashValueSource,
  normalizedCustomerPolicyComponentsSource,
  normalizedCustomerPolicyListSource,
].join('\n');
const normalizedFamilyProfileSource = familyProfileSource.replaceAll("from '../../", "from './");
const normalizedPolicyEntrySource = policyEntrySource.replaceAll("from '../../", "from './");
const normalizedPolicyDetailSource = policyDetailSource.replaceAll("from '../../", "from './");
const normalizedResponsibilityAssistantSource = responsibilityAssistantSource.replaceAll("from '../../", "from './");
const formatterSource = fs.readFileSync(new URL('../src/shared/formatters.ts', import.meta.url), 'utf8');
const reportExportSource = fs.readFileSync(new URL('../src/features/report-export/report-export.ts', import.meta.url), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} component should exist`);
  assert.notEqual(end, -1, `${nextName} component should exist`);
  return source.slice(start, end);
}

function owningSource(name) {
  const marker = `function ${name}`;
  if (normalizedCustomerAppSource.includes(marker)) return normalizedCustomerAppSource;
  if (normalizedFamilyProfileSource.includes(marker)) return normalizedFamilyProfileSource;
  if (normalizedPolicyEntrySource.includes(marker)) return normalizedPolicyEntrySource;
  if (normalizedPolicyDetailSource.includes(marker)) return normalizedPolicyDetailSource;
  if (normalizedResponsibilityAssistantSource.includes(marker)) return normalizedResponsibilityAssistantSource;
  if (normalizedCustomerPolicyComponentsSource.includes(marker)) return normalizedCustomerPolicyComponentsSource;
  if (normalizedCustomerPolicyListSource.includes(marker)) return normalizedCustomerPolicyListSource;
  if (normalizedCustomerPolicyFormSource.includes(marker)) return normalizedCustomerPolicyFormSource;
  if (normalizedCustomerCashValueSource.includes(marker)) return normalizedCustomerCashValueSource;
  if (normalizedAdminAppSource.includes(marker)) return normalizedAdminAppSource;
  if (sharedReportUiSource.includes(marker)) return sharedReportUiSource;
  if (appShellSource.includes(marker)) return appShellSource;
  return appShellSource;
}

function componentSource(name, nextName, source = owningSource(name)) {
  return functionSource(source, name, nextName);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('customer account sheet uses a blue account logo', () => {
  const source = componentSource('CustomerAccountSheet', 'PhoneVerificationDialog');
  assert.match(source, /h-12 w-12[^"]*bg-blue-500/);
});

test('customer account sheet exposes account actions and policy navigation', () => {
  const sheetSource = componentSource('CustomerAccountSheet', 'PhoneVerificationDialog');
  const appSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(sheetSource, /onOpenPolicies/);
  assert.match(sheetSource, /我的基本信息/);
  assert.match(sheetSource, /我的保单/);
  assert.match(sheetSource, /onClick=\{onOpenPolicies\}/);
  assert.match(sheetSource, /退出/);
  assert.match(appSource, /setShowAccountSheet\(false\);\s*setActiveTab\('policies'\);/);
});

test('phone verification send-code button uses the blue primary style', () => {
  const source = componentSource('PhoneVerificationDialog', null);
  assert.match(source, /className="[^"]*bg-blue-500[^"]*"[\s\S]*发验证码/);
});

test('entry form exposes local product candidates before responsibility generation', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const matchPanelSource = componentSource('ProductMatchSelectPanel', 'UploadPolicyPage');
  assert.match(pageSource, /ProductMatchSelectPanel/);
  assert.match(pageSource, /onGenerateAnalysis/);
  assert.match(pageSource, /生成责任/);
  assert.match(pageSource, /复制原文/);
  assert.match(pageSource, /handleCopyOcrText/);
  assert.match(pageSource, /录入保险公司候选/);
  assert.match(pageSource, /录入保险产品候选/);
  assert.match(pageSource, /formProductSuggestions/);
  assert.match(pageSource, /onSelectFormProduct/);
  assert.match(matchPanelSource, /相似产品/);
  assert.match(matchPanelSource, /role="listbox"/);
});

test('entry form requires family profile and supports core setup after OCR', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(pageSource, /家庭档案/);
  assert.match(pageSource, /新建家庭档案/);
  assert.match(pageSource, /家庭关系中心/);
  assert.match(pageSource, /保存前请选择家庭核心人员/);
  assert.match(pageSource, /家庭核心人员/);
  assert.match(pageSource, /与核心人员家庭关系/);
  assert.match(pageSource, /participantsAreSamePerson/);
  assert.match(pageSource, /areSameParticipantName\(formData\.applicant, formData\.insured\)/);
  assert.match(pageSource, /samePersonRelationResetKeyRef/);
  assert.doesNotMatch(pageSource, /if \(participantsAreSamePerson\(\)\) return '本人'/);
  assert.doesNotMatch(pageSource, /disabled=\{samePerson\}/);
  assert.doesNotMatch(pageSource, /applicantRelation \|\| '本人'/);
  assert.doesNotMatch(customerSource, /participantNamesMatch \? '本人'/);
  assert.doesNotMatch(pageSource, /和录入人的关系/);
  assert.doesNotMatch(pageSource, /投保人家庭成员/);
  assert.doesNotMatch(pageSource, /被保险人家庭成员/);
  assert.doesNotMatch(pageSource, /选择家庭成员/);
  assert.doesNotMatch(pageSource, /新增为家庭成员/);
  assert.match(customerSource, /familyProfiles/);
  assert.match(customerSource, /selectedFamilyId/);
  assert.match(customerSource, /createFamilyProfile/);
  assert.match(customerSource, /createFamilyMember/);
  assert.match(customerSource, /applicantMemberId/);
  assert.match(customerSource, /insuredMemberId/);
  assert.match(customerSource, /setFamilyCoreMember/);
  assert.match(customerSource, /setAsCoreOnCreate/);
  assert.match(pageSource, /updateParticipantName/);
  assert.match(pageSource, /setParticipantAsCore/);
  assert.match(pageSource, /updateParticipantRelation/);
  assert.doesNotMatch(pageSource, /selectFamilyParticipantMember/);
  assert.doesNotMatch(customerSource, /input\.memberId && !input\.setAsCore/);
  assert.doesNotMatch(customerSource, /input\.setAsCore\s*\?\s*null/);
});

test('customer app exposes family profile management surface', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const familySource = componentSource('FamilyProfileManager', null);
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(customerSource, /FamilyProfileManager/);
  assert.match(customerSource, /onOpenFamilies=\{\(\) => setActiveTab\('families'\)\}/);
  assert.match(customerSource, /<CustomerBottomTabs activeTab=\{activeTab\} onChange=\{setActiveTab\} onOpenReport=\{\(\) => setShowFamilyReport\(true\)\} \/>/);
  assert.match(pageSource, /onOpenFamilies/);
  assert.match(familySource, /家庭档案列表/);
  assert.match(pageSource, /家庭档案/);
  assert.match(pageSource, /<header[\s\S]*<h1 className="text-lg font-bold">录入保单<\/h1>[\s\S]*onClick=\{onOpenFamilies\}[\s\S]*家庭档案/);
  assert.match(pageSource, /bg-blue-50 px-3 text-sm font-black text-blue-600[\s\S]*onClick=\{onOpenFamilies\}[\s\S]*家庭档案/);
  assert.doesNotMatch(pageSource, /onOpenReport/);
  assert.doesNotMatch(pageSource, /查看报告/);
  assert.match(familySource, /成员数/);
  assert.match(familySource, /查看报告/);
  assert.match(familySource, /管理成员/);
  assert.doesNotMatch(familySource, /保单管理/);
  assert.doesNotMatch(familySource, /FamilyPolicyManagerPanel/);
  assert.doesNotMatch(familySource, /添加成员/);
  assert.doesNotMatch(familySource, /成员姓名/);
  assert.doesNotMatch(familySource, /handleAddFamilyMember/);
  assert.match(familySource, /设为核心/);
  assert.match(familySource, /onUpdateFamilyMemberRelation/);
  assert.match(familySource, /设置\$\{member\.name\}家庭关系/);
  assert.doesNotMatch(familySource, /编辑家庭/);
  assert.match(familySource, /录入保单/);
});

test('customer bottom tabs expose entry policy family and report navigation', () => {
  const source = componentSource('CustomerBottomTabs', 'CustomerAccountSheet');

  assert.match(source, /key: 'entry'/);
  assert.match(source, /key: 'policies'/);
  assert.match(source, /key: 'families'/);
  assert.match(source, /我的保单/);
  assert.match(source, /onOpenReport/);
  assert.match(source, /查看报告/);
  assert.match(source, /查看家庭保障分析报告/);
  assert.match(source, /grid-cols-4/);
});

test('policy relation controls keep prior policy edit options', () => {
  const source = `${normalizedCustomerPolicySharedSource}\n${normalizedPolicyDetailSource}`;

  assert.match(source, /const FAMILY_MEMBER_RELATION_OPTIONS = \['本人', '配偶', '儿子', '女儿', '父亲', '母亲', '其他', '待确认'\]/u);
  assert.match(source, /const POLICY_RELATION_OPTIONS = \['本人', '子女', '父母', '夫妻'\]/u);
  assert.match(source, /SelectField label="投保人关系"[\s\S]*options=\{POLICY_RELATION_OPTIONS\}/u);
  assert.match(source, /SelectField label="被保人关系"[\s\S]*options=\{POLICY_RELATION_OPTIONS\}/u);
});

test('customer app exposes family report share flow', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /createFamilyReportShare/);
  assert.match(apiSource, /getFamilyReportShare/);
  assert.match(appShellSource, /getFamilyReportShare/);
  assert.match(appShellSource, /family-share/);
  assert.match(appShellSource, /SharedFamilyReportApp/);
  assert.match(appShellSource, /sharedFamilyReport/);
  assert.match(appShellSource, /readOnly/);
  assert.match(customerSource, /handleShareFamilyReport/);
  assert.match(customerSource, /selectedFamilyId/);
  assert.match(customerSource, /navigator\.clipboard\.writeText\(shareUrl\)/);
  assert.match(customerSource, /分享链接：\$\{shareUrl\}/);
  assert.match(customerSource, /分享家庭报告/);
  assert.match(customerSource, /<span>分享<\/span>/);
});

test('photo upload area shows an OCR recognition animation while loading', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(pageSource, /aria-busy=\{loading\}/);
  assert.match(pageSource, /OCR 识别中/);
  assert.match(pageSource, /animate-spin/);
  assert.match(pageSource, /aria-live="polite"/);
});

test('entry form keeps bottom actions focused on saving workflow', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(pageSource, /max-w-3xl/);
  assert.match(pageSource, /生成责任/);
  assert.match(pageSource, /保存保单/);
  assert.match(customerSource, /renderResponsibilityAssistant\('bottom-24'\)/);
  assert.doesNotMatch(pageSource, /aria-label="进入我的保单"/);
  assert.doesNotMatch(pageSource, /CustomerBottomTabs/);
  assert.doesNotMatch(pageSource, /确认信息后保存保单/);
});

test('cash value upload dialog shows a progress bar while scanning', () => {
  const appSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(appSource, /role="progressbar"/);
  assert.match(appSource, /aria-valuetext="正在识别现金价值表"/);
  assert.match(appSource, /现金价值表识别中/);
  assert.match(appSource, /animate-\[cash-value-progress/);
});

test('cash value upload uses rear camera capture path', () => {
  const appSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const inputRefIndex = appSource.indexOf('ref={cashValueInputRef}');
  assert.notEqual(inputRefIndex, -1, 'cash value upload input should exist');
  const inputSource = appSource.slice(inputRefIndex, appSource.indexOf('/>', inputRefIndex));
  assert.match(appSource, /拍照上传/);
  assert.match(inputSource, /type="file"/);
  assert.match(inputSource, /accept="image\/\*"/);
  assert.match(inputSource, /capture="environment"/);
});

test('entry form keeps the add rider action visible in plan details', () => {
  const source = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  assert.match(source, /险种明细/);
  assert.match(source, /手动添加附加险/);
  assert.match(source, /w-full/);
  assert.match(source, /附加险或万能账户为可选项/);
  assert.doesNotMatch(source, /OCR 未识别到附加险/);
});

test('entry plan editor shows only riders and linked accounts', () => {
  const source = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  assert.match(source, /editablePlans/);
  assert.match(source, /String\(plan\.role \|\| ''\) !== 'main'/);
  assert.match(source, /originalIndex/);
  assert.match(source, /onRemove\(plan\.originalIndex\)/);
  assert.match(source, /onUpdate\(plan\.originalIndex,/);
  assert.doesNotMatch(source, /{plans\.map\(\(plan, index\) =>/);
  assert.doesNotMatch(source, /value: 'main', label: '主险'/);
});

test('plan type selector displays Chinese role labels instead of internal values', () => {
  const editorSource = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  const selectSource = componentSource('SelectField', null);
  assert.match(editorSource, /options=\{\[/);
  assert.match(editorSource, /label: '附加险'/);
  assert.match(editorSource, /label: '万能账户'/);
  assert.match(editorSource, /label: '未分类'/);
  assert.match(selectSource, /label: option/);
  assert.match(selectSource, /normalizedOption\.label \|\| normalizedOption\.value/);
});

test('manual rider drafts remain visible before a name is entered', () => {
  const normalizeSource = componentSource('normalizePolicyPlanList', 'primaryPlanFromPolicyForm');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const updatePlanSource = componentSource('updatePolicyPlan', 'addPolicyPlan');
  const addPlanSource = componentSource('addPolicyPlan', 'removePolicyPlan');
  const removePlanSource = componentSource('removePolicyPlan', 'selectFormProductMatch');
  assert.match(normalizeSource, /keepEmpty/);
  assert.match(normalizeSource, /!name && !matchedProductName && !keepEmpty/);
  assert.match(updatePlanSource, /normalizePolicyPlanList\(formData\.plans,\s*formData\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(addPlanSource, /normalizePolicyPlanList\(current\.plans,\s*current\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(removePlanSource, /normalizePolicyPlanList\(current\.plans,\s*current\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(pageSource, /plans=\{normalizePolicyPlanList\(formData\.plans,\s*formData\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)\}/);
});

test('rider edits do not clear matched optional responsibility draft', () => {
  const updatePlanSource = componentSource('updatePolicyPlan', 'addPolicyPlan');
  const addPlanSource = componentSource('addPolicyPlan', 'removePolicyPlan');
  const removePlanSource = componentSource('removePolicyPlan', 'selectFormProductMatch');
  const draftSource = componentSource('loadFormProductAnalysisDraft', 'updateForm');

  assert.doesNotMatch(updatePlanSource, /setAnalysisDraft\(null\)/);
  assert.doesNotMatch(addPlanSource, /setAnalysisDraft\(null\)/);
  assert.doesNotMatch(removePlanSource, /setAnalysisDraft\(null\)/);
  assert.match(updatePlanSource, /loadFormProductAnalysisDraft\(nextData,\s*'已更新险种明细'\)/);
  assert.match(removePlanSource, /setMessage\('已删除附加险'\)/);
  assert.doesNotMatch(removePlanSource, /loadFormProductAnalysisDraft\(nextData,\s*'已删除附加险/);
  assert.match(removePlanSource, /loadFormProductAnalysisDraft\(nextData,\s*'已删除险种，已重新带出可选责任'\)/);
  assert.match(draftSource, /existingOptionalResponsibilities/);
  assert.match(draftSource, /optionalResponsibilities: existingOptionalResponsibilities/);
});

test('policy plan normalization keeps main plans before riders', () => {
  const normalizeSource = componentSource('normalizePolicyPlanList', 'primaryPlanFromPolicyForm');
  assert.match(normalizeSource, /policyPlanRoleOrder/);
  assert.match(normalizeSource, /plan\?\.role \|\| \(index === 0 \? 'main' : 'rider'\)/);
  assert.match(normalizeSource, /\.sort\(\(left, right\) =>/);
  assert.match(normalizeSource, /policyPlanRoleOrder\(left\.role\) - policyPlanRoleOrder\(right\.role\)/);
  assert.match(normalizeSource, /left\.__originalIndex - right\.__originalIndex/);
});

test('recognized plans assign first product as main and later products as riders', () => {
  const normalizeSource = componentSource('normalizePolicyPlanList', 'primaryPlanFromPolicyForm');
  const scanSource = componentSource('scanToForm', 'mergeScanToForm');
  assert.match(normalizeSource, /assignRolesByRecognizedOrder/);
  assert.match(normalizeSource, /assignRolesByRecognizedOrder \? \(index === 0 \? 'main' : 'rider'\)/);
  assert.match(scanSource, /normalizePolicyPlanList\(data\.plans,\s*String\(data\.company \|\| ''\),\s*\{\s*assignRolesByRecognizedOrder:\s*true\s*\}\)/);
});

test('entry form preserves canonical product id and clears it when product name changes', () => {
  assert.match(normalizedCustomerPolicyFormSource, /canonicalProductId: String\(plan\?\.canonicalProductId \|\| ''\)\.trim\(\)/u);
  assert.match(normalizedCustomerPolicyFormSource, /matchedProductName: productChanged \? '' : plan\.matchedProductName/u);
  assert.match(normalizedCustomerPolicyFormSource, /canonicalProductId: productChanged \? '' : plan\.canonicalProductId/u);
  assert.match(normalizedCustomerAppSource, /canonicalProductId: String\(match\.canonicalProductId \|\| ''\)\.trim\(\)/u);
  assert.match(normalizedCustomerAppSource, /canonicalProductId: String\(suggestion\.canonicalProductId \|\| ''\)\.trim\(\)/u);
});

test('entry form captures insured birthday for age-based reports', () => {
  const formSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(formSource, /被保险人生日/);
  assert.match(formSource, /insuredBirthday/);
  assert.match(customerSource, /selectedFamilyPolicies/);
  assert.match(customerSource, /buildFamilyReport\(selectedFamilyPolicies,\s*familyPlanningProfile,\s*\{\s*familyId:\s*selectedFamilyId\s*\}\)/);
  assert.match(customerSource, /<FamilyCoverageOverview[\s\S]*report=\{familyReport\}[\s\S]*policies=\{policies\}/);
});

test('entry form separates legal beneficiary from beneficiary name before saving policy', () => {
  const formSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const normalizeSource = functionSource(formatterSource, 'normalizeBeneficiaryValue', 'formatBeneficiaryValue');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /beneficiary: string/);
  assert.match(normalizeSource, /继本人/);
  assert.match(normalizeSource, /维承人/);
  assert.match(formSource, /法定受益人/);
  assert.match(formSource, /type="checkbox"/);
  assert.match(formSource, /checked=\{formData\.beneficiary === '法定'\}/);
  assert.match(formSource, /onUpdateForm\('beneficiary', event\.target\.checked \? '法定' : ''\)/);
  assert.match(formSource, /label="受益人姓名"/);
});

test('family overview prefers local product indicators over raw OCR responsibility years', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const overviewBuilderSource = normalizedCustomerAppSource.slice(
    normalizedCustomerAppSource.indexOf('function parseAmountFromText'),
    normalizedCustomerAppSource.indexOf('type PolicyUploadSource'),
  );
  assert.match(apiSource, /coverageIndicators/);
  assert.match(overviewBuilderSource, /indicator\.productName/);
  assert.match(overviewBuilderSource, /formatCoverageIndicator/);
  assert.doesNotMatch(overviewBuilderSource, /\\d\{4,\}/);
});

test('family overview treats annuity payouts as cashflow instead of cash value table prerequisites', () => {
  const overviewBuilderSource = normalizedCustomerAppSource.slice(
    normalizedCustomerAppSource.indexOf('function parseAmountFromText'),
    normalizedCustomerAppSource.indexOf('type PolicyUploadSource'),
  );
  assert.match(overviewBuilderSource, /isCashflowPayoutIndicator/);
  assert.match(overviewBuilderSource, /生存保险金/);
  assert.match(overviewBuilderSource, /养老年金/);
  assert.match(overviewBuilderSource, /满期生存保险金/);
  assert.match(overviewBuilderSource, /resolveIndicatorAmount/);
  assert.doesNotMatch(overviewBuilderSource, /缺少现金价值表/);
});

test('family overview substitutes policy amounts into indicator formulas', () => {
  const overviewBuilderSource = normalizedCustomerAppSource.slice(
    normalizedCustomerAppSource.indexOf('function parseAmountFromText'),
    normalizedCustomerAppSource.indexOf('type PolicyUploadSource'),
  );
  assert.match(overviewBuilderSource, /indicatorCoreText/);
  assert.match(overviewBuilderSource, /isNonPayoutCashflowIndicator/);
  assert.match(overviewBuilderSource, /resolveIndicatorAmount/);
  assert.match(overviewBuilderSource, /formatIndicatorCalculation/);
  assert.match(overviewBuilderSource, /基本保额 × 倍数/);
  assert.match(overviewBuilderSource, /基本保额 × 比例/);
  assert.match(overviewBuilderSource, /基本保额 = /);
  assert.match(overviewBuilderSource, /年交保费 × 缴费年期/);
  assert.match(overviewBuilderSource, /实际交纳保险费/);
  assert.match(overviewBuilderSource, /领取起始年龄|开始领取年龄/);
});

test('responsibility assistant floats at the bottom right of the screen', () => {
  const source = componentSource('ResponsibilityAssistant', null);
  assert.match(source, /fixed bottom-6 right-4/);
  assert.match(source, /sm:right-6/);
  assert.match(source, /输入保险名称查责任/);
  assert.match(source, /保险公司候选/);
  assert.match(source, /保险产品候选/);
  assert.match(source, /renderHighlightedSuggestion/);
  assert.doesNotMatch(source, /bottom-28|sm:bottom-6/);
});

test('pdf export uses a dedicated A4 report layout instead of mobile card cloning', () => {
  const reportSource = functionSource(reportExportSource, 'createPrintableReportNode', 'createPdfRenderTarget');
  const renderSource = functionSource(reportExportSource, 'createPdfRenderTarget', 'escapeHtml');
  assert.match(reportSource, /width:760px/);
  assert.match(reportSource, /保单解析报告/);
  assert.match(reportExportSource, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(renderSource, /createPrintableReportNode\(target, title, policy\)/);
  assert.doesNotMatch(reportExportSource, /function applyPdfSafeStyle/);
});

test('admin policy detail exposes policy source links', () => {
  const source = componentSource('AdminPolicyDetail', null);
  assert.match(source, /资料来源/);
  assert.match(source, /policy\.sources/);
  assert.match(source, /href=\{source\.url\}/);
  assert.match(source, /target="_blank"/);
});

test('admin app includes official domain whitelist maintenance panel', () => {
  const adminSource = componentSource('AdminApp', 'AdminStatCard');
  const panelSource = componentSource('AdminOfficialDomainPanel', 'AdminOcrModePanel');
  const ocrPanelSource = componentSource('AdminOcrModePanel', 'AdminPolicyDetail');
  assert.match(adminSource, /AdminOfficialDomainPanel/);
  assert.match(panelSource, /保险公司官方域名/);
  assert.match(panelSource, /保存白名单/);
  assert.match(panelSource, /删除/);
  assert.match(ocrPanelSource, /本地视觉兜底/);
  assert.match(ocrPanelSource, /仅图片/);
  assert.match(ocrPanelSource, /不处理 PDF/);
});

test('customer policy detail exposes edit and delete actions through policy APIs', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const detailSource = componentSource('PolicyDetailSheet', null);
  assert.match(apiSource, /export function updatePolicy/);
  assert.match(apiSource, /method:\s*'PATCH'/);
  assert.match(apiSource, /export function deletePolicy/);
  assert.match(apiSource, /method:\s*'DELETE'/);
  assert.match(customerSource, /handleUpdatePolicy/);
  assert.match(customerSource, /handleDeletePolicy/);
  assert.match(detailSource, /Pencil/);
  assert.match(detailSource, /Trash2/);
  assert.match(detailSource, /PolicyEditDialog/);
  assert.match(detailSource, /reportRegenerating/);
});

test('customer policy detail shows applicant beneficiary and effective date', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /beneficiary\?: string/);
  assert.match(detailSource, /label="投保人"/);
  assert.match(detailSource, /policy\.applicant/);
  assert.match(detailSource, /label="受益人"/);
  assert.match(detailSource, /policy\.beneficiary/);
  assert.match(detailSource, /label="保单生效日期"/);
  assert.match(detailSource, /formatDateLabel\(policy\.date/);
});

test('customer policy detail moves coverage amount into plan details', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  const summarySource = componentSource('PolicyPlanSummary', 'SelectField');
  const infoGridStart = detailSource.indexOf('<section className="mt-4 grid grid-cols-2 gap-3">');
  const infoGridEnd = detailSource.indexOf('{cashValueSummary || onEditCashValue', infoGridStart);
  assert.notEqual(infoGridStart, -1, 'policy detail metric grid should exist');
  assert.notEqual(infoGridEnd, -1, 'policy detail cash value section should follow metric grid');
  const infoGridSource = detailSource.slice(infoGridStart, infoGridEnd);

  assert.doesNotMatch(infoGridSource, /label="年度保费"/);
  assert.doesNotMatch(infoGridSource, /label="保障额度"/);
  assert.doesNotMatch(infoGridSource, /label="保障期间"/);
  assert.match(summarySource, /险种明细/);
  assert.match(summarySource, /保额：\{formatCoverageAmount\(Number\(plan\.amount \|\| 0\)\)\}/);
});

test('customer policy cards derive validity status from coverage period', () => {
  const validitySource = fs.readFileSync(new URL('../src/policy-validity.mjs', import.meta.url), 'utf8');
  const listItemSource = componentSource('PolicyListItem', null);
  const summarySource = componentSource('PolicyPlanSummary', 'SelectField');

  assert.match(normalizedCustomerPolicyListSource, /from '\.\/policy-validity\.mjs'/);
  assert.match(validitySource, /function resolvePolicyValidityStatus|export function resolvePolicyValidityStatus/);
  assert.match(validitySource, /parseCoveragePeriodEndDate/);
  assert.match(listItemSource, /const validityStatus = resolvePolicyValidityStatus\(policy\.coveragePeriod,\s*\{\s*effectiveDate: policy\.date,\s*insuredBirthday: policy\.insuredBirthday/);
  assert.doesNotMatch(listItemSource, /<span className="rounded-full bg-\[#EBFBF1\][\s\S]*>有效<\/span>/);
  assert.match(summarySource, /const validityStatus = resolvePolicyValidityStatus\(plan\.coveragePeriod,\s*\{\s*effectiveDate/);
  assert.match(summarySource, /状态：[\s\S]*\{validityStatus\.label\}/);
  assert.match(summarySource, /policyValidityClassName\(validityStatus\.tone\)/);
});

test('customer policy detail displays responsibility official urls', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  const adminDetailSource = componentSource('AdminPolicyDetail', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /sourceUrl\?: string/);
  assert.match(apiSource, /sourceTitle\?: string/);
  assert.match(sharedReportUiSource, /function getPolicyResponsibilitySourceLinks\(policy: Policy\)/);
  assert.match(sharedReportUiSource, /policy\.sources/);
  assert.match(sharedReportUiSource, /policy\.coverageIndicators/);
  assert.match(detailSource, /getPolicyResponsibilitySourceLinks\(policy\)/);
  assert.match(detailSource, /官网地址/);
  assert.match(detailSource, /href=\{source\.url\}/);
  assert.match(detailSource, /target="_blank"/);
  assert.match(detailSource, /ExternalLink/);
  assert.match(adminDetailSource, /官网地址/);
});

test('customer entry and policy detail expose optional responsibility selection controls', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const entrySource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const analysisSource = componentSource('AnalysisReportPage', null);
  const detailSource = componentSource('PolicyDetailSheet', null);
  const reviewSource = componentSource('OptionalResponsibilityReview', 'PolicyPlanEditor');

  assert.match(apiSource, /export type OptionalResponsibility/);
  assert.match(apiSource, /selectionStatus: ResponsibilitySelectionStatus/);
  assert.match(entrySource, /optionalResponsibilities/);
  assert.match(entrySource, /OptionalResponsibilityReview/);
  assert.ok(
    entrySource.indexOf('<OptionalResponsibilityReview') < entrySource.indexOf('<PolicyPlanEditor'),
    'entry page should show main optional responsibilities before rider editor',
  );
  assert.match(entrySource, /compact/);
  assert.match(entrySource, /主险可选责任确认/);
  assert.match(entrySource, /已按主险匹配产品带出/);
  assert.match(entrySource, /onUpdateOptionalResponsibility/);
  assert.match(normalizedCustomerAppSource, /updateAnalysisOptionalResponsibility/);
  assert.match(normalizedCustomerAppSource, /handleUpdateOptionalResponsibility/);
  assert.match(analysisSource, /OptionalResponsibilityReview/);
  assert.match(analysisSource, /onUpdateOptionalResponsibility/);
  assert.match(detailSource, /policy\.optionalResponsibilities/);
  assert.match(detailSource, /onUpdateOptionalResponsibility/);
  assert.match(reviewSource, /可选责任确认/);
  assert.match(normalizedCustomerPolicyComponentsSource, /value: 'selected', label: '已投保'/);
  assert.match(normalizedCustomerPolicyComponentsSource, /value: 'not_selected', label: '未投保'/);
  assert.match(normalizedCustomerPolicyComponentsSource, /value: 'unknown', label: '不确定'/);
});

test('ocr recognition stays on entry form while carrying matched responsibility draft', () => {
  const start = normalizedCustomerAppSource.indexOf('async function recognizePreparedUpload');
  const end = normalizedCustomerAppSource.indexOf('function handleScanClick', start);
  assert.notEqual(start, -1, 'recognizePreparedUpload should exist');
  assert.notEqual(end, -1, 'handleScanClick should exist after recognizePreparedUpload');
  const recognizeSource = normalizedCustomerAppSource.slice(start, end);

  assert.match(recognizeSource, /const recognizedAnalysis = payload\.analysis \|\| null/);
  assert.match(recognizeSource, /setAnalysisDraft\(recognizedAnalysis\);\s*setShowAnalysisReport\(false\);/);
  assert.doesNotMatch(recognizeSource, /setShowAnalysisReport\(true\)/);
  assert.doesNotMatch(recognizeSource, /setShowAnalysisReport\(hasResponsibilityReportResult/);
});

test('optional responsibility review displays quantification status and selected gap warning', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const reviewSource = componentSource('OptionalResponsibilityReview', 'PolicyPlanEditor');

  assert.match(apiSource, /quantificationStatus\?: QuantificationStatus/);
  assert.match(reviewSource, /OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS\.filter\(\(option\) => option\.value !== 'unknown'\)/);
  assert.match(reviewSource, /compact \? 'grid-cols-2' : 'grid-cols-3'/);
  assert.match(reviewSource, /!compact && item\.sourceExcerpt/);
  assert.match(reviewSource, /量化状态/);
  assert.match(reviewSource, /该可选责任已确认投保，但尚未完成指标量化/);
  assert.match(reviewSource, /optionalResponsibilityQuantificationLabel/);
});

test('family report renders optional responsibility gaps', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(source, /optionalResponsibilityGaps/);
  assert.match(source, /已投保但未量化责任/);
  assert.match(source, /quantificationReason/);
});

test('family report renders household identity fields', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(source, /家庭身份/);
  assert.match(source, /投保人/);
  assert.match(source, /姓名待核对/);
  assert.match(source, /relationLabel/);
});

test('family report keeps verbose protection notes readable on mobile', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(source, /function ConditionSummary/);
  assert.match(source, /summarizeConditionText/);
  assert.match(source, /查看原文/);
  assert.match(source, /data-family-report-raw-note/);
  assert.match(source, /data-report-canvas-skip/);
  assert.match(source, /data-report-export-cards/);
  assert.match(source, /data-report-export-table/);
  assert.match(source, /md:hidden/);
  assert.match(source, /hidden md:block/);
  assert.match(source, /max-h-28 overflow-y-auto/);
});

test('admin app exposes optional responsibility quantification governance list', () => {
  const appText = normalizedAdminAppSource;
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /OptionalResponsibilityGap/);
  assert.match(apiSource, /markOptionalResponsibilityNotQuantifiable/);
  assert.match(apiSource, /reextractOptionalResponsibilities/);
  assert.match(appText, /AdminOptionalResponsibilityGapPanel/);
  assert.match(appText, /可选责任量化缺口/);
  assert.match(appText, /标记不可量化/);
  assert.match(appText, /重新拆解/);
});

test('customer policy detail can open manual cash value entry', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const detailSource = componentSource('PolicyDetailSheet', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /source\?: 'ocr' \| 'macos_vision' \| 'vision_llm' \| 'manual'/);
  assert.match(customerSource, /openManualCashValueEditor/);
  assert.match(customerSource, /startManualCashValueEntry/);
  assert.match(customerSource, /handleAddCashValueRow/);
  assert.match(customerSource, /handleRemoveCashValueRow/);
  assert.match(customerSource, /normalizeCashValueRowsForSaving/);
  assert.match(customerSource, /confirmCashValue/);
  assert.match(customerSource, /手动录入/);
  assert.match(customerSource, /添加年度/);
  assert.match(detailSource, /onEditCashValue/);
  assert.match(detailSource, /录入现金价值/);
  assert.match(detailSource, /修改现金价值/);
});

test('policy edit dialog offers insurer and product suggestions', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  assert.match(detailSource, /editCompanySuggestions/);
  assert.match(detailSource, /editProductSuggestions/);
  assert.match(detailSource, /listPolicyResponsibilityCompanySuggestions/);
  assert.match(detailSource, /listPolicyResponsibilityProductSuggestions/);
  assert.match(detailSource, /aria-label="修改保险公司候选"/);
  assert.match(detailSource, /aria-label="修改保险产品候选"/);
  assert.match(detailSource, /renderHighlightedSuggestion/);
});

test('customer app exposes family report from family cards and policy dashboard', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(normalizedCustomerAppSource, /buildFamilyReport/);
  assert.match(normalizedCustomerAppSource, /FamilyReportPage/);
  assert.match(normalizedCustomerAppSource, /function openFamilyReport\(familyId: number\)/);
  assert.match(normalizedCustomerAppSource, /onOpenReport=\{openFamilyReport\}/);
  assert.match(normalizedCustomerAppSource, /onClick=\{\(\) => setShowFamilyReport\(true\)\}/);
  assert.match(familySource, /全家总统计/);
  assert.match(familySource, /家庭保单清单/);
  assert.match(familySource, /被保人保单明细/);
  assert.match(familySource, /重疾分析/);
  assert.match(familySource, /意外分析/);
  assert.match(familySource, /财富分析/);
  assert.ok(familySource.indexOf('家庭保单清单') < familySource.indexOf('被保人保单明细'));
  assert.ok(familySource.indexOf('被保人保单明细') < familySource.indexOf('重疾分析'));
  assert.ok(familySource.indexOf('重疾分析') < familySource.indexOf('意外分析'));
  assert.ok(familySource.indexOf('意外分析') < familySource.indexOf('财富分析'));
});

test('customer app renders global policy overview report shortcut', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');

  assert.match(customerSource, /FamilyCoverageOverview/);
  assert.match(customerSource, /家庭保障分析报告/);
  assert.match(customerSource, /policyGroups\.map/);
  assert.match(customerSource, /if \(cashflowMember\)[\s\S]*<CashflowDetailPage/);
});

test('family report labels match the agreed report structure', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const attentionStart = source.indexOf('function AttentionSection');
  const attentionEnd = source.indexOf('function OptionalResponsibilityGapSection', attentionStart + 1);
  assert.notEqual(attentionStart, -1, 'AttentionSection component should exist');
  assert.notEqual(attentionEnd, -1, 'OptionalResponsibilityGapSection component should follow AttentionSection');
  const attentionSource = source.slice(attentionStart, attentionEnd);
  [
    '全家总统计',
    '家庭保单清单',
    '被保人保单明细',
    '重疾分析',
    '意外分析',
    '财富分析',
    '全家财富统计',
    '保险公司/保单号',
    '险种名称',
    '保费(元)',
    '交费期',
    '保障期',
    '生效日期',
    '保额(元)',
    '身故受益人',
    '期交总保费',
  ].forEach((label) => assert.match(source, new RegExp(escapeRegExp(label))));
  assert.match(attentionSource, /sm:grid-cols-2 lg:grid-cols-4/);
  assert.match(source, /family-report-heading/);
  assert.match(source, /family-report-kicker/);
  assert.match(source, /family-report-number/);
  assert.doesNotMatch(source, /营销落地页|立即购买|推荐产品/);
});

test('family report aggregate wealth table splits cashflow details into compact columns', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const tableStart = source.indexOf('function WealthAggregateTable');
  const tableEnd = source.indexOf('function WealthSection', tableStart + 1);

  assert.notEqual(tableStart, -1, 'WealthAggregateTable component should exist');
  assert.notEqual(tableEnd, -1, 'WealthSection component should follow the aggregate table');

  const tableSource = source.slice(tableStart, tableEnd);
  assert.match(tableSource, />年度汇总<\/span>/);
  assert.match(tableSource, />仅统计确定领取现金流<\/span>/);
  assert.match(tableSource, />左侧：年度合计<\/span>/);
  assert.match(tableSource, />右侧：现金流明细<\/span>/);
  assert.match(tableSource, /aria-label="当年现金流"/);
  assert.match(tableSource, /aria-label="累计现金流"/);
  assert.doesNotMatch(tableSource, /aria-label="总现金价值"/);
  assert.doesNotMatch(tableSource, /aria-label="总价值"/);
  assert.match(tableSource, />当年现金流<\/th>/);
  assert.match(tableSource, />累计现金流<\/th>/);
  assert.doesNotMatch(tableSource, />总现金价值<\/th>/);
  assert.doesNotMatch(tableSource, />总价值<\/th>/);
  assert.match(tableSource, />投保人<\/th>/);
  assert.match(tableSource, />产品<\/th>/);
  assert.match(tableSource, />项目<\/th>/);
  assert.match(tableSource, />现金流<\/th>/);
  assert.match(tableSource, /table-fixed/);
  assert.match(tableSource, /<colgroup>/);
  assert.match(tableSource, /row\.cumulativePayoutInflow/);
  assert.doesNotMatch(tableSource, /row\.cashValueTotal/);
  assert.doesNotMatch(tableSource, /row\.totalValue/);
  assert.match(tableSource, /detail\.policyholder/);
  assert.match(tableSource, /detail\.liability/);
  assert.match(tableSource, /detailStartTdClassName/);
  assert.match(tableSource, /border-l border-\[#CAD7E4\]/);
  assert.match(tableSource, /border-l border-blue-300/);
  assert.doesNotMatch(tableSource, /border-l-4 border-white/);
  assert.match(source, /cashflowAggregateDetails\(row\)/);
  assert.match(source, /wealthAggregateDetailRows\(row\)/);
  assert.match(source, /detail\.type === 'payout'/);
  assert.match(source, /insuranceProductKeyword\(detail\.productName\)/);
  assert.match(source, /rowSpan=\{detailRows\.length\}/);
  assert.doesNotMatch(tableSource, /现金价值明细/);
  assert.doesNotMatch(tableSource, /colSpan=\{2\}>现金流/);
  assert.doesNotMatch(tableSource, /colSpan=\{4\}>现金价值明细/);
  assert.doesNotMatch(tableSource, />右侧：现金价值明细<\/span>/);
  assert.doesNotMatch(tableSource, />年增<\/th>/);
  assert.doesNotMatch(tableSource, />累增<\/th>/);
  assert.doesNotMatch(tableSource, />领取<\/th>/);
  assert.doesNotMatch(tableSource, />累领<\/th>/);
  assert.doesNotMatch(tableSource, />现增<\/th>/);
  assert.doesNotMatch(tableSource, />现价<\/th>/);
  assert.doesNotMatch(tableSource, />总值<\/th>/);
  assert.doesNotMatch(tableSource, />现金价值<\/th>/);
  assert.doesNotMatch(tableSource, />增额<\/th>/);
  assert.doesNotMatch(tableSource, />现价\+现金流<\/span>/);
  assert.doesNotMatch(tableSource, />当年增额<\/th>/);
  assert.doesNotMatch(tableSource, />期末现价<\/th>/);
  assert.doesNotMatch(tableSource, /row\.cashValueIncrease/);
  assert.doesNotMatch(tableSource, /detail\.increase/);
  assert.doesNotMatch(tableSource, />谁<\/th>/);
  assert.doesNotMatch(tableSource, />保单年<\/th>/);
  assert.doesNotMatch(tableSource, /第\$\{detail\.policyYear\}年/);
  assert.doesNotMatch(tableSource, />保费支出<\/th>/);
  assert.doesNotMatch(tableSource, />年度净现金流<\/th>/);
  assert.doesNotMatch(tableSource, />累计净现金流<\/th>/);
  assert.doesNotMatch(tableSource, /row\.premiumOutflow/);
});

test('family report aggregate wealth is drawn inside the cash value trend chart', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  assert.match(source, /function CashValueTrendChart/);
  assert.match(source, /buildAggregateCashValueTrendSeries/);
  assert.match(source, /cashValueAggregateTrendSeriesConfig/);
  assert.match(source, /data-cash-value-trend-chart/);
  assert.match(source, /aria-label="现金价值与现金流趋势对比图"/);
  assert.match(source, /label: '现金流'/);
  assert.match(source, /label: '累计现金流'/);
  assert.match(source, /meta: '当年领取现金流'/);
  assert.match(source, /meta: '累计领取现金流'/);
  assert.match(source, /key: 'payoutInflow'/);
  assert.match(source, /key: 'cumulativePayoutInflow'/);
  assert.match(source, /'#1D4ED8', '#BE123C', '#7C3AED', '#0E7490'/);
  assert.match(source, /color: '#EA580C', strokeWidth: 1\.2/);
  assert.match(source, /color: '#0F766E', strokeDasharray: '6 5', strokeWidth: 1\.2/);
  assert.doesNotMatch(source, /label: '总价值'/);
  assert.doesNotMatch(source, /label: '总现金价值'/);
  assert.match(source, /activePolicyPoints/);
  assert.match(source, /useCashflowAxis/);
  assert.match(source, /primaryYMax/);
  assert.match(source, /secondaryYMax/);
  assert.match(source, /yForSeries/);
  assert.match(source, /保单现价/);
  assert.match(source, /右轴/);
  assert.match(source, /hoverCashValuePoint/);
  assert.match(source, /data-cash-value-hover-tooltip/);
  assert.match(source, /data-cash-value-hover-x/);
  assert.match(source, /data-cash-value-hover-y/);
  assert.match(source, /onPointerMove=\{updateHoverCashValuePoint\}/);
  assert.match(source, /onPointerDown=\{\(event\) =>/);
  assert.match(source, /touchAction: 'none'/);
  assert.match(source, /当前年份对应值/);
  assert.match(source, /坐标/);
  assert.match(source, /aggregateCashValueChartXValue/);
  assert.match(source, /Date\.UTC\(row\.year, 11, 31\)/);
  assert.match(source, /\.\.\.buildAggregateCashValueTrendSeries\(report\.wealth\.aggregateRows\)/);
  assert.match(source, /kind: 'aggregate' as const/);
  assert.match(source, /hiddenCashValueSeriesIds/);
  assert.match(source, /setHiddenCashValueSeriesIds/);
  assert.match(source, /const activeSeries = series\.filter/);
  assert.match(source, /activeSeries\.map/);
  assert.match(source, /aria-pressed=\{!hidden\}/);
  assert.match(source, /onClick=\{\(\) =>/);
  assert.match(source, /next\.has\(item\.id\)/);
  assert.doesNotMatch(source, /function WealthAggregateTrendChart/);
  assert.doesNotMatch(source, /data-wealth-aggregate-trend-chart/);
  assert.doesNotMatch(source, /<WealthAggregateTrendChart/);
  assert.match(source, /<WealthAggregateTable rows=\{report\.wealth\.aggregateRows\} \/>/);
  assert.doesNotMatch(cssSource, /data-wealth-aggregate-trend-chart/);
  assert.match(cssSource, /svg:not\(\[data-cash-value-trend-chart\]\)/);
});

test('family report wealth section shows cash value in each policy table and keeps the trend chart', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(source, /function PolicyAnnualCashflowTable/);
  assert.match(source, /个人现金流明细/);
  assert.match(source, /领取金额/);
  assert.match(source, /累计领取/);
  assert.match(source, /function CashValueTrendChart/);
  assert.match(source, /buildCashValueTrendSeries/);
  assert.match(source, /aria-label="现金价值与现金流趋势对比图"/);
  assert.match(source, /data-cash-value-trend-chart/);
  assert.match(source, /现金价值趋势/);
  assert.match(source, /现金价值/);
  assert.match(source, /row\.cashValueTime/);
  assert.match(source, /formatCashValueTimeTick/);
  assert.match(source, /现金价值与现金流趋势对比图/);
  assert.match(source, />时间</);
  assert.match(source, /缺第1-/);
  assert.match(source, /strokeWidth=\{item\.strokeWidth \?\? 1\.1\}/);
  assert.match(source, /type="button"/);
  assert.match(source, /aria-label=\{`\$\{hidden \? '显示' : '隐藏'\}\$\{item\.label\}折线`\}/);
  assert.doesNotMatch(source, /r=\{index === item\.rows\.length - 1 \? 2\.8 : 1\.7\}/);
  assert.doesNotMatch(source, /<circle/);
  assert.match(source, /<CashValueTrendChart report=\{report\} \/>/);
  assert.match(source, /<PolicyAnnualCashflowTable policy=\{policy\} \/>/);
  const policyCardStart = source.indexOf('function WealthPolicyCard');
  const policyCardEnd = source.indexOf('export function FamilyReportPage', policyCardStart + 1);
  const policyTableStart = source.indexOf('function PolicyAnnualCashflowTable');
  const policyTableEnd = source.indexOf('function WealthPolicyCard', policyTableStart + 1);
  assert.notEqual(policyCardStart, -1, 'WealthPolicyCard component should exist');
  assert.notEqual(policyCardEnd, -1, 'FamilyReportPage component should exist');
  assert.notEqual(policyTableStart, -1, 'PolicyAnnualCashflowTable component should exist');
  assert.notEqual(policyTableEnd, -1, 'WealthPolicyCard component should follow the cashflow table');
  const policyCardSource = source.slice(policyCardStart, policyCardEnd);
  const policyTableSource = source.slice(policyTableStart, policyTableEnd);
  assert.doesNotMatch(policyCardSource, /CashValueTrendChart/);
  assert.doesNotMatch(policyCardSource, /CashValueLineChart/);
  assert.match(policyTableSource, />现金价值参考<\/th>/);
  assert.doesNotMatch(policyTableSource, /期满前参考/);
  assert.doesNotMatch(policyTableSource, /终止前参考/);
  assert.doesNotMatch(policyTableSource, /退保参考/);
  assert.doesNotMatch(policyTableSource, /现金价值为退保参考/);
  assert.match(policyTableSource, /现金价值不等同于当年可直接领取金额/);
  assert.match(policyTableSource, /合同终止型给付发生后，现金价值不再保留/);
  assert.match(policyTableSource, /row\.cashValue != null/);
  assert.doesNotMatch(source, /function CashValueLineChart/);
  assert.doesNotMatch(source, /return row\.policyYear;/);
  assert.doesNotMatch(source, /row\.calendarYear > 0 \? row\.calendarYear : row\.policyYear/);
  assert.doesNotMatch(source, /fill="#FFFFFF"[\s\S]{0,120}stroke=\{item\.color\}/);
});

test('family report wealth section explains dividend and universal account statistics scope', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const typeSource = fs.readFileSync(new URL('../src/family-report-engine.d.mts', import.meta.url), 'utf8');
  const engineSource = fs.readFileSync(new URL('../src/family-report-engine.mjs', import.meta.url), 'utf8');

  assert.match(engineSource, /wealthUncertaintyItems/);
  assert.match(engineSource, /分红\/红利/);
  assert.match(engineSource, /万能账户/);
  assert.match(engineSource, /当前财富统计仅包含已识别的确定领取现金流/);
  assert.match(familySource, /统计口径/);
  assert.match(familySource, /report\.wealth\.statisticsScopeNote/);
  assert.match(familySource, /report\.wealth\.excludedPolicies/);
  assert.match(familySource, /不确定未计入/);
  assert.match(familySource, /已排除\{uncertaintyLabels\}不确定金额/);
  assert.match(familySource, /仅统计确定领取现金流/);
  assert.match(familySource, /未计入 \{excludedCount\} 张/);
  assert.match(typeSource, /FamilyWealthUncertaintyItem/);
  assert.match(typeSource, /excludedPolicies: FamilyWealthExcludedPolicy\[\]/);
  assert.match(typeSource, /statisticsScopeNote: string/);
});

test('family report renders amount-based radar sections in the agreed order without chart dependencies', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const packageSource = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');

  assert.match(familySource, /\bRadarChart\b/);
  assert.match(familySource, /<svg\b/);
  assert.match(familySource, /role="img"/);
  assert.match(familySource, /aria-label/);
  assert.match(familySource, /全家保障均衡雷达/);
  assert.match(familySource, /个人保障估算雷达/);
  assert.match(familySource, /个人保额结构雷达/);
  assert.match(familySource, /按有效金额压缩比例绘制/);
  assert.match(familySource, /按家庭目标自动分摊到成员/);
  assert.match(familySource, /客户未录入家庭目标时/);
  assert.match(familySource, /Calculator/);
  assert.match(familySource, /怎么算/);
  assert.match(familySource, /金额计算方法/);
  assert.match(familySource, /全家金额和雷达值怎么算/);
  assert.match(familySource, /RadarCalculationDetails/);
  assert.match(familySource, /score\.amountDetails/);
  assert.match(familySource, /radarAmountPolicyTitle/);
  assert.match(familySource, /责任：/);
  assert.match(familySource, /inactive/);
  assert.match(familySource, /失效/);
  assert.match(familySource, /bg-red-50 text-red-700 ring-red-100/);
  assert.match(familySource, /calculationRowsForScore/);
  assert.match(familySource, /按有效保障 \/ 系统估算目标计算/);
  assert.match(familySource, /避免高额责任压低其他维度/);
  assert.match(familySource, /function radarScoreSummary/);
  assert.match(familySource, /radarScoreSummary\(score\)/);
  assert.match(familySource, /FamilyPlanningProfilePanel/);
  assert.match(familySource, /保障规划版/);
  assert.match(familySource, /保额结构版/);
  assert.match(familySource, /家庭年支出/);
  assert.match(familySource, /onPlanningProfileChange/);
  assert.match(normalizedCustomerAppSource, /FAMILY_PLANNING_PROFILE_KEY/);
  assert.match(normalizedCustomerAppSource, /buildFamilyReport\(selectedFamilyPolicies,\s*familyPlanningProfile,\s*\{\s*familyId:\s*selectedFamilyId\s*\}\)/);
  assert.match(familySource, /<FamilyRadarSection report=\{report\} \/>/);
  assert.match(familySource, /<MemberRadarSection report=\{report\} \/>/);
  assert.match(familySource, /memberRadarGridStyle/);
  assert.match(familySource, /gridTemplateColumns: 'repeat\(auto-fit, minmax\(min\(100%, 540px\), 1fr\)\)'/);
  assert.match(familySource, /style=\{memberRadarGridStyle\}/);
  assert.match(familySource, /gridColumn: '1 \/ -1'/);
  const memberRadarSectionStart = familySource.indexOf('function MemberRadarSection');
  const memberRadarSectionEnd = familySource.indexOf('function InventorySection', memberRadarSectionStart + 1);
  assert.notEqual(memberRadarSectionStart, -1, 'MemberRadarSection should exist');
  assert.notEqual(memberRadarSectionEnd, -1, 'InventorySection should follow MemberRadarSection');
  const memberRadarSectionSource = familySource.slice(memberRadarSectionStart, memberRadarSectionEnd);
  assert.doesNotMatch(memberRadarSectionSource, /lg:grid-cols-2/);
  const familyRadarIndex = familySource.indexOf('<FamilyRadarSection report={report} />');
  const inventoryIndex = familySource.indexOf('<InventorySection rows={report.policyInventory.rows} />');
  const memberRadarIndex = familySource.indexOf('<MemberRadarSection report={report} />');
  const insuredDetailIndex = familySource.indexOf('<InsuredPolicyDetailSection rows={report.policyInventory.rows} />');

  assert.notEqual(familyRadarIndex, -1, 'FamilyRadarSection render call should exist');
  assert.notEqual(inventoryIndex, -1, 'InventorySection render call should exist');
  assert.notEqual(memberRadarIndex, -1, 'MemberRadarSection render call should exist');
  assert.notEqual(insuredDetailIndex, -1, 'InsuredPolicyDetailSection render call should exist');
  assert.ok(
    familyRadarIndex < inventoryIndex && inventoryIndex < memberRadarIndex && memberRadarIndex < insuredDetailIndex,
    'radar sections should render in order: family radar, inventory, member radar, insured detail',
  );
  assert.doesNotMatch(packageSource, /recharts|victory|d3|chart\.js|echarts/);
});

test('family report attention items use radar dimensions instead of accident subrows', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const functionStart = familySource.indexOf('function getFamilyAttentionItems');
  const functionEnd = familySource.indexOf('function getFamilySummaryMetrics', functionStart + 1);
  assert.notEqual(functionStart, -1, 'getFamilyAttentionItems should exist');
  assert.notEqual(functionEnd, -1, 'getFamilySummaryMetrics should follow getFamilyAttentionItems');

  const attentionSource = familySource.slice(functionStart, functionEnd);
  assert.match(attentionSource, /report\.radar\.members/);
  assert.match(attentionSource, /report\.radar\.hiddenMembers/);
  assert.match(attentionSource, /score\.label/);
  assert.match(attentionSource, /score\.coveragePresent === false/);
  assert.doesNotMatch(attentionSource, /Number\(score\.amount \|\| 0\) <= 0/);
  assert.doesNotMatch(attentionSource, /report\.accident\.members/);
  assert.doesNotMatch(attentionSource, /report\.criticalIllness\.members/);
  assert.doesNotMatch(attentionSource, /report\.wealth\.memberReports/);
});

test('family report wealth policies show cashflow table with cash value and keep one trend chart', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(source, /function PolicyAnnualCashflowTable/);
  assert.match(source, /个人现金流明细/);
  assert.match(source, /领取金额/);
  assert.match(source, /累计领取/);
  assert.match(source, /function CashValueTrendChart/);
  assert.match(source, /buildCashValueTrendSeries/);
  assert.match(source, /aria-label="现金价值与现金流趋势对比图"/);
  assert.match(source, /data-cash-value-trend-chart/);
  assert.match(source, /现金价值趋势/);
  assert.match(source, /现金价值/);
  assert.match(source, /row\.cashValueTime/);
  assert.match(source, /formatCashValueTimeTick/);
  assert.match(source, /现金价值与现金流趋势对比图/);
  assert.match(source, />时间</);
  assert.match(source, /缺第1-/);
  assert.match(source, /strokeWidth=\{item\.strokeWidth \?\? 1\.1\}/);
  assert.match(source, /type="button"/);
  assert.match(source, /aria-label=\{`\$\{hidden \? '显示' : '隐藏'\}\$\{item\.label\}折线`\}/);
  assert.doesNotMatch(source, /r=\{index === item\.rows\.length - 1 \? 2\.8 : 1\.7\}/);
  assert.doesNotMatch(source, /<circle/);
  assert.match(source, /<CashValueTrendChart report=\{report\} \/>/);
  assert.match(source, /<PolicyAnnualCashflowTable policy=\{policy\} \/>/);
  const policyCardStart = source.indexOf('function WealthPolicyCard');
  const policyCardEnd = source.indexOf('export function FamilyReportPage', policyCardStart + 1);
  const policyTableStart = source.indexOf('function PolicyAnnualCashflowTable');
  const policyTableEnd = source.indexOf('function WealthPolicyCard', policyTableStart + 1);
  assert.notEqual(policyCardStart, -1, 'WealthPolicyCard component should exist');
  assert.notEqual(policyCardEnd, -1, 'FamilyReportPage component should exist');
  assert.notEqual(policyTableStart, -1, 'PolicyAnnualCashflowTable component should exist');
  assert.notEqual(policyTableEnd, -1, 'WealthPolicyCard component should follow the cashflow table');
  const policyCardSource = source.slice(policyCardStart, policyCardEnd);
  const policyTableSource = source.slice(policyTableStart, policyTableEnd);
  assert.doesNotMatch(policyCardSource, /CashValueTrendChart/);
  assert.doesNotMatch(policyCardSource, /CashValueLineChart/);
  assert.match(policyTableSource, />现金价值参考<\/th>/);
  assert.doesNotMatch(policyTableSource, /期满前参考/);
  assert.doesNotMatch(policyTableSource, /终止前参考/);
  assert.doesNotMatch(policyTableSource, /退保参考/);
  assert.doesNotMatch(policyTableSource, /现金价值为退保参考/);
  assert.match(policyTableSource, /现金价值不等同于当年可直接领取金额/);
  assert.match(policyTableSource, /合同终止型给付发生后，现金价值不再保留/);
  assert.match(policyTableSource, /row\.cashValue != null/);
  assert.doesNotMatch(source, /function CashValueLineChart/);
  assert.doesNotMatch(source, /return row\.policyYear;/);
  assert.doesNotMatch(source, /row\.calendarYear > 0 \? row\.calendarYear : row\.policyYear/);
  assert.doesNotMatch(source, /fill="#FFFFFF"[\s\S]{0,120}stroke=\{item\.color\}/);
});

test('family report export downloads a page-styled image instead of paginated pdf', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(reportExportSource, /type ReportExportOptions = \{ rawTarget\?: boolean; preservePageStyle\?: boolean; matchScreenStyle\?: boolean \}/);
  assert.match(reportExportSource, /rawTarget: true/);
  assert.match(reportExportSource, /matchScreenStyle: true/);
  assert.match(normalizedCustomerAppSource, /downloadReportImage\(target,\s*title/);
  assert.match(reportExportSource, /captureReportImageCanvas\(imageTarget,\s*fileName/);
  assert.match(reportExportSource, /exportScreenStyledReportImageInCurrentPage\(imageTarget,\s*fileName/);
  assert.match(reportExportSource, /await import\('html-to-image'\)/);
  assert.match(reportExportSource, /toCanvas\(renderTarget\.node/);
  assert.match(reportExportSource, /isWeChatBrowser\(\)/);
  assert.match(reportExportSource, /isWeChatMiniProgramWebView\(\)/);
  assert.match(reportExportSource, /MiniProgram\|miniProgram/);
  assert.match(reportExportSource, /triggerImageBlobDownload\(imageBlob,\s*fileName\)/);
  assert.match(reportExportSource, /link\.download = `\$\{fileName\}\.jpg`/);
  const imageExportSource = functionSource(reportExportSource, 'downloadReportImage', null);
  const imageCaptureSource = functionSource(reportExportSource, 'captureReportImageCanvas', 'downloadReportPdf');
  assert.doesNotMatch(imageExportSource, /exportCurrentReportAsPdf/);
  assert.doesNotMatch(imageExportSource, /renderReportToLongImage/);
  assert.doesNotMatch(imageExportSource, /new jsPDF/);
  assert.doesNotMatch(imageExportSource, /PDF/);
  assert.doesNotMatch(imageExportSource, /document\.body\.classList\.add\('pdf-page-style-export-mode'\)/);
  assert.doesNotMatch(imageCaptureSource, /html2canvas/);
  assert.match(imageCaptureSource, /pixelRatio:\s*getPdfRenderScale\(\)/);
  assert.match(imageCaptureSource, /skipFonts:\s*true/);
  assert.match(imageCaptureSource, /createPdfRenderTarget\(target,\s*_title,\s*undefined,\s*\{ rawTarget: true,\s*matchScreenStyle: true \}\)/);
  assert.match(imageCaptureSource, /margin:\s*'0'/);
  assert.match(imageCaptureSource, /renderTarget\?\.cleanup\(\)/);
  assert.match(reportExportSource, /max-width:min\(1180px,calc\(100vw - 28px\)\)/);
  assert.match(reportExportSource, /reportNode\.classList\?\.add\?\.\('print-policy-report'\)/);
  assert.match(reportExportSource, /createPdfRenderTarget\(target,\s*fileName,\s*policy,\s*options\)/);
  assert.match(familySource, /family-report-content print-policy-report/);
  assert.match(familySource, /aria-label="下载报告图片"/);
  assert.match(familySource, /title="下载报告图片"/);
});

test('family report export keeps page styling and still supports safe pdf capture', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  assert.match(familySource, /data-pdf-table-wrap/);
  assert.match(reportExportSource, /prepareScreenStyleReportNode\(reportNode,\s*width,\s*backgroundColor\)/);
  assert.match(reportExportSource, /family-report-screen-export-target/);
  assert.match(reportExportSource, /getScreenStyleReportBackground\(target\)/);
  assert.match(reportExportSource, /convertCssOklchToRgb/);
  assert.match(reportExportSource, /normalizeCanvasColorValues\(reportNode\)/);
  assert.match(reportExportSource, /reportNode\.style\.margin = '0'/);
  assert.match(reportExportSource, /reportNode\.style\.marginLeft = '0'/);
  assert.match(reportExportSource, /reportNode\.style\.marginRight = '0'/);
  assert.match(reportExportSource, /preparePageStyleReportNode\(reportNode,\s*width\)/);
  assert.match(reportExportSource, /family-report-pdf-target/);
  assert.match(reportExportSource, /html2canvas-safe-export/);
  assert.match(reportExportSource, /\[data-family-report-raw-note\], \[data-report-canvas-skip\], \[data-report-export-table\]/);
  assert.match(reportExportSource, /node\.remove\(\)/);
  assert.match(reportExportSource, /querySelectorAll<HTMLElement>\('\[data-report-export-cards\]'\)/);
  assert.match(reportExportSource, /classList\.remove\('hidden', 'md:hidden'\)/);
  assert.match(reportExportSource, /setProperty\('display', 'block', 'important'\)/);
  assert.match(reportExportSource, /querySelectorAll<HTMLElement>\('\[data-pdf-table-wrap\]'\)/);
  assert.match(reportExportSource, /compactReportCanvasText/);
  assert.match(reportExportSource, /\[data-family-report-raw-note\], \[data-report-canvas-skip\]/);
  assert.match(reportExportSource, /captureWidth: options\?\.matchScreenStyle \|\| options\?\.preservePageStyle \? width/);
  assert.match(reportExportSource, /new jsPDF\(options\?\.preservePageStyle \? 'l' : 'p'/);
  assert.match(cssSource, /\.pdf-page-style-export-mode \.html2canvas-safe-export/);
  assert.match(cssSource, /background-color:\s*transparent !important/);
  assert.match(cssSource, /svg:not\(\[data-cash-value-trend-chart\]\)/);
  assert.match(cssSource, /\[data-family-report-raw-note\]/);
  assert.match(cssSource, /\[data-report-export-cards\]/);
  assert.match(cssSource, /\[data-report-export-table\]/);
  assert.match(cssSource, /\.pdf-page-style-export-mode \.family-report-pdf-target \[data-pdf-table-wrap\]/);
  assert.match(cssSource, /overflow:\s*visible !important/);
  assert.match(cssSource, /max-width:\s*100% !important/);
  assert.match(cssSource, /table-layout:\s*fixed !important/);
  assert.match(cssSource, /white-space:\s*normal !important/);
  assert.match(cssSource, /print-color-adjust:\s*exact/);
  assert.match(cssSource, /\.family-report-content/);
  assert.match(cssSource, /width:\s*min\(1180px, calc\(100% - 32px\)\)/);
  assert.match(cssSource, /overflow-x:\s*hidden/);
  assert.match(cssSource, /--family-report-font-sans:/);
  assert.match(cssSource, /--family-report-font-display:/);
  assert.match(cssSource, /--family-report-font-number:/);
  assert.match(cssSource, /\.family-report-shell \.font-black/);
  assert.match(cssSource, /\.family-report-number/);
  assert.match(cssSource, /font-variant-numeric:\s*tabular-nums/);
});

test('client API exposes family profile types and endpoints', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /export type FamilyProfile/);
  assert.match(apiSource, /export type FamilyMember/);
  assert.match(apiSource, /\|\s*'child'/);
  assert.match(apiSource, /listFamilyProfiles/);
  assert.match(apiSource, /request<\{ ok: true; families: FamilyProfile\[\] \}>/);
  assert.doesNotMatch(apiSource, /request<\{ ok: true; familyProfiles: FamilyProfile\[\] \}>/);
  assert.match(apiSource, /createFamilyProfile/);
  assert.match(apiSource, /createFamilyMember/);
  assert.match(apiSource, /updateFamilyMemberRelation/);
  assert.match(apiSource, /ensureDefaultFamilyProfile/);
  assert.match(apiSource, /familyId\?: number/);
  assert.match(apiSource, /applicantMemberId\?: number/);
  assert.match(apiSource, /insuredMemberId\?: number/);
});

test('deleting a rider does not force-refresh optional responsibilities when main product is unchanged', () => {
  const source = `${normalizedCustomerPolicyFormSource}\n${normalizedCustomerAppSource}`;

  assert.match(source, /function mainProductIdentityKey\(/u);
  assert.match(source, /const beforeMainProductKey = mainProductIdentityKey\(formData\)/u);
  assert.match(source, /const afterMainProductKey = mainProductIdentityKey\(nextData\)/u);
  assert.match(source, /if \(beforeMainProductKey !== afterMainProductKey\)/u);
  assert.match(source, /canonicalProductId: primary\?\.canonicalProductId \|\| ''/u);
  assert.doesNotMatch(source, /primary\?\.canonicalProductId \|\| form\.canonicalProductId/u);
  assert.doesNotMatch(source, /primary\?\.canonicalProductId \|\| formData\.canonicalProductId/u);
  assert.doesNotMatch(source, /canonicalProductId: primary\.canonicalProductId \|\| formData\.canonicalProductId/u);
  assert.doesNotMatch(source, /已删除附加险，正在重新带出可选责任['"`]\);\s*void loadFormProductAnalysisDraft\(nextData/u);
});

test('policy save keeps existing core when another scanned member relation is recognized as self', () => {
  const source = normalizedCustomerAppSource;

  assert.match(source, /!submitFamily\.coreMemberId && applicantShouldBeCore && insuredShouldBeCore/u);
  assert.match(source, /const shouldPersistAsCore = \(member: FamilyMember, relationLabel: string\) => \(/u);
  assert.match(source, /!submitFamily\.coreMemberId \|\| Number\(member\.id\) === Number\(submitFamily\.coreMemberId\)/u);
  assert.match(source, /return member\.relationLabel && member\.relationLabel !== '本人' \? member\.relationLabel : '待确认'/u);
  assert.match(source, /applicantRelation: applicantFinalRelation/u);
  assert.match(source, /insuredRelation: insuredFinalRelation/u);
});
