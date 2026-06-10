function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function normalizeAmount(value) {
  const raw = text(value).replace(/[,，\s]/gu, '').replace(/[¥￥]/gu, '');
  if (!raw) return '';
  const wan = raw.match(/(\d+(?:\.\d+)?)万/u);
  if (wan) return String(Math.round(Number(wan[1]) * 10000));
  const number = raw.match(/(\d+(?:\.\d+)?)/u);
  return number ? String(Number(number[1])) : '';
}

function firstString(...values) {
  return values.map(text).find(Boolean) || '';
}

function fieldObject(value, evidence = '', confidence = null) {
  const normalized = text(value);
  if (!normalized) return undefined;
  return {
    value: normalized,
    evidence: text(evidence),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
  };
}

function isUnsupportedInferredField(field) {
  if (!text(field?.value)) return false;
  return /默认|推断|按规则|无明确|未提供|未识别|为空|空白/u.test(text(field?.evidence));
}

function extractJsonObject(content) {
  const raw = text(content)
    .replace(/^```(?:json)?/iu, '')
    .replace(/```$/u, '')
    .trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function compactTables(tables = []) {
  return tables.map((table, index) => ({
    index: index + 1,
    title: text(table.title),
    source: text(table.source),
    headers: Array.isArray(table.headers) ? table.headers.map(text) : [],
    rows: Array.isArray(table.rows)
      ? table.rows.map((row) => Array.isArray(row) ? row.map(text) : [text(row)])
      : [],
  }));
}

function sourceSnippet(value, maxLength = 9000) {
  const normalized = text(value).replace(/\n{3,}/gu, '\n\n');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n...[truncated ${normalized.length - maxLength} chars]`;
}

export function buildStructureV3LlmMessages({ normalized = {}, candidates = {}, markdown = '' } = {}) {
  const payload = {
    ruleCandidates: candidates,
    tables: compactTables(normalized.tables || []),
    ocrText: sourceSnippet(normalized.ocrText || markdown, 12000),
    markdown: sourceSnippet(markdown, 6000),
  };

  return [
    {
      role: 'system',
      content: [
        '你是保险保单结构化字段理解器。',
        '只能根据输入的 PP-StructureV3 OCR 文本、表格和规则候选提取字段，不能编造。',
        '你要像人审保单一样判断主险、附加险、行保费和合计保费的对应关系。',
        '只输出严格 JSON，不要 markdown，不要解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '请输出这个 JSON 结构：',
        JSON.stringify({
          policyFields: {
            company: { value: '', evidence: '', confidence: 0 },
            productName: { value: '', evidence: '', confidence: 0 },
            applicant: { value: '', evidence: '', confidence: 0 },
            insured: { value: '', evidence: '', confidence: 0 },
            beneficiary: { value: '', evidence: '', confidence: 0 },
            firstPremium: { value: '', evidence: '', confidence: 0 },
          },
          plans: [
            {
              role: 'main',
              name: '',
              amount: '',
              paymentPeriod: '',
              coveragePeriod: '',
              premium: '',
              evidence: '',
              confidence: 0,
            },
          ],
          warnings: [],
        }, null, 2),
        '',
        '抽取规则：',
        '1. 第一条真实保险产品是主险 role=main；后续真实保险产品是附加险 role=rider。',
        '2. 不要把特别约定、保单说明、保险合同专用章、业务员、服务电话、说明文字当成产品。',
        '3. 每个计划行的保额、缴费期间、保障期间、保费必须和同一险种同行或同段对应；不确定就留空。',
        '4. firstPremium 优先取“首期保险费合计/保险费合计/合计保费”附近带 ￥/¥/元 或中文大写金额对应的金额；不要把日期年份、保单年度、页码当成保费。',
        '5. 金额字段只保留数字，不要人民币符号、逗号和“元”。',
        '6. 受益人只输出原文明确写出的姓名或明确写出的“法定/被保险人本人/法定继承人”；如果只有受益人表头没有实际内容，必须留空，不能默认法定继承人。',
        '7. 如果规则候选和原文冲突，以原文和表格证据为准，但 warnings 写明冲突。',
        '8. 如果每个计划行 premium 都明确，但合计保费 OCR 顺序混乱或无法确定，firstPremium 用计划行 premium 求和，并在 evidence 写“行保费求和”。',
        '9. 识别表格或表格被压成文本时，要按表头字段顺序、同行关系和空间位置，把表头后的内容逐列对应到字段；不要脱离表头顺序猜测金额含义。',
        '10. 无法识别的字段 value 用空字符串。',
        '',
        '输入：',
        JSON.stringify(payload, null, 2),
      ].join('\n'),
    },
  ];
}

function normalizeFieldMap(fields = {}) {
  const normalized = {
    company: fieldObject(fields.company?.value ?? fields.company, fields.company?.evidence, fields.company?.confidence),
    productName: fieldObject(fields.productName?.value ?? fields.productName, fields.productName?.evidence, fields.productName?.confidence),
    applicant: fieldObject(fields.applicant?.value ?? fields.applicant, fields.applicant?.evidence, fields.applicant?.confidence),
    insured: fieldObject(fields.insured?.value ?? fields.insured, fields.insured?.evidence, fields.insured?.confidence),
    beneficiary: fieldObject(fields.beneficiary?.value ?? fields.beneficiary, fields.beneficiary?.evidence, fields.beneficiary?.confidence),
    firstPremium: fieldObject(
      normalizeAmount(fields.firstPremium?.value ?? fields.firstPremium),
      fields.firstPremium?.evidence,
      fields.firstPremium?.confidence,
    ),
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (isUnsupportedInferredField(value)) delete normalized[key];
  }
  return normalized;
}

function normalizeRole(value, index) {
  const raw = compact(value).toLowerCase();
  if (raw === 'main' || /主险/u.test(raw)) return 'main';
  if (raw === 'linked_account' || /万能|账户/u.test(raw)) return 'linked_account';
  if (raw === 'rider' || /附加险/u.test(raw)) return 'rider';
  return index === 0 ? 'main' : 'rider';
}

function normalizePlan(plan = {}, index = 0) {
  const name = firstString(plan.name, plan.productName, plan.planName);
  if (!name) return null;
  return {
    role: normalizeRole(plan.role, index),
    name,
    amount: normalizeAmount(firstString(plan.amount, plan.sumInsured, plan.coverageAmount)),
    paymentPeriod: firstString(plan.paymentPeriod, plan.payPeriod, plan.paymentTerm),
    coveragePeriod: firstString(plan.coveragePeriod, plan.insurancePeriod, plan.period),
    premium: normalizeAmount(firstString(plan.premium, plan.firstPremium, plan.fee)),
    evidence: text(plan.evidence),
    confidence: Number.isFinite(Number(plan.confidence)) ? Number(plan.confidence) : null,
  };
}

export function normalizeStructureV3LlmPayload(payload = {}) {
  const fields = normalizeFieldMap(payload.policyFields || payload.fields || {});
  const plans = (Array.isArray(payload.plans) ? payload.plans : [])
    .map(normalizePlan)
    .filter(Boolean)
    .map((plan, index) => ({ ...plan, role: normalizeRole(plan.role, index) }));
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(text).filter(Boolean) : [];

  if (!fields.productName && plans[0]?.name) {
    fields.productName = fieldObject(plans[0].name, plans[0].evidence, plans[0].confidence);
  }
  return {
    policyFields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value?.value)),
    plans,
    validation: validateStructureV3LlmExtraction({ policyFields: fields, plans }),
    warnings,
  };
}

export function validateStructureV3LlmExtraction({ policyFields = {}, plans = [] } = {}) {
  const firstPremium = Number(normalizeAmount(policyFields.firstPremium?.value));
  const premiumSum = plans.reduce((sum, plan) => sum + (Number(normalizeAmount(plan.premium)) || 0), 0);
  const premiumMatches = Number.isFinite(firstPremium)
    && firstPremium > 0
    && premiumSum > 0
    && Math.abs(firstPremium - premiumSum) < 0.01;
  const missingFields = ['company', 'productName', 'applicant', 'insured', 'beneficiary', 'firstPremium']
    .filter((field) => !text(policyFields[field]?.value));
  if (!plans.length) missingFields.push('plans');
  const incompletePlans = plans
    .filter((plan) => !plan.name || !plan.amount || !plan.paymentPeriod || !plan.coveragePeriod || !plan.premium)
    .map((plan) => plan.name || '未命名计划');
  return {
    premiumSum: premiumSum ? String(premiumSum) : '',
    firstPremium: firstPremium ? String(firstPremium) : '',
    premiumMatches,
    missingFields,
    incompletePlans,
    ready: missingFields.length === 0 && incompletePlans.length === 0 && premiumMatches,
  };
}

function ollamaBaseUrl(options = {}) {
  return text(options.baseUrl)
    || text(process.env.POLICY_OCR_STRUCTUREV3_LLM_BASE_URL)
    || text(process.env.POLICY_OCR_OLLAMA_BASE_URL)
    || 'http://127.0.0.1:11434';
}

function ollamaModel(options = {}) {
  return text(options.model)
    || text(process.env.POLICY_OCR_STRUCTUREV3_LLM_MODEL)
    || text(process.env.POLICY_OCR_OLLAMA_MODEL)
    || 'qwen3:8b';
}

function timeoutMs(options = {}) {
  const raw = Number.parseInt(
    text(options.timeoutMs) || text(process.env.POLICY_OCR_STRUCTUREV3_LLM_TIMEOUT_MS) || '180000',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
}

export async function extractStructureV3WithLocalModel({
  normalized = {},
  candidates = {},
  markdown = '',
  fetchImpl = fetch,
  model = '',
  baseUrl = '',
  timeout = 0,
} = {}) {
  const resolvedBaseUrl = ollamaBaseUrl({ baseUrl }).replace(/\/+$/u, '');
  const resolvedModel = ollamaModel({ model });
  const resolvedTimeout = timeoutMs({ timeoutMs: timeout });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeout);
  try {
    const response = await fetchImpl(`${resolvedBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: resolvedModel,
        stream: false,
        think: false,
        format: 'json',
        options: { temperature: 0, num_ctx: 8192 },
        messages: buildStructureV3LlmMessages({ normalized, candidates, markdown }),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
      };
    }

    const payload = await response.json().catch(() => null);
    const content = text(payload?.message?.content || payload?.response || '');
    const parsed = extractJsonObject(content);
    if (!parsed) {
      return {
        ok: false,
        error: 'MODEL_JSON_PARSE_FAILED',
        model: resolvedModel,
        baseUrl: resolvedBaseUrl,
        rawContent: content,
      };
    }

    return {
      ok: true,
      model: resolvedModel,
      baseUrl: resolvedBaseUrl,
      rawContent: content,
      result: normalizeStructureV3LlmPayload(parsed),
    };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted ? 'MODEL_TIMEOUT' : text(error?.message || error),
      model: resolvedModel,
      baseUrl: resolvedBaseUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

function fieldLine(label, field) {
  return `- ${label}: ${field?.value || '未识别'}${field?.confidence != null ? ` (${field.confidence})` : ''}`;
}

function planLine(plan) {
  const roleLabel = plan.role === 'main' ? '主险' : plan.role === 'linked_account' ? '账户' : '附加险';
  return `- ${roleLabel}: ${plan.name || '未识别'} | 保额 ${plan.amount || '缺失'} | 缴费期间 ${plan.paymentPeriod || '缺失'} | 保障期间 ${plan.coveragePeriod || '缺失'} | 保费 ${plan.premium || '缺失'}`;
}

export function buildStructureV3LlmReport(llmResult = {}) {
  if (llmResult.ok !== true) {
    return [
      '# PP-StructureV3 本地模型理解报告',
      '',
      `- 状态: 失败`,
      `- 模型: ${llmResult.model || '未配置'}`,
      `- 错误: ${llmResult.error || 'unknown'}`,
      '',
    ].join('\n');
  }

  const result = llmResult.result || {};
  const fields = result.policyFields || {};
  const validation = result.validation || {};
  return [
    '# PP-StructureV3 本地模型理解报告',
    '',
    `- 状态: 成功`,
    `- 模型: ${llmResult.model}`,
    `- 保费校验: ${validation.premiumMatches ? '通过' : '未通过'}${validation.premiumSum ? ` (${validation.premiumSum}/${validation.firstPremium || '未识别'})` : ''}`,
    `- 结论: ${validation.ready ? '建议作为理解层候选' : '需要人工核对或回退规则候选'}`,
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
    ...(result.plans?.length ? result.plans.map(planLine) : ['- 未识别到计划行']),
    '',
    '## 校验',
    '',
    `- 缺失字段: ${validation.missingFields?.length ? validation.missingFields.join(', ') : '无'}`,
    `- 不完整计划: ${validation.incompletePlans?.length ? validation.incompletePlans.join('、') : '无'}`,
    `- 模型警告: ${result.warnings?.length ? result.warnings.join('；') : '无'}`,
    '',
  ].join('\n');
}
