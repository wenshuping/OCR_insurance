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

  const incompletePages = pages.filter((page) => page?.layout?.extraction?.incomplete === true);
  checks.push(incompletePages.length
    ? check('page_extraction_incomplete', 'blocked', '部分页面的列表或比较内容未完整识别，需要视觉识别或人工复核', {
        pageNumbers: incompletePages.map((page) => Number(page.pageNo)).filter(Boolean),
        affectedCount: incompletePages.length,
      })
    : check('page_extraction_complete', 'passed', '未发现明显缺失的页面结构内容'));

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
    qualityRuleVersion: 'product-document-quality-v2',
  };
}

export function assessProductPublishReadiness(input = {}) {
  const document = input.document || {};
  const links = Array.isArray(input.links) ? input.links : [];
  const readyChunks = (Array.isArray(input.chunks) ? input.chunks : [])
    .filter((chunk) => text(chunk?.chunkType) !== 'parent' && text(chunk?.indexStatus) === 'ready');
  const boundLinks = links.filter((link) => text(link?.canonicalProductId));
  const checks = [];

  checks.push(boundLinks.length
    ? check('product_binding', 'passed', '资料已关联产品')
    : check('product_binding_missing', 'blocked', '资料尚未关联到确定产品，不能发布'));

  const unboundChunks = readyChunks.filter((chunk) => !text(chunk?.canonicalProductId));
  if (unboundChunks.length) {
    checks.push(check('chunk_product_binding_missing', 'blocked', '部分可检索切片尚未绑定产品', {
      affectedCount: unboundChunks.length,
    }));
  }

  const ambiguousChunks = readyChunks.filter((chunk) => {
    const pageStart = Number(chunk?.pageStart || 0);
    const pageEnd = Number(chunk?.pageEnd || pageStart);
    const applicable = boundLinks.filter((link) => (
      pageEnd >= Number(link?.pageStart || 0)
      && pageStart <= Number(link?.pageEnd || link?.pageStart || 0)
    ));
    return applicable.length !== 1
      || text(applicable[0]?.canonicalProductId) !== text(chunk?.canonicalProductId);
  });
  if (ambiguousChunks.length) {
    checks.push(check('product_boundary_ambiguous', 'blocked', '部分切片无法唯一对应一个产品范围', {
      affectedCount: ambiguousChunks.length,
    }));
  }

  const explicitVersionId = text(document?.payload?.productVersionId);
  const missingVersionChunks = explicitVersionId
    ? readyChunks.filter((chunk) => text(chunk?.productVersionId) !== explicitVersionId)
    : [];
  if (missingVersionChunks.length) {
    checks.push(check('product_version_binding_missing', 'blocked', '部分切片未绑定已选择的产品版本', {
      affectedCount: missingVersionChunks.length,
    }));
  }

  const blockingReasons = checks.filter((item) => item.status === 'blocked');
  return {
    decision: blockingReasons.length ? 'blocked' : 'pass',
    checks,
    blockingReasons,
    qualityRuleVersion: 'product-publish-readiness-v1',
  };
}
