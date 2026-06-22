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
const familyCreateDialogSource = fs.readFileSync(new URL('../src/features/family-profile/CreateFamilyProfileDialog.tsx', import.meta.url), 'utf8');
const policyEntrySource = fs.readFileSync(new URL('../src/features/policy-entry/UploadPolicyPage.tsx', import.meta.url), 'utf8');
const policyDetailSource = fs.readFileSync(new URL('../src/features/policy-detail/PolicyDetailSheet.tsx', import.meta.url), 'utf8');
const responsibilityAssistantSource = fs.readFileSync(new URL('../src/features/responsibility-assistant/ResponsibilityAssistant.tsx', import.meta.url), 'utf8');
const policyApiSource = fs.readFileSync(new URL('../src/api/contracts/policy.ts', import.meta.url), 'utf8');
const responsibilityApiSource = fs.readFileSync(new URL('../src/api/contracts/responsibility.ts', import.meta.url), 'utf8');
const poptonicComposeSource = fs.readFileSync(new URL('../docker-compose.poptonic.yml', import.meta.url), 'utf8');

function readOptionalSource(relativePath) {
  try {
    return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

const customerAuthAccountSource = readOptionalSource('../src/features/customer-auth/CustomerAccountSheet.tsx');
const customerAuthPhoneSource = readOptionalSource('../src/features/customer-auth/PhoneVerificationDialog.tsx');
const customerNavigationSource = readOptionalSource('../src/features/customer-navigation/CustomerBottomTabs.tsx');
const customerCashflowFeatureSource = readOptionalSource('../src/features/cashflow/CashflowDetailPage.tsx');
const customerFamilyReportFeatureSource = readOptionalSource('../src/features/family-report/FamilyCoverageOverview.tsx');
const familySalesReviewMarkdownSource = readOptionalSource('../src/features/family-report/FamilySalesReviewMarkdown.tsx');
const customerFamilyPlanningStorageSource = readOptionalSource('../src/features/family-report/family-planning-storage.ts');
const customerCashValueFeatureSource = readOptionalSource('../src/features/cash-value/CashValueDialog.tsx');
const adminSharedSource = readOptionalSource('../src/features/admin-shared/AdminStatCard.tsx')
  + '\n' + readOptionalSource('../src/features/admin-shared/TextField.tsx')
  + '\n' + readOptionalSource('../src/features/admin-shared/AdminPagination.tsx')
  + '\n' + readOptionalSource('../src/features/admin-shared/fuzzyList.ts');
const adminOfficialDomainSource = readOptionalSource('../src/features/admin-official-domain/AdminOfficialDomainPanel.tsx');
const adminKnowledgeSource = readOptionalSource('../src/features/admin-knowledge/AdminKnowledgePanel.tsx');
const adminGovernanceSource = readOptionalSource('../src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx');
const adminPolicyDetailSource = readOptionalSource('../src/features/admin-policy-detail/AdminPolicyDetail.tsx');
const adminShellSource = readOptionalSource('../src/apps/admin/AdminShell.tsx');
const adminPagesSource = readOptionalSource('../src/apps/admin/adminPages.ts');
const adminUsersPageSource = readOptionalSource('../src/apps/admin/pages/AdminUsersPage.tsx');
const adminOfficialDomainsPageSource = readOptionalSource('../src/apps/admin/pages/AdminOfficialDomainsPage.tsx');
const adminOptionalResponsibilitiesPageSource = readOptionalSource('../src/apps/admin/pages/AdminOptionalResponsibilitiesPage.tsx');
const adminReportIssuesPageSource = readOptionalSource('../src/apps/admin/pages/AdminReportIssuesPage.tsx');
const adminFamilyReportPageSource = readOptionalSource('../src/apps/admin/pages/AdminFamilyReportPage.tsx');
const adminSalesReviewPageSource = readOptionalSource('../src/apps/admin/pages/AdminSalesReviewPage.tsx');
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
const normalizedFamilyCreateDialogSource = familyCreateDialogSource.replaceAll("from '../../", "from './");
const normalizedPolicyEntrySource = policyEntrySource.replaceAll("from '../../", "from './");
const normalizedPolicyDetailSource = policyDetailSource.replaceAll("from '../../", "from './");
const normalizedResponsibilityAssistantSource = responsibilityAssistantSource.replaceAll("from '../../", "from './");
const normalizedCustomerFeatureSource = [
  customerAuthAccountSource,
  customerAuthPhoneSource,
  customerNavigationSource,
  customerCashflowFeatureSource,
  customerFamilyReportFeatureSource,
  customerCashValueFeatureSource,
].join('\n').replaceAll("from '../../", "from './");
const normalizedAdminFeatureSource = [
  adminSharedSource,
  adminOfficialDomainSource,
  adminKnowledgeSource,
  adminGovernanceSource,
  adminPolicyDetailSource,
].join('\n').replaceAll("from '../../", "from './");
const extractedFeatureSourceByComponent = new Map([
  ['CustomerAccountSheet', customerAuthAccountSource.replaceAll("from '../../", "from './")],
  ['PhoneVerificationDialog', customerAuthPhoneSource.replaceAll("from '../../", "from './")],
  ['CustomerBottomTabs', customerNavigationSource.replaceAll("from '../../", "from './")],
  ['AdminOfficialDomainPanel', adminOfficialDomainSource.replaceAll("from '../../", "from './")],
  ['AdminPolicyDetail', adminPolicyDetailSource.replaceAll("from '../../", "from './")],
]);
const formatterSource = fs.readFileSync(new URL('../src/shared/formatters.ts', import.meta.url), 'utf8');
const reportExportSource = fs.readFileSync(new URL('../src/features/report-export/report-export.ts', import.meta.url), 'utf8');

test('admin backoffice shell defines grouped sidebar navigation', () => {
  assert.match(adminPagesSource, /key: 'overview'/);
  assert.match(adminPagesSource, /label: '运营总览'/);
  assert.match(adminPagesSource, /label: '保单运营'/);
  assert.match(adminPagesSource, /label: '用户'/);
  assert.doesNotMatch(adminPagesSource, /用户与被保人/);
  assert.match(adminPagesSource, /label: '报告问题'/);
  assert.match(adminPagesSource, /label: '可选责任缺口'/);
  assert.match(adminPagesSource, /label: '产品知识库'/);
  assert.match(adminPagesSource, /label: '官方域名'/);
  assert.match(adminPagesSource, /label: '会员设置'/);
  assert.match(adminPagesSource, /key: 'familyReport', label: '家庭报告'/);
  assert.match(adminPagesSource, /key: 'salesReview', label: '销售建议'/);
  assert.doesNotMatch(adminPagesSource.match(/export const ADMIN_PAGE_GROUPS[\s\S]*?export const ADMIN_PAGE_META/u)?.[0] || '', /key: 'familyReport'/);
  assert.doesNotMatch(adminPagesSource.match(/export const ADMIN_PAGE_GROUPS[\s\S]*?export const ADMIN_PAGE_META/u)?.[0] || '', /key: 'salesReview'/);
  assert.match(adminShellSource, /aside/);
  assert.match(adminShellSource, /退出/);
  assert.match(adminShellSource, /刷新/);
});

test('admin users page is read-only and uses user label', () => {
  assert.match(adminUsersPageSource, /用户列表/);
  assert.match(adminUsersPageSource, /家庭列表/);
  assert.match(adminUsersPageSource, /家庭报告/);
  assert.doesNotMatch(adminUsersPageSource, /查看报告/);
  assert.match(adminUsersPageSource, /家庭保单/);
  assert.match(adminUsersPageSource, /销售建议/);
  assert.doesNotMatch(adminUsersPageSource, /录入保单/);
  assert.doesNotMatch(adminUsersPageSource, /录入第一张保单/);
  assert.doesNotMatch(adminUsersPageSource, /编辑家庭/);
  assert.doesNotMatch(adminUsersPageSource, /删除家庭/);
  assert.doesNotMatch(adminUsersPageSource, /新建家庭/);
});

test('admin family report page reuses family policy report read-only', () => {
  assert.match(normalizedAdminAppSource, /getAdminFamilyReport/);
  assert.match(normalizedAdminAppSource, /createAdminFamilyReport/);
  assert.match(normalizedAdminAppSource, /changeAdminPage\('familyReport'\)/);
  assert.match(normalizedAdminAppSource, /<AdminFamilyReportPage/);
  assert.match(adminFamilyReportPageSource, /FamilyReportPage/);
  assert.match(adminFamilyReportPageSource, /家庭保单分析报告/);
  assert.match(adminFamilyReportPageSource, /暂无已保存家庭保单分析报告/);
  assert.match(adminFamilyReportPageSource, /生成家庭保单分析报告/);
  assert.match(adminFamilyReportPageSource, /onGenerate/);
  assert.match(adminFamilyReportPageSource, /readOnly/);
  assert.doesNotMatch(adminFamilyReportPageSource, /onRegenerate/);
});

test('admin sales review page is read-only and reuses customer markdown renderer', () => {
  assert.match(adminSalesReviewPageSource, /FamilySalesReviewMarkdown/);
  assert.match(adminSalesReviewPageSource, /只读查看已保存的销售建议/);
  assert.match(adminSalesReviewPageSource, /暂无已保存销售建议/);
  assert.doesNotMatch(adminSalesReviewPageSource, /重新生成专家报告/);
  assert.doesNotMatch(adminSalesReviewPageSource, /createFamilySalesReview/);
  assert.doesNotMatch(adminSalesReviewPageSource, /下载报告/);
});

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} component should exist`);
  if (nextName && end === -1 && !(name === 'CustomerApp' && nextName === 'FamilyCoverageOverview')) {
    assert.notEqual(end, -1, `${nextName} component should exist`);
  }
  return source.slice(start, end === -1 ? source.length : end);
}

function owningSource(name) {
  const marker = `function ${name}`;
  if (normalizedCustomerAppSource.includes(marker)) return normalizedCustomerAppSource;
  if (normalizedCustomerFeatureSource.includes(marker)) return normalizedCustomerFeatureSource;
  if (normalizedFamilyProfileSource.includes(marker)) return normalizedFamilyProfileSource;
  if (normalizedPolicyEntrySource.includes(marker)) return normalizedPolicyEntrySource;
  if (normalizedPolicyDetailSource.includes(marker)) return normalizedPolicyDetailSource;
  if (normalizedResponsibilityAssistantSource.includes(marker)) return normalizedResponsibilityAssistantSource;
  if (normalizedCustomerPolicyComponentsSource.includes(marker)) return normalizedCustomerPolicyComponentsSource;
  if (normalizedCustomerPolicyListSource.includes(marker)) return normalizedCustomerPolicyListSource;
  if (normalizedCustomerPolicyFormSource.includes(marker)) return normalizedCustomerPolicyFormSource;
  if (normalizedCustomerCashValueSource.includes(marker)) return normalizedCustomerCashValueSource;
  if (normalizedAdminAppSource.includes(marker)) return normalizedAdminAppSource;
  if (normalizedAdminFeatureSource.includes(marker)) return normalizedAdminFeatureSource;
  if (sharedReportUiSource.includes(marker)) return sharedReportUiSource;
  if (appShellSource.includes(marker)) return appShellSource;
  return appShellSource;
}

function componentSource(name, nextName, source = owningSource(name)) {
  return functionSource(source, name, nextName);
}

function extractedOrBoundedComponentSource(name, fallbackNextName) {
  const marker = `function ${name}`;
  const extractedSource = extractedFeatureSourceByComponent.get(name) || '';
  if (extractedSource.includes(marker)) return componentSource(name, null, extractedSource);
  if (normalizedCustomerAppSource.includes(marker)) {
    return componentSource(name, fallbackNextName, normalizedCustomerAppSource);
  }
  if (normalizedAdminAppSource.includes(marker)) {
    return componentSource(name, fallbackNextName, normalizedAdminAppSource);
  }
  return componentSource(name, null);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('customer account sheet uses a blue account logo', () => {
  const source = extractedOrBoundedComponentSource('CustomerAccountSheet', 'PhoneVerificationDialog');
  assert.match(source, /h-12 w-12[^"]*bg-blue-500/);
});

test('customer account sheet exposes account actions and policy navigation', () => {
  const sheetSource = extractedOrBoundedComponentSource('CustomerAccountSheet', 'PhoneVerificationDialog');
  const appSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(sheetSource, /onOpenPolicies/);
  assert.match(sheetSource, /我的基本信息/);
  assert.match(sheetSource, /我的保单/);
  assert.match(sheetSource, /onClick=\{onOpenPolicies\}/);
  assert.match(sheetSource, /退出/);
  assert.match(appSource, /setShowAccountSheet\(false\);\s*setActiveTab\('families'\);/);
});

test('phone verification send-code button uses the blue primary style', () => {
  const source = extractedOrBoundedComponentSource('PhoneVerificationDialog', null);
  assert.match(source, /className="[^"]*bg-blue-500[^"]*"[\s\S]*发验证码/);
});

test('phone verification copy matches policy entry gate rules', () => {
  const source = extractedOrBoundedComponentSource('PhoneVerificationDialog', null);
  assert.match(source, /录入或上传保单前需要验证手机号；仅查询保险责任无需验证/);
  assert.doesNotMatch(source, /第一张保单可直接录入/);
  assert.doesNotMatch(source, /第二张开始需要验证手机号/);
});

test('customer policy entry gates upload and save before phone verification', () => {
  const source = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(source, /function blockPolicyEntryIfUnauthenticated/);
  assert.match(source, /handleScanClick\(\)[\s\S]*blockPolicyEntryIfUnauthenticated\('上传保单照片前需要先验证手机号'\)/);
  assert.match(source, /handleFileChange[\s\S]*blockPolicyEntryIfUnauthenticated\('上传保单照片前需要先验证手机号'\)/);
  assert.match(source, /handleGenerateAnalysis[\s\S]*blockPolicyEntryIfUnauthenticated\(\)/);
  assert.match(source, /handleSubmit\(\)[\s\S]*blockPolicyEntryIfUnauthenticated\('保存保单前需要先验证手机号'\)/);
  assert.doesNotMatch(source, /blockSecondGuestPolicyIfNeeded/);
  assert.doesNotMatch(source, /第二次录入需要手机验证码/);
});

test('customer phone verification defers policy payload loading', () => {
  const source = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(source, /register\(\{ mobile: normalizedMobile, code: normalizedCode, guestId, includePolicies: false \}\)/);
  assert.match(source, /if \(!payload\.policiesDeferred\) \{[\s\S]*setPolicies\(/);
});

test('entry form exposes local product candidates before responsibility generation', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const assistantSource = componentSource('ResponsibilityAssistant', null);
  const detailSource = componentSource('PolicyDetailSheet', null);
  const sharedSource = fs.readFileSync(new URL('../src/shared/customer-policy-components.tsx', import.meta.url), 'utf8');
  const matchPanelSource = componentSource('ProductMatchSelectPanel', 'UploadPolicyPage');
  const productSuggestionSources = [pageSource, assistantSource, detailSource, sharedSource].join('\n');
  assert.match(pageSource, /ProductMatchSelectPanel/);
  assert.match(pageSource, /onOpenFamilies/);
  assert.match(pageSource, /CustomerBottomTabs/);
  assert.match(pageSource, /activeTab="entry"/);
  assert.match(pageSource, /复制原文/);
  assert.match(pageSource, /handleCopyOcrText/);
  assert.match(pageSource, /录入保险公司候选/);
  assert.match(pageSource, /录入保险产品候选/);
  assert.match(pageSource, /formProductSuggestions/);
  assert.match(pageSource, /onSelectFormProduct/);
  assert.doesNotMatch(productSuggestionSources, /normalizeSuggestionQuery\(suggestion\.productName\) !== normalizedQuery/);
  assert.match(responsibilityApiSource, /RESPONSIBILITY_TRANSIENT_STATUSES = new Set\(\[[^\]]*530/);
  assert.match(responsibilityApiSource, /function waitForRetry/);
  assert.match(responsibilityApiSource, /function requestResponsibility/);
  assert.match(responsibilityApiSource, /matchPolicyResponsibilities[\s\S]*requestResponsibility/);
  assert.match(responsibilityApiSource, /listPolicyResponsibilityProductSuggestions[\s\S]*requestResponsibility/);
  assert.match(customerSource, /productSuggestionToKnowledgeMatch/);
  assert.match(customerSource, /listPolicyResponsibilityProductSuggestions\(\{ company, q: name, limit: 3 \}\)/);
  assert.match(matchPanelSource, /相似产品/);
  assert.match(matchPanelSource, /role="listbox"/);
});

test('poptonic compose persists the production SQLite database in the data volume', () => {
  assert.match(poptonicComposeSource, /POLICY_OCR_APP_DB_PATH:\s*\/data\/policy-ocr\.sqlite/);
  assert.match(poptonicComposeSource, /POLICY_OCR_APP_STATE_PATH:\s*\/data\/state\.json/);
  assert.match(poptonicComposeSource, /-\s*poptonic_policy_data:\/data/);
});

test('entry form surfaces OCR layout review warnings', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const contractSource = fs.readFileSync(new URL('../src/api/contracts/policy.ts', import.meta.url), 'utf8');
  assert.match(contractSource, /ocrWarnings\?: string\[\]/);
  assert.match(contractSource, /fieldConfidence\?: Record<string,/);
  assert.match(customerSource, /scanReviewMessageSuffix/);
  assert.match(customerSource, /ocrWarnings=\{scanResult\?\.ocrWarnings \|\| \[\]\}/);
  assert.match(pageSource, /部分 OCR 字段建议确认/);
  assert.match(pageSource, /ocrWarnings\.map/);
});

test('entry form requires family profile and supports top-pillar setup after OCR', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const formSource = normalizedCustomerPolicyFormSource;
  assert.match(pageSource, /家庭档案/);
  assert.match(pageSource, /新建家庭档案/);
  assert.match(pageSource, /家庭顶梁柱/);
  assert.match(pageSource, /可先保存保单，稍后再补充顶梁柱/);
  assert.match(pageSource, /家庭顶梁柱/);
  assert.match(pageSource, /与顶梁柱的关系/);
  assert.match(pageSource, /requiredFieldLabel\('保险公司'\)/);
  assert.match(pageSource, /requiredFieldLabel\('保险名称'\)/);
  assert.match(pageSource, /label="姓名"[\s\S]*required/u);
  assert.match(pageSource, /label="投保时间"[\s\S]*required/u);
  assert.match(pageSource, /birthdayKey/);
  assert.match(pageSource, /\$\{label\}生日/u);
  assert.doesNotMatch(pageSource, /label="被保险人生日"[\s\S]*required/u);
  assert.match(pageSource, /label="选择家庭档案"[\s\S]*required/u);
  assert.match(pageSource, /label="受益人姓名"[\s\S]*required/u);
  assert.match(pageSource, /label="缴费期间"[\s\S]*required/u);
  assert.match(pageSource, /label="保障期间"[\s\S]*required/u);
  assert.match(pageSource, /label="保额 \(元\)"[\s\S]*required/u);
  assert.match(pageSource, /label="首期保费 \(元\)"[\s\S]*required/u);
  assert.match(pageSource, /participantsAreSamePerson/);
  assert.match(pageSource, /areSameParticipantName\(formData\.applicant, formData\.insured\)/);
  assert.match(pageSource, /resolveSamePersonRelation/);
  assert.match(pageSource, /与投保人为同一人/);
  assert.match(pageSource, /顶梁柱身份和关系随上方同步/);
  assert.doesNotMatch(pageSource, /if \(participantsAreSamePerson\(\)\) return '本人'/);
  assert.doesNotMatch(pageSource, /disabled=\{samePerson\}/);
  assert.doesNotMatch(pageSource, /applicantRelation \|\| '本人'/);
  assert.doesNotMatch(pageSource, /samePersonRelationResetKeyRef/);
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
  assert.match(customerSource, /validatePolicyEntryForm\(submitBaseData,\s*\{/);
  assert.match(customerSource, /requireFamily: mustSelectExistingFamily/);
  assert.match(customerSource, /requireParticipantRelations: familyHasCoreMember/);
  assert.match(customerSource, /window\.alert\(message\)/);
  assert.match(customerSource, /请先补全必录项后再保存/);
  assert.match(formSource, /if \(requireFamily && !data\.familyId\) errors\.push\('选择家庭档案'\)/);
  assert.match(formSource, /requireParticipantRelations && !hasConfirmedRelation\(applicantRelation\)/);
  assert.doesNotMatch(formSource, /coreMemberId/);
  assert.match(pageSource, /updateParticipantName/);
  assert.match(pageSource, /setParticipantAsCore/);
  assert.match(pageSource, /updateParticipantRelation/);
  assert.doesNotMatch(pageSource, /participantRelation\(otherKind\) === '本人'/);
  assert.doesNotMatch(pageSource, /selectFamilyParticipantMember/);
  assert.doesNotMatch(customerSource, /input\.memberId && !input\.setAsCore/);
  assert.doesNotMatch(customerSource, /input\.setAsCore\s*\?\s*null/);
});

test('family profile entry keeps the selected family but clears stale member bindings', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(customerSource, /function startEntryForm\(options: \{ preserveSelectedFamily\?: boolean \} = \{\}\)/);
  assert.match(customerSource, /const preserveSelectedFamily = options\.preserveSelectedFamily \?\? true/);
  assert.match(customerSource, /const nextFamilyId = preserveSelectedFamily \? selectedFamilyId : null/);
  assert.match(customerSource, /setFormData\(\{\s*\.\.\.emptyForm,\s*familyId: nextFamilyId,\s*\}\)/);
  assert.match(customerSource, /onBackToEntry=\{\(\) => \{\s*startEntryForm\(\{ preserveSelectedFamily: true \}\);/);
});

test('entry form uses the effective family selection for both display and save', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(customerSource, /const entryFamilyId = formData\.familyId \?\? selectedFamilyId \?\? null/);
  assert.match(customerSource, /const entrySelectedFamilyMembers = useMemo/);
  assert.match(customerSource, /const submitBaseData = Number\(entryFamilyId \|\| 0\) && Number\(formData\.familyId \|\| 0\) !== Number\(entryFamilyId\)/);
  assert.match(customerSource, /familyId: entryFamilyId,/);
  assert.match(customerSource, /selectedFamilyId=\{entryFamilyId\}/);
  assert.match(customerSource, /if \(entrySelectedFamily\) return entrySelectedFamily/);
});

test('entry form shows a refresh prompt when the loaded client is stale', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(customerSource, /getHealthStatus/);
  assert.match(customerSource, /staleClientHealth/);
  assert.match(customerSource, /CURRENT_CLIENT_ASSET_PATH/);
  assert.match(customerSource, /clientAssetPathFromHtml/);
  assert.match(customerSource, /clientFreshness/);
  assert.match(customerSource, /serverStartedAt > clientStartedAt \+ 1000/);
  assert.match(pageSource, /页面已更新/);
  assert.match(pageSource, /你当前这个页面还是旧版本/);
  assert.doesNotMatch(pageSource, /开发环境刚刚重启过/);
  assert.match(pageSource, /刷新页面/);
  assert.match(pageSource, /staleClientDetected/);
});

test('cash value follow-up returns directly to the saved policy detail', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(customerSource, /function finishCashValueFlow/);
  assert.match(customerSource, /setShowFamilyPolicies\(false\)/);
  assert.match(customerSource, /setSelectedPolicy\(policy\)/);
  assert.match(customerSource, /finishCashValueFlow\(savedPolicy, `现金价值表已保存/);
  assert.match(customerSource, /finishCashValueFlow\(currentPolicy, '已跳过现金价值录入'\)/);
});

