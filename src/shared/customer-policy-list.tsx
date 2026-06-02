import { FileText } from 'lucide-react';
import type { Policy } from '../api/contracts/policy';
import {
  policyValidityClassName,
  resolvePolicyValidityStatus,
} from '../policy-validity.mjs';
import {
  formatCoverageAmount,
  formatCurrency,
} from './formatters';
import {
  isPolicyReportFailed,
  isPolicyReportGenerating,
} from './policy-report-ui';
import {
  summarizeCashValues,
} from './customer-cash-value';

type PolicyGroup = {
  insured: string;
  policies: Policy[];
  totalCoverage: number;
  annualPremium: number;
};

export function groupPoliciesByInsured(policies: Policy[]): PolicyGroup[] {
  const groups = new Map<string, PolicyGroup>();
  for (const policy of policies) {
    const insured = String(policy.insured || '').trim() || '未识别被保人';
    const existing = groups.get(insured) || {
      insured,
      policies: [],
      totalCoverage: 0,
      annualPremium: 0,
    };
    existing.policies.push(policy);
    existing.totalCoverage += Number(policy.amount || 0);
    existing.annualPremium += Number(policy.firstPremium || 0);
    groups.set(insured, existing);
  }
  return [...groups.values()].sort((left, right) => right.policies.length - left.policies.length || left.insured.localeCompare(right.insured));
}

export function PolicyListItem({ policy, index, onOpen }: { policy: Policy; index: number; onOpen: () => void }) {
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const cashValueSummary = summarizeCashValues(policy.cashValues);
  const validityStatus = resolvePolicyValidityStatus(policy.coveragePeriod, {
    effectiveDate: policy.date,
    insuredBirthday: policy.insuredBirthday,
  });
  const validityStatusClassName = policyValidityClassName(validityStatus.tone);
  const reportStatusClassName = reportGenerating
    ? 'bg-[#FFF7ED] text-[#C2410C] ring-[#FED7AA]'
    : reportFailed
      ? 'bg-[#FEF2F2] text-[#DC2626] ring-[#FECACA]'
      : 'bg-[#EFF6FF] text-[#1D4ED8] ring-[#DBEAFE]';
  const reportStatusLabel = reportGenerating ? '报告生成中' : reportFailed ? '报告失败' : 'OCR 已识别';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group block w-full cursor-pointer rounded-[20px] border border-[#E3ECF8] bg-[linear-gradient(180deg,rgba(17,82,212,0.045)_0%,rgba(248,251,255,0.96)_100%)] px-4 py-4 text-left transition hover:border-[#BCD1EE] active:scale-[0.995]"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[16px] border border-[#CFE0F4] bg-white text-[#1152D4] shadow-[0_10px_22px_-20px_rgba(17,82,212,0.45)]">
          <FileText className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#68829F] ring-1 ring-[#DFE8F4]">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${validityStatusClassName}`}>{validityStatus.label}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${reportStatusClassName}`}>{reportStatusLabel}</span>
          </div>
          <p
            className="mt-2 text-[16px] font-semibold leading-[1.45] text-[#0F172A]"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {policy.name}
          </p>
          <div className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[12px] font-medium text-[#5E7A98] ring-1 ring-[#DCE7F4]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1152D4]/45" />
            <span className="truncate">{policy.company}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
            <span className="rounded-xl bg-white px-3 py-2 text-[#5E7A98] ring-1 ring-[#E1EAF5]">保额 {formatCoverageAmount(Number(policy.amount || 0))}</span>
            <span className="rounded-xl bg-white px-3 py-2 text-[#5E7A98] ring-1 ring-[#E1EAF5]">保费 {formatCurrency(Number(policy.firstPremium || 0))}</span>
          </div>
          {cashValueSummary ? (
            <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-[12px] font-semibold text-emerald-700">
              现金价值已录入 {cashValueSummary.count} 年 · 首年 {formatCurrency(cashValueSummary.first.cashValue)} · {cashValueSummary.last.policyYear}年末 {formatCurrency(cashValueSummary.last.cashValue)}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
