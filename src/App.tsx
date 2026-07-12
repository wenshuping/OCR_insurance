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
  const uploadToken = policyUploadTokenFromHash(window.location.hash);
  if (uploadToken) return <DelegatedPolicyUploadApp token={uploadToken} />;
  return <CustomerApp />;
}

function policyUploadTokenFromHash(hash: string) {
  const match = hash.match(/^#\/policy-upload\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function DelegatedPolicyUploadApp({ token }: { token: string }) {
  const [message, setMessage] = useState('正在验证安全上传链接');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    fetch(`/api/policy-upload-links/${encodeURIComponent(token)}`)
      .then(async (response) => { if (!response.ok) throw new Error('上传链接无效或已过期'); return response.json(); })
      .then(() => { setReady(true); setMessage('请选择客户保单图片或 PDF'); })
      .catch((error) => setMessage(error instanceof Error ? error.message : '上传链接不可用'));
  }, [token]);
  async function upload(file: File) {
    setMessage('正在上传并识别，请勿关闭页面');
    const uploadItem = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file);
    });
    const response = await fetch(`/api/policy-upload-links/${encodeURIComponent(token)}/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ uploadItem, name: 'customer-policy', mediaType: file.type }] }) });
    if (!response.ok) throw new Error('上传或识别失败，请检查文件后重试');
    const payload = await response.json();
    setMessage(`上传成功，已识别 ${payload.task?.documentSummary?.count || 1} 份资料。顾问将在系统中完成确认。`);
  }
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl"><h1 className="text-xl font-black text-slate-950">安全补充保单</h1><p className="mt-3 text-sm text-slate-600">文件直接进入 OCR Insurance，不经过钉钉聊天或 Hermes。</p><p className="mt-5 rounded-2xl bg-blue-50 p-4 text-sm font-bold text-blue-900">{message}</p>{ready ? <input className="mt-5 block w-full text-sm" type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file).catch((error) => setMessage(error.message)); }} /> : null}</div></div>;
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
