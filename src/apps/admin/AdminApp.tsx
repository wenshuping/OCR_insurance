import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { LayoutDashboard } from 'lucide-react';
import {
  AdminOfficialDomainProfile,
  AdminMembershipConfig,
  AdminOverview,
  AdminReportCorrection,
  AdminReportIssue,
  AdminReportIssueSummary,
  AdminUserFamiliesResponse,
  ApiError,
  FamilyReportRecord,
  FamilySalesChatThread,
  FamilySalesReview,
  KnowledgeRecord,
  OptionalResponsibilityGap,
  Policy,
  adminLogin,
  crawlAdminKnowledge,
  createAdminOfficialDomainProfile,
  createAdminFamilyReport,
  deleteAdminOfficialDomainProfile,
  getAdminOfficialDomainProfiles,
  getAdminKnowledgeRecords,
  getAdminMembershipConfig,
  getAdminOverview,
  getAdminFamilySalesReview,
  getAdminFamilySalesChatThreads,
  getAdminFamilyReport,
  getAdminReportIssueDetail,
  getAdminReportIssues,
  getAdminOptionalResponsibilityGaps,
  getAdminPolicy,
  getAdminUserFamilies,
  markOptionalResponsibilityNotQuantifiable,
  regeneratePolicyReport,
  reextractOptionalResponsibilities,
  updateAdminMembershipConfig,
  updateAdminOfficialDomainProfile,
} from '../../api';
import { maskMobile } from '../../shared/formatters';
import {
  emptyOfficialDomainForm,
  formToOfficialDomainPayload,
  profileToOfficialDomainForm,
  type OfficialDomainForm,
} from '../../features/admin-official-domain/AdminOfficialDomainPanel';
import {
  emptyKnowledgeCrawlForm,
  type KnowledgeCrawlForm,
} from '../../features/admin-knowledge/AdminKnowledgePanel';
import { TextField } from '../../features/admin-shared/TextField';
import { isPolicyReportGenerating } from '../../shared/policy-report-ui';
import { AdminShell } from './AdminShell';
import type { AdminPageKey } from './adminPages';
import { AdminKnowledgePage } from './pages/AdminKnowledgePage';
import { AdminFamilyReportPage } from './pages/AdminFamilyReportPage';
import { AdminMembershipPage } from './pages/AdminMembershipPage';
import { AdminOfficialDomainsPage } from './pages/AdminOfficialDomainsPage';
import { AdminOptionalResponsibilitiesPage } from './pages/AdminOptionalResponsibilitiesPage';
import { AdminOverviewPage } from './pages/AdminOverviewPage';
import { AdminPoliciesPage } from './pages/AdminPoliciesPage';
import { AdminReportIssuesPage } from './pages/AdminReportIssuesPage';
import { AdminSalesReviewPage } from './pages/AdminSalesReviewPage';
import { AdminUsersPage } from './pages/AdminUsersPage';

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
  const [selectedAdminFamilyId, setSelectedAdminFamilyId] = useState<number | null>(null);
  const [selectedUserFamilies, setSelectedUserFamilies] = useState<AdminUserFamiliesResponse | null>(null);
  const [userFamiliesLoading, setUserFamiliesLoading] = useState(false);
  const [selectedFamilyReport, setSelectedFamilyReport] = useState<FamilyReportRecord | null>(null);
  const [selectedFamilyReportFamilyName, setSelectedFamilyReportFamilyName] = useState('');
  const [familyReportLoading, setFamilyReportLoading] = useState(false);
  const [familyReportGenerating, setFamilyReportGenerating] = useState(false);
  const [selectedSalesReview, setSelectedSalesReview] = useState<FamilySalesReview | null>(null);
  const [selectedSalesReviewFamilyName, setSelectedSalesReviewFamilyName] = useState('');
  const [selectedSalesChatThreads, setSelectedSalesChatThreads] = useState<FamilySalesChatThread[]>([]);
  const [salesReviewLoading, setSalesReviewLoading] = useState(false);
  const [message, setMessage] = useState('输入后台密码进入平台只读管理台');
  const [loading, setLoading] = useState(false);
  const [membershipConfig, setMembershipConfig] = useState<AdminMembershipConfig | null>(null);
  const [membershipQuotaInput, setMembershipQuotaInput] = useState('3');
  const [familyReportDailyRefreshLimitInput, setFamilyReportDailyRefreshLimitInput] = useState('3');
  const [familySalesReviewDailyRefreshLimitInput, setFamilySalesReviewDailyRefreshLimitInput] = useState('3');
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [officialDomainLoading, setOfficialDomainLoading] = useState(false);
  const [officialDomainSaving, setOfficialDomainSaving] = useState(false);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeCrawling, setKnowledgeCrawling] = useState(false);
  const [retryingPolicyId, setRetryingPolicyId] = useState<number | null>(null);
  const [activePage, setActivePage] = useState<AdminPageKey>('overview');
  const [reportIssueReports, setReportIssueReports] = useState<AdminReportIssueSummary[]>([]);
  const [selectedReportIssueReport, setSelectedReportIssueReport] = useState<AdminReportIssueSummary | null>(null);
  const [selectedReportIssues, setSelectedReportIssues] = useState<AdminReportIssue[]>([]);
  const [selectedReportCorrections, setSelectedReportCorrections] = useState<AdminReportCorrection[]>([]);
  const [reportIssuesLoading, setReportIssuesLoading] = useState(false);
  const [optionalResponsibilityGaps, setOptionalResponsibilityGaps] = useState<OptionalResponsibilityGap[]>([]);
  const [optionalResponsibilityGapsLoading, setOptionalResponsibilityGapsLoading] = useState(false);

  function clearAdminAuthState() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    setAdminToken('');
    setOverview(null);
    setMembershipConfig(null);
    setMembershipQuotaInput('3');
    setFamilyReportDailyRefreshLimitInput('3');
    setFamilySalesReviewDailyRefreshLimitInput('3');
    setOfficialDomainProfiles([]);
    setOfficialDomainForm(emptyOfficialDomainForm);
    setKnowledgeRecords([]);
    setKnowledgeCrawlForm(emptyKnowledgeCrawlForm);
    setSelectedPolicy(null);
    setSelectedAdminUserId(null);
    setSelectedAdminFamilyId(null);
    setSelectedUserFamilies(null);
    setSelectedFamilyReport(null);
    setSelectedFamilyReportFamilyName('');
    setSelectedSalesReview(null);
    setSelectedSalesReviewFamilyName('');
    setSelectedSalesChatThreads([]);
    setReportIssueReports([]);
    setSelectedReportIssueReport(null);
    setSelectedReportIssues([]);
    setSelectedReportCorrections([]);
    setOptionalResponsibilityGaps([]);
    setActivePage('overview');
  }

  async function loadOverview(token = adminToken) {
    if (!token) return;
    setLoading(true);
    try {
      const payload = await getAdminOverview(token);
      setOverview(payload);
      setOptionalResponsibilityGaps((current) => {
        const preview = payload.optionalResponsibilityGaps || [];
        const expectedCount = payload.summary.optionalResponsibilityGapCount ?? preview.length;
        return current.length === expectedCount ? current : preview;
      });
      setSelectedPolicy((current) => {
        if (!current) return current;
        const summary = payload.policies.find((policy) => Number(policy.id) === Number(current.id));
        return summary ? { ...summary, ...current, report: summary.report, reportStatus: summary.reportStatus, reportError: summary.reportError } : current;
      });
      setMessage('平台数据已加载');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
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
      setFamilyReportDailyRefreshLimitInput(String(payload.config.familyReportDailyRefreshLimit));
      setFamilySalesReviewDailyRefreshLimitInput(String(payload.config.familySalesReviewDailyRefreshLimit));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
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
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
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
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '本地知识库读取失败');
    } finally {
      setKnowledgeLoading(false);
    }
  }

  async function loadReportIssues(token = adminToken) {
    if (!token) return;
    setReportIssuesLoading(true);
    try {
      const payload = await getAdminReportIssues(token);
      setReportIssueReports(payload.reports);
      setSelectedReportIssueReport((current) => (
        current ? payload.reports.find((row) => Number(row.id) === Number(current.id)) || null : current
      ));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '报告问题读取失败');
    } finally {
      setReportIssuesLoading(false);
    }
  }

  async function loadAdminOptionalResponsibilityGaps(token = adminToken) {
    if (!token) return;
    setOptionalResponsibilityGapsLoading(true);
    try {
      const payload = await getAdminOptionalResponsibilityGaps(token);
      setOptionalResponsibilityGaps(payload.gaps);
      setMessage('可选责任治理列表已加载');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '可选责任治理列表读取失败');
    } finally {
      setOptionalResponsibilityGapsLoading(false);
    }
  }

  async function loadSelectedUserFamilies(userId: number, token = adminToken) {
    if (!token || !userId) return;
    setUserFamiliesLoading(true);
    try {
      const payload = await getAdminUserFamilies(token, userId);
      setSelectedUserFamilies(payload);
      setMessage('用户家庭列表已加载');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '用户家庭列表读取失败');
    } finally {
      setUserFamiliesLoading(false);
    }
  }

  async function loadAdminFamilyReport(familyId: number, token = adminToken) {
    if (!token || !familyId) return;
    setFamilyReportLoading(true);
    setSelectedFamilyReport(null);
    try {
      const payload = await getAdminFamilyReport(token, familyId);
      setSelectedFamilyReport(payload.reportRecord || null);
      setMessage(payload.reportRecord?.report ? '家庭保单分析报告已加载' : '暂无已保存家庭保单分析报告');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '家庭保单分析报告读取失败');
    } finally {
      setFamilyReportLoading(false);
    }
  }

  async function generateAdminFamilyReport(familyId = selectedAdminFamilyId || 0, token = adminToken) {
    if (!token || !familyId || familyReportGenerating) return;
    setFamilyReportGenerating(true);
    setMessage('正在生成家庭保单分析报告');
    try {
      const payload = await createAdminFamilyReport(token, familyId);
      setSelectedFamilyReport(payload.reportRecord || null);
      setMessage('家庭保单分析报告已生成');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '家庭保单分析报告生成失败');
    } finally {
      setFamilyReportGenerating(false);
    }
  }

  async function loadAdminFamilySalesReview(familyId: number, token = adminToken) {
    if (!token || !familyId) return;
    setSalesReviewLoading(true);
    setSelectedSalesReview(null);
    setSelectedSalesChatThreads([]);
    try {
      const [payload, chatPayload] = await Promise.all([
        getAdminFamilySalesReview(token, familyId),
        getAdminFamilySalesChatThreads(token, familyId),
      ]);
      setSelectedSalesReview(payload.review || null);
      setSelectedSalesChatThreads(chatPayload.threads || []);
      setMessage(payload.review?.content ? '销售建议已加载' : '暂无已保存销售建议');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '销售建议读取失败');
    } finally {
      setSalesReviewLoading(false);
    }
  }

  async function openReportIssueDetail(report: AdminReportIssueSummary) {
    if (!adminToken) return;
    setSelectedReportIssueReport(report);
    setSelectedReportIssues([]);
    setSelectedReportCorrections([]);
    setReportIssuesLoading(true);
    try {
      const payload = await getAdminReportIssueDetail(adminToken, report.id);
      setSelectedReportIssueReport(payload.report);
      setSelectedReportIssues(payload.issues);
      setSelectedReportCorrections(payload.corrections || []);
      setMessage('报告问题详情已加载');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '报告问题详情读取失败');
    } finally {
      setReportIssuesLoading(false);
    }
  }

  useEffect(() => {
    if (!adminToken) return;
    void loadMembershipConfig(adminToken);
    void loadOfficialDomainProfiles(adminToken);
    void loadReportIssues(adminToken);
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
    const normalizedFamilyReportLimitInput = familyReportDailyRefreshLimitInput.trim();
    const normalizedSalesReviewLimitInput = familySalesReviewDailyRefreshLimitInput.trim();
    if (!/^\d+$/.test(normalizedFamilyReportLimitInput)) {
      setMessage('家庭保单分析报告每日刷新次数请输入非负整数');
      return;
    }
    if (!/^\d+$/.test(normalizedSalesReviewLimitInput)) {
      setMessage('营销建议报告每日刷新次数请输入非负整数');
      return;
    }
    setMembershipSaving(true);
    setMessage('正在保存会员设置');
    try {
      const payload = await updateAdminMembershipConfig(adminToken, {
        enabled: membershipConfig.enabled,
        registeredFreePolicyQuota: Number(normalizedQuotaInput),
        familyReportDailyRefreshLimit: Number(normalizedFamilyReportLimitInput),
        familySalesReviewDailyRefreshLimit: Number(normalizedSalesReviewLimitInput),
      });
      setMembershipConfig(payload.config);
      setMembershipQuotaInput(String(payload.config.registeredFreePolicyQuota));
      setFamilyReportDailyRefreshLimitInput(String(payload.config.familyReportDailyRefreshLimit));
      setFamilySalesReviewDailyRefreshLimitInput(String(payload.config.familySalesReviewDailyRefreshLimit));
      setMessage('会员设置已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
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

  async function openAdminPolicy(policy: Policy) {
    if (!policy) return;
    const policyId = Number(policy.id);
    setSelectedPolicy(policy);
    if (!adminToken || !policyId) return;
    try {
      const payload = await getAdminPolicy(adminToken, policyId);
      setSelectedPolicy((current) => (Number(current?.id || 0) === policyId ? payload.policy : current));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearAdminAuthState();
      setMessage(error instanceof Error ? error.message : '保单详情读取失败');
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
      await loadAdminOptionalResponsibilityGaps(adminToken);
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
      await loadAdminOptionalResponsibilityGaps(adminToken);
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
    setSelectedAdminFamilyId(null);
    setSelectedUserFamilies(null);
  }, [overview, selectedAdminUser, selectedAdminUserId]);

  function matchesAdminQuery(values: Array<unknown>) {
    if (!normalizedQuery) return true;
    return values
      .filter((value) => value !== undefined && value !== null)
      .some((value) => String(value).toLowerCase().includes(normalizedQuery));
  }

  const filteredUsers = useMemo(() => {
    const rows = overview?.users || [];
    if (!normalizedQuery) return rows;
    return rows.filter((user) =>
      matchesAdminQuery([
        user.mobile,
        maskMobile(user.mobile),
        user.id,
        `${user.familyCount || 0} 家庭`,
        `${user.policyCount} 保单`,
        `${user.insuredCount} 被保人`,
      ]),
    );
  }, [overview, normalizedQuery]);

  const filteredPolicies = useMemo(() => {
    const rows = overview?.policies || [];
    return rows.filter((policy) => {
      if (selectedAdminUserId && String(policy.userMobile || '') !== String(selectedAdminUser?.mobile || '')) return false;
      if (selectedAdminFamilyId && Number(policy.familyId || 0) !== Number(selectedAdminFamilyId)) return false;
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
  }, [overview, normalizedQuery, selectedAdminFamilyId, selectedAdminUser?.mobile, selectedAdminUserId]);

  function formatAdminMobile(mobileValue: string) {
    return String(mobileValue || '').trim() || '未绑定手机号';
  }

  function selectAdminUser(userId: number) {
    setSelectedAdminUserId(userId);
    setSelectedAdminFamilyId(null);
    setSelectedUserFamilies(null);
    setSelectedFamilyReport(null);
    setSelectedFamilyReportFamilyName('');
    setSelectedSalesReview(null);
    setSelectedSalesReviewFamilyName('');
    void loadSelectedUserFamilies(userId);
  }

  function clearPolicyFilters() {
    setSelectedAdminUserId(null);
    setSelectedAdminFamilyId(null);
    setSelectedUserFamilies(null);
  }

  function changeAdminPage(page: AdminPageKey) {
    setActivePage(page);
    if (page === 'knowledge' && !knowledgeRecords.length) void loadKnowledgeRecords();
    if (page === 'reportIssues' && !reportIssueReports.length) void loadReportIssues();
    if (page === 'optionalResponsibilities') {
      const expectedCount = overview?.summary.optionalResponsibilityGapCount ?? 0;
      if (!optionalResponsibilityGaps.length || optionalResponsibilityGaps.length < expectedCount) {
        void loadAdminOptionalResponsibilityGaps();
      }
    }
    if (page === 'officialDomains' && !officialDomainProfiles.length) void loadOfficialDomainProfiles();
    if (page === 'membership' && !membershipConfig) void loadMembershipConfig();
  }

  function openAdminFamilyPolicies(familyId: number) {
    setSelectedAdminFamilyId(familyId);
    changeAdminPage('policies');
    setSelectedPolicy(null);
    setMessage('已筛选该家庭的保单');
  }

  function openAdminFamilyReport(familyId: number) {
    const family = selectedUserFamilies?.families.find((row) => Number(row.id) === Number(familyId)) || null;
    setSelectedAdminFamilyId(familyId);
    setSelectedFamilyReportFamilyName(family?.familyName || `家庭 ${familyId}`);
    changeAdminPage('familyReport');
    void loadAdminFamilyReport(familyId);
  }

  function openAdminFamilySalesReview(familyId: number) {
    const family = selectedUserFamilies?.families.find((row) => Number(row.id) === Number(familyId)) || null;
    setSelectedAdminFamilyId(familyId);
    setSelectedSalesReviewFamilyName(family?.familyName || `家庭 ${familyId}`);
    changeAdminPage('salesReview');
    void loadAdminFamilySalesReview(familyId);
  }

  function refreshCurrentAdminPage() {
    if (activePage === 'overview') {
      void loadOverview();
      void loadReportIssues();
    } else if (activePage === 'policies' || activePage === 'optionalResponsibilities') {
      void loadOverview();
      if (activePage === 'optionalResponsibilities') void loadAdminOptionalResponsibilityGaps();
    } else if (activePage === 'users') {
      void loadOverview();
      if (selectedAdminUserId) void loadSelectedUserFamilies(selectedAdminUserId);
    } else if (activePage === 'familyReport' && selectedAdminFamilyId) {
      void loadAdminFamilyReport(selectedAdminFamilyId);
    } else if (activePage === 'reportIssues') {
      void loadReportIssues();
    } else if (activePage === 'knowledge') {
      void loadKnowledgeRecords();
    } else if (activePage === 'officialDomains') {
      void loadOfficialDomainProfiles();
    } else if (activePage === 'membership') {
      void loadMembershipConfig();
    } else if (activePage === 'salesReview' && selectedAdminFamilyId) {
      void loadAdminFamilySalesReview(selectedAdminFamilyId);
    }
  }

  function renderAdminPage() {
    switch (activePage) {
      case 'overview':
        return <AdminOverviewPage overview={overview} reportIssueReports={reportIssueReports} onNavigate={changeAdminPage} />;
      case 'policies':
        return (
          <AdminPoliciesPage
            filteredPolicies={filteredPolicies}
            selectedAdminUserLabel={selectedAdminFamilyId ? `家庭 ${selectedAdminFamilyId}` : (selectedAdminUser ? formatAdminMobile(selectedAdminUser.mobile) : '')}
            selectedPolicy={selectedPolicy}
            retryingPolicyId={retryingPolicyId}
            onClearUserFilter={clearPolicyFilters}
            onSelectPolicy={(policy) => (policy ? void openAdminPolicy(policy) : setSelectedPolicy(null))}
            onRetryPolicyReport={(policy) => void retryAdminPolicyReport(policy)}
          />
        );
      case 'users':
        return (
          <AdminUsersPage
            users={filteredUsers}
            selectedUserId={selectedAdminUserId}
            familiesPayload={selectedUserFamilies}
            loadingFamilies={userFamiliesLoading}
            onSelectUser={selectAdminUser}
            onOpenFamilyReport={openAdminFamilyReport}
            onViewFamilyPolicies={openAdminFamilyPolicies}
            onOpenSalesReview={openAdminFamilySalesReview}
          />
        );
      case 'familyReport':
        return (
          <AdminFamilyReportPage
            reportRecord={selectedFamilyReport}
            familyName={selectedFamilyReportFamilyName}
            loading={familyReportLoading}
            generating={familyReportGenerating}
            onBack={() => changeAdminPage('users')}
            onGenerate={() => void generateAdminFamilyReport()}
          />
        );
      case 'reportIssues':
        return (
          <AdminReportIssuesPage
            reports={reportIssueReports}
            selectedReport={selectedReportIssueReport}
            issues={selectedReportIssues}
            corrections={selectedReportCorrections}
            loading={reportIssuesLoading}
            onRefresh={() => void loadReportIssues()}
            onOpenReport={(report) => void openReportIssueDetail(report)}
          />
        );
      case 'optionalResponsibilities':
        return (
          <AdminOptionalResponsibilitiesPage
            gaps={optionalResponsibilityGaps}
            loading={loading || optionalResponsibilityGapsLoading}
            onMarkNotQuantifiable={(gap) => void handleMarkOptionalNotQuantifiable(gap)}
            onReextract={() => void handleReextractOptionalResponsibilities()}
          />
        );
      case 'knowledge':
        return (
          <AdminKnowledgePage
            records={knowledgeRecords}
            form={knowledgeCrawlForm}
            loading={knowledgeLoading}
            crawling={knowledgeCrawling}
            onChange={setKnowledgeCrawlForm}
            onRefresh={() => void loadKnowledgeRecords()}
            onCrawl={() => void crawlKnowledgeRecords()}
          />
        );
      case 'officialDomains':
        return (
          <AdminOfficialDomainsPage
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
        );
      case 'membership':
        return (
          <AdminMembershipPage
            config={membershipConfig}
            quotaInput={membershipQuotaInput}
            familyReportDailyRefreshLimitInput={familyReportDailyRefreshLimitInput}
            familySalesReviewDailyRefreshLimitInput={familySalesReviewDailyRefreshLimitInput}
            saving={membershipSaving}
            onToggleEnabled={(enabled) => setMembershipConfig((current) => (current ? { ...current, enabled } : current))}
            onQuotaInputChange={setMembershipQuotaInput}
            onFamilyReportDailyRefreshLimitInputChange={setFamilyReportDailyRefreshLimitInput}
            onFamilySalesReviewDailyRefreshLimitInputChange={setFamilySalesReviewDailyRefreshLimitInput}
            onSave={() => void handleSaveMembershipConfig()}
          />
        );
      case 'salesReview':
        return (
          <AdminSalesReviewPage
            review={selectedSalesReview}
            chatThreads={selectedSalesChatThreads}
            familyName={selectedSalesReviewFamilyName}
            loading={salesReviewLoading}
            onBack={() => changeAdminPage('users')}
          />
        );
      default:
        return null;
    }
  }

  if (!adminToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#EEF3F8] px-6">
        <section className="w-full max-w-md rounded-[26px] border border-white bg-white p-8 shadow-[0_24px_80px_-50px_rgba(15,23,42,0.45)]">
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-white">
              <LayoutDashboard size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-950">平台管理后台</h1>
              <p className="mt-1 text-sm text-slate-500">只读查看账号、家庭和保单</p>
            </div>
          </div>
          <TextField label="后台密码" value={password} onChange={setPassword} type="password" placeholder="请输入后台密码" />
          <button
            className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-blue-600 text-sm font-black text-white transition hover:bg-blue-700 disabled:opacity-60"
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
    <AdminShell
      activePage={activePage}
      query={query}
      message={message}
      loading={loading || reportIssuesLoading || userFamiliesLoading || familyReportLoading || familyReportGenerating || salesReviewLoading || optionalResponsibilityGapsLoading}
      badgeCounts={{
        reportIssues: reportIssueReports.length,
        optionalResponsibilities: overview?.summary.optionalResponsibilityGapCount ?? optionalResponsibilityGaps.length,
      }}
      onPageChange={changeAdminPage}
      onQueryChange={setQuery}
      onRefresh={refreshCurrentAdminPage}
      onLogout={logoutAdmin}
    >
      {renderAdminPage()}
    </AdminShell>
  );
}
