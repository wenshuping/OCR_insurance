#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalProductKey,
  isLegacyCalculationEnabled,
  quarantineCardPayload,
  quarantineIndicatorPayload,
} from '../server/deepseek-responsibility-repair.mjs';

function text(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function assertNewFile(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  if (fs.existsSync(filePath)) throw new Error(`${label} already exists: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function quarantineDeepSeekCalculations({
  dbPath,
  backupPath,
  receiptPath,
  now = new Date().toISOString(),
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedBackupPath = path.resolve(backupPath);
  const resolvedReceiptPath = path.resolve(receiptPath);
  assertNewFile(resolvedBackupPath, 'Backup');
  assertNewFile(resolvedReceiptPath, 'Receipt');

  const db = new DatabaseSync(resolvedDbPath);
  const productKeys = new Set();
  const products = [];
  try {
    for (const row of db.prepare(`
      SELECT company, product_name, payload
        FROM product_responsibility_artifacts
       WHERE publisher_version = '2026-07-23-unified-responsibility-artifact-v3'
       ORDER BY company, product_name
    `).iterate()) {
      const artifact = JSON.parse(row.payload);
      if (!isLegacyCalculationEnabled(artifact)) continue;
      const key = canonicalProductKey(row.company, row.product_name);
      productKeys.add(key);
      products.push({ company: row.company, productName: row.product_name });
    }

    db.prepare('VACUUM INTO ?').run(resolvedBackupPath);
    const updatedIndicators = [];
    const updatedCards = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateIndicator = db.prepare(`
        UPDATE insurance_indicator_records
           SET payload = ?
         WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, company, product_name, liability, payload
          FROM insurance_indicator_records
         WHERE id LIKE 'ind_pipeline_%'
         ORDER BY company, product_name, liability, id
      `).iterate()) {
        if (!productKeys.has(canonicalProductKey(row.company, row.product_name))) continue;
        const result = quarantineIndicatorPayload(JSON.parse(row.payload));
        if (!result.changed) continue;
        updateIndicator.run(JSON.stringify(result.payload), row.id);
        updatedIndicators.push({
          id: row.id,
          company: row.company,
          productName: row.product_name,
          liability: row.liability,
        });
      }

      const updateCard = db.prepare(`
        UPDATE product_responsibility_cards
           SET calculation_status = 'manual_review',
               calculation_reason = ?,
               payload = ?
         WHERE id = ?
      `);
      for (const row of db.prepare(`
        SELECT id, company, product_name, title, calculation_reason, payload
          FROM product_responsibility_cards
         WHERE id LIKE 'product_responsibility_card_pipeline_%'
         ORDER BY company, product_name, title, id
      `).iterate()) {
        if (!productKeys.has(canonicalProductKey(row.company, row.product_name))) continue;
        const result = quarantineCardPayload(JSON.parse(row.payload));
        if (!result.changed) continue;
        const reason = [
          text(row.calculation_reason),
          '旧 DeepSeek 可计算状态已暂停，等待同源修复复核',
        ].filter(Boolean).join('；');
        updateCard.run(reason, JSON.stringify(result.payload), row.id);
        updatedCards.push({
          id: row.id,
          company: row.company,
          productName: row.product_name,
          title: row.title,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const remaining = [];
    for (const row of db.prepare(`
      SELECT id, company, product_name, liability, payload
        FROM insurance_indicator_records
       WHERE id LIKE 'ind_pipeline_%'
       ORDER BY company, product_name, liability, id
    `).iterate()) {
      if (!productKeys.has(canonicalProductKey(row.company, row.product_name))) continue;
      if (JSON.parse(row.payload).calculationEligible === true) {
        remaining.push({
          id: row.id,
          company: row.company,
          productName: row.product_name,
          liability: row.liability,
        });
      }
    }
    const quickCheck = db.prepare('PRAGMA quick_check').get();
    const receipt = {
      generatedAt: now,
      dbPath: resolvedDbPath,
      backupPath: resolvedBackupPath,
      legacyCalculableProducts: products,
      updatedIndicators,
      updatedCards,
      remainingEnabledPipelineIndicators: remaining,
      quickCheck: Object.values(quickCheck)[0],
    };
    fs.writeFileSync(resolvedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const receipt = quarantineDeepSeekCalculations({
    dbPath: readArg('db-path', '.runtime/local/policy-ocr.sqlite'),
    backupPath: readArg('backup-path'),
    receiptPath: readArg('receipt-path'),
  });
  console.log(JSON.stringify({
    legacyCalculableProducts: receipt.legacyCalculableProducts.length,
    updatedIndicators: receipt.updatedIndicators.length,
    updatedCards: receipt.updatedCards.length,
    remainingEnabledPipelineIndicators: receipt.remainingEnabledPipelineIndicators.length,
    backupPath: receipt.backupPath,
    quickCheck: receipt.quickCheck,
  }, null, 2));
}
