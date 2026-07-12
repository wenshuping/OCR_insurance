# Admin Backoffice Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/admin` into a left-navigation backoffice with an operation overview, focused admin pages, and a read-only user family viewer.

**Architecture:** Keep the existing React/Vite admin app and Express admin API. Split the current large `AdminApp` into a shell plus page components, reuse existing admin API calls, and add one narrow read-only admin endpoint for selected user's family list. Avoid new dependencies and keep all admin user-family actions read-only.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, lucide-react, Express ESM routes, Node test runner.

---

## Files

- Modify: `server/routes/admin.routes.mjs`
  - Add a read-only `GET /api/admin/users/:userId/families` route.
  - Use `requireAdmin`, `listFamilyMembers`, `state.familyProfiles`, and `state.policies`.
- Modify: `src/api/contracts/admin.ts`
  - Add admin family summary types and `getAdminUserFamilies`.
  - Extend `AdminUserSummary` and `AdminOverview.summary` with family counts.
- Modify: `server/app.mjs`
  - Add family counts to `buildAdminOverview`.
- Modify: `src/apps/admin/AdminApp.tsx`
  - Reduce it to auth, shared state, data loading, action handlers, and page selection.
- Create: `src/apps/admin/AdminShell.tsx`
  - Sidebar, top toolbar, page metadata, search, refresh, logout.
- Create: `src/apps/admin/adminPages.ts`
  - Page key, labels, groups, icon mapping metadata.
- Create: `src/apps/admin/pages/AdminOverviewPage.tsx`
  - Stats and operational queues.
- Create: `src/apps/admin/pages/AdminPoliciesPage.tsx`
  - Policy list and selected policy detail entry.
- Create: `src/apps/admin/pages/AdminUsersPage.tsx`
  - User list and selected user's read-only family cards.
- Create: `src/apps/admin/pages/AdminReportIssuesPage.tsx`
  - Report issue list and detail.
- Create: `src/apps/admin/pages/AdminOptionalResponsibilitiesPage.tsx`
  - Optional responsibility gap governance page.
- Create: `src/apps/admin/pages/AdminKnowledgePage.tsx`
  - Product knowledge page wrapper.
- Create: `src/apps/admin/pages/AdminOfficialDomainsPage.tsx`
  - Official domain page wrapper.
- Create: `src/apps/admin/pages/AdminMembershipPage.tsx`
  - Membership settings page.
- Test: `tests/policy-ocr-flow.test.mjs`
  - Add admin read-only user families route coverage.
- Test: `tests/customer-ui-style.test.mjs`
  - Add source-level admin page checks for navigation and no mutation controls on user page.

## Task 1: Admin Family Read API

**Files:**
- Modify: `server/routes/admin.routes.mjs`
- Modify: `src/api/contracts/admin.ts`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add the failing route test**

Add this test near the existing admin tests in `tests/policy-ocr-flow.test.mjs`:

```js
test('admin can list selected user families without mutating family state', async () => {
  const state = createInitialState();
  state.users = [{ id: 1, mobile: '13800000000', createdAt: '2026-06-17T00:00:00.000Z', updatedAt: '2026-06-17T00:00:00.000Z' }];
  state.adminSessions = [{ token: 'admin-token', createdAt: '2026-06-17T00:01:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z' }];
  state.familyProfiles = [
    { id: 10, ownerUserId: 1, ownerGuestId: '', familyName: '默认家庭', coreMemberId: 11, status: 'active', createdAt: '2026-06-17T00:02:00.000Z', updatedAt: '2026-06-17T00:02:00.000Z' },
    { id: 20, ownerUserId: 1, ownerGuestId: '', familyName: '吴连英', coreMemberId: null, status: 'active', createdAt: '2026-06-17T00:03:00.000Z', updatedAt: '2026-06-17T00:03:00.000Z' },
    { id: 30, ownerUserId: 2, ownerGuestId: '', familyName: '其他用户家庭', coreMemberId: null, status: 'active', createdAt: '2026-06-17T00:04:00.000Z', updatedAt: '2026-06-17T00:04:00.000Z' },
  ];
  state.familyMembers = [
    { id: 11, familyId: 10, name: '温舒萍', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active', createdAt: '2026-06-17T00:02:10.000Z', updatedAt: '2026-06-17T00:02:10.000Z' },
    { id: 12, familyId: 10, name: '冯力', relationToCore: 'spouse', relationLabel: '配偶', role: 'adult', status: 'active', createdAt: '2026-06-17T00:02:20.000Z', updatedAt: '2026-06-17T00:02:20.000Z' },
    { id: 21, familyId: 20, name: '翟卿', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active', createdAt: '2026-06-17T00:03:10.000Z', updatedAt: '2026-06-17T00:03:10.000Z' },
  ];
  state.policies = [
    { id: 100, userId: 1, familyId: 10, company: '中国人寿', name: '测试保单 A', insured: '温舒萍', applicant: '温舒萍', amount: 100000, firstPremium: 1000, responsibilities: [], coverageIndicators: [], createdAt: '2026-06-17T00:05:00.000Z', updatedAt: '2026-06-17T00:05:00.000Z' },
    { id: 101, userId: 1, familyId: 10, company: '新华保险', name: '测试保单 B', insured: '冯力', applicant: '温舒萍', amount: 200000, firstPremium: 2000, responsibilities: [], coverageIndicators: [], createdAt: '2026-06-17T00:06:00.000Z', updatedAt: '2026-06-17T00:06:00.000Z' },
    { id: 102, userId: 1, familyId: 20, company: '平安人寿', name: '测试保单 C', insured: '翟卿', applicant: '翟卿', amount: 300000, firstPremium: 3000, responsibilities: [], coverageIndicators: [], createdAt: '2026-06-17T00:07:00.000Z', updatedAt: '2026-06-17T00:07:00.000Z' },
  ];
  const before = JSON.stringify({ nextId: state.nextId, familyProfiles: state.familyProfiles, familyMembers: state.familyMembers, policies: state.policies });
  const app = createPolicyOcrApp({
    adminPassword: 'admin-pass',
    state,
    persist: async () => {
      throw new Error('admin user family list must not persist');
    },
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/admin/users/1/families', {
      headers: { authorization: 'Bearer admin-token' },
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.user.id, 1);
    assert.equal(result.payload.user.mobile, '13800000000');
    assert.deepEqual(result.payload.families.map((family) => family.id), [20, 10]);
    assert.equal(result.payload.families[0].familyName, '吴连英');
    assert.equal(result.payload.families[0].memberCount, 1);
    assert.equal(result.payload.families[0].policyCount, 1);
    assert.equal(result.payload.families[0].coreMemberName, '待设置');
    assert.equal(result.payload.families[1].memberCount, 2);
    assert.equal(result.payload.families[1].policyCount, 2);
    assert.equal(result.payload.families[1].coreMemberName, '温舒萍');
    assert.equal(JSON.stringify({ nextId: state.nextId, familyProfiles: state.familyProfiles, familyMembers: state.familyMembers, policies: state.policies }), before);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "admin can list selected user families"
```

