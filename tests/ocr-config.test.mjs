import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POLICY_OCR_MODE_PADDLEOCR_LOCAL,
  POLICY_OCR_MODE_PADDLEOCR_VL_1_5,
  POLICY_OCR_MODE_QWEN25_VL_3B_INSTRUCT_MLX_VLM,
  listPolicyOcrModeOptions,
  resolveLocalVisionFallbackRuntime,
  resolvePolicyOcrModeAdminReadiness,
} from '../ocr-service/ocr-config.service.mjs';

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
