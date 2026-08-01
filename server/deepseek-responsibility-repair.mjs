import { createHash } from 'node:crypto';

export const DEEPSEEK_REPAIR_VERSION = '2026-07-26-deepseek-repair-v3';

export const CANONICAL_REQUIRED_INPUTS = new Set([
  'policy.amount',
  'policy.firstPremium',
  'policy.paymentPeriodYears',
  'cashValue',
  'policyYear',
  'policyScheduleTable',
  'policyYearOrAge',
  'accountValue',
  'actualMedicalExpense',
  'deductible',
  'reimbursementRate',
  'thirdPartyPaid',
  'liabilityLimit',
  'actualDays',
  'dailyAmount',
  'dayLimit',
  'manualFormulaInputs',
]);

const INPUT_ALIASES = new Map([
  ['insured_amount', 'policy.amount'],
  ['basic_insured_amount', 'policy.amount'],
  ['basic_insurance_amount', 'policy.amount'],
  ['basic_sum_insured', 'policy.amount'],
  ['basic_sum_assured', 'policy.amount'],
  ['sum_insured', 'policy.amount'],
  ['insurance_amount', 'policy.amount'],
  ['基本保险金额', 'policy.amount'],
  ['保险金额', 'policy.amount'],
  ['first_premium', 'policy.firstPremium'],
  ['annual_premium', 'policy.firstPremium'],
  ['首期保险费', 'policy.firstPremium'],
  ['首年保险费', 'policy.firstPremium'],
  ['premium_payment_years', 'policy.paymentPeriodYears'],
  ['payment_period_years', 'policy.paymentPeriodYears'],
  ['payment_term_years', 'policy.paymentPeriodYears'],
  ['缴费年期', 'policy.paymentPeriodYears'],
  ['cash_value', 'cashValue'],
  ['现金价值', 'cashValue'],
  ['policy_year', 'policyYear'],
  ['保单年度', 'policyYear'],
  ['保单年度数', 'policyYear'],
  ['policy_schedule_table', 'policyScheduleTable'],
  ['benefit_schedule_table', 'policyScheduleTable'],
  ['policy_year_or_age', 'policyYearOrAge'],
  ['attained_age', 'policyYearOrAge'],
  ['到达年龄', 'policyYearOrAge'],
  ['account_value', 'accountValue'],
  ['policy_account_value', 'accountValue'],
  ['保单账户价值', 'accountValue'],
  ['actual_medical_expense', 'actualMedicalExpense'],
  ['actual_medical_expenses', 'actualMedicalExpense'],
  ['合理且必要的医疗费用', 'actualMedicalExpense'],
  ['deductible_amount', 'deductible'],
  ['免赔额', 'deductible'],
  ['reimbursement_ratio', 'reimbursementRate'],
  ['reimbursement_rate', 'reimbursementRate'],
  ['payment_ratio', 'reimbursementRate'],
  ['给付比例', 'reimbursementRate'],
  ['other_compensation', 'thirdPartyPaid'],
  ['compensation_from_other_sources', 'thirdPartyPaid'],
  ['third_party_paid', 'thirdPartyPaid'],
  ['annual_limit', 'liabilityLimit'],
  ['cumulative_limit', 'liabilityLimit'],
  ['liability_limit', 'liabilityLimit'],
  ['actual_hospital_days', 'actualDays'],
  ['actual_hospitalization_days', 'actualDays'],
  ['actual_days', 'actualDays'],
  ['daily_allowance_amount', 'dailyAmount'],
  ['daily_amount', 'dailyAmount'],
  ['day_limit', 'dayLimit'],
]);

const CONSTANT_INPUTS = new Set([
  '',
  'none',
  'zero',
  'fixed_amount',
  'not_applicable',
  'not_quantitative',
  'no_input',
]);

const RUNTIME_CALCULATION_KEYS = new Set([
  'fixed_amount',
  'basic_amount',
  'percent_of_basic_amount',
  'multiple_of_basic_amount',
  'first_premium',
  'percent_of_first_premium',
  'multiple_of_first_premium',
  'total_paid_premium',
  'percent_of_total_paid_premium',
  'multiple_of_total_paid_premium',
]);

const PARAMETER_CALCULATION_KEYS = new Set([
  'annual_limit',
  'cumulative_limit',
  'deductible',
  'limit',
  'payment_ratio',
  'percentage',
  'reimbursement_ratio',
]);

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])]),
  );
}

