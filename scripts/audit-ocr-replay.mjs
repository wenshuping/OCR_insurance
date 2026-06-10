#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { extractPolicyFieldsFromText } from '../ocr-service/insurance-ocr.service.mjs';
import { enhancePolicyScanWithOcrMapping } from '../server/policy-ocr-mapping.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, '.runtime', 'policy-ocr.sqlite');

function readArg(args, name, fallback = '') {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function amountText(value) {
  const raw = text(value).replace(/[,，]/gu, '').replace(/[¥￥元圆]/gu, '');
  if (!raw) return '';
  const number = Number(raw);
  return Number.isFinite(number) ? String(Math.round(number)) : raw;
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row?.name);
}

function loadKnowledgeRecords(db) {
  if (!tableExists(db, 'knowledge_records')) return [];
  return db
    .prepare(`
      SELECT
        id,
        company,
        product_name AS productName,
        json_extract(payload, '$.productType') AS productType,
        json_extract(payload, '$.official') AS official,
        json_extract(payload, '$.canonicalProductId') AS canonicalProductId
      FROM knowledge_records
      ORDER BY id ASC
    `)
    .all()
    .map((row) => ({
      id: row.id,
      company: text(row.company),
      productName: text(row.productName),
      productType: text(row.productType),
      official: row.official === true || row.official === 1 || row.official === 'true',
      canonicalProductId: text(row.canonicalProductId),
    }))
    .filter((row) => row.company || row.productName);
}

function loadPayloadRows(db, tableName, idColumn) {
  if (!tableExists(db, tableName)) return [];
  return db
    .prepare(`SELECT ${idColumn} AS rowId, payload FROM ${tableName} ORDER BY ${idColumn} ASC`)
    .all()
    .map((row) => ({
      rowId: row.rowId,
      payload: parseJson(row.payload, null),
    }))
    .filter((row) => row.payload);
}

function replayOcrText(ocrText, state) {
  const extracted = extractPolicyFieldsFromText(ocrText);
  const enhanced = enhancePolicyScanWithOcrMapping({
    scan: { ok: true, data: extracted, ocrText },
    state,
  });
  return enhanced.data || extracted;
}

function summarizePlan(plan = {}) {
  return {
    role: text(plan.role),
    name: text(plan.name),
    amount: amountText(plan.amount),
    coveragePeriod: text(plan.coveragePeriod),
    paymentMode: text(plan.paymentMode),
    paymentPeriod: text(plan.paymentPeriod),
    premium: amountText(plan.premium),
  };
}

function summarizePolicy(data = {}) {
  return {
    company: text(data.company),
    name: text(data.name),
    applicant: text(data.applicant),
    insured: text(data.insured),
    beneficiary: text(data.beneficiary),
    policyNumber: text(data.policyNumber),
    date: text(data.date),
    amount: amountText(data.amount),
    firstPremium: amountText(data.firstPremium),
    paymentPeriod: text(data.paymentPeriod),
    coveragePeriod: text(data.coveragePeriod),
    plans: (Array.isArray(data.plans) ? data.plans : []).map(summarizePlan),
  };
}

function auditPlan(plan, index) {
  const issues = [];
  const role = text(plan.role);
  const label = `${index + 1}:${role || 'unknown'}:${text(plan.name) || 'unnamed'}`;
  if (!text(plan.name)) issues.push(`${label} missing name`);
  if (role !== 'linked_account' && !amountText(plan.amount)) issues.push(`${label} missing amount`);
  if (!text(plan.coveragePeriod)) issues.push(`${label} missing coveragePeriod`);
  if (!text(plan.paymentMode)) issues.push(`${label} missing paymentMode`);
  if (!text(plan.paymentPeriod)) issues.push(`${label} missing paymentPeriod`);
  if (role !== 'linked_account' && !amountText(plan.premium)) issues.push(`${label} missing premium`);
  return issues;
}

