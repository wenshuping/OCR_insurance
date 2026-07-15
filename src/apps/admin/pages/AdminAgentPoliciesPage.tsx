import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createAdminAgentQuestionPolicyDraft,
  getAdminAgentQuestionPolicies,
  getAdminAgentUnknownQuestions,
  publishAdminAgentQuestionPolicyDraft,
  rollbackAdminAgentQuestionPolicyVersion,
  simulateAdminAgentQuestionPolicy,
  updateAdminAgentQuestionPolicyDraft,
  type AdminAgentPolicySimulationResponse,
  type AdminAgentQuestionPolicy,
  type AdminAgentQuestionPolicyVersion,
  type AdminAgentRuntimeSettings,
  type AdminAgentUnknownQuestion,
} from '../../../api';
import { createLatestRequestController, createLifecycleController, createRequestMutex, fallbackPolicyKeys, policyValidationViewModel, shouldDiscardDirty, unknownQuestionViewModel, type AgentPolicyLatestRequestScope, type AgentPolicyLifecycleScope } from './adminAgentPolicies.mjs';

const HANDLERS = ['system', 'insurance_expert', 'sales_champion'] as const;
const OPERATIONS = ['read', 'write'] as const;
const CONFIRMATIONS = ['not_required', 'required'] as const;
const OUTPUT_MODES = ['direct', 'structured', 'preview'] as const;
const DECISIONS = ['execute', 'propose', 'reject'] as const;
const ALLOWED_TOOLS = ['list_families', 'family_summary', 'coverage_report', 'sales_report', 'product_knowledge_search', 'create_upload_link', 'propose_memory', 'preview_transfer'] as const;
const UNKNOWN_LIMIT = 20;
const DEFAULT_RUNTIME_SETTINGS: AdminAgentRuntimeSettings = { fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 30 };

const POLICY_LABELS: Record<string, string> = {
  family_list: '家庭列表',
  family_summary: '家庭概况',
  coverage_report: '保障分析报告',
  sales_report: '销售建议报告',
  insurance_product_knowledge: '保险产品知识',
  sales_coaching: '销售辅导',
  upload_link: '上传链接',
  memory_proposal: '记忆写入建议',
  transfer_preview: '转交预览',
  system_help: '系统帮助',
  chat: '日常对话',
  unknown_read: '未识别的读取请求',
  unknown_write: '未识别的写入请求',
};
const HANDLER_LABELS: Record<string, string> = { system: '系统助手', insurance_expert: '保险专家', sales_champion: '销售顾问' };
const OPERATION_LABELS: Record<string, string> = { read: '读取', write: '写入' };
const CONFIRMATION_LABELS: Record<string, string> = { not_required: '无需确认', required: '需要确认' };
const OUTPUT_MODE_LABELS: Record<string, string> = { direct: '直接回复', structured: '结构化输出', preview: '预览' };
const DECISION_LABELS: Record<string, string> = { execute: '执行', propose: '提出建议', reject: '拒绝', clarify: '要求澄清' };
const TOOL_LABELS: Record<string, string> = {
  list_families: '查询家庭列表',
  family_summary: '生成家庭概况',
  coverage_report: '生成保障分析报告',
  sales_report: '生成销售建议报告',
  product_knowledge_search: '搜索产品知识',
  create_upload_link: '创建上传链接',
  propose_memory: '提出记忆写入建议',
  preview_transfer: '预览转交内容',
};
const STATUS_LABELS: Record<string, string> = { draft: '草稿', published: '已发布', archived: '已归档', open: '待处理', resolved: '已解决', closed: '已关闭' };
const POLICY_SOURCE_LABELS: Record<string, string> = { draft: '草稿', published: '已发布版本', built_in: '内置策略' };
const UNKNOWN_CATEGORY_LABELS: Record<string, string> = { unrecognized_question: '未识别问题' };
const FALLBACK_DECISION_LABELS: Record<string, string> = { manual_review: '人工复核' };

function localizedLabel(labels: Record<string, string>, value: string | null | undefined, emptyLabel = '无') {
  if (!value) return emptyLabel;
  return labels[value] || value;
}

const selectClass = 'h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800';
const inputClass = 'h-10 min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}

