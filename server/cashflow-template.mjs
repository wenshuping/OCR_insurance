// server/cashflow-template.mjs
// Matches policies to their cashflow templates stored in knowledge_records payload JSON.
// Uses normalized company+productName keys for matching.

/**
 * Normalize text for fuzzy company/product matching:
 * - Strip whitespace
 * - Remove common corporate suffixes (股份有限公司, 有限责任公司, 有限公司)
 * - Lowercase
 */
function normalizeLookupText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/股份有限公司/g, '')
    .replace(/有限责任公司/g, '')
    .replace(/有限公司/g, '')
    .toLowerCase();
}

/**
 * Build the set of lookup keys for a policy.
 * Keys are "normalizedCompany\x1fnormalizedProductName" for both
 * policy.name and policy.productName.
 */
function policyProductKeys(policy) {
  const keys = new Set();
  const company = normalizeLookupText(policy?.company);
  const add = (name) => {
    const n = normalizeLookupText(name);
    if (company && n) keys.add(`${company}\x1f${n}`);
  };
  add(policy?.name);
  add(policy?.productName);
  return keys;
}

/**
 * Find the cashflow template for a given policy by matching against
 * knowledge_records rows. Returns the first matching cashflowTemplate
 * from the record payload, or null if no match is found.
 *
 * @param {object|null|undefined} policy - Policy with company, name, productName fields.
 * @param {Array|null|undefined} knowledgeRecords - Rows with company, productName, payload.
 * @returns {object|null} The cashflowTemplate object, or null.
 */
export function findProductCashflowTemplate(policy, knowledgeRecords) {
  const keys = policyProductKeys(policy);
  if (!keys.size) return null;

  for (const record of knowledgeRecords || []) {
    const recordKey = `${normalizeLookupText(record.company)}\x1f${normalizeLookupText(record.productName)}`;
    if (keys.has(recordKey)) {
      let payload = record.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { continue; }
      }
      if (payload?.cashflowTemplate) {
        return payload.cashflowTemplate;
      }
    }
  }
  return null;
}
