import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const localStackSource = readFileSync(new URL('../scripts/local-stack.mjs', import.meta.url), 'utf8');
const serverIndexSource = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');

test('local production stack lets runtime OCR env override the default provider', () => {
  assert.match(localStackSource, /'POLICY_OCR_OLLAMA_VISION_NUM_PREDICT'/u);
  assert.match(localStackSource, /'POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES'/u);
  assert.match(localStackSource, /'POLICY_OCR_REMOTE_VISION_MAX_IMAGE_DIMENSION'/u);
  assert.match(localStackSource, /'POLICY_OCR_REMOTE_VISION_MAX_TOKENS'/u);
  assert.match(localStackSource, /'POLICY_OCR_HUAWEI_PROJECT_ID'/u);
  assert.match(localStackSource, /'POLICY_OCR_HUAWEI_X_AUTH_TOKEN'/u);
  assert.match(localStackSource, /'POLICY_OCR_HUAWEI_AK'/u);
  assert.match(localStackSource, /'POLICY_OCR_HUAWEI_SK'/u);
  assert.match(localStackSource, /'POLICY_OCR_HUAWEI_ENDPOINT'/u);
  assert.doesNotMatch(localStackSource, /'POLICY_OCR_STRUCTUREV3_ENDPOINT'/u);
  assert.doesNotMatch(localStackSource, /'POLICY_OCR_STRUCTUREV3_LLM_BASE_URL'/u);
  assert.doesNotMatch(localStackSource, /'POLICY_OCR_STRUCTUREV3_LLM_MODEL'/u);

  const envBlock = localStackSource.match(/env:\s*\{[\s\S]+?POLICY_OCR_PROVIDER:[\s\S]+?\n\s*\},\n\s*\};/u)?.[0] || '';
  assert.doesNotMatch(envBlock, /POLICY_OCR_CONFIG_PATH/u);
  assert.match(envBlock, /POLICY_OCR_PROVIDER:\s*'remote_gpu_vision'[\s\S]+?\.\.\.extraEnv/u);
});

test('development dotenv skip still permits DeepSeek review configuration', () => {
  assert.match(serverIndexSource, /skippedProjectDotenvLocalAllowKeys/u);
  assert.match(serverIndexSource, /'DEEPSEEK_API_KEY'/u);
  assert.match(serverIndexSource, /'DEEPSEEK_FAMILY_REVIEW_MODEL'/u);
  assert.match(serverIndexSource, /allowKeys:\s*skippedProjectDotenvLocalAllowKeys/u);
  assert.match(serverIndexSource, /POLICY_OCR_SKIP_PROJECT_DOTENV_LOCAL/u);
});
