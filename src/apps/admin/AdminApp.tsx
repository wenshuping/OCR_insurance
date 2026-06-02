import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Database,
  Download,
  ExternalLink,
  LayoutDashboard,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  AdminOcrConfig,
  AdminOfficialDomainProfile,
  AdminOverview,
  ApiError,
  KnowledgeRecord,
  OptionalResponsibilityGap,
  Policy,
  adminLogin,
  crawlAdminKnowledge,
  createAdminOfficialDomainProfile,
  deleteAdminOfficialDomainProfile,
  getAdminOfficialDomainProfiles,
  getAdminKnowledgeRecords,
  getAdminOcrConfig,
  getAdminOverview,
  markOptionalResponsibilityNotQuantifiable,
  regeneratePolicyReport,
  reextractOptionalResponsibilities,
  updateAdminOfficialDomainProfile,
  updateAdminOcrConfig,
} from '../../api';

import {
  formatCoverageAmount,
  formatCurrency,
  formatDateLabel,
  formatOcrModeLabel,
  maskMobile,
} from '../../shared/formatters';

import {
  downloadReportPdf,
  getReportExportControlTitle,
} from '../../features/report-export/report-export';
import {
  MetricBox,
  ReportText,
  buildPolicyReportTitle,
  formatSourceUrlHost,
  getPolicyResponsibilitySourceLinks,
  isPolicyReportFailed,
  isPolicyReportGenerating,
} from '../../shared/policy-report-ui';

const ADMIN_TOKEN_KEY = 'policy-ocr-app.adminToken';

type OfficialDomainForm = {
  id: string;
  company: string;
  aliasesText: string;
  siteDomainsText: string;
  officialDomainsText: string;
};

type KnowledgeCrawlForm = {
  company: string;
  name: string;
};

const emptyOfficialDomainForm: OfficialDomainForm = {
  id: '',
  company: '',
  aliasesText: '',
  siteDomainsText: '',
  officialDomainsText: '',
};

const emptyKnowledgeCrawlForm: KnowledgeCrawlForm = {
  company: '',
  name: '',
};

function listToText(values: string[] = []) {
  return values.filter(Boolean).join('\n');
}

