// src/cashflow-engine.mjs

/**
 * 按被保人汇总年度现金流。
 * @param {Array<object>} plans - PolicyCashflowPlan[]
 * @returns {Array<object>} MemberAnnualSummary[]
 */
export function buildMemberAnnualSummaries(plans) {
  const activePlans = plans.filter((p) => !p.expired);
  const memberMap = new Map();

  for (const plan of activePlans) {
    const member = plan.insured || '未识别被保人';
    if (!memberMap.has(member)) {
      memberMap.set(member, { member, birthday: plan.insuredBirthday, yearMap: new Map() });
    }
    const data = memberMap.get(member);
    if (!data.birthday && plan.insuredBirthday) data.birthday = plan.insuredBirthday;

    for (const entry of plan.annualEntries) {
      const existing = data.yearMap.get(entry.year) || { year: entry.year, age: entry.age, totalAmount: 0, details: [] };
      existing.totalAmount += entry.amount;
      existing.details.push(entry);
      data.yearMap.set(entry.year, existing);
    }
  }

  return Array.from(memberMap.values()).map((data) => {
    const entries = Array.from(data.yearMap.values())
      .sort((a, b) => a.year - b.year);
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.totalAmount;
      entry.cumulative = cumulative;
    }
    return {
      member: data.member,
      birthday: data.birthday || '',
      entries,
      totalCashflow: cumulative,
    };
  });
}

/**
 * 将年度条目扩展为完整年份范围，无现金流的年份用空条目填充。
 * @param {Array<object>} annualEntries - CashflowEntry[]
 * @param {number} effectiveYear - 保单生效年
 * @param {number} birthYear - 被保人出生年
 * @param {number} endYear - 结束年份（保障终止年或当前年+50等）
 * @param {object} policyInfo - { policyId, productName }
 * @returns {Array<object>} 完整年份的 CashflowEntry[]
 */
export function fillCashflowYears(annualEntries, effectiveYear, birthYear, endYear, policyInfo) {
  const entryMap = new Map();
  for (const entry of annualEntries) {
    entryMap.set(entry.year, entry);
  }
  const filled = [];
  let cumulative = 0;
  for (let year = effectiveYear; year <= endYear; year++) {
    const existing = entryMap.get(year);
    if (existing) {
      cumulative += existing.amount;
      filled.push({ ...existing, cumulative });
    } else {
      filled.push({
        year,
        age: year - birthYear,
        amount: 0,
        cumulative,
        liability: '',
        policyId: policyInfo?.policyId || 0,
        productName: policyInfo?.productName || '',
        calculationText: '',
        cashValue: null,
      });
    }
  }
  return filled;
}
