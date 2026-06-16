import { useEffect, useState } from 'react';
import { CustomerApp } from './apps/customer/CustomerApp';
import { AdminApp } from './apps/admin/AdminApp';
import { getFamilyReportShare } from './api';
import { FamilyReportPage } from './FamilyReport';
import { buildFamilyReport } from './family-report-engine.mjs';
import type { FamilyReport } from './family-report-engine.mjs';
import { downloadReportImage } from './features/report-export/report-export';

export default function App() {
  if (window.location.pathname.startsWith('/admin')) {
    return <AdminApp />;
  }
  const shareToken = familyShareTokenFromHash(window.location.hash);
  if (shareToken) {
    return <SharedFamilyReportApp shareToken={shareToken} />;
  }
  return <CustomerApp />;
}

function familyShareTokenFromHash(hash: string) {
  const match = hash.match(/^#\/family-share\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function SharedFamilyReportApp({ shareToken }: { shareToken: string }) {
  const [sharedFamilyReport, setSharedFamilyReport] = useState<{
    loading: boolean;
    message: string;
    report: FamilyReport | null;
  }>({
    loading: true,
    message: '正在加载家庭分享报告',
    report: null,
  });

  useEffect(() => {
    let active = true;
    async function loadFamilyShare() {
      try {
        const payload = await getFamilyReportShare(shareToken);
        const familyId = Number(payload.family?.id || 0) || null;
        const report = buildFamilyReport(payload.policies || [], {}, { familyId });
        if (active) setSharedFamilyReport({ loading: false, message: '', report });
      } catch (error) {
        if (active) {
          setSharedFamilyReport({
            loading: false,
            message: error instanceof Error ? error.message : '分享报告不存在',
            report: null,
          });
        }
      }
    }
    void loadFamilyShare();
    return () => {
      active = false;
    };
  }, [shareToken]);

  function backToEntry() {
    window.location.href = `${window.location.origin}${window.location.pathname}`;
  }

  if (sharedFamilyReport.loading || !sharedFamilyReport.report) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-center">
        <div>
          <p className="text-base font-black text-slate-950">{sharedFamilyReport.message}</p>
          {!sharedFamilyReport.loading ? (
            <button
              type="button"
              className="mt-4 rounded-full bg-blue-500 px-4 py-2 text-sm font-black text-white"
              onClick={backToEntry}
            >
              返回录入页
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <FamilyReportPage
      report={sharedFamilyReport.report}
      planningProfile={{}}
      onPlanningProfileChange={() => {}}
      onBack={backToEntry}
      onExport={(target, title) => void downloadReportImage(target, title)}
      readOnly
    />
  );
}