test('customer app exposes family profile management surface', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const familySource = componentSource('FamilyProfileManager', null);
  const familyCreateSource = normalizedFamilyCreateDialogSource;
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(customerSource, /FamilyProfileManager/);
  assert.match(customerSource, /CreateFamilyProfileDialog/);
  assert.match(customerSource, /familyCreateDialogOpen/);
  assert.match(customerSource, /updateFamilyProfile/);
  assert.match(customerSource, /deleteFamilyProfile/);
  assert.match(customerSource, /familyPolicyMemberIds/);
  assert.match(customerSource, /familyMemberPolicyRefs/);
  assert.match(customerSource, /createFamilyMemberForFamily/);
  assert.match(customerSource, /getFamilySalesReview/);
  assert.match(customerSource, /createFamilySalesReview/);
  assert.match(customerSource, /familySalesReviewPage/);
  assert.match(customerSource, /familySalesReviewReportRef/);
  assert.match(customerSource, /familySalesReviewExportTitle/);
  assert.match(customerSource, /FamilySalesReviewMarkdown/);
  assert.match(familySalesReviewMarkdownSource, /parseFamilySalesReviewMarkdown/);
  assert.match(familySalesReviewMarkdownSource, /family-sales-review-markdown/);
  assert.match(familySalesReviewMarkdownSource, /family-sales-review-table-wrap/);
  assert.match(customerSource, /familySalesReviewLoadingRef/);
  assert.match(customerSource, /setFamilySalesReviewBusy/);
  assert.match(customerSource, /家庭保障策略简报/);
  assert.match(customerSource, /公司专家分析系统/);
  assert.match(customerSource, /专家研判报告/);
  assert.match(customerSource, /下载销售建议报告/);
  assert.match(customerSource, /downloadReportImage\(familySalesReviewReportRef\.current,\s*familySalesReviewExportTitle\)/);
  assert.match(customerSource, /print-policy-report space-y-3 bg-slate-50/);
  assert.match(customerSource, /正在读取已保存的专家报告/);
  assert.match(customerSource, /暂无已保存报告，正在生成专家研判/);
  assert.match(customerSource, /专家系统仍在生成中，完成后会自动保存/);
  assert.match(customerSource, /专家研判已完成并保存/);
  assert.match(customerSource, /重新生成专家报告/);
  assert.match(customerSource, /正在生成专家报告/);
  assert.match(customerSource, /专家研判控制台/);
  assert.match(customerSource, /实时生成中/);
  assert.match(customerSource, /策略生成进度/);
  assert.match(customerSource, /familySalesReviewProgress/);
  assert.match(customerSource, /报告生成进度条/);
  assert.match(customerSource, /aria-label="专家报告生成进度"/);
  assert.match(customerSource, /role="progressbar"/);
  assert.match(customerSource, /pendingLabel: '扫描中'/);
  assert.match(customerSource, /pendingLabel: '校验中'/);
  assert.match(customerSource, /animate-spin/);
  assert.match(customerSource, /animate-bounce/);
  assert.match(customerSource, /研判信号矩阵/);
  assert.match(customerSource, /自动保存报告/);
  assert.match(customerSource, /机会建模/);
  assert.match(customerSource, /aria-busy=\{familySalesReviewLoading\}/);
  assert.doesNotMatch(customerSource, /aria-disabled=\{familySalesReviewLoading \|\| !familySalesReviewFamilyId\}/);
  assert.doesNotMatch(customerSource, /\n\s+disabled=\{familySalesReviewLoading \|\| !familySalesReviewFamilyId\}/);
  assert.doesNotMatch(customerSource, /\n\s+disabled=\{familySalesReviewLoading\}/);
  assert.match(customerSource, /返回家庭档案/);
  assert.doesNotMatch(customerSource, /正在等待 DeepSeek 返回/);
  assert.doesNotMatch(customerSource, /familySalesReview\?\.model \?/);
  assert.doesNotMatch(customerSource, /role="dialog" aria-modal="true" aria-label="家庭专家研判"/);
  assert.match(customerSource, /onOpenFamilies=\{\(\) => setActiveTab\('families'\)\}/);
  assert.match(customerSource, /<CustomerBottomTabs activeTab=\{activeTab\} onChange=\{setActiveTab\} \/>/);
  assert.match(
    customerSource,
    /<FamilyProfileManager[\s\S]*onOpenReport=\{openFamilyReport\}[\s\S]*\/>\s*<CustomerBottomTabs activeTab=\{activeTab\} onChange=\{setActiveTab\} \/>/,
  );
  assert.match(pageSource, /onOpenFamilies/);
  assert.match(familySource, /家庭列表/);
  assert.match(pageSource, /家庭档案/);
  assert.match(familyCreateSource, /role="dialog"/);
  assert.match(familyCreateSource, /家庭名称/);
  assert.match(familyCreateSource, /创建中/);
  assert.doesNotMatch(customerSource, /window\.prompt/);
  assert.doesNotMatch(familySource, /window\.prompt/);
  assert.match(pageSource, /<header[\s\S]*<h1 className="text-lg font-bold">录入保单<\/h1>[\s\S]*onClick=\{onOpenFamilies\}[\s\S]*家庭档案/);
  assert.match(pageSource, /bg-blue-50 px-3 text-sm font-black text-blue-600[\s\S]*onClick=\{onOpenFamilies\}[\s\S]*家庭档案/);
  assert.doesNotMatch(pageSource, /onOpenReport/);
  assert.doesNotMatch(pageSource, /查看报告/);
  assert.match(familySource, /成员数/);
  assert.match(familySource, /查看报告/);
  assert.match(familySource, /家庭保单/);
  assert.match(familySource, /销售建议/);
  assert.match(familySource, /onOpenSalesReview/);
  assert.match(familySource, /hasPolicies \|\| members\.length/);
  assert.match(familySource, /onViewFamilyPolicies/);
  assert.match(familySource, /管理成员/);
  assert.match(familySource, /家庭备注/);
  assert.match(familySource, /成员备注/);
  assert.match(familySource, /onUpdateFamily/);
  assert.match(familySource, /保存家庭/);
  assert.doesNotMatch(familySource, /保存名称/);
  assert.doesNotMatch(familySource, /保存备注/);
  assert.doesNotMatch(familySource, /保存成员备注/);
  assert.match(familySource, /添加成员/);
  assert.match(familySource, /成员姓名/);
  assert.match(familySource, /出生日期/);
  assert.match(familySource, /handleAddFamilyMember/);
  assert.match(familySource, /onCreateFamilyMember/);
  assert.match(familySource, /familyPolicyMemberIds/);
  assert.match(familySource, /familyMemberPolicyRefs/);
  assert.match(familySource, /policyBoundMemberIds/);
  assert.match(familySource, /保单成员/);
  assert.match(familySource, /由保单扫描生成；修改姓名、生日或关系会提示同步关联保单/);
  assert.match(familySource, /将同步以下保单/);
  assert.match(familySource, /确认并同步/);
  assert.match(familySource, /syncBoundPolicies/);
  assert.doesNotMatch(familySource, /关系请在保单详情修改/);
  assert.match(familySource, /编辑家庭/);
  assert.match(familySource, /onUpdateFamilyMember/);
  assert.match(familySource, /onDeleteFamilyMember/);
  assert.match(familySource, /handleUpdateFamilyMember/);
  assert.match(familySource, /handleDeleteFamilyMember/);
  assert.match(familySource, /确认删除成员/);
  assert.match(familySource, /删除家庭/);
  assert.match(familySource, /确认删除/);
  assert.match(familySource, /familyPolicyCounts/);
  assert.match(familySource, /const policyCount = Number\(familyPolicyCounts\[Number\(family\.id\)\] \|\| 0\)/);
  assert.match(familySource, /暂无家庭保单，可先维护成员或录入保单/);
  assert.match(familySource, /coreMember\?\.name \|\| '待设置'/);
  assert.doesNotMatch(familySource, /members\[0\]\?\.name \|\| '待设置'/);
  assert.doesNotMatch(familySource, /保单管理/);
  assert.doesNotMatch(familySource, /FamilyPolicyManagerPanel/);
  assert.match(familySource, /设为顶梁柱/);
  assert.match(familySource, /\{!core \? \([\s\S]*设为顶梁柱/);
  assert.doesNotMatch(familySource, /policyBound \? \([\s\S]*\) : !core \? \(/);
  assert.match(familySource, /onUpdateFamilyMemberRelation/);
  assert.match(familySource, /onDeleteFamily/);
  assert.match(familySource, /设置\$\{member\.name\}家庭关系/);
  assert.doesNotMatch(familySource, /window\.confirm/);
  assert.match(familySource, /录入保单/);
});

test('customer bottom tabs expose entry and family navigation only', () => {
  const source = extractedOrBoundedComponentSource('CustomerBottomTabs', 'CustomerAccountSheet');

  assert.match(source, /key: 'entry'/);
  assert.doesNotMatch(source, /key: 'policies'/);
  assert.doesNotMatch(source, /key: 'familyPolicies'/);
  assert.match(source, /key: 'families'/);
  assert.doesNotMatch(source, /我的保单/);
  assert.match(source, /家庭保单/);
  assert.doesNotMatch(source, /家庭档案/);
  assert.match(source, /grid-cols-2/);
});

test('family policy detail keeps entry and family bottom tabs visible', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const start = customerSource.indexOf('if (showFamilyPolicies)');
  const end = customerSource.indexOf("if (activeTab === 'families')", start);
  assert.notEqual(start, -1, 'family policy detail branch should exist');
  assert.notEqual(end, -1, 'family profile branch should follow family policy detail');
  const familyPolicyDetailSource = customerSource.slice(start, end);

  const tabsIndex = familyPolicyDetailSource.indexOf('<CustomerBottomTabs');
  const policyOverlayIndex = familyPolicyDetailSource.indexOf('{selectedPolicy ? (');
  assert.notEqual(tabsIndex, -1, 'family policy detail should render bottom tabs');
  assert.notEqual(policyOverlayIndex, -1, 'policy detail overlay should remain in the family policy detail branch');
  assert.match(familyPolicyDetailSource, /<CustomerBottomTabs[\s\S]*activeTab="families"/);
  assert.match(familyPolicyDetailSource, /tab === 'entry'[\s\S]*setShowFamilyPolicies\(false\)[\s\S]*startEntryForm\(\{ preserveSelectedFamily: true \}\)/);
  assert.ok(
    tabsIndex < policyOverlayIndex,
    'family policy detail tabs should stay behind the policy detail overlay',
  );
});

test('policy relation controls use top-pillar family relation options', () => {
  const source = `${normalizedCustomerPolicySharedSource}\n${normalizedPolicyDetailSource}`;

  assert.match(source, /'孙子'/u);
  assert.match(source, /'孙女'/u);
  assert.match(source, /'儿媳'/u);
  assert.match(source, /'女婿'/u);
  assert.match(source, /'外孙'/u);
  assert.match(source, /'外孙女'/u);
  assert.match(source, /'外公'/u);
  assert.match(source, /'外婆'/u);
  assert.match(source, /'爷爷'/u);
  assert.match(source, /'奶奶'/u);
  assert.match(source, /POLICY_PERSON_RELATION_OPTIONS = FAMILY_MEMBER_RELATION_OPTIONS/u);
  assert.match(source, /SelectField label="投保人与顶梁柱关系"[\s\S]*options=\{POLICY_PERSON_RELATION_OPTIONS\}/u);
  assert.match(source, /SelectField label="被保人与顶梁柱关系"[\s\S]*options=\{POLICY_PERSON_RELATION_OPTIONS\}/u);
  assert.match(source, /SelectField label="与顶梁柱的关系"[\s\S]*options=\{POLICY_PERSON_RELATION_OPTIONS\}/u);
});

test('policy period fields support common dropdown options plus manual entry', () => {
  assert.match(customerPolicyComponentsSource, /const PAYMENT_PERIOD_OPTIONS = \['趸交', '1年交', '3年交', '5年交', '10年交', '15年交', '20年交', '30年交', '交至55岁', '交至60岁', '交至65岁', '交至70岁'\]/u);
  assert.match(customerPolicyComponentsSource, /const COVERAGE_PERIOD_OPTIONS = \['1年', '20年', '30年', '至60岁', '至65岁', '至70岁', '至75岁', '至80岁', '终身'\]/u);
  assert.match(customerPolicyComponentsSource, /function PeriodField/);
  assert.match(customerPolicyComponentsSource, /list=\{listId\}/u);
  assert.match(customerPolicyComponentsSource, /<datalist id=\{listId\}>/u);
  assert.match(policyEntrySource, /<PaymentPeriodField label="缴费期间"/u);
  assert.match(policyEntrySource, /<CoveragePeriodField label="保障期间"/u);
  assert.match(policyDetailSource, /<CoveragePeriodField label="保障期间"/u);
  assert.match(policyDetailSource, /<PaymentPeriodField label="缴费期间"/u);
  assert.match(customerPolicyComponentsSource, /<CoveragePeriodField label="保障期间" value=\{String\(plan\.coveragePeriod \|\| ''\)\}/u);
  assert.match(customerPolicyComponentsSource, /<PaymentPeriodField label="缴费期间" value=\{String\(plan\.paymentPeriod \|\| ''\)\}/u);
});

test('customer app exposes family report share flow', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
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
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(pageSource, /max-w-3xl/);
  assert.match(pageSource, /保存保单/);
  assert.match(pageSource, /CustomerBottomTabs/);
  assert.match(pageSource, /if \(tab === 'families'\) onOpenFamilies\(\);/);
  assert.match(customerSource, /renderResponsibilityAssistant\('bottom-24'\)/);
  assert.match(pageSource, /onClick=\{onSubmit\}/);
  assert.match(pageSource, /disabled=\{loading\}/);
  assert.doesNotMatch(pageSource, /aria-label="进入我的保单"/);
  assert.doesNotMatch(pageSource, /确认信息后保存保单/);
});

