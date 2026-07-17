function text(value) {
  return String(value ?? '').trim();
}

function numericValue(value, unit) {
  const number = Number(String(value || '').replace(/,/gu, ''));
  if (!Number.isFinite(number)) return null;
  if (unit === '万元') return { value: number * 10_000, unit: 'CNY' };
  if (unit === '元') return { value: number, unit: 'CNY' };
  if (unit === '%') return { value: number, unit: 'PERCENT' };
  if (unit === '日' || unit === '天') return { value: number, unit: 'DAY' };
  if (unit === '个月' || unit === '月') return { value: number, unit: 'MONTH' };
  if (unit === '年') return { value: number, unit: 'YEAR' };
  if (unit === '周岁' || unit === '岁') return { value: number, unit: 'AGE' };
  return null;
}

function factRecord(chunk, fieldKey, matched, normalizedValue, scope = {}) {
  const semantic = chunk?.payload?.semantic || {};
  return {
    canonicalProductId: text(chunk?.canonicalProductId),
    productVersionId: text(chunk?.productVersionId),
    fieldKey,
    normalizedValue,
    displayValue: text(matched),
    scope: {
      plan: text(scope.plan),
      responsibility: text(scope.responsibility) || text(semantic.responsibility),
      period: text(scope.period),
    },
    exceptions: [],
    status: 'candidate',
    completeness: normalizedValue && text(chunk?.canonicalProductId) ? 'complete' : 'incomplete',
    evidenceChunkIds: [text(chunk?.id)].filter(Boolean),
    confidence: normalizedValue ? 0.9 : 0.5,
    extractorVersion: 'product-fact-extractor-v1',
  };
}

function planValueFacts(chunk, fieldKey, content, valuePattern, scope = {}) {
  const results = [];
  const pattern = new RegExp(`(计划(?:[一二三四五六七八九十]|[A-Z]|\\d+))[^\\d]{0,16}(\\d+(?:\\.\\d+)?)\\s*(${valuePattern})`, 'gu');
  for (const match of content.matchAll(pattern)) {
    const normalized = numericValue(match[2], match[3]);
    if (normalized) results.push(factRecord(chunk, fieldKey, `${match[2]}${match[3]}`, normalized, {
      ...scope,
      plan: match[1],
    }));
  }
  return results;
}

function matchingRows(content, pattern) {
  const rows = text(content).split('\n').map(text).filter(Boolean);
  const matched = rows.filter((row) => pattern.test(row));
  return matched.length ? matched : [text(content)];
}

function responsibilityFromLimitRow(value) {
  const prefix = text(value).split(/(?:年度)?(?:给付|责任)?限额/u)[0] || '';
  return text(prefix.replace(/^保障项目\s*\|?/u, '').replace(/[|：:]\s*$/u, ''));
}

function trailingRatioFact(chunk, content, scope = {}) {
  const match = text(content).match(/(\d+(?:\.\d+)?)\s*%\s*(?:赔付|给付|报销)/u);
  if (!match) return [];
  const normalized = numericValue(match[1], '%');
  return normalized ? [factRecord(chunk, 'reimbursement_ratio', `${match[1]}%`, normalized, scope)] : [];
}

function firstValueFact(chunk, fieldKey, content, keywordPattern, valuePattern, scope = {}) {
  const match = content.match(new RegExp(`(?:${keywordPattern})[^\\d]{0,20}(\\d+(?:\\.\\d+)?)\\s*(${valuePattern})`, 'u'));
  if (!match) return [];
  const normalized = numericValue(match[1], match[2]);
  return normalized ? [factRecord(chunk, fieldKey, `${match[1]}${match[2]}`, normalized, scope)] : [];
}

