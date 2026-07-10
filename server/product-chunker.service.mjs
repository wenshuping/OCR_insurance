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
  return [
    product?.company ? `保险公司：${text(product.company)}` : '',
    product?.productName ? `产品：${text(product.productName)}` : '',
    product?.versionLabel ? `产品版本：${text(product.versionLabel)}` : '',
    `资料：${text(document.fileName)}`,
    `资料类型：${text(document.documentType) || 'unknown'}`,
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

function chunkRecord({ id, document, product, page, headingPath, chunkType, content, parentChunkId = '', payload = {} }) {
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
    pageEnd: Number(page.pageNo),
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
  for (const page of Array.isArray(input.pages) ? input.pages : []) {
    const content = text(page?.rawText);
    const headingPath = (Array.isArray(page?.headings) ? page.headings : []).map(text).filter(Boolean);
    const parentContent = [content, ...(page?.tables || []).map((table) => text(table?.text))].filter(Boolean).join('\n\n');
    if (!parentContent) continue;
    const parentId = stableId(document.id, page.pageNo, 'parent', parentContent);
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

    const maxTokens = document.documentType === 'terms' ? 800 : 500;
    const bodyParts = packUnits(sentenceUnits(content), maxTokens);
    bodyParts.forEach((part, index) => chunks.push(chunkRecord({
      id: stableId(document.id, page.pageNo, 'child', index, part),
      document,
      product,
      page,
      headingPath,
      chunkType: 'child',
      content: part,
      parentChunkId: parentId,
      payload: { sourceLabel: text(page.sourceLabel), sequence: index },
    })));

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
  return chunks;
}
