import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  LayoutDashboard,
  Search,
  Users,
} from 'lucide-react';
import {
  AdminOfficialDomainProfile,
  AdminMembershipConfig,
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
  getAdminMembershipConfig,
  getAdminOverview,
  markOptionalResponsibilityNotQuantifiable,
  regeneratePolicyReport,
  reextractOptionalResponsibilities,
  updateAdminMembershipConfig,
  updateAdminOfficialDomainProfile,
} from '../../api';

import {
  formatCoverageAmount,
  formatDateLabel,
  maskMobile,
} from '../../shared/formatters';
import {
  AdminOfficialDomainPanel,
  emptyOfficialDomainForm,
  formToOfficialDomainPayload,
  profileToOfficialDomainForm,
  type OfficialDomainForm,
} from '../../features/admin-official-domain/AdminOfficialDomainPanel';
import {
  AdminKnowledgePanel,
  emptyKnowledgeCrawlForm,
  type KnowledgeCrawlForm,
} from '../../features/admin-knowledge/AdminKnowledgePanel';
import { AdminOptionalResponsibilityGapPanel } from '../../features/admin-governance/AdminOptionalResponsibilityGapPanel';
import { AdminPolicyDetail } from '../../features/admin-policy-detail/AdminPolicyDetail';
import { AdminStatCard } from '../../features/admin-shared/AdminStatCard';
import { TextField } from '../../features/admin-shared/TextField';
import {
  isPolicyReportFailed,
  isPolicyReportGenerating,
} from '../../shared/policy-report-ui';

const ADMIN_TOKEN_KEY = 'policy-ocr-app.adminToken';

export function AdminApp() {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [password, setPassword] = useState('');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [officialDomainProfiles, setOfficialDomainProfiles] = useState<AdminOfficialDomainProfile[]>([]);
  const [officialDomainForm, setOfficialDomainForm] = useState<OfficialDomainForm>(emptyOfficialDomainForm);
  const [knowledgeRecords, setKnowledgeRecords] = useState<KnowledgeRecord[]>([]);
  const [knowledgeCrawlForm, setKnowledgeCrawlForm] = useState<KnowledgeCrawlForm>(emptyKnowledgeCrawlForm);
  const [query, setQuery] = useState('');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState<number | null>(null);
  const [message, setMessage] = useState('输入后台密码进入平台只读管理台');
  const [loading, setLoading] = useState(false);
  const [membershipConfig, setMembershipConfig] = useState<AdminMembershipConfig | null>(null);
  const [membershipQuotaInput, setMembershipQuotaInput] = useState('3');
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [officialDomainLoading, setOfficialDomainLoading] = useState(false);
  const [officialDomainSaving, setOfficialDomainSaving] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeCrawling, setKnowledgeCrawling] = useState(false);
  const [retryingPolicyId, setRetryingPolicyId] = useState<number | null>(null);

  function clearAdminAuthState() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setAdminToken('');
    setOverview(null);
    setMembershipConfig(null);
    setMembershipQuotaInput('3');
    setOfficialDomainProfiles([]);
    setOfficialDomainForm(emptyOfficialDomainForm);
    setKnowledgeRecords([]);
    setKnowledgeCrawlForm(emptyKnowledgeCrawlForm);
    setSelectedPolicy(null);
    setSelectedAdminUserId(null);
  }

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
        clearAdminAuthState();
      }
      setMessage(error instanceof Error ? error.message : '后台数据加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function loadMembershipConfig(token = adminToken) {
    if (!token) return;
    try {
      const payload = await getAdminMembershipConfig(token);
      setMembershipConfig(payload.config);
      setMembershipQuotaInput(String(payload.config.registeredFreePolicyQuota));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearAdminAuthState();
      }
      setMessage(error instanceof Error ? error.message : '会员设置读取失败');
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
        clearAdminAuthState();
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
        clearAdminAuthState();
      }
      setMessage(error instanceof Error ? error.message : '本地知识库读取失败');
    } finally {
      setKnowledgeLoading(false);
    }
  }

  useEffect(() => {
    if (!adminToken) return;
    void loadMembershipConfig(adminToken);
    void loadOfficialDomainProfiles(adminToken);
    const overviewTimer = window.setTimeout(() => {
      void loadOverview(adminToken);
    }, 300);
    return () => window.clearTimeout(overviewTimer);
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
      setMessage('登录成功，正在加载会员设置');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台登录失败');
    } finally {
      setLoading(false);
    }
  }

  function logoutAdmin() {
    clearAdminAuthState();
    setMessage('已退出管理后台');
  }

  async function handleSaveMembershipConfig() {
    if (!adminToken || !membershipConfig || membershipSaving) return;
    const normalizedQuotaInput = membershipQuotaInput.trim();
    if (!/^\d+$/.test(normalizedQuotaInput)) {
      setMessage('免费保存保单数请输入非负整数');
      return;
    }
    const quota = Number(normalizedQuotaInput);
    setMembershipSaving(true);
    setMessage('正在保存会员设置');
    try {
      const payload = await updateAdminMembershipConfig(adminToken, {
        enabled: membershipConfig.enabled,
        registeredFreePolicyQuota: quota,
      });
      setMembershipConfig(payload.config);
      setMembershipQuotaInput(String(payload.config.registeredFreePolicyQuota));
      setMessage('会员设置已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearAdminAuthState();
      }
      setMessage(error instanceof Error ? error.message : '会员设置保存失败');
    } finally {
      setMembershipSaving(false);
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
                void loadMembershipConfig();
                void loadOfficialDomainProfiles();
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

            <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-black text-slate-950">会员设置</h2>
                  <p className="mt-1 text-xs font-medium text-slate-400">控制年度会员购买和免费保单额度</p>
                </div>
                <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-400">300 元/年</span>
              </div>
              <label className="mt-4 flex items-center justify-between gap-3 rounded-[16px] border border-slate-200 bg-slate-50 px-3 py-2.5">
                <span className="text-sm font-bold text-slate-700">开放会员购买</span>
                <input
                  type="checkbox"
                  checked={membershipConfig?.enabled ?? true}
                  onChange={(event) => setMembershipConfig((current) => (current ? { ...current, enabled: event.target.checked } : current))}
                />
              </label>
              <label className="mt-3 block">
                <span className="text-xs font-black text-slate-400">注册用户免费保存保单数</span>
                <input
                  className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition focus:border-slate-400"
                  type="number"
                  min="0"
                  value={membershipQuotaInput}
                  onChange={(event) => setMembershipQuotaInput(event.target.value)}
                />
              </label>
              <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">年费价格 300 元，有效期 365 天。免费额度只按已成功保存保单数计算。</p>
              <button
                className="mt-4 h-11 w-full rounded-xl bg-slate-950 px-4 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(15,23,42,0.9)] disabled:opacity-60"
                type="button"
                disabled={!membershipConfig || membershipSaving}
                onClick={() => void handleSaveMembershipConfig()}
              >
                {membershipSaving ? '保存中...' : '保存会员设置'}
              </button>
            </section>

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
