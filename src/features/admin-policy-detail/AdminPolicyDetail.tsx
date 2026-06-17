import { useRef } from 'react';
import {
  Download,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';

import type { Policy } from '../../api';
import {
  formatCoverageAmount,
  formatCurrency,
  maskMobile,
} from '../../shared/formatters';
import {
  downloadReportPdf,
  getReportExportControlTitle,
} from '../report-export/report-export';
import {
  MetricBox,
  ReportText,
  buildPolicyReportTitle,
  formatSourceUrlHost,
  getPolicyResponsibilitySourceLinks,
  isPolicyReportFailed,
  isPolicyReportGenerating,
} from '../../shared/policy-report-ui';

export function AdminPolicyDetail({
  policy,
  onClose,
  onRetryReport,
  retrying = false,
}: {
  policy: Policy;
  onClose: () => void;
  onRetryReport?: (policy: Policy) => void | Promise<void>;
  retrying?: boolean;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildPolicyReportTitle(policy);
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const responsibilities = Array.isArray(policy.responsibilities) ? policy.responsibilities : [];
  const policySources = Array.isArray(policy.sources) ? policy.sources : [];
  const responsibilitySourceLinks = getPolicyResponsibilitySourceLinks(policy);
  const exportControlTitle = getReportExportControlTitle();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/25">
      <aside className="ml-auto flex h-full w-[560px] flex-col bg-white shadow-2xl">
        <header className="no-print flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <p className="text-xs font-black uppercase text-slate-400">保单详情</p>
            <h2 className="mt-1 text-xl font-black">{policy.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold ${
                reportGenerating ? 'bg-slate-100 text-slate-300' : 'bg-blue-50 text-blue-700'
              }`}
              type="button"
              disabled={reportGenerating}
              onClick={() => void downloadReportPdf(reportRef.current, exportTitle, policy)}
            >
              <Download size={17} />
              {exportControlTitle}
            </button>
            <button className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-bold" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        <main ref={reportRef} className="print-policy-report flex-1 space-y-5 overflow-auto p-6">
          <section className="print-only">
            <h1>保单解析报告</h1>
            <p>生成时间：{generatedAt}</p>
          </section>

          {policy.report?.trim() ? (
            <section className="print-only print-policy-section">
              <h2>保险责任说明</h2>
              <ReportText text={policy.report} />
            </section>
          ) : null}

          {reportGenerating || reportFailed ? (
            <section className={`rounded-2xl border px-4 py-3 text-sm ${
              reportFailed ? 'border-red-100 bg-red-50 text-red-700' : 'border-blue-100 bg-blue-50 text-blue-700'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black">{reportFailed ? '报告生成失败' : '报告正在后台生成'}</p>
                  <p className="mt-1 text-xs leading-5">{reportFailed ? policy.reportError || '请稍后刷新查看。' : '保单已经保存，完整责任解析完成后会更新。'}</p>
                </div>
                {reportFailed && onRetryReport ? (
                  <button
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
                    type="button"
                    disabled={retrying}
                    onClick={() => void onRetryReport(policy)}
                  >
                    <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} />
                    {retrying ? '提交中' : '重新生成报告'}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="grid grid-cols-2 gap-3">
            <MetricBox label="账号" value={maskMobile(policy.userMobile || '')} />
            <MetricBox label="被保人" value={policy.insured || '-'} />
            <MetricBox label="投保人关系" value={policy.applicantRelation || '-'} />
            <MetricBox label="被保人关系" value={policy.insuredRelation || '-'} />
            <MetricBox label="保险公司" value={policy.company || '-'} />
            <MetricBox label="生效日期" value={policy.date || '-'} />
            <MetricBox label="保额" value={formatCoverageAmount(Number(policy.amount || 0))} />
            <MetricBox label="首期保费" value={formatCurrency(Number(policy.firstPremium || 0))} />
          </section>
          <section>
            <h3 className="mb-3 text-sm font-black">责任解析</h3>
            <div className="space-y-3">
              {responsibilitySourceLinks.length ? (
                <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-3">
                  <p className="text-xs font-black text-blue-700">官网地址</p>
                  <div className="mt-2 space-y-2">
                    {responsibilitySourceLinks.map((source) => (
                      <a
                        key={`${source.title}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-start gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-5 text-blue-700"
                      >
                        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate font-black">{source.title || formatSourceUrlHost(source.url)}</span>
                          <span className="block break-all text-blue-500">{source.url}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
              {responsibilities.length ? (
                responsibilities.map((row, index) => (
                  <article key={`${row.coverageType}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <h4 className="font-black">{row.coverageType}</h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{row.scenario}</p>
                    <p className="mt-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-blue-700">{row.payout}</p>
                    {row.note ? <p className="mt-2 text-xs text-slate-500">{row.note}</p> : null}
                  </article>
                ))
              ) : (
                <article className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  {reportGenerating ? '正在生成完整保险责任解析。' : '暂无责任解析。'}
                </article>
              )}
            </div>
          </section>
          {policySources.length ? (
            <section className="no-print">
              <h3 className="mb-3 text-sm font-black">资料来源</h3>
              <div className="space-y-2">
                {policySources.map((source, index) => (
                  <a
                    key={`${source.url}-${index}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-3 text-sm transition hover:border-blue-200 hover:bg-blue-50"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-black text-slate-800">{source.title || source.url}</span>
                      <span className={source.official ? 'shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700' : 'shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-black text-slate-500'}>
                        {source.official ? '官方' : source.evidenceLabel || '辅助'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{source.url}</p>
                  </a>
                ))}
              </div>
            </section>
          ) : null}
          <section className="no-print">
            <h3 className="mb-3 text-sm font-black">OCR 原文</h3>
            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">{policy.ocrText || '暂无 OCR 原文'}</pre>
          </section>
        </main>
      </aside>
    </div>
  );
}
