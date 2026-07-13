function text(value) {
  return String(value ?? '').trim();
}

function check(code, status, message, details = {}) {
  return { code, status, message, ...details };
}

function suspiciousCharacterRatio(value) {
  const content = text(value);
  if (!content) return 0;
  const suspicious = content.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu) || [];
  return suspicious.length / [...content].length;
}

function hasPersonalData(value) {
  const content = text(value);
  return /(?:身份证|证件号码)\s*[：:]?\s*\d{6}[0-9Xx*]{8,12}/u.test(content)
    || /(?:手机|联系电话)\s*[：:]?\s*1\d{10}/u.test(content);
}

export function assessProductDocumentQuality(input = {}) {
  const document = input.document || {};
  const parsed = input.parsed || {};
  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  const body = pages.map((page) => text(page?.rawText)).filter(Boolean).join('\n');
  const checks = [];

  checks.push(body
    ? check('effective_text', 'passed', '资料包含可解析正文')
    : check('effective_text', 'blocked', '资料没有可用于切片的正文'));

  const invalidPages = pages.filter((page) => !Number.isInteger(Number(page?.pageNo)) || Number(page.pageNo) <= 0);
  checks.push(invalidPages.length
    ? check('page_traceability', 'blocked', '部分页面缺少有效页码', { affectedCount: invalidPages.length })
    : check('page_traceability', 'passed', '页面均可追溯'));

  const suspiciousRatio = suspiciousCharacterRatio(body);
  checks.push(suspiciousRatio > 0.02
    ? check('text_integrity', 'blocked', '正文包含过多乱码或控制字符', { ratio: suspiciousRatio })
    : check('text_integrity', 'passed', '正文未发现严重乱码', { ratio: suspiciousRatio }));

  const parserWarnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(Boolean) : [];
  if (parserWarnings.length) {
    checks.push(check('parser_warnings', 'warning', '解析器返回了需要复核的警告', { warnings: parserWarnings }));
  }

  if (hasPersonalData(body)) {
    checks.push(check('personal_data', 'warning', '疑似包含客户个人信息，不应直接发布到产品知识库'));
  }

  if (text(parsed.documentType) === 'terms') {
    if (!/保险责任/u.test(body)) checks.push(check('terms_coverage_section', 'warning', '完整条款未识别到保险责任章节'));
    if (!/责任免除|免责/u.test(body)) checks.push(check('terms_exclusion_section', 'warning', '完整条款未识别到责任免除章节'));
  }

  if (!text(document.sourceAuthority)) {
    checks.push(check('source_authority', 'warning', '资料来源等级尚未标注'));
  }

  const blockingReasons = checks.filter((item) => item.status === 'blocked');
  const warnings = checks.filter((item) => item.status === 'warning');
  return {
    decision: blockingReasons.length ? 'reprocess_required' : warnings.length ? 'review_required' : 'pass',
    checks,
    blockingReasons,
    warnings,
    qualityRuleVersion: 'product-document-quality-v1',
  };
}