export function AdminAgentPoliciesPage({ adminToken, onDirtyChange }: { adminToken: string; onDirtyChange: (dirty: boolean) => void }) {
  const [published, setPublished] = useState<AdminAgentQuestionPolicyVersion | null>(null);
  const [draft, setDraft] = useState<AdminAgentQuestionPolicyVersion | null>(null);
  const [policies, setPolicies] = useState<AdminAgentQuestionPolicy[]>([]);
  const [runtimeSettings, setRuntimeSettings] = useState<AdminAgentRuntimeSettings>(DEFAULT_RUNTIME_SETTINGS);
  const [history, setHistory] = useState<AdminAgentQuestionPolicyVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [policiesLoaded, setPoliciesLoaded] = useState(false);
  const [policyLoadError, setPolicyLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [candidateIntent, setCandidateIntent] = useState('coverage_report');
  const [question, setQuestion] = useState('查看家庭保障情况');
  const [confidence, setConfidence] = useState('0.9');
  const [requestedOperation, setRequestedOperation] = useState<'read' | 'write'>('read');
  const [familyName, setFamilyName] = useState('');
  const [familyRef, setFamilyRef] = useState('');
  const [policyHint, setPolicyHint] = useState('');
  const [simulationSource, setSimulationSource] = useState<'current' | 'draft'>('current');
  const [simulation, setSimulation] = useState<AdminAgentPolicySimulationResponse | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [unknownItems, setUnknownItems] = useState<AdminAgentUnknownQuestion[]>([]);
  const [unknownTotal, setUnknownTotal] = useState(0);
  const [unknownOffset, setUnknownOffset] = useState(0);
  const [unknownLoading, setUnknownLoading] = useState(false);
  const requestMutex = useRef(createRequestMutex());
  const simulationMutex = useRef(createRequestMutex());
  const policyRequests = useRef(createLatestRequestController());
  const unknownRequests = useRef(createLatestRequestController());
  const lifecycle = useRef(createLifecycleController());

  async function loadPolicies({ token = adminToken, scope = lifecycle.current.capture(adminToken), request = policyRequests.current.begin() }: { token?: string; scope?: AgentPolicyLifecycleScope; request?: AgentPolicyLatestRequestScope } = {}) {
    const commit = (update: () => void) => scope.commit(() => { request.commit(update); });
    commit(() => { setLoading(true); setPolicyLoadError(''); });
    try {
      const response = await getAdminAgentQuestionPolicies(token);
      commit(() => {
        const selectedDraft = response.drafts[0] || null;
        setPublished(response.published); setDraft(selectedDraft);
        setPolicies((selectedDraft?.policies || response.published?.policies || response.templates).map((item) => ({ ...item })));
        setRuntimeSettings({ ...(selectedDraft?.runtimeSettings || response.published?.runtimeSettings || response.defaultRuntimeSettings) });
        setHistory(response.history); setPoliciesLoaded(true); setDirty(false);
      });
    } catch (requestError) {
      commit(() => { setPoliciesLoaded(false); setPolicyLoadError(errorMessage(requestError)); });
    } finally {
      commit(() => setLoading(false));
    }
  }

  async function loadUnknownQuestions(offset = unknownOffset, token = adminToken, scope = lifecycle.current.capture(adminToken), request = unknownRequests.current.begin()) {
    const commit = (update: () => void) => scope.commit(() => { request.commit(update); });
    commit(() => setUnknownLoading(true));
    try {
      const response = await getAdminAgentUnknownQuestions(token, { limit: UNKNOWN_LIMIT, offset });
      commit(() => { setUnknownItems(response.items.map(unknownQuestionViewModel)); setUnknownTotal(response.total); setUnknownOffset(response.offset); });
    } catch (requestError) {
      commit(() => setError(errorMessage(requestError)));
    } finally {
      commit(() => setUnknownLoading(false));
    }
  }

  useEffect(() => {
    const scope = lifecycle.current.activate(adminToken);
    requestMutex.current = createRequestMutex();
    simulationMutex.current = createRequestMutex();
    scope.commit(() => {
      setPublished(null); setDraft(null); setPolicies([]); setRuntimeSettings(DEFAULT_RUNTIME_SETTINGS); setHistory([]);
      setPoliciesLoaded(false); setPolicyLoadError(''); setLoading(true);
      setSaving(false); setDirty(false); setError(''); setSimulation(null); setSimulating(false);
      setCandidateIntent('coverage_report'); setQuestion('查看家庭保障情况'); setConfidence('0.9'); setRequestedOperation('read');
      setFamilyName(''); setFamilyRef(''); setPolicyHint(''); setSimulationSource('current');
      setUnknownItems([]); setUnknownTotal(0); setUnknownOffset(0); setUnknownLoading(false);
    });
    void loadPolicies({ token: adminToken, scope });
    return () => { scope.invalidate(); policyRequests.current.invalidate(); };
  }, [adminToken]);
  useEffect(() => {
    const scope = lifecycle.current.capture(adminToken);
    void loadUnknownQuestions(unknownOffset, adminToken, scope);
    return () => unknownRequests.current.invalidate();
  }, [adminToken, unknownOffset]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const preventUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty]);

  const intentOptions = useMemo(() => [...new Set(policies.map((policy) => policy.intent))], [policies]);
  const validation = useMemo(() => policyValidationViewModel({ loading, loadError: policyLoadError, loaded: policiesLoaded, policies }), [loading, policies, policiesLoaded, policyLoadError]);
  const runtimeSettingsError = !Number.isInteger(runtimeSettings.fallbackHistoryMessageLimit) || runtimeSettings.fallbackHistoryMessageLimit < 1 || runtimeSettings.fallbackHistoryMessageLimit > 40
    ? '降级历史消息上限必须是 1–40 的整数'
    : !Number.isInteger(runtimeSettings.productContextTtlMinutes) || runtimeSettings.productContextTtlMinutes < 1 || runtimeSettings.productContextTtlMinutes > 1_440
      ? '产品指代有效期必须是 1–1440 分钟的整数'
      : '';
  const validationErrors = runtimeSettingsError ? [runtimeSettingsError, ...validation.errors] : validation.errors;

  function changePolicy(index: number, patch: Partial<AdminAgentQuestionPolicy>) {
    setPolicies((current) => current.map((policy, policyIndex) => policyIndex === index ? { ...policy, ...patch } : policy));
    setDirty(true);
  }

  function changeRuntimeSetting(patch: Partial<AdminAgentRuntimeSettings>) {
    setRuntimeSettings((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  async function saveDraft() {
    if (validationErrors.length) { setError(validationErrors[0]); return; }
    const scope = lifecycle.current.capture(adminToken);
    const token = scope.token;
    await requestMutex.current.run(async () => {
      scope.commit(() => { setSaving(true); setError(''); });
      try {
        const response = draft ? await updateAdminAgentQuestionPolicyDraft(token, draft.id, policies, runtimeSettings) : await createAdminAgentQuestionPolicyDraft(token, policies, runtimeSettings);
        if (!scope.commit(() => { setDraft(response.draft); setSimulationSource('draft'); setDirty(false); })) return;
        if (scope.isCurrent()) await loadPolicies({ token, scope });
      } catch (requestError) { scope.commit(() => setError(errorMessage(requestError))); }
      finally { scope.commit(() => setSaving(false)); }
    });
  }

  async function publishDraft() {
    if (!draft || saving || dirty || !window.confirm(`确认发布版本 ${draft.version}？发布后将影响新请求。`)) return;
    const scope = lifecycle.current.capture(adminToken);
    const token = scope.token;
    await requestMutex.current.run(async () => {
      scope.commit(() => setSaving(true));
      try { await publishAdminAgentQuestionPolicyDraft(token, draft.id); if (scope.isCurrent()) await loadPolicies({ token, scope }); }
      catch (requestError) { scope.commit(() => setError(errorMessage(requestError))); }
      finally { scope.commit(() => setSaving(false)); }
    });
  }

  async function rollback(version: AdminAgentQuestionPolicyVersion) {
    if (saving || !shouldDiscardDirty(dirty, window.confirm) || !window.confirm(`确认回滚到版本 ${version.version}？系统会创建新的发布版本。`)) return;
    const scope = lifecycle.current.capture(adminToken);
    const token = scope.token;
    await requestMutex.current.run(async () => {
      scope.commit(() => setSaving(true));
      try { await rollbackAdminAgentQuestionPolicyVersion(token, version.id); if (scope.isCurrent()) await loadPolicies({ token, scope }); }
      catch (requestError) { scope.commit(() => setError(errorMessage(requestError))); }
      finally { scope.commit(() => setSaving(false)); }
    });
  }

  async function runSimulation() {
    if (simulating || (simulationSource === 'draft' && !draft)) return;
    const scope = lifecycle.current.capture(adminToken);
    const token = scope.token;
    await simulationMutex.current.run(async () => {
      scope.commit(() => { setSimulating(true); setError(''); });
      try {
        const entities = Object.fromEntries(Object.entries({ familyName, familyRef, policyHint }).filter(([, value]) => value.trim()));
        const response = await simulateAdminAgentQuestionPolicy(token, { ...(simulationSource === 'draft' && draft ? { draftId: draft.id } : {}), candidate: { intent: candidateIntent, question, confidence: Number(confidence), requestedOperation, entities } });
        scope.commit(() => setSimulation(response));
      } catch (requestError) { scope.commit(() => setError(errorMessage(requestError))); }
      finally { scope.commit(() => setSimulating(false)); }
    });
  }

  function refreshPolicies() {
    if (!shouldDiscardDirty(dirty, window.confirm)) return;
    void loadPolicies();
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-lg font-black text-slate-950">智能体策略管理</h2><p className="mt-1 text-sm font-semibold text-slate-500">当前发布版本：{published ? `v${published.version} · ${localizedLabel(STATUS_LABELS, published.status)}` : '暂无'}</p></div>
          <div className="flex gap-2"><button className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold" disabled={loading || saving} onClick={refreshPolicies}>刷新</button><button className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50" disabled={!validation.ready || loading || saving || !policies.length || validationErrors.length > 0} onClick={() => void saveDraft()}>{saving ? '处理中...' : '保存草稿'}</button><button className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50" disabled={!validation.ready || !draft || saving || dirty || validationErrors.length > 0} onClick={() => void publishDraft()}>显式发布</button></div>
        </div>
        {dirty && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800">未保存草稿：请先保存后再发布或模拟草稿。</p>}
        {policyLoadError && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{policyLoadError}</p>}
        {validationErrors.length > 0 && <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">请修正后保存：{validationErrors[0]}</div>}
        {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{error}</p>}
        {!loading && <div className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <h3 className="font-black text-slate-950">对话运行参数</h3>
          <p className="mt-1 text-xs font-semibold text-slate-600">Hermes 会话历史由 Hermes 自动维护。以下参数只控制降级解释器和 OCR 产品指代，不会合并不同用户的记忆。</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-700">降级历史消息上限<input aria-label="降级历史消息上限" className={`${inputClass} mt-1 w-full`} type="number" min="1" max="40" step="1" value={runtimeSettings.fallbackHistoryMessageLimit} onChange={(event) => changeRuntimeSetting({ fallbackHistoryMessageLimit: Number(event.target.value) })} /><span className="mt-1 block font-normal text-slate-500">仅直接回复或 DeepSeek 降级模式使用，默认 6 条。</span></label>
            <label className="text-xs font-bold text-slate-700">产品指代有效期（分钟）<input aria-label="产品指代有效期（分钟）" className={`${inputClass} mt-1 w-full`} type="number" min="1" max="1440" step="1" value={runtimeSettings.productContextTtlMinutes} onChange={(event) => changeRuntimeSetting({ productContextTtlMinutes: Number(event.target.value) })} /><span className="mt-1 block font-normal text-slate-500">控制“它/这个产品”等 OCR 业务上下文，默认 30 分钟。</span></label>
          </div>
        </div>}
        {loading ? <p className="mt-5 text-sm text-slate-500">加载中...</p> : <div className="mt-5 grid gap-3 lg:grid-cols-2">{policies.map((policy, index) => (
          <article key={policy.key} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3"><div><h3 className="font-black text-slate-900">{localizedLabel(POLICY_LABELS, policy.key)}</h3><p className="text-xs text-slate-500">意图：{localizedLabel(POLICY_LABELS, policy.intent)}</p></div><label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={policy.enabled !== false} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { enabled: event.target.checked })} />启用</label></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <label className="text-xs font-bold text-slate-600">处理角色<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}处理角色`} className={`${selectClass} mt-1 w-full`} value={policy.handler} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { handler: event.target.value as AdminAgentQuestionPolicy['handler'] })}>{HANDLERS.map((value) => <option key={value} value={value}>{localizedLabel(HANDLER_LABELS, value)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">操作类型<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}操作类型`} className={`${selectClass} mt-1 w-full`} value={policy.operation} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { operation: event.target.value as AdminAgentQuestionPolicy['operation'], ...(event.target.value === 'write' ? { confirmation: 'required' } : {}) })}>{OPERATIONS.map((value) => <option key={value} value={value}>{localizedLabel(OPERATION_LABELS, value)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">执行方式<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}执行方式`} className={`${selectClass} mt-1 w-full`} value={policy.decision} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { decision: event.target.value as AdminAgentQuestionPolicy['decision'] })}>{DECISIONS.map((value) => <option key={value} value={value}>{localizedLabel(DECISION_LABELS, value)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">确认要求<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}确认要求`} className={`${selectClass} mt-1 w-full`} value={policy.confirmation} disabled={policy.operation === 'write' || fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { confirmation: event.target.value as AdminAgentQuestionPolicy['confirmation'] })}>{CONFIRMATIONS.map((value) => <option key={value} value={value}>{localizedLabel(CONFIRMATION_LABELS, value)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">输出方式<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}输出方式`} className={`${selectClass} mt-1 w-full`} value={policy.outputMode} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { outputMode: event.target.value as AdminAgentQuestionPolicy['outputMode'] })}>{OUTPUT_MODES.map((value) => <option key={value} value={value}>{localizedLabel(OUTPUT_MODE_LABELS, value)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">调用工具<select aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}调用工具`} className={`${selectClass} mt-1 w-full`} value={policy.tool || ''} disabled={fallbackPolicyKeys.includes(policy.key)} onChange={(event) => changePolicy(index, { tool: (event.target.value || null) as AdminAgentQuestionPolicy['tool'] })}><option value="">不调用工具</option>{ALLOWED_TOOLS.map((value) => <option key={value} value={value}>{localizedLabel(TOOL_LABELS, value)}</option>)}</select></label>
              <label className="col-span-2 text-xs font-bold text-slate-600 sm:col-span-3">置信度阈值<input aria-label={`${localizedLabel(POLICY_LABELS, policy.key)}置信度阈值`} className={`${inputClass} mt-1 w-full`} type="number" min="0" max="1" step="0.05" value={policy.confidenceThreshold ?? 0} onChange={(event) => changePolicy(index, { confidenceThreshold: Number(event.target.value) })} /></label>
            </div>
          </article>
        ))}</div>}
      </section>

      <section className="rounded-[18px] border border-blue-200 bg-blue-50 p-5"><h2 className="text-lg font-black text-slate-950">决策模拟</h2><p className="mt-1 text-sm font-black text-blue-700">只预览、不执行：不会调用工具、写入业务数据或创建确认任务。</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4"><select aria-label="策略来源" className={selectClass} value={simulationSource} onChange={(event) => setSimulationSource(event.target.value as 'current' | 'draft')}><option value="current">当前发布策略</option><option value="draft" disabled={!draft}>草稿策略</option></select><select aria-label="候选意图" className={selectClass} value={candidateIntent} onChange={(event) => setCandidateIntent(event.target.value)}>{intentOptions.map((intent) => <option key={intent} value={intent}>{localizedLabel(POLICY_LABELS, intent)}</option>)}</select><select aria-label="请求操作" className={selectClass} value={requestedOperation} onChange={(event) => setRequestedOperation(event.target.value as 'read' | 'write')}><option value="read">读取</option><option value="write">写入（仅预览）</option></select><input aria-label="置信度" className={inputClass} type="number" min="0" max="1" step="0.05" value={confidence} onChange={(event) => setConfidence(event.target.value)} placeholder="置信度" /><input aria-label="问题" className={`${inputClass} sm:col-span-2`} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="问题（结果页不回显敏感原文）" /><input aria-label="家庭名称" className={inputClass} value={familyName} onChange={(event) => setFamilyName(event.target.value)} placeholder="家庭名称" /><input aria-label="家庭编号" className={inputClass} value={familyRef} onChange={(event) => setFamilyRef(event.target.value)} placeholder="家庭编号" /><input aria-label="保单提示" className={inputClass} value={policyHint} onChange={(event) => setPolicyHint(event.target.value)} placeholder="保单提示" /></div>
        <button className="mt-3 rounded-xl bg-blue-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50" disabled={simulating || (simulationSource === 'draft' && (!draft || dirty))} onClick={() => void runSimulation()}>{simulating ? '模拟中...' : '运行安全预览'}</button>
        {simulation && <div className="mt-4 grid gap-2 rounded-2xl bg-white p-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><span>实际意图：<b>{localizedLabel(POLICY_LABELS, simulation.decision.intent)}</b></span><span>业务实体：<b>已脱敏，不回显原值</b></span><span>家庭匹配：<b>{simulation.decision.familyResolved ? '已匹配' : '未匹配'}</b></span><span>策略来源：<b>{localizedLabel(POLICY_SOURCE_LABELS, simulation.decision.policySource)}</b></span><span>处理角色／工具：<b>{localizedLabel(HANDLER_LABELS, simulation.decision.handler)}／{localizedLabel(TOOL_LABELS, simulation.decision.tool, '不调用工具')}</b></span><span>决策：<b>{localizedLabel(DECISION_LABELS, simulation.decision.decision)}</b></span><span>确认要求：<b>{simulation.decision.confirmationRequired ? '需要确认' : '无需确认'}</b></span><span>隐私处理：<b>敏感实体不回显</b></span><span>输出方式：<b>{localizedLabel(OUTPUT_MODE_LABELS, simulation.decision.outputMode)}</b></span><p className="sm:col-span-2 lg:col-span-3">说明：{simulation.decision.explanation}</p>{simulation.decision.result === 'low_confidence' && <strong className="text-amber-700">低置信度：将要求澄清</strong>}{simulation.decision.result === 'write_preview' && <strong className="text-rose-700">写操作预览：必须确认且不会执行</strong>}</div>}
      </section>

      <section className="rounded-[18px] border border-slate-200 bg-white p-5"><h2 className="text-lg font-black">版本历史</h2><div className="mt-3 space-y-2">{history.map((version) => <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 text-sm"><span><b>v{version.version}</b> · {localizedLabel(STATUS_LABELS, version.status)} · {version.createdAt}</span><button className="rounded-lg border border-slate-300 px-3 py-1 font-bold disabled:opacity-40" disabled={saving || version.status === 'draft' || version.id === published?.id} onClick={() => void rollback(version)}>回滚到此版本</button></div>)}</div></section>

      <section className="rounded-[18px] border border-slate-200 bg-white p-5"><div className="flex items-center justify-between"><div><h2 className="text-lg font-black">未知问题统计</h2><p className="text-sm text-slate-500">不展示原问句、标准化文本、消息引用或原始载荷。</p></div><span className="text-sm font-bold">共 {unknownTotal} 条</span></div>{unknownLoading ? <p className="mt-3 text-sm">加载中...</p> : <div className="mt-3 space-y-2">{unknownItems.map((item) => <div key={item.id} className="rounded-xl bg-slate-50 p-3 text-sm"><div className="flex justify-between gap-2"><b>{localizedLabel(UNKNOWN_CATEGORY_LABELS, item.category)} · {localizedLabel(STATUS_LABELS, item.status)}</b><span className="text-slate-500">{item.createdAt}</span></div><p className="mt-1 text-slate-700">后续处理：{localizedLabel(FALLBACK_DECISION_LABELS, item.fallbackDecision)} · 次数：{item.occurrenceCount}</p></div>)}</div>}<div className="mt-3 flex justify-end gap-2"><button className="rounded-lg border px-3 py-1 text-sm font-bold" disabled={unknownLoading || unknownOffset === 0} onClick={() => setUnknownOffset(Math.max(0, unknownOffset - UNKNOWN_LIMIT))}>上一页</button><button className="rounded-lg border px-3 py-1 text-sm font-bold" disabled={unknownLoading || unknownOffset + UNKNOWN_LIMIT >= unknownTotal} onClick={() => setUnknownOffset(unknownOffset + UNKNOWN_LIMIT)}>下一页</button></div></section>
    </div>
  );
}
