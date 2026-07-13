import crypto from 'node:crypto';

function text(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n').trim();
}

function stableId(...parts) {
  const hash = crypto.createHash('sha256').update(parts.map(text).join('\u001f')).digest('hex').slice(0, 24);
  return `kch_${hash}`;
}

export function estimateTokenCount(value) {
  const content = text(value);
  const cjkCount = (content.match(/[\u3400-\u9fff]/gu) || []).length;
  const latinTokens = content.replace(/[\u3400-\u9fff]/gu, ' ').match(/[A-Za-z]+|\d+(?:\.\d+)?/gu) || [];
  return cjkCount + latinTokens.length;
}

function contextPrefix({ document, product, page, headingPath }) {
  const metadata = document?.payload && typeof document.payload === 'object' ? document.payload : {};
  const focusTags = Array.isArray(metadata.focusTags) ? metadata.focusTags.map(text).filter(Boolean) : [];
  const productNames = Array.isArray(metadata.productNames) ? metadata.productNames.map(text).filter(Boolean) : [];
  return [
    product?.company ? `保险公司：${text(product.company)}` : '',
    product?.productName ? `产品：${text(product.productName)}` : '',
    productNames.length > 1 ? `本资料涉及产品：${productNames.join('、')}` : '',
    product?.versionLabel ? `产品版本：${text(product.versionLabel)}` : '',
    metadata.contributorName ? `知识贡献者：${text(metadata.contributorRole) || '未标注角色'} · ${text(metadata.contributorName)}` : '',
    `资料：${text(document.fileName)}`,
    `资料类型：${text(document.documentType) || 'unknown'}`,
    metadata.materialType ? `人工标注类型：${text(metadata.materialType)}` : '',
    Array.isArray(metadata.materialUsages) && metadata.materialUsages.length ? `资料用途：${metadata.materialUsages.map(text).filter(Boolean).join('、')}` : metadata.materialUsage ? `资料用途：${text(metadata.materialUsage)}` : '',
    focusTags.length ? `重点关注标签：${focusTags.join('、')}` : '',
    metadata.specialInstructions ? `人工检索说明（非事实证据）：${text(metadata.specialInstructions)}` : '',
    headingPath.length ? `章节：${headingPath.join(' / ')}` : '',
    `页码：${text(page.sourceLabel) || page.pageNo}`,
    '审核状态：待审核',
  ].filter(Boolean).join('\n');
}

function sentenceUnits(value) {
  const content = text(value);
  if (!content) return [];
  const lines = content.split(/\n{2,}|\n(?=(?:第[一二三四五六七八九十百零0-9]+条|[一二三四五六七八九十]+、|\d+[.、]))/u)
    .map(text).filter(Boolean);
  return lines.flatMap((line) => {
    if (estimateTokenCount(line) <= 500) return [line];
    return line.match(/[^。！？!?；;]+[。！？!?；;]?/gu)?.map(text).filter(Boolean) || [line];
  });
}

