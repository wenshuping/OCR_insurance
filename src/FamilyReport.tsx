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

function formatMoney(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatMoneyWithUnit(value: number) {
  return `${formatMoney(value)}元`;
}

function formatCashValue(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
                <td className="min-w-[220px] bg-white px-3 py-2 text-xs font-medium text-slate-500 ring-1 ring-[#E1EAF5]">{emptyText(row.conditionText)}</td>
                <td className="min-w-[180px] bg-white px-3 py-2 text-xs font-medium text-slate-500 ring-1 ring-[#E1EAF5]">
                  {row.sourcePolicies.length ? row.sourcePolicies.map((policy) => policy.productName || policy.liability || '未命名保单').join(' / ') : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
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

function CashValueLineChart({ rows }: { rows: FamilyWealthPolicyReport['cashValueRows'] }) {
  const chartRows = rows.filter((row) => Number.isFinite(row.cashValue));
  if (chartRows.length < 2) return <EmptyState text="现金价值点不足，暂无法生成曲线" />;

  const width = 420;
  const height = 168;
  const paddingX = 34;
  const paddingY = 22;
  const values = chartRows.map((row) => row.cashValue);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = Math.max(1, maxValue - minValue);
  const xStep = chartRows.length > 1 ? (width - paddingX * 2) / (chartRows.length - 1) : 0;
  const points = chartRows.map((row, index) => {
    const x = paddingX + index * xStep;
    const y = height - paddingY - ((row.cashValue - minValue) / valueRange) * (height - paddingY * 2);
    return { ...row, x, y };
  });
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const midValue = minValue + valueRange / 2;
  const yTicks = [
    { label: formatMoney(maxValue), y: paddingY },
    { label: formatMoney(midValue), y: height / 2 },
    { label: formatMoney(minValue), y: height - paddingY },
  ];

  return (
    <div className="mb-3 rounded-xl bg-[#F8FBFF] p-3 ring-1 ring-[#E1EAF5]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h6 className="text-xs font-black text-slate-700">现金价值曲线</h6>
        <span className="text-[11px] font-bold text-[#7890AA]">
          {first.calendarYear || `第${first.policyYear}年`} 至 {last.calendarYear || `第${last.policyYear}年`}
        </span>
      </div>
      <svg className="h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="现金价值曲线">
        <rect x="0" y="0" width={width} height={height} rx="12" fill="#FFFFFF" />
        {yTicks.map((tick) => (
          <g key={`${tick.label}-${tick.y}`}>
            <line x1={paddingX} x2={width - paddingX} y1={tick.y} y2={tick.y} stroke="#E2E8F0" strokeDasharray="4 5" />
            <text x="8" y={tick.y + 4} fontSize="10" fill="#64748B">{tick.label}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#0EA5E9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d={`${path} L ${last.x.toFixed(1)} ${height - paddingY} L ${first.x.toFixed(1)} ${height - paddingY} Z`} fill="#0EA5E9" opacity="0.08" />
        {points.map((point, index) => (
          <g key={`${point.policyYear}-${point.calendarYear}-${point.cashValue}`}>
            <circle cx={point.x} cy={point.y} r={index === 0 || index === points.length - 1 ? 4 : 3} fill="#FFFFFF" stroke="#0EA5E9" strokeWidth="2" />
            {(index === 0 || index === points.length - 1) ? (
              <>
                <text x={point.x} y={height - 7} textAnchor={index === 0 ? 'start' : 'end'} fontSize="10" fill="#475569">
                  {point.calendarYear || `第${point.policyYear}年`}
                </text>
                <text x={point.x} y={Math.max(12, point.y - 8)} textAnchor={index === 0 ? 'start' : 'end'} fontSize="10" fontWeight="700" fill="#0369A1">
                  {formatMoney(point.cashValue)}
                </text>
              </>
            ) : null}
          </g>
        ))}
      </svg>
    </div>
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
                <th className={compactThClassName}>累计领取</th>
                <th className={`${compactThClassName} rounded-tr-xl`}>现金价值</th>
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
                  <td className={`${compactTdClassName} text-right text-[#7F96B5]`}>
                    {row.cashValue === null ? '—' : formatCashValue(row.cashValue)}
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

      <div className="grid gap-3 xl:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h5 className="text-xs font-black text-slate-700">个人现金流明细</h5>
            <span className="text-[11px] font-bold text-[#7890AA]">(单位:元)</span>
          </div>
          <PolicyAnnualCashflowTable policy={policy} />
        </div>

        <div>
          <h5 className="mb-2 text-xs font-black text-slate-700">现金价值</h5>
          {policy.cashValueRows.length ? (
            <CashValueLineChart rows={policy.cashValueRows} />
          ) : (
            <EmptyState text="暂无现金价值表" />
          )}
        </div>
      </div>
    </article>
  );
}

export function FamilyReportPage({ report, onBack, onExport }: FamilyReportPageProps) {
  const reportRef = useRef<HTMLElement | null>(null);
  const exportTitle = '家庭保障分析报告';
  const attentionItems = getFamilyAttentionItems(report);

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