function textToList(value: string) {
  return String(value || '')
    .split(/[\n,，;；\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileToOfficialDomainForm(profile: AdminOfficialDomainProfile): OfficialDomainForm {
  return {
    id: profile.id,
    company: profile.company || '',
    aliasesText: listToText(profile.aliases || []),
    siteDomainsText: listToText(profile.siteDomains || []),
    officialDomainsText: listToText(profile.officialDomains || []),
  };
}

function formToOfficialDomainPayload(form: OfficialDomainForm) {
  return {
    company: form.company,
    aliases: textToList(form.aliasesText),
    siteDomains: textToList(form.siteDomainsText),
    officialDomains: textToList(form.officialDomainsText),
  };
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: 'text' | 'decimal' | 'numeric' | 'tel';
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold text-slate-700">{props.label}</label>
      <input
        type={props.type || 'text'}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm focus:border-blue-500 focus:ring-blue-500"
      />
    </div>
  );
}
export function AdminApp() {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [password, setPassword] = useState('');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [ocrConfig, setOcrConfig] = useState<AdminOcrConfig | null>(null);
  const [officialDomainProfiles, setOfficialDomainProfiles] = useState<AdminOfficialDomainProfile[]>([]);
  const [officialDomainForm, setOfficialDomainForm] = useState<OfficialDomainForm>(emptyOfficialDomainForm);
  const [knowledgeRecords, setKnowledgeRecords] = useState<KnowledgeRecord[]>([]);
  const [knowledgeCrawlForm, setKnowledgeCrawlForm] = useState<KnowledgeCrawlForm>(emptyKnowledgeCrawlForm);
  const [query, setQuery] = useState('');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState<number | null>(null);
  const [message, setMessage] = useState('输入后台密码进入平台只读管理台');
  const [loading, setLoading] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [officialDomainLoading, setOfficialDomainLoading] = useState(false);
  const [officialDomainSaving, setOfficialDomainSaving] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeCrawling, setKnowledgeCrawling] = useState(false);
  const [retryingPolicyId, setRetryingPolicyId] = useState<number | null>(null);

  async function loadOverview(token = adminToken) {
    if (!token) return;
    setLoading(true);
    try {
      const payload = await getAdminOverview(token);
      setOverview(payload);
      setSelectedPolicy((current) => {
        if (!current) return current;
        return payload.policies.find((policy) => Number(policy.id) === Number(current.id)) || current;
      });
      setMessage('平台数据已加载');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '后台数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadOcrConfig(token = adminToken) {
    if (!token) return;
    setOcrLoading(true);
    try {
      const payload = await getAdminOcrConfig(token);
      setOcrConfig(payload);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : 'OCR 方式读取失败');
    } finally {
      setOcrLoading(false);
    }
  }

  async function loadOfficialDomainProfiles(token = adminToken) {
    if (!token) return;
    setOfficialDomainLoading(true);
    try {
      const payload = await getAdminOfficialDomainProfiles(token);
      setOfficialDomainProfiles(payload.profiles);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '官方域名白名单读取失败');
    } finally {
      setOfficialDomainLoading(false);
    }
  }

  async function loadKnowledgeRecords(token = adminToken) {
    if (!token) return;
    setKnowledgeLoading(true);
    try {
      const payload = await getAdminKnowledgeRecords(token);
      setKnowledgeRecords(payload.records);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        setAdminToken('');
      }
      setMessage(error instanceof Error ? error.message : '本地知识库读取失败');
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    if (!adminToken) return;
    void loadOverview(adminToken);
    void loadOcrConfig(adminToken);
    void loadOfficialDomainProfiles(adminToken);
    void loadKnowledgeRecords(adminToken);
  }, [adminToken]);

  useEffect(() => {
    if (!adminToken || !overview?.policies.some(isPolicyReportGenerating)) return;
    const timer = window.setInterval(() => {
      void loadOverview(adminToken);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [adminToken, overview]);

  async function handleAdminLogin() {
    if (loading || !password.trim()) return;
    setLoading(true);
    setMessage('正在登录管理后台');
    try {
      const payload = await adminLogin(password);
      localStorage.setItem(ADMIN_TOKEN_KEY, payload.token);
      setAdminToken(payload.token);
      setPassword('');
      setMessage('登录成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台登录失败');
    } finally {
      setLoading(false);
    }
  }

  function logoutAdmin() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setAdminToken('');
    setOverview(null);
    setOcrConfig(null);
    setOfficialDomainProfiles([]);
    setOfficialDomainForm(emptyOfficialDomainForm);
    setKnowledgeRecords([]);
    setKnowledgeCrawlForm(emptyKnowledgeCrawlForm);
    setSelectedPolicy(null);
    setSelectedAdminUserId(null);
    setMessage('已退出管理后台');
  }

  async function handleOcrModeChange(mode: string) {
    if (!adminToken || ocrLoading || !mode || mode === ocrConfig?.config.mode) return;
    setOcrLoading(true);
    setMessage('正在切换 OCR 识别方式');
    try {
      const payload = await updateAdminOcrConfig(adminToken, mode);
      setOcrConfig(payload);
      setMessage(`OCR 已切换为 ${payload.runtime.providerLabel}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'OCR 方式切换失败');
    } finally {
      setOcrLoading(false);
    }
  }

  async function retryAdminPolicyReport(policy: Policy) {
    if (!adminToken || retryingPolicyId) return;
    setRetryingPolicyId(policy.id);
    setMessage('正在重新生成保险责任报告');
    try {
      const payload = await regeneratePolicyReport({ token: adminToken, id: policy.id });
      setSelectedPolicy(payload.policy);
      setOverview((current) => {
        if (!current) return current;
        return {
          ...current,
          policies: current.policies.map((row) => (Number(row.id) === Number(payload.policy.id) ? payload.policy : row)),
        };
      });
      setMessage(payload.skipped ? '保险责任报告已存在' : '已开始重新生成报告');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新生成报告失败');
    } finally {
      setRetryingPolicyId(null);
    }
  }

  async function saveOfficialDomainProfile() {
    if (!adminToken || officialDomainSaving || !officialDomainForm.company.trim() || !officialDomainForm.officialDomainsText.trim()) return;
    setOfficialDomainSaving(true);
    setMessage('正在保存保险公司官方域名白名单');
    try {
      const payload = officialDomainForm.id
        ? await updateAdminOfficialDomainProfile(adminToken, officialDomainForm.id, formToOfficialDomainPayload(officialDomainForm))
        : await createAdminOfficialDomainProfile(adminToken, formToOfficialDomainPayload(officialDomainForm));
      setOfficialDomainProfiles(payload.profiles);
      setOfficialDomainForm(emptyOfficialDomainForm);
      setMessage('官方域名白名单已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官方域名白名单保存失败');
    } finally {
      setOfficialDomainSaving(false);
    }
  }

  async function removeOfficialDomainProfile(profile: AdminOfficialDomainProfile) {
    if (!adminToken || officialDomainSaving || profile.source !== 'custom') return;
    setOfficialDomainSaving(true);
    setMessage('正在删除官方域名白名单');
    try {
      const payload = await deleteAdminOfficialDomainProfile(adminToken, profile.id);
      setOfficialDomainProfiles(payload.profiles);
      if (officialDomainForm.id === profile.id) setOfficialDomainForm(emptyOfficialDomainForm);
      setMessage('官方域名白名单已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官方域名白名单删除失败');
    } finally {
      setOfficialDomainSaving(false);
    }
  }

  async function crawlKnowledgeRecords() {
    if (!adminToken || knowledgeCrawling || !knowledgeCrawlForm.company.trim() || !knowledgeCrawlForm.name.trim()) return;
    setKnowledgeCrawling(true);
    setMessage('正在爬取保险公司官网资料');
    try {
      const payload = await crawlAdminKnowledge(adminToken, {
        company: knowledgeCrawlForm.company.trim(),
        name: knowledgeCrawlForm.name.trim(),
      });
      setKnowledgeRecords(payload.records);
      await loadOverview(adminToken);
      setMessage(payload.savedCount ? `已写入 ${payload.savedCount} 条官方资料` : '未找到官方资料，未写入知识库');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '官网资料爬取失败');
    } finally {
      setKnowledgeCrawling(false);
    }
  }

  async function handleMarkOptionalNotQuantifiable(gap: OptionalResponsibilityGap) {
    if (!adminToken || loading) return;
    setLoading(true);
    setMessage('正在标记可选责任不可量化');
    try {
      await markOptionalResponsibilityNotQuantifiable(adminToken, gap.id, '该责任暂不进入金额量化计算');
      await loadOverview(adminToken);
      setMessage('可选责任已标记为不可量化');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '标记失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleReextractOptionalResponsibilities() {
    if (!adminToken || loading) return;
    setLoading(true);
    setMessage('正在重新拆解可选责任');
    try {
      await reextractOptionalResponsibilities(adminToken);
      await loadOverview(adminToken);
      setMessage('可选责任拆解已刷新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新拆解失败');
    } finally {
      setLoading(false);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const selectedAdminUser = useMemo(
    () => (overview?.users || []).find((user) => Number(user.id) === Number(selectedAdminUserId)) || null,
    [overview, selectedAdminUserId],
  );

  useEffect(() => {
    if (!selectedAdminUserId || selectedAdminUser || !overview) return;
    setSelectedAdminUserId(null);
  }, [overview, selectedAdminUser, selectedAdminUserId]);

  function matchesAdminQuery(values: Array<unknown>) {
    if (!normalizedQuery) return true;
    return values
      .filter((value) => value !== undefined && value !== null)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  }

  const filteredPolicies = useMemo(() => {
    const rows = overview?.policies || [];
    return rows.filter((policy) => {
      if (selectedAdminUserId && String(policy.userMobile || '') !== String(selectedAdminUser?.mobile || '')) {
        return false;
      }
      return matchesAdminQuery([
        policy.userMobile,
        policy.company,
        policy.name,
        policy.applicant,
        policy.insured,
        policy.date,
        policy.paymentPeriod,
        policy.coveragePeriod,
      ]);
    });
  }, [overview, normalizedQuery, selectedAdminUser?.mobile, selectedAdminUserId]);

  const filteredUsers = useMemo(() => {
    const rows = overview?.users || [];
    if (!normalizedQuery) return rows;
    return rows.filter((user) =>
      matchesAdminQuery([
        user.mobile,
        maskMobile(user.mobile),
        user.id,
        `${user.policyCount} 保单`,
        `${user.insuredCount} 被保人`,
      ]),
    );
  }, [overview, normalizedQuery]);

  function formatAdminMobile(mobileValue: string) {
    return String(mobileValue || '').trim() || '未绑定手机号';
  }

  const filteredInsureds = useMemo(() => {
    const rows = overview?.insureds || [];
    return rows.filter((row) => {
      if (selectedAdminUserId && Number(row.userId) !== Number(selectedAdminUserId)) return false;
      return matchesAdminQuery([row.userMobile, maskMobile(row.userMobile), row.insured]);
    });
  }, [overview, normalizedQuery, selectedAdminUserId]);

  if (!adminToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#EEF3F8] px-6">
        <section className="w-full max-w-md rounded-[26px] border border-white bg-white p-8 shadow-[0_24px_80px_-50px_rgba(15,23,42,0.45)]">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <LayoutDashboard size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-950">平台管理后台</h1>
              <p className="mt-1 text-sm text-slate-500">只读查看账号、被保人和保单</p>
            </div>
          </div>
          <TextField label="后台密码" value={password} onChange={setPassword} type="password" placeholder="请输入后台密码" />
          <button
            className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-slate-950 text-sm font-black text-white disabled:opacity-60"
            type="button"
            disabled={loading || !password.trim()}
            onClick={() => void handleAdminLogin()}
          >
            {loading ? '登录中...' : '进入后台'}
          </button>
          <p className="mt-4 text-sm font-medium text-slate-500">{message}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] text-slate-950">
      <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-950 text-white shadow-[0_14px_38px_-24px_rgba(15,23,42,0.8)]">
              <LayoutDashboard size={21} />
            </div>
            <div>
              <h1 className="text-[19px] font-black leading-tight">P 端保单运营台</h1>
              <p className="mt-0.5 text-xs font-medium text-slate-500">{message}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-[460px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索注册用户手机号 / 被保人 / 保司 / 产品"
                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-4 text-sm outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </div>
            <button
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 shadow-sm transition hover:border-slate-300"
              type="button"
              onClick={() => {
                void loadOverview();
                void loadOcrConfig();
                void loadOfficialDomainProfiles();
                void loadKnowledgeRecords();
              }}
            >
              刷新
            </button>
            <button className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-bold text-white shadow-[0_14px_36px_-24px_rgba(15,23,42,0.9)]" type="button" onClick={logoutAdmin}>
              退出
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-6 py-5">
        <section className="mb-5 grid grid-cols-5 gap-3">
          <AdminStatCard label="注册账号" value={`${overview?.summary.userCount || 0}`} />
          <AdminStatCard label="被保人数" value={`${overview?.summary.insuredCount || 0}`} />
          <AdminStatCard label="保单总数" value={`${overview?.summary.policyCount || 0}`} />
          <AdminStatCard label="知识库资料" value={`${overview?.summary.knowledgeRecordCount || knowledgeRecords.length || 0}`} />
          <AdminStatCard label="总保额" value={formatCoverageAmount(overview?.summary.totalCoverage || 0)} />
        </section>

        <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-5">
          <aside className="space-y-4">
            <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-sm font-black">
                    <Users size={16} />
                    注册用户
                  </div>
                  <p className="mt-1 text-xs font-medium text-slate-400">搜索手机号，点击用户筛选保单</p>
                </div>
                {selectedAdminUser ? (
                  <button
                    className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500 transition hover:bg-slate-200"
                    type="button"
                    onClick={() => setSelectedAdminUserId(null)}
                  >
                    全部
                  </button>
                ) : (
                  <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-400">{filteredUsers.length}</span>
                )}
              </div>
              <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
                {filteredUsers.map((user) => {
                  const active = Number(user.id) === Number(selectedAdminUserId);
                  return (
                    <button
                      key={user.id}
                      className={[
                        'w-full rounded-[18px] border px-4 py-3 text-left transition',
                        active
                          ? 'border-slate-950 bg-slate-950 text-white shadow-[0_18px_42px_-28px_rgba(15,23,42,0.9)]'
                          : 'border-slate-100 bg-slate-50 text-slate-950 hover:border-slate-200 hover:bg-white',
                      ].join(' ')}
                      type="button"
                      onClick={() => setSelectedAdminUserId(Number(user.id))}
                    >
                      <p className="font-mono text-[20px] font-black leading-none tracking-normal">{formatAdminMobile(user.mobile)}</p>
                      <div className="mt-3 flex items-center justify-between text-xs font-bold">
                        <span className={active ? 'text-white/65' : 'text-slate-500'}>{user.insuredCount} 被保人</span>
                        <span className={active ? 'rounded-full bg-white/10 px-2.5 py-1 text-white/80' : 'rounded-full bg-white px-2.5 py-1 text-slate-500'}>
                          {user.policyCount} 保单
                        </span>
                      </div>
                    </button>
                  );
                })}
                {!filteredUsers.length ? <p className="rounded-[18px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">没有匹配的注册用户</p> : null}
              </div>
            </section>

            <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-black">被保人</p>
                  <p className="mt-1 text-xs font-medium text-slate-400">{selectedAdminUser ? '当前注册用户名下' : '全部账号下的被保人'}</p>
                </div>
                <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-400">{filteredInsureds.length}</span>
              </div>
              <div className="max-h-[260px] space-y-2 overflow-auto pr-1">
                {filteredInsureds.map((row) => (
                  <div key={row.key} className="rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 truncate font-black">{row.insured}</p>
                      <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-500">{row.policyCount}</span>
                    </div>
                    <p className="mt-1 font-mono text-xs text-slate-500">{formatAdminMobile(row.userMobile)}</p>
                  </div>
                ))}
                {!filteredInsureds.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">没有匹配的被保人</p> : null}
              </div>
            </section>

            <AdminOcrModePanel
              config={ocrConfig}
              loading={ocrLoading}
              onRefresh={() => void loadOcrConfig()}
              onChange={(mode) => void handleOcrModeChange(mode)}
            />

            <AdminOfficialDomainPanel
              profiles={officialDomainProfiles}
              form={officialDomainForm}
              loading={officialDomainLoading}
              saving={officialDomainSaving}
              onChange={setOfficialDomainForm}
              onEdit={(profile) => setOfficialDomainForm(profileToOfficialDomainForm(profile))}
              onReset={() => setOfficialDomainForm(emptyOfficialDomainForm)}
              onRefresh={() => void loadOfficialDomainProfiles()}
              onSave={() => void saveOfficialDomainProfile()}
              onDelete={(profile) => void removeOfficialDomainProfile(profile)}
            />

            <AdminOptionalResponsibilityGapPanel
              gaps={overview?.optionalResponsibilityGaps || []}
              loading={loading}
              onMarkNotQuantifiable={(gap) => void handleMarkOptionalNotQuantifiable(gap)}
              onReextract={() => void handleReextractOptionalResponsibilities()}
            />

            <AdminKnowledgePanel
              records={knowledgeRecords}
              form={knowledgeCrawlForm}
              loading={knowledgeLoading}
              crawling={knowledgeCrawling}
              onChange={setKnowledgeCrawlForm}
              onRefresh={() => void loadKnowledgeRecords()}
              onCrawl={() => void crawlKnowledgeRecords()}
            />
          </aside>

          <section className="min-w-0 rounded-[22px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_-58px_rgba(15,23,42,0.42)]">
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-xl font-black">{selectedAdminUser ? '注册用户保单' : '全部保单'}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedAdminUser ? `当前只看 ${formatAdminMobile(selectedAdminUser.mobile)} 名下的被保人和保单。` : '只读列表，点击查看 OCR 原文和责任解析。'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedAdminUser ? (
                  <button
                    className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white"
                    type="button"
                    onClick={() => setSelectedAdminUserId(null)}
                  >
                    清除用户筛选
                  </button>
                ) : null}
                <span className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500">{filteredPolicies.length} 条</span>
              </div>
            </div>

            <div className="overflow-hidden rounded-[18px] border border-slate-200">
              <div className="grid grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] bg-slate-50 px-4 py-3 text-xs font-black text-slate-500">
                <div>注册用户</div>
                <div>产品</div>
                <div>被保人</div>
                <div>保司</div>
                <div>保额</div>
                <div>录入时间</div>
              </div>
              <div className="max-h-[720px] divide-y divide-slate-100 overflow-auto">
                {filteredPolicies.map((policy) => {
                  const reportSummary = isPolicyReportGenerating(policy)
                    ? '报告生成中'
                    : isPolicyReportFailed(policy)
                      ? policy.reportError || '报告生成失败'
                      : policy.report || `已生成 ${Array.isArray(policy.responsibilities) ? policy.responsibilities.length : 0} 项保险责任`;
                  return (
                    <button
                      key={policy.id}
                      type="button"
                      onClick={() => setSelectedPolicy(policy)}
                      className="grid w-full grid-cols-[1.05fr_1.45fr_0.9fr_0.85fr_0.8fr_0.8fr] items-center px-4 py-3 text-left text-sm transition hover:bg-slate-50"
                    >
                      <div className="font-mono font-bold text-slate-600">{formatAdminMobile(policy.userMobile || '')}</div>
                      <div className="min-w-0 pr-3 font-black text-slate-950">
                        <span className="block truncate">{policy.name}</span>
                        <span className="mt-1 block truncate text-xs font-medium text-slate-500">{reportSummary}</span>
                      </div>
                      <div className="truncate pr-3">{policy.insured || '未识别'}</div>
                      <div className="truncate pr-3">{policy.company}</div>
                      <div className="font-bold">{formatCoverageAmount(Number(policy.amount || 0))}</div>
                      <div className="text-slate-500">{formatDateLabel(policy.createdAt)}</div>
                    </button>
                  );
                })}
                {!filteredPolicies.length ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm font-black text-slate-500">没有匹配的保单</p>
                    <p className="mt-1 text-xs font-medium text-slate-400">可以换一个手机号、被保人或产品关键词搜索。</p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </main>

      {selectedPolicy ? (
        <AdminPolicyDetail
          policy={selectedPolicy}
          onClose={() => setSelectedPolicy(null)}
          onRetryReport={retryAdminPolicyReport}
          retrying={retryingPolicyId === selectedPolicy.id}
        />
      ) : null}
    </div>
  );
}

function AdminStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-slate-200 bg-white p-4">
      <p className="text-xs font-black uppercase text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}

function AdminOptionalResponsibilityGapPanel({
  gaps,
  loading,
  onMarkNotQuantifiable,
  onReextract,
}: {
  gaps: OptionalResponsibilityGap[];
  loading: boolean;
  onMarkNotQuantifiable: (gap: OptionalResponsibilityGap) => void;
  onReextract: () => void;
}) {
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">可选责任量化缺口</p>
          <p className="mt-1 text-xs font-medium text-slate-400">已识别但未完成结构化指标的可选责任</p>
        </div>
        <button type="button" disabled={loading} onClick={onReextract} className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50">
          重新拆解
        </button>
      </div>
      <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
        {gaps.map((gap) => (
          <article key={gap.id} className="rounded-[16px] border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs">
            <p className="font-black text-amber-900">{gap.productName}</p>
            <p className="mt-1 font-semibold text-amber-800">{gap.company} · {gap.liability}</p>
            <p className="mt-1 leading-5 text-amber-700">{gap.quantificationReason}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 font-black text-amber-700">{gap.recentPolicyCount} 张相关保单</span>
              <button type="button" disabled={loading} onClick={() => onMarkNotQuantifiable(gap)} className="rounded-full bg-white px-2.5 py-1 font-black text-slate-700 ring-1 ring-amber-100 disabled:opacity-50">
                标记不可量化
              </button>
            </div>
          </article>
        ))}
        {!gaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无量化缺口</p> : null}
      </div>
    </section>
  );
}

function AdminOfficialDomainPanel({
  profiles,
  form,
  loading,
  saving,
  onChange,
  onEdit,
  onReset,
  onRefresh,
  onSave,
  onDelete,
}: {
  profiles: AdminOfficialDomainProfile[];
  form: OfficialDomainForm;
  loading: boolean;
  saving: boolean;
  onChange: (form: OfficialDomainForm) => void;
  onEdit: (profile: AdminOfficialDomainProfile) => void;
  onReset: () => void;
  onRefresh: () => void;
  onSave: () => void;
  onDelete: (profile: AdminOfficialDomainProfile) => void;
}) {
  const customCount = profiles.filter((profile) => profile.source === 'custom').length;
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Shield size={16} />
            保险公司官方域名
          </div>
          <p className="mt-1 text-xs font-medium text-slate-400">维护报告检索使用的官网白名单</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" onClick={onRefresh}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>

      <div className="space-y-2">
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.company}
          onChange={(event) => onChange({ ...form, company: event.target.value })}
          placeholder="保险公司名称"
        />
        <textarea
          className="min-h-[64px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.aliasesText}
          onChange={(event) => onChange({ ...form, aliasesText: event.target.value })}
          placeholder="别名，一行一个，例如：平安保险"
        />
        <textarea
          className="min-h-[72px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.officialDomainsText}
          onChange={(event) => onChange({ ...form, officialDomainsText: event.target.value })}
          placeholder="官方域名，一行一个，例如：life.pingan.com"
        />
        <textarea
          className="min-h-[56px] w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.siteDomainsText}
          onChange={(event) => onChange({ ...form, siteDomainsText: event.target.value })}
          placeholder="搜索域名，可留空，默认同官方域名"
        />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
          type="button"
          disabled={saving || !form.company.trim() || !form.officialDomainsText.trim()}
          onClick={onSave}
        >
          {saving ? '保存中' : '保存白名单'}
        </button>
        <button className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500" type="button" onClick={onReset}>
          新增
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{profiles.length} 条白名单</span>
        <span>{customCount} 条自定义</span>
      </div>
      <div className="mt-2 max-h-[260px] space-y-2 overflow-auto pr-1">
        {profiles.map((profile) => {
          const custom = profile.source === 'custom';
          return (
            <div key={profile.id} className="rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <button className="min-w-0 text-left" type="button" onClick={() => onEdit(profile)}>
                  <p className="truncate font-black text-slate-900">{profile.company}</p>
                  <p className="mt-1 truncate text-xs font-medium text-slate-500">{(profile.officialDomains || []).join(' / ')}</p>
                </button>
                <span className={custom ? 'shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700' : 'shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-400'}>
                  {custom ? '自定义' : '系统'}
                </span>
              </div>
              {custom ? (
                <button className="mt-2 text-xs font-black text-red-500" type="button" disabled={saving} onClick={() => onDelete(profile)}>
                  删除
                </button>
              ) : null}
            </div>
          );
        })}
        {!profiles.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无白名单配置</p> : null}
      </div>
    </section>
  );
}

function AdminKnowledgePanel({
  records,
  form,
  loading,
  crawling,
  onChange,
  onRefresh,
  onCrawl,
}: {
  records: KnowledgeRecord[];
  form: KnowledgeCrawlForm;
  loading: boolean;
  crawling: boolean;
  onChange: (form: KnowledgeCrawlForm) => void;
  onRefresh: () => void;
  onCrawl: () => void;
}) {
  const officialCount = records.filter((record) => record.official).length;
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Database size={16} />
            本地产品知识库
          </div>
          <p className="mt-1 text-xs font-medium text-slate-400">先爬官网入库，生成报告优先用本地资料</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" disabled={loading} onClick={onRefresh}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>

      <div className="space-y-2">
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.company}
          onChange={(event) => onChange({ ...form, company: event.target.value })}
          placeholder="保险公司，例如：新华保险"
        />
        <input
          className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-300 focus:bg-white"
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
          placeholder="产品名称，例如：盛世荣耀臻享版终身寿险（分红型）"
        />
      </div>

      <button
        className="mt-3 flex w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60"
        type="button"
        disabled={crawling || !form.company.trim() || !form.name.trim()}
        onClick={onCrawl}
      >
        {crawling ? '爬取中...' : '爬取并写入知识库'}
      </button>

      <div className="mt-4 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{records.length} 条资料</span>
        <span>{officialCount} 条官方</span>
      </div>
      <div className="mt-2 max-h-[260px] space-y-2 overflow-auto pr-1">
        {records.slice(0, 30).map((record) => (
          <a
            key={`${record.id}-${record.url}`}
            className="block rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm transition hover:border-blue-100 hover:bg-blue-50"
            href={record.url}
            target="_blank"
            rel="noreferrer"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate font-black text-slate-900">{record.productName || record.title}</p>
              <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-black text-slate-500">
                {record.sourceType || 'html'}
              </span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-slate-500">{record.company}</p>
            <p className="mt-1 truncate text-xs text-slate-400">{record.url}</p>
          </a>
        ))}
        {!records.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无本地知识库资料</p> : null}
      </div>
    </section>
  );
}

function AdminOcrModePanel({
  config,
  loading,
  onRefresh,
  onChange,
}: {
  config: AdminOcrConfig | null;
  loading: boolean;
  onRefresh: () => void;
  onChange: (mode: string) => void;
}) {
  const currentMode = config?.config.mode || '';
  const updatedAt = config?.config.updatedAt ? formatDateLabel(config.config.updatedAt) : '';

  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-black">
            <Sparkles size={16} />
            OCR 识别方式
          </div>
          <p className="mt-1 text-xs font-medium text-slate-500">{config ? config.runtime.providerLabel : '正在读取配置'}</p>
        </div>
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600 disabled:opacity-50" type="button" disabled={loading} onClick={onRefresh}>
          刷新
        </button>
      </div>

      <div className="space-y-2">
        {(config?.options || []).map((option) => {
          const active = option.value === currentMode;
          return (
            <button
              key={option.value}
              type="button"
              disabled={loading || active || !option.selectable}
              onClick={() => onChange(option.value)}
              className={[
                'w-full rounded-2xl border px-3 py-3 text-left transition disabled:cursor-not-allowed',
                active
                  ? 'border-slate-950 bg-slate-950 text-white'
                  : option.selectable
                    ? 'border-slate-200 bg-slate-50 hover:border-slate-400'
                    : 'border-slate-100 bg-slate-50 text-slate-400',
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-black">{formatOcrModeLabel(option.value)}</span>
                <span className={active ? 'text-xs font-black text-white/70' : 'text-xs font-black text-slate-400'}>
                  {active ? '当前' : option.selectable ? '可切换' : '不可用'}
                </span>
              </div>
              <p className={active ? 'mt-1 text-xs font-medium leading-5 text-white/70' : 'mt-1 text-xs font-medium leading-5 text-slate-500'}>{option.description}</p>
            </button>
          );
        })}
        {!config ? <div className="rounded-2xl bg-slate-50 px-3 py-4 text-sm font-bold text-slate-500">{loading ? '加载中...' : '暂无 OCR 配置'}</div> : null}
      </div>

      <p className="mt-3 text-xs font-medium text-slate-400">
        当前模式：{formatOcrModeLabel(currentMode)}
        {updatedAt ? ` · ${updatedAt}` : ''}
      </p>
      {config?.runtime.localVisionFallback ? (
        <p className="mt-2 rounded-2xl bg-blue-50 px-3 py-2 text-xs font-bold leading-5 text-blue-700">
          本地视觉兜底：
          {config.runtime.localVisionFallback.enabled
            ? '已启用（仅图片，不处理 PDF）'
            : '未启用（仅图片，不处理 PDF）'}
        </p>
      ) : null}
    </section>
  );
}

function AdminPolicyDetail({
  policy,
  onClose,
  onRetryReport,
  retrying = false,
}: {
  policy: Policy;
  onClose: () => void;
  onRetryReport?: (policy: Policy) => void | Promise<void>;
  retrying?: boolean;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const exportTitle = buildPolicyReportTitle(policy);
  const reportGenerating = isPolicyReportGenerating(policy);
  const reportFailed = isPolicyReportFailed(policy);
  const responsibilities = Array.isArray(policy.responsibilities) ? policy.responsibilities : [];
  const policySources = Array.isArray(policy.sources) ? policy.sources : [];
  const responsibilitySourceLinks = getPolicyResponsibilitySourceLinks(policy);
  const exportControlTitle = getReportExportControlTitle();

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/25">
      <aside className="ml-auto flex h-full w-[560px] flex-col bg-white shadow-2xl">
        <header className="no-print flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <p className="text-xs font-black uppercase text-slate-400">保单详情</p>
            <h2 className="mt-1 text-xl font-black">{policy.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-bold ${
                reportGenerating ? 'bg-slate-100 text-slate-300' : 'bg-blue-50 text-blue-700'
              }`}
              type="button"
              disabled={reportGenerating}
              onClick={() => void downloadReportPdf(reportRef.current, exportTitle, policy)}
            >
              <Download size={17} />
              {exportControlTitle}
            </button>
            <button className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-bold" type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        <main ref={reportRef} className="print-policy-report flex-1 space-y-5 overflow-auto p-6">
          <section className="print-only">
            <h1>保单解析报告</h1>
            <p>生成时间：{generatedAt}</p>
          </section>

          {policy.report?.trim() ? (
            <section className="print-only print-policy-section">
              <h2>保险责任说明</h2>
              <ReportText text={policy.report} />
            </section>
          ) : null}

          {reportGenerating || reportFailed ? (
            <section className={`rounded-2xl border px-4 py-3 text-sm ${
              reportFailed ? 'border-red-100 bg-red-50 text-red-700' : 'border-orange-100 bg-orange-50 text-orange-700'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black">{reportFailed ? '报告生成失败' : '报告正在后台生成'}</p>
                  <p className="mt-1 text-xs leading-5">{reportFailed ? policy.reportError || '请稍后刷新查看。' : '保单已经保存，完整责任解析完成后会更新。'}</p>
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

          <section className="grid grid-cols-2 gap-3">
            <MetricBox label="账号" value={maskMobile(policy.userMobile || '')} />
            <MetricBox label="被保人" value={policy.insured || '-'} />
            <MetricBox label="投保人关系" value={policy.applicantRelation || '-'} />
            <MetricBox label="被保人关系" value={policy.insuredRelation || '-'} />
            <MetricBox label="保险公司" value={policy.company || '-'} />
            <MetricBox label="生效日期" value={policy.date || '-'} />
            <MetricBox label="保额" value={formatCoverageAmount(Number(policy.amount || 0))} />
            <MetricBox label="首期保费" value={formatCurrency(Number(policy.firstPremium || 0))} />
          </section>
          <section>
            <h3 className="mb-3 text-sm font-black">责任解析</h3>
            <div className="space-y-3">
              {responsibilitySourceLinks.length ? (
                <div className="rounded-2xl border border-blue-100 bg-blue-50 px-3 py-3">
                  <p className="text-xs font-black text-blue-700">官网地址</p>
                  <div className="mt-2 space-y-2">
                    {responsibilitySourceLinks.map((source) => (
                      <a
                        key={`${source.title}-${source.url}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-start gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-5 text-blue-700"
                      >
                        <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate font-black">{source.title || formatSourceUrlHost(source.url)}</span>
                          <span className="block break-all text-blue-500">{source.url}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
              {responsibilities.length ? (
                responsibilities.map((row, index) => (
                  <article key={`${row.coverageType}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <h4 className="font-black">{row.coverageType}</h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{row.scenario}</p>
                    <p className="mt-2 rounded-xl bg-white px-3 py-2 text-sm font-bold text-blue-700">{row.payout}</p>
                    {row.note ? <p className="mt-2 text-xs text-slate-500">{row.note}</p> : null}
                  </article>
                ))
              ) : (
                <article className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  {reportGenerating ? '正在生成完整保险责任解析。' : '暂无责任解析。'}
                </article>
              )}
            </div>
          </section>
          {policySources.length ? (
            <section className="no-print">
              <h3 className="mb-3 text-sm font-black">资料来源</h3>
              <div className="space-y-2">
                {policySources.map((source, index) => (
                  <a
                    key={`${source.url}-${index}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-3 text-sm transition hover:border-blue-200 hover:bg-blue-50"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-black text-slate-800">{source.title || source.url}</span>
                      <span className={source.official ? 'shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-black text-blue-700' : 'shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-black text-slate-500'}>
                        {source.official ? '官方' : source.evidenceLabel || '辅助'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{source.url}</p>
                  </a>
                ))}
              </div>
            </section>
          ) : null}
          <section className="no-print">
            <h3 className="mb-3 text-sm font-black">OCR 原文</h3>
            <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">{policy.ocrText || '暂无 OCR 原文'}</pre>
          </section>
        </main>
      </aside>
    </div>
  );
}
