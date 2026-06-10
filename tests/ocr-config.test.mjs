import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  OCR_PROVIDER_PADDLE_LOCAL,
  OCR_PROVIDER_HUAWEI_CLOUD_INSURANCE,
  POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE,
  POLICY_OCR_MODE_PADDLEOCR_LOCAL,
  POLICY_OCR_MODE_PADDLEOCR_VL_1_5,
  POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL,
  POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM,
  getLegacyPolicyOcrProviderFromEnv,
  listPolicyOcrModeOptions,
  policyOcrProviderLabel,
  resolveLocalVisionFallbackRuntime,
  resolvePolicyOcrModeAdminReadiness,
  resolvePolicyOcrModeReadiness,
} from '../ocr-service/ocr-config.service.mjs';

const POLICY_OCR_MODE_REMOTE_GPU_VISION = 'remote_gpu_vision';
const OCR_PROVIDER_REMOTE_GPU_VISION = 'remote_gpu_vision';

test('admin OCR mode list uses fast readiness instead of blocking runtime probes', () => {
  assert.equal(resolvePolicyOcrModeAdminReadiness(POLICY_OCR_MODE_PADDLEOCR_LOCAL, {}).ready, true);
  assert.equal(resolvePolicyOcrModeAdminReadiness(POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM, {}).ready, true);
  assert.equal(resolvePolicyOcrModeAdminReadiness(POLICY_OCR_MODE_PADDLEOCR_VL_1_5, {}).ready, false);

  const options = listPolicyOcrModeOptions({ probeRuntime: false });
  const paddle = options.find((option) => option.value === POLICY_OCR_MODE_PADDLEOCR_LOCAL);
  const qwen = options.find((option) => option.value === POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM);
  const paddleVl = options.find((option) => option.value === POLICY_OCR_MODE_PADDLEOCR_VL_1_5);

  assert.equal(paddle?.selectable, true);
  assert.equal(qwen?.selectable, true);
  assert.equal(paddleVl?.selectable, false);
});

test('local vision fallback runtime reports image-only local fallback state', () => {
  assert.deepEqual(resolveLocalVisionFallbackRuntime({ POLICY_OCR_LOCAL_VISION_FALLBACK: 'true' }), {
    enabled: true,
    provider: 'mlx_qwen25_vl_local',
    scope: 'image_only',
  });

  assert.deepEqual(resolveLocalVisionFallbackRuntime({}), {
    enabled: false,
    provider: 'mlx_qwen25_vl_local',
    scope: 'image_only',
  });
});

test('remote GPU vision mode is available when a 4080 vision endpoint is configured', () => {
  const env = { POLICY_OCR_REMOTE_VISION_BASE_URL: 'http://192.168.1.8:11434' };

  assert.equal(resolvePolicyOcrModeReadiness(POLICY_OCR_MODE_REMOTE_GPU_VISION, {}).ready, false);
  assert.equal(resolvePolicyOcrModeReadiness(POLICY_OCR_MODE_REMOTE_GPU_VISION, env).ready, true);
  assert.equal(resolvePolicyOcrModeAdminReadiness(POLICY_OCR_MODE_REMOTE_GPU_VISION, env).ready, true);
  assert.equal(policyOcrProviderLabel(OCR_PROVIDER_REMOTE_GPU_VISION), '4080 远程视觉识别');

  const options = listPolicyOcrModeOptions({ probeRuntime: false });
  const remoteVision = options.find((option) => option.value === POLICY_OCR_MODE_REMOTE_GPU_VISION);
  assert.equal(remoteVision?.selectable, true);
});

test('Huawei Cloud insurance OCR mode requires project and credentials', () => {
  const env = {
    POLICY_OCR_HUAWEI_PROJECT_ID: 'cn-north-4-project',
    POLICY_OCR_HUAWEI_X_AUTH_TOKEN: 'token',
  };

  assert.equal(resolvePolicyOcrModeReadiness(POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE, {}).ready, false);
  assert.equal(resolvePolicyOcrModeReadiness(POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE, env).ready, true);
  assert.equal(resolvePolicyOcrModeAdminReadiness(POLICY_OCR_MODE_HUAWEI_CLOUD_INSURANCE, env).ready, true);
  assert.equal(policyOcrProviderLabel(OCR_PROVIDER_HUAWEI_CLOUD_INSURANCE), '华为云保险单识别');
});

