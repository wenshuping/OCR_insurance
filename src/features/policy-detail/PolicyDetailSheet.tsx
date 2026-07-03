import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Download,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Policy,
  PolicyFormData,
} from '../../api/contracts/policy';
import type {
  CustomerResponsibilitySummary,
  OptionalResponsibility,
  PolicyCompanySuggestion,
  PolicyProductSuggestion,
} from '../../api/contracts/responsibility';
import {
  getProductCustomerResponsibilitySummary,
  listPolicyResponsibilityCompanySuggestions,
  listPolicyResponsibilityProductSuggestions,
} from '../../api/contracts/responsibility';
import {
  downloadReportPdf,
  getReportExportControlTitle,
} from '../../features/report-export/report-export';
import {
  formatBeneficiaryValue,
  formatCoverageAmount,
  formatCurrency,
  formatDateLabel,
} from '../../shared/formatters';
import {
  MetricBox,
  ReportText,
  buildPolicyReportTitle,
  getReportPlaceholder,
  isPolicyReportFailed,
  isPolicyReportGenerating,
} from '../../shared/policy-report-ui';
import {
  POLICY_PERSON_RELATION_OPTIONS,
  normalizePolicyPlanList,
  policyToForm,
  sanitizeAmount,
} from '../../shared/customer-policy-form';
import {
  summarizeCashValues,
} from '../../shared/customer-cash-value';
import { CustomerResponsibilitySummaryCard } from '../../shared/CustomerResponsibilitySummaryCard';
import {
  CoveragePeriodField,
  PaymentPeriodField,
  OptionalResponsibilityReview,
  PolicyPlanEditor,
  PolicyPlanSummary,
  SelectField,
  TextField,
  normalizeSuggestionQuery,
  renderHighlightedSuggestion,
} from '../../shared/customer-policy-components';