Expected: FAIL with 404 or missing route.

- [ ] **Step 3: Implement family counts in overview**

In `server/app.mjs`, update `buildAdminOverview` so each user and the summary include active family counts:

```js
  const activeFamilies = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
    .filter((family) => String(family?.status || 'active') === 'active');
  const familyCountByUserId = new Map();
  for (const family of activeFamilies) {
    const ownerUserId = Number(family?.ownerUserId || 0);
    if (!ownerUserId) continue;
    familyCountByUserId.set(ownerUserId, (familyCountByUserId.get(ownerUserId) || 0) + 1);
  }
```

Inside each user row, add:

```js
        familyCount: familyCountByUserId.get(Number(user.id)) || 0,
```

Inside `summary`, add:

```js
      familyCount: activeFamilies.length,
```

- [ ] **Step 4: Implement read-only route**

In `server/routes/admin.routes.mjs`, add this helper before route definitions:

```js
  function adminFamilySummary(family) {
    const members = typeof listFamilyMembers === 'function' ? listFamilyMembers(state, family.id) : [];
    const policies = (Array.isArray(state.policies) ? state.policies : [])
      .filter((policy) => Number(policy?.familyId || 0) === Number(family.id));
    const coreMember = members.find((member) => Number(member.id) === Number(family.coreMemberId || 0)) || null;
    const latestPolicyAt = policies
      .map((policy) => String(policy?.createdAt || policy?.updatedAt || ''))
      .filter(Boolean)
      .sort((left, right) => right.localeCompare(left))[0] || '';
    return {
      ...family,
      members,
      memberCount: members.length,
      policyCount: policies.length,
      coreMemberName: coreMember?.name || '待设置',
      latestPolicyAt,
    };
  }
```

Add this route after `/overview`:

```js
  router.get('/users/:userId/families', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    const userId = Number(req.params.userId || 0);
    const user = (Array.isArray(state.users) ? state.users : [])
      .find((row) => Number(row?.id || 0) === userId) || null;
    if (!user) {
      return res.status(404).json({ ok: false, code: 'ADMIN_USER_NOT_FOUND', message: '用户不存在' });
    }
    const families = (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
      .filter((family) => (
        Number(family?.ownerUserId || 0) === userId &&
        String(family?.status || 'active') === 'active'
      ))
      .map(adminFamilySummary)
      .sort((left, right) => (
        String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) ||
        Number(right.id || 0) - Number(left.id || 0)
      ));
    return res.json({
      ok: true,
      user: {
        id: Number(user.id),
        mobile: String(user.mobile || ''),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      families,
    });
  });
```

- [ ] **Step 5: Update admin API types and client**

In `src/api/contracts/admin.ts`, import family type:

```ts
import type { FamilyMember, FamilyProfile } from './family';
```

Extend `AdminUserSummary`:

```ts
  familyCount: number;
```

Extend `AdminOverview.summary`:

```ts
    familyCount?: number;
```

Add:

```ts
export type AdminUserFamilySummary = FamilyProfile & {
  members: FamilyMember[];
  memberCount: number;
  policyCount: number;
  coreMemberName: string;
  latestPolicyAt?: string;
};

export type AdminUserFamiliesResponse = {
  ok: true;
  user: {
    id: number;
    mobile: string;
    createdAt?: string;
    updatedAt?: string;
  };
  families: AdminUserFamilySummary[];
};
```

