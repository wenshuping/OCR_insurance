import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const customerAppSource = fs.readFileSync(new URL('../src/apps/customer/CustomerApp.tsx', import.meta.url), 'utf8');

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

  assert.match(customerAppSource, /optionalResponsibilitySelectionRef = useRef<Map<string, OptionalResponsibility\['selectionStatus'\]>>\(new Map\(\)\)/);
  assert.match(updateSource, /optionalResponsibilitySelectionRef\.current\.set\(id,\s*selectionStatus\)/);
  assert.match(updateSource, /setAnalysisDraft\(\(current\) => current[\s\S]*updateOptionalResponsibilityItems\(current\.optionalResponsibilities,\s*id,\s*selectionStatus\)/);
  assert.match(submitSource, /const analysisForSubmit = withRememberedOptionalResponsibilitySelections\(analysisDraft\)/);
  assert.match(submitSource, /const hasGeneratedAnalysis = hasAnalysisResult\(analysisForSubmit\)/);
  assert.match(submitSource, /analysis: hasGeneratedAnalysis \? analysisForSubmit : null/);
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
