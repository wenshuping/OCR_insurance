import type { OptionalResponsibility, Policy, PolicyFormData, ResponsibilityCard } from '../api';
import { hasQuantifiedCalculationSignal } from '../indicator-calculation.mjs';

export type ResponsibilitySourceLink = {
  title: string;
  url: string;
  official: boolean;
  sourceType?: string;
  sourceExcerpt?: string;
  sourceKind?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
};

export function formatSourceUrlHost(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch (_error) {
    return url;
  }
}

export function getPolicyResponsibilitySourceLinks(policy: Policy): ResponsibilitySourceLink[] {
  const links: ResponsibilitySourceLink[] = [];
  const seenUrls = new Set<string>();
  const pushLink = (source: { title?: string; url?: string; official?: boolean; evidenceLabel?: string; evidenceLevel?: string; sourceKind?: string; verificationStatus?: string; verificationLabel?: string; referenceOnly?: boolean; sourceType?: string; sourceExcerpt?: string; liability?: string; productName?: string } | null | undefined) => {
    const url = String(source?.url || '').trim();
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    const referenceOnly = source?.referenceOnly === true || String(source?.verificationStatus || '') === 'pending_review';
    const official = !referenceOnly && (Boolean(source?.official) || String(source?.evidenceLevel || '') === 'insurer_official' || String(source?.sourceKind || '') === 'customer_policy_terms');
    links.push({
      title: String(source?.title || source?.liability || source?.productName || formatSourceUrlHost(url)).trim(),
      url,
      official,
      sourceType: source?.sourceType,
      sourceExcerpt: source?.sourceExcerpt,
      sourceKind: source?.sourceKind,
      evidenceLabel: source?.verificationLabel || source?.evidenceLabel,
      evidenceLevel: source?.evidenceLevel,
      verificationStatus: source?.verificationStatus,
      verificationLabel: source?.verificationLabel,
      referenceOnly,
    });
  };

  (policy.sources || []).forEach(pushLink);
  getVisibleResponsibilityCards(policy.responsibilityCards || [], policy.optionalResponsibilities || []).forEach((card) => {
    pushLink({
      title: card.sourceTitle || card.title,
      url: card.sourceUrl,
      official: card.official,
      sourceKind: card.sourceKind,
      evidenceLabel: card.evidenceLabel,
      evidenceLevel: card.evidenceLevel,
      verificationStatus: card.verificationStatus,
      verificationLabel: card.verificationLabel,
      referenceOnly: card.referenceOnly,
      sourceExcerpt: card.sourceExcerpt,
    });
    (card.indicators || []).forEach((indicator) => {
      pushLink({
        title: indicator.liability || card.title,
        url: indicator.sourceUrl,
        official: indicator.official,
        sourceKind: indicator.sourceKind,
        evidenceLabel: indicator.evidenceLabel,
        evidenceLevel: indicator.evidenceLevel,
        verificationStatus: indicator.verificationStatus,
        verificationLabel: indicator.verificationLabel,
        referenceOnly: indicator.referenceOnly,
        sourceExcerpt: indicator.sourceExcerpt,
      });
    });
  });
  (policy.coverageIndicators || []).forEach((indicator) => {
    pushLink({
      title: indicator.liability || indicator.productName,
      url: indicator.sourceUrl,
      official: indicator.official,
      sourceKind: indicator.sourceKind,
      evidenceLabel: indicator.evidenceLabel,
      evidenceLevel: indicator.evidenceLevel,
      verificationStatus: indicator.verificationStatus,
      verificationLabel: indicator.verificationLabel,
      referenceOnly: indicator.referenceOnly,
      sourceExcerpt: indicator.sourceExcerpt,
    });
  });
  (policy.responsibilities || []).forEach((responsibility) => {
    pushLink({
      title: responsibility.sourceTitle || responsibility.coverageType,
      url: responsibility.sourceUrl,
      official: responsibility.official,
      sourceKind: responsibility.sourceKind,
      evidenceLabel: responsibility.evidenceLabel,
      evidenceLevel: responsibility.evidenceLevel,
      verificationStatus: responsibility.verificationStatus,
      verificationLabel: responsibility.verificationLabel,
      referenceOnly: responsibility.referenceOnly,
    });
  });

  return links
    .sort((left, right) => Number(right.official) - Number(left.official))
    .slice(0, 5);
}

export function getPolicyReportStatus(policy: Policy | null | undefined) {
  return String(policy?.reportStatus || 'ready');
}

export function isPolicyReportGenerating(policy: Policy | null | undefined) {
  return getPolicyReportStatus(policy) === 'generating';
}

export function isPolicyReportFailed(policy: Policy | null | undefined) {
  return getPolicyReportStatus(policy) === 'failed';
}