Add client function:

```ts
export function getAdminUserFamilies(token: string, userId: number) {
  return request<AdminUserFamiliesResponse>(`/api/admin/users/${encodeURIComponent(String(userId))}/families`, { token });
}
```

- [ ] **Step 6: Run route test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "admin can list selected user families"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs server/routes/admin.routes.mjs src/api/contracts/admin.ts tests/policy-ocr-flow.test.mjs
git commit -m "feat: add admin user families read endpoint"
```

## Task 2: Admin Shell and Page Metadata

**Files:**
- Create: `src/apps/admin/adminPages.ts`
- Create: `src/apps/admin/AdminShell.tsx`
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add source-level shell test**

In `tests/customer-ui-style.test.mjs`, add optional source reads near the existing admin source reads:

```js
const adminShellSource = readOptionalSource('../src/apps/admin/AdminShell.tsx');
const adminPagesSource = readOptionalSource('../src/apps/admin/adminPages.ts');
```

Add this test:

```js
test('admin backoffice shell defines grouped sidebar navigation', () => {
  assert.match(adminPagesSource, /key: 'overview'/);
  assert.match(adminPagesSource, /label: '运营总览'/);
  assert.match(adminPagesSource, /label: '保单运营'/);
  assert.match(adminPagesSource, /label: '用户'/);
  assert.doesNotMatch(adminPagesSource, /用户与被保人/);
  assert.match(adminPagesSource, /label: '报告问题'/);
  assert.match(adminPagesSource, /label: '可选责任缺口'/);
  assert.match(adminPagesSource, /label: '产品知识库'/);
  assert.match(adminPagesSource, /label: '官方域名'/);
  assert.match(adminPagesSource, /label: '会员设置'/);
  assert.match(adminShellSource, /aside/);
  assert.match(adminShellSource, /退出/);
  assert.match(adminShellSource, /刷新/);
});
```

- [ ] **Step 2: Run the failing shell test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "admin backoffice shell defines grouped sidebar navigation"
```

Expected: FAIL because the new files do not exist.

- [ ] **Step 3: Create page metadata**

Create `src/apps/admin/adminPages.ts`:

```ts
import {
  CircleHelp,
  Database,
  FileText,
  Globe2,
  LayoutDashboard,
  ListChecks,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type AdminPageKey =
  | 'overview'
  | 'policies'
  | 'users'
  | 'reportIssues'
  | 'optionalResponsibilities'
  | 'knowledge'
  | 'officialDomains'
  | 'membership';

export type AdminPageMeta = {
  key: AdminPageKey;
  label: string;
  description: string;
  icon: LucideIcon;
};

export type AdminPageGroup = {
  group: string;
  items: AdminPageMeta[];
};

export const ADMIN_PAGE_GROUPS: AdminPageGroup[] = [
  {
    group: '总览',
    items: [
      { key: 'overview', label: '运营总览', description: '平台关键指标和待处理事项', icon: LayoutDashboard },
    ],
  },
  {
    group: '业务运营',
    items: [
      { key: 'policies', label: '保单运营', description: '查看保单、OCR 和责任报告', icon: FileText },
      { key: 'users', label: '用户', description: '查看注册用户和家庭列表', icon: Users },
    ],
  },
  {
    group: '质检治理',
    items: [
      { key: 'reportIssues', label: '报告问题', description: '查看家庭报告问题和修正记录', icon: ListChecks },
      { key: 'optionalResponsibilities', label: '可选责任缺口', description: '治理未量化的可选责任', icon: CircleHelp },
    ],
  },
  {
    group: '知识配置',
    items: [
      { key: 'knowledge', label: '产品知识库', description: '爬取和查看本地官方资料', icon: Database },
      { key: 'officialDomains', label: '官方域名', description: '维护保险公司官网白名单', icon: Globe2 },
    ],
  },
  {
    group: '系统',
    items: [
      { key: 'membership', label: '会员设置', description: '配置会员购买和免费额度', icon: Settings },
    ],
  },
];

export const ADMIN_PAGE_META: Record<AdminPageKey, AdminPageMeta> = Object.fromEntries(
  ADMIN_PAGE_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item])),
) as Record<AdminPageKey, AdminPageMeta>;
```

- [ ] **Step 4: Create shell component**

Create `src/apps/admin/AdminShell.tsx`:

```tsx
import { LogOut, RefreshCw, Search } from 'lucide-react';
import { ADMIN_PAGE_GROUPS, ADMIN_PAGE_META, type AdminPageKey } from './adminPages';

export function AdminShell({
  activePage,
  query,
  message,
  loading,
  children,
  badgeCounts = {},
  onPageChange,
  onQueryChange,
  onRefresh,
  onLogout,
}: {
  activePage: AdminPageKey;
  query: string;
  message: string;
  loading: boolean;
  children: React.ReactNode;
  badgeCounts?: Partial<Record<AdminPageKey, number>>;
  onPageChange: (page: AdminPageKey) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  const page = ADMIN_PAGE_META[activePage];
  return (
    <div className="min-h-screen bg-[#F4F7FB] text-slate-950">
      <div className="grid min-h-screen grid-cols-[248px_minmax(0,1fr)] max-[900px]:grid-cols-[76px_minmax(0,1fr)]">
        <aside className="sticky top-0 h-screen overflow-y-auto bg-slate-950 px-4 py-5 text-white max-[900px]:px-2">
          <div className="mb-8 flex items-center gap-3 px-2">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-slate-950">
              <span className="text-sm font-black">P</span>
            </div>
            <div className="min-w-0 max-[900px]:hidden">
              <p className="text-base font-black leading-tight">运营后台</p>
              <p className="mt-1 text-xs font-bold text-sky-200">保单 OCR 管理台</p>
            </div>
          </div>

          <nav className="space-y-5">
            {ADMIN_PAGE_GROUPS.map((group) => (
              <div key={group.group}>
                <p className="mb-2 px-2 text-xs font-black text-sky-200 max-[900px]:sr-only">{group.group}</p>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = item.key === activePage;
                    const badge = badgeCounts[item.key] || 0;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => onPageChange(item.key)}
                        className={[
                          'flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-black transition',
                          active ? 'bg-white text-slate-950' : 'text-slate-400 hover:bg-white/10 hover:text-white',
                        ].join(' ')}
                        title={item.label}
                      >
                        <Icon size={18} />
                        <span className="min-w-0 flex-1 truncate max-[900px]:sr-only">{item.label}</span>
                        {badge ? (
                          <span className={active ? 'rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 max-[900px]:hidden' : 'rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-300 max-[900px]:hidden'}>
                            {badge}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/95 px-5 py-3 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h1 className="truncate text-xl font-black text-slate-950">{page.label}</h1>
                <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">{message || page.description}</p>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <label className="relative block w-[360px] max-w-[36vw] max-[900px]:hidden">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder={`搜索${page.label}`}
                    className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-sm font-semibold outline-none transition focus:border-slate-400 focus:bg-white"
                  />
                </label>
                <button
                  type="button"
                  className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-black text-slate-600 shadow-sm transition hover:border-slate-300"
                  onClick={onRefresh}
                >
                  <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                  <span className="max-[900px]:sr-only">刷新</span>
                </button>
                <button
                  type="button"
                  className="flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-3 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(15,23,42,0.9)]"
                  onClick={onLogout}
                >
                  <LogOut size={16} />
                  <span className="max-[900px]:sr-only">退出</span>
                </button>
              </div>
            </div>
          </header>
          <main className="min-w-0 px-5 py-5">{children}</main>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run shell test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "admin backoffice shell defines grouped sidebar navigation"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/apps/admin/adminPages.ts src/apps/admin/AdminShell.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: add admin backoffice shell"
```

## Task 3: Extract Admin Pages

**Files:**
- Create: `src/apps/admin/pages/AdminOverviewPage.tsx`
- Create: `src/apps/admin/pages/AdminPoliciesPage.tsx`
- Create: `src/apps/admin/pages/AdminReportIssuesPage.tsx`
- Create: `src/apps/admin/pages/AdminOptionalResponsibilitiesPage.tsx`
- Create: `src/apps/admin/pages/AdminKnowledgePage.tsx`
- Create: `src/apps/admin/pages/AdminOfficialDomainsPage.tsx`
- Create: `src/apps/admin/pages/AdminMembershipPage.tsx`
- Modify: `src/apps/admin/AdminApp.tsx`

- [ ] **Step 1: Create overview page**

Create `src/apps/admin/pages/AdminOverviewPage.tsx`:

