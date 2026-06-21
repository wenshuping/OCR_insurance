import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildLocalCompanyInventory,
  buildLocalCompanyQueries,
} from '../scripts/jrcpcx-local-company-pdf-only-backfill.mjs';

test('buildLocalCompanyInventory includes local human-insurance companies and excludes property-only companies', () => {
  const records = [
    {
      id: 1,
      company: '阳光人寿保险股份有限公司',
      productName: '阳光人寿重大疾病保险',
      productType: '健康保险-疾病保险',
      url: 'https://example.test/sunshine',
      pdfLocalPath: '/tmp/sunshine.pdf',
    },
    {
      id: 2,
      company: '某财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      url: 'https://example.test/property',
    },
    {
      id: 3,
      company: '友邦人寿保险有限公司',
      productName: '友邦附加意外伤害保险',
      productType: '',
      pageText: '保险责任包括意外身故保险金。',
      url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia&t=1',
      pdfLocalPath: '/tmp/aia.pdf',
    },
  ];

  const inventory = buildLocalCompanyInventory(records);

  assert.equal(inventory.length, 3);
  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [
      ['阳光人寿保险股份有限公司', true, ''],
      ['友邦人寿保险有限公司', true, ''],
      ['某财产保险股份有限公司', false, 'property_insurance_only'],
    ],
  );
  assert.equal(inventory[0].localKnowledgeRecordCount, 1);
  assert.equal(inventory[1].localJrcpcxClauseUrlCount, 1);
  assert.equal(inventory[1].localPdfPathCount, 1);
});

test('buildLocalCompanyQueries creates human-insurance status shards for included companies only', () => {
  const inventory = [
    { company: '阳光人寿保险股份有限公司', included: true },
    { company: '某财产保险股份有限公司', included: false, excludeReason: 'property_insurance_only' },
  ];

  const queries = buildLocalCompanyQueries(inventory);

  assert.deepEqual(
    queries.map((row) => [row.deptName, row.productTypeLabel, row.productTermLabel, row.productStateLabel]),
    [
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '在售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停用'],
    ],
  );
});

test('property-only rows with generic responsibility text are excluded from inventory and queries', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 4,
      company: '某财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      pageText: '保险责任包括车辆损失保险责任。',
    },
  ]);

  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [['某财产保险股份有限公司', false, 'property_insurance_only']],
  );
  assert.deepEqual(buildLocalCompanyQueries(inventory), []);
});

test('buildLocalCompanyInventory counts JRCPCX clause URL after non-JRCPCX source URL candidates', () => {
  const inventory = buildLocalCompanyInventory([
    {
      id: 5,
      company: '友邦人寿保险有限公司',
      productName: '友邦终身寿险',
      productType: '人身保险类',
      url: 'https://example.test/non-jrcpcx-detail',
      pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia-clause&t=1',
    },
  ]);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].included, true);
  assert.equal(inventory[0].localJrcpcxClauseUrlCount, 1);
});
