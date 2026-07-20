import {
  AlertCircle,
  ClipboardList,
  ExternalLink,
  FileText,
  ShieldCheck,
} from 'lucide-react';
import type { CustomerResponsibilitySummary } from '../api/contracts/responsibility';
import type { CashflowEntry } from '../api/contracts/cashflow';
import { formatCurrency } from './formatters';

function cleanStrings(values: string[] | undefined) {
  return Array.isArray(values) ? values.map((value) => String(value || '').trim()).filter(Boolean) : [];
}

function cleanText(value: unknown) {
  return String(value ?? '').trim();
}

function hostFromUrl(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function CustomerResponsibilitySummaryCard({
  summary,
  cashflowEntries = [],
}: {
  summary: CustomerResponsibilitySummary;
  cashflowEntries?: CashflowEntry[];
}) {
  const blocks = (Array.isArray(summary.contentBlocks) ? summary.contentBlocks : [])
    .map((block) => ({
      blockKey: cleanText(block?.blockKey),
      title: cleanText(block?.title),
      enabled: block?.enabled !== false,
      content: cleanText(block?.content),
      order: Number.isFinite(Number(block?.order)) ? Number(block.order) : 0,
      sourceRefs: cleanStrings(block?.sourceRefs),
    }))
    .filter((block) => block.enabled && (block.title || block.content))
    .sort((left, right) => left.order - right.order);
  const responsibilities = (Array.isArray(summary.mainResponsibilities) ? summary.mainResponsibilities : [])
    .map((item) => ({
      title: cleanText(item?.title),
      plainText: cleanText(item?.plainText),
      triggerCondition: cleanText(item?.triggerCondition),
      howItPays: cleanText(item?.howItPays),
      calculationStatus: cleanText(item?.calculationStatus),
      requiredPolicyFields: cleanStrings(item?.requiredPolicyFields),
      sourceRefs: cleanStrings(item?.sourceRefs),
    }))
    .filter((item) => item.title || item.plainText || item.triggerCondition || item.howItPays || item.calculationStatus || item.sourceRefs.length);
  const notices = cleanStrings(summary.notices);
  const requiredPolicyFields = cleanStrings(summary.requiredPolicyFields);
  const sourceUrls = cleanStrings(summary.sourceUrls);
  const materialSources = (Array.isArray(summary.materialSources) ? summary.materialSources : [])
    .map((source) => ({
      evidenceId: cleanText(source?.evidenceId),
      fileName: cleanText(source?.fileName),
      pageStart: Number(source?.pageStart || 0),
      pageEnd: Number(source?.pageEnd || source?.pageStart || 0),
    }))
    .filter((source) => source.evidenceId || source.fileName);

  return (
    <section className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-blue-50 text-blue-600 ring-1 ring-blue-100">
          <ShieldCheck size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-black text-blue-600">{summary.company}</p>
          <h3 className="mt-1 break-words text-base font-black leading-6 text-slate-950">{summary.productName}</h3>
          {summary.headline ? (
            <p className="mt-2 break-words rounded-xl bg-[#F8FBFF] px-3 py-2 text-sm font-black leading-6 text-blue-700 ring-1 ring-blue-100">
              {summary.headline}
            </p>
          ) : null}
        </div>
      </div>

      {blocks.length ? (
        <div className="mt-4 space-y-3">
          {blocks.map((block) => (
            <section key={block.blockKey || block.title} className="rounded-[16px] bg-slate-50 px-3 py-3 ring-1 ring-slate-100">
              {block.title ? <h4 className="text-xs font-black text-slate-950">{block.title}</h4> : null}
              {block.content ? <p className="mt-2 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-600">{block.content}</p> : null}
              {block.sourceRefs.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {block.sourceRefs.map((sourceRef) => (
                    <span key={sourceRef} className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">{sourceRef}</span>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}

      {responsibilities.length ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-black text-slate-950">责任明细</h4>
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-700">{responsibilities.length} 项</span>
          </div>
          {responsibilities.map((item, index) => {
            const calculatedRows = cashflowEntries
              .filter((entry) => item.title && String(entry.liability || '').includes(item.title))
              .sort((left, right) => Number(left.year) - Number(right.year));
            const calculatedTotal = calculatedRows.reduce((total, entry) => total + Number(entry.amount || 0), 0);
            const calculatedAmounts = Array.from(new Set(calculatedRows.map((entry) => Number(entry.amount || 0))));
            return (
              <article key={`${item.title}-${index}`} className="rounded-[16px] border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white text-xs font-black text-blue-600 ring-1 ring-blue-100">
                    {index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="break-words text-sm font-black leading-6 text-slate-950">{item.title || '保险责任'}</h4>
                    {item.plainText ? <p className="mt-1 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-600">{item.plainText}</p> : null}
                    {item.triggerCondition ? <p className="mt-2 whitespace-pre-wrap break-words text-xs font-semibold leading-5 text-slate-500">触发条件：{item.triggerCondition}</p> : null}
                    {item.howItPays ? <p className="mt-2 break-words rounded-xl bg-white px-3 py-2 text-xs font-black leading-5 text-blue-700 ring-1 ring-slate-100">{item.howItPays}</p> : null}
                    {calculatedRows.length ? (
                      <div className="mt-2 rounded-xl bg-cyan-50 px-3 py-2 text-xs font-bold leading-5 text-cyan-800 ring-1 ring-cyan-100">
                        <p className="font-black">已按本保单指标计算</p>
                        <p className="mt-1">
                          {calculatedAmounts.length === 1 ? `每次 ${formatCurrency(calculatedAmounts[0])}，` : ''}
                          共 {calculatedRows.length} 次，合同计划累计 {formatCurrency(calculatedTotal)}
                          （{calculatedRows[0].year}—{calculatedRows[calculatedRows.length - 1].year}年）
                        </p>
                        <p className="mt-1 text-[11px] text-cyan-700">
                          {calculatedRows[0].calculationText || calculatedRows[0].calcText || '按保险责任指标计算'}
                        </p>
                      </div>
                    ) : item.calculationStatus ? (
                      <p className="mt-2 break-words text-[11px] font-black leading-5 text-slate-400">
                        {item.calculationStatus === 'claim_contingent' ? '出险后按实际情况计算' : item.calculationStatus === 'scheduled_cashflow' ? '待结合保单信息计算' : item.calculationStatus}
                      </p>
                    ) : null}
                    {item.sourceRefs.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.sourceRefs.map((sourceRef) => (
                          <span key={sourceRef} className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700 ring-1 ring-blue-100">{sourceRef}</span>
                        ))}
                      </div>
                    ) : null}
                    {item.requiredPolicyFields.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.requiredPolicyFields.map((field) => (
                          <span key={field} className="rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">{field}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {requiredPolicyFields.length && !cashflowEntries.length ? (
        <div className="mt-4 rounded-[16px] border border-amber-100 bg-amber-50 px-3 py-3">
          <div className="flex items-center gap-2 text-xs font-black text-amber-700">
            <ClipboardList size={16} />
            <span>计算金额需要这些保单信息</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {requiredPolicyFields.map((field) => (
              <span key={field} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-amber-700 ring-1 ring-amber-100">{field}</span>
            ))}
          </div>
        </div>
      ) : null}

      {notices.length ? (
        <div className="mt-3 space-y-1.5">
          {notices.map((notice) => (
            <p key={notice} className="flex items-start gap-2 break-words text-xs font-semibold leading-5 text-slate-500">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>{notice}</span>
            </p>
          ))}
        </div>
      ) : null}

      {sourceUrls.length ? (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-black text-slate-500">
            <FileText size={15} />
            <span>资料来源</span>
          </div>
          <div className="space-y-2">
            {sourceUrls.slice(0, 3).map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500 ring-1 ring-slate-100 transition hover:bg-blue-50 hover:text-blue-700"
              >
                <span className="min-w-0 truncate">{hostFromUrl(url)}</span>
                <ExternalLink size={13} className="shrink-0" />
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {materialSources.length ? (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-black text-slate-500">
            <FileText size={15} />
            <span>上传资料来源</span>
          </div>
          <div className="space-y-2">
            {materialSources.map((source) => (
              <p key={`${source.evidenceId}-${source.fileName}`} className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700 ring-1 ring-blue-100">
                {source.evidenceId} · {source.fileName}
                {source.pageStart ? ` · 第${source.pageStart}${source.pageEnd !== source.pageStart ? `-${source.pageEnd}` : ''}页` : ''}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