```tsx
import { AlertTriangle, CircleHelp, FileWarning, ListChecks } from 'lucide-react';
import type { AdminOverview, AdminReportIssueSummary, Policy } from '../../../api';
import { AdminStatCard } from '../../../features/admin-shared/AdminStatCard';
import { formatCoverageAmount, formatDateLabel } from '../../../shared/formatters';
import { isPolicyReportFailed } from '../../../shared/policy-report-ui';
import type { AdminPageKey } from '../adminPages';

export function AdminOverviewPage({
  overview,
  reportIssueReports,
  onNavigate,
}: {
  overview: AdminOverview | null;
  reportIssueReports: AdminReportIssueSummary[];
  onNavigate: (page: AdminPageKey) => void;
}) {
  const failedPolicies = (overview?.policies || []).filter(isPolicyReportFailed);
  const optionalGaps = overview?.optionalResponsibilityGaps || [];
  return (
    <div className="space-y-5">
      <section className="grid grid-cols-6 gap-3 max-[1200px]:grid-cols-3 max-[760px]:grid-cols-2">
        <AdminStatCard label="注册账号" value={`${overview?.summary.userCount || 0}`} />
        <AdminStatCard label="家庭数" value={`${overview?.summary.familyCount || 0}`} />
        <AdminStatCard label="被保人数" value={`${overview?.summary.insuredCount || 0}`} />
        <AdminStatCard label="保单总数" value={`${overview?.summary.policyCount || 0}`} />
        <AdminStatCard label="报告问题" value={`${reportIssueReports.length}`} />
        <AdminStatCard label="总保额" value={formatCoverageAmount(overview?.summary.totalCoverage || 0)} />
      </section>

      <section className="grid grid-cols-[1.2fr_0.8fr] gap-5 max-[1100px]:grid-cols-1">
        <QueueCard
          title="报告问题"
          icon={<ListChecks size={18} />}
          count={reportIssueReports.length}
          action="查看报告问题"
          onOpen={() => onNavigate('reportIssues')}
        >
          {reportIssueReports.slice(0, 5).map((report) => (
            <div key={report.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-black text-slate-950">{report.familyName}</p>
                <span className="rounded-full bg-white px-2 py-1 text-xs font-black text-slate-500">{report.issueCount}</span>
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-500">{report.memberCount} 成员 · {report.policyCount} 保单 · {formatDateLabel(report.generatedAt)}</p>
            </div>
          ))}
        </QueueCard>

        <div className="space-y-5">
          <QueueCard
            title="可选责任缺口"
            icon={<CircleHelp size={18} />}
            count={optionalGaps.length}
            action="进入治理"
            onOpen={() => onNavigate('optionalResponsibilities')}
          >
            {optionalGaps.slice(0, 3).map((gap) => (
              <div key={gap.id} className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2.5">
                <p className="truncate text-sm font-black text-amber-900">{gap.productName}</p>
                <p className="mt-1 text-xs font-semibold text-amber-700">{gap.company} · {gap.liability}</p>
              </div>
            ))}
          </QueueCard>

          <QueueCard
            title="报告生成失败"
            icon={<FileWarning size={18} />}
            count={failedPolicies.length}
            action="查看保单"
            onOpen={() => onNavigate('policies')}
          >
            {failedPolicies.slice(0, 3).map((policy: Policy) => (
              <div key={policy.id} className="rounded-xl border border-red-100 bg-red-50 px-3 py-2.5">
                <p className="truncate text-sm font-black text-red-900">{policy.name}</p>
                <p className="mt-1 truncate text-xs font-semibold text-red-700">{policy.reportError || '报告生成失败'}</p>
              </div>
            ))}
          </QueueCard>
        </div>
      </section>
    </div>
  );
}

function QueueCard({
  title,
  icon,
  count,
  action,
  children,
  onOpen,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  action: string;
  children: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <section className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-base font-black text-slate-950">{title}</h2>
          {count ? <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-black text-slate-500">{count}</span> : null}
        </div>
        <button type="button" className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white" onClick={onOpen}>
          {action}
        </button>
      </div>
      <div className="space-y-2">
        {count ? children : (
          <p className="rounded-xl bg-slate-50 px-3 py-6 text-center text-sm font-bold text-slate-400">
            <AlertTriangle className="mx-auto mb-2 h-5 w-5" />
            暂无待处理事项
          </p>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Create policy page**

Create `src/apps/admin/pages/AdminPoliciesPage.tsx` using the existing policy table markup from `AdminApp.tsx`. Props:

```tsx
import type { AdminOverview, Policy } from '../../../api';

export function AdminPoliciesPage({
  overview,
  filteredPolicies,
  selectedAdminUserLabel,
  selectedPolicy,
  retryingPolicyId,
  onClearUserFilter,
  onSelectPolicy,
  onRetryPolicyReport,
}: {
  overview: AdminOverview | null;
  filteredPolicies: Policy[];
  selectedAdminUserLabel: string;
  selectedPolicy: Policy | null;
  retryingPolicyId: number | null;
  onClearUserFilter: () => void;
  onSelectPolicy: (policy: Policy) => void;
  onRetryPolicyReport: (policy: Policy) => void;
}) {
  // Move the existing policy list table here.
  // Render AdminPolicyDetail below or beside the table for the first pass.
}
```

Use the existing markup exactly enough to preserve behavior; keep `AdminPolicyDetail` rendered from this page.

- [ ] **Step 3: Create report issues page**

Create `src/apps/admin/pages/AdminReportIssuesPage.tsx` and move the existing `activeView === 'reportIssues'` branch from `AdminApp.tsx` into it. Props:

```tsx
import type { AdminReportCorrection, AdminReportIssue, AdminReportIssueSummary } from '../../../api';

export function AdminReportIssuesPage(props: {
  reports: AdminReportIssueSummary[];
  selectedReport: AdminReportIssueSummary | null;
  issues: AdminReportIssue[];
  corrections: AdminReportCorrection[];
  loading: boolean;
  onRefresh: () => void;
  onOpenReport: (report: AdminReportIssueSummary) => void;
}) {
  // Move existing report list/detail JSX here.
}
```

- [ ] **Step 4: Create configuration page wrappers**

Create `src/apps/admin/pages/AdminOptionalResponsibilitiesPage.tsx`:

```tsx
import type { OptionalResponsibilityGap } from '../../../api';
import { AdminOptionalResponsibilityGapPanel } from '../../../features/admin-governance/AdminOptionalResponsibilityGapPanel';

