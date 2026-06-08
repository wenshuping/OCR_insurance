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
      const headers = rows[0].map(text).filter(Boolean);
      const bodyRows = rows.slice(isMarkdownDivider(rows[1]) ? 2 : 1);
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

function normalizeRawTable(table = {}, index = 0) {
  if (!table || typeof table !== 'object') return null;
  const html = htmlText(table.pred_html || table.html || table.table_html || table.table_ocr_pred);
  if (/<(?:table|tr|td|th)\b/iu.test(html)) {
    const rows = normalizeRows(parseHtmlRows(html));
    const headers = (rows[0] || []).map((cell) => text(cell)).filter(Boolean);
    const bodyRows = rows.slice(1);
    if (headers.length && bodyRows.length) {
      return {
        title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
        source: 'raw-table',
        headers,
        rows: bodyRows,
      };
    }
  }

  const markdown = markdownText(table.markdown || table.md || table.block_content || table.content);
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
  const bodyRows = headers.length ? rows : rows.slice(1);
  const inferredHeaders = headers.length ? headers : (rows[0] || []).map((cell) => text(cell)).filter(Boolean);

  if (!inferredHeaders.length || !bodyRows.length) return null;
  return {
    title: text(table.title || table.name || table.label || `原始表格${index + 1}`),
    source: 'raw-table',
    headers: inferredHeaders,
    rows: bodyRows,
  };
}

function isTableBlock(block) {
  return /table|表格/u.test(compact(block?.type || block?.block_type || block?.block_label || block?.label));
}

function collectRawTables(raw) {
  const tables = [];
  for (const payload of rawPayloads(raw)) {
    if (Array.isArray(payload.tables)) tables.push(...payload.tables);
    if (Array.isArray(payload.table)) tables.push(...payload.table);
    if (Array.isArray(payload.table_res_list)) tables.push(...payload.table_res_list);
    if (payload.table && typeof payload.table === 'object' && !Array.isArray(payload.table)) {
      tables.push(payload.table);
    }
    for (const key of ['blocks', 'layout', 'parsing_res_list']) {
      if (Array.isArray(payload[key])) {
        tables.push(...payload[key].filter(isTableBlock));
      }
    }
  }
  return tables.map(normalizeRawTable).filter(Boolean);
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
  return /保险责任说明|本保险合同|说明|条款|备注|提示|详见/u.test(compact(value));
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
  if (namedColumnValue && !isTotalPremiumText(namedColumnValue) && hasPlanDetail(row, columns)) {
    return namedColumnValue;
  }
  return row.find(looksLikePlanName) || '';
}

function isPlanCandidate(name, row, columns) {
  if (!name || isTotalPremiumText(name)) return false;
  if (isExplanationText(`${name} ${row.join(' ')}`) && !hasConcretePlanDetail(row, columns)) return false;
  if (hasPlanDetail(row, columns)) {
    return fieldFromRow(row, columns.name) === name || looksLikePlanName(name);
  }
  return false;
}

function isRiderName(value) {
  return /附加|附加险|附加合同|附加医疗|附加意外/u.test(compact(value));
}

function fieldFromRow(row, index) {
  return index >= 0 ? text(row[index]) : '';
}

function totalPremiumValue(row, premiumIndex) {
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

function extractPlansAndPremium(tables = []) {
  const plans = [];
  let totalPremium = null;

  for (const table of tables) {
    const columns = planColumns(table.headers);
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

      const name = planNameFromRow(row, columns);
      if (!isPlanCandidate(name, row, columns)) continue;

      const planIndex = plans.length;
      plans.push({
        role: planIndex === 0 ? 'main' : (isRiderName(name) ? 'rider' : 'unknown'),
        name,
        amount: normalizeAmount(fieldFromRow(row, columns.amount)),
        paymentPeriod: fieldFromRow(row, columns.paymentPeriod),
        coveragePeriod: fieldFromRow(row, columns.coveragePeriod),
        premium: normalizeAmount(fieldFromRow(row, columns.premium)),
        source: sourceLabel(table, rowIndex),
      });
    }
  }

  return { plans, totalPremium };
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

function findLabeledValue(sourceText, labels, stopLabels = []) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}(?:姓名)?[:：\\s]*`, 'u');
    const matched = sourceText.match(pattern);
    if (!matched) continue;
    const valueStart = matched.index + matched[0].length;
    const rest = sourceText.slice(valueStart);
    const value = rest.slice(0, findStopOffset(rest, stopLabels)).trim();
    if (value) return value.replace(/^姓名[:：\s]*/u, '').trim();
  }
  return '';
}

function fieldCandidate(value, source, evidence) {
  return value ? { value, source, evidence } : null;
}

function buildPolicyFields({ sourceText, plans, totalPremium }) {
  const fields = {};
  const company = findCompany(sourceText);
  const applicant = findLabeledValue(sourceText, ['投保人', '设保人'], [
    '被保险人',
    '被保人',
    '受保人',
    '身故保险金受益人',
    '身故受益人',
    '受益人',
  ]);
  const insured = findLabeledValue(sourceText, ['被保险人', '被保人', '受保人'], [
    '投保人',
    '设保人',
    '身故保险金受益人',
    '身故受益人',
    '受益人',
  ]);
  const beneficiary = findLabeledValue(sourceText, ['身故保险金受益人', '身故受益人', '受益人'], [
    '保单号',
    '保险合同号',
    '合同号',
    '投保人',
    '设保人',
    '被保险人',
    '被保人',
    '受保人',
  ]);

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
  if (totalPremium?.value) fields.firstPremium = totalPremium;

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
  if (hasRawTable && plans.length && missing.length <= 2) return '建议接入正式流程';
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
