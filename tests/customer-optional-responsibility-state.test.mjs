import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const customerAppSource = fs.readFileSync(new URL('../src/apps/customer/CustomerApp.tsx', import.meta.url), 'utf8');
const customerPolicyComponentsSource = fs.readFileSync(new URL('../src/shared/customer-policy-components.tsx', import.meta.url), 'utf8');
const policyReportUiSource = fs.readFileSync(new URL('../src/shared/policy-report-ui.tsx', import.meta.url), 'utf8');

function functionSource(name, nextName) {
  const start = customerAppSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = nextName ? customerAppSource.indexOf(`function ${nextName}`, start + 1) : customerAppSource.length;
  if (nextName) assert.notEqual(end, -1, `${nextName} should exist`);
  return customerAppSource.slice(start, end === -1 ? customerAppSource.length : end);
}

test('entry optional responsibility choices are saved from the latest manual selection', () => {
  const updateSource = functionSource('updateAnalysisOptionalResponsibility', 'openResponsibilityAssistant');
  const submitSource = functionSource('handleSubmit', 'handleCashValueFileChange');

  assert.match(customerAppSource, /optionalResponsibilitySelectionRef = useRef<Map<string, OptionalResponsibilitySelectionDraft>>\(new Map\(\)\)/);
  assert.match(updateSource, /optionalResponsibilitySelectionRef\.current\.set\(id,\s*{\s*selectionStatus,\s*coverageAmount/);
  assert.match(updateSource, /setAnalysisDraft\(\(current\) => current[\s\S]*updateOptionalResponsibilityItems\(\s*current\.optionalResponsibilities,\s*id,\s*selectionStatus,\s*coverageAmount/);
  assert.match(submitSource, /const analysisForSubmit = withRememberedOptionalResponsibilitySelections\(analysisDraft\)/);
  assert.match(submitSource, /const hasGeneratedAnalysis = hasAnalysisResult\(analysisForSubmit\)/);
  assert.match(submitSource, /analysis: hasGeneratedAnalysis \? analysisForSubmit : null/);
});

test('entry optional responsibility amount survives local OCR draft refreshes', () => {
  const rememberSource = functionSource('rememberOptionalResponsibilitySelections', 'applyRememberedOptionalResponsibilitySelections');
  const applySource = functionSource('applyRememberedOptionalResponsibilitySelections', 'withRememberedOptionalResponsibilitySelections');

  assert.match(rememberSource, /coverageAmount:\s*item\.coverageAmount/);
  assert.match(applySource, /const rememberedSelection = id \? remembered\.get\(id\) : undefined/);
  assert.match(applySource, /rememberedSelection\.selectionStatus,\s*rememberedSelection\.coverageAmount/);
});

test('manual optional responsibility choice controls card visibility ahead of stale indicator status', () => {
  const start = policyReportUiSource.indexOf('function responsibilityCardSelectionStatus');
  const end = policyReportUiSource.indexOf('export function getVisibleResponsibilityCards', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const selectionSource = policyReportUiSource.slice(start, end);

  assert.ok(
    selectionSource.indexOf('optionalResponsibilities.find') < selectionSource.indexOf('indicatorStatuses'),
    'the explicit optional responsibility selection should be checked before nested indicator defaults',
  );
});

test('optional responsibility indicators render and calculate only after the responsibility is selected', () => {
  const start = customerPolicyComponentsSource.indexOf('export function OptionalResponsibilityReview');
  const end = customerPolicyComponentsSource.indexOf('export function PolicyPlanEditor', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const reviewSource = customerPolicyComponentsSource.slice(start, end);

  assert.match(reviewSource, /status === 'selected' && linkedIndicators\.length \? \(/);
  assert.match(reviewSource, /resolveIndicatorAmountFromCalculation\(indicator, \{ baseAmount: coverageAmount, firstPremium, paymentYears, effectiveInsuranceAmount, accumulatedDividendInsuredAmount \}\)/);
  assert.doesNotMatch(reviewSource, /4,?493\.85|8,?987\.70/);
});

test('optional responsibility card prefers the bounded customer summary over raw clause text', () => {
  assert.match(
    customerPolicyComponentsSource,
    /String\(item\.customerSummary \|\| item\.sourceExcerpt \|\| ''\)/,
  );
});

test('generic optional responsibility keeps its group title instead of borrowing a child benefit title', () => {
  const start = customerPolicyComponentsSource.indexOf('function optionalResponsibilityDisplayName');
  const end = customerPolicyComponentsSource.indexOf('function optionalResponsibilityContentText', start);
  const displayNameSource = customerPolicyComponentsSource.slice(start, end);
  assert.doesNotMatch(displayNameSource, /numberedHeading|inlineHeading/);
});

test('entry optional responsibility choices survive local draft refreshes', () => {
  const draftSource = functionSource('loadFormProductAnalysisDraft', 'updateForm');
  const updateFormSource = functionSource('updateForm', 'updatePolicyPlan');

  assert.match(draftSource, /rememberOptionalResponsibilitySelections\(existingOptionalResponsibilitySource\)/);
  assert.match(draftSource, /const existingOptionalResponsibilities = applyRememberedOptionalResponsibilitySelections\(existingOptionalResponsibilitySource\)/);
  assert.match(draftSource, /const nextAnalysis = withRememberedOptionalResponsibilitySelections\(payload\.analysis\)/);
  assert.match(draftSource, /setAnalysisDraft\(nextAnalysis\)/);
  assert.doesNotMatch(updateFormSource, /function updateForm[^{]*{\s*setAnalysisDraft\(null\)/);
  assert.match(updateFormSource, /if \(key === 'company' \|\| key === 'name'\) {[\s\S]*clearOptionalResponsibilitySelections\(\);[\s\S]*setAnalysisDraft\(null\)/);
});

test('entry optional responsibility choices are cleared for a new policy context', () => {
  const ocrTextSource = functionSource('handleOcrTextChange', 'openPhoneVerificationDialog');
  const recognizeSource = functionSource('recognizePreparedUpload', 'handleScanClick');
  const startEntrySource = functionSource('startEntryForm');

  assert.match(ocrTextSource, /clearOptionalResponsibilitySelections\(\)/);
  assert.match(recognizeSource, /clearOptionalResponsibilitySelections\(\)/);
  assert.match(startEntrySource, /clearOptionalResponsibilitySelections\(\)/);
});
