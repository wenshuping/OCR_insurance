import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const localStackSource = readFileSync(new URL('../scripts/local-stack.mjs', import.meta.url), 'utf8');
const serverIndexSource = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
const dockerfileSource = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('local production stack lets runtime OCR env override the default provider', () => {
  assert.match(localStackSource, /'POLICY_OCR_OLLAMA_VISION_NUM_PREDICT'/u);
  assert.match(localStackSource, /'POLICY_OCR_OLLAMA_VISION_COMPLEX_PASSES'/u);
  assert.match(localStackSource, /'POLICY_OCR_REMOTE_VISION_MAX_IMAGE_DIMENSION'/u);
  assert.match(localStackSource, /'POLICY_OCR_REMOTE_VISION_MAX_TOKENS'/u);
  assert.match(localStackSource, /'POLICY_OCR_SERVICE_URL'/u);
  assert.match(localStackSource, /'POLICY_OCR_SERVICE_TOKEN'/u);
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
  assert.match(envBlock, /\.\.\.extraEnv[\s\S]+?\.\.\.readProcessRuntimeEnvOverrides\(\)/u);
  assert.match(localStackSource, /function readProcessRuntimeEnvOverrides/u);
  assert.match(localStackSource, /'POLICY_OCR_DEEPSEEK_OCR_BASE_URL'/u);
});

test('development dotenv skip still permits DeepSeek review configuration', () => {
  assert.match(serverIndexSource, /skippedProjectDotenvLocalAllowKeys/u);
  assert.match(serverIndexSource, /'DEEPSEEK_API_KEY'/u);
  assert.match(serverIndexSource, /'DEEPSEEK_FAMILY_REVIEW_MODEL'/u);
  assert.match(serverIndexSource, /'DEEPSEEK_FAMILY_REPORT_MODEL'/u);
  assert.match(serverIndexSource, /allowKeys:\s*skippedProjectDotenvLocalAllowKeys/u);
  assert.match(serverIndexSource, /POLICY_OCR_SKIP_PROJECT_DOTENV_LOCAL/u);
});

test('development stack keeps the DingTalk gateway alive when its credentials are configured', () => {
  assert.match(localStackSource, /name:\s*'dingtalk'[\s\S]+?server\/dingtalk-agent-gateway\.mjs/u);
  assert.match(localStackSource, /skip:\s*profile\.name\s*!==\s*'dev'\s*\|\|\s*!hasDingtalkGatewayConfig\(\)/u);
  assert.match(localStackSource, /DINGTALK_CHANNEL_API_BASE_URL:\s*`http:\/\/127\.0\.0\.1:\$\{profile\.apiPort\}`/u);
  assert.match(localStackSource, /name:\s*'dingtalk'[\s\S]+?shutdownGraceMs:\s*20_000/u);
  assert.match(localStackSource, /service\.shutdownGraceMs/u);
});

test('production Docker runtime copies src modules imported by the API server', () => {
  assert.match(dockerfileSource, /COPY src\/family-report-engine\.mjs \.\/src\/family-report-engine\.mjs/u);
  assert.match(dockerfileSource, /COPY src\/policy-plan-filter\.mjs \.\/src\/policy-plan-filter\.mjs/u);
  assert.match(dockerfileSource, /COPY src\/policy-validity\.mjs \.\/src\/policy-validity\.mjs/u);
});