export function getReportPlaceholder(policy: Policy) {
  if (isPolicyReportGenerating(policy)) return '报告正在生成中。保单已经保存，完整保险责任会自动刷新。';
  if (isPolicyReportFailed(policy)) return policy.reportError || '报告生成失败，请稍后重新生成或联系管理员。';
  const responsibilityCount = Array.isArray(policy.responsibilities) ? policy.responsibilities.length : 0;
  return policy.report || (responsibilityCount ? `已生成 ${responsibilityCount} 项保险责任。` : '暂无保险责任解析。');
}

export function splitReportIntoParagraphs(value: string) {
  const raw = String(value || '').replace(/\r/g, '').trim();
  if (!raw) return ['暂无解析报告'];
  const normalized = raw
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([。！？!?；;])\s*(?=(保险责任|基本|特定|此外|保单|给付系数|红利|若|该产品|产品|保障))/g, '$1\n\n')
    .replace(/\s*(?=([一二三四五六七八九十]+[、.]|\d+、|\d+\.\s))/g, '\n\n');

  return normalized
    .split(/\n{1,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      if (paragraph.length <= 120) return [paragraph];
      const sentences = paragraph.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [paragraph];
      const groups: string[] = [];
      let current = '';
      for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
        if (current && `${current}${sentence}`.length > 140) {
          groups.push(current);
          current = sentence;
        } else {
          current = `${current}${sentence}`;
        }
      }
      if (current) groups.push(current);
      return groups;
    });
}

export function buildDraftReportTitle(formData: PolicyFormData) {
  return `${formData.insured || '客户'}-${formData.name || '保单'}-解析报告`;
}

export function buildPolicyReportTitle(policy: Policy) {
  return `${policy.insured || '客户'}-${policy.name || '保单'}-解析报告`;
}

function normalizeResponsibilityText(value: unknown) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

function responsibilityCardTitle(card: ResponsibilityCard) {
  return String(card.title || card.category || '保险责任').trim();
}

function responsibilityCardProductName(card: ResponsibilityCard) {
  return String(card.productName || '').trim();
}

function responsibilityCardVerificationLabel(card: ResponsibilityCard) {
  if (card.referenceOnly || card.verificationStatus === 'pending_review') return card.verificationLabel || '待核实参考';
  if (card.sourceKind === 'customer_policy_terms') return card.verificationLabel || '客户上传保单责任页/合同页';
  if (card.verificationLabel) return card.verificationLabel;
  return '';
}

function quantifiedIndicatorText(indicator: NonNullable<ResponsibilityCard['indicators']>[number]) {
  const formula = String(indicator.formulaText || '').trim();
  if (formula) return formula;
  return [indicator.basis, indicator.value, indicator.unit].filter((value) => value !== null && value !== undefined && String(value).trim()).join(' × ');
}

function optionalResponsibilityTitle(item: OptionalResponsibility) {
  return String(item.liability || item.title || item.coverageType || '').trim();
}

function optionalResponsibilityMatchesCard(item: OptionalResponsibility, card: ResponsibilityCard) {
  const cardProduct = normalizeResponsibilityText(responsibilityCardProductName(card));
  const itemProduct = normalizeResponsibilityText(item.productName);
  if (cardProduct && itemProduct && cardProduct !== itemProduct) return false;
  const cardTitle = normalizeResponsibilityText(responsibilityCardTitle(card));
  const itemTitle = normalizeResponsibilityText(optionalResponsibilityTitle(item));
  return Boolean(cardTitle && itemTitle && (cardTitle === itemTitle || cardTitle.includes(itemTitle) || itemTitle.includes(cardTitle)));
}

type CardSelectionStatusSource = ResponsibilityCard & { selectionStatus?: string };

function responsibilityCardSelectionStatus(card: ResponsibilityCard, optionalResponsibilities: OptionalResponsibility[] = []) {
  const indicatorStatuses = (card.indicators || [])
    .map((indicator) => String(indicator.selectionStatus || '').trim())
    .filter(Boolean);
  if (indicatorStatuses.includes('selected')) return 'selected';
  if (indicatorStatuses.includes('not_selected')) return 'not_selected';
  if (indicatorStatuses.includes('unknown')) return 'unknown';

  const matched = optionalResponsibilities.find((item) => optionalResponsibilityMatchesCard(item, card));
  if (matched?.selectionStatus) return matched.selectionStatus;
  return String((card as CardSelectionStatusSource).selectionStatus || '').trim();
}

export function getVisibleResponsibilityCards(
  cards: ResponsibilityCard[] = [],
  optionalResponsibilities: OptionalResponsibility[] = [],
) {
  return (Array.isArray(cards) ? cards : []).filter((card) => {
    const status = responsibilityCardSelectionStatus(card, optionalResponsibilities);
    return !status || status === 'selected';
  });
}

