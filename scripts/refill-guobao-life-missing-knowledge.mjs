import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { allocateId, createInitialState } from '../server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from '../server/policy-knowledge.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const statePath = path.resolve(process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));
const crawlerPath = path.join(projectRoot, 'server', 'scrapling-policy-crawler.py');
const swiftOcrPath = path.join(projectRoot, 'ocr-service', 'scripts', 'pdf_responsibility_vision.swift');
const scraplingPython = process.env.SCRAPLING_PYTHON_BIN || '/Users/wenshuping/Documents/Scrapling/.venv/bin/python';
const scraplingCwd = process.env.SCRAPLING_PROJECT_DIR || '/Users/wenshuping/Documents/Scrapling';
const outputMarker = '__POLICY_KNOWLEDGE_JSON__';
const officialSource = 'https://www.panda-assets.com/PublicInfo/Index/114';

function trim(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function runCrawler(payload, { maxBuffer = 320 * 1024 * 1024 } = {}) {
  const result = spawnSync(scraplingPython, [crawlerPath], {
    cwd: scraplingCwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(`国宝人寿修复 crawler 调用失败\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/u)
    .reverse()
    .find((item) => item.includes(outputMarker));
  if (!line) throw new Error(`国宝人寿修复 crawler 未返回 JSON\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice(line.indexOf(outputMarker) + outputMarker.length));
}

function localGuobaoUrls(state) {
  return new Set(
    (state.knowledgeRecords || [])
      .filter((record) => trim(record.company) === '国宝人寿')
      .map((record) => trim(record.url))
      .filter(Boolean),
  );
}

async function downloadPdf(url) {
  const response = await fetch(url, {
    headers: {
      Referer: officialSource,
      'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: trim(response.headers.get('content-type')),
    buffer,
  };
}

function runSwiftPdfOcr(pdfPath, maxPages) {
  const args = [swiftOcrPath, pdfPath];
  if (maxPages) args.push(String(maxPages));
  const result = spawnSync('/usr/bin/swift', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 80 * 1024 * 1024,
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n') || 'Swift PDF OCR failed');
  }
  return JSON.parse(String(result.stdout || '{}'));
}

function focusedResponsibilityExcerpt(text) {
  const result = runCrawler({ mode: 'focused_responsibility_excerpt', text }, { maxBuffer: 120 * 1024 * 1024 });
  return trim(result.pageText);
}

function buildRecord(task, pageText, meta = {}) {
  const now = new Date().toISOString();
  const productName = trim(task.productName);
  const label = trim(task.label) || (trim(task.materialType) === 'product_manual' ? '产品说明书' : '产品条款');
  return {
    company: '国宝人寿',
    productName,
    productType: trim(task.productType),
    salesStatus: trim(task.salesStatus),
    title: `${productName}${label}`,
    url: trim(task.url),
    snippet: `国宝人寿官网${label}，已通过本机 Vision OCR 补取保险责任正文段。`,
    pageText,
    sourceType: 'pdf',
    materialType: trim(task.materialType),
    official: true,
    evidenceLabel: '本地知识库官方资料',
    evidenceLevel: 'insurer_official',
    officialDomain: 'www.panda-assets.com',
    parser: 'scrapling_guobao_life_pdf_vision_ocr_repair',
    qualityStatus: 'valid_complete',
    qualityReason: '',
    discoveredAt: now,
    lastFetchedAt: now,
    updatedAt: now,
    pages: meta.pages || 0,
    bytes: meta.bytes || 0,
    ocrTextChars: meta.ocrTextChars || 0,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const saleStatus = readArg('sale-status', process.env.GUOBAO_LIFE_SALE_STATUS || 'all');
  const normalMaxWorkers = readNumberArg('normal-max-workers', 1);
  const maxOcr = readNumberArg('max-ocr', 0);
  const maxOcrPages = readNumberArg('max-ocr-pages', 0);
  const stamp = timestampForFile();
  const state = readJson(statePath, createInitialState());
  if (!Number(state.nextId)) state.nextId = 1;

  const beforeTotal = (state.knowledgeRecords || []).filter((record) => trim(record.company) === '国宝人寿').length;
  const beforeUrls = localGuobaoUrls(state);

  const normalResult = runCrawler({
    mode: 'guobao_life_pages',
    company: '国宝人寿',
    saleStatus,
    maxWorkers: normalMaxWorkers,
    skipUrls: [...beforeUrls],
  });
  const normalSaved = dryRun ? [] : upsertKnowledgeRecords(state, normalResult.records || [], { allocateId });
  const plannedNormalUrls = new Set((normalResult.records || []).map((record) => trim(record.url)).filter(Boolean));
  const afterNormalUrls = dryRun ? new Set([...beforeUrls, ...plannedNormalUrls]) : localGuobaoUrls(state);

  const taskResult = runCrawler({
    mode: 'guobao_life_material_tasks',
    company: '国宝人寿',
    saleStatus,
  });
  const allTasks = taskResult.tasks || [];
  let missingTasks = allTasks.filter((task) => !afterNormalUrls.has(trim(task.url)));
  if (maxOcr) missingTasks = missingTasks.slice(0, maxOcr);

  const ocrRecords = [];
  const failed = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guobao-life-ocr-'));
  try {
    for (const task of missingTasks) {
      const url = trim(task.url);
      try {
        const pdf = await downloadPdf(url);
        if (pdf.status < 200 || pdf.status >= 300 || !pdf.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          failed.push({
            productName: trim(task.productName),
            materialType: trim(task.materialType),
            url,
            reason: 'pdf_download_failed',
            status: pdf.status,
            bytes: pdf.buffer.length,
            contentType: pdf.contentType,
          });
          continue;
        }
        const pdfPath = path.join(tempDir, `${ocrRecords.length + failed.length + 1}.pdf`);
        fs.writeFileSync(pdfPath, pdf.buffer);
        const ocr = runSwiftPdfOcr(pdfPath, maxOcrPages);
        const ocrText = trim(ocr.text);
        const pageText = focusedResponsibilityExcerpt(ocrText);
        if (!pageText || !pageText.includes('保险责任')) {
          failed.push({
            productName: trim(task.productName),
            materialType: trim(task.materialType),
            url,
            reason: 'ocr_responsibility_not_found',
            pages: ocr.pages || 0,
            processedPages: ocr.processedPages || 0,
            ocrTextChars: ocrText.length,
            preview: ocrText.slice(0, 500),
          });
          continue;
        }
        ocrRecords.push(buildRecord(task, pageText, {
          pages: ocr.pages || 0,
          bytes: pdf.buffer.length,
          ocrTextChars: ocrText.length,
        }));
        console.log(`[guobao-life] OCR 修复成功 ${ocrRecords.length}/${missingTasks.length}: ${trim(task.productName)}`);
      } catch (error) {
        failed.push({
          productName: trim(task.productName),
          materialType: trim(task.materialType),
          url,
          reason: 'ocr_exception',
          error: String(error?.message || error).slice(0, 500),
        });
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const ocrSaved = dryRun ? [] : upsertKnowledgeRecords(state, ocrRecords, { allocateId });
  if (!dryRun) writeJson(statePath, state);

  const afterUrls = dryRun ? new Set([...afterNormalUrls, ...ocrRecords.map((record) => record.url)]) : localGuobaoUrls(state);
  const remainingMissing = allTasks.filter((task) => !afterUrls.has(trim(task.url)));
  const newSaved = [...normalSaved, ...ocrSaved].filter((record) => !beforeUrls.has(trim(record.url)));
  const ids = newSaved.map((record) => Number(record.id)).filter(Number.isFinite).sort((left, right) => left - right);
  const report = {
    ok: remainingMissing.length === 0,
    dryRun,
    saleStatus,
    normalMaxWorkers,
    officialTaskCount: allTasks.length,
    beforeTotal,
    normalCrawledRecordCount: (normalResult.records || []).length,
    normalSavedCount: normalSaved.length,
    ocrAttemptCount: missingTasks.length,
    ocrRecordCount: ocrRecords.length,
    ocrSavedCount: ocrSaved.length,
    newSavedCount: newSaved.length,
    newSavedMinId: ids[0] || null,
    newSavedMaxId: ids.at(-1) || null,
    remainingMissingCount: remainingMissing.length,
    failed,
    remainingMissing,
    statePath,
  };
  const reportPath = path.join(runtimeDir, `guobao-life-missing-refill-report-${stamp}.json`);
  writeJson(reportPath, report);
  console.log(JSON.stringify({ ...report, reportPath, failed: failed.slice(0, 10), remainingMissing: remainingMissing.slice(0, 10) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
