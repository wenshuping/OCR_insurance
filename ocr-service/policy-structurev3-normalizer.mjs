function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') {
    return text(value.text ?? value.content ?? value.block_content ?? value.value ?? value.cell_text ?? '');
  }
  return String(value).replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function markdownText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(markdownText).filter(Boolean).join('\n').trim();
  if (typeof value === 'object') {
    return markdownText(value.markdown ?? value.md ?? value.block_content ?? value.content ?? value.table_ocr_pred ?? '');
  }
  return String(value).replace(/<br\s*\/?>/giu, '\n').trim();
}

function htmlText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(htmlText).filter(Boolean).join('').trim();
  if (typeof value === 'object') {
    return htmlText(value.pred_html ?? value.html ?? value.table_html ?? value.table_ocr_pred ?? '');
  }
  return String(value).trim();
}

function normalizeAmount(value) {
  const raw = text(value).replace(/[,，\s]/gu, '').replace(/[¥￥]/gu, '');
  if (!raw) return '';
  const wan = raw.match(/(\d+(?:\.\d+)?)万/u);
  if (wan) return String(Math.round(Number(wan[1]) * 10000));
  const number = raw.match(/(\d+(?:\.\d+)?)/u);
  if (!number) return '';
  const parsed = Number(number[1]);
  return Number.isFinite(parsed) ? String(parsed) : '';
}

function normalizeBlock(block = {}) {
  const blockText = text(block);
  if (!blockText) return null;
  const bbox = block.bbox || block.box || block.coordinate || [];
  return {
    type: text(block.type || block.block_type || block.block_label || block.label || 'text') || 'text',
    text: blockText,
    bbox: Array.isArray(bbox) ? bbox : [],
    confidence: Number(block.confidence || block.score || 0) || 0,
  };
}

function rawPayloads(raw) {
  const payloads = [];
  const seen = new Set();
  const stack = [raw].filter(Boolean);

  while (stack.length) {
    const payload = stack.shift();
    if (!payload || typeof payload !== 'object' || seen.has(payload)) continue;
    if (Array.isArray(payload)) {
      stack.push(...payload);
      continue;
    }
    seen.add(payload);
    payloads.push(payload);

    if (Array.isArray(payload.results)) stack.push(...payload.results);
    if (Array.isArray(payload.result)) stack.push(...payload.result);
    if (payload.res && typeof payload.res === 'object') stack.push(payload.res);
    if (payload.result && !Array.isArray(payload.result) && typeof payload.result === 'object') {
      stack.push(payload.result);
    }
  }

  return payloads;
}

function collectBlocks(raw) {
  const blocks = [];
  for (const payload of rawPayloads(raw)) {
    if (Array.isArray(payload.blocks)) blocks.push(...payload.blocks);
    if (Array.isArray(payload.layout)) blocks.push(...payload.layout);
    if (Array.isArray(payload.parsing_res_list)) blocks.push(...payload.parsing_res_list);
    if (Array.isArray(payload.ocr_results)) blocks.push(...payload.ocr_results);
  }
  return blocks.map(normalizeBlock).filter(Boolean);
}

function collectStandaloneTexts(raw) {
  const values = [];
  for (const payload of rawPayloads(raw)) {
    for (const key of ['ocrText', 'ocr_text', 'text', 'markdown']) {
      const value = text(payload[key]);
      if (value) values.push(value);
    }
    if (Array.isArray(payload.overall_ocr_res?.rec_texts)) {
      const value = payload.overall_ocr_res.rec_texts.map(text).filter(Boolean).join(' ');
      if (value) values.push(value);
    }
  }
  return values;
}

function normalizeRows(rows = []) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => text(cell)))
    .filter((row) => row.some(Boolean));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function rowsFromCells(cells = []) {
  const grid = [];
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') continue;
    const rowIndex = Number(cell.row ?? cell.row_index ?? cell.start_row ?? cell.rowspan_start ?? 0);
    const colIndex = Number(cell.col ?? cell.col_index ?? cell.start_col ?? cell.colspan_start ?? 0);
    if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) continue;
    if (!grid[rowIndex]) grid[rowIndex] = [];
    grid[rowIndex][colIndex] = text(cell);
  }
  return grid.map((row) => (row || []).map((cell) => text(cell)));
}

function parseHtmlRows(html = '') {
  const rows = [];
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const rowHtml = rowMatch[1];
    const row = [];
    for (const cellMatch of rowHtml.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/giu)) {
      row.push(text(decodeHtml(cellMatch[1]).replace(/<[^>]+>/gu, ' ')));
    }
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => text(cell.replace(/<br\s*\/?>/giu, ' ')));
}

function isMarkdownDivider(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(compact(cell)));
}

function collectMarkdownTables(markdown = '', source = 'markdown-table') {
  const tables = [];
  const lines = String(markdown || '').replace(/\r/gu, '\n').split('\n');
  let current = [];

  function flush() {
    if (current.length >= 2) {
      const rows = current.map(splitMarkdownRow);
      const headerRowIndex = rows.findIndex(looksLikePlanTableHeader);
      const inferredHeaderIndex = headerRowIndex >= 0 ? headerRowIndex : 0;
      const headers = rows[inferredHeaderIndex].map(text).filter(Boolean);
      let bodyRows = rows.slice(inferredHeaderIndex + 1);
      if (isMarkdownDivider(bodyRows[0] || [])) bodyRows = bodyRows.slice(1);
      const normalizedRows = normalizeRows(bodyRows);
      if (headers.length && normalizedRows.length) {
        tables.push({
          title: source === 'raw-table' ? `原始表格${tables.length + 1}` : `Markdown表格${tables.length + 1}`,
          source,
          headers,
          rows: normalizedRows,
        });
      }
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

function looksLikePlanTableHeader(row = []) {
  const compacted = compact(row.join(''));
  return /险种名称|产品名称|保险名称|主险名称/u.test(compacted)
    && /基本保险金额|保险金额|保额|保险期间|保障期间|交费期间|缴费期间|保险费|保费/u.test(compacted);
}

function amountBeforeCoverage(value) {
  const raw = text(value);
  const beforeCoverage = raw.split(/终身|至\d{4}|保险期间|保障期间/u)[0] || raw;
  return normalizeAmount(beforeCoverage);
}

function moneyAmount(value) {
  const raw = text(value).replace(/[,，\s]/gu, '');
  const matches = [...raw.matchAll(/[Y¥￥]?(\d+(?:\.\d+)?)元/giu)];
  if (!matches.length) return normalizeAmount(raw);
  return normalizeAmount(matches.at(-1)?.[1] || '');
}

function standardPlanHeaders() {
  return ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'];
}

function nextLabeledOffset(value, labels = []) {
  const raw = text(value);
  let offset = raw.length;
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]`, 'u');
    const matched = raw.match(pattern);
    if (matched?.index >= 0) offset = Math.min(offset, matched.index);
  }
  const plainStop = raw.search(/特别约定|保单说明|保险公司签章|保险合同专用章|业务员|保单签发地|服务电话/u);
  if (plainStop >= 0) offset = Math.min(offset, plainStop);
  return offset;
}

function labeledSegmentValue(segment, labels = [], stopLabels = []) {
  const raw = text(segment);
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}\\s*[:：]\\s*`, 'u');
    const matched = raw.match(pattern);
    if (!matched) continue;
    const rest = raw.slice(matched.index + matched[0].length);
    return rest.slice(0, nextLabeledOffset(rest, stopLabels)).trim();
  }
  return '';
}

