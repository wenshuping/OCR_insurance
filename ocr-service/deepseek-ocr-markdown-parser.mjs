function trimText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function stripMarkdownHeading(value = '') {
  return String(value || '').replace(/^#{1,6}\s*/u, '').trim();
}

function stripDeepSeekTags(value = '') {
  return String(value || '')
    .replace(/<\|ref\|>[\s\S]*?<\|\/ref\|>/gu, '')
    .replace(/<\|det\|>[\s\S]*?<\|\/det\|>/gu, '');
}

function htmlCellText(value = '') {
  return trimText(
    decodeHtmlEntities(value)
      .replace(/<br\s*\/?>/giu, '')
      .replace(/<[^>]+>/gu, ' '),
  );
}

function plainLineText(value = '') {
  return trimText(
    decodeHtmlEntities(stripMarkdownHeading(value))
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<[^>]+>/gu, ' '),
  );
}

function normalizeRows(rows = []) {
  return rows
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => trimText(cell)))
    .filter((row) => row.some(Boolean));
}

export function parseHtmlTablesFromDeepSeekOcrMarkdown(markdown = '') {
  const tables = [];
  for (const tableMatch of String(markdown || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
    const rows = [];
    for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
      const row = [];
      for (const cellMatch of rowMatch[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/giu)) {
        row.push(htmlCellText(cellMatch[1]));
      }
      if (row.some(Boolean)) rows.push(row);
    }

    const normalizedRows = normalizeRows(rows);
    if (!normalizedRows.length) continue;
    tables.push({
      source: 'deepseek-ocr-html-table',
      headers: normalizedRows[0],
      rows: normalizedRows.slice(1),
    });
  }
  return tables;
}

function splitMarkdownTableRow(line = '') {
  return String(line || '')
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => htmlCellText(cell));
}

function isMarkdownDivider(row = []) {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/u.test(String(cell || '').replace(/\s+/gu, '')));
}

export function parsePipeTablesFromDeepSeekOcrMarkdown(markdown = '') {
  const tables = [];
  const lines = String(markdown || '').replace(/\r/gu, '\n').split('\n');
  let current = [];

  function flush() {
    if (current.length < 2) {
      current = [];
      return;
    }
    const rows = current.map(splitMarkdownTableRow);
    const headers = rows[0] || [];
    let bodyRows = rows.slice(1);
    if (isMarkdownDivider(bodyRows[0] || [])) bodyRows = bodyRows.slice(1);
    const normalizedRows = normalizeRows(bodyRows);
    if (headers.some(Boolean) && normalizedRows.length) {
      tables.push({
        source: 'deepseek-ocr-markdown-table',
        headers,
        rows: normalizedRows,
      });
    }
    current = [];
  }

  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

function parseDeepSeekOcrBox(det = '') {
  const raw = String(det || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 4 && parsed.every((item) => Number.isFinite(Number(item)))) {
      return parsed.map(Number);
    }
    const first = Array.isArray(parsed) ? parsed[0] : null;
    if (Array.isArray(first) && first.length === 4 && first.every((item) => Number.isFinite(Number(item)))) {
      return first.map(Number);
    }
    if (Array.isArray(first) && first.every((point) => Array.isArray(point) && point.length >= 2)) {
      return first.map((point) => [Number(point[0]), Number(point[1])]);
    }
  } catch {
    return null;
  }
  return null;
}

function tableRowsAsLines(tables = []) {
  return tables.flatMap((table) => [
    table.headers.join(' '),
    ...table.rows.map((row) => row.join(' ')),
  ].map(trimText).filter(Boolean));
}

function boxBounds(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  if (box.length === 4 && box.every((value) => Number.isFinite(Number(value)))) {
    const [x1, y1, x2, y2] = box.map(Number);
    return {
      xMin: Math.min(x1, x2),
      yMin: Math.min(y1, y2),
      xMax: Math.max(x1, x2),
      yMax: Math.max(y1, y2),
    };
  }
  return null;
}

