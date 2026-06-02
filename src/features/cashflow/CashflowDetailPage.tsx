import {
  useState,
  type ReactNode,
} from 'react';
import {
  ChevronLeft,
} from 'lucide-react';
import type {
  CashValueRow,
  CashflowEntry,
  MemberAnnualSummary,
  MemberYearEntry,
  Policy,
  PolicyCashflowPlan,
  ScenarioEntry,
} from '../../api';
import {
  buildMemberAnnualSummaries,
  fillCashflowYears,
} from '../../cashflow-engine.mjs';
import {
  resolvePolicyValidityStatus,
} from '../../policy-validity.mjs';

function CashflowAnnualTable({ entries, effectiveYear, birthYear, endYear, policyId, productName, cashValues }: {
  entries: CashflowEntry[];
  effectiveYear: number;
  birthYear: number;
  endYear: number;
  policyId: number;
  productName: string;
  cashValues?: CashValueRow[];
}) {
  const allEntries = fillCashflowYears(entries, effectiveYear, birthYear, endYear, { policyId, productName });

  // Overlay OCR cash values onto entries
  const cashValueMap = new Map<number, number>();
  if (cashValues) {
    for (const cv of cashValues) {
      const calendarYear = effectiveYear + cv.policyYear;
      cashValueMap.set(calendarYear, cv.cashValue);
    }
  }
  const enrichedEntries = allEntries.map((entry) => {
    const ocrCashValue = cashValueMap.get(entry.year);
    if (ocrCashValue != null) {
      return { ...entry, cashValue: ocrCashValue };
    }
    return entry;
  });

  if (!enrichedEntries.length) return null;
  const columnSize = 14;
  const columns: CashflowEntry[][] = [];
  for (let i = 0; i < enrichedEntries.length; i += columnSize) {
    columns.push(enrichedEntries.slice(i, i + columnSize));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">个人现金流明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {columns.map((col, colIndex) => (
            <table key={colIndex} className="border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th className="rounded-tl-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">年份</th>
                  <th className="bg-[#0B72B9] px-2 py-1 text-white font-bold">领取金额</th>
                  <th className="bg-[#0B72B9] px-2 py-1 text-white font-bold">累计领取</th>
                  <th className="rounded-tr-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">现金价值</th>
                </tr>
              </thead>
              <tbody>
                {col.map((entry) => {
                  const hasAmount = entry.amount > 0;
                  const isLastAndMaturity = hasAmount && /满期/.test(entry.liability);
                  return (
                    <tr key={entry.year} className={isLastAndMaturity ? 'bg-orange-50 font-black' : ''}>
                      <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                        {entry.year}/{entry.age}
                      </td>
                      <td className="px-2 py-1 text-right ring-1 ring-slate-100">
                        {hasAmount ? (
                          <span className={`inline-block rounded px-1 text-[10px] font-bold ${/满期/.test(entry.liability) ? 'text-orange-600 bg-orange-50' : /养老/.test(entry.liability) ? 'text-emerald-600 bg-emerald-50' : 'text-blue-600 bg-blue-50'}`}>
                            {entry.amount.toLocaleString('zh-CN')}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                        {hasAmount ? entry.cumulative.toLocaleString('zh-CN') : '—'}
                      </td>
                      <td className="px-2 py-1 text-right text-slate-400 ring-1 ring-slate-100">
                        {entry.cashValue != null ? entry.cashValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScenarioDetailTable({ entries }: { entries: ScenarioEntry[] }) {
  if (!entries.length) return null;

  const depthColor = (amount: number) => {
    if (amount >= 2000000) return 'text-blue-800 font-black';
    if (amount >= 1000000) return 'text-blue-700 font-bold';
    if (amount >= 500000) return 'text-blue-600 font-semibold';
    return 'text-slate-700';
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">保障责任明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="rounded-tl-lg bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">场景</th>
            <th className="bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">计算公式</th>
            <th className="rounded-tr-lg bg-[#0B72B9] px-3 py-2 text-right font-bold text-white">金额</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i} className={entry.condition ? 'bg-slate-50' : ''}>
              <td className={`px-3 py-2 ring-1 ring-slate-100 ${entry.condition ? 'pl-6' : ''}`}>
                <span className="font-bold text-slate-800">{entry.scenario}</span>
                {entry.condition ? (
                  <span className="ml-1 text-[10px] text-slate-400">({entry.condition})</span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-slate-500 ring-1 ring-slate-100">{entry.formula}</td>
              <td className={`px-3 py-2 text-right ring-1 ring-slate-100 ${depthColor(entry.amount)}`}>
                {entry.amount.toLocaleString('zh-CN')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberAnnualSummaryTable({ summary }: { summary: MemberAnnualSummary }) {
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const columnSize = 12;
  const columns: MemberYearEntry[][] = [];
  for (let i = 0; i < summary.entries.length; i += columnSize) {
    columns.push(summary.entries.slice(i, i + columnSize));
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-3 min-w-max">
        {columns.map((col, colIndex) => (
          <table key={colIndex} className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="rounded-tl-lg bg-blue-600 px-2 py-1 text-white font-bold">年份/年龄</th>
                <th className="bg-blue-600 px-2 py-1 text-white font-bold">领取</th>
                <th className="rounded-tr-lg bg-blue-600 px-2 py-1 text-white font-bold">累计</th>
              </tr>
            </thead>
            <tbody>
              {col.map((entry) => (
                <tr
                  key={entry.year}
                  className="cursor-pointer hover:bg-blue-50"
                  onClick={() => setExpandedYear(expandedYear === entry.year ? null : entry.year)}
                >
                  <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                    {entry.year}/{entry.age}
                  </td>
                  <td className="px-2 py-1 text-right font-black text-slate-800 ring-1 ring-slate-100">
                    {entry.totalAmount.toLocaleString('zh-CN')}
                  </td>
                  <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                    {entry.cumulative.toLocaleString('zh-CN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      {expandedYear !== null ? (
        <div className="mt-1">
          {summary.entries.filter((e) => e.year === expandedYear).map((entry) => (
            <div key={entry.year} className="rounded-lg bg-blue-50 px-3 py-2 ring-1 ring-blue-100">
              {entry.details.map((d, i) => (
                <p key={i} className="text-[11px] text-blue-700">
                  {d.productName} - {d.liability}: {d.amount.toLocaleString('zh-CN')}元
                </p>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CashflowDetailPage({
  member, policies, onBack, cashValueDialog, onUploadCashValue,
}: {
  member: string;
  policies: Policy[];
  onBack: () => void;
  cashValueDialog?: ReactNode;
  onUploadCashValue?: (policyId: number) => void;
}) {
  const memberPolicies = policies.filter((p) => (p.insured || '').trim() === member);
  const plans: PolicyCashflowPlan[] = memberPolicies.map(p => ({
    policyId: p.id,
    productName: p.name || '',
    company: p.company || '',
    insured: p.insured || '',
    insuredBirthday: p.insuredBirthday || '',
    effectiveDate: p.date || '',
    annualEntries: p.cashflowEntries || [],
    scenarioEntries: p.scenarioEntries || [],
    totalDeterministicCashflow: p.totalCashflow ?? 0,
    expired: resolvePolicyValidityStatus(p.coveragePeriod, {
      effectiveDate: p.date,
      insuredBirthday: p.insuredBirthday,
    }).tone === 'expired',
  }));
  const summaries = buildMemberAnnualSummaries(plans);
  const summary = summaries[0];
  const notes: string[] = [];

  for (const plan of plans) {
    if (!plan.insuredBirthday) notes.push(`${plan.productName}缺少被保险人生日，年度现金流无法生成。`);
    if (!plan.effectiveDate) notes.push(`${plan.productName}缺少生效日，年度现金流无法生成。`);
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur-md">
        <button type="button" onClick={onBack} className="rounded-full p-1 hover:bg-slate-100">
          <ChevronLeft size={20} className="text-slate-600" />
        </button>
        <div>
          <h1 className="text-lg font-black text-slate-900">{member} · 现金流明细</h1>
          <p className="text-[11px] font-medium text-slate-400">{plans.length} 张保单</p>
        </div>
      </header>

      <main className="space-y-4 p-4">
        {notes.length ? (
          <div className="space-y-1 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            {notes.map((n) => <p key={n}>* {n}</p>)}
          </div>
        ) : null}

        {plans.map((plan) => (
          <section key={plan.policyId} className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.12)]">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-black text-slate-900">{plan.productName}</h3>
                <p className="mt-1 text-xs text-slate-400">{plan.company}</p>
              </div>
              {plan.expired ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">已过期</span>
              ) : null}
            </div>
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-500">
              {plan.effectiveDate ? <span>生效 {plan.effectiveDate}</span> : null}
              {plan.insuredBirthday ? <span>生日 {plan.insuredBirthday}</span> : null}
            </div>

            {plan.annualEntries.length ? (() => {
              const effectiveYear = plan.effectiveDate ? new Date(plan.effectiveDate).getFullYear() : 0;
              const birthYear = plan.insuredBirthday ? new Date(plan.insuredBirthday).getFullYear() : 0;
              const lastEntryYear = plan.annualEntries.length ? plan.annualEntries[plan.annualEntries.length - 1].year : 0;
              const endYear = Math.max(lastEntryYear, effectiveYear + 50, birthYear + 85);
              return (
                <div className="mb-3">
                  <CashflowAnnualTable
                    entries={plan.annualEntries}
                    effectiveYear={effectiveYear}
                    birthYear={birthYear}
                    endYear={endYear}
                    policyId={plan.policyId}
                    productName={plan.productName}
                    cashValues={memberPolicies.find(p => p.id === plan.policyId)?.cashValues}
                  />
                  <p className="mt-2 text-right text-sm font-black text-slate-800">
                    确定现金流合计: {plan.totalDeterministicCashflow.toLocaleString('zh-CN')}元
                  </p>
                  {onUploadCashValue ? (
                    <button
                      className="mt-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      onClick={() => onUploadCashValue(plan.policyId)}
                    >
                      上传现金价值表
                    </button>
                  ) : null}
                </div>
              );
            })() : null}

            {plan.scenarioEntries.length ? (
              <ScenarioDetailTable entries={plan.scenarioEntries} />
            ) : null}

            {!plan.annualEntries.length && !plan.scenarioEntries.length ? (
              <p className="py-6 text-center text-sm text-slate-400">暂无现金流或保障责任数据</p>
            ) : null}
          </section>
        ))}

        {summary && summary.entries.length ? (
          <section className="rounded-[20px] border-2 border-blue-200 bg-white p-4 shadow-[0_12px_24px_-20px_rgba(37,99,235,0.16)]">
            <h3 className="mb-3 text-base font-black text-blue-700">年度现金流汇总</h3>
            <MemberAnnualSummaryTable summary={summary} />
            <p className="mt-2 text-right text-sm font-black text-blue-800">
              合计: {summary.totalCashflow.toLocaleString('zh-CN')}元
            </p>
          </section>
        ) : null}
      </main>
      {cashValueDialog}
    </div>
  );
}
