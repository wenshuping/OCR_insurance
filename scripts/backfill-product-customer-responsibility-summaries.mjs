#!/usr/bin/env node
import { generateProductCustomerResponsibilitySummary } from '../server/product-customer-responsibility-summary.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const DEFAULT_DB_PATH = '.runtime/local/policy-ocr.sqlite';
const V22_SUMMARY_VERSION = 'customer-summary-v22-structured-rag';

function text(value) {
  return String(value ?? '').trim();
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseLimit(value) {
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
}

function resolveSummaryVersion(value) {
  const version = text(value);
  return version === 'v22' ? V22_SUMMARY_VERSION : version || V22_SUMMARY_VERSION;
}

export function parseBackfillArgs(argv = process.argv.slice(2)) {
  const args = {
    summaryVersion: V22_SUMMARY_VERSION,
    limit: 50,
    company: '',
    category: '',
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version') {
      args.summaryVersion = resolveSummaryVersion(readValue(argv, index, arg));
      index += 1;
    } else if (arg === '--limit') {
      args.limit = parseLimit(readValue(argv, index, arg));
      index += 1;
    } else if (arg === '--company') {
      args.company = text(readValue(argv, index, arg));
      index += 1;
    } else if (arg === '--category') {
      args.category = text(readValue(argv, index, arg));
      index += 1;
    } else if (arg === '--db') {
      args.dbPath = text(readValue(argv, index, arg));
      index += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    }
  }

  return args;
}

export function selectBackfillProducts({ knowledgeRecords = [], company = '', limit = 50 } = {}) {
  const companyFilter = text(company);
  const maxRows = parseLimit(limit);
  const seen = new Set();
  const products = [];

  for (const record of Array.isArray(knowledgeRecords) ? knowledgeRecords : []) {
    const row = {
      company: text(record?.company),
      productName: text(record?.productName || record?.product_name || record?.title),
    };
    if (!row.company || !row.productName) continue;
    if (companyFilter && row.company !== companyFilter) continue;

    const key = `${row.company}\n${row.productName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    products.push(row);
    if (products.length >= maxRows) break;
  }

  return products;
}

export async function backfillProductCustomerResponsibilitySummaries({
  dbPath = DEFAULT_DB_PATH,
  summaryVersion = V22_SUMMARY_VERSION,
  limit = 50,
  company = '',
  category = '',
  dryRun = false,
  storeFactory = createSqliteStateStore,
  generateSummary = generateProductCustomerResponsibilitySummary,
} = {}) {
  const store = await storeFactory({ dbPath });
  try {
    const state = await store.load();
    const products = selectBackfillProducts({
      knowledgeRecords: state.knowledgeRecords,
      company,
      limit,
    });
    const report = {
      dbPath,
      summaryVersion,
      category,
      dryRun: Boolean(dryRun),
      total: products.length,
      generated: 0,
      failed: 0,
      skippedDryRun: 0,
      products,
      failures: [],
    };

    for (const product of products) {
      if (dryRun) {
        report.skippedDryRun += 1;
        continue;
      }

      try {
        const result = await generateSummary({
          state,
          db: store.db,
          input: { company: product.company, productName: product.productName },
          findSummary: store.findProductCustomerResponsibilitySummary
            ? (query) => store.findProductCustomerResponsibilitySummary(query)
            : undefined,
          persistSummary: store.persistProductCustomerResponsibilitySummary
            ? (summary) => store.persistProductCustomerResponsibilitySummary({ state, summary })
            : undefined,
          persistGenerationRun: store.persistProductCustomerSummaryGenerationRun
            ? (run) => store.persistProductCustomerSummaryGenerationRun({ state, run })
            : undefined,
        });
        if (result?.ok) {
          report.generated += 1;
        } else {
          report.failed += 1;
          report.failures.push({ ...product, status: text(result?.status) || 'not_ready' });
        }
      } catch (error) {
        report.failed += 1;
        report.failures.push({
          ...product,
          status: 'failed',
          message: text(error?.message),
        });
      }
    }

    return report;
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseBackfillArgs();
  const report = await backfillProductCustomerResponsibilitySummaries(args);
  console.log(JSON.stringify(report, null, 2));
}
