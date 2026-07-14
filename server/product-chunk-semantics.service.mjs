function text(value) {
  return String(value ?? '').trim();
}

const FACT_RULES = [
  ['waiting_period', /等待期/u],
  ['annual_deductible', /(?:年度)?免赔额/u],
  ['reimbursement_ratio', /(?:赔付|给付|报销)比例|按\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*(?:赔付|给付|报销)/u],
  ['benefit_limit', /(?:年度|累计|给付|责任)?限额|最高(?:给付|报销)?/u],
  ['entry_age', /投保年龄|最高投保年龄|最低投保年龄/u],
  ['renewal_period', /保证续保|续保期间|最高续保年龄/u],
];

const CONTRACT_DOCUMENT_TYPES = new Set(['terms', 'benefit_terms', 'basic_terms', 'plan_table', 'rate_table']);
const NON_CONTRACT_DOCUMENT_TYPES = new Set(['training_deck', 'sales_manual', 'marketing_material']);
const REQUIRED_CONTEXT_PATTERN = /^(?:注|说明|其中)|但(?:是|若)?|除外|不适用|另有约定|以.+为准|前述/u;

function factKeys(content) {
  return FACT_RULES.filter(([, pattern]) => pattern.test(content)).map(([key]) => key);
}

function planNames(content) {
  return [...new Set((content.match(/计划(?:[一二三四五六七八九十]|[A-Z]|\d+)/gu) || []).map(text))];
}

function responsibilityName(chunk) {
  const heading = (Array.isArray(chunk?.headingPath) ? chunk.headingPath : [])
    .map(text).filter(Boolean).at(-1) || '';
  if (/保险金|保险责任|医疗费用|豁免/u.test(heading)) return heading;
  return text(chunk?.content).match(/(?:^|\n)((?:[^\n，。；]{2,30})(?:保险金|医疗费用保险金|豁免保险费))/u)?.[1]?.trim() || '';
}

function semanticForChunk(document, chunk) {
  const content = [
    ...(Array.isArray(chunk?.headingPath) ? chunk.headingPath : []),
    chunk?.content,
  ].map(text).filter(Boolean).join('\n');
  const topics = Array.isArray(chunk?.payload?.businessTopics)
    ? chunk.payload.businessTopics.map(text).filter(Boolean)
    : [];
  const keys = factKeys(content);
  const documentType = text(document?.documentType);
  const sourceAuthority = text(document?.sourceAuthority || chunk?.sourceAuthority);
  const contractual = CONTRACT_DOCUMENT_TYPES.has(documentType);
  const nonContractual = NON_CONTRACT_DOCUMENT_TYPES.has(documentType)
    || ['company_material', 'expert_training', 'approved_company_material'].includes(sourceAuthority);
  let evidenceKind = 'other';
  if (/释义|定义/u.test(content)) {
    evidenceKind = 'definition';
  } else if (/理赔|保险金申请|申请材料|服务流程|报案/u.test(content)) {
    evidenceKind = 'process';
  } else if (/计算公式|给付金额\s*=|赔付金额\s*=|×|\*/u.test(content)) {
    evidenceKind = 'formula';
  } else if (nonContractual && topics.some((topic) => ['product_advantage', 'target_audience', 'health_services'].includes(topic))) {
    evidenceKind = 'claim';
  } else if (keys.length) {
    evidenceKind = 'fact';
  } else if (contractual || topics.some((topic) => ['coverage', 'exclusions', 'underwriting'].includes(topic))) {
    evidenceKind = 'clause';
  }
  return {
    evidenceKind,
    topics,
    factKeys: keys,
    responsibility: responsibilityName(chunk),
    planNames: planNames(content),
    contractual,
    nonContractual,
    requiredContextChunkIds: [],
    classifierVersion: 'product-chunk-semantic-v1',
  };
}

export function annotateProductChunks(input = {}) {
  const document = input.document || {};
  const annotated = (Array.isArray(input.chunks) ? input.chunks : []).map((chunk) => {
    if (text(chunk?.chunkType) === 'parent') return chunk;
    return {
      ...chunk,
      payload: {
        ...(chunk?.payload && typeof chunk.payload === 'object' ? chunk.payload : {}),
        semantic: semanticForChunk(document, chunk),
      },
    };
  });
  const groups = new Map();
  for (const chunk of annotated) {
    if (text(chunk?.chunkType) === 'parent') continue;
    const key = text(chunk?.parentChunkId) || `${text(chunk?.documentId)}:${Number(chunk?.pageStart || 0)}`;
    const rows = groups.get(key) || [];
    rows.push(chunk);
    groups.set(key, rows);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => Number(left?.payload?.sequence ?? left?.payload?.partIndex ?? 0)
      - Number(right?.payload?.sequence ?? right?.payload?.partIndex ?? 0));
    rows.forEach((chunk, index) => {
      const next = rows[index + 1];
      if (!next || !REQUIRED_CONTEXT_PATTERN.test(text(next.content))) return;
      chunk.payload.semantic.requiredContextChunkIds = [text(next.id)].filter(Boolean);
    });
  }
  return annotated;
}
