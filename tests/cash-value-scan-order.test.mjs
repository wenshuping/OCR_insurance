import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanCashValueTable } from '../ocr-service/insurance-ocr.service.mjs';

const UPLOAD_ITEM = {
  name: 'cash-value.png',
  dataUrl: `data:image/png;base64,${Buffer.from('fake image').toString('base64')}`,
};

const VISION_TEXT = [
  '保单年度末',
  '现金价值（元）',
  '1年末',
  '100.00',
  '2年末',
  '200.00',
  '3年末',
  '300.00',
].join('\n');

const PADDLE_STDOUT = JSON.stringify({
  ok: true,
  boxes: [
    { text: '保单年度', box: [[100, 50], [180, 50], [180, 70], [100, 70]], confidence: 0.99 },
    { text: '现金价值', box: [[220, 50], [320, 50], [320, 70], [220, 70]], confidence: 0.99 },
    { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]], confidence: 0.99 },
    { text: '900', box: [[240, 90], [290, 90], [290, 110], [240, 110]], confidence: 0.99 },
    { text: '2', box: [[120, 130], [140, 130], [140, 150], [120, 150]], confidence: 0.99 },
    { text: '1000', box: [[240, 130], [290, 130], [290, 150], [240, 150]], confidence: 0.99 },
    { text: '3', box: [[120, 170], [140, 170], [140, 190], [120, 190]], confidence: 0.99 },
    { text: '1100', box: [[240, 170], [290, 170], [290, 190], [240, 190]], confidence: 0.99 },
  ],
});

function testDependencies(execFile) {
  return {
    platform: 'darwin',
    env: {},
    warmupPaddle: async () => undefined,
    resolveScriptPaths: () => ({
      visionScriptPath: '/tmp/policy_ocr_vision.swift',
      paddleScriptPath: '/tmp/policy_ocr_paddle.py',
    }),
    assertScriptExists: () => undefined,
    getPaddlePython: () => 'python3',
    execFile,
  };
}

describe('cash value OCR scan order', () => {
  it('uses PaddleOCR before macOS Vision and skips Vision when PaddleOCR succeeds', async () => {
    const calls = [];
    const result = await scanCashValueTable({ uploadItem: UPLOAD_ITEM }, testDependencies(async (command, args) => {
      calls.push({ command, args });
      if (command === 'swift') return { stdout: VISION_TEXT, stderr: '' };
      return { stdout: PADDLE_STDOUT, stderr: '' };
    }));

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.command, 'python3');
    assert.equal(calls.some((call) => call.command === 'swift'), false);
    assert.equal(result.rows[0].cashValue, 900);
  });

  it('falls back to macOS Vision when PaddleOCR text is not parseable', async () => {
    const calls = [];
    const result = await scanCashValueTable({ uploadItem: UPLOAD_ITEM }, testDependencies(async (command, args) => {
      calls.push({ command, args });
      if (command === 'swift') return { stdout: VISION_TEXT, stderr: '' };
      return { stdout: JSON.stringify({ ok: true, boxes: [] }), stderr: '' };
    }));

    assert.equal(result.ok, true);
    assert.equal(result.source, 'macos_vision');
    assert.deepEqual(calls.map((call) => call.command), ['python3', 'swift']);
    assert.equal(result.rows[0].cashValue, 100);
  });
});
