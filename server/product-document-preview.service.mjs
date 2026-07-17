import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OFFICE_EXTENSIONS = new Set(['pptx', 'docx', 'xlsx']);
const MACOS_CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function previewError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function run(binary, args) {
  try {
    await execFileAsync(binary, args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  } catch (cause) {
    throw previewError('PRODUCT_DOCUMENT_PREVIEW_UNAVAILABLE', '当前环境无法生成原页图片预览', 503);
  }
}

async function readRenderedPages(directory, prefix = 'page') {
  const pagePattern = new RegExp(`^${prefix}-(\\d+)\\.png$`, 'u');
  const pageFiles = (await readdir(directory))
    .map((name) => ({ name, match: name.match(pagePattern) }))
    .filter((entry) => entry.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  if (!pageFiles.length) throw previewError('PRODUCT_DOCUMENT_PREVIEW_UNAVAILABLE', '没有生成可用的页面图片', 503);
  return Promise.all(pageFiles.map((entry) => readFile(path.join(directory, entry.name))));
}

async function renderPptxWithMacosPreview(inputPath, temporaryDirectory, options) {
  const quickLookDirectory = path.join(temporaryDirectory, 'quicklook');
  await mkdir(quickLookDirectory);
  await run(options.quickLookBin || 'qlmanage', ['-p', '-o', quickLookDirectory, inputPath]);

  const previewDirectory = path.join(quickLookDirectory, `${path.basename(inputPath)}.qlpreview`);
  const previewHtmlPath = path.join(previewDirectory, 'Preview.html');
  let previewHtml = await readFile(previewHtmlPath, 'utf8');
  const attachmentPdfs = (await readdir(previewDirectory)).filter((name) => name.toLowerCase().endsWith('.pdf'));
  for (const attachment of attachmentPdfs) {
    const source = path.join(previewDirectory, attachment);
    const output = path.join(previewDirectory, attachment.slice(0, -4));
    await run(options.pdftoppmBin || process.env.PRODUCT_DOCUMENT_PDFTOPPM_BIN || 'pdftoppm', [
      '-f', '1', '-l', '1', '-singlefile', '-png', '-r', '144', source, output,
    ]);
  }

  previewHtml = previewHtml.replace(/\.pdf(["'])/giu, '.png$1').replace('</head>', `<style>
@page { size: 10in 5.625in; margin: 0; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: white !important; }
  div.slide { margin: 0 !important; box-shadow: none !important; page-break-after: always !important; break-after: page !important; }
}
</style></head>`);
  const printableHtmlPath = path.join(previewDirectory, 'Printable.html');
  await writeFile(printableHtmlPath, previewHtml);

  const pdfPath = path.join(temporaryDirectory, 'native-preview.pdf');
  await run(options.chromeBin || process.env.PRODUCT_DOCUMENT_CHROME_BIN || MACOS_CHROME_BIN, [
    '--headless', '--disable-gpu', '--allow-file-access-from-files', '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`, `file://${printableHtmlPath}`,
  ]);
  const outputPrefix = path.join(temporaryDirectory, 'native-page');
  await run(options.pdftoppmBin || process.env.PRODUCT_DOCUMENT_PDFTOPPM_BIN || 'pdftoppm', [
    '-png', '-r', '120', pdfPath, outputPrefix,
  ]);
  return readRenderedPages(temporaryDirectory, 'native-page');
}

export async function renderProductDocumentPages(document, options = {}) {
  const bytes = Buffer.from(document?.bytes || []);
  const extension = String(document?.extension || '').toLowerCase();
  const mediaType = String(document?.mediaType || '').toLowerCase();
  if (!bytes.length) throw previewError('PRODUCT_DOCUMENT_EMPTY', '产品资料文件为空', 400);
  if (mediaType.startsWith('image/')) return [bytes];
  if (extension !== 'pdf' && !OFFICE_EXTENSIONS.has(extension)) {
    throw previewError('PRODUCT_DOCUMENT_PREVIEW_UNSUPPORTED', '当前资料格式不支持原页图片预览');
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'product-preview-'));
  try {
    const inputPath = path.join(temporaryDirectory, `source.${extension}`);
    await writeFile(inputPath, bytes);
    if (extension === 'pptx' && process.platform === 'darwin') {
      try {
        return await renderPptxWithMacosPreview(inputPath, temporaryDirectory, options);
      } catch {
        // Quick Look preserves uncommon Chinese PPT fonts better; keep LibreOffice as the portable fallback.
      }
    }
    let pdfPath = inputPath;
    if (OFFICE_EXTENSIONS.has(extension)) {
      await run(options.sofficeBin || process.env.PRODUCT_DOCUMENT_SOFFICE_BIN || 'soffice', [
        '--headless', '--convert-to', 'pdf', '--outdir', temporaryDirectory, inputPath,
      ]);
      const converted = (await readdir(temporaryDirectory)).find((name) => name.toLowerCase() === 'source.pdf');
      if (!converted) throw previewError('PRODUCT_DOCUMENT_PREVIEW_UNAVAILABLE', 'Office资料未能转换成页面预览', 503);
      pdfPath = path.join(temporaryDirectory, converted);
    }
    const outputPrefix = path.join(temporaryDirectory, 'page');
    await run(options.pdftoppmBin || process.env.PRODUCT_DOCUMENT_PDFTOPPM_BIN || 'pdftoppm', [
      '-png', '-r', '120', pdfPath, outputPrefix,
    ]);
    return readRenderedPages(temporaryDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function createProductDocumentPreviewService(options = {}) {
  const renderPages = options.renderPages || renderProductDocumentPages;
  const cache = new Map();
  const maxEntries = Math.max(1, Number(options.maxEntries || 4));

  async function getPagePreview({ document, pageNo } = {}) {
    const normalizedPageNo = Math.trunc(Number(pageNo || 0));
    if (normalizedPageNo < 1) throw previewError('PRODUCT_DOCUMENT_PAGE_NOT_FOUND', '产品资料页面不存在', 404);
    const cacheKey = `${document?.id || ''}:${document?.contentHash || ''}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, Promise.resolve().then(() => renderPages(document, options)));
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    }
    let pages;
    try {
      pages = await cache.get(cacheKey);
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
    const image = pages[normalizedPageNo - 1];
    if (!image) throw previewError('PRODUCT_DOCUMENT_PAGE_NOT_FOUND', '产品资料页面不存在', 404);
    return Buffer.from(image);
  }

  return { getPagePreview };
}