function hardSplit(value, maxTokens) {
  const characters = [...text(value)];
  const parts = [];
  let current = '';
  for (const character of characters) {
    const next = current + character;
    if (current && estimateTokenCount(next) > maxTokens) {
      parts.push(current.trim());
      current = character;
    } else {
      current = next;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function packUnits(units, maxTokens) {
  const chunks = [];
  let current = '';
  for (const unit of units) {
    const parts = estimateTokenCount(unit) > maxTokens ? hardSplit(unit, maxTokens) : [unit];
    for (const part of parts) {
      const joined = current ? `${current}\n${part}` : part;
      if (current && estimateTokenCount(joined) > maxTokens) {
        chunks.push(current);
        current = part;
      } else {
        current = joined;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function tableContents(table, maxTokens = 500) {
  const rows = Array.isArray(table?.rows) ? table.rows.map((row) => row.map(text)) : [];
  if (!rows.length) return text(table?.text) ? [text(table.text)] : [];
  const header = rows[0].join(' | ');
  const chunks = [];
  let group = [];
  for (const row of rows.slice(1)) {
    const next = [...group, row.join(' | ')];
    if (group.length && estimateTokenCount([header, ...next].join('\n')) > maxTokens) {
      chunks.push([header, ...group].join('\n'));
      group = [row.join(' | ')];
    } else {
      group = next;
    }
  }
  if (group.length) chunks.push([header, ...group].join('\n'));
  if (!chunks.length && header) chunks.push(header);
  return chunks.flatMap((chunk) => estimateTokenCount(chunk) > 800 ? hardSplit(chunk, 800) : [chunk]);
}

function structuredTableContent(table) {
  const rows = Array.isArray(table?.rows) ? table.rows.map((row) => row.map(text)) : [];
  if (rows.length) return rows.map((row) => row.join(' | ')).join('\n');
  return text(table?.text);
}

const ARTICLE_HEADING_PATTERN = /^第[一二三四五六七八九十百零〇0-9]+条(?:\s+|$)/u;
const NUMBERED_HEADING_PATTERN = /^[一二三四五六七八九十百]+[、.．](?!.*[。；;]$)/u;
const PARENTHETICAL_HEADING_PATTERN = /^[（(][一二三四五六七八九十百零〇0-9]+[）)](?!.*[。；;]$)/u;

function detectHeading(line, declaredHeadings = []) {
  const content = text(line);
  if (!content) return null;
  let level = 0;
  let confidence = 0;
  let reason = '';
  if (ARTICLE_HEADING_PATTERN.test(content)) {
    level = 1;
    confidence = 0.92;
    reason = '条款编号标题';
  } else if (NUMBERED_HEADING_PATTERN.test(content)) {
    level = 2;
    confidence = 0.88;
    reason = '中文序号标题';
  } else if (PARENTHETICAL_HEADING_PATTERN.test(content)) {
    level = 3;
    confidence = 0.84;
    reason = '括号序号标题';
  } else if (declaredHeadings.includes(content)) {
    level = 2;
    confidence = 0.76;
    reason = '文档结构标题';
  } else {
    return null;
  }
  const reasons = [reason];
  if (declaredHeadings.includes(content)) {
    confidence = Math.min(0.99, confidence + 0.08);
    reasons.push('解析器标题标记');
  }
  if ([...content].length <= 40) {
    confidence = Math.min(0.99, confidence + 0.02);
    reasons.push('短行标题');
  }
  return { title: content, level, confidence, reasons };
}

function documentSections(pages = []) {
  const sections = [];
  const headingStack = [];
  let current = null;
  const closeCurrent = () => {
    if (current?.units.length) sections.push(current);
    current = null;
  };

  for (const page of Array.isArray(pages) ? pages : []) {
    if (Array.isArray(page?.tables) && page.tables.length) continue;
    const pageNo = Number(page?.pageNo) || 1;
    const declaredHeadings = (Array.isArray(page?.headings) ? page.headings : []).map(text).filter(Boolean);
    const lines = text(page?.rawText).split('\n').map(text).filter(Boolean);
    lines.forEach((line, index) => {
      const unit = { id: `p${pageNo}-l${index + 1}`, pageNo, text: line };
      const heading = detectHeading(line, declaredHeadings);
      if (heading) {
        closeCurrent();
        while (headingStack.length && headingStack.at(-1).level >= heading.level) headingStack.pop();
        headingStack.push(heading);
        current = {
          pageStart: pageNo,
          pageEnd: pageNo,
          headingPath: headingStack.map((item) => item.title),
          boundaryConfidence: heading.confidence,
          boundaryReasons: heading.reasons,
          reviewRequired: heading.confidence < 0.75,
          units: [unit],
        };
        return;
      }
      if (!current) {
        current = {
          pageStart: pageNo,
          pageEnd: pageNo,
          headingPath: headingStack.map((item) => item.title),
          boundaryConfidence: headingStack.length ? 0.7 : 0.45,
          boundaryReasons: [headingStack.length ? '延续上一章节' : '未检测到章节标题'],
          reviewRequired: !headingStack.length,
          units: [],
        };
      }
      current.pageEnd = pageNo;
      current.units.push(unit);
    });
  }
  closeCurrent();
  return sections;
}

function chunkRecord({ id, document, product, page, pageEnd = null, headingPath, chunkType, content, parentChunkId = '', payload = {} }) {
  const normalizedContent = text(content);
  return {
    id,
    documentId: text(document.id),
    canonicalProductId: text(product?.canonicalProductId),
    productVersionId: text(product?.productVersionId),
    parentChunkId,
    chunkType,
    headingPath,
    pageStart: Number(page.pageNo),
    pageEnd: Number(pageEnd || page.pageNo),
    content: normalizedContent,
    contextualPrefix: contextPrefix({ document, product, page, headingPath }),
    tokenCount: estimateTokenCount(normalizedContent),
    contentHash: crypto.createHash('sha256').update(normalizedContent).digest('hex'),
    sourceAuthority: text(document.sourceAuthority) || 'company_material',
    reviewStatus: 'pending',
    indexStatus: 'ready',
    payload: { sourceLabel: text(page.sourceLabel) || `第 ${page.pageNo} 页`, ...payload },
  };
}

export function chunkProductDocument(input = {}) {
  const document = input.document || {};
  const product = input.product || {};
  if (!text(document.id)) throw new Error('Product document chunking requires document.id');
  const chunks = [];
  const pages = Array.isArray(input.pages) ? input.pages : [];
  const parentIdsByPage = new Map();
  for (const page of pages) {
    const content = text(page?.rawText);
    const headingPath = (Array.isArray(page?.headings) ? page.headings : []).map(text).filter(Boolean);
    const tableContent = (page?.tables || []).map(structuredTableContent).filter(Boolean).join('\n\n');
    const parentContent = tableContent || content;
    if (!parentContent) continue;
    const parentId = stableId(document.id, page.pageNo, 'parent', parentContent);
    parentIdsByPage.set(Number(page.pageNo), parentId);
    chunks.push(chunkRecord({
      id: parentId,
      document,
      product,
      page,
      headingPath,
      chunkType: 'parent',
      content: parentContent,
      payload: { sourceLabel: text(page.sourceLabel), isParent: true },
    }));

    (page?.tables || []).forEach((table, tableIndex) => {
      tableContents(table).forEach((tableContent, partIndex) => chunks.push(chunkRecord({
        id: stableId(document.id, page.pageNo, 'table', tableIndex, partIndex, tableContent),
        document,
        product,
        page,
        headingPath,
        chunkType: 'table',
        content: tableContent,
        parentChunkId: parentId,
        payload: { sourceLabel: text(page.sourceLabel), isTable: true, tableIndex, partIndex },
      })));
    });
  }

  const maxTokens = document.documentType === 'terms' ? 800 : 500;
  const childChunks = [];
  documentSections(pages).forEach((section, sectionIndex) => {
    const sourcePage = pages.find((page) => Number(page?.pageNo) === section.pageStart) || { pageNo: section.pageStart };
    const parts = packUnits(sentenceUnits(section.units.map((unit) => unit.text).join('\n')), maxTokens);
    parts.forEach((part, partIndex) => childChunks.push(chunkRecord({
      id: stableId(document.id, section.pageStart, section.pageEnd, 'child', sectionIndex, partIndex, part),
      document,
      product,
      page: sourcePage,
      pageEnd: section.pageEnd,
      headingPath: section.headingPath,
      chunkType: 'child',
      content: part,
      parentChunkId: parentIdsByPage.get(section.pageStart) || '',
      payload: {
        sourceLabel: text(sourcePage.sourceLabel) || `第 ${section.pageStart} 页`,
        sequence: childChunks.length,
        sectionIndex,
        partIndex,
        boundaryConfidence: section.boundaryConfidence,
        boundaryReasons: section.boundaryReasons,
        reviewRequired: section.reviewRequired,
        sourceUnitIds: section.units
          .filter((unit) => part.includes(unit.text) || unit.text.includes(part))
          .map((unit) => unit.id),
      },
    })));
  });
  childChunks.forEach((chunk, index) => {
    chunk.payload.previousChunkId = childChunks[index - 1]?.id || '';
    chunk.payload.nextChunkId = childChunks[index + 1]?.id || '';
  });
  chunks.push(...childChunks);
  return chunks;
}
