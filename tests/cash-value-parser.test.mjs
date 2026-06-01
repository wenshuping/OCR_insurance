import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clusterIntoRows,
  detectTableHeader,
  extractCashValueRows,
  parseCashValueTable,
  parseCashValueText,
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

    it('parses policy-year values written as 年末', () => {
      const dataRows = [
        [{ text: '1年末' }, { text: '282.00' }],
        [{ text: '2年末' }, { text: '663.00' }],
        [{ text: '3年末' }, { text: '1296.00' }],
      ];
      const result = extractCashValueRows(dataRows, ['policyYear', 'cashValue']);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { policyYear: 1, age: null, cashValue: 282 });
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

    it('parses side-by-side repeated 保单年度末/现金价值 groups', () => {
      const boxes = [
        { text: '保单年度末', box: [[100, 50], [180, 50], [180, 70], [100, 70]], confidence: 0.98 },
        { text: '现金价值(元)', box: [[210, 50], [310, 50], [310, 70], [210, 70]], confidence: 0.98 },
        { text: '保单年度末', box: [[390, 50], [470, 50], [470, 70], [390, 70]], confidence: 0.98 },
        { text: '现金价值(元)', box: [[500, 50], [600, 50], [600, 70], [500, 70]], confidence: 0.98 },
        { text: '保单年度末', box: [[680, 50], [760, 50], [760, 70], [680, 70]], confidence: 0.98 },
        { text: '现金价值(元)', box: [[790, 50], [890, 50], [890, 70], [790, 70]], confidence: 0.98 },

        { text: '1年末', box: [[110, 90], [170, 90], [170, 110], [110, 110]], confidence: 0.99 },
        { text: '282.00', box: [[220, 90], [300, 90], [300, 110], [220, 110]], confidence: 0.99 },
        { text: '22年末', box: [[400, 90], [460, 90], [460, 110], [400, 110]], confidence: 0.99 },
        { text: '35241.00', box: [[510, 90], [590, 90], [590, 110], [510, 110]], confidence: 0.99 },
        { text: '43年末', box: [[690, 90], [750, 90], [750, 110], [690, 110]], confidence: 0.99 },
        { text: '50649.00', box: [[800, 90], [880, 90], [880, 110], [800, 110]], confidence: 0.99 },

        { text: '2年末', box: [[110, 130], [170, 130], [170, 150], [110, 150]], confidence: 0.99 },
        { text: '663.00', box: [[220, 130], [300, 130], [300, 150], [220, 150]], confidence: 0.99 },
        { text: '23年末', box: [[400, 130], [460, 130], [460, 150], [400, 150]], confidence: 0.99 },
        { text: '35838.00', box: [[510, 130], [590, 130], [590, 150], [510, 150]], confidence: 0.99 },
        { text: '44年末', box: [[690, 130], [750, 130], [750, 150], [690, 150]], confidence: 0.99 },
        { text: '51537.00', box: [[800, 130], [880, 130], [880, 150], [800, 150]], confidence: 0.99 },

        { text: '3年末', box: [[110, 170], [170, 170], [170, 190], [110, 190]], confidence: 0.99 },
        { text: '1296.00', box: [[220, 170], [300, 170], [300, 190], [220, 190]], confidence: 0.99 },
        { text: '24年末', box: [[400, 170], [460, 170], [460, 190], [400, 190]], confidence: 0.99 },
        { text: '36444.00', box: [[510, 170], [590, 170], [590, 190], [510, 190]], confidence: 0.99 },
        { text: '45年末', box: [[690, 170], [750, 170], [750, 190], [690, 190]], confidence: 0.99 },
        { text: '52440.00', box: [[800, 170], [880, 170], [880, 190], [800, 190]], confidence: 0.99 },
      ];

      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, true);
      assert.equal(result.tableType, 2);
      assert.equal(result.rows.length, 9);
      assert.deepEqual(result.rows[0], { policyYear: 1, age: null, cashValue: 282 });
      assert.deepEqual(result.rows[3], { policyYear: 22, age: null, cashValue: 35241 });
      assert.deepEqual(result.rows[8], { policyYear: 45, age: null, cashValue: 52440 });
    });

    it('does not parse year/value pairs when headers are missed', () => {
      const boxes = [
        { text: '1年末', box: [[100, 90], [160, 90], [160, 110], [100, 110]], confidence: 0.98 },
        { text: '282.00', box: [[200, 90], [280, 90], [280, 110], [200, 110]], confidence: 0.98 },
        { text: '2年末', box: [[100, 130], [160, 130], [160, 150], [100, 150]], confidence: 0.98 },
        { text: '663.00', box: [[200, 130], [280, 130], [280, 150], [200, 150]], confidence: 0.98 },
        { text: '3年末', box: [[100, 170], [160, 170], [160, 190], [100, 190]], confidence: 0.98 },
        { text: '1296.00', box: [[200, 170], [280, 170], [280, 190], [200, 190]], confidence: 0.98 },
      ];

      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'CASH_VALUE_TABLE_NOT_DETECTED');
    });
  });

  describe('parseCashValueText', () => {
    it('parses actual OCR text with repeated header sections', () => {
      const ocrText = [
        '保险合同号：990204352040',
        '盛世荣耀臻享版终身寿险（分红型）基本保险金额现金价值表',
        '投保年龄：37岁',
        '性别：女',
        '保险年期：终身',
        '保单年度末',
        '现金价值（元）',
        '1年末',
        '282.00',
        '2年末',
        '663.00',
        '3年末',
        '1296.00',
        '10年末',
        '21468:00',
        '11年未',
        '29310.00',
        '保单年度末',
        '22年末',
        '23年末',
        '24年末',
        '现金价值（元）',
        '35241.00',
        '35838.00',
        '36444.00',
        '保单年度末',
        '43年末',
        '44年末',
        '45年末',
        '现金价值（元）',
        '50649.00',
        '51537.00',
        '52440.00',
        '1.本表仅为保单年度末的现金价值，保单年度之内的现金价值金额您可以向我们查询。',
      ].join('\n');

      const result = parseCashValueText(ocrText);
      assert.equal(result.ok, true);
      assert.equal(result.rows.length, 11);
      assert.deepEqual(result.rows[0], { policyYear: 1, age: null, cashValue: 282 });
      assert.deepEqual(result.rows[4], { policyYear: 11, age: null, cashValue: 29310 });
      assert.deepEqual(result.rows[10], { policyYear: 45, age: null, cashValue: 52440 });
    });

    it('parses macOS Vision interleaved three-column cash value text', () => {
      const ocrText = [
        '保险合同号：990204352040',
        '盛世荣耀臻享版终身寿险（分红型）基本保险金额现金价值表',
        '投保年龄：37岁',
        '性别：女',
        '保险年期：终身',
        '保单年度末',
        '现金价值（元）',
        '保单年度末',
        '1年末', '282.00', '22年末',
        '2年末', '663.00', '23年末',
        '3年末', '1296.00', '24年末',
        '4年末', '2748.00', '25年末',
        '5年末', '4317.00', '26年末',
        '6年末', '6009.00', '27年末',
        '7年末', '7830.00', '28年末',
        '8年末', '9783.00', '29年末',
        '9年末', '11874.00', '30年末',
        '10年末', '21465.00', '31年末',
        '11年末', '29310.00', '32年末',
        '12年末', '29808.00', '33年末',
        '13年末', '30312.00', '34年末',
        '14年末', '30825.00', '35年末',
        '15年末', '31344.00', '36年末',
        '16年末', '31875.00', '37年末',
        '17年末', '32412.00', '38年末',
        '18年末', '32958.00', '39年末',
        '19年末', '33516.00', '40年末',
        '20年末', '34080.00', '41年末',
        '21年末', '34656.00', '42年末',
        '现金价值（元）',
        '35241.00', '35838.00', '36444.00', '37080.00', '37728.00', '38385.00', '39057.00',
        '39738.00', '40434.00', '41139.00', '41859.00', '42588.00', '43332.00', '44091.00',
        '44862.00', '45645.00', '46443.00', '47256.00', '48081.00', '48924.00', '49779.00',
        '保单年度末',
        '43年末', '44年末', '45年末', '46年末', '47年未', '48年未', '49年未',
        '50年未', '51年未', '52年未', '53年末', '54年末', '55年末', '56年末',
        '57年末', '58年末', '59年末', '60年末', '61年末', '62年末', '63年末',
        '现金价值（元）',
        '50649.00', '51537.00', '52440.00', '53355.00', '54291.00', '55239.00', '56208.00',
        '57192.00', '58191.00', '59211.00', '60246.00', '61299.00', '62373.00', '63465.00',
        '64575.00', '65706.00', '66855.00', '68025.00', '69216.00', '70428.00', '71658.00',
        '1.本表仅为保单年度末的现金价值，保单年度之内的现金价值金额您可以向我们查询。',
      ].join('\n');

      const result = parseCashValueText(ocrText, { source: 'macos_vision' });
      assert.equal(result.ok, true);
      assert.equal(result.source, 'macos_vision');
      assert.equal(result.rowCount, 63);
      assert.deepEqual(result.rows[0], { policyYear: 1, age: null, cashValue: 282 });
      assert.deepEqual(result.rows[21], { policyYear: 22, age: null, cashValue: 35241 });
      assert.deepEqual(result.rows[41], { policyYear: 42, age: null, cashValue: 49779 });
      assert.deepEqual(result.rows[62], { policyYear: 63, age: null, cashValue: 71658 });
    });

    it('recovers macOS Vision text with split decimal values and OCR year suffix errors', () => {
      const ocrText = [
        '保单年度末',
        '现金价值（元）',
        '保单年度末',
        '1年末', '336.00', '22年末',
        '2年末', '1272.00', '23年末',
        '3年末', '2304.00', '24年末',
        '16年木', '26472.00', '25年末',
        '现金价值（元）',
        '29976.00',
        '30600.00',
        '31272.',
        '00',
        '31896.00',
        '保单年度末',
        '43年末',
        '44年末',
        '45年末',
        '现金价值（元）',
        '46224.00',
        '46680.00',
        '47088.00',
        '1.本表仅为保单年度末的现金价值，保单年度之内的现金价值金额您可以向我们查询。',
      ].join('\n');

      const result = parseCashValueText(ocrText, { source: 'macos_vision' });
      assert.equal(result.ok, true);
      assert.equal(result.rowCount, 11);
      assert.deepEqual(result.rows.find((row) => row.policyYear === 16), { policyYear: 16, age: null, cashValue: 26472 });
      assert.deepEqual(result.rows.find((row) => row.policyYear === 22), { policyYear: 22, age: null, cashValue: 29976 });
      assert.deepEqual(result.rows.find((row) => row.policyYear === 24), { policyYear: 24, age: null, cashValue: 31272 });
      assert.deepEqual(result.rows.find((row) => row.policyYear === 45), { policyYear: 45, age: null, cashValue: 47088 });
    });

    it('fails when text does not contain table headers', () => {
      const result = parseCashValueText('1年末\n282.00\n2年末\n663.00\n3年末\n1296.00');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'CASH_VALUE_TABLE_NOT_DETECTED');
    });
  });
});