export function digestJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex')}`;
}

export function canonicalProductKey(company, productName) {
  return `${compact(company)}\u001f${compact(productName)}`;
}

export function artifactSourceDigest(artifact = {}) {
  return text(artifact.productIdentity?.sourceDigest || artifact.sourceDigest);
}

export function normalizeRequiredInput(value) {
  const original = text(value);
  if (CANONICAL_REQUIRED_INPUTS.has(original)) {
    return { canonical: original, original, status: 'canonical' };
  }
  if (CONSTANT_INPUTS.has(original)) {
    return { canonical: '', original, status: 'constant' };
  }
  const canonical = INPUT_ALIASES.get(original);
  if (canonical) return { canonical, original, status: 'mapped' };
  return { canonical: '', original, status: 'unresolved' };
}

function unresolvedKey(item = {}) {
  return [text(item.value), text(item.location), text(item.reason)].join('\u001f');
}

function mergeUnresolved(...groups) {
  const seen = new Set();
  const merged = [];
  for (const item of groups.flat()) {
    if (!item || !text(item.value)) continue;
    const normalized = {
      value: text(item.value),
      location: text(item.location),
      reason: text(item.reason || 'no_lossless_canonical_mapping'),
    };
    const key = unresolvedKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function normalizeInputs(inputs, location) {
  const canonical = [];
  const unresolved = [];
  const mappings = [];
  for (const value of rows(inputs)) {
    const result = normalizeRequiredInput(value);
    if (result.canonical) canonical.push(result.canonical);
    if (result.status === 'unresolved') {
      unresolved.push({
        value: result.original,
        location,
        reason: 'no_lossless_canonical_mapping',
      });
    }
    if (result.status === 'mapped' || result.status === 'constant') {
      mappings.push({
        value: result.original,
        canonical: result.canonical,
        location,
        action: result.status,
      });
    }
  }
  return {
    canonical: unique(canonical),
    unresolved,
    mappings,
  };
}

function appendCalculationReason(node, reason) {
  const current = text(node.calculationReason);
  return unique([current, reason]).join('；');
}

function repairCalculationNode(node = {}, location) {
  const repaired = structuredClone(node || {});
  const direct = normalizeInputs(repaired.requiredInputs, `${location}.requiredInputs`);
  const branchResults = rows(repaired.branches).map((branch, index) => (
    repairCalculationNode(branch, `${location}.branches[${index}]`)
  ));
  const operandResults = rows(repaired.operands).map((operand, index) => (
    repairCalculationNode(operand, `${location}.operands[${index}]`)
  ));
  if (Array.isArray(repaired.branches)) {
    repaired.branches = branchResults.map((result) => result.node);
  }
  if (Array.isArray(repaired.operands)) {
    repaired.operands = operandResults.map((result) => result.node);
  }

  const inheritedUnresolved = rows(repaired.unresolvedRequiredInputs);
  const unresolved = mergeUnresolved(
    inheritedUnresolved,
    direct.unresolved,
    branchResults.flatMap((result) => result.unresolved),
    operandResults.flatMap((result) => result.unresolved),
  );
  const requiredInputs = unique([
    ...direct.canonical,
    ...branchResults.flatMap((result) => result.requiredInputs),
    ...operandResults.flatMap((result) => result.requiredInputs),
  ]);
  repaired.requiredInputs = requiredInputs;
  if (unresolved.length) {
    repaired.unresolvedRequiredInputs = unresolved;
    repaired.calculationEligible = false;
    repaired.calculationReason = appendCalculationReason(
      repaired,
      `存在未解析计算输入：${unique(unresolved.map((item) => item.value)).join('、')}`,
    );
  } else {
    delete repaired.unresolvedRequiredInputs;
  }

  const calculationKey = text(repaired.calculationKey);
  if (repaired.calculationEligible === true && !RUNTIME_CALCULATION_KEYS.has(calculationKey)) {
    repaired.calculationEligible = false;
    repaired.calculationReason = appendCalculationReason(
      repaired,
      `计算键 ${calculationKey || '空'} 不受当前运行时支持`,
    );
  }
  if (repaired.calculationEligible === true && PARAMETER_CALCULATION_KEYS.has(calculationKey)) {
    repaired.calculationEligible = false;
    repaired.calculationReason = appendCalculationReason(
      repaired,
      '该指标是责任参数，不是可直接计算的责任给付金额',
    );
  }
  if (node?.calculationEligible === true) {
    repaired.calculationEligible = false;
    repaired.calculationStatus = 'manual_review';
    repaired.calculationReason = appendCalculationReason(
      repaired,
      '旧 DeepSeek 可计算状态已暂停，等待同源修复复核',
    );
  }

  return {
    node: repaired,
    requiredInputs,
    unresolved,
    mappings: [
      ...direct.mappings,
      ...branchResults.flatMap((result) => result.mappings),
      ...operandResults.flatMap((result) => result.mappings),
    ],
  };
}

function ruleEvidenceText(rule = {}) {
  return [
    rule.sourceExcerpt,
    ...rows(rule.evidenceSegments).map((segment) => segment?.sourceExcerpt),
    ...rows(rule.calculation?.evidenceTokens),
  ].map(text).filter(Boolean).join('\n');
}

function responsibilityEvidenceText(responsibility = {}) {
  return [
    responsibility.sourceExcerpt,
    ...rows(responsibility.evidenceSegments).map((segment) => segment?.sourceExcerpt),
    ...rows(responsibility.indicators).flatMap((indicator) => [
      indicator.sourceExcerpt,
      ...rows(indicator.evidenceTokens),
    ]),
  ].map(text).filter(Boolean).join('\n');
}

const CHINESE_DIGITS = new Map([
  ['零', 0],
  ['〇', 0],
  ['一', 1],
  ['二', 2],
  ['两', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
]);

function chineseNumber(value) {
  const normalized = text(value);
  if (!normalized) return null;
  if ([...normalized].every((character) => CHINESE_DIGITS.has(character))) {
    return Number([...normalized].map((character) => CHINESE_DIGITS.get(character)).join(''));
  }
  let total = 0;
  let current = 0;
  for (const character of normalized) {
    if (CHINESE_DIGITS.has(character)) {
      current = CHINESE_DIGITS.get(character);
    } else if (character === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else {
      return null;
    }
  }
  return total + current;
}

function canonicalNumericToken(number, unit = '') {
  const numeric = Number(number);
  if (!Number.isFinite(numeric)) return '';
  const normalizedUnit = text(unit).replace(/％/gu, '%');
  if (normalizedUnit === '万元') return `amount:${numeric * 10000}`;
  if (normalizedUnit === '元') return `amount:${numeric}`;
  if (normalizedUnit === '%' || normalizedUnit === '倍') return `${normalizedUnit}:${numeric}`;
  if (normalizedUnit === '周岁' || normalizedUnit === '岁') return `age:${numeric}`;
  if (normalizedUnit === '年') return `year:${numeric}`;
  if (normalizedUnit === '日' || normalizedUnit === '天') return `day:${numeric}`;
  if (normalizedUnit === '次') return `count:${numeric}`;
  if (numeric >= 10000) return `amount:${numeric}`;
  return `number:${numeric}`;
}

function numericTokens(value) {
  const source = text(value);
  const tokens = [
    ...source.matchAll(/(\d+(?:\.\d+)?)\s*(%|％|倍|万元|元|周岁|岁|年|日|天|次)?/gu),
  ].map((match) => canonicalNumericToken(match[1], match[2]));
  for (const match of source.matchAll(/([零〇一二两三四五六七八九十百]+)\s*(周岁|岁|年|日|天|次)/gu)) {
    const number = chineseNumber(match[1]);
    if (number !== null) tokens.push(canonicalNumericToken(number, match[2]));
  }
  return unique(tokens);
}

function unsupportedNumericTokens(formulaText, evidenceText) {
  const evidence = new Set(numericTokens(evidenceText));
  return numericTokens(formulaText).filter((token) => !evidence.has(token));
}

function titleFor(responsibility = {}) {
  return text(responsibility.card?.title || responsibility.liability || responsibility.officialTitle);
}

function repairProductRules(productRules = [], receipt) {
  return rows(productRules).map((rule, index) => {
    const repaired = structuredClone(rule || {});
    if (!repaired.calculation) return repaired;
    const result = repairCalculationNode(
      repaired.calculation,
      `productRules[${index}].calculation`,
    );
    repaired.calculation = result.node;
    receipt.inputMappings.push(...result.mappings);
    return repaired;
  });
}

function ruleMapFor(productRules = []) {
  return new Map(rows(productRules).map((rule) => [text(rule?.ruleId), rule]));
}

function repairResponsibilities(responsibilities = [], productRules, receipt) {
  const ruleMap = ruleMapFor(productRules);
  return rows(responsibilities).map((responsibility, responsibilityIndex) => {
    const repaired = structuredClone(responsibility || {});
    const responsibilityId = text(repaired.responsibilityId);
    repaired.indicators = rows(repaired.indicators).map((indicator, indicatorIndex) => {
      const location = `responsibilities[${responsibilityIndex}].indicators[${indicatorIndex}]`;
      const result = repairCalculationNode(indicator, location);
      const next = result.node;
      const referencedRules = [];
      for (const ref of rows(next.ruleRefs).map(text).filter(Boolean)) {
        const rule = ruleMap.get(ref);
        if (!rule) {
          receipt.invalidRuleRefs.push({ responsibilityId, ruleRef: ref, reason: 'missing_rule' });
          continue;
        }
        const affected = rows(rule.affectedResponsibilityIds).map(text);
        if (!affected.includes(responsibilityId)) {
          receipt.invalidRuleRefs.push({
            responsibilityId,
            ruleRef: ref,
            reason: 'rule_scope_does_not_include_responsibility',
          });
          continue;
        }
        referencedRules.push(rule);
      }

      const referencedInputs = referencedRules.flatMap((rule) => (
        rows(rule.calculation?.requiredInputs).map(text)
      ));
      const referencedUnresolved = referencedRules.flatMap((rule) => (
        rows(rule.calculation?.unresolvedRequiredInputs)
      ));
      next.requiredInputs = unique([...rows(next.requiredInputs), ...referencedInputs]);
      const unresolved = mergeUnresolved(
        rows(next.unresolvedRequiredInputs),
        referencedUnresolved,
      );
      if (unresolved.length) {
        next.unresolvedRequiredInputs = unresolved;
        next.calculationEligible = false;
      }
      if (receipt.invalidRuleRefs.some((issue) => issue.responsibilityId === responsibilityId)) {
        next.calculationEligible = false;
        next.calculationReason = appendCalculationReason(
          next,
          '存在缺失或越界的共享规则引用',
        );
      }

      const evidence = [
        responsibilityEvidenceText(repaired),
        ...referencedRules.map(ruleEvidenceText),
      ].join('\n');
      const missingNumbers = unsupportedNumericTokens(next.formulaText, evidence);
      if (missingNumbers.length) {
        receipt.unsupportedNumericClaims.push({
          responsibilityId,
          indicatorName: text(next.indicatorName),
          tokens: missingNumbers,
        });
        next.calculationEligible = false;
      }
      receipt.inputMappings.push(...result.mappings);
      return next;
    });
    return repaired;
  });
}

export function repairDeepSeekArtifact({
  legacyArtifact,
  authoritativeArtifact,
  legacyArtifactId,
  authority,
  now = new Date().toISOString(),
} = {}) {
  const source = authoritativeArtifact || legacyArtifact;
  if (!source || typeof source !== 'object') throw new TypeError('A source artifact is required');
  const beforeDigest = digestJson(source);
  const repaired = structuredClone(source);
  const receipt = {
    legacyArtifactId: text(legacyArtifactId),
    company: text(repaired.company),
    productName: text(repaired.productName),
    sourceDigest: artifactSourceDigest(repaired),
    authority: text(authority),
    beforeDigest,
    inputMappings: [],
    invalidRuleRefs: [],
    unsupportedNumericClaims: [],
  };

  repaired.productRules = repairProductRules(repaired.productRules, receipt);
  repaired.responsibilities = repairResponsibilities(
    repaired.responsibilities,
    repaired.productRules,
    receipt,
  );

  const repairAudit = {
    version: DEEPSEEK_REPAIR_VERSION,
    authority: receipt.authority,
    legacyArtifactId: receipt.legacyArtifactId,
    sourceDigest: receipt.sourceDigest,
    generatedAt: now,
    beforeDigest,
    mappedInputCount: receipt.inputMappings.filter((item) => item.action === 'mapped').length,
    removedConstantInputCount: receipt.inputMappings.filter((item) => item.action === 'constant').length,
    invalidRuleRefs: receipt.invalidRuleRefs,
    unsupportedNumericClaims: receipt.unsupportedNumericClaims,
  };
  repaired.repairAudit = repairAudit;
  repaired.publication = {
    ...repaired.publication,
    repairVersion: DEEPSEEK_REPAIR_VERSION,
    repairAuthority: receipt.authority,
    legacyArtifactId: receipt.legacyArtifactId,
  };

  const afterDigest = digestJson(repaired);
  const artifactId = `responsibility_repair_artifact_${afterDigest.slice(-24)}`;
  repaired.artifactId = artifactId;
  receipt.artifactId = artifactId;
  receipt.afterDigest = digestJson(repaired);
  receipt.metrics = auditRepairedArtifact(repaired);
  receipt.route = routeRepairReceipt(receipt);
  return { artifact: repaired, receipt };
}

export function auditRepairedArtifact(artifact = {}) {
  const metrics = {
    responsibilityCount: rows(artifact.responsibilities).length,
    indicatorCount: 0,
    unresolvedInputCount: 0,
    noncanonicalInputCount: 0,
    calculationEnabledCount: 0,
    invalidRuleRefCount: rows(artifact.repairAudit?.invalidRuleRefs).length,
    unsupportedNumericClaimCount: rows(artifact.repairAudit?.unsupportedNumericClaims).length,
    duplicateTitleCount: 0,
    missingEvidenceCount: 0,
    tableSignalCount: 0,
    branchCount: 0,
  };
  const titles = new Map();
  for (const responsibility of rows(artifact.responsibilities)) {
    const title = titleFor(responsibility);
    if (title) titles.set(compact(title), (titles.get(compact(title)) || 0) + 1);
    if (!responsibilityEvidenceText(responsibility)) metrics.missingEvidenceCount += 1;
    for (const indicator of rows(responsibility.indicators)) {
      metrics.indicatorCount += 1;
      metrics.unresolvedInputCount += rows(indicator.unresolvedRequiredInputs).length;
      metrics.branchCount += rows(indicator.branches).length;
      if (indicator.calculationEligible === true) metrics.calculationEnabledCount += 1;
      for (const input of rows(indicator.requiredInputs)) {
        if (!CANONICAL_REQUIRED_INPUTS.has(text(input))) metrics.noncanonicalInputCount += 1;
      }
      for (const branch of rows(indicator.branches)) {
        metrics.unresolvedInputCount += rows(branch.unresolvedRequiredInputs).length;
        for (const input of rows(branch.requiredInputs)) {
          if (!CANONICAL_REQUIRED_INPUTS.has(text(input))) metrics.noncanonicalInputCount += 1;
        }
      }
      if (/表|计划|档|等级|附录|附表/u.test([
        indicator.formulaText,
        indicator.calculationReason,
      ].map(text).join(' '))) metrics.tableSignalCount += 1;
    }
  }
  metrics.duplicateTitleCount = [...titles.values()].filter((count) => count > 1).length;
  return metrics;
}

export function routeRepairReceipt(receipt = {}) {
  const metrics = receipt.metrics || {};
  if (!text(receipt.sourceDigest) || Number(metrics.missingEvidenceCount) > 0) {
    return 'source_repair_required';
  }
  if (
    Number(metrics.noncanonicalInputCount) > 0
    || Number(metrics.invalidRuleRefCount) > 0
    || Number(metrics.unsupportedNumericClaimCount) > 0
    || Number(metrics.duplicateTitleCount) > 0
  ) {
    return 'gemini_required';
  }
  return 'deterministic_pass';
}

export function isLegacyCalculationEnabled(artifact = {}) {
  return rows(artifact.responsibilities).some((responsibility) => (
    rows(responsibility.indicators).some((indicator) => indicator.calculationEligible === true)
  ));
}

export function quarantineIndicatorPayload(payload = {}) {
  const next = structuredClone(payload || {});
  if (next.calculationEligible !== true) return { changed: false, payload: next };
  next.calculationEligible = false;
  next.calculationStatus = 'manual_review';
  next.calculationReason = appendCalculationReason(
    next,
    '旧 DeepSeek 可计算状态已暂停，等待同源修复复核',
  );
  return { changed: true, payload: next };
}

export function quarantineCardPayload(payload = {}) {
  const next = structuredClone(payload || {});
  let changed = false;
  if (Array.isArray(next.indicators)) {
    next.indicators = next.indicators.map((indicator) => {
      const result = quarantineIndicatorPayload(indicator);
      if (result.changed) changed = true;
      return result.payload;
    });
  }
  if (changed) {
    next.calculationStatus = 'manual_review';
    next.calculationReason = appendCalculationReason(
      next,
      '旧 DeepSeek 可计算状态已暂停，等待同源修复复核',
    );
  }
  return { changed, payload: next };
}
