import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  ChevronLeft,
  Download,
  FileText,
  RotateCcw,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import type {
  FamilyPlanningProfile,
  FamilyMemberProtectionReport,
  FamilyPolicyInventoryRow,
  FamilyReport,
  FamilyWealthAggregateRow,
  FamilyWealthPolicyReport,
} from './family-report-engine.mjs';
import { FamilySalesReviewMarkdown } from './features/family-report/FamilySalesReviewMarkdown';

type FamilyReportPageProps = {
  report: FamilyReport;
  reportStale?: boolean;
  planningProfile: FamilyPlanningProfile;
  policyAnalysisReport?: FamilyPolicyAnalysisReport | null;
  policyAnalysisLoading?: boolean;
  onPlanningProfileChange: (profile: FamilyPlanningProfile) => void;
  onBack: () => void;
  onExport: (target: HTMLElement | null, title: string) => void | Promise<void>;
  onRegenerate?: () => void | Promise<void>;
  onGeneratePolicyAnalysisReport?: () => void | Promise<void>;
  regenerating?: boolean;
  statusMessage?: string;
  readOnly?: boolean;
};

type FamilyPolicyAnalysisReport = {
  status?: string;
  content?: string;
  generatedAt?: string;
  error?: string;
  stale?: boolean;
};

type OptionalResponsibilityGap = {
  member: string;
  policyId?: number;
  productName: string;
  liability: string;
  quantificationStatus: string;
  quantificationReason: string;
};

type FamilyReportWithOptionalGaps = FamilyReport & {
  optionalResponsibilityGaps?: OptionalResponsibilityGap[];
  pendingVerificationItems?: Array<{
    policyId?: number | string | null;
    company?: string;
    productName?: string;
    title?: string;
    verificationLabel?: string;
    url?: string;
    excerpt?: string;
  }>;
};

const planningProfileFields: Array<{ key: keyof FamilyPlanningProfile; label: string; placeholder: string }> = [
  { key: 'annualExpense', label: '家庭年支出', placeholder: '如 300000' },
  { key: 'debt', label: '家庭负债', placeholder: '如 800000' },
  { key: 'educationGoal', label: '教育目标', placeholder: '如 500000' },
  { key: 'parentSupportGoal', label: '父母赡养', placeholder: '如 300000' },
  { key: 'retirementGoal', label: '养老目标', placeholder: '如 1000000' },
  { key: 'availableAssets', label: '可用资产', placeholder: '如 200000' },
  { key: 'premiumBudget', label: '保费预算', placeholder: '如 50000' },
];

function formatMoney(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function insuranceProductKeyword(productName?: string | null) {
  const original = String(productName || '').replace(/\s+/g, '').trim();
  if (!original) return '未命名';

  const withoutInsurer = original
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/^.*?(保险股份有限公司|保险有限责任公司|保险有限公司|人寿保险公司|保险公司)/u, '')
    .replace(/^(新华保险|平安人寿|中国人寿|太平洋人寿|泰康人寿|太平人寿|友邦人寿)/u, '');
  const keyword = [
    /终身护理保险$/u,
    /重大疾病保险$/u,
    /意外伤害保险$/u,
    /两全保险$/u,
    /年金保险$/u,
    /医疗保险$/u,
    /终身寿险$/u,
    /万能保险$/u,
    /护理保险$/u,
    /保险$/u,
    /寿险$/u,
  ].reduce((text, suffix) => text.replace(suffix, ''), withoutInsurer).trim();

  return truncateText(keyword || original, 12);
}

function formatMoneyWithUnit(value: number) {
  return `${formatMoney(value)}元`;
}