export function PolicyDetailSheet({
  policy,
  onClose,
  onRetryReport,
  retrying = false,
  onUpdatePolicy,
  onUpdateOptionalResponsibility,
  updating = false,
  onDeletePolicy,
  deleting = false,
  onEditCashValue,
}: {
  policy: Policy;
  onClose: () => void;
  onRetryReport?: (policy: Policy) => void | Promise<void>;
  retrying?: boolean;
  onUpdatePolicy?: (policy: Policy, data: PolicyFormData) => Promise<{ reportRegenerating: boolean } | void>;
  onUpdateOptionalResponsibility?: (policy: Policy, id: string, status: OptionalResponsibility['selectionStatus']) => void | Promise<void>;
  updating?: boolean;
  onDeletePolicy?: (policy: Policy) => void | Promise<void>;
  deleting?: boolean;
  onEditCashValue?: (policy: Policy) => void;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [customerSummary, setCustomerSummary] = useState<CustomerResponsibilitySummary | null>(null);
  const [customerSummaryLoading, setCustomerSummaryLoading] = useState(false);
  const [customerSummaryMessage, setCustomerSummaryMessage] = useState('');
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildPolicyReportTitle(policy);
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const optionalResponsibilities = Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : [];
  const exportControlTitle = getReportExportControlTitle();
  const cashValueSummary = summarizeCashValues(policy.cashValues);

  useEffect(() => {
    let cancelled = false;
    const company = String(policy.company || '').trim();
    const name = String(policy.name || '').trim();
    setCustomerSummary(null);
    setCustomerSummaryMessage('');
    if (!company || !name) {
      setCustomerSummaryLoading(false);
      setCustomerSummaryMessage('缺少保险公司或产品名称，暂无法生成客户版保险责任摘要。');
      return () => {
        cancelled = true;
      };
    }
    setCustomerSummaryLoading(true);
    getProductCustomerResponsibilitySummary({ company, name, plannerMode: 'auto' })
      .then((payload) => {
        if (cancelled) return;
        setCustomerSummary(payload.ok ? payload.summary : null);
        setCustomerSummaryMessage(payload.ok ? '' : (payload.message || '客户版保险责任摘要暂未生成，请稍后重试。'));
      })
      .catch(() => {
        if (cancelled) return;
        setCustomerSummary(null);
        setCustomerSummaryMessage('客户版保险责任摘要生成失败，请稍后重试。');
      })
      .finally(() => {
        if (!cancelled) setCustomerSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [policy.company, policy.id, policy.name]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-50">
      <header className="no-print sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-4">
        <button onClick={onClose} className="-ml-2 rounded-full p-2 text-slate-700 active:bg-slate-100" type="button">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-bold">保单详情</h1>
        <div className="flex items-center gap-2">
          {onUpdatePolicy ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={updating || deleting}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600 active:bg-slate-200 disabled:text-slate-300"
              aria-label="修改保单"
              title="修改保单"
            >
              <Pencil size={18} />
            </button>
          ) : null}
          {onDeletePolicy ? (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={updating || deleting}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600 active:bg-red-100 disabled:text-red-200"
              aria-label="删除保单"
              title="删除保单"
            >
              <Trash2 size={18} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void downloadReportPdf(reportRef.current, exportTitle)}
            disabled={reportGenerating}
            className={`flex h-10 w-10 items-center justify-center rounded-full active:bg-blue-100 ${
              reportGenerating ? 'bg-slate-100 text-slate-300' : 'bg-blue-50 text-blue-600'
            }`}
            aria-label={exportControlTitle}
            title={exportControlTitle}
          >
            <Download size={19} />
          </button>
        </div>
      </header>
      <main ref={reportRef} className="print-policy-report flex-1 overflow-y-auto p-4 pb-10">
        <section className="print-only">
          <h1>保单解析报告</h1>
          <p>生成时间：{generatedAt}</p>
        </section>

        <section className="rounded-[28px] bg-gradient-to-br from-blue-600 to-cyan-500 p-5 text-white shadow-[0_18px_40px_-18px_rgba(37,99,235,0.75)]">
          <p className="text-xs font-semibold text-white/70">{policy.company}</p>
          <h2 className="mt-2 text-2xl font-black leading-tight">{policy.name}</h2>
          {policy.report?.trim() ? (
            <div className="mt-3">
              <ReportText text={policy.report} compact inverted />
            </div>
          ) : (
            <p className="mt-3 text-sm font-semibold leading-6 text-white/85">{getReportPlaceholder(policy)}</p>
          )}
        </section>

        {onUpdatePolicy || onDeletePolicy ? (
          <section className="no-print mt-4 grid grid-cols-2 gap-3">
            {onUpdatePolicy ? (
              <button
                className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/20 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
                type="button"
                onClick={() => setEditing(true)}
                disabled={updating || deleting}
              >
                <Pencil size={18} />
                修改保单
              </button>
            ) : null}
            {onDeletePolicy ? (
              <button
                className="flex h-12 items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:bg-red-100 disabled:text-red-200"
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={updating || deleting}
              >
                <Trash2 size={18} />
                删除保单
              </button>
            ) : null}
          </section>
        ) : null}

        {reportGenerating || reportFailed ? (
          <section className={`mt-4 rounded-[22px] border px-4 py-3 ${
            reportFailed ? 'border-red-100 bg-red-50 text-red-700' : 'border-orange-100 bg-orange-50 text-orange-700'
          }`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black">{reportFailed ? '报告生成失败' : '报告正在后台生成'}</p>
                <p className="mt-1 text-xs font-medium leading-5">
                  {reportFailed ? policy.reportError || '可以稍后刷新查看，或重新生成报告。' : '保单信息已经保存，完整保险责任生成后会自动刷新。'}
                </p>
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

        <section className="mt-4 grid grid-cols-2 gap-3">
          <MetricBox label="被保人" value={policy.insured || '-'} />
          <MetricBox label="投保人" value={policy.applicant || '-'} />
          <MetricBox label="投保人生日" value={policy.applicantBirthday || '-'} />
          <MetricBox label="受益人" value={formatBeneficiaryValue(policy.beneficiary)} />
          <MetricBox label="受益人关系" value={policy.beneficiaryRelation || '-'} />
          <MetricBox label="受益人生日" value={policy.beneficiaryBirthday || '-'} />
          <MetricBox label="被保人生日" value={policy.insuredBirthday || '-'} />
          <MetricBox label="保单生效日期" value={formatDateLabel(policy.date)} />
          <MetricBox label="投保人与顶梁柱关系" value={policy.applicantRelation || '-'} />
          <MetricBox label="被保人与顶梁柱关系" value={policy.insuredRelation || '-'} />
        </section>

        {cashValueSummary || onEditCashValue ? (
          <section className={`mt-4 rounded-[22px] border px-4 py-3 ${
            cashValueSummary ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : 'border-blue-100 bg-blue-50 text-blue-800'
          }`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black">保单现金价值</p>
                <p className="mt-1 text-xs font-semibold leading-5">
                  {cashValueSummary
                    ? `已录入 ${cashValueSummary.count} 年现金价值，首年 ${formatCurrency(cashValueSummary.first.cashValue)}，${cashValueSummary.last.policyYear}年末 ${formatCurrency(cashValueSummary.last.cashValue)}。`
                    : '未录入现金价值。'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {cashValueSummary ? (
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-emerald-700">
                    已入库
                  </span>
                ) : null}
                {onEditCashValue ? (
                  <button
                    type="button"
                    className="no-print rounded-full bg-white px-3 py-1.5 text-xs font-black text-blue-700 ring-1 ring-blue-100 active:bg-blue-50"
                    onClick={() => onEditCashValue(policy)}
                  >
                    {cashValueSummary ? '修改现金价值' : '录入现金价值'}
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="print-only print-policy-section">
          <h2>保单信息</h2>
          <div className="print-policy-grid">
            <p><strong>保险公司：</strong>{policy.company || '-'}</p>
            <p><strong>产品名称：</strong>{policy.name || '-'}</p>
            <p><strong>投保人：</strong>{policy.applicant || '-'}</p>
            <p><strong>投保人生日：</strong>{policy.applicantBirthday || '-'}</p>
            <p><strong>受益人：</strong>{formatBeneficiaryValue(policy.beneficiary)}</p>
            <p><strong>受益人与顶梁柱的关系：</strong>{policy.beneficiaryRelation || '-'}</p>
            <p><strong>受益人生日：</strong>{policy.beneficiaryBirthday || '-'}</p>
            <p><strong>投保人与顶梁柱的关系：</strong>{policy.applicantRelation || '-'}</p>
            <p><strong>被保人：</strong>{policy.insured || '-'}</p>
            <p><strong>被保险人与顶梁柱的关系：</strong>{policy.insuredRelation || '-'}</p>
            <p><strong>被保险人生日：</strong>{policy.insuredBirthday || '-'}</p>
            <p><strong>生效日期：</strong>{policy.date || '-'}</p>
            <p><strong>缴费期间：</strong>{policy.paymentPeriod || '-'}</p>
            <p><strong>保障期间：</strong>{policy.coveragePeriod || '-'}</p>
            <p><strong>保障额度：</strong>{formatCoverageAmount(Number(policy.amount || 0))}</p>
            <p><strong>首期保费：</strong>{formatCurrency(Number(policy.firstPremium || 0))}</p>
          </div>
        </section>

        <PolicyPlanSummary
          plans={normalizePolicyPlanList(policy.plans, policy.company)}
          effectiveDate={policy.date}
          insuredBirthday={policy.insuredBirthday}
          paymentPeriod={policy.paymentPeriod}
          coveragePeriod={policy.coveragePeriod}
        />

        {optionalResponsibilities.length ? (
          <div className="mt-4">
            <OptionalResponsibilityReview
              items={optionalResponsibilities}
              disabled={updating || deleting}
              saving={updating}
              onChange={onUpdateOptionalResponsibility ? (id, status) => void onUpdateOptionalResponsibility(policy, id, status) : undefined}
              description="未投保或不确定的可选责任不会进入当前保单和家庭报告的量化计算。"
            />
          </div>
        ) : null}

        <section className="mt-4 space-y-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">保险责任</h3>
            <p className="mt-1 text-xs text-slate-500">以下内容来自官网保险责任摘要。</p>
          </div>
          {customerSummaryLoading ? (
            <article className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 text-sm font-semibold leading-6 text-slate-500">
              正在生成客户可读保险责任摘要...
            </article>
          ) : customerSummary ? (
            <CustomerResponsibilitySummaryCard summary={customerSummary} />
          ) : (
            <article className="rounded-[22px] border border-dashed border-[#D9E6F4] bg-white p-4 text-sm leading-6 text-slate-500">
              {customerSummaryMessage || (reportGenerating ? '正在生成客户可读保险责任摘要，请稍后。' : '暂无客户版保险责任摘要。')}
            </article>
          )}
        </section>

        <details className="no-print mt-4 rounded-xl border border-slate-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">查看原始 OCR 文本</summary>
          <pre className="mt-3 whitespace-pre-wrap break-all rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{policy.ocrText || '暂无 OCR 原文'}</pre>
        </details>
      </main>
      {editing && onUpdatePolicy ? (
        <PolicyEditDialog
          policy={policy}
          loading={updating}
          onClose={() => setEditing(false)}
          onSave={async (nextData) => {
            const result = await onUpdatePolicy(policy, nextData);
            if (result?.reportRegenerating) {
              setEditing(false);
              return;
            }
            setEditing(false);
          }}
        />
      ) : null}
      {confirmingDelete && onDeletePolicy ? (
        <PolicyDeleteDialog
          policy={policy}
          loading={deleting}
          onClose={() => setConfirmingDelete(false)}
          onConfirm={() => void onDeletePolicy(policy)}
        />
      ) : null}
    </div>
  );
}

function PolicyEditDialog({
  policy,
  loading,
  onClose,
  onSave,
}: {
  policy: Policy;
  loading: boolean;
  onClose: () => void;
  onSave: (data: PolicyFormData) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PolicyFormData>(() => policyToForm(policy));
  const [companyFocused, setCompanyFocused] = useState(false);
  const [productFocused, setProductFocused] = useState(false);
  const [editCompanySuggestions, setEditCompanySuggestions] = useState<PolicyCompanySuggestion[]>([]);
  const [editCompanySuggestionLoading, setEditCompanySuggestionLoading] = useState(false);
  const [editProductSuggestions, setEditProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [editProductSuggestionLoading, setEditProductSuggestionLoading] = useState(false);
  const [editPlanProductSuggestions, setEditPlanProductSuggestions] = useState<PolicyProductSuggestion[]>([]);
  const [editPlanProductSuggestionLoading, setEditPlanProductSuggestionLoading] = useState(false);
  const [editPlanProductQuery, setEditPlanProductQuery] = useState<{ index: number | null; company: string; q: string }>({
    index: null,
    company: '',
    q: '',
  });
  const updateDraft = (key: keyof PolicyFormData, value: string) => {
    setDraft((current) => ({ ...current, [key]: key === 'amount' || key === 'firstPremium' ? sanitizeAmount(value) : value }));
  };
  const updateDraftPlan = (index: number, key: string, value: string) => {
    setDraft((current) => {
      const plans = normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true });
      const existing = plans[index];
      if (!existing) return current;
      const nextPlans = plans.map((plan, planIndex) => (
        planIndex === index
          ? {
              ...plan,
              [key]: key === 'amount' || key === 'premium' ? sanitizeAmount(value) : value,
              ...(key === 'name' ? { matchedProductName: '', canonicalProductId: '' } : {}),
            }
          : plan
      ));
      return { ...current, plans: nextPlans };
    });
  };
  const addDraftPlan = () => {
    setDraft((current) => ({
      ...current,
      plans: [
        ...normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true }),
        {
          company: current.company,
          role: 'rider',
          name: '',
          matchedProductName: '',
          productType: '',
          amount: '',
          coveragePeriod: '',
          paymentMode: '',
          paymentPeriod: '',
          premium: '',
          premiumText: '',
          matchScore: 0,
          matchReason: '',
        },
      ],
    }));
  };
  const removeDraftPlan = (index: number) => {
    setDraft((current) => {
      const nextPlans = normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true })
        .filter((_, planIndex) => planIndex !== index);
      return { ...current, plans: nextPlans };
    });
    setEditPlanProductQuery((current) => (current.index === index ? { index: null, company: '', q: '' } : current));
  };
  const selectDraftPlanProduct = (index: number, suggestion: PolicyProductSuggestion) => {
    setDraft((current) => {
      const plans = normalizePolicyPlanList(current.plans, current.company, { keepEmpty: true });
      const existing = plans[index];
      if (!existing) return current;
      const nextPlans = plans.map((plan, planIndex) => (
        planIndex === index
          ? {
              ...plan,
              company: suggestion.company.trim(),
              name: suggestion.productName.trim(),
              matchedProductName: suggestion.productName.trim(),
              canonicalProductId: String(suggestion.canonicalProductId || '').trim(),
            }
          : plan
      ));
      return { ...current, plans: nextPlans };
    });
    setEditPlanProductQuery({ index: null, company: '', q: '' });
    setEditPlanProductSuggestions([]);
  };
  const canSave = Boolean(draft.company.trim() && draft.name.trim());
  const companyQuery = draft.company.trim();
  const productQuery = draft.name.trim();
  const visibleCompanySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSuggestionQuery(companyQuery);
    if (!normalizedQuery) return [];
    return editCompanySuggestions
      .filter((suggestion) => normalizeSuggestionQuery(suggestion.company) !== normalizedQuery)
      .slice(0, 8);
  }, [companyQuery, editCompanySuggestions]);
  const visibleProductSuggestions = useMemo(() => {
    if (!normalizeSuggestionQuery(companyQuery)) return [];
    return editProductSuggestions
      .slice(0, 8);
  }, [companyQuery, editProductSuggestions]);
  const showCompanySuggestions = companyFocused && companyQuery && (editCompanySuggestionLoading || visibleCompanySuggestions.length);
  const showProductSuggestions = productFocused && companyQuery && (editProductSuggestionLoading || visibleProductSuggestions.length);

  useEffect(() => {
    const q = draft.company.trim();
    if (!q) {
      setEditCompanySuggestions([]);
      setEditCompanySuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setEditCompanySuggestions([]);
      setEditCompanySuggestionLoading(true);
      listPolicyResponsibilityCompanySuggestions({ q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setEditCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setEditCompanySuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setEditCompanySuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft.company]);

  useEffect(() => {
    const company = draft.company.trim();
    const q = draft.name.trim();
    if (!company) {
      setEditProductSuggestions([]);
      setEditProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setEditProductSuggestions([]);
      setEditProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setEditProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setEditProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setEditProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft.company, draft.name]);

  useEffect(() => {
    const index = editPlanProductQuery.index;
    const company = editPlanProductQuery.company.trim();
    const q = editPlanProductQuery.q.trim();
    if (index === null || !company) {
      setEditPlanProductSuggestions([]);
      setEditPlanProductSuggestionLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setEditPlanProductSuggestions([]);
      setEditPlanProductSuggestionLoading(true);
      listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
        .then((payload) => {
          if (!cancelled) setEditPlanProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
        })
        .catch(() => {
          if (!cancelled) setEditPlanProductSuggestions([]);
        })
        .finally(() => {
          if (!cancelled) setEditPlanProductSuggestionLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editPlanProductQuery]);

  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="max-h-[88vh] w-full overflow-y-auto rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-2xl">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-slate-950">修改保单</h2>
            <p className="mt-1 text-xs font-bold leading-5 text-slate-500">修改保险公司或产品名称后会重新生成保险责任。</p>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭修改"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <label className="relative block">
            <span className="mb-1.5 block text-sm font-bold text-slate-700">保险公司</span>
            <input
              value={draft.company}
              onChange={(event) => updateDraft('company', event.target.value)}
              onFocus={() => setCompanyFocused(true)}
              onBlur={() => window.setTimeout(() => setCompanyFocused(false), 120)}
              placeholder="输入保险公司，可模糊匹配"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
            />
            {showCompanySuggestions ? (
              <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="修改保险公司候选">
                {editCompanySuggestionLoading ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载保险公司
                  </div>
                ) : (
                  visibleCompanySuggestions.map((suggestion) => (
                    <button
                      key={suggestion.company}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDraft((current) => ({ ...current, company: suggestion.company }));
                        setCompanyFocused(false);
                      }}
                    >
                      <span className="min-w-0 truncate">{renderHighlightedSuggestion(suggestion.company, companyQuery)}</span>
                      <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </label>
          <label className="relative block">
            <span className="mb-1.5 block text-sm font-bold text-slate-700">保险产品</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft('name', event.target.value)}
              onFocus={() => setProductFocused(true)}
              onBlur={() => window.setTimeout(() => setProductFocused(false), 120)}
              placeholder="输入保险产品，可模糊匹配"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
            />
            {showProductSuggestions ? (
              <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-[0_18px_45px_-24px_rgba(15,23,42,0.45)]" role="listbox" aria-label="修改保险产品候选">
                {editProductSuggestionLoading ? (
                  <div className="flex items-center gap-2 px-3 py-3 text-xs font-black text-blue-600">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载保险产品
                  </div>
                ) : (
                  visibleProductSuggestions.map((suggestion) => (
                    <button
                      key={`${suggestion.company}-${suggestion.productName}`}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-black text-slate-900 transition hover:bg-blue-50 active:bg-blue-100"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setDraft((current) => ({
                          ...current,
                          company: suggestion.company,
                          name: suggestion.productName,
                        }));
                        setProductFocused(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{renderHighlightedSuggestion(suggestion.productName, productQuery)}</span>
                        <span className="mt-0.5 block truncate text-[11px] font-bold text-slate-400">{suggestion.company}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-black text-slate-400">{suggestion.recordCount} 份资料</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="投保人" value={draft.applicant} onChange={(value) => updateDraft('applicant', value)} placeholder="投保人姓名" />
            <TextField label="被保人" value={draft.insured} onChange={(value) => updateDraft('insured', value)} placeholder="被保人姓名" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="投保人生日" type="date" value={draft.applicantBirthday || ''} onChange={(value) => updateDraft('applicantBirthday', value)} />
            <TextField label="被保人生日" type="date" value={draft.insuredBirthday || ''} onChange={(value) => updateDraft('insuredBirthday', value)} />
          </div>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            <label className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-slate-700">法定受益人</span>
              <input
                type="checkbox"
                checked={draft.beneficiary === '法定'}
                onChange={(event) => updateDraft('beneficiary', event.target.checked ? '法定' : '')}
                className="h-5 w-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </label>
            {draft.beneficiary === '法定' ? (
              <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700">受益人：法定</div>
            ) : (
              <TextField label="受益人姓名" value={draft.beneficiary} onChange={(value) => updateDraft('beneficiary', value)} placeholder="请输入受益人姓名" />
            )}
            <SelectField label="与顶梁柱的关系" value={draft.beneficiaryRelation || ''} onChange={(value) => updateDraft('beneficiaryRelation', value)} options={POLICY_PERSON_RELATION_OPTIONS} />
            <TextField label="受益人生日" type="date" value={draft.beneficiaryBirthday || ''} onChange={(value) => updateDraft('beneficiaryBirthday', value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="投保人与顶梁柱关系" value={draft.applicantRelation} onChange={(value) => updateDraft('applicantRelation', value)} options={POLICY_PERSON_RELATION_OPTIONS} />
            <SelectField label="被保人与顶梁柱关系" value={draft.insuredRelation} onChange={(value) => updateDraft('insuredRelation', value)} options={POLICY_PERSON_RELATION_OPTIONS} />
          </div>
          <div className="grid grid-cols-1 gap-3">
            <TextField label="身份证号" value={draft.insuredIdNumber || ''} onChange={(value) => updateDraft('insuredIdNumber', value)} placeholder="被保人证件号" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="生效日期" type="date" value={draft.date} onChange={(value) => updateDraft('date', value)} />
            <CoveragePeriodField label="保障期间" value={draft.coveragePeriod} onChange={(value) => updateDraft('coveragePeriod', value)} placeholder="如 终身、30年、至70岁" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PaymentPeriodField label="缴费期间" value={draft.paymentPeriod} onChange={(value) => updateDraft('paymentPeriod', value)} placeholder="如 10年交 或 趸交" />
            <TextField label="首期保费 (元)" value={draft.firstPremium} onChange={(value) => updateDraft('firstPremium', value)} inputMode="decimal" placeholder="0.00" />
          </div>
          <TextField label="保障额度 (元)" value={draft.amount} onChange={(value) => updateDraft('amount', value)} inputMode="decimal" placeholder="0.00" />
          <PolicyPlanEditor
            company={draft.company}
            plans={normalizePolicyPlanList(draft.plans, draft.company, { keepEmpty: true })}
            optionalResponsibilities={policy.optionalResponsibilities || []}
            productSuggestionLoading={editPlanProductSuggestionLoading}
            productSuggestions={editPlanProductSuggestions}
            productSuggestionTargetIndex={editPlanProductQuery.index}
            onAdd={addDraftPlan}
            onRemove={removeDraftPlan}
            onUpdate={updateDraftPlan}
            onSelectProduct={selectDraftPlanProduct}
            onUpdateProductQuery={(index, company, q) => setEditPlanProductQuery({ index, company, q })}
          />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            className="flex h-12 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-600 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25 disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
            type="button"
            disabled={loading || !canSave}
            onClick={() => void onSave(draft)}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            保存
          </button>
        </div>
      </section>
    </div>
  );
}

function PolicyDeleteDialog({
  policy,
  loading,
  onClose,
  onConfirm,
}: {
  policy: Policy;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[85] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600">
            <Trash2 size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-black text-slate-950">删除保单</h2>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-500">{policy.name}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            className="flex h-12 items-center justify-center rounded-xl bg-slate-100 text-sm font-black text-slate-600 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-black text-white shadow-lg shadow-red-600/20 disabled:bg-red-200 disabled:shadow-none"
            type="button"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
            删除
          </button>
        </div>
      </section>
    </div>
  );
}

export type PolicyDetailSheetProps = Parameters<typeof PolicyDetailSheet>[0];