test('cash value upload dialog shows a progress bar while scanning', () => {
  const cashValueSource = customerCashValueFeatureSource || componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(cashValueSource, /role="progressbar"/);
  assert.match(cashValueSource, /aria-valuetext="正在识别现金价值表"/);
  assert.match(cashValueSource, /现金价值表识别中/);
  assert.match(cashValueSource, /animate-\[cash-value-progress/);
});

test('cash value upload uses the system image picker without forcing direct camera capture', () => {
  const cashValueSource = customerCashValueFeatureSource || componentSource('CustomerApp', 'FamilyCoverageOverview');
  const inputRefIndex = cashValueSource.indexOf('ref={cashValueInputRef}');
  assert.notEqual(inputRefIndex, -1, 'cash value upload input should exist');
  const inputSource = cashValueSource.slice(inputRefIndex, cashValueSource.indexOf('/>', inputRefIndex));
  assert.match(cashValueSource, /本地照片上传/);
  assert.match(cashValueSource, /从本地照片或拍照上传保单的现金价值页面/);
  assert.match(inputSource, /type="file"/);
  assert.match(inputSource, /accept="image\/\*"/);
  assert.doesNotMatch(inputSource, /capture="environment"/);
});

test('policy entry upload uses the system image picker without forcing direct camera capture', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const inputRefIndex = pageSource.indexOf('ref={fileInputRef}');
  assert.notEqual(inputRefIndex, -1, 'policy entry upload input should exist');
  const inputSource = pageSource.slice(inputRefIndex, pageSource.indexOf('/>', inputRefIndex));
  assert.match(inputSource, /type="file"/);
  assert.match(inputSource, /accept="image\/\*"/);
  assert.doesNotMatch(inputSource, /capture="environment"/);
});