function formatCashValue(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCashValueAxis(value: number) {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 100000000) return `${Number((value / 100000000).toFixed(1))}亿`;
  if (Math.abs(value) >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
  return formatMoney(value);
}

function emptyText(value?: string | number | null) {
  if (value === null || value === undefined || String(value).trim() === '') return '-';
  return String(value);
}

function memberDisplayName(member: { member?: string; name?: string; relationLabel?: string }) {
  const name = member.member || member.name || '';
  return [member.relationLabel, name].filter(Boolean).join(' · ') || name;
}

function reportMemberKey(member: { memberKey?: string; member?: string; name?: string }) {
  return member.memberKey || member.member || member.name || '';
}

function statusClassName(status: string) {
  if (status === 'covered') return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (status === 'partial' || status === 'formula') return 'bg-amber-50 text-amber-700 ring-amber-100';
  if (status === 'inactive') return 'bg-red-50 text-red-700 ring-red-100';
  if (status === 'missing') return 'bg-slate-100 text-slate-500 ring-slate-200';
  return 'bg-blue-50 text-blue-700 ring-blue-100';
}

function statusLabel(status: string) {
  if (status === 'covered') return '已覆盖';
  if (status === 'partial') return '部分覆盖';
  if (status === 'formula') return '公式型';
  if (status === 'inactive') return '已失效';
  if (status === 'missing') return '未识别';
  return '待确认';
}

function compactText(value?: string | number | null) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number) {
  const text = compactText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function isVerboseConditionText(text: string) {
  return text.length > 80 || /保险责任|本合同|保险期间|官网条款|已截取|我们按/u.test(text);
}

function summarizeConditionText(value?: string | number | null) {
  const raw = compactText(value);
  if (!raw) return '-';
  if (!isVerboseConditionText(raw)) return raw;

  const tags = [
    { label: '等待期', pattern: /等待期/u },
    { label: '重疾', pattern: /重大疾病|重疾|重度疾病/u },
    { label: '中症', pattern: /中症|中度疾病/u },
    { label: '轻症', pattern: /轻症|轻度疾病/u },
    { label: '特定疾病', pattern: /特定疾病|少儿特疾|癌|恶性肿瘤/u },
    { label: '护理金', pattern: /护理/u },
    { label: '身故/全残', pattern: /身故|全残|身体全残/u },
    { label: '给付比例', pattern: /给付比例|赔付比例|[0-9]+(?:\.[0-9]+)?%/u },
    { label: '给付次数', pattern: /给付次数|赔付次数|限[0-9一二三四五六七八九十]+次/u },
    { label: '保额/保费公式', pattern: /基本保险金额|基本保额|保险费|现金价值|较大者|最大者|max/iu },
  ].filter((tag) => tag.pattern.test(raw)).map((tag) => tag.label);

  const uniqueTags = Array.from(new Set(tags)).slice(0, 4);
  if (uniqueTags.length) return `${uniqueTags.join('、')}相关条款`;

  const cleaned = raw
    .replace(/^[^。；;]{0,80}?(?:官网条款|已截取保险责任正文)[。；;]*/u, '')
    .replace(/^保险责任\s*/u, '')
    .replace(/^在本合同保险期间内[，,]?(?:我们|本公司)?(?:按下列规定)?承担保险责任[:：]?/u, '')
    .trim();
  return truncateText(cleaned || raw, 42);
}

function ConditionSummary({ text }: { text?: string | number | null }) {
  const raw = compactText(text);
  if (!raw) return <span>-</span>;

  const summary = summarizeConditionText(raw);
  const collapsed = summary !== raw;

  return (
    <div className="min-w-0 max-w-full leading-5">
      <p className="break-words text-xs font-semibold text-slate-600">{summary}</p>
      {collapsed ? (
        <details data-family-report-raw-note className="mt-1 block">
          <summary className="block cursor-pointer text-[11px] font-black leading-5 text-[#0B72B9]">查看原文</summary>
          <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] font-medium leading-5 text-slate-500 ring-1 ring-slate-100">
            {raw}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function sourcePolicyText(row: FamilyMemberProtectionReport['rows'][number]) {
  if (!row.sourcePolicies.length) return '-';
  const names = row.sourcePolicies
    .map((policy) => compactText(policy.productName || policy.liability || '未命名保单'))
    .filter(Boolean);
  return Array.from(new Set(names)).join(' / ') || '-';
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${reportSurfaceClassName} space-y-4 p-4 md:p-5`}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-7 w-1.5 shrink-0 rounded-full bg-[#0B72B9]" aria-hidden="true" />
        <h2 className="family-report-heading min-w-0 break-words text-lg font-black leading-tight text-[#102033]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-[18px] border border-dashed border-[#CBD7E1] bg-[#F8FAFC] px-4 py-6 text-center text-sm font-semibold text-[#72849A]">
      {text}
    </div>
  );
}

function TableWrap({ children }: { children: React.ReactNode }) {
  return <div data-pdf-table-wrap className="overflow-x-auto rounded-[18px] border border-[#E1E8EF] bg-white">{children}</div>;
}

type RadarSeries = FamilyReport['radar']['family'];

const radarColors = ['#0EA5E9', '#22C55E', '#F97316', '#8B5CF6'];

type RadarReferenceMarker = {
  key: string;
  color: string;
  amountText: string;
  visualScore: number;
  x: number;
  y: number;
  textX: number;
  textY: number;
  textAnchor: 'start' | 'middle' | 'end';
};

function scoreByKey(series: RadarSeries, key: string) {
  return series.scores.find((score) => score.key === key);
}

function radarShortAmount(score: RadarSeries['scores'][number]) {
  return score.amountText || formatMoneyWithUnit(score.amount);
}

function radarScoreSummary(score: RadarSeries['scores'][number]) {
  if (score.amount <= 0) return score.note;
  if (score.key === 'wealth') return '现金价值与未来领取合计';
  return score.policyCount > 0
    ? `来源${score.policyCount}张保单，按金额合计绘制`
    : '按已识别责任金额绘制';
}

function radarPlanningSummary(score: RadarSeries['scores'][number]) {
  if (!score.target || score.target <= 0) return '目标待录入';
  if ((score.gap || 0) > 0) return `有效${score.effectiveAmountText}，目标${score.targetText}，缺口${score.gapText}`;
  if ((score.over || 0) > 0) return `有效${score.effectiveAmountText}，目标${score.targetText}，超配${score.overText}`;
  return `有效${score.effectiveAmountText}，目标${score.targetText}`;
}

function radarPrimaryValue(score: RadarSeries['scores'][number], mode: FamilyReport['radar']['mode']) {
  if (mode === 'planning' && score.target && score.target > 0) return score.adequacyText || `${score.score}%`;
  return radarShortAmount(score);
}

function radarCardSummary(score: RadarSeries['scores'][number], mode: FamilyReport['radar']['mode']) {
  if (mode === 'planning') return radarPlanningSummary(score);
  return radarScoreSummary(score);
}

function radarStructureAmount(score: RadarSeries['scores'][number]) {
  return score.key === 'accident' ? Number(score.effectiveAmount || score.amount || 0) : Number(score.amount || 0);
}

function radarReferenceOnlyDetails(score: RadarSeries['scores'][number]) {
  return (score.amountDetails || []).filter((detail) => detail.referenceOnly && Number(detail.amount || 0) > 0);
}

function radarReferenceAmount(score: RadarSeries['scores'][number]) {
  const details = radarReferenceOnlyDetails(score);
  return details.length ? Math.max(...details.map((detail) => Number(detail.amount || 0))) : 0;
}

function radarReferenceAmountText(score: RadarSeries['scores'][number]) {
  const maxReferenceAmount = radarReferenceAmount(score);
  if (maxReferenceAmount <= 0) return '';
  return score.amountText || `≥${formatMoneyWithUnit(maxReferenceAmount)}参考`;
}

function radarChartAmount(score: RadarSeries['scores'][number]) {
  return radarStructureAmount(score) || radarReferenceAmount(score);
}

function radarChartScore(score: RadarSeries['scores'][number], series: RadarSeries, mode: FamilyReport['radar']['mode']) {
  if (mode === 'planning') return Math.max(0, Math.min(100, Number(score.score || 0)));

  const amount = radarChartAmount(score);
  if (amount <= 0) return 0;
  const maxBase = Math.max(0, ...series.scores.map((item) => Math.sqrt(Math.max(0, radarChartAmount(item)))));
  return maxBase > 0 ? Math.round((Math.sqrt(amount) / maxBase) * 100) : 0;
}

function calculationRowsForScore(
  score: RadarSeries['scores'][number],
  series: RadarSeries,
  mode: FamilyReport['radar']['mode'],
) {
  if (mode === 'planning') {
    if (!score.target || score.target <= 0) {
      return [
        { label: '金额合计', value: score.amountText },
        { label: '计算结果', value: '目标为0，雷达值按0显示' },
      ];
    }

    return [
      { label: '金额合计', value: score.amountText },
      { label: '有效保障', value: score.effectiveAmountText },
      { label: '估算目标', value: score.targetText || formatMoneyWithUnit(score.target) },
      { label: '雷达值', value: `${score.effectiveAmountText} ÷ ${score.targetText || formatMoneyWithUnit(score.target)} ≈ ${score.adequacyText || `${score.score}%`}` },
    ];
  }

  const amount = radarStructureAmount(score);
  const maxAmount = Math.max(0, ...series.scores.map(radarStructureAmount));
  const amountText = formatMoneyWithUnit(amount);
  const maxText = formatMoneyWithUnit(maxAmount);
  const basisLabel = score.key === 'accident' ? '有效金额' : '原始金额';
  const referenceDetails = radarReferenceOnlyDetails(score);

  if (amount <= 0 && referenceDetails.length) {
    const referenceScore = radarChartScore(score, series, mode);
    return [
      { label: '固定保额', value: amountText },
      { label: '参考下限', value: score.amountText },
      { label: '固定雷达值', value: `${score.score}/100（参考下限不计入固定保额）` },
      { label: '图表参考', value: `${referenceScore}/100（图形按参考下限显示）` },
    ];
  }

  return [
    { label: '金额合计', value: score.amountText },
    { label: basisLabel, value: amountText },
    { label: '压缩处理', value: `√${amountText} ÷ √${maxText} × 100` },
    { label: '雷达值', value: `${score.score}/100` },
  ];
}

function radarAmountSourceDetails(score: RadarSeries['scores'][number]) {
  return (score.amountDetails || []).filter((detail) => Number(detail.amount || 0) > 0);
}

function radarAmountPolicyTitle(detail: ReturnType<typeof radarAmountSourceDetails>[number]) {
  const parts = [detail.company, detail.productName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index);
  return parts.join(' · ') || '未命名保单';
}

function radarAmountLiabilityTitle(detail: ReturnType<typeof radarAmountSourceDetails>[number]) {
  const productName = String(detail.productName || '').trim();
  const parts = [detail.liability, detail.label]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part) => part !== productName)
    .filter((part, index, all) => all.indexOf(part) === index);
  return parts.join(' · ') || '已识别责任';
}

function RadarCalculationDetails({
  series,
  mode,
}: {
  series: RadarSeries;
  mode: FamilyReport['radar']['mode'];
}) {
  const planningMode = mode === 'planning';

  return (
    <div className="mt-3 rounded-[18px] border border-[#E1E8EF] bg-[#F8FAFC] p-3">
      <p className="mb-2 text-[11px] font-black text-[#72849A]">
        {planningMode ? '先看金额计算方法，再按有效保障 / 系统估算目标计算' : '先看金额计算方法，再按有效金额开平方后对比，避免高额责任压低其他维度'}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        {series.scores.map((score) => {
          const amountDetails = radarAmountSourceDetails(score);
          return (
            <div key={score.key} className="min-w-0 rounded-[14px] border border-[#E1E8EF] bg-white px-3 py-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-black text-[#102033]">{score.label}</p>
                <p className="shrink-0 text-xs font-black text-[#0B72B9]">{planningMode ? (score.adequacyText || `${score.score}%`) : `${score.score}/100`}</p>
              </div>
              <div className="mb-1.5 rounded-xl bg-[#F8FAFC] px-2 py-1.5">
                <p className="mb-1 text-[11px] font-black text-[#72849A]">金额计算方法</p>
                {amountDetails.length ? (
                  <div className="max-h-[260px] space-y-1 overflow-y-auto pr-1">
                    {amountDetails.map((detail) => (
                      <div key={`${detail.sourceKey || detail.policyId || detail.label}-${detail.liability}-${detail.amountText}`} className="min-w-0">
                        <p className="break-words text-[11px] font-bold leading-4 text-[#102033]">{radarAmountPolicyTitle(detail)}</p>
                        <p className="break-words text-[11px] font-semibold leading-4 text-[#72849A]">责任：{radarAmountLiabilityTitle(detail)}</p>
                        <p className="break-words text-[11px] font-semibold leading-4 text-[#475569]">{detail.calculationText}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="break-words text-[11px] font-semibold leading-4 text-[#475569]">{score.note}</p>
                )}
              </div>
              {calculationRowsForScore(score, series, mode).map((row) => (
                <div key={row.label} className="flex min-w-0 justify-between gap-2 py-0.5 text-[11px] font-semibold leading-4">
                  <span className="shrink-0 text-[#72849A]">{row.label}</span>
                  <span className="min-w-0 break-words text-right text-[#475569]">{row.value}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const thClassName = 'bg-blue-500 px-3 py-2.5 text-left text-xs font-black text-white';
const tdClassName = 'whitespace-nowrap bg-white px-3 py-2.5 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]';
const compactThClassName = 'bg-blue-500 px-2 py-1.5 text-center text-xs font-black text-white';
const compactTdClassName = 'whitespace-nowrap bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]';

function getFamilyAttentionItems(report: FamilyReport) {
  const memberSeries = [
    ...report.radar.members,
    ...report.radar.hiddenMembers,
  ];

  return [
    ...report.summary.attentionItems,
    ...memberSeries.flatMap((member) => member.scores
      .filter((score) => score.coveragePresent === false)
      .map((score) => `${memberDisplayName(member)}: ${score.label}缺失`)),
  ];
}

function getFamilySummaryMetrics(report: FamilyReport, attentionItems: string[]) {
  const { summary } = report;
  return [
    { label: '家庭成员', value: `${summary.memberCount}人` },
    { label: '有效保单', value: `${summary.policyCount}张` },
    { label: '年交保费', value: formatMoneyWithUnit(summary.annualPremium) },
    { label: '保障总额', value: formatMoneyWithUnit(summary.totalCoverage) },
    { label: '现金价值合计', value: formatMoneyWithUnit(summary.cashValueTotal) },
    { label: '待关注', value: `${attentionItems.length}项` },
  ];
}

function AttentionSection({ attentionItems }: { attentionItems: string[] }) {
  if (!attentionItems.length) return null;

  return (
    <Section title="待关注事项">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {attentionItems.map((item, index) => (
          <div key={`${item}-${index}`} className="flex min-w-0 items-center gap-2 rounded-[16px] border border-[#F3D9B4] bg-[#FFF8EB] px-3 py-2 text-xs font-bold leading-5 text-[#9A4A16]">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F97316] text-white">
              <AlertTriangle size={12} />
            </span>
            <p className="min-w-0 break-words">{item}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function OptionalResponsibilityGapSection({ gaps = [] }: { gaps?: OptionalResponsibilityGap[] }) {
  if (!gaps?.length) return null;

  return (
    <Section title="已投保但未量化责任">
      <div className="grid gap-2 md:grid-cols-2">
        {gaps.map((gap, index) => (
          <div key={`${gap.policyId}-${gap.liability}-${index}`} className="min-w-0 rounded-[16px] border border-[#F3D9B4] bg-[#FFF8EB] px-3 py-2.5 text-xs font-semibold leading-5 text-[#9A4A16]">
            <p className="break-words font-black text-[#7C2D12]">{gap.member} · {gap.productName}</p>
            <p className="mt-1 break-words">{gap.liability}</p>
            <p className="mt-1 break-words text-[#B45309]">{gap.quantificationReason || '缺少可计算结构化指标'}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function PendingVerificationSection({ items = [] }: { items?: FamilyReportWithOptionalGaps['pendingVerificationItems'] }) {
  if (!items?.length) return null;

  return (
    <Section title="待核实参考线索">
      <div className="grid gap-2 md:grid-cols-2">
        {items.map((item, index) => (
          <article key={`${item.policyId}-${item.title}-${index}`} className="min-w-0 rounded-[16px] border border-[#F3D9B4] bg-[#FFF8EB] px-3 py-2.5 text-xs font-semibold leading-5 text-[#9A4A16]">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words font-black text-[#7C2D12]">
                {[item.company, item.productName].filter(Boolean).join(' · ') || '待核实保单资料'}
              </p>
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-black text-[#A6531B] ring-1 ring-[#F3D9B4]">
                {item.verificationLabel || '待核实参考'}
              </span>
            </div>
            <p className="mt-1 break-words font-black">{item.title || '待核实资料'}</p>
            {item.excerpt ? <p className="mt-1 line-clamp-2 break-words text-[#B45309]">{item.excerpt}</p> : null}
            {item.url ? <p className="mt-1 truncate text-[11px] text-[#B45309]">{item.url}</p> : null}
          </article>
        ))}
      </div>
    </Section>
  );
}

const reportSurfaceClassName = 'rounded-[24px] border border-[#D7E2EA] bg-white shadow-[0_18px_48px_-36px_rgba(15,23,42,0.38)]';
const reportMutedSurfaceClassName = 'rounded-[20px] border border-[#E1E8EF] bg-[#F7FAFC]';

function metricIcon(label: string) {
  if (/成员/u.test(label)) return <Users size={17} />;
  if (/保单/u.test(label)) return <FileText size={17} />;
  if (/保费|现金|财富/u.test(label)) return <Wallet size={17} />;
  if (/保障|保额/u.test(label)) return <ShieldCheck size={17} />;
  if (/关注/u.test(label)) return <AlertTriangle size={17} />;
  return <TrendingUp size={17} />;
}

function MetricTile({ label, value, dark = false }: { label: string; value: string; dark?: boolean }) {
  return (
    <div className={`min-w-0 rounded-[18px] border px-2.5 py-2.5 md:px-3 md:py-3 ${
      dark
        ? 'border-white/25 bg-white/[0.16] text-white'
        : 'border-[#E1EAF5] bg-[#F8FBFF] text-[#0F172A]'
    }`}>
      <div className={`mb-2 flex h-7 w-7 items-center justify-center rounded-xl md:h-8 md:w-8 ${
        dark ? 'bg-white/18 text-white' : 'bg-blue-50 text-[#0B72B9]'
      }`}>
        {metricIcon(label)}
      </div>
      <p className={`family-report-kicker text-[11px] uppercase ${dark ? 'text-white/62' : 'text-[#72849A]'}`}>{label}</p>
      <p className={`family-report-number mt-1 break-words text-base font-black leading-tight md:text-lg ${dark ? 'text-white' : 'text-[#0F172A]'}`}>{value}</p>
    </div>
  );
}

function ReportHero({ report, attentionItems }: { report: FamilyReport; attentionItems: string[] }) {
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const metrics = getFamilySummaryMetrics(report, attentionItems);
  const headlineMetrics = metrics.slice(0, 3);
  const secondaryMetrics = metrics.slice(3);

  return (
    <section className="overflow-hidden rounded-[28px] border border-[#7CC7F4] bg-gradient-to-br from-blue-600 via-sky-500 to-emerald-400 text-white shadow-[0_26px_70px_-42px_rgba(14,116,144,0.78)]">
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.12fr)_minmax(340px,0.88fr)]">
        <div className="relative min-w-0 p-5 md:p-7">
          <div className="absolute inset-y-6 left-0 w-1 rounded-r-full bg-white/70" aria-hidden="true" />
          <p className="family-report-kicker text-[11px] uppercase text-white/75">Family Policy Dossier</p>
          <h2 className="family-report-heading mt-3 max-w-[720px] text-[30px] font-black leading-tight md:text-[40px]">家庭保障分析报告</h2>
          <p className="mt-3 max-w-2xl text-sm font-medium leading-6 text-white/72">
            按家庭成员汇总重疾、意外、财富三大板块，并保留每张保单的责任、现金流和现金价值。
          </p>
          <p className="family-report-kicker mt-5 text-[11px] uppercase text-white/48">全家总统计</p>
          <div className="mt-2 grid grid-cols-3 gap-2 md:gap-3">
            {headlineMetrics.map((metric) => <MetricTile key={metric.label} label={metric.label} value={metric.value} dark />)}
          </div>
        </div>
        <div className="min-w-0 border-t border-white/20 bg-white/[0.12] p-5 md:p-7 lg:border-l lg:border-t-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="family-report-kicker text-[11px] uppercase text-white/48">生成时间</p>
              <p className="family-report-number mt-1 text-base font-black text-white">{generatedAt}</p>
            </div>
            <div className={`rounded-[16px] px-3 py-2 text-right ${
              attentionItems.length ? 'bg-[#FFF8EB] text-[#9A4A16]' : 'bg-blue-50 text-[#0B72B9]'
            }`}>
              <p className="text-[11px] font-black">待关注</p>
              <p className="family-report-number text-lg font-black">{attentionItems.length}项</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 md:gap-3 lg:grid-cols-1 xl:grid-cols-3">
            {secondaryMetrics.map((metric) => <MetricTile key={metric.label} label={metric.label} value={metric.value} dark />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function RadarChart({
  dimensions,
  series,
  ariaLabel,
  mode,
  framed = true,
}: {
  dimensions: FamilyReport['radar']['dimensions'];
  series: RadarSeries[];
  ariaLabel: string;
  mode: FamilyReport['radar']['mode'];
  framed?: boolean;
}) {
  const width = 320;
  const height = 218;
  const centerX = width / 2;
  const centerY = 118;
  const radius = 82;
  const rings = [0.25, 0.5, 0.75, 1];
  const axisPoints = dimensions.map((dimension, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / dimensions.length;
    return {
      ...dimension,
      angle,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      labelX: centerX + Math.cos(angle) * (radius + 24),
      labelY: centerY + Math.sin(angle) * (radius + 24),
    };
  });
  const referenceMarkers = series.flatMap((item, seriesIndex) => axisPoints.map((point): RadarReferenceMarker | null => {
    const score = scoreByKey(item, point.key);
    const amountText = score ? radarReferenceAmountText(score) : '';
    if (!score || !amountText) return null;

    const color = radarColors[seriesIndex % radarColors.length];
    const visualScore = radarChartScore(score, item, mode);
    const visibleScore = mode === 'structure' ? Math.max(visualScore, 28) : visualScore;
    const markerRadius = radius * Math.max(12, Math.min(100, visibleScore)) / 100;
    const cos = Math.cos(point.angle);
    const sin = Math.sin(point.angle);
    const textAnchor = cos > 0.35 ? 'start' : (cos < -0.35 ? 'end' : 'middle');
    return {
      key: `${item.name}-${point.key}`,
      color,
      amountText,
      visualScore: visibleScore,
      x: centerX + cos * markerRadius,
      y: centerY + sin * markerRadius,
      textX: centerX + cos * (markerRadius + 12),
      textY: centerY + sin * (markerRadius + 12) + (Math.abs(sin) > 0.8 ? (sin > 0 ? 10 : -4) : 4),
      textAnchor,
    };
  }).filter((marker): marker is RadarReferenceMarker => Boolean(marker)));
  const hasShape = series.some((item) => item.scores.some((score) => radarChartScore(score, item, mode) > 0));

  if (!hasShape && !referenceMarkers.length) return <EmptyState text="暂无可绘制雷达图的金额数据" />;

  const polygonForSeries = (item: RadarSeries) => axisPoints.map((point) => {
    const matchedScore = scoreByKey(item, point.key);
    const score = matchedScore ? radarChartScore(matchedScore, item, mode) : 0;
    const pointRadius = (radius * score) / 100;
    return `${(centerX + Math.cos(point.angle) * pointRadius).toFixed(1)},${(centerY + Math.sin(point.angle) * pointRadius).toFixed(1)}`;
  }).join(' ');

  return (
    <div className={framed ? 'min-w-0 rounded-2xl bg-white p-2' : 'min-w-0'}>
      <svg className="h-auto w-full max-w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        <rect x="0" y="0" width={width} height={height} rx="16" fill="#FFFFFF" />
        {rings.map((ring) => (
          <polygon
            key={ring}
            points={axisPoints.map((point) => `${(centerX + Math.cos(point.angle) * radius * ring).toFixed(1)},${(centerY + Math.sin(point.angle) * radius * ring).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#E2E8F0"
            strokeWidth="1"
          />
        ))}
        {axisPoints.map((point) => (
          <g key={point.key}>
            <line x1={centerX} y1={centerY} x2={point.x} y2={point.y} stroke="#E2E8F0" strokeWidth="1" />
            <text x={point.labelX} y={point.labelY + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
              {point.label}
            </text>
          </g>
        ))}
        {series.map((item, index) => {
          const color = radarColors[index % radarColors.length];
          return (
            <g key={item.name}>
              {item.scores.some((score) => radarChartScore(score, item, mode) > 0) ? (
                <polygon points={polygonForSeries(item)} fill={color} opacity={series.length === 1 ? 0.18 : 0.1} stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
              ) : null}
            </g>
          );
        })}
        {referenceMarkers.map((marker) => (
          <g key={marker.key}>
            <line
              x1={centerX}
              y1={centerY}
              x2={marker.x}
              y2={marker.y}
              stroke={marker.color}
              strokeWidth={marker.visualScore >= 24 ? 4 : 3}
              strokeLinecap="round"
              strokeDasharray="5 4"
              opacity="0.82"
            />
            <path d={`M ${marker.x} ${marker.y - 4} L ${marker.x + 4} ${marker.y} L ${marker.x} ${marker.y + 4} L ${marker.x - 4} ${marker.y} Z`} fill={marker.color} stroke="#FFFFFF" strokeWidth="1.8" />
            <text x={marker.textX} y={marker.textY} textAnchor={marker.textAnchor} fontSize="10" fontWeight="800" fill={marker.color}>
              {marker.amountText}
            </text>
          </g>
        ))}
      </svg>
      <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 px-1 pb-1" aria-hidden="true">
        {series.map((item, index) => {
          const color = radarColors[index % radarColors.length];
          return (
            <div key={item.name} className="flex min-w-0 max-w-full items-start gap-1.5">
              <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
              <span className="min-w-0 break-words text-[11px] font-bold leading-4 text-[#475569]">{item.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FamilyPlanningProfilePanel({
  profile,
  onChange,
  readOnly = false,
}: {
  profile: FamilyPlanningProfile;
  onChange: (profile: FamilyPlanningProfile) => void;
  readOnly?: boolean;
}) {
  const hasPlanningProfile = planningProfileFields.some((field) => Number(profile?.[field.key] || 0) > 0);

  function updateProfileValue(key: keyof FamilyPlanningProfile, value: string) {
    const numericValue = Math.max(0, Number(value || 0) || 0);
    onChange({ ...(profile || {}), [key]: numericValue });
  }

  return (
    <Section title="保障规划设置">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-black ${
          hasPlanningProfile ? 'bg-blue-50 text-[#0B72B9]' : 'bg-[#EEF3F7] text-[#42566B]'
        }`}>
          保障规划版
        </span>
        <span className={`rounded-full px-3 py-1 text-xs font-black ${
          hasPlanningProfile ? 'bg-[#EEF3F7] text-[#42566B]' : 'bg-blue-50 text-[#0B72B9]'
        }`}>
          保额结构版
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {planningProfileFields.map((field) => (
          <label key={field.key} className="min-w-0 rounded-[16px] border border-[#E1E8EF] bg-white px-3 py-2">
            <span className="block text-[11px] font-black text-[#72849A]">{field.label}</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              disabled={readOnly}
              value={profile?.[field.key] || ''}
              onChange={(event) => updateProfileValue(field.key, event.target.value)}
              placeholder={field.placeholder}
              className="mt-1 w-full min-w-0 bg-transparent text-sm font-black text-[#102033] outline-none placeholder:text-[#A7B5C3] disabled:text-[#72849A]"
            />
          </label>
        ))}
      </div>
    </Section>
  );
}

export function FamilyRadarSection({ report }: { report: FamilyReport }) {
  const family = report.radar.family;
  const wealth = scoreByKey(family, 'wealth');
  const planningMode = report.radar.mode === 'planning';
  const [calculationExpanded, setCalculationExpanded] = useState(false);

  return (
    <Section title={planningMode ? '全家保障充足率雷达' : '全家保额结构雷达'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold leading-5 text-[#72849A]">
          {planningMode ? '按当前有效保障/家庭目标绘制，超出部分单独显示。' : '按有效金额压缩比例绘制，避免高额责任压低其他维度。'}
        </p>
        <button
          type="button"
          onClick={() => setCalculationExpanded((current) => !current)}
          className="flex items-center gap-1 rounded-full bg-[#EEF3F7] px-2 py-1 text-[11px] font-black text-[#42566B] active:bg-[#E1E8EF]"
          aria-expanded={calculationExpanded}
          aria-label="全家金额和雷达值怎么算"
          title="金额计算方法和雷达值怎么算"
        >
          <Calculator size={13} />
          <span>金额怎么算</span>
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <RadarChart dimensions={report.radar.dimensions} series={[family]} mode={report.radar.mode} ariaLabel="全家保障均衡雷达" />
        <div className="grid gap-3 sm:grid-cols-2">
          {family.scores.map((score) => (
            <div key={score.key} className="min-w-0 rounded-[18px] border border-[#E1E8EF] bg-[#F8FAFC] px-3 py-3">
              <p className="text-[11px] font-black uppercase text-[#72849A]">{score.label}</p>
              <p className="mt-1 break-words text-lg font-black leading-tight text-[#102033]">{radarPrimaryValue(score, report.radar.mode)}</p>
              <p className="mt-2 break-words text-[11px] font-semibold leading-4 text-[#64748B]">{radarCardSummary(score, report.radar.mode)}</p>
            </div>
          ))}
          {wealth ? (
            <div className="min-w-0 rounded-[18px] border border-[#D9E6F4] bg-[#F8FBFF] px-3 py-3 sm:col-span-2">
              <p className="text-[11px] font-black uppercase text-[#0B72B9]">财富拆分</p>
              <p className="mt-1 break-words text-[11px] font-semibold leading-4 text-[#425570]">{wealth.note}</p>
            </div>
          ) : null}
        </div>
      </div>
      {calculationExpanded ? (
        <RadarCalculationDetails series={family} mode={report.radar.mode} />
      ) : null}
    </Section>
  );
}

function MemberRadarSection({ report }: { report: FamilyReport }) {
  const members = report.radar.members;
  if (!members.length) return null;
  const planningMode = report.radar.mode === 'planning';
  const [expandedCalculations, setExpandedCalculations] = useState<Record<string, boolean>>({});
  const memberRadarGridStyle = {
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 540px), 1fr))',
  };

  return (
    <Section title={planningMode ? '个人保障估算雷达' : '个人保额结构雷达'}>
      <div className={`${reportMutedSurfaceClassName} p-3 md:p-4`}>
        <p className="mb-3 text-xs font-bold leading-5 text-[#64748B]">
          {planningMode ? '按家庭目标自动分摊到成员，仅供初步估算；未要求客户录入个人收入、负债或资产。' : '客户未录入家庭目标时，按有效金额压缩比例展示个人结构，非保障充足率。'}
        </p>
        <div className="grid gap-3" style={memberRadarGridStyle}>
          {members.map((member) => {
            const memberKey = reportMemberKey(member);
            return (
            <article key={memberKey} className="min-w-0 rounded-[20px] border border-[#E1E8EF] bg-white p-3 shadow-[0_14px_34px_-32px_rgba(15,23,42,0.34)]">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-base font-black leading-5 text-[#102033]">{memberDisplayName(member)}</p>
                  <p className="mt-1 text-[11px] font-bold text-[#72849A]">{member.roleLabel || '成员'} · 合计 {formatMoneyWithUnit(member.totalAmount)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-[#0B72B9]">
                    {planningMode ? '系统估算' : '结构展示'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedCalculations((current) => ({ ...current, [memberKey]: !current[memberKey] }))}
                    className="flex items-center gap-1 rounded-full bg-[#EEF3F7] px-2 py-1 text-[11px] font-black text-[#42566B] active:bg-[#E1E8EF]"
                    aria-expanded={Boolean(expandedCalculations[memberKey])}
                    aria-label={`${member.name}金额和雷达值怎么算`}
                    title="金额来源和雷达值怎么算"
                  >
                    <Calculator size={13} />
                    <span>金额怎么算</span>
                  </button>
                </div>
              </div>
              <div className="grid gap-3 xl:grid-cols-[minmax(0,220px)_1fr]">
                <RadarChart dimensions={report.radar.dimensions} series={[member]} mode={report.radar.mode} ariaLabel={`${member.name}保障雷达`} framed={false} />
                <div className="divide-y divide-[#E1E8EF]">
                  {member.scores.map((score) => (
                    <div key={score.key} className="flex min-w-0 items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <p className="text-xs font-black text-[#102033]">{score.label}</p>
                        <p className="mt-0.5 break-words text-[11px] font-semibold leading-4 text-[#72849A]">{radarCardSummary(score, report.radar.mode)}</p>
                      </div>
                      <p className="shrink-0 text-right text-sm font-black text-[#0B72B9]">{radarPrimaryValue(score, report.radar.mode)}</p>
                    </div>
                  ))}
                </div>
              </div>
              {expandedCalculations[memberKey] ? (
                <RadarCalculationDetails series={member} mode={report.radar.mode} />
              ) : null}
              {!planningMode && member.notes.length ? (
                <p className="mt-3 break-words rounded-[14px] border border-[#F3D9B4] bg-[#FFF8EB] px-3 py-2 text-[11px] font-semibold leading-4 text-[#9A4A16]">{member.notes.join('；')}</p>
              ) : null}
            </article>
            );
          })}
          {report.radar.hiddenMembers.length ? (
            <div className="rounded-[16px] border border-[#F3D9B4] bg-[#FFF8EB] px-3 py-2 text-[11px] font-semibold leading-4 text-[#9A4A16]" style={{ gridColumn: '1 / -1' }}>
              未展示成员: {report.radar.hiddenMembers.map((member) => `${memberDisplayName(member)}(${formatMoneyWithUnit(member.totalAmount)})`).join('、')}
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

function rowPlanItems(row: FamilyPolicyInventoryRow) {
  if (Array.isArray(row.planItems) && row.planItems.length) return row.planItems;
  return [{
    roleLabel: '主险',
    productName: row.productName,
    matchedProductName: '',
    typeLabel: row.typeLabel,
    coverageText: row.coverageText,
    premiumText: row.annualPremiumText,
    paymentPeriod: row.paymentPeriod,
    coveragePeriod: row.coveragePeriod,
    statusLabel: row.isInactive ? row.policyStatusText || '已失效' : '',
  }];
}

function PolicyPlanList({ row }: { row: FamilyPolicyInventoryRow }) {
  return (
    <div className="space-y-1.5">
      {rowPlanItems(row).map((item, index) => {
        const productName = item.productName || item.matchedProductName;
        const officialName = item.matchedProductName && compactText(item.matchedProductName) !== compactText(item.productName)
          ? item.matchedProductName
          : '';
        const meta = [
          item.statusLabel,
          item.coverageText && item.coverageText !== '按条款' ? `保额 ${item.coverageText}` : '',
          item.premiumText ? `保费 ${item.premiumText}` : '',
          item.coveragePeriod ? `保障 ${item.coveragePeriod}` : '',
        ].filter(Boolean).join(' · ');

        return (
          <div key={`${item.roleLabel}-${productName}-${index}`} className="rounded-[10px] bg-[#F8FBFE] px-2 py-1.5 ring-1 ring-[#E6EEF5]">
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-black text-[#0B72B9] ring-1 ring-[#D7E2EA]">{emptyText(item.roleLabel)}</span>
              <div className="min-w-0">
                <span className="block break-words font-black text-slate-900">{emptyText(productName)}</span>
                {officialName ? (
                  <span className="mt-0.5 block break-words text-[11px] font-medium text-slate-400">{officialName}</span>
                ) : null}
                {meta ? (
                  <span className="mt-0.5 block break-words text-[11px] font-semibold leading-4 text-[#64748B]">{meta}</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PolicyPlanTypeList({ row }: { row: FamilyPolicyInventoryRow }) {
  const plans = rowPlanItems(row);
  return (
    <div className="space-y-1.5">
      {plans.map((item, index) => {
        const typeLabel = item.typeLabel || (plans.length === 1 ? row.typeLabel : '');
        return (
          <div key={`${item.roleLabel}-${item.productName || item.matchedProductName}-${index}`} className="rounded-[10px] bg-white px-2 py-1.5 ring-1 ring-[#E6EEF5]">
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded-full bg-[#EEF6FF] px-1.5 py-0.5 text-[10px] font-black text-[#0B72B9] ring-1 ring-[#CFE5FF]">{emptyText(item.roleLabel)}</span>
              <div className="min-w-0">
                <span className="block break-words text-xs font-black leading-5 text-[#102033]">{emptyText(typeLabel)}</span>
                {item.statusLabel ? (
                  <span className="mt-0.5 block text-[11px] font-semibold text-[#9A4A16]">{item.statusLabel}</span>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function exportStatusToneClassName(status?: string | null) {
  const text = compactText(status);
  if (/量化|完整|正常|有效/u.test(text)) return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (/待|缺|核对|未知|未/u.test(text)) return 'bg-amber-50 text-amber-700 ring-amber-100';
  if (/失效|过期|异常/u.test(text)) return 'bg-red-50 text-red-700 ring-red-100';
  return 'bg-[#EEF3F7] text-[#42566B] ring-[#D7E2EA]';
}

type ExportTone = 'blue' | 'emerald' | 'amber' | 'violet' | 'rose';

const exportToneOrder: ExportTone[] = ['blue', 'emerald', 'amber', 'violet', 'rose'];

const exportToneClassNames: Record<ExportTone, {
  border: string;
  rail: string;
  header: string;
  soft: string;
  badge: string;
  text: string;
  line: string;
}> = {
  blue: {
    border: 'border-blue-100',
    rail: 'bg-[#0B72B9]',
    header: 'bg-[#F0F8FF]',
    soft: 'bg-blue-50 ring-blue-100',
    badge: 'bg-blue-50 text-[#0B72B9] ring-blue-100',
    text: 'text-[#0B72B9]',
    line: 'border-[#0B72B9]',
  },
  emerald: {
    border: 'border-emerald-100',
    rail: 'bg-emerald-500',
    header: 'bg-emerald-50',
    soft: 'bg-emerald-50 ring-emerald-100',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
    text: 'text-emerald-700',
    line: 'border-emerald-500',
  },
  amber: {
    border: 'border-amber-100',
    rail: 'bg-amber-500',
    header: 'bg-amber-50',
    soft: 'bg-amber-50 ring-amber-100',
    badge: 'bg-amber-50 text-amber-700 ring-amber-100',
    text: 'text-amber-700',
    line: 'border-amber-500',
  },
  violet: {
    border: 'border-violet-100',
    rail: 'bg-violet-500',
    header: 'bg-violet-50',
    soft: 'bg-violet-50 ring-violet-100',
    badge: 'bg-violet-50 text-violet-700 ring-violet-100',
    text: 'text-violet-700',
    line: 'border-violet-500',
  },
  rose: {
    border: 'border-rose-100',
    rail: 'bg-rose-500',
    header: 'bg-rose-50',
    soft: 'bg-rose-50 ring-rose-100',
    badge: 'bg-rose-50 text-rose-700 ring-rose-100',
    text: 'text-rose-700',
    line: 'border-rose-500',
  },
};

function exportToneByIndex(index: number): ExportTone {
  return exportToneOrder[index % exportToneOrder.length];
}

function exportMetricToneClassName(label: string, highlight?: boolean) {
  const text = compactText(label);
  if (/保费|交费|年交/u.test(text)) return 'bg-amber-50 text-amber-700 ring-amber-100';
  if (/保障|保额|身故|受益/u.test(text)) return 'bg-blue-50 text-[#0B72B9] ring-blue-100';
  if (/现金价值|价值合计/u.test(text)) return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (/领取|累计/u.test(text)) return 'bg-violet-50 text-violet-700 ring-violet-100';
  if (/身份|被保人|投保人/u.test(text)) return 'bg-cyan-50 text-cyan-700 ring-cyan-100';
  return highlight ? 'bg-blue-50 text-[#0B72B9] ring-blue-100' : 'bg-white text-[#102033] ring-[#E1E8EF]';
}

function exportPlanToneClassName(index: number) {
  return exportToneClassNames[exportToneByIndex(index)].badge;
}

function ExportMetricStrip({ rows }: { rows: Array<{ label: string; value?: string | number | null; highlight?: boolean }> }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] leading-4 md:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label} className={`min-w-0 rounded-lg px-2.5 py-2 ring-1 ${exportMetricToneClassName(row.label, row.highlight)}`}>
          <p className="font-black text-[#72849A]">{row.label}</p>
          <p className="mt-1 break-words font-black">{emptyText(row.value)}</p>
        </div>
      ))}
    </div>
  );
}

function PolicyPlanExportList({ row }: { row: FamilyPolicyInventoryRow }) {
  return (
    <div className="mt-3 divide-y divide-[#E6EEF5]">
      {rowPlanItems(row).map((item, index) => {
        const productName = item.productName || item.matchedProductName || row.productName;
        const officialName = item.matchedProductName && compactText(item.matchedProductName) !== compactText(item.productName)
          ? item.matchedProductName
          : '';
        const meta = [
          item.typeLabel,
          item.coverageText && item.coverageText !== '按条款' ? `保额 ${item.coverageText}` : '',
          item.premiumText ? `保费 ${item.premiumText}` : '',
          item.coveragePeriod ? `保障 ${item.coveragePeriod}` : '',
        ].filter(Boolean).join(' · ');
        const roleToneClassName = exportPlanToneClassName(index);

        return (
          <div key={`${item.roleLabel}-${productName}-${index}`} className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 py-2 first:pt-0 last:pb-0">
            <span className={`mt-0.5 h-fit rounded-md px-1.5 py-1 text-center text-[11px] font-black ring-1 ${roleToneClassName}`}>{emptyText(item.roleLabel)}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-start gap-1.5">
                <p className="min-w-0 flex-1 break-words text-sm font-black leading-5 text-[#102033]">{emptyText(productName)}</p>
                {item.statusLabel ? (
                  <span className="shrink-0 rounded-md bg-[#FFF8EB] px-1.5 py-0.5 text-[11px] font-black text-[#9A4A16] ring-1 ring-[#F3D9B4]">{item.statusLabel}</span>
                ) : null}
              </div>
              {officialName ? (
                <p className="mt-1 break-words text-[11px] font-semibold leading-4 text-[#64748B]">匹配产品：{officialName}</p>
              ) : null}
              {meta ? (
                <p className="mt-1 break-words text-[11px] font-semibold leading-4 text-[#64748B]">{meta}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExportPolicyShell({
  row,
  tone = 'status',
  accent = 'blue',
  children,
}: {
  row: FamilyPolicyInventoryRow;
  tone?: 'status' | 'type';
  accent?: ExportTone;
  children: React.ReactNode;
}) {
  const pillText = tone === 'type' ? row.typeLabel : row.dataStatus;
  const color = exportToneClassNames[accent];
  return (
    <article className={`relative overflow-hidden rounded-lg border bg-white shadow-[0_10px_28px_-24px_rgba(15,23,42,0.36)] ${color.border}`}>
      <span className={`absolute inset-y-0 left-0 w-1 ${color.rail}`} aria-hidden="true" />
      <div className={`border-b border-[#E6EEF5] p-3 pl-4 ${color.header}`}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-black leading-5 text-[#102033]">{emptyText(row.company || row.productName)}</p>
            {row.policyNumber ? (
              <p className="mt-1 break-words text-[11px] font-semibold leading-4 text-[#64748B]">保单号 {row.policyNumber}</p>
            ) : null}
          </div>
          <span className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-black ring-1 ${tone === 'type' ? color.badge : exportStatusToneClassName(row.dataStatus)}`}>
            {emptyText(pillText)}
          </span>
        </div>
      </div>
      <div className="p-3 pl-4">{children}</div>
    </article>
  );
}

function InventoryExportCards({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  return (
    <div data-report-export-cards className="hidden space-y-3">
      {rows.map((row, index) => (
        <ExportPolicyShell key={`inventory-export-${row.policyId}`} row={row} tone="type" accent={exportToneByIndex(index)}>
          <PolicyPlanExportList row={row} />
          <ExportMetricStrip
            rows={[
              { label: '投保人', value: row.applicant },
              { label: '被保人', value: row.member },
              { label: '年交保费', value: row.annualPremiumText || formatMoney(row.annualPremium), highlight: true },
              { label: '保障/保额', value: row.coverageText, highlight: true },
            ]}
          />
        </ExportPolicyShell>
      ))}
    </div>
  );
}

function InsuredPolicyExportCards({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  return (
    <div data-report-export-cards className="hidden space-y-2">
      {rows.map((row, index) => (
        <ExportPolicyShell key={`insured-policy-export-${row.policyId}`} row={row} tone="type" accent={exportToneByIndex(index + 1)}>
          <PolicyPlanExportList row={row} />
          <ExportMetricStrip
            rows={[
              { label: '保费(元)', value: row.annualPremiumText || formatMoney(row.annualPremium), highlight: true },
              { label: '交费期', value: row.paymentPeriod },
              { label: '保障期', value: row.coveragePeriod },
              { label: '生效日期', value: row.effectiveDate },
              { label: '保额(元)', value: row.coverageText || formatMoney(row.coverage), highlight: true },
              { label: '身故受益人', value: row.beneficiary },
              { label: '期交总保费', value: row.totalPremiumText },
              { label: '现金价值', value: row.cashValueText || '-' },
            ]}
          />
        </ExportPolicyShell>
      ))}
    </div>
  );
}

function InventorySection({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  return (
    <Section title="家庭保单清单">
      {rows.length ? (
        <>
          <InventoryExportCards rows={rows} />
          <div data-report-export-table>
            <TableWrap>
              <table className="min-w-full border-separate border-spacing-0 text-left">
                <thead>
                  <tr>
                    <th className={`${thClassName} rounded-tl-[18px]`}>投保人</th>
                    <th className={thClassName}>被保人</th>
                    <th className={thClassName}>保单/产品</th>
                    <th className={thClassName}>类型</th>
                    <th className={`${thClassName} text-right`}>年交保费</th>
                    <th className={`${thClassName} rounded-tr-[18px]`}>保障/保额</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.policyId}>
                      <td className={tdClassName}>{emptyText(row.applicant)}</td>
                      <td className={tdClassName}>
                        <span className="block">{row.member}</span>
                        {row.participantReviewStatus === 'name_mismatch' ? (
                          <span className="mt-1 inline-flex rounded-full bg-[#FFF8EB] px-2 py-0.5 text-[11px] font-black text-[#9A4A16] ring-1 ring-[#F3D9B4]">姓名待核对</span>
                        ) : null}
                      </td>
                      <td className="min-w-[220px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 text-xs font-semibold text-[#334155]">
                        <PolicyPlanList row={row} />
                        <span className="mt-0.5 block text-[11px] font-medium text-slate-400">{emptyText(row.company)}</span>
                      </td>
                      <td className="min-w-[180px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 text-xs font-semibold text-[#334155]">
                        <PolicyPlanTypeList row={row} />
                      </td>
                      <td className={`${tdClassName} text-right`}>{row.annualPremiumText || formatMoney(row.annualPremium)}</td>
                      <td className={tdClassName}>{emptyText(row.coverageText)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        </>
      ) : (
        <EmptyState text="暂无家庭保单清单" />
      )}
    </Section>
  );
}

function InsuredPolicyDetailSection({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  const groups = new Map<string, { member: string; relationLabel?: string; policies: FamilyPolicyInventoryRow[] }>();
  rows.forEach((row) => {
    if (!groups.has(row.memberKey)) {
      groups.set(row.memberKey, {
        member: row.member,
        relationLabel: row.relationLabel,
        policies: [],
      });
    }
    groups.get(row.memberKey)?.policies.push(row);
  });

  return (
    <Section title="被保人保单明细">
      {groups.size ? (
        <div className="space-y-3">
          {Array.from(groups, ([memberKey, group]) => (
            <article key={memberKey} className={`${reportMutedSurfaceClassName} p-3`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-black text-[#102033]">{memberDisplayName(group)}</h3>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-[#0B72B9] ring-1 ring-[#D7E2EA]">
                  {group.policies.length}张保单
                </span>
              </div>
              <InsuredPolicyExportCards rows={group.policies} />
              <div data-report-export-table>
                <TableWrap>
                  <table className="min-w-full border-separate border-spacing-0 text-left">
                    <thead>
                      <tr>
                        <th className={`${thClassName} rounded-tl-[18px]`}>保险公司/保单号</th>
                        <th className={thClassName}>险种名称</th>
                        <th className={`${thClassName} text-right`}>保费(元)</th>
                        <th className={thClassName}>交费期</th>
                        <th className={thClassName}>保障期</th>
                        <th className={thClassName}>生效日期</th>
                        <th className={`${thClassName} text-right`}>保额(元)</th>
                        <th className={thClassName}>身故受益人</th>
                        <th className={`${thClassName} rounded-tr-[18px] text-right`}>期交总保费</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.policies.map((row) => (
                        <tr key={row.policyId}>
                          <td className="min-w-[170px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 text-xs font-semibold text-[#334155]">
                            <span className="block">{emptyText(row.company)}</span>
                            {row.policyNumber ? (
                              <span className="mt-0.5 block text-[11px] font-medium text-slate-400">{row.policyNumber}</span>
                            ) : null}
                          </td>
                          <td className="min-w-[220px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 text-xs font-semibold text-slate-800">
                            <PolicyPlanList row={row} />
                          </td>
                          <td className={`${tdClassName} text-right`}>{formatMoney(row.annualPremium)}</td>
                          <td className={tdClassName}>{emptyText(row.paymentPeriod)}</td>
                          <td className={tdClassName}>{emptyText(row.coveragePeriod)}</td>
                          <td className={tdClassName}>{emptyText(row.effectiveDate)}</td>
                          <td className={`${tdClassName} text-right`}>{formatMoney(row.coverage)}</td>
                          <td className={tdClassName}>{emptyText(row.beneficiary)}</td>
                          <td className={`${tdClassName} text-right`}>{emptyText(row.totalPremiumText)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState text="暂无被保人保单明细" />
      )}
    </Section>
  );
}

function ProtectionMemberTable({ member }: { member: FamilyMemberProtectionReport }) {
  return (
    <article className={`${reportMutedSurfaceClassName} p-3`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black text-[#102033]">{memberDisplayName(member)}</h3>
        {member.attentionItems.length ? (
          <span className="rounded-full bg-[#FFF8EB] px-2 py-1 text-[11px] font-bold text-[#9A4A16] ring-1 ring-[#F3D9B4]">
            待关注 {member.attentionItems.length}
          </span>
        ) : null}
      </div>
      {member.attentionItems.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {member.attentionItems.map((item) => (
            <span key={item} className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[#9A4A16] ring-1 ring-[#F3D9B4]">{item}</span>
          ))}
        </div>
      ) : null}
      <div data-report-export-cards className="space-y-2 md:hidden">
        {member.rows.map((row) => (
          <div key={row.key} className="rounded-[18px] border border-[#E1E8EF] bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 break-words text-sm font-black leading-5 text-[#176B94]">{row.label}</h4>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${statusClassName(row.status)}`}>
                {statusLabel(row.status)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] leading-5">
              <div className="rounded-xl bg-[#F8FAFC] px-2 py-1.5">
                <p className="font-bold text-[#72849A]">金额/比例</p>
                <p className="mt-0.5 break-words font-black text-slate-800">{emptyText(row.amountText)}</p>
              </div>
              <div className="rounded-xl bg-[#F8FAFC] px-2 py-1.5">
                <p className="font-bold text-[#72849A]">次数/方式</p>
                <p className="mt-0.5 break-words font-black text-slate-800">{emptyText(row.countText)}</p>
              </div>
            </div>
            <div className="mt-2 rounded-xl bg-[#F8FAFC] px-2 py-1.5">
              <p data-report-canvas-skip className="mb-0.5 text-[11px] font-bold text-[#72849A]">条件/说明</p>
              <ConditionSummary text={row.conditionText} />
            </div>
            <div data-report-canvas-skip className="mt-3 border-t border-[#E1E8EF] pt-2">
              <p className="text-[11px] font-bold leading-4 text-[#72849A]">来源保单</p>
              <p className="mt-1 break-words text-[11px] font-medium leading-5 text-slate-500">
                {truncateText(sourcePolicyText(row), 42)}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div data-report-canvas-skip data-report-export-table className="hidden md:block">
        <TableWrap>
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className={`${thClassName} rounded-tl-[18px]`}>责任颗粒度</th>
              <th className={thClassName}>金额/比例</th>
              <th className={thClassName}>次数/方式</th>
              <th className={thClassName}>状态</th>
              <th className={thClassName}>条件/说明</th>
              <th className={`${thClassName} rounded-tr-[18px]`}>来源保单</th>
            </tr>
          </thead>
          <tbody>
            {member.rows.map((row) => (
              <tr key={row.key}>
                <td className={tdClassName}>{row.label}</td>
                <td className={tdClassName}>{emptyText(row.amountText)}</td>
                <td className={tdClassName}>{emptyText(row.countText)}</td>
                <td className={tdClassName}>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${statusClassName(row.status)}`}>
                    {statusLabel(row.status)}
                  </span>
                </td>
                <td className="max-w-[300px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 align-top text-xs font-medium text-slate-500">
                  <ConditionSummary text={row.conditionText} />
                </td>
                <td className="max-w-[240px] border-b border-[#E6EEF5] bg-white px-3 py-2.5 align-top text-xs font-medium leading-5 text-slate-500">
                  {truncateText(sourcePolicyText(row), 56)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableWrap>
      </div>
    </article>
  );
}

function ProtectionSection({ title, members }: { title: string; members: FamilyMemberProtectionReport[] }) {
  return (
    <Section title={title}>
      {members.length ? (
        <div className="space-y-3">
          {members.map((member) => <ProtectionMemberTable key={reportMemberKey(member)} member={member} />)}
        </div>
      ) : (
        <EmptyState text={`暂无${title}数据`} />
      )}
    </Section>
  );
}

type CashValueTrendPoint = {
  xValue: number;
  xLabel: string;
  cashValue: number;
  policyYear?: number;
};

type CashValueTrendSeries = {
  id: string;
  kind: 'policy' | 'aggregate';
  label: string;
  meta: string;
  color: string;
  strokeDasharray?: string;
  strokeWidth?: number;
  rows: CashValueTrendPoint[];
};

const cashValueTrendColors = ['#1D4ED8', '#BE123C', '#7C3AED', '#0E7490', '#B45309', '#A21CAF', '#4338CA', '#64748B'];

type CashValueAggregateTrendKey = keyof Pick<FamilyWealthAggregateRow, 'payoutInflow' | 'cumulativePayoutInflow'>;

const cashValueAggregateTrendSeriesConfig: Array<{
  key: CashValueAggregateTrendKey;
  label: string;
  meta: string;
  color: string;
  strokeDasharray?: string;
  strokeWidth?: number;
}> = [
  { key: 'payoutInflow', label: '现金流', meta: '当年领取现金流', color: '#EA580C', strokeWidth: 1.2 },
  { key: 'cumulativePayoutInflow', label: '累计现金流', meta: '累计领取现金流', color: '#0F766E', strokeDasharray: '6 5', strokeWidth: 1.2 },
];

function cashValueChartXValue(row: FamilyWealthPolicyReport['cashValueRows'][number]) {
  return typeof row.cashValueTime === 'number' && Number.isFinite(row.cashValueTime) ? row.cashValueTime : null;
}

function cashValueChartXLabel(row: FamilyWealthPolicyReport['cashValueRows'][number]) {
  return row.cashValueDateLabel || row.cashValueDate || `第${row.policyYear}年末`;
}

function formatCashValueTimeTick(value: number) {
  if (!Number.isFinite(value)) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function buildPolicyCashValueTrendSeries(report: FamilyReport): CashValueTrendSeries[] {
  return report.wealth.memberReports
    .flatMap((member) => member.policies.map((policy) => ({ member: memberDisplayName(member), memberKey: reportMemberKey(member), policy })))
    .flatMap(({ member, memberKey, policy }, index) => {
      const rows = policy.cashValueRows
        .filter((row) => Number.isFinite(row.cashValue) && cashValueChartXValue(row) !== null)
        .map((row) => ({
          ...row,
          xValue: cashValueChartXValue(row) as number,
          xLabel: cashValueChartXLabel(row),
        }))
        .sort((a, b) => a.xValue - b.xValue);
      if (!rows.length) return [];

      return [{
        id: `${policy.policyId}-${memberKey}`,
        kind: 'policy' as const,
        label: compactText(policy.productName) || '未命名产品',
        meta: [member, compactText(policy.company)].filter(Boolean).join(' · '),
        color: cashValueTrendColors[index % cashValueTrendColors.length],
        rows,
      }];
    });
}

function aggregateCashValueChartXValue(row: FamilyWealthAggregateRow) {
  return Date.UTC(row.year, 11, 31);
}

function buildAggregateCashValueTrendSeries(rows: FamilyWealthAggregateRow[]): CashValueTrendSeries[] {
  const sortedRows = [...rows]
    .filter((row) => Number.isFinite(row.year))
    .sort((a, b) => a.year - b.year);

  return cashValueAggregateTrendSeriesConfig.map((series) => ({
    id: `aggregate-${series.key}`,
    kind: 'aggregate' as const,
    label: series.label,
    meta: series.meta,
    color: series.color,
    strokeDasharray: series.strokeDasharray,
    strokeWidth: series.strokeWidth,
    rows: sortedRows.map((row) => ({
      xValue: aggregateCashValueChartXValue(row),
      xLabel: `${row.year}年`,
      cashValue: Math.max(0, Number(row[series.key] || 0)),
      policyYear: row.year,
    })),
  })).filter((series) => series.rows.length);
}

function buildCashValueTrendSeries(report: FamilyReport): CashValueTrendSeries[] {
  return [
    ...buildPolicyCashValueTrendSeries(report),
    ...buildAggregateCashValueTrendSeries(report.wealth.aggregateRows),
  ];
}

function niceCashValueCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const paddedValue = value * 1.08;
  const magnitude = 10 ** Math.floor(Math.log10(paddedValue));
  const scaled = paddedValue / magnitude;
  const factor = [1, 1.2, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10].find((step) => scaled <= step) ?? 10;
  return factor * magnitude;
}

function uniqueTicks(values: number[]) {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
}

function maxCashValue(points: CashValueTrendPoint[]) {
  if (!points.length) return 0;
  return Math.max(0, ...points.map((point) => Number(point.cashValue || 0)).filter((value) => Number.isFinite(value)));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cashValuePointYear(point: CashValueTrendPoint) {
  return new Date(point.xValue).getUTCFullYear();
}

function CashValueTrendChart({ report }: { report: FamilyReport }) {
  const series = buildCashValueTrendSeries(report);
  const policySeries = series.filter((item) => item.kind === 'policy');
  const [hiddenCashValueSeriesIds, setHiddenCashValueSeriesIds] = useState<Set<string>>(() => new Set());
  const [hoverCashValuePoint, setHoverCashValuePoint] = useState<{ x: number; y: number } | null>(null);
  if (!series.length) return <EmptyState text="暂无现金价值趋势数据" />;

  const activeSeries = series.filter((item) => !hiddenCashValueSeriesIds.has(item.id));
  const width = 760;
  const height = 310;
  const paddingLeft = 74;
  const paddingRight = 56;
  const paddingTop = 30;
  const paddingBottom = 48;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const allPoints = series.flatMap((item) => item.rows);
  const activePoints = activeSeries.flatMap((item) => item.rows);
  const activePolicyPoints = activeSeries.filter((item) => item.kind === 'policy').flatMap((item) => item.rows);
  const activeAggregatePoints = activeSeries.filter((item) => item.kind === 'aggregate').flatMap((item) => item.rows);
  const visibleScalePoints = activePoints.length ? activePoints : allPoints;
  const policyScalePoints = activePolicyPoints.length ? activePolicyPoints : visibleScalePoints;
  const policyYMax = niceCashValueCeiling(maxCashValue(policyScalePoints));
  const aggregateYMax = niceCashValueCeiling(maxCashValue(activeAggregatePoints));
  const useCashflowAxis = activePolicyPoints.length > 0
    && activeAggregatePoints.length > 0
    && aggregateYMax > policyYMax * 1.45;
  const primaryYMax = useCashflowAxis ? policyYMax : niceCashValueCeiling(maxCashValue(visibleScalePoints));
  const secondaryYMax = Math.max(1, aggregateYMax);
  const xMin = Math.min(...allPoints.map((point) => point.xValue));
  const xMax = Math.max(...allPoints.map((point) => point.xValue));
  const xRange = Math.max(1, xMax - xMin);
  const xFor = (value: number) => paddingLeft + ((value - xMin) / xRange) * plotWidth;
  const primaryYFor = (value: number) => paddingTop + plotHeight - (Math.max(0, value) / primaryYMax) * plotHeight;
  const secondaryYFor = (value: number) => paddingTop + plotHeight - (Math.max(0, value) / secondaryYMax) * plotHeight;
  const yForSeries = (item: CashValueTrendSeries, value: number) => (
    useCashflowAxis && item.kind === 'aggregate' ? secondaryYFor(value) : primaryYFor(value)
  );
  const yTicks = [primaryYMax, primaryYMax / 2, 0];
  const secondaryYTicks = [secondaryYMax, secondaryYMax / 2, 0];
  const xTicks = uniqueTicks([xMin, Math.round((xMin + xMax) / 2), xMax]);
  const seriesRanges = series.map((item) => ({
    first: item.rows[0],
    last: item.rows[item.rows.length - 1],
  }));
  const hoverXValue = hoverCashValuePoint
    ? xMin + ((hoverCashValuePoint.x - paddingLeft) / plotWidth) * xRange
    : null;
  const hoverPrimaryYValue = hoverCashValuePoint
    ? Math.max(0, ((paddingTop + plotHeight - hoverCashValuePoint.y) / plotHeight) * primaryYMax)
    : 0;
  const hoverSecondaryYValue = hoverCashValuePoint
    ? Math.max(0, ((paddingTop + plotHeight - hoverCashValuePoint.y) / plotHeight) * secondaryYMax)
    : 0;
  const hoverYears = uniqueTicks(activePoints.map(cashValuePointYear));
  const hoverYear = hoverXValue !== null && hoverYears.length
    ? hoverYears.reduce((nearest, year) => {
      const currentDistance = Math.abs(Date.UTC(year, 6, 1) - hoverXValue);
      const nearestDistance = Math.abs(Date.UTC(nearest, 6, 1) - hoverXValue);
      return currentDistance < nearestDistance ? year : nearest;
    }, hoverYears[0])
    : null;
  const hoverItems = hoverYear === null || hoverXValue === null
    ? []
    : activeSeries
      .map((item) => {
        const sameYearRows = item.rows.filter((point) => cashValuePointYear(point) === hoverYear);
        if (!sameYearRows.length) return null;
        const point = sameYearRows.reduce((nearest, row) => (
          Math.abs(row.xValue - hoverXValue) < Math.abs(nearest.xValue - hoverXValue) ? row : nearest
        ), sameYearRows[0]);
        return {
          id: item.id,
          label: item.label,
          color: item.color,
          value: point.cashValue,
          xLabel: point.xLabel,
          x: xFor(point.xValue),
          y: yForSeries(item, point.cashValue),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const hoverTooltipWidth = 276;
  const hoverTooltipHeight = 58 + hoverItems.length * 18;
  const hoverTooltipX = hoverCashValuePoint
    ? clampNumber(
      hoverCashValuePoint.x > paddingLeft + plotWidth - hoverTooltipWidth - 12
        ? hoverCashValuePoint.x - hoverTooltipWidth - 12
        : hoverCashValuePoint.x + 12,
      paddingLeft + 8,
      width - paddingRight - hoverTooltipWidth - 8,
    )
    : 0;
  const hoverTooltipY = hoverCashValuePoint
    ? clampNumber(hoverCashValuePoint.y - 34, paddingTop + 8, paddingTop + plotHeight - hoverTooltipHeight - 8)
    : 0;

  const updateHoverCashValuePoint = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const nextY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * height;
    setHoverCashValuePoint({
      x: clampNumber(nextX, paddingLeft, width - paddingRight),
      y: clampNumber(nextY, paddingTop, paddingTop + plotHeight),
    });
  };

  return (
    <article className="overflow-hidden rounded-[22px] border border-[#D7E2EA] bg-white p-4 shadow-[0_18px_45px_-34px_rgba(15,23,42,0.36)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase text-[#0B72B9]">Cash Value Timeline</p>
          <h3 className="mt-1 text-base font-black text-[#102033]">现金价值趋势</h3>
        </div>
        <div className="rounded-[16px] bg-blue-50 px-3 py-2 text-right ring-1 ring-[#D9E6F4]">
          <p className="text-[11px] font-bold text-[#64748B]">产品数</p>
          <p className="text-sm font-black text-[#0B72B9]">{policySeries.length}款</p>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg
          className="h-auto min-w-[680px] w-full"
          data-cash-value-trend-chart
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="现金价值与现金流趋势对比图"
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            updateHoverCashValuePoint(event);
          }}
          onPointerMove={updateHoverCashValuePoint}
          onPointerLeave={() => setHoverCashValuePoint(null)}
          onPointerCancel={() => setHoverCashValuePoint(null)}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        >
          <rect x="0" y="0" width={width} height={height} rx="18" fill="#F8FAFC" />
          <rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} rx="10" fill="#FFFFFF" />
          {yTicks.map((tick) => {
            const y = primaryYFor(tick);
            return (
              <g key={`y-${tick}`}>
                <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#DDE7F1" strokeDasharray="5 6" />
                <text x={paddingLeft - 10} y={y + 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#64748B">
                  {formatCashValueAxis(tick)}
                </text>
              </g>
            );
          })}
          {useCashflowAxis ? secondaryYTicks.map((tick) => {
            const y = secondaryYFor(tick);
            return (
              <g key={`cashflow-y-${tick}`}>
                <text x={width - paddingRight + 10} y={y + 4} textAnchor="start" fontSize="10" fontWeight="800" fill="#0F766E">
                  {formatCashValueAxis(tick)}
                </text>
              </g>
            );
          }) : null}
          {xTicks.map((tick) => {
            const x = xFor(tick);
            return (
              <g key={`x-${tick}`}>
                <line x1={x} x2={x} y1={paddingTop} y2={paddingTop + plotHeight} stroke="#EEF3F8" />
                <text x={x} y={height - 19} textAnchor="middle" fontSize="11" fontWeight="700" fill="#64748B">
                  {formatCashValueTimeTick(tick)}
                </text>
              </g>
            );
          })}
          <line x1={paddingLeft} x2={paddingLeft} y1={paddingTop} y2={paddingTop + plotHeight} stroke="#94A3B8" strokeWidth="1.2" />
          {useCashflowAxis ? <line x1={width - paddingRight} x2={width - paddingRight} y1={paddingTop} y2={paddingTop + plotHeight} stroke="#99D6CC" strokeWidth="1" /> : null}
          <line x1={paddingLeft} x2={width - paddingRight} y1={paddingTop + plotHeight} y2={paddingTop + plotHeight} stroke="#94A3B8" strokeWidth="1.2" />
          <text x={paddingLeft + plotWidth / 2} y={height - 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="#334155">时间</text>
          <text x="18" y={paddingTop + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 18 ${paddingTop + plotHeight / 2})`} fontSize="12" fontWeight="800" fill="#334155">
            {useCashflowAxis ? '保单现价' : '金额'}
          </text>
          {useCashflowAxis ? (
            <text x={width - 14} y={paddingTop + plotHeight / 2} textAnchor="middle" transform={`rotate(90 ${width - 14} ${paddingTop + plotHeight / 2})`} fontSize="11" fontWeight="900" fill="#0F766E">
              现金流
            </text>
          ) : null}

          {activeSeries.map((item) => {
            const path = item.rows
              .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point.xValue).toFixed(1)} ${yForSeries(item, point.cashValue).toFixed(1)}`)
              .join(' ');
            const firstPoint = item.rows[0];
            const lastPoint = item.rows[item.rows.length - 1];
            return (
              <g key={item.id}>
                <title>{`${item.label} ${firstPoint?.xLabel || ''}-${lastPoint?.xLabel || ''}: ${formatCashValue(lastPoint?.cashValue ?? 0)}元`}</title>
                <path d={path} fill="none" stroke={item.color} strokeWidth={item.strokeWidth ?? 1.1} strokeDasharray={item.strokeDasharray} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}
          {hoverCashValuePoint && hoverYear !== null ? (
            <g data-cash-value-hover-tooltip>
              <line
                data-cash-value-hover-x
                x1={hoverCashValuePoint.x}
                x2={hoverCashValuePoint.x}
                y1={paddingTop}
                y2={paddingTop + plotHeight}
                stroke="#0F172A"
                strokeOpacity="0.28"
                strokeDasharray="4 4"
              />
              <line
                data-cash-value-hover-y
                x1={paddingLeft}
                x2={width - paddingRight}
                y1={hoverCashValuePoint.y}
                y2={hoverCashValuePoint.y}
                stroke="#0F172A"
                strokeOpacity="0.2"
                strokeDasharray="4 4"
              />
              <rect x={hoverCashValuePoint.x - 24} y={paddingTop + plotHeight + 7} width="48" height="18" rx="9" fill="#0F172A" opacity="0.9" />
              <text x={hoverCashValuePoint.x} y={paddingTop + plotHeight + 20} textAnchor="middle" fontSize="10" fontWeight="800" fill="#FFFFFF">
                {hoverYear}年
              </text>
              <rect x={paddingLeft - 66} y={hoverCashValuePoint.y - 9} width="58" height="18" rx="9" fill="#0F172A" opacity="0.9" />
              <text x={paddingLeft - 37} y={hoverCashValuePoint.y + 4} textAnchor="middle" fontSize="10" fontWeight="800" fill="#FFFFFF">
                {formatCashValueAxis(hoverPrimaryYValue)}
              </text>
              {hoverItems.map((entry) => (
                <rect key={`hover-marker-${entry.id}`} x={entry.x - 2.5} y={entry.y - 2.5} width="5" height="5" rx="1.5" fill={entry.color} stroke="#FFFFFF" strokeWidth="1" />
              ))}
              <rect x={hoverTooltipX} y={hoverTooltipY} width={hoverTooltipWidth} height={hoverTooltipHeight} rx="14" fill="#FFFFFF" stroke="#CBD7E1" />
              <text x={hoverTooltipX + 12} y={hoverTooltipY + 18} fontSize="11" fontWeight="900" fill="#0F172A">
                {hoverYear}年 · 坐标 {formatCashValueTimeTick(hoverXValue ?? 0)} / {formatCashValueAxis(hoverPrimaryYValue)}
              </text>
              {useCashflowAxis ? (
                <text x={hoverTooltipX + hoverTooltipWidth - 12} y={hoverTooltipY + 34} textAnchor="end" fontSize="10" fontWeight="800" fill="#0F766E">
                  右轴 {formatCashValueAxis(hoverSecondaryYValue)}
                </text>
              ) : null}
              <text x={hoverTooltipX + 12} y={hoverTooltipY + 34} fontSize="10" fontWeight="700" fill="#64748B">
                当前年份对应值
              </text>
              {hoverItems.map((entry, index) => {
                const rowY = hoverTooltipY + 53 + index * 18;
                return (
                  <g key={`hover-value-${entry.id}`}>
                    <rect x={hoverTooltipX + 12} y={rowY - 7} width="7" height="7" rx="1.5" fill={entry.color} />
                    <text x={hoverTooltipX + 26} y={rowY} fontSize="10.5" fontWeight="800" fill="#334155">
                      {truncateText(entry.label, 15)}
                    </text>
                    <text x={hoverTooltipX + hoverTooltipWidth - 12} y={rowY} textAnchor="end" fontSize="10.5" fontWeight="900" fill="#0F172A">
                      {formatCashValue(entry.value)}
                    </text>
                  </g>
                );
              })}
            </g>
          ) : null}
        </svg>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {series.map((item, index) => {
          const hidden = hiddenCashValueSeriesIds.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              className={`min-w-0 rounded-[16px] border px-3 py-2 text-left transition ${
                hidden
                  ? 'border-[#E1E8EF] bg-[#F8FAFC] opacity-45'
                  : 'border-[#D7E2EA] bg-[#F8FAFC] hover:border-[#A7C7E8] active:bg-blue-50'
              }`}
              aria-pressed={!hidden}
              aria-label={`${hidden ? '显示' : '隐藏'}${item.label}折线`}
              title={`${hidden ? '显示' : '隐藏'}${item.label}折线`}
              onClick={() => {
                setHiddenCashValueSeriesIds((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) {
                    next.delete(item.id);
                  } else {
                    next.add(item.id);
                  }
                  return next;
                });
              }}
            >
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: hidden ? '#CBD5E1' : item.color }} />
                <p className={`min-w-0 truncate text-xs font-black ${hidden ? 'text-[#64748B]' : 'text-[#0F172A]'}`}>{truncateText(item.label, 24)}</p>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-bold text-[#64748B]">
                <span className="min-w-0 truncate">{item.meta || `产品${index + 1}`}</span>
                <span className={`shrink-0 ${hidden ? 'text-[#94A3B8]' : 'text-[#0B72B9]'}`}>
                  {seriesRanges[index]?.first.xLabel}-{seriesRanges[index]?.last.xLabel} · {formatCashValueAxis(seriesRanges[index]?.last.cashValue ?? 0)}
                </span>
              </div>
              {item.kind === 'policy' && (seriesRanges[index]?.first.policyYear ?? 0) > 1 ? (
                <p className="mt-1 text-[10px] font-bold text-amber-600">
                  缺第1-{(seriesRanges[index].first.policyYear ?? 1) - 1}年
                </p>
              ) : null}
            </button>
          );
        })}
      </div>
    </article>
  );
}

function PolicyAnnualCashflowTable({ policy }: { policy: FamilyWealthPolicyReport }) {
  const rows = policy.annualCashflowRows;
  if (!rows.length) return <EmptyState text="暂无现金流明细" />;
  const hasCashValueReference = rows.some((row) => row.cashValue != null);

  const columnSize = 14;
  const columns: FamilyWealthPolicyReport['annualCashflowRows'][] = [];
  for (let index = 0; index < rows.length; index += columnSize) {
    columns.push(rows.slice(index, index + columnSize));
  }

  return (
    <div>
      <AnnualCashflowExportList policy={policy} />
      <div data-report-export-table>
        <TableWrap>
          <div className="flex min-w-max gap-3">
            {columns.map((column, columnIndex) => (
              <table key={`${policy.policyId}-${columnIndex}`} className="border-separate border-spacing-0 text-left">
                <thead>
                  <tr>
                    <th className={`${compactThClassName} rounded-tl-[14px]`}>年份</th>
                    <th className={compactThClassName}>领取金额</th>
                    <th className={compactThClassName}>累计领取</th>
                    <th className={`${compactThClassName} rounded-tr-[14px]`}>现金价值参考</th>
                  </tr>
                </thead>
                <tbody>
                  {column.map((row) => (
                    <tr key={`${policy.policyId}-${row.year}`} className={row.isContractTerminatingPayout ? 'bg-orange-50' : undefined}>
                      <td className={`${compactTdClassName} font-black text-[#425570]`}>{row.year}/{row.age === null ? '-' : row.age}</td>
                      <td className={`${compactTdClassName} text-right`}>
                        {row.amount > 0 ? (
                          <span className={`inline-block rounded px-1 text-[11px] font-black ${row.isContractTerminatingPayout ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}>
                            {formatMoney(row.amount)}
                          </span>
                        ) : '—'}
                      </td>
                      <td className={`${compactTdClassName} text-right text-[#5E7290]`}>
                        {row.amount > 0 ? formatMoney(row.cumulative) : '—'}
                      </td>
                      <td className={`${compactTdClassName} text-right text-[#0B72B9]`}>
                        {row.cashValue != null ? formatMoney(row.cashValue) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        </TableWrap>
      </div>
      {hasCashValueReference ? (
        <p className="mt-2 rounded-[14px] border border-[#D7E2EA] bg-[#F8FBFF] px-3 py-2 text-[11px] font-semibold leading-5 text-[#5E7290]">
          现金价值不等同于当年可直接领取金额；与领取金额同年出现时不代表可叠加领取。合同终止型给付发生后，现金价值不再保留。
        </p>
      ) : null}
    </div>
  );
}

function AnnualCashflowExportList({ policy }: { policy: FamilyWealthPolicyReport }) {
  const informativeRows = policy.annualCashflowRows.filter((row) => (
    row.amount > 0 || row.cashValue != null || row.liabilities.length > 0 || row.isContractTerminatingPayout
  ));
  const rows = informativeRows.length ? informativeRows : policy.annualCashflowRows.slice(0, 1);

  return (
    <div data-report-export-cards className="hidden overflow-hidden rounded-lg border border-blue-100 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-blue-100 bg-[#F0F8FF] px-3 py-2">
        <p className="text-xs font-black text-[#102033]">现金流年度摘要</p>
        <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-black text-[#0B72B9] ring-1 ring-blue-100">
          展示{rows.length}个关键年份
        </span>
      </div>
      <div className="space-y-2 p-3">
        {rows.map((row, index) => {
          const yearTone = row.isContractTerminatingPayout ? exportToneClassNames.amber : exportToneClassNames[exportToneByIndex(index)];
          return (
          <div key={`${policy.policyId}-export-cashflow-${row.year}`} className={`grid grid-cols-[68px_minmax(0,1fr)_minmax(0,1fr)] gap-2 rounded-lg p-2 text-[11px] leading-4 ring-1 ${yearTone.soft}`}>
            <div className="min-w-0">
              <p className={`font-black ${yearTone.text}`}>{row.year}</p>
              <p className="mt-0.5 font-semibold text-[#72849A]">{row.age === null ? '年龄 -' : `${row.age}岁`}</p>
            </div>
            <div className="min-w-0">
              <p className="font-bold text-[#72849A]">领取金额</p>
              <p className={`mt-0.5 break-words font-black ${row.amount > 0 ? yearTone.text : 'text-[#94A3B8]'}`}>{row.amount > 0 ? formatMoney(row.amount) : '-'}</p>
              {row.liabilities.length ? <p className="mt-0.5 break-words font-semibold text-[#64748B]">{row.liabilities.slice(0, 2).join('、')}</p> : null}
            </div>
            <div className="min-w-0 text-right">
              <p className="font-bold text-[#72849A]">现金价值参考</p>
              <p className="mt-0.5 break-words font-black text-emerald-700">{row.cashValue != null ? formatMoney(row.cashValue) : '-'}</p>
              {row.amount > 0 ? <p className="mt-0.5 font-semibold text-[#64748B]">累计 {formatMoney(row.cumulative)}</p> : null}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function WealthPolicyCard({ policy }: { policy: FamilyWealthPolicyReport }) {
  const uncertaintyLabels = policy.uncertaintyItems.map((item) => item.label).join('、');
  const excludedStatisticRowsCount = policy.excludedCashflowRows.length + policy.excludedCashValueRows.length;

  return (
    <article className="rounded-[20px] border border-[#E1E8EF] bg-white p-3 shadow-[0_12px_28px_-26px_rgba(15,23,42,0.24)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h4 className="min-w-0 break-words text-sm font-black text-[#102033]">{emptyText(policy.productName)}</h4>
            {policy.hasUncertainWealthFactors ? (
              <span className="shrink-0 rounded-full bg-[#FFF8EB] px-1.5 py-0.5 text-[10px] font-black text-[#A6531B] ring-1 ring-[#F3D9B4]">
                不确定未计入
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs font-medium text-[#72849A]">{emptyText(policy.company)} · 年交 {formatMoneyWithUnit(policy.annualPremium)}</p>
        </div>
        {policy.attentionItems.length ? (
          <span className="rounded-full bg-[#FFF8EB] px-2 py-1 text-[11px] font-bold text-[#9A4A16] ring-1 ring-[#F3D9B4]">
            {policy.attentionItems.length}项待关注
          </span>
        ) : null}
      </div>

      {policy.keyPoints.length ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          {policy.keyPoints.map((point) => (
            <div key={`${point.label}-${point.value}`} className="rounded-[16px] border border-[#E1E8EF] bg-[#F8FAFC] px-3 py-2">
              <p className="text-[11px] font-bold text-[#72849A]">{point.label}</p>
              <p className="mt-0.5 text-xs font-black text-slate-900">{point.value} · {formatMoneyWithUnit(point.amount)}</p>
              {point.note ? <p className="mt-1 text-[10px] font-semibold leading-4 text-[#9A4A16]">{point.note}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h5 className="text-xs font-black text-slate-700">个人现金流明细</h5>
            {policy.hasUncertainWealthFactors ? (
              <p className="mt-0.5 break-words text-[11px] font-semibold leading-4 text-[#72849A]">
                已排除{uncertaintyLabels}不确定金额{excludedStatisticRowsCount > 0 ? ` ${excludedStatisticRowsCount}条` : ''}
              </p>
            ) : null}
          </div>
          <span className="text-[11px] font-bold text-[#7890AA]">(单位:元)</span>
        </div>
        <PolicyAnnualCashflowTable policy={policy} />
      </div>
    </article>
  );
}

export function FamilyReportPage({
  report,
  reportStale = false,
  planningProfile,
  policyAnalysisReport,
  policyAnalysisLoading = false,
  onPlanningProfileChange,
  onBack,
  onExport,
  onRegenerate,
  onGeneratePolicyAnalysisReport,
  regenerating = false,
  statusMessage = '',
  readOnly = false,
}: FamilyReportPageProps) {
  const activeReportRef = useRef<HTMLDivElement | null>(null);
  const [activeReportTab, setActiveReportTab] = useState<'analysis' | 'policyReport'>('analysis');
  const exportTitle = activeReportTab === 'policyReport' ? '家庭保单分析报告' : '家庭保障分析报告';
  const pageTitle = activeReportTab === 'policyReport' ? '家庭保单分析报告' : '家庭保障分析报告';
  const attentionItems = getFamilyAttentionItems(report);
  const reportWithOptionalGaps = report as FamilyReportWithOptionalGaps;
  const hasPolicyAnalysisContent = Boolean(policyAnalysisReport?.content?.trim());
  const policyAnalysisFailed = policyAnalysisReport?.status === 'failed' || Boolean(policyAnalysisReport?.error);

  return (
    <div className="family-report-shell min-h-screen bg-[#EEF3F7] pb-10 text-[#102033]">
      <header className="no-print fixed inset-x-0 top-0 z-30 border-b border-[#DDE6EE] bg-white/95 backdrop-blur">
        <div className="family-report-content grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-[#42566B] active:bg-[#EEF3F7]"
            aria-label="返回"
            title="返回"
          >
            <ChevronLeft size={24} />
          </button>
          <div className="min-w-0 text-center">
            <h1 className="family-report-heading truncate text-lg font-black text-[#102033]">{pageTitle}</h1>
            <p className="family-report-kicker mt-0.5 hidden text-[11px] text-[#72849A] sm:block">Family Policy Dossier</p>
          </div>
          <div className="flex items-center justify-end gap-2">
            {onRegenerate ? (
              <button
                type="button"
                onClick={() => void onRegenerate()}
                disabled={regenerating}
                className="flex h-10 items-center justify-center gap-1.5 rounded-full bg-emerald-50 px-3 text-xs font-black text-emerald-700 active:bg-emerald-100 disabled:opacity-60"
                aria-label="重新生成家庭保障分析报告"
                aria-busy={regenerating}
                title="重新生成家庭保障分析报告"
              >
                <RotateCcw className={regenerating ? 'h-[18px] w-[18px] animate-spin' : 'h-[18px] w-[18px]'} />
                <span>{regenerating ? '生成中' : '重算'}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void onExport(activeReportRef.current, exportTitle)}
              className="flex h-10 items-center justify-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-black text-[#0B72B9] active:bg-blue-100"
              aria-label="下载报告图片"
              title="下载报告图片"
            >
              <Download size={18} />
              <span>图片</span>
            </button>
          </div>
        </div>
      </header>

      <div className="no-print fixed inset-x-0 top-[65px] z-20 border-b border-[#DDE6EE] bg-[#EEF3F7]/95 py-3 backdrop-blur">
        <div className="family-report-content grid grid-cols-2 gap-2 rounded-[18px] border border-[#DDE6EE] bg-white p-1 shadow-sm shadow-slate-950/5">
          <button
            type="button"
            onClick={() => setActiveReportTab('analysis')}
            className={`min-h-10 rounded-[14px] px-3 text-sm font-black transition ${
              activeReportTab === 'analysis'
                ? 'bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-500 text-white shadow-sm shadow-sky-900/20'
                : 'text-[#42566B] active:bg-[#EEF3F7]'
            }`}
          >
            保障分析
          </button>
          <button
            type="button"
            onClick={() => setActiveReportTab('policyReport')}
            className={`min-h-10 rounded-[14px] px-3 text-sm font-black transition ${
              activeReportTab === 'policyReport'
                ? 'bg-gradient-to-r from-blue-600 via-sky-500 to-cyan-500 text-white shadow-sm shadow-sky-900/20'
                : 'text-[#42566B] active:bg-[#EEF3F7]'
            }`}
          >
            保单分析报告
          </button>
        </div>
      </div>

      <div className="no-print h-[149px]" aria-hidden="true" />

      <main className="py-4 md:py-5">
        {statusMessage ? (
          <div className="family-report-content mb-4">
            <div className="rounded-[18px] border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-bold leading-6 text-blue-800" role="status" aria-live="polite">
              {statusMessage}
            </div>
          </div>
        ) : null}
        {activeReportTab === 'analysis' ? (
          <div ref={activeReportRef} className="family-report-content print-policy-report space-y-4 md:space-y-5">
            {reportStale ? (
              <div className="rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-6 text-amber-800">
                当前展示的是旧版家庭保障分析报告，资料已更新，建议点击右上角重算。
              </div>
            ) : null}
            <ReportHero report={report} attentionItems={attentionItems} />
            <FamilyPlanningProfilePanel profile={planningProfile} onChange={onPlanningProfileChange} readOnly={readOnly} />
            <FamilyRadarSection report={report} />
            <AttentionSection attentionItems={attentionItems} />
            <OptionalResponsibilityGapSection gaps={reportWithOptionalGaps.optionalResponsibilityGaps} />
            <PendingVerificationSection items={reportWithOptionalGaps.pendingVerificationItems} />
            <InventorySection rows={report.policyInventory.rows} />
            <MemberRadarSection report={report} />
            <InsuredPolicyDetailSection rows={report.policyInventory.rows} />
            <ProtectionSection title="重疾分析" members={report.criticalIllness.members} />
            <ProtectionSection title="意外分析" members={report.accident.members} />
            <WealthSection report={report} />
          </div>
        ) : (
          <div ref={activeReportRef} className="family-report-content print-policy-report">
            <FamilyPolicyAnalysisReportSection
              report={policyAnalysisReport}
              loading={policyAnalysisLoading}
              onGenerate={onGeneratePolicyAnalysisReport}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function FamilyPolicyAnalysisReportSection({
  report,
  loading,
  onGenerate,
}: {
  report?: FamilyPolicyAnalysisReport | null;
  loading: boolean;
  onGenerate?: () => void | Promise<void>;
}) {
  const hasContent = Boolean(report?.content?.trim());
  const failed = report?.status === 'failed' || Boolean(report?.error);
  const stale = Boolean(report?.stale);
  const statusText = loading ? '生成中' : failed ? '生成失败' : stale && hasContent ? '旧版' : hasContent ? '已生成' : '待生成';

  return (
    <section className={`${reportSurfaceClassName} overflow-hidden bg-[#F8FBFE]`}>
      <div className="border-b border-[#BDE2F5] bg-gradient-to-br from-blue-600 via-sky-500 to-cyan-500 px-4 py-4 text-white md:px-6 md:py-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-3">
              <span className="h-8 w-1.5 shrink-0 rounded-full bg-white/75" aria-hidden="true" />
              <div className="min-w-0">
                <p className="family-report-kicker text-[11px] uppercase text-white/72">Policy Analysis Report</p>
                <h2 className="family-report-heading min-w-0 break-words text-xl font-black leading-tight text-white">家庭保单分析报告</h2>
              </div>
            </div>
            <p className="mt-3 max-w-3xl text-sm font-semibold leading-6 text-white/78">
              综合家庭成员、现有保单、责任结构和保障缺口生成，适合给客户单独阅读。
            </p>
          </div>
          {onGenerate ? (
            <button
              type="button"
              onClick={() => void onGenerate()}
              disabled={loading}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-white px-4 text-sm font-black text-[#0B72B9] shadow-[0_16px_32px_-20px_rgba(15,23,42,0.45)] active:bg-blue-50 disabled:opacity-60"
              aria-busy={loading}
            >
              <FileText className={loading ? 'h-[18px] w-[18px] animate-pulse' : 'h-[18px] w-[18px]'} />
              <span>{loading ? '生成中' : hasContent ? '重新生成' : '生成报告'}</span>
            </button>
          ) : null}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
            <p className="text-[11px] font-bold text-white/68">报告状态</p>
            <p className="mt-1 text-sm font-black text-white">{statusText}</p>
          </div>
          <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
            <p className="text-[11px] font-bold text-white/68">阅读对象</p>
            <p className="mt-1 text-sm font-black text-white">客户单独阅读</p>
          </div>
          <div className="rounded-[16px] border border-white/25 bg-white/12 px-3 py-2.5">
            <p className="text-[11px] font-bold text-white/68">分析重点</p>
            <p className="mt-1 text-sm font-black text-white">缺口与优先级</p>
          </div>
        </div>
      </div>

      {hasContent ? (
        <div className="px-4 py-4 md:px-6 md:py-5">
          {stale ? (
            <div className="mx-auto mb-4 max-w-[980px] rounded-[16px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold leading-6 text-amber-800">
              当前展示的是旧版家庭保单分析报告，资料已更新，建议重新生成。
            </div>
          ) : null}
          <article
            className="family-policy-analysis-document mx-auto max-w-[980px] rounded-[18px] border border-[#DCE7F1] bg-white px-4 py-4 shadow-[0_16px_36px_-30px_rgba(15,23,42,0.3)] md:px-7 md:py-6"
            aria-label="家庭保单分析报告正文"
          >
            <FamilySalesReviewMarkdown content={report?.content || ''} />
          </article>
        </div>
      ) : loading ? (
        <div className="m-4 rounded-[18px] border border-[#D6E6F4] bg-blue-50 px-4 py-8 text-center md:m-6">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#0B72B9] shadow-sm shadow-blue-900/10">
            <FileText className="h-6 w-6 animate-pulse" />
          </div>
          <p className="mt-3 text-base font-black text-[#102033]">正在生成家庭保单分析报告</p>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-semibold leading-6 text-[#72849A]">
            正在综合家庭成员、现有保单、责任结构和保障缺口，完成后会自动显示在这里。
          </p>
        </div>
      ) : (
        <div className="m-4 rounded-[18px] border border-dashed border-[#CBD7E1] bg-white px-4 py-8 text-center md:m-6">
          <p className="text-base font-black text-[#102033]">{failed ? '家庭保单分析报告生成失败' : '暂无已生成的家庭保单分析报告'}</p>
          <p className="mx-auto mt-2 max-w-2xl text-sm font-semibold leading-6 text-[#72849A]">
            {failed
              ? report?.error || '请稍后重试，或检查报告生成服务配置。'
              : '这份报告会单独分析全家保单结构，并重点展开保障缺口、风险影响和补强优先级；生成时间可能较长，不影响左侧保障分析报告。'}
          </p>
        </div>
      )}

      {failed ? (
        <div className="mx-4 mb-4 rounded-[18px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 md:mx-6 md:mb-6">
          {report?.error || '报告生成失败，请稍后重试。'}
        </div>
      ) : null}
    </section>
  );
}

function cashflowAggregateDetails(row: FamilyWealthAggregateRow) {
  return row.details.filter((detail) => detail.type === 'payout');
}

function wealthAggregateDetailRows(row: FamilyWealthAggregateRow) {
  const details = cashflowAggregateDetails(row);
  return details.length ? details : [null];
}

function WealthAggregateExportList({ rows }: { rows: FamilyWealthAggregateRow[] }) {
  const informativeRows = rows.filter((row) => row.payoutInflow > 0 || row.cashValueTotal > 0 || cashflowAggregateDetails(row).length > 0);
  const exportRows = informativeRows.length ? informativeRows : rows.slice(0, 1);

  return exportRows.length ? (
    <div data-report-export-cards className="hidden space-y-2">
      {exportRows.map((row, index) => {
        const details = cashflowAggregateDetails(row).slice(0, 3);
        const tone = exportToneClassNames[exportToneByIndex(index + 3)];
        return (
          <article key={`wealth-aggregate-export-${row.year}`} className={`overflow-hidden rounded-lg border bg-white shadow-[0_10px_28px_-24px_rgba(15,23,42,0.3)] ${tone.border}`}>
            <div className={`flex flex-wrap items-start justify-between gap-2 border-b border-[#E6EEF5] px-3 py-2.5 ${tone.header}`}>
              <div className="min-w-0">
                <p className={`text-sm font-black ${tone.text}`}>{row.year} 年</p>
                <p className="mt-0.5 text-[11px] font-semibold text-[#72849A]">仅统计确定领取现金流</p>
              </div>
              <span className={`rounded-md px-2 py-1 text-[11px] font-black ring-1 ${tone.badge}`}>
                当年领取 {formatMoney(row.payoutInflow)}
              </span>
            </div>
            <div className="p-3 pt-0">
              <ExportMetricStrip
                rows={[
                  { label: '累计领取', value: formatMoney(row.cumulativePayoutInflow), highlight: true },
                  { label: '现金价值合计', value: formatMoney(row.cashValueTotal), highlight: true },
                  { label: '价值合计', value: formatMoney(row.totalValue), highlight: true },
                ]}
              />
              {details.length ? (
                <div className="mt-3 divide-y divide-[#E6EEF5] overflow-hidden rounded-lg border border-[#E1E8EF] bg-white">
                  {details.map((detail, detailIndex) => {
                    const detailTone = exportToneClassNames[exportToneByIndex(detailIndex)];
                    return (
                    <div key={`${row.year}-${detail.policyId}-${detail.liability}-${detail.amount}`} className="grid grid-cols-[minmax(0,1fr)_92px] gap-3 py-2 pl-3 pr-2 text-[11px] leading-4">
                      <div className={`min-w-0 border-l-2 pl-2 ${detailTone.line}`}>
                        <p className="break-words font-black text-[#102033]">{insuranceProductKeyword(detail.productName)}</p>
                        <p className="mt-0.5 break-words font-semibold text-[#64748B]">{detail.policyholder || '-'} · {truncateText(detail.liability || '领取', 18)}</p>
                      </div>
                      <p className={`text-right font-black ${detailTone.text}`}>{formatMoney(detail.amount)}</p>
                    </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  ) : null;
}

function WealthAggregateTable({ rows }: { rows: FamilyWealthAggregateRow[] }) {
  const summaryTdClassName = `${tdClassName} align-top`;
  const detailTdClassName = 'bg-[#F8FBFF] px-2.5 py-2 text-xs font-semibold text-slate-700 align-top ring-1 ring-[#E1EAF5]';
  const detailStartTdClassName = `${detailTdClassName} border-l border-[#CAD7E4]`;

  return rows.length ? (
    <>
      <WealthAggregateExportList rows={rows} />
      <div data-report-export-table>
        <TableWrap>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E1E8EF] bg-[#F8FBFF] px-3 py-2 text-[11px] font-black">
            <div className="flex flex-wrap items-center gap-2 text-[#36516A]">
              <span className="rounded-full bg-blue-50 px-2 py-1 text-[#0B72B9] ring-1 ring-blue-100">年度汇总</span>
              <span>仅统计确定领取现金流</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[#72849A]">
              <span className="rounded-full bg-white px-2 py-1 ring-1 ring-[#E1E8EF]">左侧：年度合计</span>
              <span className="rounded-full bg-white px-2 py-1 ring-1 ring-[#E1E8EF]">右侧：现金流明细</span>
            </div>
          </div>
          <table className="min-w-[1060px] table-fixed border-separate border-spacing-0 text-left">
            <colgroup>
              <col className="w-[72px]" />
              <col className="w-[116px]" />
              <col className="w-[116px]" />
              <col className="w-[96px]" />
              <col className="w-[158px]" />
              <col className="w-[110px]" />
              <col className="w-[120px]" />
            </colgroup>
            <thead>
              <tr>
                <th className={thClassName} title="年份" aria-label="年份">年</th>
                <th className={`${thClassName} text-right`} title="当年领取现金流" aria-label="当年现金流">当年现金流</th>
                <th className={`${thClassName} text-right`} title="累计领取现金流" aria-label="累计现金流">累计现金流</th>
                <th className={`${thClassName} border-l border-blue-300`} title="现金流明细：投保人">投保人</th>
                <th className={thClassName} title="现金流明细产品">产品</th>
                <th className={thClassName} title="现金流项目">项目</th>
                <th className={`${thClassName} text-right`} title="该保单当年领取现金流" aria-label="该保单现金流">现金流</th>
              </tr>
            </thead>
            <tbody>
              {rows.flatMap((row) => {
                const detailRows = wealthAggregateDetailRows(row);
                return detailRows.map((detail, index) => (
                  <tr key={`${row.year}-${detail?.policyId ?? 'empty'}-${detail?.policyYear ?? index}-${index}`}>
                    {index === 0 ? (
                      <>
                        <td className={summaryTdClassName} rowSpan={detailRows.length}>{row.year}</td>
                        <td className={`${summaryTdClassName} text-right`} rowSpan={detailRows.length}>{formatMoney(row.payoutInflow)}</td>
                        <td className={`${summaryTdClassName} text-right`} rowSpan={detailRows.length}>{formatMoney(row.cumulativePayoutInflow)}</td>
                      </>
                    ) : null}
                    <td className={detailStartTdClassName}>
                      {detail ? (
                        <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-black text-[#0B72B9] ring-1 ring-blue-100">
                          {detail.policyholder || '-'}
                        </span>
                      ) : <span className="text-[#8AA0B8]">—</span>}
                    </td>
                    <td className={`${detailTdClassName} min-w-[116px] max-w-[150px]`}>
                      {detail ? (
                        <span title={detail.productName || ''} className="font-black text-[#102033]">
                          {insuranceProductKeyword(detail.productName)}
                        </span>
                      ) : <span className="text-[#8AA0B8]">—</span>}
                    </td>
                    <td className={`${detailTdClassName} min-w-[86px] max-w-[110px]`}>
                      {detail ? (
                        <span title={detail.liability || ''} className="font-bold text-[#36516A]">
                          {truncateText(detail.liability || '领取', 8)}
                        </span>
                      ) : <span className="text-[#8AA0B8]">—</span>}
                    </td>
                    <td className={`${detailTdClassName} text-right font-black text-[#0B72B9] tabular-nums`}>
                      {detail ? formatMoney(detail.amount) : '—'}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </TableWrap>
      </div>
    </>
  ) : (
    <EmptyState text="暂无全家财富统计" />
  );
}

function WealthStatisticsScope({ report }: { report: FamilyReport }) {
  if (!report.wealth.statisticsScopeNote) return null;

  const reasonLabels = Array.from(new Set(report.wealth.excludedPolicies.flatMap((policy) => policy.reasons)));
  const excludedCount = report.wealth.excludedPolicies.length;

  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[#D7E2EA] bg-white px-2.5 py-1.5 text-[11px] shadow-[0_8px_24px_-22px_rgba(15,23,42,0.28)]">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="h-5 w-1 shrink-0 rounded-full bg-[#0B72B9]" aria-hidden="true" />
        <span className="font-black text-[#102033]">财富统计口径</span>
        <span className="font-semibold text-[#5E7290]">仅统计确定领取现金流</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-[#F8FBFF] px-2 py-0.5 font-black text-[#0B72B9] ring-1 ring-[#D7E2EA]">
          未计入 {excludedCount} 张
        </span>
        {reasonLabels.map((label) => (
          <span key={label} className="rounded-full bg-[#FFF8EB] px-1.5 py-0.5 font-black text-[#A6531B] ring-1 ring-[#F3D9B4]">
            {label}
          </span>
        ))}
        <div className="min-w-0 basis-full text-[10px] font-semibold leading-4 text-[#7890AA] sm:basis-auto">
          分红/万能账户因红利分配、结算利率、账户价值不确定，暂不进入统计。
        </div>
      </div>
    </div>
  );
}

function WealthSection({ report }: { report: FamilyReport }) {
  return (
    <Section title="财富分析">
      <div className="space-y-3">
        <CashValueTrendChart report={report} />

        {report.wealth.memberReports.length ? report.wealth.memberReports.map((member) => (
          <article key={reportMemberKey(member)} className={`${reportMutedSurfaceClassName} p-3`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-[#102033]">{memberDisplayName(member)}</h3>
              {member.attentionItems.length ? (
                <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-black text-[#0B72B9] ring-1 ring-[#D7E2EA]" title={member.attentionItems.join('；')}>
                  {member.attentionItems.length}项未入统计
                </span>
              ) : null}
            </div>
            <div className="space-y-3">
              {member.policies.map((policy) => <WealthPolicyCard key={policy.policyId} policy={policy} />)}
            </div>
          </article>
        )) : (
          <EmptyState text="暂无财富型保单数据" />
        )}

        <div className={`${reportMutedSurfaceClassName} p-3`}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-black text-[#102033]">全家财富统计</h3>
            {report.wealth.keyPoints.length ? (
              <div className="flex flex-wrap gap-1">
                {report.wealth.keyPoints.map((point) => (
                  <span key={`${point.label}-${point.value}`} className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-[#0B72B9] ring-1 ring-[#D7E2EA]">
                    {point.label}: {point.value}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <WealthStatisticsScope report={report} />
          <div className="space-y-3">
            <WealthAggregateTable rows={report.wealth.aggregateRows} />
          </div>
        </div>
      </div>
    </Section>
  );
}
