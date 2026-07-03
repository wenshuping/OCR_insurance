import { ArrowLeft, FileSearch, MessageSquareText } from 'lucide-react';
import type { FamilySalesChatThread, FamilySalesReview } from '../../../api';
import { FamilySalesReviewMarkdown } from '../../../features/family-report/FamilySalesReviewMarkdown';
import { formatDateLabel } from '../../../shared/formatters';

export function AdminSalesReviewPage({
  review,
  chatThreads,
  familyName,
  loading,
  onBack,
}: {
  review: FamilySalesReview | null;
  chatThreads: FamilySalesChatThread[];
  familyName: string;
  loading: boolean;
  onBack: () => void;
}) {
  return (
    <section className="mx-auto max-w-5xl overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
      <header className="border-b border-blue-100 bg-blue-950 px-5 py-5 text-white">
        <button
          type="button"
          className="mb-4 flex items-center gap-2 rounded-xl bg-blue-900/80 px-3 py-2 text-xs font-black text-blue-100 ring-1 ring-blue-300/25"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
          返回用户家庭
        </button>
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-400/15 text-blue-200 ring-1 ring-blue-300/35">
            <FileSearch size={22} />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase text-blue-200">Expert Intelligence</p>
            <h2 className="mt-1 text-xl font-black leading-tight">家庭保障策略简报</h2>
            <p className="mt-1 truncate text-xs font-semibold text-slate-300">
              {familyName || '当前家庭'}
              {review?.generatedAt ? <span> · {formatDateLabel(review.generatedAt)}</span> : null}
            </p>
          </div>
        </div>
      </header>

      <div className="bg-slate-50 p-5">
        {loading ? (
          <p className="rounded-2xl bg-white px-4 py-12 text-center text-sm font-black text-slate-400 ring-1 ring-slate-200">正在读取销售建议</p>
        ) : review?.content ? (
          <div className="print-policy-report space-y-3 bg-slate-50">
            {review.inputSummary ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetricCard label="家庭成员" value={`${review.inputSummary.memberCount ?? 0}`} />
                <MetricCard label="有效样本" value={`${review.inputSummary.policyCount ?? 0}`} />
                <MetricCard label="待覆盖成员" value={`${review.inputSummary.membersWithoutPolicyCount ?? 0}`} />
                <MetricCard label="条款证据" value={`${review.inputSummary.officialProductCount ?? 0}`} />
              </div>
            ) : null}
            <article className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200">
              <div className="mb-3 flex items-center gap-2 border-b border-slate-100 pb-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-blue-100">
                  <FileSearch size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-black text-slate-950">专家研判报告</h3>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">只读查看已保存的销售建议</p>
                </div>
              </div>
              <FamilySalesReviewMarkdown content={review.content} />
            </article>
            <article className="rounded-[22px] bg-white p-4 ring-1 ring-slate-200">
              <div className="mb-3 flex items-center gap-2 border-b border-slate-100 pb-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100">
                  <MessageSquareText size={18} />
                </span>
                <div>
                  <h3 className="text-sm font-black text-slate-950">续聊记录</h3>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">只读查看顾问围绕销售建议的追问</p>
                </div>
              </div>
              {chatThreads.length ? (
                <div className="space-y-4">
                  {chatThreads.map((thread) => (
                    <section key={thread.id} className="rounded-[18px] border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-black text-slate-950">{thread.title || `会话 ${thread.id}`}</h4>
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">
                          {thread.messageCount || thread.messages?.length || 0} 条
                        </span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {(thread.messages || []).map((message) => (
                          <div
                            key={message.id}
                            className={`rounded-2xl px-3 py-2.5 text-xs font-semibold leading-5 ${
                              message.role === 'user'
                                ? 'bg-blue-600 text-white'
                                : 'bg-white text-slate-600 ring-1 ring-slate-200'
                            }`}
                          >
                            <p className={message.role === 'user' ? 'mb-1 font-black text-blue-100' : 'mb-1 font-black text-slate-400'}>
                              {message.role === 'user' ? '顾问追问' : '续聊 Agent'}
                            </p>
                            <p className="whitespace-pre-wrap break-words">{message.content}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm font-black text-slate-400 ring-1 ring-slate-200">暂无续聊记录</p>
              )}
            </article>
          </div>
        ) : (
          <p className="rounded-2xl bg-white px-4 py-12 text-center text-sm font-black text-slate-400 ring-1 ring-slate-200">暂无已保存销售建议</p>
        )}
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white px-3 py-3 ring-1 ring-slate-200">
      <p className="text-[11px] font-black text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-black text-slate-950">{value}</p>
    </div>
  );
}