function labeledPlanRowsFromText(value) {
  const raw = text(value);
  const matches = [...raw.matchAll(/险种名称\s*[:：]\s*/gu)];
  if (!matches.length) return [];

  const rows = [];
  const stopLabels = [
    '险种名称',
    '基本保险金额',
    '保险金额',
    '保险期间',
    '交费方式',
    '交费期间',
    '缴费期间',
    '续期保险费交费日期',
    '保险费',
    '保险费合计',
    '首期保险费合计',
    '首期保费合计',
  ];

  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index || 0;
    const end = matches[index + 1]?.index ?? raw.length;
    const segment = raw.slice(start, end);
    const name = cleanPlanName(labeledSegmentValue(segment, ['险种名称'], stopLabels));
    if (!looksLikePlanName(name)) continue;

    const coverageText = labeledSegmentValue(segment, ['保险期间', '保障期间'], stopLabels);
    const paymentMethodText = labeledSegmentValue(segment, ['交费方式', '缴费方式'], stopLabels);
    const paymentTermText = labeledSegmentValue(segment, ['交费期间', '缴费期间'], stopLabels);
    rows.push([
      name,
      normalizeAmount(labeledSegmentValue(segment, ['基本保险金额', '保险金额', '保额'], stopLabels)),
      cleanGlobalCoveragePeriod(coverageText),
      cleanPaymentPeriod(`${paymentMethodText} ${paymentTermText}`),
      normalizeAmount(labeledSegmentValue(segment, ['保险费', '保费'], stopLabels)),
    ]);
  }

  return rows;
}

function labeledPlanRows(rows = []) {
  const normalized = [];
  let totalPremium = '';
  for (const row of rows) {
    const joined = row.join(' ');
    normalized.push(...labeledPlanRowsFromText(joined));
    if (isTotalPremiumText(joined)) {
      totalPremium = totalPremiumValue(row, -1) || totalPremium;
    }
  }
  if (!normalized.length) return [];
  if (totalPremium) normalized.push(['首期保险费合计', '', '', '', totalPremium]);
  return normalized;
}

function flattenedPlanRows(headers = [], rows = []) {
  if (headers.length >= standardPlanHeaders().length - 1) return [];
  const headerText = compact(headers.join(' '));
  if (!/险种名称|产品名称|保险名称/u.test(headerText)) return [];
  if (!/保险期间|保障期间/u.test(headerText)) return [];
  if (!rows.some((row) => Array.isArray(row) && row.length >= 4)) return [];

  const normalized = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const joined = row.join(' ');
    if (isTotalPremiumText(joined)) {
      const value = totalPremiumValue(row, -1);
      if (value) normalized.push(['首期保险费合计', '', '', '', value]);
      continue;
    }
    const firstCell = text(row[0]);
    const possibleName = cleanPlanName(firstCell);
    if (firstCell && looksLikePlanName(possibleName)) {
      normalized.push([
        possibleName,
        amountBeforeCoverage(row[1]),
        cleanCoveragePeriod(row[1]),
        cleanPaymentPeriod(`${row[2] || ''} ${row[3] || ''}`),
        moneyAmount(row[3]),
      ]);
      continue;
    }

    const last = normalized.at(-1);
    if (!last) continue;
    if (!last[3]) last[3] = cleanPaymentPeriod(joined);
    if (!last[2]) last[2] = cleanCoveragePeriod(joined);
    if (!last[4]) last[4] = moneyAmount(joined);
  }

  return normalized.filter((row) => row.some(Boolean));
}

