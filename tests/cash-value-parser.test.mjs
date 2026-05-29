import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clusterIntoRows,
  detectTableHeader,
  extractCashValueRows,
  parseCashValueTable,
} from '../ocr-service/cash-value-parser.mjs';

describe('cash-value-parser', () => {

  describe('clusterIntoRows', () => {
    it('groups items by Y coordinate with tolerance', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '现金价值', box: [[350, 52], [450, 52], [450, 72], [350, 72]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
        { text: '8,500', box: [[360, 92], [430, 92], [430, 112], [360, 112]] },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].length, 2);
      assert.equal(rows[0][0].text, '保单年度');
      assert.equal(rows[0][1].text, '现金价值');
      assert.equal(rows[1][0].text, '1');
      assert.equal(rows[1][1].text, '8,500');
    });

    it('sorts items within a row by X coordinate', () => {
      const boxes = [
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows[0][0].text, '1');
      assert.equal(rows[0][1].text, '8,500');
    });

    it('handles boxes without coordinates by returning single-item rows', () => {
      const boxes = [
        { text: 'hello' },
        { text: 'world' },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows.length, 2);
    });
  });

  describe('detectTableHeader', () => {
    it('detects 2-column header with 保单年度 and 现金价值', () => {
      const rows = [
        [{ text: '保单年度', box: [[100, 50]] }, { text: '现金价值', box: [[350, 50]] }],
        [{ text: '1', box: [[120, 90]] }, { text: '8,500', box: [[360, 90]] }],
      ];
      const header = detectTableHeader(rows);
      assert.ok(header);
      assert.equal(header.headerRowIndex, 0);
      assert.equal(header.tableType, 2);
      assert.deepEqual(header.columns, ['policyYear', 'cashValue']);
    });

    it('detects 3-column header with age column', () => {
      const rows = [
        [
          { text: '保险年限' },
          { text: '被保险年龄' },
          { text: '现金价值' },
        ],
      ];
      const header = detectTableHeader(rows);
      assert.ok(header);
      assert.equal(header.tableType, 3);
      assert.deepEqual(header.columns, ['policyYear', 'age', 'cashValue']);
    });

    it('returns null when no header keywords found', () => {
      const rows = [
        [{ text: '姓名' }, { text: '张三' }],
      ];
      const header = detectTableHeader(rows);
      assert.equal(header, null);
    });
  });

  describe('extractCashValueRows', () => {
    it('parses 2-column data rows', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8,500' }],
        [{ text: '2' }, { text: '19,200' }],
        [{ text: '3' }, { text: '31,800.50' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { policyYear: 1, age: null, cashValue: 8500 });
      assert.deepEqual(result[1], { policyYear: 2, age: null, cashValue: 19200 });
      assert.deepEqual(result[2], { policyYear: 3, age: null, cashValue: 31800.50 });
    });

    it('parses 3-column data rows with age', () => {
      const dataRows = [
        [{ text: '1' }, { text: '30' }, { text: '8,500' }],
        [{ text: '2' }, { text: '31' }, { text: '19,200' }],
      ];
      const columns = ['policyYear', 'age', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { policyYear: 1, age: 30, cashValue: 8500 });
    });

    it('skips rows with non-numeric data', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8,500' }],
        [{ text: '合计' }, { text: '—' }],
        [{ text: '2' }, { text: '19,200' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 2);
    });

    it('handles amounts with 元 suffix', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8500元' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result[0].cashValue, 8500);
    });
  });

  describe('parseCashValueTable', () => {
    it('returns parsed result with confidence for valid 2-column table', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]], confidence: 0.98 },
        { text: '现金价值', box: [[350, 50], [450, 50], [450, 70], [350, 70]], confidence: 0.97 },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]], confidence: 0.99 },
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]], confidence: 0.96 },
        { text: '2', box: [[120, 130], [140, 130], [140, 150], [120, 150]], confidence: 0.99 },
        { text: '19,200', box: [[360, 130], [440, 130], [440, 150], [360, 150]], confidence: 0.95 },
        { text: '3', box: [[120, 170], [140, 170], [140, 190], [120, 190]], confidence: 0.98 },
        { text: '31,800', box: [[360, 170], [440, 170], [440, 190], [360, 190]], confidence: 0.94 },
      ];
      const result = parseCashValueTable(boxes);
      assert.ok(result.ok);
      assert.equal(result.tableType, 2);
      assert.equal(result.rows.length, 3);
      assert.equal(result.rows[0].policyYear, 1);
      assert.equal(result.rows[0].cashValue, 8500);
      assert.ok(result.confidence > 0);
    });

    it('returns failure when boxes are empty', () => {
      const result = parseCashValueTable([]);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'CASH_VALUE_TABLE_NOT_DETECTED');
    });

    it('returns failure when no header detected', () => {
      const boxes = [
        { text: '姓名', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '张三', box: [[350, 50], [450, 50], [450, 70], [350, 70]] },
      ];
      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, false);
    });

    it('returns failure when fewer than 3 data rows', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '现金价值', box: [[350, 50], [450, 50], [450, 70], [350, 70]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]] },
      ];
      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, false);
    });
  });
});
