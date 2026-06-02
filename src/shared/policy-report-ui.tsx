import type { Policy, PolicyFormData } from '../api';

export type ResponsibilitySourceLink = {
  title: string;
  url: string;
  official: boolean;
  sourceType?: string;
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
  const pushLink = (source: { title?: string; url?: string; official?: boolean; evidenceLevel?: string; sourceType?: string; liability?: string; productName?: string } | null | undefined) => {
    const url = String(source?.url || '').trim();
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    links.push({
      title: String(source?.title || source?.liability || source?.productName || formatSourceUrlHost(url)).trim(),
      url,
      official: Boolean(source?.official) || String(source?.evidenceLevel || '') === 'insurer_official',
      sourceType: source?.sourceType,
    });
  };

  (policy.sources || []).forEach(pushLink);
  (policy.coverageIndicators || []).forEach((indicator) => {
    pushLink({
      title: indicator.liability || indicator.productName,
      url: indicator.sourceUrl,
      official: true,
      evidenceLevel: 'insurer_official',
    });
  });
  (policy.responsibilities || []).forEach((responsibility) => {
    pushLink({
      title: responsibility.sourceTitle || responsibility.coverageType,
      url: responsibility.sourceUrl,
      official: true,
      evidenceLevel: 'insurer_official',
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