function normalizeRawTable(table = {}, index = 0) {
  if (!table || typeof table !== 'object') return null;
  const html = htmlText(table.pred_html || table.html || table.table_html || table.table_ocr_pred || table.block_content || table.content);
  if (/<(?:table|tr|td|th)\b/iu.test(html)) {
    const rows = normalizeRows(parseHtmlRows(html));
    const labeledRows = labeledPlanRows(rows);
    if (labeledRows.length) {
      return {
        title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
        source: 'raw-table',
        headers: standardPlanHeaders(),
        rows: labeledRows,
      };
    }
    const headerRowIndex = rows.findIndex(looksLikePlanTableHeader);
    const headers = (rows[headerRowIndex >= 0 ? headerRowIndex : 0] || []).map((cell) => text(cell)).filter(Boolean);
    const bodyRows = rows.slice((headerRowIndex >= 0 ? headerRowIndex : 0) + 1);
    const flattenedRows = flattenedPlanRows(headers, bodyRows);
    if (flattenedRows.length) {
      return {
        title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
        source: 'raw-table',
        headers: standardPlanHeaders(),
        rows: flattenedRows,
      };
    }
    if (headers.length && bodyRows.length) {
      return {
        title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
        source: 'raw-table',
        headers,
        rows: bodyRows,
      };
    }
  }

  const markdown = markdownText(table.markdown || table.md || table.block_content || table.content || table.table_ocr_pred);
  if (markdown.includes('|')) {
    const markdownTables = collectMarkdownTables(markdown, 'raw-table');
    if (markdownTables[0]) {
      return {
        ...markdownTables[0],
        title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
      };
    }
  }

  let rows = normalizeRows(table.rows || table.table_rows || table.data);
  if (!rows.length && Array.isArray(table.cells)) rows = normalizeRows(rowsFromCells(table.cells));
  if (!rows.length && Array.isArray(table.table_cells)) rows = normalizeRows(rowsFromCells(table.table_cells));

  const explicitHeaders = table.headers || table.header || table.columns;
  const headers = Array.isArray(explicitHeaders) ? explicitHeaders.map((cell) => text(cell)).filter(Boolean) : [];
  const headerRowIndex = headers.length ? -1 : rows.findIndex(looksLikePlanTableHeader);
  const inferredHeaderIndex = headerRowIndex >= 0 ? headerRowIndex : 0;
  const bodyRows = headers.length ? rows : rows.slice(inferredHeaderIndex + 1);
  const inferredHeaders = headers.length ? headers : (rows[inferredHeaderIndex] || []).map((cell) => text(cell)).filter(Boolean);
  const labeledRows = labeledPlanRows(rows);
  if (labeledRows.length) {
    return {
      title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
      source: 'raw-table',
      headers: standardPlanHeaders(),
      rows: labeledRows,
    };
  }
  const flattenedRows = flattenedPlanRows(inferredHeaders, bodyRows);
  if (flattenedRows.length) {
    return {
      title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
      source: 'raw-table',
      headers: standardPlanHeaders(),
      rows: flattenedRows,
    };
  }

  if (!inferredHeaders.length || !bodyRows.length) return null;
  return {
    title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
    source: 'raw-table',
    headers: inferredHeaders,
    rows: bodyRows,
  };
}

function positionedToken(textValue, poly) {
  if (!Array.isArray(poly) || poly.length === 0) return null;
  const points = poly.filter((point) => Array.isArray(point) && point.length >= 2);
  if (!points.length) return null;
  const x = points.reduce((sum, point) => sum + Number(point[0] || 0), 0) / points.length;
  const y = points.reduce((sum, point) => sum + Number(point[1] || 0), 0) / points.length;
  return {
    text: text(textValue),
    x,
    y,
  };
}

function tokensFromTableOcrPred(table = {}) {
  const pred = table?.table_ocr_pred || table;
  const texts = Array.isArray(pred?.rec_texts) ? pred.rec_texts : [];
  const polys = Array.isArray(pred?.rec_polys) ? pred.rec_polys : [];
  return texts
    .map((value, index) => positionedToken(value, polys[index]))
    .filter((token) => token && token.text);
}

function findToken(tokens, pattern) {
  return tokens.find((token) => pattern.test(compact(token.text))) || null;
}

function midpoint(left, right) {
  return (left + right) / 2;
}

function inBand(token, lower, upper) {
  return token.y >= lower && token.y < upper;
}

function tokenTextInColumn(tokens, lower, upper, minX, maxX, joiner = ' ') {
  return tokens
    .filter((token) => inBand(token, lower, upper) && token.x >= minX && token.x < maxX)
    .sort((left, right) => (left.y - right.y) || (left.x - right.x))
    .map((token) => token.text)
    .join(joiner)
    .trim();
}

function cleanPlanName(value) {
  const raw = compact(value)
    .replace(/险种名称|产品名称|保险名称|基本保险金额|保险金额|保障计划|份数/gu, '')
    .trim();
  return raw.split(/特别约定|备注|保单说明|保险公司签章|保险合同专用章|业务员|保单签发地|服务电话/u)[0] || raw;
}

function cleanCoveragePeriod(value) {
  const raw = text(value);
  if (!raw) return '';
  const matched = raw.match(/至\s*\d{4}年\d{1,2}月\d{1,2}日(?:零时)?/u)
    || raw.match(/终身/u)
    || raw.match(/\d+\s*年/u);
  return matched ? compact(matched[0]) : '';
}

function cleanPaymentPeriod(value) {
  const raw = text(value);
  if (!raw) return '';
  if (/一次交清|趸交/u.test(raw)) return raw.match(/一次交清|趸交/u)?.[0] || '';
  const exactYear = compact(raw).match(/^(\d{1,2})年$/u);
  if (exactYear) return `${exactYear[1]}年`;
  const slashMatched = raw.match(/\/\s*(\d{1,2})\s*年(?:交|缴)?/u);
  if (slashMatched) return `${slashMatched[1]}年`;
  const labeledYear = raw.match(/(?:^|[^\d年月日])(\d{1,2})\s*年(?:$|[^\d年月日])/u);
  if (labeledYear) return `${labeledYear[1]}年`;
  const matched = raw.match(/(?:^|[^\d年月日])(\d{1,2})\s*年(?:交|缴|期)/u);
  return matched ? `${matched[1]}年` : '';
}

function cleanGlobalCoveragePeriod(value) {
  const raw = text(value);
  if (!raw) return '';
  const matched = raw.match(/\d{4}年\d{1,2}月\d{1,2}日(?:零时)?(?:起)?至\d{4}年\d{1,2}月\d{1,2}日(?:二十四时止|零时)?/u);
  if (matched) return matched[0].replace(/起至/u, '至');
  return cleanCoveragePeriod(raw);
}

function findTokenTotalPremium(tokens, minPremiumX = 0) {
  const totalLabel = tokens.find((token) => isTotalPremiumText(token.text));
  if (!totalLabel) return '';
  const nearby = tokens
    .filter((token) => token.x >= minPremiumX && Math.abs(token.y - totalLabel.y) <= 80)
    .filter((token) => normalizeAmount(token.text))
    .sort((left, right) => right.x - left.x);
  return normalizeAmount(nearby[0]?.text || '');
}

