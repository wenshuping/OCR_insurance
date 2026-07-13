import { parseOffice } from 'officeparser';

const PLAIN_TEXT_EXTENSIONS = new Set(['txt', 'md']);
const OFFICEPARSER_EXTENSIONS = new Set(['pdf', 'pptx', 'docx', 'xlsx']);
const LEGACY_OFFICE_EXTENSIONS = new Set(['ppt', 'doc', 'xls']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac']);

function text(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function parserError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function nodeChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function walkNodes(nodes, visit) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    visit(node);
    walkNodes(nodeChildren(node), visit);
  }
}

function tableFromNode(node) {
  const rows = nodeChildren(node)
    .filter((row) => row?.type === 'row')
    .map((row) => nodeChildren(row).filter((cell) => cell?.type === 'cell').map((cell) => text(cell.text)));
  return {
    text: text(node?.text),
    rows,
    metadata: node?.metadata && typeof node.metadata === 'object' ? node.metadata : {},
  };
}

function sourceUnits(ast) {
  const content = Array.isArray(ast?.content) ? ast.content : [];
  const expectedType = ast?.type === 'pdf' ? 'page' : ast?.type === 'pptx' ? 'slide' : ast?.type === 'xlsx' ? 'sheet' : '';
  const units = expectedType ? content.filter((node) => node?.type === expectedType) : [];
  return units.length ? units : [{ type: 'document', text: '', children: content, metadata: {} }];
}

function normalizeUnit(unit, index, sourceType) {
  const headings = [];
  const tables = [];
  const fragments = [];
  walkNodes([unit], (node) => {
    const nodeText = text(node?.text);
    if (node?.type === 'heading' && nodeText) headings.push(nodeText);
    if (node?.type === 'table') tables.push(tableFromNode(node));
    if (!nodeChildren(node).length && nodeText) fragments.push(nodeText);
  });
  const directText = text(unit?.text);
  const rawText = directText || text(fragments.join('\n'));
  const notes = (Array.isArray(unit?.notes) ? unit.notes : []).map((note) => text(note?.text)).filter(Boolean);
  const metadata = unit?.metadata && typeof unit.metadata === 'object' ? unit.metadata : {};
  const pageNo = Number(metadata.pageNumber || metadata.slideNumber || index + 1) || index + 1;
  const sourceLabel = sourceType === 'pptx'
    ? `幻灯片 ${pageNo}`
    : sourceType === 'xlsx'
      ? `工作表 ${text(metadata.sheetName) || pageNo}`
      : `第 ${pageNo} 页`;
  return {
    pageNo,
    rawText,
    layout: { sourceType, sourceLabel, metadata, notes },
    tables,
    headings,
    sourceLabel,
  };
}

function classifyDocumentType({ extension, pages }) {
  const body = pages.map((page) => `${page.headings.join(' ')} ${page.rawText}`).join('\n');
  if (extension === 'xlsx' || /费率表|保费表|费率因子/u.test(body)) return 'rate_table';
  if (/保险条款|条款编号|责任免除|释义/u.test(body)) return 'terms';
  if (extension === 'pptx' && /培训|话术|销售|产品亮点|异议处理/u.test(body)) return 'training_deck';
  if (/产品介绍|产品说明|保险责任|投保规则|产品亮点/u.test(body)) return 'product_intro';
  return 'unknown';
}

function parsePlainText(bytes, extension) {
  const content = Buffer.from(bytes || []).toString('utf8').replace(/^\uFEFF/u, '');
  const parts = content.split(/\f/u).map(text).filter(Boolean);
  const pages = (parts.length ? parts : [text(content)]).filter(Boolean).map((rawText, index) => ({
    pageNo: index + 1,
    rawText,
    layout: { sourceType: extension, sourceLabel: `第 ${index + 1} 页`, metadata: {}, notes: [] },
    tables: [],
    headings: rawText.split('\n').filter((line) => /^#{1,6}\s+/u.test(line)).map((line) => line.replace(/^#{1,6}\s+/u, '').trim()),
    sourceLabel: `第 ${index + 1} 页`,
  }));
  if (!pages.length) throw parserError('PRODUCT_DOCUMENT_EMPTY_TEXT', '产品资料未包含可解析文字');
  return {
    parser: 'plain-text',
    documentType: classifyDocumentType({ extension, pages }),
    metadata: {},
    warnings: [],
    pages,
  };
}

export async function parseProductDocument(input = {}) {
  const bytes = Buffer.from(input.bytes || []);
  const extension = text(input.extension).toLowerCase();
  if (!bytes.length) throw parserError('PRODUCT_DOCUMENT_EMPTY', '产品资料文件不能为空', 400);
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return parsePlainText(bytes, extension);
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    throw parserError('PRODUCT_DOCUMENT_CONVERSION_REQUIRED', '旧版Office格式请先转换为PPTX、DOCX或XLSX后再解析');
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    throw parserError('PRODUCT_DOCUMENT_OCR_REQUIRED', '图片资料需要进入OCR识别队列');
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    throw parserError('PRODUCT_DOCUMENT_TRANSCRIPTION_REQUIRED', '语音资料已保存，等待语音转写服务处理');
  }
  if (!OFFICEPARSER_EXTENSIONS.has(extension)) {
    throw parserError('PRODUCT_DOCUMENT_UNSUPPORTED_TYPE', '暂不支持解析该产品资料格式');
  }

  const parser = typeof input.parser === 'function' ? input.parser : parseOffice;
  let ast;
  try {
    ast = await parser(bytes, {
      fileType: extension,
      ignoreComments: false,
      ignoreNotes: false,
      ignoreHeadersAndFooters: false,
      ignoreSlideMasters: true,
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw parserError('PRODUCT_DOCUMENT_PARSE_FAILED', '产品资料结构解析失败，请检查文件是否损坏');
  }
  const pages = sourceUnits(ast).map((unit, index) => normalizeUnit(unit, index, text(ast?.type) || extension));
  if (!pages.some((page) => page.rawText)) {
    throw parserError('PRODUCT_DOCUMENT_OCR_REQUIRED', '资料没有可提取文字，需要进入OCR识别队列');
  }
  return {
    parser: 'officeparser',
    documentType: classifyDocumentType({ extension, pages }),
    metadata: ast?.metadata && typeof ast.metadata === 'object' ? ast.metadata : {},
    warnings: Array.isArray(ast?.warnings) ? ast.warnings : [],
    pages,
  };
}
