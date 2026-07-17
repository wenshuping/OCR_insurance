import crypto from 'node:crypto';

function text(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function stableElementId(pageNo, kind, index, content) {
  const hash = crypto.createHash('sha256').update(`${pageNo}|${kind}|${index}|${text(content)}`).digest('hex').slice(0, 16);
  return `pse_${hash}`;
}

function normalizedExistingElements(page) {
  const pageNo = Number(page?.pageNo || 0);
  const elements = Array.isArray(page?.layout?.elements) ? page.layout.elements : [];
  return elements.flatMap((element, index) => {
    const kind = text(element?.kind) || 'text';
    const content = text(element?.text || element?.caption);
    if (!content && !text(element?.assetRef)) return [];
    return [{
      ...element,
      id: text(element?.id) || stableElementId(pageNo, kind, index, content || element.assetRef),
      kind,
      text: text(element?.text),
      caption: text(element?.caption),
      bbox: Array.isArray(element?.bbox) && element.bbox.length === 4 ? element.bbox.map(Number) : null,
    }];
  });
}

function derivedElements(page) {
  const pageNo = Number(page?.pageNo || 0);
  const elements = [];
  text(page?.rawText).split('\n').map(text).filter(Boolean).forEach((line, index) => {
    elements.push({
      id: stableElementId(pageNo, 'text', index, line),
      kind: 'text',
      text: line,
      bbox: null,
      source: 'derived_line',
    });
  });
  (Array.isArray(page?.tables) ? page.tables : []).forEach((table, index) => {
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const content = text(table?.text) || rows.map((row) => (Array.isArray(row) ? row.map(text).join(' | ') : '')).filter(Boolean).join('\n');
    if (!content) return;
    elements.push({
      id: stableElementId(pageNo, 'table', index, content),
      kind: 'table',
      text: content,
      bbox: Array.isArray(table?.metadata?.bbox) ? table.metadata.bbox.map(Number) : null,
      tableIndex: index,
      source: 'derived_table',
    });
  });
  return elements;
}

export function annotatePagesWithSourceElements(pages = []) {
  return (Array.isArray(pages) ? pages : []).map((page) => {
    const existing = normalizedExistingElements(page);
    const elements = existing.length ? existing : derivedElements(page);
    return {
      ...page,
      layout: {
        ...(page?.layout && typeof page.layout === 'object' && !Array.isArray(page.layout) ? page.layout : {}),
        elements,
        sourceElementVersion: 'product-source-elements-v1',
      },
    };
  });
}

export function attachChunkSourceRegions(chunks = [], pages = []) {
  const byPage = new Map((Array.isArray(pages) ? pages : []).map((page) => [Number(page?.pageNo || 0), page]));
  return (Array.isArray(chunks) ? chunks : []).map((chunk) => {
    const chunkContent = compact(chunk?.content);
    const sourceRegions = [];
    const pageStart = Number(chunk?.pageStart || 0);
    const pageEnd = Number(chunk?.pageEnd || pageStart);
    for (let pageNo = pageStart; pageNo <= pageEnd; pageNo += 1) {
      const page = byPage.get(pageNo);
      if (!page) continue;
      const matching = (Array.isArray(page?.layout?.elements) ? page.layout.elements : []).filter((element) => {
        const content = compact(element?.text || element?.caption);
        return content && (chunkContent.includes(content) || content.includes(chunkContent));
      });
      if (!matching.length) continue;
      sourceRegions.push({
        pageNo,
        elementIds: matching.map((element) => text(element.id)).filter(Boolean),
        bboxes: matching.map((element) => element.bbox).filter((bbox) => Array.isArray(bbox) && bbox.length === 4),
      });
    }
    return {
      ...chunk,
      payload: {
        ...(chunk?.payload && typeof chunk.payload === 'object' && !Array.isArray(chunk.payload) ? chunk.payload : {}),
        sourceRegions,
        sourceElementVersion: 'product-source-elements-v1',
      },
    };
  });
}

