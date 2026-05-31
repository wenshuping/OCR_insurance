import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

function componentSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}`);
  const end = nextName ? appSource.indexOf(`function ${nextName}`, start + 1) : appSource.length;
  assert.notEqual(start, -1, `${name} component should exist`);
  assert.notEqual(end, -1, `${nextName} component should exist`);
  return appSource.slice(start, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('customer account sheet uses a blue account logo', () => {
  const source = componentSource('CustomerAccountSheet', 'PhoneVerificationDialog');
  assert.match(source, /h-12 w-12[^"]*bg-blue-500/);
});

test('phone verification send-code button uses the blue primary style', () => {
  const source = componentSource('PhoneVerificationDialog', 'UploadPolicyPage');
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

test('photo upload area shows an OCR recognition animation while loading', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  assert.match(pageSource, /aria-busy=\{loading\}/);
  assert.match(pageSource, /OCR 识别中/);
  assert.match(pageSource, /animate-spin/);
  assert.match(pageSource, /aria-live="polite"/);
});

test('cash value upload dialog shows a progress bar while scanning', () => {
  const appSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(appSource, /role="progressbar"/);
  assert.match(appSource, /aria-valuetext="正在识别现金价值表"/);
  assert.match(appSource, /现金价值表识别中/);
  assert.match(appSource, /animate-\[cash-value-progress/);
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
  const selectSource = componentSource('SelectField', 'PolicyDetailSheet');
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
  const keepDraftCalls = appSource.match(/normalizePolicyPlanList\(current\.plans,\s*current\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)/g) || [];
  assert.match(normalizeSource, /keepEmpty/);
  assert.match(normalizeSource, /!name && !matchedProductName && !keepEmpty/);
  assert.ok(keepDraftCalls.length >= 3, 'add, update and remove should preserve unnamed draft plans');
  assert.match(pageSource, /plans=\{normalizePolicyPlanList\(formData\.plans,\s*formData\.company,\s*\{\s*keepEmpty:\s*true\s*\}\)\}/);
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

test('entry form and family overview expose insured birthday for age-based reports', () => {
  const formSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const overviewSource = componentSource('FamilyCoverageOverview', 'AdminApp');
  assert.match(formSource, /被保险人生日/);
  assert.match(formSource, /insuredBirthday/);
  assert.match(overviewSource, /家庭保障总览/);
  assert.match(overviewSource, /memberBirthdays/);
  assert.match(appSource, /buildFamilyCoverageOverview\(policies\)/);
  assert.match(appSource, /<FamilyCoverageOverview[\s\S]*overview=\{familyCoverageOverview\}[\s\S]*policies=\{policies\}/);
});

test('entry form separates legal beneficiary from beneficiary name before saving policy', () => {
  const formSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /beneficiary: string/);
  assert.match(formSource, /法定受益人/);
  assert.match(formSource, /type="checkbox"/);
  assert.match(formSource, /checked=\{formData\.beneficiary === '法定'\}/);
  assert.match(formSource, /onUpdateForm\('beneficiary', event\.target\.checked \? '法定' : ''\)/);
  assert.match(formSource, /label="受益人姓名"/);
});

test('family overview prefers local product indicators over raw OCR responsibility years', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const overviewBuilderSource = appSource.slice(
    appSource.indexOf('function parseAmountFromText'),
    appSource.indexOf('type PolicyUploadSource'),
  );
  const overviewSource = componentSource('FamilyCoverageOverview', 'AdminApp');
  assert.match(apiSource, /coverageIndicators/);
  assert.match(overviewBuilderSource, /policy\.coverageIndicators/);
  assert.match(overviewBuilderSource, /formatCoverageIndicator/);
  assert.doesNotMatch(overviewBuilderSource, /\\d\{4,\}/);
  assert.match(overviewSource, /cell\.displayText/);
});

test('family overview treats annuity payouts as cashflow instead of cash value table prerequisites', () => {
  const overviewBuilderSource = appSource.slice(
    appSource.indexOf('function parseAmountFromText'),
    appSource.indexOf('type PolicyUploadSource'),
  );
  const overviewSource = componentSource('FamilyCoverageOverview', 'AdminApp');
  assert.match(overviewBuilderSource, /isCashflowPayoutIndicator/);
  assert.match(overviewBuilderSource, /生存保险金/);
  assert.match(overviewBuilderSource, /养老年金/);
  assert.match(overviewBuilderSource, /满期生存保险金/);
  assert.match(overviewBuilderSource, /resolveIndicatorAmount/);
  assert.doesNotMatch(overviewBuilderSource, /缺少现金价值表/);
  assert.doesNotMatch(overviewSource, /待现金价值表/);
});

test('family overview substitutes policy amounts into indicator formulas', () => {
  const overviewBuilderSource = appSource.slice(
    appSource.indexOf('function parseAmountFromText'),
    appSource.indexOf('type PolicyUploadSource'),
  );
  const overviewSource = componentSource('FamilyCoverageOverview', 'AdminApp');
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
  assert.match(overviewSource, /cell\.calculationText/);
  assert.match(overviewSource, /text-\[11px\]/);
});

test('responsibility assistant floats at the bottom right of the screen', () => {
  const source = componentSource('ResponsibilityAssistant', 'PolicyListItem');
  assert.match(source, /fixed bottom-6 right-4/);
  assert.match(source, /sm:right-6/);
  assert.match(source, /输入保险名称查责任/);
  assert.match(source, /保险公司候选/);
  assert.match(source, /保险产品候选/);
  assert.match(source, /renderHighlightedSuggestion/);
  assert.doesNotMatch(source, /bottom-28|sm:bottom-6/);
});

test('pdf export uses a dedicated A4 report layout instead of mobile card cloning', () => {
  const reportSource = componentSource('createPrintableReportNode', 'createPdfRenderTarget');
  const renderSource = componentSource('createPdfRenderTarget', 'escapeHtml');
  assert.match(reportSource, /width:760px/);
  assert.match(reportSource, /保单解析报告/);
  assert.match(appSource, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(renderSource, /createPrintableReportNode\(target, title, policy\)/);
  assert.doesNotMatch(appSource, /function applyPdfSafeStyle/);
});

test('admin policy detail exposes policy source links', () => {
  const source = componentSource('AdminPolicyDetail', 'MetricBox');
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
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
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

test('customer policy detail displays responsibility official urls', () => {
  const detailSource = componentSource('PolicyDetailSheet', null);
  const adminDetailSource = componentSource('AdminPolicyDetail', 'MetricBox');
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /sourceUrl\?: string/);
  assert.match(apiSource, /sourceTitle\?: string/);
  assert.match(appSource, /function getPolicyResponsibilitySourceLinks\(policy: Policy\)/);
  assert.match(appSource, /policy\.sources/);
  assert.match(appSource, /policy\.coverageIndicators/);
  assert.match(detailSource, /getPolicyResponsibilitySourceLinks\(policy\)/);
  assert.match(detailSource, /官网地址/);
  assert.match(detailSource, /href=\{source\.url\}/);
  assert.match(detailSource, /target="_blank"/);
  assert.match(detailSource, /ExternalLink/);
  assert.match(adminDetailSource, /官网地址/);
});

test('customer policy detail can open manual cash value entry', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const detailSource = componentSource('PolicyDetailSheet', null);
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /source\?: 'ocr' \| 'vision_llm' \| 'manual'/);
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

test('customer app exposes family report after policy inventory and before section analysis', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /buildFamilyReport/);
  assert.match(appSource, /FamilyReportPage/);
  assert.match(appSource, /setShowFamilyReport\(true\)/);
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

test('family overview header exposes a direct family report entry', () => {
  const customerSource = componentSource('CustomerApp', 'FamilyCoverageOverview');
  const overviewSource = componentSource('FamilyCoverageOverview', 'AdminApp');

  assert.match(customerSource, /onViewReport=\{\(\) => setShowFamilyReport\(true\)\}/);
  assert.match(overviewSource, /onViewReport/);
  assert.match(overviewSource, /家庭保障分析报告/);
  assert.match(overviewSource, /查看报告/);
  assert.match(overviewSource, /onClick=\{onViewReport\}/);
});

test('family report labels match the agreed report structure', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
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
  assert.doesNotMatch(source, /营销落地页|立即购买|推荐产品/);
});

test('family report renders amount-based radar sections in the agreed order without chart dependencies', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
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
  assert.match(appSource, /FAMILY_PLANNING_PROFILE_KEY/);
  assert.match(appSource, /buildFamilyReport\(policies,\s*familyPlanningProfile\)/);
  assert.match(familySource, /<FamilyRadarSection report=\{report\} \/>/);
  assert.match(familySource, /<MemberRadarSection report=\{report\} \/>/);
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

test('family report wealth policies show cashflow table with cash value and keep cash value as line chart only', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(source, /function PolicyAnnualCashflowTable/);
  assert.match(source, /个人现金流明细/);
  assert.match(source, /领取金额/);
  assert.match(source, /累计领取/);
  assert.match(source, /function CashValueLineChart/);
  assert.match(source, /aria-label="现金价值曲线"/);
  assert.match(source, /<path d=\{path\}/);
  assert.match(source, /<PolicyAnnualCashflowTable policy=\{policy\} \/>/);
  const cashValueAreaStart = source.indexOf('<h5 className="mb-2 text-xs font-black text-slate-700">现金价值</h5>');
  const cashValueAreaEnd = source.indexOf('</div>', cashValueAreaStart);
  const cashValueArea = source.slice(cashValueAreaStart, cashValueAreaEnd);
  assert.doesNotMatch(cashValueArea, /<TableWrap>/);
});

test('family report export downloads a page-styled image instead of paginated pdf', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /type ReportExportOptions = \{ rawTarget\?: boolean; preservePageStyle\?: boolean \}/);
  assert.match(appSource, /rawTarget: true/);
  assert.match(appSource, /preservePageStyle: true/);
  assert.match(appSource, /downloadReportImage\(target,\s*title/);
  assert.match(appSource, /triggerImageBlobDownload\(imageBlob,\s*fileName\)/);
  assert.match(appSource, /link\.download = `\$\{fileName\}\.jpg`/);
  const imageExportSource = componentSource('downloadReportImage', 'buildDraftReportTitle');
  assert.doesNotMatch(imageExportSource, /exportCurrentReportAsPdf/);
  assert.doesNotMatch(imageExportSource, /new jsPDF/);
  assert.doesNotMatch(imageExportSource, /PDF/);
  assert.match(appSource, /reportNode\.classList\?\.add\?\.\('print-policy-report'\)/);
  assert.match(appSource, /createPdfRenderTarget\(target,\s*fileName,\s*policy,\s*options\)/);
  assert.match(familySource, /aria-label="下载报告图片"/);
  assert.match(familySource, /title="下载报告图片"/);
});

test('family report export keeps page styling and wraps wide tables for pdf capture', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const cssSource = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  assert.match(familySource, /data-pdf-table-wrap/);
  assert.match(appSource, /preparePageStyleReportNode\(reportNode,\s*width\)/);
  assert.match(appSource, /family-report-pdf-target/);
  assert.match(appSource, /querySelectorAll<HTMLElement>\('\[data-pdf-table-wrap\]'\)/);
  assert.match(appSource, /captureWidth: options\?\.preservePageStyle \? width/);
  assert.match(appSource, /new jsPDF\(options\?\.preservePageStyle \? 'l' : 'p'/);
  assert.match(cssSource, /\.pdf-page-style-export-mode \.family-report-pdf-target \[data-pdf-table-wrap\]/);
  assert.match(cssSource, /overflow:\s*visible !important/);
  assert.match(cssSource, /max-width:\s*100% !important/);
  assert.match(cssSource, /table-layout:\s*fixed !important/);
  assert.match(cssSource, /white-space:\s*normal !important/);
  assert.match(cssSource, /print-color-adjust:\s*exact/);
});