test('entry form keeps the add rider action visible in plan details', () => {
  const source = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  assert.match(source, /险种明细/);
  assert.match(source, /手动添加附加险/);
  assert.match(source, /w-full/);
  assert.match(source, /附加险或万能账户为可选项/);
  assert.match(source, /label="保额 \(元\)"[\s\S]*required/u);
  assert.match(source, /label="保费 \(元\)"[\s\S]*required/u);
  assert.match(source, /label="保障期间"[\s\S]*required/u);
  assert.match(source, /label="缴费期间"[\s\S]*required/u);
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

test('entry optional responsibilities are rendered under their owning plan', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const editorSource = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  const reviewSource = componentSource('OptionalResponsibilityReview', 'PolicyPlanEditor');
  const mergeSource = componentSource('mergeOptionalResponsibilityDisplayItems', 'optionalResponsibilitiesForProduct');
  const filterSource = componentSource('optionalResponsibilitiesForProduct', 'TextField');
  assert.match(pageSource, /optionalResponsibilitiesForProduct\(optionalResponsibilities,\s*formData\.name\)/);
  assert.match(pageSource, /optionalResponsibilities=\{optionalResponsibilities\}/);
  assert.match(pageSource, /onUpdateOptionalResponsibility=\{onUpdateOptionalResponsibility\}/);
  assert.match(editorSource, /optionalResponsibilitiesForProduct\(optionalResponsibilities,\s*String\(plan\.matchedProductName \|\| plan\.name \|\| ''\)\)/);
  assert.match(editorSource, /title="附加险可选责任确认"/);
  assert.match(editorSource, /onChange=\{onUpdateOptionalResponsibility\}/);
  assert.match(mergeSource, /optionalResponsibilitySemanticKey/);
  assert.match(filterSource, /mergeOptionalResponsibilityDisplayItems\(matches\)/);
  assert.match(reviewSource, /const statusOptions = OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS/);
  assert.match(reviewSource, /grid grid-cols-3 gap-2/);
  assert.doesNotMatch(reviewSource, /option\.value !== 'unknown'/);
});

test('entry rider names expose product suggestion selection', () => {
  const editorSource = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  const entrySource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(editorSource, /productSuggestionTargetIndex/);
  assert.match(editorSource, /aria-label="附加险产品候选"/);
  assert.match(editorSource, /onSelectProduct\?\.\(plan\.originalIndex, suggestion\)/);
  assert.match(editorSource, /renderHighlightedSuggestion\(suggestion\.productName, String\(plan\.name \|\| ''\)\)/);
  assert.match(entrySource, /formPlanProductSuggestionTargetIndex/);
  assert.match(entrySource, /onUpdateProductQuery=\{onUpdatePlanProductQuery\}/);
  assert.match(normalizedCustomerAppSource, /function selectPolicyPlanProduct/);
  assert.match(normalizedCustomerAppSource, /matchedProductName: name/);
});

test('manual rider editor hides role and product type fields from customers', () => {
  const editorSource = componentSource('PolicyPlanEditor', 'PolicyPlanSummary');
  assert.doesNotMatch(editorSource, /label="类型"/u);
  assert.doesNotMatch(editorSource, /label="产品分类"/u);
});

test('manual rider drafts remain visible before a name is entered', () => {
  const normalizeSource = componentSource('normalizePolicyPlanList', 'primaryPlanFromPolicyForm');
  const normalizeWithIndexSource = componentSource('normalizePolicyPlanListWithIndex', 'normalizePolicyPlanList');
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const updatePlanSource = componentSource('updatePolicyPlan', 'addPolicyPlan');
  const addPlanSource = componentSource('addPolicyPlan', 'removePolicyPlan');
  const removePlanSource = componentSource('removePolicyPlan', 'selectFormProductMatch');
  assert.match(normalizeSource, /keepEmpty/);
  assert.match(normalizeSource, /!name && !matchedProductName && !keepEmpty/);
  assert.match(normalizeWithIndexSource, /__originalIndex: index/);
  assert.match(updatePlanSource, /normalizePolicyPlanList\(formData\.plans,\s*formData\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(addPlanSource, /normalizePolicyPlanList\(current\.plans,\s*current\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(removePlanSource, /normalizePolicyPlanListWithIndex\(current\.plans,\s*current\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/);
  assert.match(removePlanSource, /find\(\(plan\) => plan\.__originalIndex === index\)/);
  assert.match(removePlanSource, /filter\(\(plan\) => plan\.__originalIndex !== index\)/);
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

test('recognized plans preserve explicit roles and only default missing roles by order', () => {
  const normalizeSource = componentSource('normalizePolicyPlanList', 'primaryPlanFromPolicyForm');
  const scanSource = componentSource('scanToForm', 'mergeScanToForm');
  assert.match(normalizeSource, /assignRolesByRecognizedOrder/);
  assert.match(normalizeSource, /assignRolesByRecognizedOrder \? \(plan\?\.role \|\| \(index === 0 \? 'main' : 'rider'\)\)/);
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
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(formSource, /\$\{label\}生日/u);
  assert.match(formSource, /insuredBirthday/);
  assert.match(formSource, /applicantBirthday/);
  assert.match(formSource, /受益人生日/);
  assert.match(formSource, /beneficiaryRelation/);
  assert.match(customerSource, /selectedFamilyPolicies/);
  assert.match(customerSource, /buildFamilyReport\(selectedFamilyPolicies,\s*familyPlanningProfile,\s*\{\s*familyId:\s*selectedFamilyId\s*\}\)/);
  assert.match(customerSource, /<FamilyCoverageOverview[\s\S]*report=\{displayFamilyReport\}[\s\S]*policies=\{selectedFamilyPolicies\}/);
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
  const source = extractedOrBoundedComponentSource('AdminPolicyDetail', null);
  assert.match(source, /资料来源/);
  assert.match(source, /policy\.sources/);
  assert.match(source, /href=\{source\.url\}/);
  assert.match(source, /target="_blank"/);
});

test('admin app includes official domain whitelist maintenance panel', () => {
  const panelSource = extractedOrBoundedComponentSource('AdminOfficialDomainPanel', 'AdminOptionalResponsibilityGapPanel');
  assert.match(normalizedAdminAppSource, /AdminOfficialDomainsPage/);
  assert.match(adminOfficialDomainsPageSource, /AdminOfficialDomainPanel/);
  assert.doesNotMatch(normalizedAdminAppSource + adminOfficialDomainsPageSource, /AdminOcrModePanel/);
  assert.match(panelSource, /保险公司官方域名/);
  assert.match(panelSource, /保存白名单/);
  assert.match(panelSource, /新增白名单/);
  assert.match(panelSource, /点击列表可编辑/);
  assert.match(panelSource, /取消/);
  assert.match(panelSource, /删除/);
  assert.match(panelSource, /const \[editing, setEditing\] = useState\(false\)/);
  assert.match(panelSource, /placeholder="保险公司名称"/);
  assert.match(panelSource, /list=\{searchListId\}/);
  assert.match(panelSource, /<datalist id=\{searchListId\}>/);
  assert.match(panelSource, /filterAdminList\(profiles, query, getOfficialDomainSearchFields\)/);
  assert.match(panelSource, /AdminPagination/);
  assert.match(panelSource, /每页 \{OFFICIAL_DOMAIN_PAGE_SIZE\} 条/);
  assert.match(panelSource, /getOfficialDomainSearchFields/);
  assert.doesNotMatch(panelSource, /max-h-\[260px\]/);
});

test('admin app does not preload full knowledge records after login', () => {
  const adminSource = componentSource('AdminApp', null);
  const adminTokenEffect = adminSource.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[adminToken\]\);/)?.[0] || '';
  assert.match(adminTokenEffect, /loadMembershipConfig\(adminToken\)[\s\S]*loadOfficialDomainProfiles\(adminToken\)[\s\S]*setTimeout/);
  assert.match(adminTokenEffect, /loadOverview\(adminToken\)/);
  assert.doesNotMatch(adminTokenEffect, /loadKnowledgeRecords\(adminToken\)/);
  assert.match(adminSource, /登录成功，正在加载会员设置/);
  assert.match(adminSource, /onRefresh=\{\(\) => void loadKnowledgeRecords\(\)\}/);
});

test('customer policy detail exposes edit and delete actions through policy APIs', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const detailSource = componentSource('PolicyDetailSheet', null);
  assert.match(apiSource, /export function updatePolicy/);
  assert.match(apiSource, /method:\s*'PATCH'/);
  assert.match(apiSource, /export function deletePolicy/);
  assert.match(apiSource, /method:\s*'DELETE'/);
  assert.match(customerSource, /handleUpdatePolicy/);
  assert.match(customerSource, /handleDeletePolicy/);
  assert.match(customerSource, /payload\.policy\.familyId \? refreshFamilyProfiles\(\) : Promise\.resolve\(\[\]\)/u);
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
  assert.match(summarySource, /const planCoveragePeriod = plan\.coveragePeriod \|\| fallbackCoveragePeriod/);
  assert.match(summarySource, /const validityStatus = resolvePolicyValidityStatus\(planCoveragePeriod,\s*\{\s*effectiveDate/);
  assert.match(summarySource, /状态：[\s\S]*\{validityStatus\.label\}/);
  assert.match(summarySource, /policyValidityClassName\(validityStatus\.tone\)/);
});

test('customer policy summary falls back to top-level periods for the main plan', () => {
  const summarySource = componentSource('PolicyPlanSummary', 'SelectField');
  const policyEntrySource = componentSource('AnalysisReportPage', null, normalizedPolicyEntrySource);
  const detailSource = componentSource('PolicyDetailSheet', null);

  assert.match(summarySource, /const fallbackCoveragePeriod = index === 0 \? coveragePeriod : ''/);
  assert.match(summarySource, /const fallbackPaymentPeriod = index === 0 \? paymentPeriod : ''/);
  assert.match(summarySource, /const planCoveragePeriod = plan\.coveragePeriod \|\| fallbackCoveragePeriod/);
  assert.match(summarySource, /const planPaymentPeriod = plan\.paymentPeriod \|\| plan\.paymentMode \|\| fallbackPaymentPeriod/);
  assert.match(policyEntrySource, /paymentPeriod=\{formData\.paymentPeriod\}/);
  assert.match(policyEntrySource, /coveragePeriod=\{formData\.coveragePeriod\}/);
  assert.match(detailSource, /paymentPeriod=\{policy\.paymentPeriod\}/);
  assert.match(detailSource, /coveragePeriod=\{policy\.coveragePeriod\}/);
});

test('customer policy detail displays responsibility official urls', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  const adminDetailSource = componentSource('AdminPolicyDetail', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /sourceUrl\?: string/);
  assert.match(apiSource, /sourceTitle\?: string/);
  assert.match(policyApiSource, /responsibilityCards\?: ResponsibilityCard\[\]/);
  assert.match(responsibilityApiSource, /export type ResponsibilityCard/u);
  assert.match(responsibilityApiSource, /export type ResponsibilityCardCategory/u);
  assert.match(responsibilityApiSource, /export type CalculationStatus/u);
  assert.match(responsibilityApiSource, /export type CashflowTreatment/u);
  assert.match(responsibilityApiSource, /export type QuantifiedIndicator/u);
  assert.match(sharedReportUiSource, /function getPolicyResponsibilitySourceLinks\(policy: Policy\)/);
  assert.match(sharedReportUiSource, /policy\.sources/);
  assert.match(sharedReportUiSource, /policy\.responsibilityCards/);
  assert.match(sharedReportUiSource, /card\.sourceUrl/);
  assert.match(sharedReportUiSource, /card\.sourceExcerpt/);
  assert.match(sharedReportUiSource, /indicator\.sourceExcerpt/);
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
  assert.match(recognizeSource, /setAnalysisDraft\(withRememberedOptionalResponsibilitySelections\(recognizedAnalysis\)\);\s*setShowAnalysisReport\(false\);/);
  assert.doesNotMatch(recognizeSource, /setShowAnalysisReport\(true\)/);
  assert.doesNotMatch(recognizeSource, /setShowAnalysisReport\(hasResponsibilityReportResult/);
});

test('optional responsibility review displays quantification status and selected gap warning', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const reviewSource = componentSource('OptionalResponsibilityReview', 'PolicyPlanEditor');

  assert.match(apiSource, /quantificationStatus\?: QuantificationStatus/);
  assert.match(reviewSource, /const statusOptions = OPTIONAL_RESPONSIBILITY_STATUS_OPTIONS/);
  assert.match(reviewSource, /grid grid-cols-3 gap-2/);
  assert.doesNotMatch(reviewSource, /option\.value !== 'unknown'/);
  assert.match(reviewSource, /const contentText = optionalResponsibilityContentText\(item\)/);
  assert.match(reviewSource, /compact \? 'line-clamp-3' : 'line-clamp-2'/);
  assert.match(reviewSource, /group-hover:line-clamp-none/);
  assert.match(reviewSource, /focus:line-clamp-none/);
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

test('family report omits household identity from inventory table', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /家庭身份/);
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
  const governanceSource = adminGovernanceSource.replaceAll("from '../../", "from './");
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /OptionalResponsibilityGap/);
  assert.match(apiSource, /markOptionalResponsibilityNotQuantifiable/);
  assert.match(apiSource, /reextractOptionalResponsibilities/);
  assert.match(normalizedAdminAppSource, /AdminOptionalResponsibilitiesPage/);
  assert.match(adminOptionalResponsibilitiesPageSource, /<AdminOptionalResponsibilityGapPanel/);
  assert.match(normalizedAdminAppSource, /onMarkNotQuantifiable=\{\(gap\) => void handleMarkOptionalNotQuantifiable\(gap\)\}/);
  assert.match(normalizedAdminAppSource, /onReextract=\{\(\) => void handleReextractOptionalResponsibilities\(\)\}/);
  assert.match(governanceSource, /可选责任量化缺口/);
  assert.match(governanceSource, /标记不可量化/);
  assert.match(governanceSource, /重新拆解/);
  assert.match(governanceSource, /type="search"/);
  assert.match(governanceSource, /list=\{searchListId\}/);
  assert.match(governanceSource, /<datalist id=\{searchListId\}>/);
  assert.match(governanceSource, /filterAdminList/);
  assert.match(governanceSource, /AdminPagination/);
  assert.match(governanceSource, /每页 \{GAP_PAGE_SIZE\} 条/);
});

test('admin knowledge and governance lists support paged fuzzy search', () => {
  assert.match(adminKnowledgeSource, /type="search"/);
  assert.match(adminKnowledgeSource, /list=\{searchListId\}/);
  assert.match(adminKnowledgeSource, /<datalist id=\{searchListId\}>/);
  assert.match(adminKnowledgeSource, /filterAdminList/);
  assert.match(adminKnowledgeSource, /AdminPagination/);
  assert.match(adminKnowledgeSource, /每页 \{KNOWLEDGE_PAGE_SIZE\} 条/);
  assert.doesNotMatch(adminKnowledgeSource, /records\.slice\(0, 30\)/);
  assert.match(adminSharedSource, /function AdminPagination/);
  assert.match(adminSharedSource, /scoreAdminFuzzyMatch/);
  assert.match(adminSharedSource, /getAdminPageWindow/);
});

test('admin report issues display DeepSeek correction labels and actions', () => {
  const apiSource = fs.readFileSync(new URL('../src/api/contracts/admin.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /rejectAdminReportCorrection/);
  assert.match(apiSource, /correctionLabel/);
  assert.match(normalizedAdminAppSource, /AdminReportIssuesPage/);
  assert.match(adminReportIssuesPageSource, /已修正/);
  assert.match(adminReportIssuesPageSource, /处理结果/);
  assert.match(adminReportIssuesPageSource, /未自动修正/);
  assert.match(adminReportIssuesPageSource, /修正记录/);
  assert.doesNotMatch(adminReportIssuesPageSource, /人工采纳并重算/);
});

test('customer policy detail can open manual cash value entry', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const cashValueSource = customerCashValueFeatureSource || customerSource;
  const detailSource = componentSource('PolicyDetailSheet', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /source\?: 'ocr' \| 'macos_vision' \| 'vision_llm' \| 'manual'/);
  assert.match(customerSource, /openManualCashValueEditor/);
  assert.match(customerSource, /startManualCashValueEntry/);
  assert.match(customerSource, /handleAddCashValueRow/);
  assert.match(customerSource, /handleRemoveCashValueRow/);
  assert.match(customerSource, /normalizeCashValueRowsForSaving/);
  assert.match(customerSource, /confirmCashValue/);
  assert.match(customerSource, /appendCashValueRowsSequentially/);
  assert.match(customerSource, /mode === 'append'/);
  assert.match(cashValueSource, /手动录入/);
  assert.match(cashValueSource, /添加年度/);
  assert.match(cashValueSource, /openCashValueUpload\('append'\)/);
  assert.match(cashValueSource, /scanResult\.source === 'manual'/);
  assert.match(cashValueSource, /cashValueInputModeRef\.current/);
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

test('policy edit dialog includes rider editing controls and plan product suggestions', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  assert.match(detailSource, /PolicyPlanEditor/);
  assert.match(detailSource, /editPlanProductSuggestions/);
  assert.match(detailSource, /editPlanProductSuggestionLoading/);
  assert.match(detailSource, /editPlanProductQuery/);
  assert.match(detailSource, /addDraftPlan/);
  assert.match(detailSource, /removeDraftPlan/);
  assert.match(detailSource, /selectDraftPlanProduct/);
  assert.match(detailSource, /onUpdateProductQuery=\{\(index, company, q\) => setEditPlanProductQuery\(\{ index, company, q \}\)\}/);
});

test('customer app exposes family report from family cards and policy dashboard', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const openFamilyReportSource = normalizedCustomerAppSource.match(/async function openFamilyReport\(familyId: number\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(normalizedCustomerAppSource, /buildFamilyReport/);
  assert.match(normalizedCustomerAppSource, /FamilyReportPage/);
  assert.match(normalizedCustomerAppSource, /getFamilyReportRecord/);
  assert.match(normalizedCustomerAppSource, /regenerateFamilyReportRecord/);
  assert.match(normalizedCustomerAppSource, /function openFamilyReport\(familyId: number\)/);
  assert.match(normalizedCustomerAppSource, /async function regenerateFamilyReport\(\)/);
  assert.match(openFamilyReportSource, /getFamilyReportRecord/);
  assert.match(openFamilyReportSource, /正在加载家庭保障分析报告/);
  assert.match(openFamilyReportSource, /暂无已保存家庭保障分析报告/);
  assert.doesNotMatch(openFamilyReportSource, /createFamilyReportRecord/);
  assert.match(normalizedCustomerAppSource, /regenerateFamilyReportRecord\(\{[\s\S]*userRefresh: true/);
  assert.match(normalizedCustomerAppSource, /createFamilySalesReview\(\{[\s\S]*familyId: familySalesReviewFamilyId,[\s\S]*userRefresh: true/);
  assert.match(normalizedCustomerAppSource, /正在重新生成家庭保障分析报告/);
  assert.match(normalizedCustomerAppSource, /DeepSeek质检已完成/);
  assert.match(normalizedCustomerAppSource, /当前为本地规则结果/);
  assert.match(normalizedCustomerAppSource, /onOpenReport=\{openFamilyReport\}/);
  assert.match(normalizedCustomerAppSource, /onClick=\{\(\) => selectedFamilyId \? void openFamilyReport\(selectedFamilyId\) : undefined\}/);
  assert.match(familySource, /onRegenerate/);
  assert.match(familySource, /重新生成家庭保障分析报告/);
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
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');

  assert.match(customerSource, /FamilyCoverageOverview/);
  assert.match(customerSource, /家庭保障分析报告/);
  assert.match(customerSource, /policyGroups\.length/);
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
  assert.match(customerFamilyPlanningStorageSource, /FAMILY_PLANNING_PROFILE_KEY/);
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

test('family report radar chart renders reference-only lower bound markers', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const radarChartStart = familySource.indexOf('function RadarChart');
  const radarChartEnd = familySource.indexOf('export function FamilyRadarSection', radarChartStart + 1);
  assert.notEqual(radarChartStart, -1, 'RadarChart should exist');
  assert.notEqual(radarChartEnd, -1, 'FamilyRadarSection should follow RadarChart');

  const radarChartSource = familySource.slice(radarChartStart, radarChartEnd);
  assert.match(familySource, /function radarReferenceOnlyDetails/);
  assert.match(familySource, /function radarReferenceAmountText/);
  assert.match(familySource, /function radarChartAmount/);
  assert.match(familySource, /function radarChartScore/);
  assert.match(familySource, /radarStructureAmount\(score\) \|\| radarReferenceAmount\(score\)/);
  assert.match(familySource, /参考下限/);
  assert.match(radarChartSource, /referenceMarkers/);
  assert.match(radarChartSource, /radarReferenceAmountText\(score\)/);
  assert.match(radarChartSource, /radarChartScore\(score, item, mode\)/);
  assert.match(radarChartSource, /radarChartScore\(matchedScore, item, mode\)/);
  assert.match(radarChartSource, /visibleScore = mode === 'structure' \? Math\.max\(visualScore, 28\) : visualScore/);
  assert.match(radarChartSource, /!hasShape && !referenceMarkers\.length/);
  assert.match(radarChartSource, /strokeDasharray="5 4"/);
  assert.match(radarChartSource, /x1=\{centerX\}/);
  assert.match(radarChartSource, /<path d=\{`M \$\{marker\.x\}/);
  assert.match(radarChartSource, /\{marker\.amountText\}/);
  assert.doesNotMatch(radarChartSource, /score\.score > 0/);
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

test('family report export downloads a desktop H5 styled image instead of paginated pdf', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(reportExportSource, /type ReportExportOptions = \{ rawTarget\?: boolean; preservePageStyle\?: boolean; matchScreenStyle\?: boolean \}/);
  assert.match(reportExportSource, /const screenStyleReportWidth = 1180/);
  assert.match(reportExportSource, /rawTarget: true/);
  assert.match(reportExportSource, /matchScreenStyle: true/);
  assert.match(reportExportSource, /return Math\.max\(screenStyleReportWidth,\s*width\)/);
  assert.match(reportExportSource, /return \{ rawTarget: true,\s*\.\.\.options,\s*preservePageStyle: false,\s*matchScreenStyle: true \}/);
  assert.match(reportExportSource, /resolveImageCaptureOptions/);
  assert.match(normalizedCustomerAppSource, /downloadReportImage\(target,\s*title/);
  assert.match(normalizedCustomerAppSource, /onExport=\{\(target,\s*title\) => void downloadReportImage\(target,\s*title\)\}/);
  assert.match(appShellSource, /onExport=\{\(target,\s*title\) => void downloadReportImage\(target,\s*title\)\}/);
  assert.doesNotMatch(
    `${normalizedCustomerAppSource}\n${appShellSource}`,
    /downloadReportImage\(target,\s*title,\s*\{[^}]*preservePageStyle:\s*true/,
  );
  assert.match(reportExportSource, /captureReportImageCanvas\(imageTarget,\s*fileName/);
  assert.match(reportExportSource, /exportScreenStyledReportImageInCurrentPage\(imageTarget,\s*fileName/);
  assert.match(reportExportSource, /await import\('html-to-image'\)/);
  assert.match(reportExportSource, /toCanvas\(renderTarget\.node/);
  assert.match(reportExportSource, /isWeChatBrowser\(\)/);
  assert.match(reportExportSource, /isWeChatMiniProgramWebView\(\)/);
  assert.match(reportExportSource, /MiniProgram\|miniProgram/);
  assert.match(reportExportSource, /triggerImageBlobDownload\(imageBlob,\s*fileName\)/);
  assert.match(reportExportSource, /link\.download = `\$\{fileName\}\.jpg`/);
  assert.match(reportExportSource, /showBlobResult\(imageBlob: Blob\)/);
  assert.match(reportExportSource, /download="\$\{safeFileName\}\.jpg"/);
  assert.match(reportExportSource, /const useLongPressSave = isWeChatBrowser\(\) \|\| isWeChatMiniProgramWebView\(\)/);
  assert.match(reportExportSource, /长按图片保存/);
  assert.match(reportExportSource, /长按下面图片保存到相册/);
  assert.match(reportExportSource, /点击“下载长图”保存/);
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
  assert.match(imageCaptureSource, /renderOptions = resolveImageCaptureOptions\(_options\)/);
  assert.match(imageCaptureSource, /createPdfRenderTarget\(target,\s*_title,\s*undefined,\s*renderOptions\)/);
  assert.doesNotMatch(imageCaptureSource, /document\.body\.classList\.add\('pdf-page-style-export-mode'\)/);
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
  assert.match(familySource, /function InventoryExportCards/);
  assert.match(familySource, /function InsuredPolicyExportCards/);
  assert.match(familySource, /function AnnualCashflowExportList/);
  assert.match(familySource, /function WealthAggregateExportList/);
  assert.match(reportExportSource, /prepareScreenStyleReportNode\(reportNode,\s*width,\s*backgroundColor\)/);
  assert.match(reportExportSource, /family-report-screen-export-target/);
  assert.match(reportExportSource, /getScreenStyleReportBackground\(target\)/);
  assert.match(reportExportSource, /convertCssOklchToRgb/);
  assert.match(reportExportSource, /normalizeCanvasColorValues\(reportNode,\s*\{ includeCompositeColors: false \}\)/);
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
  assert.match(reportExportSource, /preparePageStyleTableWidths\(reportNode\)/);
  assert.match(reportExportSource, /getReportCaptureWidth\(reportNode,\s*width\)/);
  assert.match(reportExportSource, /compactReportCanvasText/);
  assert.match(reportExportSource, /\[data-family-report-raw-note\], \[data-report-canvas-skip\]/);
  assert.match(reportExportSource, /const captureWidth = options\?\.matchScreenStyle \|\| options\?\.preservePageStyle \? width : getReportCaptureWidth\(reportNode,\s*width\)/);
  assert.match(reportExportSource, /new jsPDF\(options\?\.preservePageStyle \? 'l' : 'p'/);
  assert.match(cssSource, /\.pdf-page-style-export-mode \.html2canvas-safe-export/);
  assert.match(cssSource, /background-color:\s*transparent !important/);
  assert.match(cssSource, /svg:not\(\[data-cash-value-trend-chart\]\)/);
  assert.match(cssSource, /\[data-family-report-raw-note\]/);
  assert.match(cssSource, /\[data-report-export-cards\]/);
  assert.match(cssSource, /\[data-report-export-table\]/);
  assert.match(cssSource, /\.family-report-screen-export-target \[data-report-export-cards\][\s\S]*display:\s*none !important/);
  assert.match(cssSource, /\.family-report-screen-export-target \[data-report-export-table\][\s\S]*display:\s*block !important/);
  assert.match(cssSource, /\.family-report-pdf-target \[data-report-export-table\][\s\S]*display:\s*none !important/);
  assert.match(cssSource, /\.family-report-pdf-target \[data-report-export-cards\][\s\S]*display:\s*block !important/);
  assert.match(cssSource, /\.pdf-page-style-export-mode \.family-report-pdf-target \[data-pdf-table-wrap\]/);
  assert.match(cssSource, /overflow:\s*visible !important/);
  assert.match(cssSource, /width:\s*100% !important/);
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
  assert.match(apiSource, /updateFamilyMember/);
  assert.match(apiSource, /deleteFamilyMember/);
  assert.match(apiSource, /updateFamilyMemberRelation/);
  assert.match(apiSource, /notes\?: string/);
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

test('policy entry auto-links typed or OCR names to existing family members', () => {
  const source = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');

  assert.match(source, /function findSingleFamilyMemberByName/);
  assert.match(source, /function relationForFamilyMember/);
  assert.match(source, /Number\(member\.id\) === Number\(selectedFamily\?\.coreMemberId \|\| 0\)/);
  assert.match(source, /function applyParticipantMember/);
  assert.match(source, /onUpdateForm\(memberIdKey, member\.id\)/);
  assert.match(source, /applyParticipantRelation\(kind, relationForFamilyMember\(member\)\)/);
  assert.match(source, /findSingleFamilyMemberByName\(formData\.applicant \|\| ''\)/);
  assert.match(source, /findSingleFamilyMemberByName\(formData\.insured \|\| ''\)/);
  assert.match(customerSource, /function autoBindEntryMembersByName/);
  assert.match(customerSource, /relationLabelForEntryMember/);
  assert.match(customerSource, /autoBindEntryMembersByName\(mergeScanToForm\(payload\.scan, current\)\)/);
  assert.match(customerSource, /applicantMemberId: applicantMember\.id/);
  assert.match(customerSource, /insuredMemberId: insuredMember\.id/);
});