function tokenTableGlobalFields(tokens) {
  const sourceText = tokens
    .slice()
    .sort((left, right) => (left.y - right.y) || (left.x - right.x))
    .map((token) => token.text)
    .join(' ');
  return {
    coveragePeriod: cleanGlobalCoveragePeriod(sourceText),
    paymentPeriod: cleanPaymentPeriod(sourceText),
  };
}

function tokenTextWithSuffix(token, tokens, maxX) {
  let value = compact(token?.text || '');
  if (!value) return '';
  if (!/(?:保|医|责)$/u.test(value)) return value;
  const suffix = tokens
    .filter((item) => item.y > token.y && item.y - token.y <= 45)
    .filter((item) => item.x < maxX)
    .sort((left, right) => (left.y - right.y) || (left.x - right.x))
    .find((item) => /^(险|保险)$/u.test(compact(item.text)));
  return suffix ? `${value}${compact(suffix.text)}` : value;
}

function leadingPlanName(value) {
  const raw = compact(value);
  if (!raw || isTotalPremiumText(raw)) return '';
  if (isExplanationText(raw)) return '';
  if (raw.length <= 2 && /^[险金保]+$/u.test(raw)) return '';
  if (isNonProductBenefitLabel(raw) && !raw.startsWith('附加')) return '';
  if (!looksLikePlanName(raw) && !raw.startsWith('附加')) return '';
  const insuranceOffset = raw.indexOf('保险');
  if (insuranceOffset >= 0) return raw.slice(0, insuranceOffset + '保险'.length);
  if (hasConcreteProductSuffix(raw)) return raw;
  return '';
}

function nearestAmountForProduct(tokens, productToken, amountX) {
  const candidates = tokens
    .filter((token) => Math.abs(token.x - amountX) <= 90)
    .filter((token) => Math.abs(token.y - productToken.y) <= 55)
    .filter((token) => /元/u.test(token.text))
    .map((token) => ({
      token,
      distance: Math.abs(token.y - productToken.y),
    }))
    .sort((left, right) => left.distance - right.distance);
  return candidates[0]?.token?.text || '';
}

function normalizeResponsibilityTokenTable(table = {}, index = 0) {
  const tokens = tokensFromTableOcrPred(table);
  if (!tokens.length) return null;

  const nameHeader = findToken(tokens, /险种名称|产品名称|保险名称/u);
  const responsibilityHeader = findToken(tokens, /保险责任名称|责任名称|保障责任/u);
  const amountHeader = findToken(tokens, /金额\/份数|基本保险金额|保险金额|保额/u);
  const benefitHeader = findToken(tokens, /给付标准|赔付比例|免赔额/u);
  if (!nameHeader || !responsibilityHeader || !amountHeader || !benefitHeader) return null;

  const planMaxX = midpoint(nameHeader.x, responsibilityHeader.x);
  const planSearchMaxX = amountHeader.x;
  const bodyTokens = tokens
    .filter((token) => token.y > nameHeader.y + 15)
    .sort((left, right) => (left.y - right.y) || (left.x - right.x));
  const globalFields = tokenTableGlobalFields(tokens);
  const rows = [];
  const seen = new Set();

  for (const token of bodyTokens) {
    if (token.x >= planSearchMaxX) continue;
    if (token.x >= planMaxX && !compact(token.text).startsWith('附加')) continue;

    const candidate = leadingPlanName(tokenTextWithSuffix(token, bodyTokens, planMaxX));
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    rows.push([
      candidate,
      nearestAmountForProduct(tokens, token, amountHeader.x),
      globalFields.coveragePeriod,
      globalFields.paymentPeriod,
      '',
    ]);
  }

  const totalPremium = findTokenTotalPremium(tokens, amountHeader.x);
  if (totalPremium) rows.push(['首期保险费合计', '', '', '', totalPremium]);

  if (!rows.length) return null;
  return {
    title: text(table.title || table.name || table.label || `原始责任明细表${index + 1}`),
    source: 'raw-table',
    headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
    rows,
  };
}

function normalizeTokenTable(table = {}, index = 0) {
  const tokens = tokensFromTableOcrPred(table);
  if (!tokens.length) return null;
  if (!tokens.some((token) => /保险利益表/u.test(token.text))) return null;

  const nameHeader = findToken(tokens, /险种名称|产品名称|保险名称/u);
  const amountHeader = findToken(tokens, /基本保险金额|保险金额|保额/u);
  const coverageHeader = findToken(tokens, /保险期间|保障期间/u);
  const paymentHeader = findToken(tokens, /交费方式|交费期间|缴费期间|续期保险费交费日期/u);
  const premiumHeader = [...tokens].reverse().find((token) => /^保险费$/u.test(compact(token.text)))
    || findToken(tokens, /保险费/u);

  if (!nameHeader || !amountHeader || !coverageHeader || !premiumHeader) return null;

  const nameMax = midpoint(nameHeader.x, amountHeader.x);
  const amountMax = midpoint(amountHeader.x, coverageHeader.x);
  const paymentX = paymentHeader?.x || midpoint(coverageHeader.x, premiumHeader.x);
  const coverageMax = midpoint(coverageHeader.x, paymentX);
  const premiumMin = midpoint(paymentX, premiumHeader.x);

  const amountTokens = tokens
    .filter((token) => token.y > nameHeader.y + 20)
    .filter((token) => token.x >= nameMax && token.x < amountMax)
    .filter((token) => normalizeAmount(token.text))
    .filter((token) => !isTotalPremiumText(token.text))
    .sort((left, right) => left.y - right.y);

  const rows = [];
  for (let indexInAmounts = 0; indexInAmounts < amountTokens.length; indexInAmounts += 1) {
    const amountToken = amountTokens[indexInAmounts];
    const previous = amountTokens[indexInAmounts - 1];
    const next = amountTokens[indexInAmounts + 1];
    const lower = previous ? midpoint(previous.y, amountToken.y) : amountToken.y - 70;
    const upper = next ? midpoint(amountToken.y, next.y) : amountToken.y + 90;
    const name = cleanPlanName(tokenTextInColumn(tokens, lower, upper, 0, nameMax, ''));
    if (!looksLikePlanName(name)) continue;

    const coverageText = tokenTextInColumn(tokens, lower, upper, amountMax, coverageMax, ' ');
    const paymentText = tokenTextInColumn(tokens, lower, upper, coverageMax, premiumMin, ' ');
    const premiumText = tokenTextInColumn(tokens, lower, upper, premiumMin, Number.POSITIVE_INFINITY, ' ');
    rows.push([
      name,
      amountToken.text,
      cleanCoveragePeriod(`${coverageText} ${paymentText}`),
      cleanPaymentPeriod(`${coverageText} ${paymentText}`),
      premiumText,
    ]);
  }

  const totalPremium = findTokenTotalPremium(tokens, premiumMin);
  if (totalPremium) rows.push(['首期保险费合计', '', '', '', totalPremium]);
  if (!rows.length) return null;

  return {
    title: text(table.title || table.name || table.label || `原始OCR重建表${index + 1}`),
    source: 'raw-table',
    headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
    rows,
  };
}

