import { parseOffice } from 'officeparser';
import { strFromU8, unzipSync } from 'fflate';

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

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function pptxSlideXmlText(bytes, pageNumbers = []) {
  const requested = new Set(pageNumbers.map(Number).filter((value) => Number.isInteger(value) && value > 0));
  if (!requested.size) return new Map();
  const archive = unzipSync(new Uint8Array(bytes));
  const slides = new Map();
  for (const pageNo of requested) {
    const source = archive[`ppt/slides/slide${pageNo}.xml`];
    if (!source) continue;
    const xml = strFromU8(source);
    const fragments = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
      .map((match) => text(decodeXmlText(match[1])))
      .filter(Boolean);
    if (fragments.length) slides.set(pageNo, text(fragments.join('\n')));
  }
  return slides;
}

function pptxXmlFallbackPages(bytes) {
  const archive = unzipSync(new Uint8Array(bytes));
  return Object.keys(archive)
    .map((path) => ({ path, match: path.match(/^ppt\/slides\/slide(\d+)\.xml$/u) }))
    .filter((entry) => entry.match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map((entry) => {
      const pageNo = Number(entry.match[1]);
      const xml = strFromU8(archive[entry.path]);
      const rawText = text([...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map((match) => text(decodeXmlText(match[1])))
        .filter(Boolean)
        .join('\n'));
      const extraction = pageExtractionState(rawText);
      const table = planComparisonTable(rawText);
      return {
        pageNo,
        rawText,
        layout: {
          sourceType: 'pptx',
          sourceLabel: `幻灯片 ${pageNo}`,
          metadata: { slideNumber: pageNo },
          notes: [],
          extraction: {
            method: 'pptx_xml_fallback',
            nativeCharacterCount: 0,
            recoveredCharacterCount: [...rawText].length,
            expectedPointCount: extraction.expectedPoints,
            extractedPointCount: extraction.extractedPoints,
            incomplete: extraction.incomplete,
            needsVisualOcr: extraction.incomplete,
          },
        },
        tables: table ? [table] : [],
        headings: [],
        sourceLabel: `幻灯片 ${pageNo}`,
      };
    })
    .filter((page) => page.rawText);
}

function numberedPointCount(value) {
  return new Set([...text(value).matchAll(/(?:^|\n)\s*([1-9]\d*)[.．、](?!\d)\s*(?:\n|\S)/gu)]
    .map((match) => Number(match[1]))).size;
}

function expectedPointCount(value) {
  const match = text(value).match(/([2-9]|10)\s*点(?:区别|差异|不同)/u);
  return match ? Number(match[1]) : 0;
}

function pageExtractionState(value) {
  const expectedPoints = expectedPointCount(value);
  const extractedPoints = numberedPointCount(value);
  return {
    expectedPoints,
    extractedPoints,
    incomplete: expectedPoints > 0 && extractedPoints < expectedPoints,
  };
}

function planComparisonTable(value) {
  const content = text(value);
  const sections = [...content.matchAll(/(?:^|\n)\s*[1-9]\d*[.．、](?!\d)\s*\n?([\s\S]*?)(?=(?:\n\s*[1-9]\d*[.．、](?!\d)\s*(?:\n|\S))|$)/gu)]
    .map((match) => text(match[1]));
  const rows = [];
  let ratioNote = '';
  for (const section of sections) {
    let label = '';
    if (/小额医疗[\s\S]{0,30}(?:年度)?给付限额/u.test(section)) {
      label = '小额医疗（可选责任）年度给付限额';
    } else if (/康护责任[\s\S]{0,20}(?:年度)?给付限额/u.test(section)) {
      label = '康护责任年度给付限额';
    } else if (/(?:年度)?免赔额/u.test(section)) {
      label = '年度免赔额';
    }
    const values = [...section.matchAll(/计划([一二三])\s*[：:]?\s*(\d+(?:\.\d+)?)\s*(万元|元)/gu)];
    if (label && values.length >= 2) {
      const byPlan = new Map(values.map((match) => [`计划${match[1]}`, `${match[2]}${match[3]}`]));
      rows.push([
        label,
        `计划一 ${byPlan.get('计划一') || ''}`.trim(),
        `计划二 ${byPlan.get('计划二') || ''}`.trim(),
        `计划三 ${byPlan.get('计划三') || ''}`.trim(),
      ]);
    }
    const ratio = section.match(/对应年度免赔额[，,\s]*(\d+(?:\.\d+)?)\s*%\s*赔付/u);
    if (ratio && /小额医疗/u.test(section)) ratioNote = `小额医疗对应年度免赔额后${ratio[1]}%赔付`;
  }
  if (rows.length < 2) return null;
  if (ratioNote) rows.push([ratioNote, '', '', '']);
  return {
    text: rows.map((row) => row.join(' | ')).join('\n'),
    rows: [['保障项目', '计划一', '计划二', '计划三'], ...rows],
    metadata: {
      kind: 'plan_comparison',
      extractionMethod: 'pptx_xml',
      notes: ratioNote ? [ratioNote] : [],
    },
  };
}

function recoverPptxPages(bytes, pages) {
  const candidates = pages.filter((page) => pageExtractionState(page.rawText).incomplete);
  let recovered = new Map();
  if (candidates.length) {
    try {
      recovered = pptxSlideXmlText(bytes, candidates.map((page) => page.pageNo));
    } catch {
      recovered = new Map();
    }
  }
  return pages.map((page) => {
    const nativeText = text(page.rawText);
    const xmlText = text(recovered.get(Number(page.pageNo)));
    const useRecoveredText = [...xmlText].length > [...nativeText].length;
    const rawText = useRecoveredText ? xmlText : nativeText;
    const extraction = pageExtractionState(rawText);
    const recoveredTable = useRecoveredText ? planComparisonTable(rawText) : null;
    return {
      ...page,
      rawText,
      layout: {
        ...page.layout,
        extraction: {
          method: useRecoveredText ? 'officeparser+pptx_xml' : 'officeparser',
          nativeCharacterCount: [...nativeText].length,
          recoveredCharacterCount: useRecoveredText ? [...xmlText].length : 0,
          expectedPointCount: extraction.expectedPoints,
          extractedPointCount: extraction.extractedPoints,
          incomplete: extraction.incomplete,
          needsVisualOcr: extraction.incomplete,
        },
      },
      tables: recoveredTable ? [...page.tables, recoveredTable] : page.tables,
    };
  });
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
    if (extension === 'pptx') {
      try {
        const pages = pptxXmlFallbackPages(bytes);
        if (pages.length) {
          return {
            parser: 'pptx-xml-fallback',
            documentType: classifyDocumentType({ extension, pages }),
            metadata: {},
            warnings: ['officeparser_failed_pptx_xml_fallback'],
            pages,
          };
        }
      } catch {
        // Fall through to the normal parse error when the PPTX archive is also unreadable.
      }
    }
    throw parserError('PRODUCT_DOCUMENT_PARSE_FAILED', '产品资料结构解析失败，请检查文件是否损坏');
  }
  let pages = sourceUnits(ast).map((unit, index) => normalizeUnit(unit, index, text(ast?.type) || extension));
  if (extension === 'pptx') pages = recoverPptxPages(bytes, pages);
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
