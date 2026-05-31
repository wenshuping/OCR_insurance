import { useRef } from 'react';
import { ChevronLeft, Download } from 'lucide-react';
import type {
  FamilyMemberProtectionReport,
  FamilyPolicyInventoryRow,
  FamilyReport,
  FamilyWealthAggregateRow,
  FamilyWealthPolicyReport,
} from './family-report-engine.mjs';

type FamilyReportPageProps = {
  report: FamilyReport;
  onBack: () => void;
  onExport: (target: HTMLElement | null, title: string) => void | Promise<void>;
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
};

function formatMoney(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
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

function statusClassName(status: string) {
  if (status === 'covered') return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (status === 'partial' || status === 'formula') return 'bg-amber-50 text-amber-700 ring-amber-100';
  if (status === 'missing') return 'bg-slate-100 text-slate-500 ring-slate-200';
  return 'bg-blue-50 text-blue-700 ring-blue-100';
}

function statusLabel(status: string) {
  if (status === 'covered') return '已覆盖';
  if (status === 'partial') return '部分覆盖';
  if (status === 'formula') return '公式型';
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
    <div className="max-w-[280px] leading-5">
      <p className="break-words text-xs font-semibold text-slate-600">{summary}</p>
      {collapsed ? (
        <details data-family-report-raw-note className="mt-1">
          <summary className="cursor-pointer text-[11px] font-black text-[#0B72B9]">查看原文</summary>
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
    <section className="space-y-3 border-b border-[#D9E6F4] pb-5 last:border-b-0">
      <h2 className="mb-3 text-base font-black text-[#0F172A]">{title}</h2>
      {children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#D9E6F4] bg-[#F8FBFF] px-4 py-6 text-center text-sm font-semibold text-[#7890AA]">
      {text}
    </div>
  );
}

function TableWrap({ children }: { children: React.ReactNode }) {
  return <div data-pdf-table-wrap className="overflow-x-auto">{children}</div>;
}

const thClassName = 'bg-[#0B72B9] px-3 py-2 text-left text-xs font-black text-white';
const tdClassName = 'whitespace-nowrap bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]';
const mutedTdClassName = 'whitespace-nowrap bg-white px-3 py-2 text-xs font-medium text-slate-500 ring-1 ring-[#E1EAF5]';
const compactThClassName = 'bg-[#0B72B9] px-2 py-1 text-center text-xs font-black text-white';
const compactTdClassName = 'whitespace-nowrap bg-white px-2 py-1 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]';

function getFamilyAttentionItems(report: FamilyReport) {
  return [
    ...report.summary.attentionItems,
    ...report.criticalIllness.members.flatMap((member) => member.attentionItems.map((item) => `${member.member}: ${item}`)),
    ...report.accident.members.flatMap((member) => member.attentionItems.map((item) => `${member.member}: ${item}`)),
    ...report.wealth.memberReports.flatMap((member) => member.attentionItems.map((item) => `${member.member}: ${item}`)),
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
      <div className="space-y-1 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-700 ring-1 ring-amber-100">
        {attentionItems.map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}
      </div>
    </Section>
  );
}

function OptionalResponsibilityGapSection({ gaps = [] }: { gaps?: OptionalResponsibilityGap[] }) {
  if (!gaps?.length) return null;

  return (
    <Section title="已投保但未量化责任">
      <div className="space-y-2">
        {gaps.map((gap, index) => (
          <div key={`${gap.policyId}-${gap.liability}-${index}`} className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800 ring-1 ring-amber-100">
            <p className="font-black">{gap.member} · {gap.productName}</p>
            <p>{gap.liability}</p>
            <p>{gap.quantificationReason || '缺少可计算结构化指标'}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ReportHero({ report, attentionItems }: { report: FamilyReport; attentionItems: string[] }) {
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const metrics = getFamilySummaryMetrics(report, attentionItems);

  return (
    <section className="rounded-[24px] bg-gradient-to-br from-blue-600 via-sky-500 to-emerald-400 p-5 text-white shadow-[0_18px_42px_-22px_rgba(14,116,144,0.75)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase text-white/70">Family Policy Report</p>
          <h2 className="mt-2 text-2xl font-black leading-tight">家庭保障分析报告</h2>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/85">
            按家庭成员汇总重疾、意外、财富三大板块，并保留每张保单的责任、现金流和现金价值。
          </p>
        </div>
        <div className="rounded-2xl bg-white/15 px-3 py-2 text-right text-xs font-bold leading-5 text-white/80">
          <span className="block">生成时间</span>
          <span className="block text-white">{generatedAt}</span>
        </div>
      </div>
      <div className="mt-5">
        <p className="text-xs font-black text-white/70">全家总统计</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0 rounded-2xl bg-white/15 px-3 py-3">
              <p className="text-xs font-bold text-white/70">{metric.label}</p>
              <p className="mt-1 break-words text-base font-black leading-tight text-white">{metric.value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function InventorySection({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  return (
    <Section title="家庭保单清单">
      {rows.length ? (
        <TableWrap>
          <table className="min-w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th className={`${thClassName} rounded-tl-xl`}>被保人</th>
                <th className={thClassName}>保单/产品</th>
                <th className={thClassName}>类型</th>
                <th className={`${thClassName} text-right`}>年交保费</th>
                <th className={thClassName}>保障/保额</th>
                <th className={`${thClassName} text-right`}>现金价值</th>
                <th className={`${thClassName} rounded-tr-xl`}>数据状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.policyId}>
                  <td className={tdClassName}>{row.member}</td>
                  <td className="min-w-[220px] bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]">
                    <span className="block font-black text-slate-900">{emptyText(row.productName)}</span>
                    <span className="mt-0.5 block text-[11px] font-medium text-slate-400">{emptyText(row.company)}</span>
                  </td>
                  <td className={tdClassName}>{emptyText(row.typeLabel)}</td>
                  <td className={`${tdClassName} text-right`}>{row.annualPremiumText || formatMoney(row.annualPremium)}</td>
                  <td className={tdClassName}>{emptyText(row.coverageText)}</td>
                  <td className={`${tdClassName} text-right`}>{row.cashValueText || '-'}</td>
                  <td className={mutedTdClassName}>{emptyText(row.dataStatus)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <EmptyState text="暂无家庭保单清单" />
      )}
    </Section>
  );
}

function InsuredPolicyDetailSection({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  const groups = new Map<string, FamilyPolicyInventoryRow[]>();
  rows.forEach((row) => {
    if (!groups.has(row.member)) groups.set(row.member, []);
    groups.get(row.member)?.push(row);
  });

  return (
    <Section title="被保人保单明细">
      {groups.size ? (
        <div className="space-y-3">
          {Array.from(groups, ([member, policies]) => (
            <article key={member} className="rounded-xl border border-[#D9E6F4] bg-[#F8FBFF] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-black text-[#0F172A]">{member}</h3>
                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-[#1152D4] ring-1 ring-[#D9E6F4]">
                  {policies.length}张保单
                </span>
              </div>
              <TableWrap>
                <table className="min-w-full border-separate border-spacing-0 text-left">
                  <thead>
                    <tr>
                      <th className={`${thClassName} rounded-tl-xl`}>保险公司/保单号</th>
                      <th className={thClassName}>险种名称</th>
                      <th className={`${thClassName} text-right`}>保费(元)</th>
                      <th className={thClassName}>交费期</th>
                      <th className={thClassName}>保障期</th>
                      <th className={thClassName}>生效日期</th>
                      <th className={`${thClassName} text-right`}>保额(元)</th>
                      <th className={thClassName}>身故受益人</th>
                      <th className={`${thClassName} rounded-tr-xl text-right`}>期交总保费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.map((row) => (
                      <tr key={row.policyId}>
                        <td className="min-w-[170px] bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-[#E1EAF5]">
                          <span className="block">{emptyText(row.company)}</span>
                          {row.policyNumber ? (
                            <span className="mt-0.5 block text-[11px] font-medium text-slate-400">{row.policyNumber}</span>
                          ) : null}
                        </td>
                        <td className="min-w-[200px] bg-white px-3 py-2 text-xs font-black text-slate-800 ring-1 ring-[#E1EAF5]">{emptyText(row.productName)}</td>
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
    <article className="rounded-xl border border-[#D9E6F4] bg-[#F8FBFF] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black text-[#0F172A]">{member.member}</h3>
        {member.attentionItems.length ? (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-amber-100">
            待关注 {member.attentionItems.length}
          </span>
        ) : null}
      </div>
      {member.attentionItems.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {member.attentionItems.map((item) => (
            <span key={item} className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-100">{item}</span>
          ))}
        </div>
      ) : null}
      <div data-report-export-cards className="space-y-2 md:hidden">
        {member.rows.map((row) => (
          <div key={row.key} className="rounded-xl bg-white p-3 ring-1 ring-[#E1EAF5]">
            <div className="flex items-start justify-between gap-3">
              <h4 className="min-w-0 break-words text-sm font-black leading-5 text-[#176B94]">{row.label}</h4>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${statusClassName(row.status)}`}>
                {statusLabel(row.status)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] leading-5">
              <div className="rounded-lg bg-[#F8FBFF] px-2 py-1.5">
                <p className="font-bold text-[#7890AA]">金额/比例</p>
                <p className="mt-0.5 break-words font-black text-slate-800">{emptyText(row.amountText)}</p>
              </div>
              <div className="rounded-lg bg-[#F8FBFF] px-2 py-1.5">
                <p className="font-bold text-[#7890AA]">次数/方式</p>
                <p className="mt-0.5 break-words font-black text-slate-800">{emptyText(row.countText)}</p>
              </div>
            </div>
            <div className="mt-2 rounded-lg bg-[#F8FBFF] px-2 py-1.5">
              <p data-report-canvas-skip className="mb-0.5 text-[11px] font-bold text-[#7890AA]">条件/说明</p>
              <ConditionSummary text={row.conditionText} />
            </div>
            <p data-report-canvas-skip className="mt-2 break-words text-[11px] font-medium leading-5 text-slate-400">
              来源: {truncateText(sourcePolicyText(row), 42)}
            </p>
          </div>
        ))}
      </div>
      <div data-report-canvas-skip data-report-export-table className="hidden md:block">
        <TableWrap>
        <table className="min-w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className={`${thClassName} rounded-tl-xl`}>责任颗粒度</th>
              <th className={thClassName}>金额/比例</th>
              <th className={thClassName}>次数/方式</th>
              <th className={thClassName}>状态</th>
              <th className={thClassName}>条件/说明</th>
              <th className={`${thClassName} rounded-tr-xl`}>来源保单</th>
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
                <td className="max-w-[300px] bg-white px-3 py-2 align-top text-xs font-medium text-slate-500 ring-1 ring-[#E1EAF5]">
                  <ConditionSummary text={row.conditionText} />
                </td>
                <td className="max-w-[240px] bg-white px-3 py-2 align-top text-xs font-medium leading-5 text-slate-500 ring-1 ring-[#E1EAF5]">
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
          {members.map((member) => <ProtectionMemberTable key={member.member} member={member} />)}
        </div>
      ) : (
        <EmptyState text={`暂无${title}数据`} />
      )}
    </Section>
  );
}

type CashValueTrendPoint = FamilyWealthPolicyReport['cashValueRows'][number] & {
  xValue: number;
  xLabel: string;
};

type CashValueTrendSeries = {
  id: string;
  label: string;
  meta: string;
  color: string;
  rows: CashValueTrendPoint[];
};

const cashValueTrendColors = ['#0F766E', '#2563EB', '#D97706', '#BE123C', '#7C3AED', '#0891B2', '#65A30D', '#C2410C'];

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

function buildCashValueTrendSeries(report: FamilyReport): CashValueTrendSeries[] {
  return report.wealth.memberReports
    .flatMap((member) => member.policies.map((policy) => ({ member: member.member, policy })))
    .map(({ member, policy }, index) => {
      const rows = policy.cashValueRows
        .filter((row) => Number.isFinite(row.cashValue) && cashValueChartXValue(row) !== null)
        .map((row) => ({
          ...row,
          xValue: cashValueChartXValue(row) as number,
          xLabel: cashValueChartXLabel(row),
        }))
        .sort((a, b) => a.xValue - b.xValue);
      if (!rows.length) return null;

      return {
        id: `${policy.policyId}-${member}`,
        label: compactText(policy.productName) || '未命名产品',
        meta: [member, compactText(policy.company)].filter(Boolean).join(' · '),
        color: cashValueTrendColors[index % cashValueTrendColors.length],
        rows,
      };
    })
    .filter((series): series is CashValueTrendSeries => Boolean(series));
}

function niceCashValueCeiling(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const factor = scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return factor * magnitude;
}

function uniqueTicks(values: number[]) {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
}

function CashValueTrendChart({ report }: { report: FamilyReport }) {
  const series = buildCashValueTrendSeries(report);
  if (!series.length) return <EmptyState text="暂无现金价值趋势数据" />;

  const width = 760;
  const height = 310;
  const paddingLeft = 74;
  const paddingRight = 28;
  const paddingTop = 30;
  const paddingBottom = 48;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;
  const allPoints = series.flatMap((item) => item.rows);
  const xMin = Math.min(...allPoints.map((point) => point.xValue));
  const xMax = Math.max(...allPoints.map((point) => point.xValue));
  const xRange = Math.max(1, xMax - xMin);
  const yMax = niceCashValueCeiling(Math.max(...allPoints.map((point) => point.cashValue)));
  const xFor = (value: number) => paddingLeft + ((value - xMin) / xRange) * plotWidth;
  const yFor = (value: number) => paddingTop + plotHeight - (Math.max(0, value) / yMax) * plotHeight;
  const yTicks = [yMax, yMax / 2, 0];
  const xTicks = uniqueTicks([xMin, Math.round((xMin + xMax) / 2), xMax]);
  const seriesRanges = series.map((item) => ({
    first: item.rows[0],
    last: item.rows[item.rows.length - 1],
  }));

  return (
    <article className="overflow-hidden rounded-2xl border border-[#D7E4F2] bg-white p-4 shadow-[0_18px_45px_-30px_rgba(15,23,42,0.28)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#0F766E]">Cash Value Timeline</p>
          <h3 className="mt-1 text-base font-black text-[#0F172A]">现金价值趋势</h3>
        </div>
        <div className="rounded-xl bg-[#F2F7F7] px-3 py-2 text-right ring-1 ring-[#D7E9E7]">
          <p className="text-[11px] font-bold text-[#64748B]">产品数</p>
          <p className="text-sm font-black text-[#0F766E]">{series.length}款</p>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <svg
          className="h-auto min-w-[680px] w-full"
          data-cash-value-trend-chart
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="现金价值趋势对比图"
        >
          <rect x="0" y="0" width={width} height={height} rx="18" fill="#F8FBFF" />
          <rect x={paddingLeft} y={paddingTop} width={plotWidth} height={plotHeight} rx="10" fill="#FFFFFF" />
          {yTicks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={`y-${tick}`}>
                <line x1={paddingLeft} x2={width - paddingRight} y1={y} y2={y} stroke="#DDE7F1" strokeDasharray="5 6" />
                <text x={paddingLeft - 10} y={y + 4} textAnchor="end" fontSize="11" fontWeight="700" fill="#64748B">
                  {formatCashValueAxis(tick)}
                </text>
              </g>
            );
          })}
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
          <line x1={paddingLeft} x2={width - paddingRight} y1={paddingTop + plotHeight} y2={paddingTop + plotHeight} stroke="#94A3B8" strokeWidth="1.2" />
          <text x={paddingLeft + plotWidth / 2} y={height - 4} textAnchor="middle" fontSize="12" fontWeight="800" fill="#334155">时间</text>
          <text x="18" y={paddingTop + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 18 ${paddingTop + plotHeight / 2})`} fontSize="12" fontWeight="800" fill="#334155">
            现金价值
          </text>

          {series.map((item) => {
            const path = item.rows
              .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point.xValue).toFixed(1)} ${yFor(point.cashValue).toFixed(1)}`)
              .join(' ');
            return (
              <g key={item.id}>
                <path d={path} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {item.rows.map((point, index) => (
                  <circle
                    key={`${item.id}-${point.xValue}-${point.cashValue}`}
                    cx={xFor(point.xValue)}
                    cy={yFor(point.cashValue)}
                    r={index === item.rows.length - 1 ? 2.8 : 1.7}
                    fill={item.color}
                    stroke="#FFFFFF"
                    strokeWidth="0.8"
                  >
                    <title>{`${item.label} ${point.xLabel}（第${point.policyYear}年末）: ${formatCashValue(point.cashValue)}元`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {series.map((item, index) => (
          <div key={item.id} className="min-w-0 rounded-xl bg-[#F8FBFF] px-3 py-2 ring-1 ring-[#E1EAF5]">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <p className="min-w-0 truncate text-xs font-black text-[#0F172A]">{truncateText(item.label, 24)}</p>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px] font-bold text-[#64748B]">
              <span className="min-w-0 truncate">{item.meta || `产品${index + 1}`}</span>
              <span className="shrink-0 text-[#0F766E]">
                {seriesRanges[index]?.first.xLabel}-{seriesRanges[index]?.last.xLabel} · {formatCashValueAxis(seriesRanges[index]?.last.cashValue ?? 0)}
              </span>
            </div>
            {seriesRanges[index]?.first.policyYear > 1 ? (
              <p className="mt-1 text-[10px] font-bold text-amber-600">
                缺第1-{seriesRanges[index].first.policyYear - 1}年
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </article>
  );
}

function PolicyAnnualCashflowTable({ policy }: { policy: FamilyWealthPolicyReport }) {
  const rows = policy.annualCashflowRows;
  if (!rows.length) return <EmptyState text="暂无现金流明细" />;

  const columnSize = 14;
  const columns: FamilyWealthPolicyReport['annualCashflowRows'][] = [];
  for (let index = 0; index < rows.length; index += columnSize) {
    columns.push(rows.slice(index, index + columnSize));
  }

  return (
    <TableWrap>
      <div className="flex min-w-max gap-3">
        {columns.map((column, columnIndex) => (
          <table key={`${policy.policyId}-${columnIndex}`} className="border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th className={`${compactThClassName} rounded-tl-xl`}>年份</th>
                <th className={compactThClassName}>领取金额</th>
                <th className={`${compactThClassName} rounded-tr-xl`}>累计领取</th>
              </tr>
            </thead>
            <tbody>
              {column.map((row) => (
                <tr key={`${policy.policyId}-${row.year}`} className={/满期/u.test(row.liabilities.join('/')) ? 'bg-orange-50' : undefined}>
                  <td className={`${compactTdClassName} font-black text-[#425570]`}>{row.year}/{row.age === null ? '-' : row.age}</td>
                  <td className={`${compactTdClassName} text-right`}>
                    {row.amount > 0 ? (
                      <span className={`inline-block rounded px-1 text-[11px] font-black ${/满期/u.test(row.liabilities.join('/')) ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600'}`}>
                        {formatMoney(row.amount)}
                      </span>
                    ) : '—'}
                  </td>
                  <td className={`${compactTdClassName} text-right text-[#5E7290]`}>
                    {row.amount > 0 ? formatMoney(row.cumulative) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </TableWrap>
  );
}

function WealthPolicyCard({ policy }: { policy: FamilyWealthPolicyReport }) {
  return (
    <article className="rounded-xl border border-[#D9E6F4] bg-white p-3 shadow-[0_12px_24px_-22px_rgba(15,23,42,0.16)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-black text-[#0F172A]">{emptyText(policy.productName)}</h4>
          <p className="mt-1 text-xs font-medium text-[#7890AA]">{emptyText(policy.company)} · 年交 {formatMoneyWithUnit(policy.annualPremium)}</p>
        </div>
        {policy.attentionItems.length ? (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-amber-100">
            {policy.attentionItems.length}项待关注
          </span>
        ) : null}
      </div>

      {policy.keyPoints.length ? (
        <div className="mb-3 grid gap-2 sm:grid-cols-3">
          {policy.keyPoints.map((point) => (
            <div key={`${point.label}-${point.value}`} className="rounded-xl bg-[#F8FBFF] px-3 py-2 ring-1 ring-[#E1EAF5]">
              <p className="text-[11px] font-bold text-[#7890AA]">{point.label}</p>
              <p className="mt-0.5 text-xs font-black text-slate-900">{point.value} · {formatMoneyWithUnit(point.amount)}</p>
            </div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h5 className="text-xs font-black text-slate-700">个人现金流明细</h5>
          <span className="text-[11px] font-bold text-[#7890AA]">(单位:元)</span>
        </div>
        <PolicyAnnualCashflowTable policy={policy} />
      </div>
    </article>
  );
}

export function FamilyReportPage({ report, onBack, onExport }: FamilyReportPageProps) {
  const reportRef = useRef<HTMLElement | null>(null);
  const exportTitle = '家庭保障分析报告';
  const attentionItems = getFamilyAttentionItems(report);
  const reportWithOptionalGaps = report as FamilyReportWithOptionalGaps;

  return (
    <div className="min-h-screen bg-[#F4F8FC] pb-10">
      <header className="no-print sticky top-0 z-20 flex items-center justify-between border-b border-slate-100 bg-white/90 px-4 py-4 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex h-10 w-10 items-center justify-center rounded-full text-slate-700 active:bg-slate-100"
          aria-label="返回"
          title="返回"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-black text-slate-950">家庭保障分析报告</h1>
        <button
          type="button"
          onClick={() => void onExport(reportRef.current, exportTitle)}
          className="flex h-10 items-center justify-center gap-1.5 rounded-full bg-blue-50 px-3 text-xs font-black text-blue-600 active:bg-blue-100"
          aria-label="下载报告图片"
          title="下载报告图片"
        >
          <Download size={18} />
          <span>图片</span>
        </button>
      </header>

      <main ref={reportRef} className="print-policy-report space-y-4 p-4">
        <ReportHero report={report} attentionItems={attentionItems} />
        <AttentionSection attentionItems={attentionItems} />
        <OptionalResponsibilityGapSection gaps={reportWithOptionalGaps.optionalResponsibilityGaps} />
        <InventorySection rows={report.policyInventory.rows} />
        <InsuredPolicyDetailSection rows={report.policyInventory.rows} />
        <ProtectionSection title="重疾分析" members={report.criticalIllness.members} />
        <ProtectionSection title="意外分析" members={report.accident.members} />
        <WealthSection report={report} />
      </main>
    </div>
  );
}

function WealthAggregateTable({ rows }: { rows: FamilyWealthAggregateRow[] }) {
  return rows.length ? (
    <TableWrap>
      <table className="min-w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            <th className={`${thClassName} rounded-tl-xl`}>年份</th>
            <th className={`${thClassName} text-right`}>保费支出</th>
            <th className={`${thClassName} text-right`}>领取收入</th>
            <th className={`${thClassName} text-right`}>年度净现金流</th>
            <th className={`${thClassName} text-right`}>累计净现金流</th>
            <th className={`${thClassName} rounded-tr-xl text-right`}>现金价值合计</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.year}>
              <td className={tdClassName}>{row.year}</td>
              <td className={`${tdClassName} text-right`}>{formatMoney(row.premiumOutflow)}</td>
              <td className={`${tdClassName} text-right`}>{formatMoney(row.payoutInflow)}</td>
              <td className={`${tdClassName} text-right`}>{formatMoney(row.netCashflow)}</td>
              <td className={`${tdClassName} text-right`}>{formatMoney(row.cumulativeNetCashflow)}</td>
              <td className={`${tdClassName} text-right`}>{formatMoney(row.cashValueTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  ) : (
    <EmptyState text="暂无全家财富统计" />
  );
}

function WealthSection({ report }: { report: FamilyReport }) {
  return (
    <Section title="财富分析">
      <div className="space-y-3">
        <CashValueTrendChart report={report} />

        {report.wealth.memberReports.length ? report.wealth.memberReports.map((member) => (
          <article key={member.member} className="rounded-xl border border-[#D9E6F4] bg-[#F8FBFF] p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-[#0F172A]">{member.member}</h3>
              {member.attentionItems.length ? (
                <span className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-amber-100">
                  待关注 {member.attentionItems.length}
                </span>
              ) : null}
            </div>
            {member.attentionItems.length ? (
              <div className="mb-3 flex flex-wrap gap-1">
                {member.attentionItems.map((item) => (
                  <span key={item} className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-100">{item}</span>
                ))}
              </div>
            ) : null}
            <div className="space-y-3">
              {member.policies.map((policy) => <WealthPolicyCard key={policy.policyId} policy={policy} />)}
            </div>
          </article>
        )) : (
          <EmptyState text="暂无财富型保单数据" />
        )}

        <div className="rounded-xl border border-[#D9E6F4] bg-[#F8FBFF] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-black text-[#0F172A]">全家财富统计</h3>
            {report.wealth.keyPoints.length ? (
              <div className="flex flex-wrap gap-1">
                {report.wealth.keyPoints.map((point) => (
                  <span key={`${point.label}-${point.value}`} className="rounded-full bg-white px-2 py-1 text-[11px] font-bold text-[#1152D4] ring-1 ring-[#D9E6F4]">
                    {point.label}: {point.value}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <WealthAggregateTable rows={report.wealth.aggregateRows} />
        </div>
      </div>
    </Section>
  );
}