test('default OCR runtime uses remote GPU vision instead of local OCR', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ocr-config-'));
  const configPath = path.join(tmpDir, 'policy-ocr-config.json');
  const previousPath = process.env.POLICY_OCR_CONFIG_PATH;
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  const previousRemoteBaseUrl = process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
  try {
    process.env.POLICY_OCR_CONFIG_PATH = configPath;
    delete process.env.POLICY_OCR_PROVIDER;
    delete process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;

    const freshModule = await import(new URL(`../ocr-service/ocr-config.service.mjs?ts=${Date.now()}`, import.meta.url));
    const stored = freshModule.resolveStoredPolicyOcrConfig();
    const payload = freshModule.resolvePolicyOcrRuntimePayload();

    assert.equal(stored.mode, POLICY_OCR_MODE_REMOTE_GPU_VISION);
    assert.equal(freshModule.getLegacyPolicyOcrProviderFromEnv({}), OCR_PROVIDER_REMOTE_GPU_VISION);
    assert.equal(freshModule.resolveEffectivePolicyOcrProvider(), OCR_PROVIDER_REMOTE_GPU_VISION);
    assert.equal(payload.runtime.provider, OCR_PROVIDER_REMOTE_GPU_VISION);
    assert.equal(payload.runtime.legacyProvider, OCR_PROVIDER_REMOTE_GPU_VISION);
  } finally {
    if (previousPath == null) {
      delete process.env.POLICY_OCR_CONFIG_PATH;
    } else {
      process.env.POLICY_OCR_CONFIG_PATH = previousPath;
    }
    if (previousProvider == null) {
      delete process.env.POLICY_OCR_PROVIDER;
    } else {
      process.env.POLICY_OCR_PROVIDER = previousProvider;
    }
    if (previousRemoteBaseUrl == null) {
      delete process.env.POLICY_OCR_REMOTE_VISION_BASE_URL;
    } else {
      process.env.POLICY_OCR_REMOTE_VISION_BASE_URL = previousRemoteBaseUrl;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('explicit OCR provider overrides stored local OCR mode', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ocr-config-'));
  const configPath = path.join(tmpDir, 'policy-ocr-config.json');
  writeFileSync(configPath, JSON.stringify({
    mode: 'macos_vision_local',
    updatedAt: '2026-06-08T00:00:00.000Z',
    updatedByActorId: null,
  }), 'utf-8');

  const previousPath = process.env.POLICY_OCR_CONFIG_PATH;
  const previousProvider = process.env.POLICY_OCR_PROVIDER;
  try {
    process.env.POLICY_OCR_CONFIG_PATH = configPath;
    process.env.POLICY_OCR_PROVIDER = OCR_PROVIDER_REMOTE_GPU_VISION;

    const freshModule = await import(new URL(`../ocr-service/ocr-config.service.mjs?ts=${Date.now()}-override`, import.meta.url));
    const payload = freshModule.resolvePolicyOcrRuntimePayload();

    assert.equal(freshModule.resolveStoredPolicyOcrConfig().mode, 'macos_vision_local');
    assert.equal(freshModule.resolveEffectivePolicyOcrProvider(), OCR_PROVIDER_REMOTE_GPU_VISION);
    assert.equal(payload.runtime.provider, OCR_PROVIDER_REMOTE_GPU_VISION);
  } finally {
    if (previousPath == null) {
      delete process.env.POLICY_OCR_CONFIG_PATH;
    } else {
      process.env.POLICY_OCR_CONFIG_PATH = previousPath;
    }
    if (previousProvider == null) {
      delete process.env.POLICY_OCR_PROVIDER;
    } else {
      process.env.POLICY_OCR_PROVIDER = previousProvider;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deprecated pdf extract kit config falls back to PaddleOCR runtime mode', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ocr-config-'));
  const configPath = path.join(tmpDir, 'policy-ocr-config.json');
  writeFileSync(configPath, JSON.stringify({
    mode: POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL,
    updatedAt: '2026-06-03T00:00:00.000Z',
    updatedByActorId: null,
  }), 'utf-8');

  const previousPath = process.env.POLICY_OCR_CONFIG_PATH;
  try {
    process.env.POLICY_OCR_CONFIG_PATH = configPath;
    const freshModule = await import(new URL(`../ocr-service/ocr-config.service.mjs?ts=${Date.now()}`, import.meta.url));
    const stored = freshModule.resolveStoredPolicyOcrConfig();
    const payload = freshModule.resolvePolicyOcrAdminPayload();
    assert.equal(stored.mode, POLICY_OCR_MODE_PADDLEOCR_LOCAL);
    assert.equal(payload.config.mode, POLICY_OCR_MODE_PADDLEOCR_LOCAL);
    assert.equal(payload.runtime.provider, OCR_PROVIDER_PADDLE_LOCAL);
    assert.equal(payload.options.some((option) => option.value === POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL), false);
  } finally {
    if (previousPath == null) {
      delete process.env.POLICY_OCR_CONFIG_PATH;
    } else {
      process.env.POLICY_OCR_CONFIG_PATH = previousPath;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('deprecated pdf extract kit env provider falls back to PaddleOCR provider', () => {
  assert.equal(
    getLegacyPolicyOcrProviderFromEnv({ POLICY_OCR_PROVIDER: POLICY_OCR_MODE_PDF_EXTRACT_KIT_LOCAL }),
    OCR_PROVIDER_PADDLE_LOCAL,
  );
});
