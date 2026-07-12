import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const BUNDLED_PYTHON = '/Users/wenshuping/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const VERSION = '2026-06-26-official-pdf-text-refill-target-scope';

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parsePayload(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSpaces(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/\r/gu, '\n')
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/\n\s+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n');
}

function textFromPayload(payload = {}) {
  return normalizeSpaces([
    payload.pageText,
    payload.responsibility,
    payload.snippet,
    payload.analysis?.report,
    ...(Array.isArray(payload.analysis?.coverageTable)
      ? payload.analysis.coverageTable.map((row) => Object.values(row || {}).join(' '))
      : []),
  ].filter(Boolean).join('\n'));
}

function isOfficialPayload(payload = {}) {
  return payload.official === true
    || trim(payload.evidenceLevel) === 'insurer_official'
    || trim(payload.sourceEvidenceLevel) === 'insurer_official'
    || trim(payload.evidenceLabel).includes('官方');
}

function tableExists(db, tableName) {
  return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName));
}

function isPdfUrl(url) {
  return /\.pdf(?:$|[?#])/iu.test(trim(url));
}

function entryNameFromUrl(url) {
  const text = trim(url);
  const marker = '#entry=';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return '';
  const rawEntry = text.slice(markerIndex + marker.length);
  try {
    return decodeURIComponent(rawEntry);
  } catch {
    return rawEntry;
  }
}

function urlWithoutHash(url) {
  return trim(url).split('#')[0];
}

function isOfficialMaterialUrl(url) {
  const text = trim(url);
  if (isPdfUrl(text)) return true;
  return /\.(?:zip|rar)(?:$|[?#])/iu.test(text) && /\.pdf$/iu.test(entryNameFromUrl(text));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupSqlite(dbPath) {
  if (!(await exists(dbPath))) return [];
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const label = dbPath.includes(`${path.sep}local${path.sep}`) ? 'local-policy-ocr' : 'policy-ocr';
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const backupBase = path.join(backupDir, `${label}-before-no-indicator-pdf-text-refill-${stamp}.sqlite`);
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (!(await exists(source))) continue;
    const target = `${backupBase}${suffix}`;
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return copied;
}

function decodePdfHexText(value = '') {
  const normalized = String(value || '').replace(/\s+/gu, '');
  if (!normalized) return '';
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes.readUInt16BE(index));
    }
    return output;
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodePdfLiteralText(value = '') {
  return value.replace(/\\([nrtbf()\\])/gu, (_, token) => {
    const replacements = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      '(': '(',
      ')': ')',
      '\\': '\\',
    };
    return replacements[token] || token;
  });
}

function extractPdfActualText(buffer) {
  const raw = Buffer.from(buffer || []).toString('latin1');
  if (!raw) return '';
  const values = [];
  const pattern = /\/ActualText\s*(?:\((.*?)\)|<([0-9A-Fa-f\s]+)>)/gsu;
  for (const match of raw.matchAll(pattern)) {
    const decoded = match[1] !== undefined ? decodePdfLiteralText(match[1]) : decodePdfHexText(match[2]);
    const text = trim(decoded);
    if (text) values.push(text);
  }
  return values.join('\n');
}

function pythonPath() {
  return trim(process.env.POLICY_OCR_PYTHON) || BUNDLED_PYTHON;
}

function extractPdfTextWithPython(buffer) {
  const result = spawnSync(
    pythonPath(),
    [
      '-c',
      [
        'import base64, io, sys',
        'from pypdf import PdfReader',
        'data = base64.b64decode(sys.stdin.read())',
        'reader = PdfReader(io.BytesIO(data))',
        "print('\\n'.join((page.extract_text() or '') for page in reader.pages))",
      ].join('\n'),
    ],
    {
      input: Buffer.from(buffer || []).toString('base64'),
      encoding: 'utf8',
      maxBuffer: 60 * 1024 * 1024,
      timeout: Number(process.env.POLICY_OCR_PDF_EXTRACT_TIMEOUT_MS || 20000),
    },
  );
  if (result.status !== 0 || result.error) return '';
  return trim(result.stdout);
}

function extractPdfText(buffer) {
  return normalizeSpaces(extractPdfActualText(buffer) || extractPdfTextWithPython(buffer));
}

function mergeRanges(ranges, textLength) {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.min(textLength, end)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 300) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function buildFocusedOfficialText(rawText, { maxChars = 32000 } = {}) {
  const text = normalizeSpaces(rawText);
  if (text.length <= maxChars) return text;
  const anchorPatterns = [
    /保险责任/gu,
    /保险利益(?:表)?/gu,
    /保障(?:范围|计划|内容|责任|表)/gu,
    /给付(?:规则|比例|限额|标准|金额)/gu,
    /赔付(?:规则|比例|限额|标准|金额)/gu,
    /免赔额|起付金额|年限额|年度限额|累计限额/gu,
    /日津贴|住院日额|保险单位数|账户价值|现金价值/gu,
  ];
  const ranges = [];
  for (const pattern of anchorPatterns) {
    let match = pattern.exec(text);
    while (match) {
      ranges.push([match.index - 1000, match.index + 9000]);
      if (ranges.length > 24) break;
      match = pattern.exec(text);
    }
  }
  if (!ranges.length) return text.slice(0, maxChars);
  const slices = [];
  for (const [start, end] of mergeRanges(ranges, text.length)) {
    slices.push(text.slice(start, end));
    if (slices.join('\n\n').length >= maxChars) break;
  }
  return normalizeSpaces(slices.join('\n\n')).slice(0, maxChars);
}

async function fetchBuffer(url, { timeoutMs = 15000, accept = '*/*' } = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: accept,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: trim(response.headers.get('content-type')),
  };
}

async function extractArchiveEntryBuffer(archiveBuffer, entryName, { timeoutMs = 15000 } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'official-terms-archive-'));
  const archivePath = path.join(tempDir, 'archive.bin');
  try {
    await fs.writeFile(archivePath, archiveBuffer);
    const runExtract = (name) => spawnSync('bsdtar', ['-xOf', archivePath, name], {
      encoding: 'buffer',
      maxBuffer: 80 * 1024 * 1024,
      timeout: timeoutMs,
    });
    let extract = runExtract(entryName);
    if (extract.status !== 0 || extract.error || !extract.stdout?.length) {
      const list = spawnSync('bsdtar', ['-tf', archivePath], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
      });
      const entries = String(list.stdout || '')
        .split(/\r?\n/gu)
        .map((item) => trim(item))
        .filter(Boolean);
      const expectedBase = path.basename(entryName);
      const fallbackEntry = entries.find((item) => item === entryName)
        || entries.find((item) => path.basename(item) === expectedBase)
        || entries.find((item) => item.endsWith(entryName));
      if (fallbackEntry) extract = runExtract(fallbackEntry);
    }
    if (extract.status !== 0 || extract.error || !extract.stdout?.length) {
      const stderr = String(extract.stderr || '').slice(0, 200);
      throw new Error(`archive_entry_extract_failed:${stderr || extract.error?.message || 'unknown'}`);
    }
    const pdfBuffer = Buffer.from(extract.stdout);
    if (!pdfBuffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('archive_entry_not_pdf');
    }
    return pdfBuffer;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchPdfBuffer(url, { timeoutMs = 15000 } = {}) {
  const entryName = entryNameFromUrl(url);
  if (entryName) {
    const { buffer } = await fetchBuffer(urlWithoutHash(url), {
      timeoutMs,
      accept: 'application/pdf,application/zip,application/x-rar-compressed,*/*',
    });
    return extractArchiveEntryBuffer(buffer, entryName, { timeoutMs });
  }
  const { buffer, contentType } = await fetchBuffer(url, {
    timeoutMs,
    accept: 'application/pdf,*/*',
  });
  if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error(`not_pdf:${contentType || 'unknown'}`);
  }
  return buffer;
}