export function AdminOptionalResponsibilitiesPage({
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
    <div className="max-w-5xl">
      <AdminOptionalResponsibilityGapPanel
        gaps={gaps}
        loading={loading}
        onMarkNotQuantifiable={onMarkNotQuantifiable}
        onReextract={onReextract}
      />
    </div>
  );
}
```

Create `src/apps/admin/pages/AdminKnowledgePage.tsx`:

```tsx
import type { KnowledgeRecord } from '../../../api';
import { AdminKnowledgePanel, type KnowledgeCrawlForm } from '../../../features/admin-knowledge/AdminKnowledgePanel';

export function AdminKnowledgePage({
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
  return (
    <div className="max-w-5xl">
      <AdminKnowledgePanel
        records={records}
        form={form}
        loading={loading}
        crawling={crawling}
        onChange={onChange}
        onRefresh={onRefresh}
        onCrawl={onCrawl}
      />
    </div>
  );
}
```

Create `src/apps/admin/pages/AdminOfficialDomainsPage.tsx`:

```tsx
import type { AdminOfficialDomainProfile } from '../../../api';
import {
  AdminOfficialDomainPanel,
  type OfficialDomainForm,
} from '../../../features/admin-official-domain/AdminOfficialDomainPanel';

export function AdminOfficialDomainsPage({
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
  return (
    <div className="max-w-5xl">
      <AdminOfficialDomainPanel
        profiles={profiles}
        form={form}
        loading={loading}
        saving={saving}
        onChange={onChange}
        onEdit={onEdit}
        onReset={onReset}
        onRefresh={onRefresh}
        onSave={onSave}
        onDelete={onDelete}
      />
    </div>
  );
}
```

Create `src/apps/admin/pages/AdminMembershipPage.tsx`:

```tsx
import type { AdminMembershipConfig } from '../../../api';

export function AdminMembershipPage({
  config,
  quotaInput,
  saving,
  onToggleEnabled,
  onQuotaInputChange,
  onSave,
}: {
  config: AdminMembershipConfig | null;
  quotaInput: string;
  saving: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onQuotaInputChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <section className="max-w-xl rounded-[18px] border border-slate-200 bg-white p-5 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
      <div className="mb-5 flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-lg font-black text-slate-950">会员设置</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">控制年度会员购买和注册用户免费保单额度</p>
        </div>
        <span className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500">300 元/年</span>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50 px-3 py-3">
        <span className="text-sm font-bold text-slate-700">开放会员购买</span>
        <input
          type="checkbox"
          checked={config?.enabled ?? true}
          onChange={(event) => onToggleEnabled(event.target.checked)}
        />
      </label>
      <label className="mt-4 block">
        <span className="text-xs font-black text-slate-400">注册用户免费保存保单数</span>
        <input
          className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none transition focus:border-slate-400"
          type="number"
          min="0"
          value={quotaInput}
          onChange={(event) => onQuotaInputChange(event.target.value)}
        />
      </label>
      <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">年费价格 300 元，有效期 365 天。免费额度只按已成功保存保单数计算。</p>
      <button
        className="mt-4 h-11 w-full rounded-xl bg-slate-950 px-4 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(15,23,42,0.9)] disabled:opacity-60"
        type="button"
        disabled={!config || saving}
        onClick={onSave}
      >
        {saving ? '保存中...' : '保存会员设置'}
      </button>
    </section>
  );
}
```

- [ ] **Step 5: Wire pages in AdminApp**

Modify `src/apps/admin/AdminApp.tsx`:

- Replace `activeView` with:

```ts
const [activePage, setActivePage] = useState<AdminPageKey>('overview');
```

- Import and render `AdminShell`.
- Keep login screen intact.
- Keep existing load/action functions.
- Use a `renderAdminPage()` function:

```tsx
function renderAdminPage() {
  switch (activePage) {
    case 'overview':
      return <AdminOverviewPage overview={overview} reportIssueReports={reportIssueReports} onNavigate={setActivePage} />;
    case 'policies':
      return (
        <AdminPoliciesPage
          overview={overview}
          filteredPolicies={filteredPolicies}
          selectedAdminUserLabel={selectedAdminUser ? formatAdminMobile(selectedAdminUser.mobile) : ''}
          selectedPolicy={selectedPolicy}
          retryingPolicyId={retryingPolicyId}
          onClearUserFilter={() => setSelectedAdminUserId(null)}
          onSelectPolicy={setSelectedPolicy}
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
          gaps={overview?.optionalResponsibilityGaps || []}
          loading={loading}
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
          saving={membershipSaving}
          onToggleEnabled={(enabled) => setMembershipConfig((current) => (current ? { ...current, enabled } : current))}
          onQuotaInputChange={setMembershipQuotaInput}
          onSave={() => void handleSaveMembershipConfig()}
        />
      );
    default:
      return null;
  }
}
```

- Wrap authenticated output:

```tsx
return (
  <AdminShell
    activePage={activePage}
    query={query}
    message={message}
    loading={loading}
    badgeCounts={{
      reportIssues: reportIssueReports.length,
      optionalResponsibilities: overview?.optionalResponsibilityGaps?.length || 0,
    }}
    onPageChange={setActivePage}
    onQueryChange={setQuery}
    onRefresh={refreshCurrentAdminPage}
    onLogout={logoutAdmin}
  >
    {renderAdminPage()}
  </AdminShell>
);
```

- [ ] **Step 6: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS. Fix prop types and imports until it passes.

- [ ] **Step 7: Commit**

```bash
git add src/apps/admin/AdminApp.tsx src/apps/admin/pages
git commit -m "feat: split admin backoffice pages"
```

## Task 4: Read-Only Admin Users Page

**Files:**
- Create/Modify: `src/apps/admin/pages/AdminUsersPage.tsx`
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add read-only source test**

Add this optional source read in `tests/customer-ui-style.test.mjs`:

```js
const adminUsersPageSource = readOptionalSource('../src/apps/admin/pages/AdminUsersPage.tsx');
```

Add this test:

```js
test('admin users page is read-only and uses user label', () => {
  assert.match(adminUsersPageSource, /用户列表/);
  assert.match(adminUsersPageSource, /家庭列表/);
  assert.match(adminUsersPageSource, /查看报告/);
  assert.match(adminUsersPageSource, /家庭保单/);
  assert.match(adminUsersPageSource, /销售建议/);
  assert.doesNotMatch(adminUsersPageSource, /录入保单/);
  assert.doesNotMatch(adminUsersPageSource, /录入第一张保单/);
  assert.doesNotMatch(adminUsersPageSource, /编辑家庭/);
  assert.doesNotMatch(adminUsersPageSource, /删除家庭/);
  assert.doesNotMatch(adminUsersPageSource, /新建家庭/);
});
```

- [ ] **Step 2: Run failing read-only test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "admin users page is read-only"
```

Expected: FAIL until `AdminUsersPage.tsx` exists and avoids mutation labels.

- [ ] **Step 3: Implement AdminUsersPage**

Create or replace `src/apps/admin/pages/AdminUsersPage.tsx`:

```tsx
import { FileText, LayoutDashboard, MessageSquareText, Users } from 'lucide-react';
import type { AdminUserFamiliesResponse, AdminUserFamilySummary, AdminUserSummary } from '../../../api';
import { formatDateLabel, maskMobile } from '../../../shared/formatters';

export function AdminUsersPage({
  users,
  selectedUserId,
  familiesPayload,
  loadingFamilies,
  onSelectUser,
  onOpenFamilyReport,
  onViewFamilyPolicies,
  onOpenSalesReview,
}: {
  users: AdminUserSummary[];
  selectedUserId: number | null;
  familiesPayload: AdminUserFamiliesResponse | null;
  loadingFamilies: boolean;
  onSelectUser: (userId: number) => void;
  onOpenFamilyReport: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
  onOpenSalesReview: (familyId: number) => void;
}) {
  const selectedUser = users.find((user) => Number(user.id) === Number(selectedUserId)) || null;
  const families = familiesPayload?.families || [];
  return (
    <div className="grid grid-cols-[360px_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
      <section className="rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-black text-slate-950">用户列表</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">选择用户后查看家庭列表</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-500">{users.length}</span>
        </div>
        <div className="max-h-[calc(100vh-190px)] space-y-2 overflow-auto pr-1">
          {users.map((user) => {
            const active = Number(user.id) === Number(selectedUserId);
            return (
              <button
                key={user.id}
                type="button"
                onClick={() => onSelectUser(Number(user.id))}
                className={[
                  'w-full rounded-[14px] border px-3 py-3 text-left transition',
                  active ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-100 bg-slate-50 text-slate-950 hover:border-slate-200 hover:bg-white',
                ].join(' ')}
              >
                <p className="font-mono text-lg font-black leading-none">{user.mobile || '未绑定手机号'}</p>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs font-black">
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.familyCount || 0} 家庭</span>
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.policyCount || 0} 保单</span>
                  <span className={active ? 'text-white/70' : 'text-slate-500'}>{user.insuredCount || 0} 被保人</span>
                </div>
              </button>
            );
          })}
          {!users.length ? <p className="rounded-xl bg-slate-50 px-3 py-8 text-center text-sm font-bold text-slate-400">没有匹配的用户</p> : null}
        </div>
      </section>

      <section className="min-w-0 rounded-[18px] border border-slate-200 bg-white p-4 shadow-[0_20px_60px_-46px_rgba(15,23,42,0.42)]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-black text-slate-950">家庭列表</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {selectedUser ? `${maskMobile(selectedUser.mobile)} 的家庭档案，只读查看` : '请先选择左侧用户'}
            </p>
          </div>
          {loadingFamilies ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-500">读取中</span> : null}
        </div>
        <div className="space-y-3">
          {families.map((family) => (
            <AdminFamilyCard
              key={family.id}
              family={family}
              onOpenFamilyReport={onOpenFamilyReport}
              onViewFamilyPolicies={onViewFamilyPolicies}
              onOpenSalesReview={onOpenSalesReview}
            />
          ))}
          {selectedUser && !loadingFamilies && !families.length ? (
            <p className="rounded-xl bg-slate-50 px-3 py-12 text-center text-sm font-bold text-slate-400">该用户暂无家庭档案</p>
          ) : null}
          {!selectedUser ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-xl bg-slate-50 text-center text-sm font-bold text-slate-400">
              <div>
                <Users className="mx-auto mb-2 h-7 w-7" />
                从用户列表选择一个用户
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function AdminFamilyCard({
  family,
  onOpenFamilyReport,
  onViewFamilyPolicies,
  onOpenSalesReview,
}: {
  family: AdminUserFamilySummary;
  onOpenFamilyReport: (familyId: number) => void;
  onViewFamilyPolicies: (familyId: number) => void;
  onOpenSalesReview: (familyId: number) => void;
}) {
  const hasPolicies = Number(family.policyCount || 0) > 0;
  return (
    <article className="rounded-[16px] border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-black text-slate-950">{family.familyName || `家庭 ${family.id}`}</h3>
          <p className="mt-1 text-sm font-semibold text-slate-500">家庭顶梁柱：{family.coreMemberName || '待设置'}</p>
        </div>
        {family.latestPolicyAt ? <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-500">{formatDateLabel(family.latestPolicyAt)}</span> : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-black text-slate-400">成员数</p>
          <p className="mt-1 text-xl font-black text-slate-950">{family.memberCount || 0}</p>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-xs font-black text-slate-400">保单数</p>
          <p className="mt-1 text-xl font-black text-slate-950">{family.policyCount || 0}</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 max-[760px]:grid-cols-1">
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-blue-500 text-xs font-black text-white shadow-lg shadow-blue-500/20 disabled:opacity-50"
          disabled={!hasPolicies}
          onClick={() => onOpenFamilyReport(family.id)}
        >
          <LayoutDashboard size={16} />
          查看报告
        </button>
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-sky-50 text-xs font-black text-sky-700 ring-1 ring-sky-100 disabled:opacity-50"
          disabled={!hasPolicies}
          onClick={() => onViewFamilyPolicies(family.id)}
        >
          <FileText size={16} />
          家庭保单
        </button>
        <button
          type="button"
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-amber-50 text-xs font-black text-amber-700 ring-1 ring-amber-100"
          onClick={() => onOpenSalesReview(family.id)}
        >
          <MessageSquareText size={16} />
          销售建议
        </button>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Wire user family loading in AdminApp**

In `src/apps/admin/AdminApp.tsx`, import:

```ts
  AdminUserFamiliesResponse,
  getAdminUserFamilies,
```

Add state:

```ts
const [selectedUserFamilies, setSelectedUserFamilies] = useState<AdminUserFamiliesResponse | null>(null);
const [userFamiliesLoading, setUserFamiliesLoading] = useState(false);
```

Add loader:

```ts
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
```

Update user selection:

```ts
function selectAdminUser(userId: number) {
  setSelectedAdminUserId(userId);
  setSelectedUserFamilies(null);
  void loadSelectedUserFamilies(userId);
}
```

Pass props to `AdminUsersPage`.

- [ ] **Step 5: Run read-only source test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "admin users page is read-only"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/apps/admin/AdminApp.tsx src/apps/admin/pages/AdminUsersPage.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: add read-only admin users page"
```

## Task 5: Final Integration and Verification

**Files:**
- Modify: only files needed to fix integration issues found by checks.

- [ ] **Step 1: Run TypeScript**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run backend syntax check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "admin can list selected user families"
node --test tests/customer-ui-style.test.mjs --test-name-pattern "admin backoffice shell|admin users page is read-only"
```

Expected: PASS.

- [ ] **Step 5: Run app smoke check**

Start development stack only:

```bash
npm run local:dev
```

Open:

```text
http://localhost:3014/admin
```

Manual checks:

- Login screen still renders.
- After login, default page is `运营总览`.
- Sidebar has `运营总览`, `保单运营`, `用户`, `报告问题`, `可选责任缺口`, `产品知识库`, `官方域名`, and `会员设置`.
- There is no `用户与被保人` label.
- `用户` page opens user list.
- Selecting a user loads family cards.
- Family cards show `查看报告`, `家庭保单`, and `销售建议`.
- Family cards do not show `录入保单`, `录入第一张保单`, `编辑家庭`, `删除家庭`, or `新建家庭`.

Stop development stack:

```bash
npm run local:dev:stop
```

- [ ] **Step 6: Final commit**

If verification fixes changed files, commit them:

```bash
git add <changed-files>
git commit -m "fix: polish admin backoffice integration"
```

If no fixes were needed, do not create an empty commit.

## Self-Review Checklist

- Spec coverage:
  - Left grouped sidebar: Task 2.
  - Default overview: Task 3.
  - Policy/report/config pages split out: Task 3.
  - `用户` label and read-only family list: Task 4.
  - No user-family mutation controls: Task 4 source test and manual smoke check.
  - Existing admin APIs preserved: Tasks 3 and 5.
  - Thin read-only admin endpoint: Task 1.
- Placeholder scan:
  - No `TBD`.
  - No `TODO`.
  - The only "Move existing markup" steps are scoped to exact source branches and wrapped with explicit props; implementation must still run typecheck.
- Type consistency:
  - Page key type is `AdminPageKey`.
  - User family response type is `AdminUserFamiliesResponse`.
  - Family summary type is `AdminUserFamilySummary`.
  - API client name is `getAdminUserFamilies`.