function factsFromChunk(chunk, excludedKeys = new Set()) {
  const semantic = chunk?.payload?.semantic || {};
  const keys = (Array.isArray(semantic.factKeys) ? semantic.factKeys : [])
    .filter((key) => !excludedKeys.has(key));
  const content = text(chunk?.content);
  const facts = [];
  for (const key of keys) {
    if (key === 'annual_deductible') {
      const rows = matchingRows(content, /(?:年度)?免赔额/u);
      rows.forEach((row) => facts.push(...planValueFacts(chunk, key, row, '万元|元')));
      if (!facts.some((item) => item.fieldKey === key)) {
        rows.forEach((row) => facts.push(...firstValueFact(chunk, key, row, '(?:年度)?免赔额(?:为|是|：|:)?', '万元|元', { period: /年度|每个保险期间/u.test(content) ? '每个保险期间' : '' })));
      }
    } else if (key === 'reimbursement_ratio') {
      const rows = matchingRows(content, /(?:赔付|给付|报销)比例|按\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*(?:赔付|给付|报销)/u);
      rows.forEach((row) => facts.push(...planValueFacts(chunk, key, row, '%')));
      if (!facts.some((item) => item.fieldKey === key)) {
        rows.forEach((row) => {
          const responsibility = /小额医疗/u.test(row) ? '小额医疗（可选责任）' : '';
          const scope = { responsibility, period: /年度免赔额/u.test(row) ? '对应年度免赔额后' : '' };
          const leading = firstValueFact(chunk, key, row, '(?:赔付|给付|报销)比例(?:为|是|：|:)?|按', '%', scope);
          facts.push(...leading, ...(leading.length ? [] : trailingRatioFact(chunk, row, scope)));
        });
      }
    } else if (key === 'benefit_limit') {
      const rows = matchingRows(content, /(?:年度|累计|给付|责任)?限额|最高(?:给付|报销)?/u);
      rows.forEach((row) => facts.push(...planValueFacts(chunk, key, row, '万元|元', {
        responsibility: responsibilityFromLimitRow(row),
        period: /年度/u.test(row) ? '年度' : '',
      })));
      if (!facts.some((item) => item.fieldKey === key)) {
        rows.forEach((row) => facts.push(...firstValueFact(chunk, key, row, '(?:年度|累计|给付|责任)?限额(?:为|是|：|:)?|最高(?:给付|报销)?', '万元|元', {
          responsibility: responsibilityFromLimitRow(row),
          period: /年度/u.test(row) ? '年度' : '',
        })));
      }
    } else if (key === 'waiting_period') {
      facts.push(...firstValueFact(chunk, key, content, '等待期(?:为|是|：|:)?', '日|天|个月|月|年'));
    } else if (key === 'entry_age') {
      facts.push(...firstValueFact(chunk, key, content, '(?:最高|最低)?投保年龄(?:为|是|：|:)?|最高可投保至', '周岁|岁'));
    } else if (key === 'renewal_period') {
      facts.push(...firstValueFact(chunk, key, content, '保证续保(?:期间)?(?:为|是|：|:)?|续保期间(?:为|是|：|:)?', '年'));
    }
  }
  return facts;
}

export function extractProductFactCandidates(input = {}) {
  const seen = new Set();
  const facts = [];
  const chunks = Array.isArray(input.chunks) ? input.chunks : [];
  const orderedChunks = [
    ...chunks.filter((chunk) => text(chunk?.chunkType) === 'table'),
    ...chunks.filter((chunk) => text(chunk?.chunkType) !== 'table'),
  ];
  const tableFactKeysByPage = new Map();
  for (const chunk of orderedChunks) {
    if (text(chunk?.chunkType) === 'parent' || text(chunk?.indexStatus) === 'blocked') continue;
    const pageNo = Number(chunk?.pageStart || 0);
    const excludedKeys = text(chunk?.chunkType) === 'child'
      ? tableFactKeysByPage.get(pageNo) || new Set()
      : new Set();
    const extracted = factsFromChunk(chunk, excludedKeys);
    if (text(chunk?.chunkType) === 'table' && extracted.length) {
      const keys = tableFactKeysByPage.get(pageNo) || new Set();
      extracted.forEach((fact) => keys.add(fact.fieldKey));
      tableFactKeysByPage.set(pageNo, keys);
    }
    for (const fact of extracted) {
      const key = JSON.stringify([
        fact.canonicalProductId,
        fact.productVersionId,
        fact.fieldKey,
        fact.normalizedValue,
        fact.scope,
        fact.evidenceChunkIds,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
  }
  return facts;
}