function tableCellBoxesFromBlock(tables = [], blockBox = null, startIndex = 0) {
  const bounds = boxBounds(blockBox);
  if (!bounds) return [];

  const boxes = [];
  let index = startIndex;
  for (const table of tables) {
    const rows = [table.headers || [], ...(table.rows || [])].filter((row) => Array.isArray(row) && row.some(Boolean));
    if (!rows.length) continue;
    const maxColumns = Math.max(...rows.map((row) => row.length));
    const rowHeight = (bounds.yMax - bounds.yMin) / rows.length;
    const colWidth = (bounds.xMax - bounds.xMin) / Math.max(1, maxColumns);

    rows.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        const text = trimText(cell);
        if (!text) return;
        const x1 = bounds.xMin + colIndex * colWidth;
        const y1 = bounds.yMin + rowIndex * rowHeight;
        boxes.push({
          text,
          box: [x1, y1, x1 + colWidth, y1 + rowHeight],
          confidence: 0,
          index,
          source: table.source || 'deepseek-ocr-table-cell',
          blockType: 'table',
        });
        index += 1;
      });
    });
  }
  return boxes;
}

function lineBoxesFromBlock(lines = [], blockBox = null, startIndex = 0) {
  const bounds = boxBounds(blockBox);
  if (!bounds) return [];
  const cleanLines = lines.map(trimText).filter(Boolean);
  if (!cleanLines.length) return [];
  const lineHeight = (bounds.yMax - bounds.yMin) / cleanLines.length;
  return cleanLines.map((line, lineIndex) => ({
    text: line,
    box: [bounds.xMin, bounds.yMin + lineIndex * lineHeight, bounds.xMax, bounds.yMin + (lineIndex + 1) * lineHeight],
    confidence: 0,
    index: startIndex + lineIndex,
    source: 'deepseek-ocr-line',
  }));
}

function removeHtmlTables(value = '') {
  return String(value || '').replace(/<table\b[^>]*>[\s\S]*?<\/table>/giu, '\n');
}

function contentLinesFromMarkdown(content = '') {
  const tables = [
    ...parseHtmlTablesFromDeepSeekOcrMarkdown(content),
    ...parsePipeTablesFromDeepSeekOcrMarkdown(content),
  ];
  const tableLines = tableRowsAsLines(tables);
  const textLines = removeHtmlTables(content)
    .replace(/\r/gu, '\n')
    .split('\n')
    .map((line) => plainLineText(stripDeepSeekTags(line)))
    .filter(Boolean);
  return {
    lines: [...textLines, ...tableLines],
    tables,
  };
}

function collectTaggedBlocks(markdown = '') {
  const text = String(markdown || '');
  const pattern = /<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>([\s\S]*?)<\|\/det\|>/gu;
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return [];

  return matches.map((match, index) => {
    const next = matches[index + 1];
    const contentStart = match.index + match[0].length;
    const contentEnd = next ? next.index : text.length;
    const content = text.slice(contentStart, contentEnd).trim();
    const { lines, tables } = contentLinesFromMarkdown(content);
    return {
      type: trimText(match[1]) || 'text',
      box: parseDeepSeekOcrBox(match[2]),
      content,
      lines,
      tables,
    };
  }).filter((block) => block.lines.length || block.tables.length);
}

function uniqueLines(lines = []) {
  const result = [];
  for (const line of lines.map(trimText).filter(Boolean)) {
    if (!result.length || result.at(-1) !== line) result.push(line);
  }
  return result;
}

export function parseDeepSeekOcrMarkdown(markdown = '') {
  const taggedBlocks = collectTaggedBlocks(markdown);
  const fallback = contentLinesFromMarkdown(stripDeepSeekTags(markdown));
  const blocks = taggedBlocks.length
    ? taggedBlocks
    : [{
      type: 'text',
      box: null,
      content: String(markdown || ''),
      lines: fallback.lines,
      tables: fallback.tables,
    }];

  const lines = uniqueLines(blocks.flatMap((block) => block.lines));
  const tables = blocks.flatMap((block) => block.tables);
  const boxes = blocks.flatMap((block, blockIndex) => {
    if (!block.box || !block.lines.length) return [];
    if (block.tables.length) return tableCellBoxesFromBlock(block.tables, block.box, blockIndex * 1000);
    return lineBoxesFromBlock(block.lines, block.box, blockIndex * 1000);
  });

  return {
    ok: Boolean(lines.length),
    source: 'deepseek-ocr-markdown',
    lines,
    ocrText: lines.join('\n'),
    boxes,
    blocks,
    tables,
  };
}