function uniqueTables(tables = []) {
  const seen = new Set();
  const unique = [];
  for (const table of tables) {
    if (!table) continue;
    const key = JSON.stringify([table.headers, table.rows]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(table);
  }
  return unique;
}

function isTableBlock(block) {
  return /table|表格/u.test(compact(block?.type || block?.block_type || block?.block_label || block?.label));
}

function collectRawTables(raw) {
  const tables = [];
  const tokenTables = [];
  for (const payload of rawPayloads(raw)) {
    if (Array.isArray(payload.tables)) tables.push(...payload.tables);
    if (Array.isArray(payload.table)) tables.push(...payload.table);
    if (Array.isArray(payload.table_res_list)) {
      tables.push(...payload.table_res_list);
      tokenTables.push(...payload.table_res_list);
    }
    if (payload.table && typeof payload.table === 'object' && !Array.isArray(payload.table)) {
      tables.push(payload.table);
    }
    for (const key of ['blocks', 'layout', 'parsing_res_list']) {
      if (Array.isArray(payload[key])) {
        tables.push(...payload[key].filter(isTableBlock));
      }
    }
  }
  return uniqueTables([
    ...tokenTables.map(normalizeResponsibilityTokenTable),
    ...tables.map(normalizeRawTable),
    ...tokenTables.map(normalizeTokenTable),
  ].filter(Boolean));
}

function headerIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(compact(header))));
}

function planColumns(headers = []) {
  return {
    name: headerIndex(headers, [/险种名称/u, /产品名称/u, /保险名称/u, /主险名称/u]),
    amount: headerIndex(headers, [/基本保险金额/u, /保险金额/u, /保额/u, /金额/u]),
    coveragePeriod: headerIndex(headers, [/保险期间/u, /保障期间/u]),
    paymentPeriod: headerIndex(headers, [/交费期间/u, /缴费期间/u, /缴费年期/u, /交费年期/u]),
    premium: headerIndex(headers, [/首期保险费/u, /保险费/u, /保费/u]),
  };
}

function isTotalPremiumText(value) {
  return /首期保险费合计|首期保费合计|保险费合计|合计保费|应交保险费合计/u.test(compact(value));
}

function isExplanationText(value) {
  return /保险责任说明|本保险合同|说明|条款|备注|提示|详见|责任免除|特别约定|本栏空白|保单说明|保险公司签章|保险合同专用章|业务员|保单签发地|服务电话/u.test(compact(value));
}

function isHeaderLikeRow(row = [], headers = []) {
  const rowText = compact(row.join(''));
  if (!rowText) return true;
  if (rowText === compact(headers.join(''))) return true;
  return /险种名称|产品名称|基本保险金额|保险期间|交费期间|缴费期间/u.test(rowText)
    && row.filter(Boolean).length <= headers.length;
}

function looksLikePlanName(value) {
  const name = compact(value);
  if (!name || isTotalPremiumText(name)) return false;
  return /保险|险|寿|年金|医疗|意外|重疾|疾病|两全|万能|豁免/u.test(name);
}

function isNonProductBenefitLabel(value) {
  return /责任名称|保障内容|保障项目|保障责任|保险责任|责任免除|给付(?:标准)?|赔付(?:比例)?|免赔额|现金价值|保险金|责任/u.test(compact(value));
}

function hasConcreteProductSuffix(value) {
  return /(?:保险|险|寿险|年金|医疗|意外|重疾|疾病|两全|万能|豁免)(?:（[^）]+）)?$/u.test(compact(value));
}

function hasPlanDetail(row, columns) {
  return [columns.amount, columns.coveragePeriod, columns.paymentPeriod, columns.premium]
    .some((index) => Boolean(fieldFromRow(row, index)));
}

function hasConcretePlanDetail(row, columns) {
  const amountText = fieldFromRow(row, columns.amount);
  const premiumText = fieldFromRow(row, columns.premium);
  const amount = !isExplanationText(amountText) ? normalizeAmount(amountText) : '';
  const premium = !isExplanationText(premiumText) ? normalizeAmount(premiumText) : '';
  const paymentPeriod = compact(fieldFromRow(row, columns.paymentPeriod));
  const coveragePeriod = compact(fieldFromRow(row, columns.coveragePeriod));
  return Boolean(amount || premium)
    || /(?:\d+|一|二|三|四|五|六|七|八|九|十|终身).*(?:年|岁|交|期|终身)|至\d{4}|终身/u.test(paymentPeriod)
    || (/^(?!.*(?:详见|条款|说明|备注|提示)).*(?:\d+年|终身|至\d{4})/u.test(coveragePeriod));
}

function planNameFromRow(row, columns) {
  const namedColumnValue = fieldFromRow(row, columns.name);
  if (namedColumnValue && !isTotalPremiumText(namedColumnValue)) {
    return namedColumnValue;
  }
  return row.find(looksLikePlanName) || '';
}

function isPlanCandidate(name, row, columns) {
  if (!name || isTotalPremiumText(name)) return false;
  if (isExplanationText(name)) return false;
  if (isNonProductBenefitLabel(name) && !hasConcreteProductSuffix(name)) return false;
  if (isExplanationText(row.join(' ')) && !hasConcretePlanDetail(row, columns)) return false;
  const isNameColumnValue = fieldFromRow(row, columns.name) === name;
  if (!hasPlanDetail(row, columns)) {
    return isNameColumnValue || (looksLikePlanName(name) && hasConcreteProductSuffix(name));
  }
  if (hasPlanDetail(row, columns)) {
    return isNameColumnValue || looksLikePlanName(name);
  }
  return false;
}

