function text(value) {
  return String(value || '').trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cellText(value) {
  return text(
    decodeHtmlEntities(String(value || ''))
      .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
      .replace(/<br\s*\/?>/giu, ' / ')
      .replace(/<\/(?:p|div|li)>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' '),
  );
}

function spanValue(attributes, name) {
  const match = String(attributes || '').match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'iu'));
  const value = Number(match?.[1] || 1);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : 1;
}

function parseTableRows(tableHtml) {
  const rows = [];
  for (const rowMatch of String(tableHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/giu)) {
      const value = cellText(cellMatch[2]);
      if (!value) continue;
      cells.push({
        value,
        rowSpan: spanValue(cellMatch[1], 'rowspan'),
        columnSpan: spanValue(cellMatch[1], 'colspan'),
      });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function expandSpans(rows) {
  const grid = [];
  rows.forEach((row, rowIndex) => {
    grid[rowIndex] ||= [];
    let columnIndex = 0;
    for (const cell of row) {
      while (grid[rowIndex][columnIndex] !== undefined) columnIndex += 1;
      for (let rowOffset = 0; rowOffset < cell.rowSpan; rowOffset += 1) {
        grid[rowIndex + rowOffset] ||= [];
        for (let columnOffset = 0; columnOffset < cell.columnSpan; columnOffset += 1) {
          const targetColumn = columnIndex + columnOffset;
          if (grid[rowIndex + rowOffset][targetColumn] === undefined) {
            grid[rowIndex + rowOffset][targetColumn] = cell.value;
          }
        }
      }
      columnIndex += cell.columnSpan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_unused, index) => text(row[index])));
}

function isPlanMatrix(grid) {
  const joined = grid.flat().join(' ');
  const hasPlanColumns = /(?:计划|方案|套餐|档次)\s*(?:[一二三四五六七八九十\dA-Z])/iu.test(joined);
  const hasInsuranceDimension = /保险责任|保障责任|保障项目|费用项目|免赔额|给付限额|赔付比例|报销比例/u.test(joined);
  return hasPlanColumns && hasInsuranceDimension;
}

export function extractInsurancePlanMatrixEvidence(html) {
  const source = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ');
  const tables = [];
  for (const match of source.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
    const grid = expandSpans(parseTableRows(match[1]));
    if (!grid.length || !isPlanMatrix(grid)) continue;
    tables.push({
      rows: grid,
      text: grid.map((row) => row.join(' | ')).join('\n'),
    });
  }
  return {
    tables,
    text: tables.map((table, index) => `保障计划表 ${index + 1}\n${table.text}`).join('\n\n'),
  };
}
