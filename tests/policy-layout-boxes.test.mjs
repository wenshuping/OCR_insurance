import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boxBounds,
  boxCenter,
  clusterBoxesIntoRows,
  normalizeOcrBoxes,
  sortBoxesReadingOrder,
} from '../ocr-service/policy-layout-boxes.mjs';

test('normalizeOcrBoxes keeps text, confidence, bounds, and original index', () => {
  const boxes = normalizeOcrBoxes([
    { text: '投保人', box: [100, 120, 160, 142], confidence: 0.98 },
    { text: '张三', box: [[220, 121], [260, 121], [260, 143], [220, 143]], confidence: 0.97 },
    { text: '', box: [0, 0, 1, 1] },
  ]);

  assert.equal(boxes.length, 2);
  assert.deepEqual(boxBounds(boxes[0].box), { xMin: 100, yMin: 120, xMax: 160, yMax: 142 });
  assert.deepEqual(boxCenter(boxes[1].box), { x: 240, y: 132 });
  assert.equal(boxes[0].index, 0);
  assert.equal(boxes[1].text, '张三');
});

test('clusterBoxesIntoRows groups nearby y centers and sorts left to right', () => {
  const boxes = normalizeOcrBoxes([
    { text: '张三', box: [220, 121, 260, 143] },
    { text: '投保人', box: [100, 120, 160, 142] },
    { text: '被保险人', box: [100, 170, 180, 192] },
    { text: '李四', box: [220, 171, 260, 193] },
  ]);

  const rows = clusterBoxesIntoRows(boxes, { yThreshold: 12 });
  assert.deepEqual(rows.map((row) => row.items.map((item) => item.text)), [
    ['投保人', '张三'],
    ['被保险人', '李四'],
  ]);
});

test('sortBoxesReadingOrder returns top-to-bottom then left-to-right text order', () => {
  const boxes = normalizeOcrBoxes([
    { text: '李四', box: [220, 171, 260, 193] },
    { text: '投保人', box: [100, 120, 160, 142] },
    { text: '张三', box: [220, 121, 260, 143] },
    { text: '被保险人', box: [100, 170, 180, 192] },
  ]);

  assert.deepEqual(sortBoxesReadingOrder(boxes).map((item) => item.text), ['投保人', '张三', '被保险人', '李四']);
});
