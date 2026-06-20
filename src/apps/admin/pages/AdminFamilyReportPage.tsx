import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FamilyPlanningProfile } from '../../../family-report-engine.mjs';
import { FamilyReportPage } from '../../../FamilyReport';
import { downloadReportImage } from '../../../features/report-export/report-export';
import type { FamilyReportRecord } from '../../../api';

const readOnlyPlanningProfile: FamilyPlanningProfile = {};

export function AdminFamilyReportPage({
  reportRecord,
  familyName,
  loading,
  generating,
  onBack,
  onGenerate,
}: {
  reportRecord: FamilyReportRecord | null;
  familyName: string;
  loading: boolean;
  generating: boolean;
  onBack: () => void;
  onGenerate: () => void;
}) {
  if (loading) {
    return (
      <AdminFamilyReportShell familyName={familyName} onBack={onBack}>
        <p className="rounded-2xl bg-white px-4 py-12 text-center text-sm font-black text-slate-400 ring-1 ring-slate-200">正在读取家庭保单分析报告</p>
      </AdminFamilyReportShell>
    );
  }

  if (!reportRecord?.report) {
    return (
      <AdminFamilyReportShell familyName={familyName} onBack={onBack}>
        <div className="rounded-2xl bg-white px-4 py-12 text-center ring-1 ring-slate-200">
          <p className="text-sm font-black text-slate-400">暂无已保存家庭保单分析报告</p>
          <button
            type="button"
            className="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white transition hover:bg-blue-700 disabled:opacity-60"
            disabled={generating}
            onClick={onGenerate}
          >
            {generating ? '正在生成...' : '生成家庭保单分析报告'}
          </button>
        </div>
      </AdminFamilyReportShell>
    );
  }

  return (
    <FamilyReportPage
      report={reportRecord.report}
      planningProfile={readOnlyPlanningProfile}
      onPlanningProfileChange={() => {}}
      onBack={onBack}
      onExport={(target, title) => void downloadReportImage(target, title)}
      readOnly
    />
  );
}

function AdminFamilyReportShell({
  familyName,
  onBack,
  children,
}: {
  familyName: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-5xl overflow-hidden rounded-[18px] border border-slate-200 bg-slate-50 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
      <header className="border-b border-blue-100 bg-blue-950 px-5 py-5 text-white">
        <button
          type="button"
          className="mb-4 flex items-center gap-2 rounded-xl bg-blue-900/80 px-3 py-2 text-xs font-black text-blue-100 ring-1 ring-blue-300/25"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
          返回用户家庭
        </button>
        <p className="text-[11px] font-black uppercase text-blue-200">Family Policy Dossier</p>
        <h2 className="mt-1 text-xl font-black leading-tight">家庭保单分析报告</h2>
        <p className="mt-1 truncate text-xs font-semibold text-slate-300">{familyName || '当前家庭'}</p>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