function fieldFromRow(row, index) {
  return index >= 0 ? text(row[index]) : '';
}

function totalPremiumValue(row, premiumIndex) {
  const joined = row.join(' ');
  const afterTotalLabel = joined.split(/首期保险费合计|首期保费合计|保险费合计|合计保费|应交保险费合计/u).pop() || joined;
  const labeledCurrency = afterTotalLabel.match(/[Y¥￥]\s*(\d+(?:\.\d+)?)/iu);
  if (labeledCurrency) return normalizeAmount(labeledCurrency[1]);
  const labeledYuan = afterTotalLabel.match(/(\d+(?:\.\d+)?)\s*元/u);
  if (labeledYuan) return normalizeAmount(labeledYuan[1]);

  const currencyMatches = [...joined.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/gu)];
  if (currencyMatches.length) return normalizeAmount(currencyMatches.at(-1)?.[0] || '');

  const premiumCell = normalizeAmount(fieldFromRow(row, premiumIndex));
  if (premiumCell) return premiumCell;
  for (let index = row.length - 1; index >= 0; index -= 1) {
    const value = normalizeAmount(row[index]);
    if (value) return value;
  }
  return '';
}

function sourceLabel(table, rowIndex) {
  return `${table.source} row ${rowIndex + 1}`;
}

function isResponsibilityDetailTable(table = {}) {
  const tableText = compact([
    ...(table.headers || []),
    ...(table.rows || []).flat(),
  ].join(' '));
  return /保险责任名称|责任名称|保障责任/u.test(tableText)
    && /给付标准|赔付比例|免赔额|金额\/份数/u.test(tableText);
}

function extractPlansAndPremium(tables = []) {
  const plans = [];
  let totalPremium = null;

  for (const table of tables) {
    const columns = planColumns(table.headers);
    const skipPlanRows = isResponsibilityDetailTable(table) && columns.name < 0;
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex];
      const joined = row.join(' ');
      if (isHeaderLikeRow(row, table.headers)) continue;

      if (isTotalPremiumText(joined)) {
        const value = totalPremiumValue(row, columns.premium);
        if (value) {
          totalPremium = {
            value,
            source: 'premium-total-row',
            evidence: joined,
          };
        }
        continue;
      }

      if (skipPlanRows) continue;

      const name = planNameFromRow(row, columns);
      if (!isPlanCandidate(name, row, columns)) continue;

      const planIndex = plans.length;
      plans.push({
        role: planIndex === 0 ? 'main' : 'rider',
        name,
        amount: normalizeAmount(fieldFromRow(row, columns.amount)),
        paymentPeriod: fieldFromRow(row, columns.paymentPeriod),
        coveragePeriod: fieldFromRow(row, columns.coveragePeriod),
        premium: normalizeAmount(fieldFromRow(row, columns.premium)),
        source: sourceLabel(table, rowIndex),
      });
    }
  }

  return { plans: mergePlans(plans), totalPremium };
}

function mergePlans(plans = []) {
  const merged = [];
  const byName = new Map();
  for (const plan of plans) {
    const key = compact(plan.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, plan);
      merged.push(plan);
      continue;
    }
    for (const field of ['amount', 'paymentPeriod', 'coveragePeriod', 'premium']) {
      if (!existing[field] && plan[field]) existing[field] = plan[field];
    }
    if (plan.source && !existing.source.includes(plan.source)) {
      existing.source = `${existing.source}; ${plan.source}`;
    }
  }
  return merged.map((plan, index) => ({
    ...plan,
    role: index === 0 ? 'main' : 'rider',
  }));
}

function findCompany(sourceText) {
  const patterns = [
    /新华(?:人寿)?保险(?:股份有限公司)?/u,
    /中国平安(?:人寿|保险)?(?:股份有限公司)?/u,
    /中国人寿(?:保险)?(?:股份有限公司)?/u,
    /中国太平洋(?:人寿)?保险(?:股份有限公司)?/u,
    /太平人寿(?:保险)?/u,
    /泰康(?:人寿|保险)/u,
    /友邦(?:人寿|保险)/u,
  ];
  return patterns.map((pattern) => sourceText.match(pattern)?.[0]).find(Boolean) || '';
}