function auditFormalPolicy(data = {}) {
  const issues = [];
  for (const field of ['company', 'name', 'applicant', 'insured', 'date', 'amount', 'firstPremium', 'paymentPeriod', 'coveragePeriod']) {
    const value = field === 'amount' || field === 'firstPremium' ? amountText(data[field]) : text(data[field]);
    if (!value) issues.push(`missing ${field}`);
  }
  const plans = Array.isArray(data.plans) ? data.plans : [];
  if (!plans.length) issues.push('missing plans');
  plans.forEach((plan, index) => issues.push(...auditPlan(plan, index)));
  return [...new Set(issues)];
}

function auditPendingScan(data = {}) {
  const issues = [];
  for (const field of ['company', 'name', 'amount', 'firstPremium', 'paymentPeriod', 'coveragePeriod']) {
    const value = field === 'amount' || field === 'firstPremium' ? amountText(data[field]) : text(data[field]);
    if (!value) issues.push(`missing ${field}`);
  }
  const plans = Array.isArray(data.plans) ? data.plans : [];
  plans.forEach((plan, index) => issues.push(...auditPlan(plan, index)));
  return [...new Set(issues)];
}

function replayRows(rows, state, { source }) {
  return rows.map((row) => {
    const payload = row.payload || {};
    const scan = payload.scan && typeof payload.scan === 'object' ? payload.scan : {};
    const ocrText = text(payload.ocrText || payload.rawOcrText || scan.ocrText);
    const data = ocrText ? replayOcrText(ocrText, state) : {};
    const summary = summarizePolicy(data);
    const issues = source === 'policies' ? auditFormalPolicy(data) : auditPendingScan(data);
    return {
      rowId: row.rowId,
      ocrChars: ocrText.length,
      issues,
      summary,
    };
  });
}

function buildSection(rows) {
  return {
    count: rows.length,
    issueCount: rows.filter((row) => row.issues.length).length,
    rows,
  };
}

export function auditOcrReplay({ dbPath = DEFAULT_DB_PATH, includePending = true, strictPending = false } = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) {
    throw new Error(`DB_NOT_FOUND: ${resolvedDbPath}`);
  }

  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    const state = { knowledgeRecords: loadKnowledgeRecords(db) };
    const policyRows = loadPayloadRows(db, 'policies', 'id');
    const pendingRows = includePending ? loadPayloadRows(db, 'pending_scans', 'row_id') : [];
    const policies = buildSection(replayRows(policyRows, state, { source: 'policies' }));
    const pendingScans = buildSection(replayRows(pendingRows, state, { source: 'pending_scans' }));
    const ok = policies.issueCount === 0 && (!strictPending || pendingScans.issueCount === 0);
    return {
      ok,
      dbPath: resolvedDbPath,
      strictPending,
      knowledgeRecordCount: state.knowledgeRecords.length,
      policies,
      pendingScans,
    };
  } finally {
    db.close();
  }
}

function formatIssueRows(rows, prefix) {
  return rows
    .filter((row) => row.issues.length)
    .map((row) => `  - ${prefix} ${row.rowId}: ${row.issues.join('; ')}`)
    .join('\n');
}

function printHumanReport(report) {
  console.log('OCR replay audit');
  console.log(`DB: ${report.dbPath}`);
  console.log(`Knowledge records: ${report.knowledgeRecordCount}`);
  console.log(`Formal policies: ${report.policies.count} checked, ${report.policies.issueCount} issue rows`);
  const policyIssues = formatIssueRows(report.policies.rows, 'policy');
  if (policyIssues) console.log(policyIssues);
  console.log(`Pending scans: ${report.pendingScans.count} checked, ${report.pendingScans.issueCount} warning rows`);
  const pendingIssues = formatIssueRows(report.pendingScans.rows, 'pending row');
  if (pendingIssues) console.log(pendingIssues);
  console.log(report.ok ? 'Result: pass' : 'Result: fail');
}

function main(args = process.argv.slice(2)) {
  const dbPath = readArg(args, '--db-path', DEFAULT_DB_PATH);
  const includePending = !hasFlag(args, '--no-pending');
  const strictPending = hasFlag(args, '--strict-pending');
  const asJson = hasFlag(args, '--json');
  const report = auditOcrReplay({ dbPath, includePending, strictPending });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