export function ResponsibilityCardList({
  cards = [],
  optionalResponsibilities = [],
  baseAmount = 0,
  firstPremium = 0,
}: {
  cards?: ResponsibilityCard[];
  optionalResponsibilities?: OptionalResponsibility[];
  baseAmount?: string | number;
  firstPremium?: string | number;
}) {
  const visibleCards = getVisibleResponsibilityCards(cards, optionalResponsibilities);
  if (!visibleCards.length) return null;

  return (
    <>
      {visibleCards.map((card, index) => {
        const title = responsibilityCardTitle(card);
        const meta = [card.productName, card.category].filter(Boolean).join(' · ');
        const summary = String(card.plainSummary || card.triggerCondition || '').trim();
        const payout = String(card.payoutSummary || '').trim();
        const quantifiedIndicators = (card.indicators || [])
          .map((indicator) => ({ indicator, formula: quantifiedIndicatorText(indicator) }))
          .filter(({ indicator, formula }) => hasQuantifiedCalculationSignal([
            indicator.liability,
            formula,
            indicator.condition,
            indicator.sourceExcerpt,
          ].filter(Boolean).join(' ')));
        const quantifiedText = quantifiedIndicators.map(({ formula, indicator }) => `${indicator.liability || ''} ${formula}`).join(' ');
        const usesPolicyAmount = /(?:基本责任保险金额|基本保险金额|基本保险金|基本保额|有效保险金额|保险金额|保额)/u.test(quantifiedText);
        const usesPolicyPremium = /(?:首期保费|首年保费|年交保费|已交保费|所交保费|保险费|保费)/u.test(quantifiedText);
        const verificationLabel = responsibilityCardVerificationLabel(card);
        return (
          <article key={card.id || `${title}-${index}`} className="rounded-[22px] border border-[#D9E6F4] bg-white p-4 shadow-[0_18px_34px_-30px_rgba(15,23,42,0.16)]">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-[#EEF6FF] text-sm font-black text-blue-600">
                {index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="break-words text-lg font-black leading-7 text-slate-950">{title}</h4>
                    {meta ? <p className="mt-0.5 text-xs font-bold leading-5 text-slate-500">{meta}</p> : null}
                  </div>
                  {verificationLabel ? (
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black ${
                      card.referenceOnly || card.verificationStatus === 'pending_review'
                        ? 'bg-amber-50 text-amber-700'
                        : card.sourceKind === 'customer_policy_terms'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-blue-50 text-blue-700'
                    }`}>
                      {verificationLabel}
                    </span>
                  ) : null}
                </div>
                {summary ? <p className="mt-2 whitespace-pre-wrap text-base leading-7 text-slate-500">{summary}</p> : null}
                {payout ? <p className="mt-2 rounded-xl bg-[#F8FBFF] px-3 py-2 text-base font-bold leading-7 text-blue-700">{payout}</p> : null}
                {quantifiedIndicators.length ? (
                  <div className="mt-2 rounded-xl bg-blue-50 px-3 py-2 ring-1 ring-blue-100">
                    <p className="text-xs font-black text-blue-700">量化指标（{quantifiedIndicators.length}项）</p>
                    {usesPolicyAmount && Number(baseAmount) > 0 ? (
                      <p className="mt-1 text-xs font-black text-cyan-800">本保单保险金额：{Number(baseAmount).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 })}</p>
                    ) : null}
                    {usesPolicyPremium && Number(firstPremium) > 0 ? (
                      <p className="mt-1 text-xs font-black text-cyan-800">本保单首期保费：{Number(firstPremium).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 })}</p>
                    ) : null}
                    <div className="mt-1.5 space-y-1">
                      {quantifiedIndicators.map(({ indicator, formula }, indicatorIndex) => (
                        <p key={indicator.id || `${indicator.liability}-${indicatorIndex}`} className="text-xs font-bold leading-5 text-slate-600">
                          {indicator.liability || indicator.coverageType || '保险责任'}{formula ? `：${formula}` : ''}
                        </p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        );
      })}
    </>
  );
}

export function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-[88px] flex-col justify-between rounded-[18px] border border-[#E4ECF8] bg-[#F8FBFF] px-4 py-3.5">
      <p className="text-[12px] font-medium leading-none text-[#8EA3BB]">{label}</p>
      <p className="mt-3 break-words text-[18px] font-semibold leading-7 text-[#0F172A]">{value}</p>
    </div>
  );
}

export function ReportText({
  text,
  compact = false,
  inverted = false,
}: {
  text: string;
  compact?: boolean;
  inverted?: boolean;
}) {
  const paragraphs = splitReportIntoParagraphs(text);
  const paragraphClassName = inverted
    ? compact
      ? 'break-words text-base leading-7 text-white/80'
      : 'break-words text-lg leading-9 text-white/85'
    : compact
      ? 'break-words text-base leading-7 text-slate-600'
      : 'break-words text-lg leading-9 text-slate-700';

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {paragraphs.map((paragraph, index) => (
        <p key={`${paragraph.slice(0, 24)}-${index}`} className={paragraphClassName}>
          {paragraph}
        </p>
      ))}
    </div>
  );
}