function findStopOffset(value, stopLabels) {
  let offset = value.length;
  const delimiter = value.search(/[\n|，,；;]/u);
  if (delimiter >= 0) offset = Math.min(offset, delimiter);
  for (const label of stopLabels) {
    const found = value.indexOf(label);
    if (found >= 0) offset = Math.min(offset, found);
  }
  return offset;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findLabeledValue(sourceText, labels, stopLabels = []) {
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}(?:姓名)?[:：\\s]*`, 'u');
    const matched = sourceText.match(pattern);
    if (!matched) continue;
    const valueStart = matched.index + matched[0].length;
    const rest = sourceText.slice(valueStart);
    const value = rest.slice(0, findStopOffset(rest, stopLabels)).trim();
    if (value) return value.replace(/^姓名[:：\s]*/u, '').trim();
  }
  return '';
}

function findLabeledValues(sourceText, labels, stopLabels = []) {
  const values = [];
  for (const label of labels) {
    const pattern = new RegExp(`${escapeRegExp(label)}(?:姓名)?[:：\\s]*`, 'gu');
    for (const matched of sourceText.matchAll(pattern)) {
      const valueStart = matched.index + matched[0].length;
      const rest = sourceText.slice(valueStart);
      const effectiveStopLabels = [...stopLabels, ...labels.filter((item) => item !== label)];
      const value = rest.slice(0, findStopOffset(rest, effectiveStopLabels)).trim();
      if (value) values.push(value.replace(/^姓名[:：\s]*/u, '').trim());
    }
  }
  return [...new Set(values)].filter(Boolean);
}

function fieldCandidate(value, source, evidence) {
  return value ? { value, source, evidence } : null;
}

function findTotalPremiumInText(sourceText) {
  const labelPattern = /首期保险费合计|首期保费合计|保险费合计|合计保费|应交保险费合计/gu;
  for (const matched of sourceText.matchAll(labelPattern)) {
    const before = sourceText.slice(Math.max(0, matched.index - 80), matched.index);
    const beforeCurrency = [...before.matchAll(/[Y¥￥]\s*(\d+(?:\.\d+)?)/giu)].at(-1);
    if (beforeCurrency) {
      return {
        value: normalizeAmount(beforeCurrency[1]),
        source: 'premium-total-text',
        evidence: `${beforeCurrency[0]} ${matched[0]}`,
      };
    }

    const after = sourceText
      .slice(matched.index + matched[0].length, matched.index + matched[0].length + 100)
      .split(/特别约定|保单说明|备注|条款/u)[0] || '';
    const afterCurrency = after.match(/[Y¥￥]\s*(\d+(?:\.\d+)?)/iu)
      || after.match(/(\d+(?:\.\d+)?)\s*元/u);
    if (afterCurrency) {
      return {
        value: normalizeAmount(afterCurrency[1]),
        source: 'premium-total-text',
        evidence: `${matched[0]} ${afterCurrency[0]}`,
      };
    }
  }
  return null;
}

function findBeneficiaryRoster(sourceText) {
  const matched = sourceText.match(/受益人(?<body>[\s\S]*?)(?:合同生效日期|合同成立日期|首期保险费交费日期|险种名称|保险利益表|保险合同号|保单号)/u);
  const body = matched?.groups?.body || '';
  if (!body || !/受益顺序|受益份额|身份证\s*[:：]?\s*\d|证件号码\s*[:：]?\s*\d|\d+(?:\.\d+)?%/u.test(body)) return '';
  const names = [...body.matchAll(/[\p{Script=Han}·]{2,10}/gu)]
    .map((item) => item[0])
    .map((name) => name.replace(/^(?:受益人|证件号码|受益顺序|受益份额|身份证|身份|性别)+/u, ''))
    .map((name) => name.replace(/(?:受益人|证件号码|受益顺序|受益份额|身份证|身份|性别)+$/u, ''))
    .filter((name) => /^[\p{Script=Han}·]{2,8}$/u.test(name))
    .filter((name) => !/受益人|证件号码|受益顺序|受益份额|身份证|身份|性别/u.test(name))
    .filter((name) => !/合同|保险|日期|险种|金额|期间|交费/u.test(name));
  const namesBeforeId = [...body.matchAll(/([\p{Script=Han}·]{2,8})\s*(?:身份|身份证|证件)/gu)]
    .map((item) => item[1])
    .filter((name) => !/受益人|证件号码|受益顺序|受益份额/u.test(name));
  return [...new Set([...namesBeforeId, ...names])].join('；');
}

function findBeneficiary(sourceText) {
  const roster = findBeneficiaryRoster(sourceText);
  if (roster) return roster;
  return findLabeledValues(sourceText, [
    '残疾保险金、意外医疗保险金受益人',
    '生存保险金受益人',
    '身故保险金受益人',
    '身故受益人',
    '受益人',
  ], [
    '证件号码',
    '受益顺序',
    '受益份额',
    '金额/份数',
    '给付标准',
    '身份证',
    '身份',
    '性别',
    '合同生效日期',
    '合同成立日期',
    '首期保险费交费日期',
    '保险利益表',
    '险种名称',
    '保险责任名称',
    '保单号',
    '保险合同号',
    '合同号',
    '经投保人',
    '投保人',
    '设保人',
  ]).join('；');
}

function premiumMatchesPlanTotal(plans = [], totalPremium) {
  if (!totalPremium?.value) return false;
  const sum = plans.reduce((total, plan) => total + (Number(plan.premium) || 0), 0);
  return sum > 0 && Math.abs(sum - Number(totalPremium.value)) < 0.01;
}

function findPremiumTotal({ sourceText, plans, totalPremium }) {
  if (totalPremium?.value && premiumMatchesPlanTotal(plans, totalPremium)) return totalPremium;
  if (totalPremium?.value && !plans.length) return totalPremium;
  const textTotalPremium = findTotalPremiumInText(sourceText);
  if (textTotalPremium?.value) return textTotalPremium;
  return totalPremium?.value ? totalPremium : null;
}

function buildPolicyFields({ sourceText, plans, totalPremium }) {
  const fields = {};
  const company = findCompany(sourceText);
  const applicant = findLabeledValue(sourceText, ['投保人', '设保人'], [
    '合同成立日期',
    '合同生效日期',
    '证件号码',
    '身份证',
    '身份',
    '性别',
    '被保险人',
    '被保人',
    '受保人',
    '受益顺序',
    '受益份额',
    '学校名称',
    '班级',
    '身故保险金受益人',
    '身故受益人',
    '受益人',
    '保险利益表',
  ]);
  const insured = findLabeledValue(sourceText, ['被保险人', '被保人', '受保人'], [
    '合同成立日期',
    '合同生效日期',
    '证件号码',
    '身份证',
    '身份',
    '性别',
    '投保人',
    '设保人',
    '受益顺序',
    '受益份额',
    '学校名称',
    '班级',
    '残疾保险金',
    '意外医疗保险金受益人',
    '身故保险金受益人',
    '身故受益人',
    '受益人',
    '保险利益表',
  ]);
  const beneficiary = findBeneficiary(sourceText);

  fields.company = fieldCandidate(company, 'text', company) || undefined;
  if (plans[0]?.name) {
    fields.productName = {
      value: plans[0].name,
      source: 'plans[0].name',
      evidence: '保险利益表第1个有效产品行',
    };
  }
  fields.applicant = fieldCandidate(applicant, 'text', `投保人 ${applicant}`) || undefined;
  fields.insured = fieldCandidate(insured, 'text', `被保险人 ${insured}`) || undefined;
  fields.beneficiary = fieldCandidate(beneficiary, 'text', `受益人 ${beneficiary}`) || undefined;
  fields.firstPremium = findPremiumTotal({ sourceText, plans, totalPremium }) || undefined;

  for (const key of Object.keys(fields)) {
    if (!fields[key]) delete fields[key];
  }
  return fields;
}

function missingCoreFields(fields, plans) {
  const required = ['company', 'productName', 'applicant', 'insured', 'beneficiary', 'firstPremium'];
  const missing = required.filter((field) => !fields[field]?.value);
  if (!plans.length) missing.push('plans');
  return missing;
}

function warningForMissing(field) {
  const labels = {
    company: '缺少保险公司',
    productName: '缺少产品名称',
    applicant: '缺少投保人',
    insured: '缺少被保险人',
    beneficiary: '缺少受益人',
    firstPremium: '缺少首期保费合计',
    plans: '缺少主险/附加险计划行',
  };
  return labels[field] || `缺少${field}`;
}

function planWarnings(plans) {
  const labels = {
    amount: '保额',
    paymentPeriod: '缴费期间',
    coveragePeriod: '保障期间',
    premium: '保费',
  };
  const warnings = [];
  for (const plan of plans) {
    for (const [key, label] of Object.entries(labels)) {
      if (!plan[key]) warnings.push(`计划行 ${plan.source} ${plan.name} 缺少${label}`);
    }
    if (plan.role === 'unknown') warnings.push(`计划行 ${plan.source} ${plan.name} 角色待确认`);
  }
  return warnings;
}

export function normalizeStructureV3Inspection({ raw = {}, markdown = '' } = {}) {
  const blocks = collectBlocks(raw);
  const rawTables = collectRawTables(raw);
  const markdownTables = rawTables.length ? [] : collectMarkdownTables(markdown);
  const tables = rawTables.length ? rawTables : markdownTables;
  const rawTexts = collectStandaloneTexts(raw);
  const ocrText = [
    ...rawTexts,
    ...blocks.map((block) => block.text),
    ...tables.flatMap((table) => [table.headers.join(' '), ...table.rows.map((row) => row.join(' '))]),
  ].filter(Boolean).join('\n');
  const fieldSourceText = [
    ...rawTexts,
    ...blocks.map((block) => block.text),
    ocrText,
  ].filter(Boolean).join('\n');
  const { plans, totalPremium } = extractPlansAndPremium(tables);
  const policyFields = buildPolicyFields({ sourceText: fieldSourceText, plans, totalPremium });
  const missingFields = missingCoreFields(policyFields, plans);
  const ambiguousFields = plans.some((plan) => plan.role === 'unknown') ? ['planRole'] : [];
  const warnings = [
    ...(!rawTables.length && markdownTables.length ? ['原始表格不可用，已降级使用 Markdown 表格'] : []),
    ...(!tables.length ? ['未识别到可用表格'] : []),
    ...missingFields.map(warningForMissing),
    ...planWarnings(plans),
  ];

  return {
    normalized: {
      ocrText,
      blocks,
      tables,
      warnings,
    },
    candidates: {
      policyFields,
      plans,
      missingFields,
      ambiguousFields,
    },
  };
}

function fieldLine(label, field) {
  return `- ${label}: ${field?.value || '未识别'}${field?.source ? ` (${field.source})` : ''}`;
}

function planLine(plan) {
  const roleLabel = plan.role === 'main' ? '主险' : plan.role === 'rider' ? '附加险' : '待确认';
  return `- ${roleLabel}: ${plan.name || '未识别'} | 保额 ${plan.amount || '缺失'} | 缴费期间 ${plan.paymentPeriod || '缺失'} | 保障期间 ${plan.coveragePeriod || '缺失'} | 保费 ${plan.premium || '缺失'} | ${plan.source}`;
}

function recommendation(result) {
  const hasRawTable = result?.normalized?.tables?.some((table) => table.source === 'raw-table');
  const plans = result?.candidates?.plans || [];
  const missing = result?.candidates?.missingFields || [];
  const completePlans = plans.every((plan) => plan.role !== 'unknown'
    && plan.amount
    && plan.paymentPeriod
    && plan.coveragePeriod
    && plan.premium);
  if (hasRawTable && plans.length && completePlans && missing.length <= 2) return '建议接入正式流程';
  if (plans.length) return '需要更多样本';
  return '暂不建议接入';
}

export function buildStructureV3InspectionReport({ input = '', result, pythonStatus = {} } = {}) {
  const fields = result?.candidates?.policyFields || {};
  const plans = result?.candidates?.plans || [];
  const warnings = result?.normalized?.warnings || [];
  const missingFields = result?.candidates?.missingFields || [];
  const ambiguousFields = result?.candidates?.ambiguousFields || [];
  const rawTableUsable = result?.normalized?.tables?.some((table) => table.source === 'raw-table');
  const lines = [
    '# PP-StructureV3 离线验证报告',
    '',
    `- 输入: ${input || '未记录'}`,
    `- 运行状态: ${pythonStatus.ok ? '成功' : '失败'}`,
    `- 设备: ${pythonStatus.device || '未记录'}`,
    `- 原始表格: ${rawTableUsable ? '可用' : '不可用'}`,
    `- 计划行数: ${plans.length}`,
    '',
    '## 核心字段',
    '',
    fieldLine('保险公司', fields.company),
    fieldLine('产品名称', fields.productName),
    fieldLine('投保人', fields.applicant),
    fieldLine('被保险人', fields.insured),
    fieldLine('受益人', fields.beneficiary),
    fieldLine('首期保费合计', fields.firstPremium),
    '',
    '## 主险和附加险',
    '',
    ...(plans.length ? plans.map(planLine) : ['- 未识别到计划行']),
    '',
    `主险: ${plans.find((plan) => plan.role === 'main')?.name || '未识别'}`,
    ...plans.filter((plan) => plan.role === 'rider').map((plan) => `附加险: ${plan.name}`),
    `首期保费合计: ${fields.firstPremium?.value || '未识别'}`,
    '',
    '## 缺失、多候选和警告',
    '',
    `- 缺失字段: ${missingFields.length ? missingFields.join(', ') : '无'}`,
    `- 多候选字段: ${ambiguousFields.length ? ambiguousFields.join(', ') : '无'}`,
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ['- 无警告']),
    '',
    `## 结论: ${recommendation(result)}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}