export function loadTargetRows(db, {
  companies = [],
  onlyShorterThan = 12000,
  limit = 0,
  targetScope = 'no-indicator',
} = {}) {
  const hasCardTable = tableExists(db, 'product_responsibility_cards');
  const missingPredicate = targetScope === 'missing-cards-or-indicators'
    ? `
       AND (
         NOT EXISTS (
           SELECT 1
             FROM insurance_indicator_records indicator
            WHERE indicator.company = knowledge_records.company
              AND indicator.product_name = knowledge_records.product_name
         )
         OR ${hasCardTable ? `NOT EXISTS (
           SELECT 1
             FROM product_responsibility_cards card
            WHERE card.company = knowledge_records.company
              AND card.product_name = knowledge_records.product_name
         )` : '1 = 1'}
       )
      `
    : `
       AND NOT EXISTS (
         SELECT 1
           FROM insurance_indicator_records indicator
          WHERE indicator.company = knowledge_records.company
            AND indicator.product_name = knowledge_records.product_name
       )
      `;
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE product_name IS NOT NULL AND product_name <> ''
       ${missingPredicate}
     ORDER BY company, product_name, id DESC
  `).all();
  const targets = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const company = trim(row.company || payload.company);
    const productName = trim(row.product_name || payload.productName);
    if (!company || !productName) continue;
    if (companies.length && !companies.includes(company)) continue;
    const url = trim(payload.url || row.url);
    if (!isOfficialMaterialUrl(url) || !isOfficialPayload(payload)) continue;
    if (trim(payload.officialTextRefillVersion) === VERSION) continue;
    const existingText = textFromPayload(payload);
    if (onlyShorterThan > 0 && existingText.length >= onlyShorterThan) continue;
    targets.push({
      id: row.id,
      company,
      productName,
      title: trim(payload.title) || productName,
      url,
      payload,
      existingTextLength: existingText.length,
    });
    if (limit > 0 && targets.length >= limit) break;
  }
  return targets;
}

function updateKnowledgeRows(db, updates, now) {
  const statement = db.prepare('UPDATE knowledge_records SET payload = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const update of updates) {
      const payload = {
        ...update.payload,
        pageText: update.officialText,
        sourceType: 'pdf',
        official: true,
        evidenceLevel: 'insurer_official',
        officialTextRefilledAt: now,
        officialTextRefillVersion: VERSION,
        officialTextRawLength: update.rawTextLength,
        officialTextFocusedLength: update.officialText.length,
      };
      statement.run(JSON.stringify(payload), update.id);
    }
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('no_indicator_official_pdf_text_refilled_at', now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function refillNoIndicatorOfficialPdfText({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  companies = [],
  limit = 0,
  onlyShorterThan = 12000,
  minNewTextLength = 800,
  maxChars = 32000,
  downloadTimeoutMs = 15000,
  targetScope = 'no-indicator',
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const targets = loadTargetRows(db, { companies, onlyShorterThan, limit, targetScope });
    const result = {
      dbPath,
      dryRun: !write,
      targetScope,
      targetRows: targets.length,
      attemptedRows: 0,
      extractedRows: 0,
      updateRows: 0,
      failedRows: 0,
      skippedRows: 0,
      backups: [],
      samples: [],
      failures: [],
    };
    const updates = [];
    for (const target of targets) {
      result.attemptedRows += 1;
      try {
        const buffer = await fetchPdfBuffer(target.url, { timeoutMs: downloadTimeoutMs });
        const rawText = extractPdfText(buffer);
        const officialText = buildFocusedOfficialText(rawText, { maxChars });
        if (officialText.length >= minNewTextLength) result.extractedRows += 1;
        if (officialText.length > target.existingTextLength + 300 && officialText.length >= minNewTextLength) {
          updates.push({
            ...target,
            officialText,
            rawTextLength: rawText.length,
          });
          if (result.samples.length < 20) {
            result.samples.push({
              id: target.id,
              company: target.company,
              productName: target.productName,
              oldLength: target.existingTextLength,
              newLength: officialText.length,
              rawLength: rawText.length,
              url: target.url,
            });
          }
        } else {
          result.skippedRows += 1;
        }
      } catch (error) {
        result.failedRows += 1;
        if (result.failures.length < 30) {
          result.failures.push({
            id: target.id,
            company: target.company,
            productName: target.productName,
            url: target.url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    result.updateRows = updates.length;
    if (write && updates.length) {
      result.backups = await backupSqlite(dbPath);
      updateKnowledgeRows(db, updates, new Date().toISOString());
    }
    return result;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const companies = readArg('companies', '')
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
  const result = await refillNoIndicatorOfficialPdfText({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    companies,
    limit: Number(readArg('limit', 0)) || 0,
    onlyShorterThan: Number(readArg('only-shorter-than', 12000)) || 0,
    minNewTextLength: Number(readArg('min-new-text-length', 800)) || 800,
    maxChars: Number(readArg('max-chars', 32000)) || 32000,
    downloadTimeoutMs: Number(readArg('download-timeout-ms', 15000)) || 15000,
    targetScope: readArg('target-scope', 'no-indicator'),
  });
  console.log(JSON.stringify(result, null, 2));
}
