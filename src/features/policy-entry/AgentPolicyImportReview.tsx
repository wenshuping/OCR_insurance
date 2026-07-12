import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  applyPolicyImportAction,
  finalizePolicyImport,
  getPolicyImport,
  listFamilyProfiles,
  type PolicyImportTask,
} from '../../api';

type Props = {
  taskId: number;
  token: string;
  onBack: () => void;
};

const PROCESSING_STATES = new Set(['uploading', 'recognizing', 'saving']);
const FIELD_LABELS: Record<string, string> = {
  company: '保险公司',
  name: '产品名称',
  applicant: '投保人',
  insured: '被保人',
  date: '生效日期',
  paymentPeriod: '缴费期间',
  coveragePeriod: '保障期间',
  amount: '保额',
  firstPremium: '首期保费',
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '任务加载失败，请稍后重试';
}

export function AgentPolicyImportReview({ taskId, token, onBack }: Props) {
  const [task, setTask] = useState<PolicyImportTask | null>(null);
  const [familyId, setFamilyId] = useState<number | null>(null);
  const [message, setMessage] = useState('正在加载跨渠道保单任务');
  const [busy, setBusy] = useState(false);
  const [policyId, setPolicyId] = useState<number | null>(null);
  const pollAttemptRef = useRef(0);
  const requestIdRef = useRef(`web-review-${taskId}-${crypto.randomUUID?.() || Date.now()}`);

  const loadTask = useCallback(async () => {
    const families = (await listFamilyProfiles({ token })).families;
    for (const family of families) {
      try {
        const payload = await getPolicyImport({ token, familyId: family.id, taskId });
        setFamilyId(family.id);
        setTask(payload.task);
        setPolicyId(null);
        setMessage('已加载最新任务状态');
        return payload.task;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
    }
    throw new Error('没有找到可访问的保单导入任务');
  }, [taskId, token]);

  useEffect(() => {
    let active = true;
    void loadTask().catch((error) => {
      if (active) setMessage(errorMessage(error));
    });
    return () => { active = false; };
  }, [loadTask]);

  useEffect(() => {
    if (!task || !PROCESSING_STATES.has(task.status)) {
      pollAttemptRef.current = 0;
      return undefined;
    }
    let active = true;
    const delay = Math.min(8000, 1000 * (2 ** pollAttemptRef.current));
    const timer = window.setTimeout(() => {
      pollAttemptRef.current += 1;
      void loadTask().catch((error) => {
        if (active) setMessage(errorMessage(error));
      });
    }, delay);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [loadTask, task]);

  async function runAction(input: { action: string; field?: string; value?: string; optionId?: string; role?: string }) {
    if (!task || !familyId || busy) return;
    setBusy(true);
    setMessage('正在提交');
    try {
      const payload = await applyPolicyImportAction({ token, familyId, taskId, stateVersion: task.stateVersion, ...input });
      setTask(payload.task);
      setMessage('任务已更新');
      return payload.task;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadTask();
        setMessage('任务已在其他渠道更新，已刷新到最新状态，请重新确认');
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function finalize(currentTask = task) {
    if (!currentTask || !familyId || busy) return;
    setBusy(true);
    setMessage('正在保存保单');
    try {
      const payload = await finalizePolicyImport({
        token,
        familyId,
        taskId,
        stateVersion: currentTask.stateVersion,
        requestId: requestIdRef.current,
      });
      setPolicyId(payload.result.policyId);
      await loadTask();
      setPolicyId(payload.result.policyId);
      setMessage('保单已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadTask();
        setMessage('任务已在其他渠道更新，已刷新到最新状态，请重新确认');
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!task) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-8">
        <div className="mx-auto max-w-2xl rounded-3xl bg-white p-6 shadow-sm">
          <p aria-live="polite" className="text-sm font-semibold text-slate-600">{message}</p>
          <button type="button" className="mt-5 rounded-xl bg-slate-100 px-4 py-2 text-sm font-bold" onClick={onBack}>返回保单录入</button>
        </div>
      </main>
    );
  }

  const interaction = task.nextInteraction;
  const draftEntries = Object.entries(task.policyDraft).filter(([, value]) => value !== '' && value !== undefined && value !== null);
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 pb-24">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="rounded-3xl bg-gradient-to-br from-blue-600 to-cyan-500 p-5 text-white shadow-lg">
          <button type="button" className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-bold" onClick={onBack}>返回</button>
          <h1 className="mt-4 text-2xl font-black">继续审核保单导入</h1>
          <p className="mt-2 text-sm text-white/85">阶段：{task.status} · 状态版本：{task.stateVersion}</p>
        </header>

        <section className="rounded-3xl bg-white p-5 shadow-sm" aria-labelledby="document-progress-title">
          <h2 id="document-progress-title" className="font-black text-slate-900">文件识别进度</h2>
          <p className="mt-2 text-sm text-slate-600">共 {task.documentSummary.count} 份文件</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(task.documentSummary.statuses).map(([status, count]) => <span key={status} className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">{status} {count}</span>)}
          </div>
        </section>

        <section className="rounded-3xl bg-white p-5 shadow-sm" aria-labelledby="masked-fields-title">
          <h2 id="masked-fields-title" className="font-black text-slate-900">已识别字段（已脱敏）</h2>
          <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {draftEntries.map(([field, value]) => <div key={field} className="rounded-2xl bg-slate-50 p-3"><dt className="text-xs font-bold text-slate-500">{FIELD_LABELS[field] || field}</dt><dd className="mt-1 break-words text-sm font-semibold text-slate-900">{String(value)}</dd></div>)}
          </dl>
          {task.missingFields.length ? <p className="mt-4 text-sm font-semibold text-amber-700">待补充：{task.missingFields.map((field) => FIELD_LABELS[field] || field).join('、')}</p> : null}
        </section>

        <section className="rounded-3xl bg-white p-5 shadow-sm" aria-labelledby="resolution-title">
          <h2 id="resolution-title" className="font-black text-slate-900">匹配与冲突处理</h2>
          <p className="mt-2 text-sm text-slate-600">产品：{task.resolution.product} · 被保人：{task.resolution.insuredMember} · 投保人：{task.resolution.applicantMember}</p>
          {interaction?.type === 'select_product' ? <div className="mt-4 grid gap-2">{task.legalOptions.products.map((option) => <button key={option.optionId} type="button" disabled={busy} className="min-h-11 rounded-2xl border border-blue-200 px-4 py-3 text-left text-sm font-bold text-blue-700" onClick={() => void runAction({ action: 'select_product', optionId: option.optionId })}>{option.label}</button>)}</div> : null}
          {interaction?.type === 'confirm_product_manual' ? <button type="button" disabled={busy} className="mt-4 min-h-11 rounded-2xl bg-blue-600 px-4 py-3 text-sm font-bold text-white" onClick={() => void runAction({ action: 'confirm_product_manual' })}>确认当前产品名称</button> : null}
          {interaction?.type === 'bind_member' ? <div className="mt-4 grid gap-2">{task.legalOptions.members.map((option) => <button key={option.optionId} type="button" disabled={busy} className="min-h-11 rounded-2xl border border-blue-200 px-4 py-3 text-left text-sm font-bold text-blue-700" onClick={() => void runAction({ action: 'bind_member', role: task.resolution.insuredMember === 'pending' ? 'insured' : 'applicant', optionId: option.optionId })}>{option.label}</button>)}</div> : null}
          {interaction?.type === 'set_field' && interaction.field ? <form className="mt-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void runAction({ action: 'set_field', field: interaction.field, value: String(data.get('value') || '') }); }}><label className="block text-sm font-bold text-slate-700" htmlFor="policy-import-field">{FIELD_LABELS[interaction.field] || interaction.field}</label><input id="policy-import-field" name="value" required className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 px-3" /><button type="submit" disabled={busy} className="mt-3 min-h-11 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white">保存字段</button></form> : null}
          {interaction?.type === 'confirm' ? <button type="button" disabled={busy} className="mt-4 min-h-11 w-full rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white" onClick={() => void runAction({ action: 'confirm' }).then((confirmed) => confirmed && finalize(confirmed))}>确认并保存保单</button> : null}
          {task.status === 'failed' ? <button type="button" disabled={busy} className="mt-4 min-h-11 rounded-2xl bg-amber-100 px-4 py-3 text-sm font-bold text-amber-900" onClick={() => void loadTask()}>重新加载任务</button> : null}
          {task.status === 'completed' && policyId ? <a className="mt-4 block min-h-11 rounded-2xl bg-emerald-600 px-4 py-3 text-center text-sm font-black text-white" href={`/?policyId=${policyId}`}>查看已保存保单</a> : null}
        </section>
        <p aria-live="polite" role="status" className="px-2 text-sm font-semibold text-slate-600">{message}</p>
      </div>
    </main>
  );
}
