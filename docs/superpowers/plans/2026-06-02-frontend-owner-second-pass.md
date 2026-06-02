# Frontend Owner Second Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the remaining large customer/admin frontend UI owners into focused feature components while preserving behavior.

**Architecture:** Keep `CustomerApp` and `AdminApp` as composition shells that own shared state and API handlers. Move controlled UI blocks into feature-owned files, update source-text tests to understand the new owner files, and avoid new hooks unless a later slice proves they are needed.

**Tech Stack:** React 19, TypeScript, Vite, Node test runner, Express API compatibility barrel in `src/api.ts`, Tailwind-style utility classes, lucide-react icons.

---

## File Structure

Create or modify these files only as needed by the task being executed:

- Create `src/features/customer-auth/CustomerAccountSheet.tsx`: controlled customer account sheet UI.
- Create `src/features/customer-auth/PhoneVerificationDialog.tsx`: controlled phone verification dialog UI.
- Create `src/features/customer-navigation/CustomerBottomTabs.tsx`: controlled customer bottom tabs and `CustomerTab` type.
- Create `src/features/cashflow/CashflowDetailPage.tsx`: cashflow detail page and cashflow tables.
- Create `src/features/family-report/FamilyCoverageOverview.tsx`: compact family radar overview used in the policy dashboard.
- Create `src/features/family-report/family-planning-storage.ts`: localStorage helpers for `FamilyPlanningProfile`.
- Create `src/features/cash-value/CashValueDialog.tsx`: controlled cash value upload/manual editor dialog.
- Create `src/features/admin-shared/AdminStatCard.tsx`: small admin metric card.
- Create `src/features/admin-shared/TextField.tsx`: shared admin text input preserved from the current admin shell.
- Create `src/features/admin-official-domain/AdminOfficialDomainPanel.tsx`: controlled official domain panel plus exported form helpers.
- Create `src/features/admin-knowledge/AdminKnowledgePanel.tsx`: controlled knowledge crawl panel plus exported crawl form type.
- Create `src/features/admin-ocr-config/AdminOcrModePanel.tsx`: controlled OCR config panel.
- Create `src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx`: controlled optional responsibility governance panel.
- Create `src/features/admin-policy-detail/AdminPolicyDetail.tsx`: controlled admin policy detail drawer.
- Modify `src/apps/customer/CustomerApp.tsx`: remove moved component definitions, import new feature components/helpers, keep handlers and shared state.
- Modify `src/apps/admin/AdminApp.tsx`: remove moved panel definitions/helpers, import new controlled panels and shared UI.
- Modify `tests/customer-ui-style.test.mjs`: read the new feature files and update `owningSource()` plus component boundary lookups that currently assume components live in app files.

Do not modify API contracts, backend routes, UI copy, endpoint URLs, response shapes, or unrelated graph output.

---

### Task 1: Teach Source-Text Tests About New Frontend Owners

**Files:**
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Update test file source reads**

At the top of `tests/customer-ui-style.test.mjs`, after the existing feature source reads, add tolerant reads for the new files so this task can pass before all files exist:

```js
function readOptionalSource(relativePath) {
  try {
    return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
}

const customerAuthAccountSource = readOptionalSource('../src/features/customer-auth/CustomerAccountSheet.tsx');
const customerAuthPhoneSource = readOptionalSource('../src/features/customer-auth/PhoneVerificationDialog.tsx');
const customerNavigationSource = readOptionalSource('../src/features/customer-navigation/CustomerBottomTabs.tsx');
const customerCashflowFeatureSource = readOptionalSource('../src/features/cashflow/CashflowDetailPage.tsx');
const customerFamilyReportFeatureSource = readOptionalSource('../src/features/family-report/FamilyCoverageOverview.tsx');
const customerCashValueFeatureSource = readOptionalSource('../src/features/cash-value/CashValueDialog.tsx');
const adminSharedSource = readOptionalSource('../src/features/admin-shared/AdminStatCard.tsx')
  + '\n' + readOptionalSource('../src/features/admin-shared/TextField.tsx');
const adminOfficialDomainSource = readOptionalSource('../src/features/admin-official-domain/AdminOfficialDomainPanel.tsx');
const adminKnowledgeSource = readOptionalSource('../src/features/admin-knowledge/AdminKnowledgePanel.tsx');
const adminOcrConfigSource = readOptionalSource('../src/features/admin-ocr-config/AdminOcrModePanel.tsx');
const adminGovernanceSource = readOptionalSource('../src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx');
const adminPolicyDetailSource = readOptionalSource('../src/features/admin-policy-detail/AdminPolicyDetail.tsx');
```

- [ ] **Step 2: Add normalized owner sources**

Near the existing `normalized*Source` declarations, add:

```js
const normalizedCustomerFeatureSource = [
  customerAuthAccountSource,
  customerAuthPhoneSource,
  customerNavigationSource,
  customerCashflowFeatureSource,
  customerFamilyReportFeatureSource,
  customerCashValueFeatureSource,
].join('\n').replaceAll("from '../../", "from './");
const normalizedAdminFeatureSource = [
  adminSharedSource,
  adminOfficialDomainSource,
  adminKnowledgeSource,
  adminOcrConfigSource,
  adminGovernanceSource,
  adminPolicyDetailSource,
].join('\n').replaceAll("from '../../", "from './");
```

- [ ] **Step 3: Update `owningSource()`**

Modify `owningSource(name)` so feature sources are checked before the app shell fallback:

```js
function owningSource(name) {
  const marker = `function ${name}`;
  if (normalizedCustomerAppSource.includes(marker)) return normalizedCustomerAppSource;
  if (normalizedCustomerFeatureSource.includes(marker)) return normalizedCustomerFeatureSource;
  if (normalizedFamilyProfileSource.includes(marker)) return normalizedFamilyProfileSource;
  if (normalizedPolicyEntrySource.includes(marker)) return normalizedPolicyEntrySource;
  if (normalizedPolicyDetailSource.includes(marker)) return normalizedPolicyDetailSource;
  if (normalizedResponsibilityAssistantSource.includes(marker)) return normalizedResponsibilityAssistantSource;
  if (normalizedCustomerPolicyComponentsSource.includes(marker)) return normalizedCustomerPolicyComponentsSource;
  if (normalizedCustomerPolicyListSource.includes(marker)) return normalizedCustomerPolicyListSource;
  if (normalizedCustomerPolicyFormSource.includes(marker)) return normalizedCustomerPolicyFormSource;
  if (normalizedCustomerCashValueSource.includes(marker)) return normalizedCustomerCashValueSource;
  if (normalizedAdminAppSource.includes(marker)) return normalizedAdminAppSource;
  if (normalizedAdminFeatureSource.includes(marker)) return normalizedAdminFeatureSource;
  if (sharedReportUiSource.includes(marker)) return sharedReportUiSource;
  if (appShellSource.includes(marker)) return appShellSource;
  return appShellSource;
}
```

- [ ] **Step 4: Replace brittle next-function boundaries**

Update tests that slice through `CustomerApp` or `AdminApp` using component boundaries that will move. Use `componentSource(name, null)` for moved standalone components when possible. Make these exact edits:

```js
// customer account tests
const source = componentSource('CustomerAccountSheet', null);
const sheetSource = componentSource('CustomerAccountSheet', null);

// phone verification test
const source = componentSource('PhoneVerificationDialog', null);

// bottom tabs test
const source = componentSource('CustomerBottomTabs', null);

// admin panel tests
const source = componentSource('AdminPolicyDetail', null);
const panelSource = componentSource('AdminOfficialDomainPanel', null);
const ocrPanelSource = componentSource('AdminOcrModePanel', null);
```

Leave tests that intentionally inspect `CustomerApp` orchestration pointed at `CustomerApp`.

- [ ] **Step 5: Run the style test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs
```

Expected: PASS before feature files are moved, because optional reads are empty and current app files still contain the components.

- [ ] **Step 6: Commit**

```bash
git add tests/customer-ui-style.test.mjs
git commit -m "test: support extracted frontend owner files"
```

---

### Task 2: Extract Customer Auth and Navigation UI

**Files:**
- Create: `src/features/customer-auth/CustomerAccountSheet.tsx`
- Create: `src/features/customer-auth/PhoneVerificationDialog.tsx`
- Create: `src/features/customer-navigation/CustomerBottomTabs.tsx`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create `CustomerAccountSheet.tsx`**

Move the current `CustomerAccountSheet` function from `CustomerApp.tsx` into `src/features/customer-auth/CustomerAccountSheet.tsx` and export it:

```tsx
import {
  CircleUserRound,
  FileText,
  LogOut,
  X,
} from 'lucide-react';

export function CustomerAccountSheet(props: {
  insuredCount: number;
  isLoggedIn: boolean;
  mobile: string;
  onClose: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenPolicies: () => void;
  policyCount: number;
}) {
  const { insuredCount, isLoggedIn, mobile, onClose, onLogin, onLogout, onOpenPolicies, policyCount } = props;
  return (
    <div className="fixed inset-0 z-[75] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500 text-white shadow-lg shadow-blue-500/25">
              <CircleUserRound size={24} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-950">我的账号</h2>
              <p className="mt-1 truncate text-sm font-semibold text-slate-500">{isLoggedIn ? mobile : '游客模式'}</p>
            </div>
          </div>
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200"
            type="button"
            onClick={onClose}
            aria-label="关闭账号"
          >
            <X size={18} />
          </button>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-black text-slate-400">登录账号</p>
          <p className="mt-2 break-all text-xl font-black text-slate-950">{isLoggedIn ? mobile : '未登录'}</p>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">我的保单</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{policyCount}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-black text-slate-400">被保人</p>
            <p className="mt-2 text-2xl font-black text-slate-950">{insuredCount}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-2">
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-700 transition-colors hover:bg-slate-50"
            type="button"
            aria-current="page"
          >
            <CircleUserRound size={18} />
            我的基本信息
          </button>
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-blue-100 bg-blue-50 text-sm font-black text-blue-700 transition-colors hover:bg-blue-100"
            type="button"
            onClick={onOpenPolicies}
          >
            <FileText size={18} />
            我的保单
          </button>
        </div>

        {isLoggedIn ? (
          <button
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:bg-red-100"
            type="button"
            onClick={onLogout}
          >
            <LogOut size={19} />
            退出
          </button>
        ) : (
          <button className="mt-2 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-sm font-black text-white shadow-lg shadow-blue-500/25" type="button" onClick={onLogin}>
            验证手机号
          </button>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Create `PhoneVerificationDialog.tsx`**

Move the current `PhoneVerificationDialog` function into `src/features/customer-auth/PhoneVerificationDialog.tsx` and export it:

```tsx
export function PhoneVerificationDialog(props: {
  code: string;
  devCode: string;
  loading: boolean;
  message: string;
  mobile: string;
  onChangeCode: (value: string) => void;
  onChangeMobile: (value: string) => void;
  onClose: () => void;
  onSendCode: () => void;
  onVerify: () => void;
}) {
  const { code, devCode, loading, message, mobile, onChangeCode, onChangeMobile, onClose, onSendCode, onVerify } = props;
  return (
    <div className="fixed inset-0 z-[80] flex items-end bg-slate-950/35 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-slate-950">手机验证码</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">第一张保单可直接录入，第二张开始需要验证手机号。</p>
          </div>
          <button className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" onClick={onClose}>
            稍后
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">手机号</span>
            <input
              value={mobile}
              onChange={(event) => onChangeMobile(event.target.value.replace(/[^\d]/g, '').slice(0, 11))}
              inputMode="tel"
              placeholder="请输入手机号"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-black text-slate-500">验证码</span>
            <div className="flex gap-2">
              <input
                value={code}
                onChange={(event) => onChangeCode(event.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="6 位验证码"
                className="h-12 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none focus:border-blue-500"
              />
              <button
                className="h-12 rounded-xl bg-blue-500 px-4 text-sm font-black text-white shadow-lg shadow-blue-500/20 transition-colors hover:bg-blue-600 disabled:opacity-50"
                type="button"
                disabled={loading || mobile.trim().length !== 11}
                onClick={onSendCode}
              >
                发验证码
              </button>
            </div>
          </label>
        </div>

        <p className="mt-3 rounded-xl bg-blue-50 px-4 py-3 text-sm font-bold leading-6 text-blue-700">{devCode ? `本地验证码：${devCode}` : message}</p>

        <button
          className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-blue-500 text-base font-black text-white shadow-lg shadow-blue-500/25 disabled:opacity-60"
          type="button"
          disabled={loading || mobile.trim().length !== 11 || code.trim().length !== 6}
          onClick={onVerify}
        >
          {loading ? '处理中...' : '验证并继续录入'}
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Create `CustomerBottomTabs.tsx`**

Move the current `CustomerBottomTabs` function and `CustomerTab` type into `src/features/customer-navigation/CustomerBottomTabs.tsx`:

```tsx
import {
  FileText,
  LayoutDashboard,
  UploadCloud,
  Users,
} from 'lucide-react';

export type CustomerTab = 'entry' | 'policies' | 'families';

export function CustomerBottomTabs({
  activeTab,
  onChange,
  onOpenReport,
  fixed = true,
}: {
  activeTab: CustomerTab;
  onChange: (tab: CustomerTab) => void;
  onOpenReport?: () => void;
  fixed?: boolean;
}) {
  const tabs: Array<{ key: CustomerTab; label: string; icon: typeof UploadCloud }> = [
    { key: 'entry', label: '录入保单', icon: UploadCloud },
    { key: 'policies', label: '我的保单', icon: FileText },
    { key: 'families', label: '家庭档案', icon: Users },
  ];
  return (
    <nav className={fixed ? 'pb-safe fixed bottom-0 left-0 right-0 z-40 border-t border-slate-100 bg-white px-4 pt-2 shadow-[0_-10px_20px_-12px_rgba(15,23,42,0.12)]' : ''}>
      <div className={`grid gap-2 ${onOpenReport ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={`flex h-12 items-center justify-center gap-1.5 rounded-2xl text-xs font-black transition sm:text-sm ${
                active ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20' : 'bg-slate-50 text-slate-500'
              }`}
            >
              <Icon size={18} />
              {tab.label}
            </button>
          );
        })}
        {onOpenReport ? (
          <button
            type="button"
            onClick={onOpenReport}
            className="flex h-12 items-center justify-center gap-1.5 rounded-2xl bg-blue-50 text-xs font-black text-blue-600 ring-1 ring-blue-100 transition hover:bg-blue-100 active:bg-blue-100 sm:text-sm"
            aria-label="查看家庭保障分析报告"
          >
            <LayoutDashboard size={18} />
            查看报告
          </button>
        ) : null}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Update `CustomerApp.tsx` imports and remove local definitions**

In `src/apps/customer/CustomerApp.tsx`:

1. Remove unused lucide imports now owned by the moved files: `FileText`, `LayoutDashboard`, `LogOut`, `UploadCloud`, `Users`, and `X` if no longer used elsewhere in `CustomerApp`.
2. Add:

```tsx
import {
  CustomerAccountSheet,
} from '../../features/customer-auth/CustomerAccountSheet';
import {
  PhoneVerificationDialog,
} from '../../features/customer-auth/PhoneVerificationDialog';
import {
  CustomerBottomTabs,
  type CustomerTab,
} from '../../features/customer-navigation/CustomerBottomTabs';
```

3. Delete the local `type CustomerTab` declaration.
4. Delete the local `CustomerBottomTabs`, `CustomerAccountSheet`, and `PhoneVerificationDialog` functions.

- [ ] **Step 5: Run verification**

Run:

```bash
npm run typecheck
node --test tests/customer-ui-style.test.mjs
```

Expected: both commands PASS. If TypeScript reports unused lucide imports, remove only those unused imports.

- [ ] **Step 6: Commit**

```bash
git add src/apps/customer/CustomerApp.tsx src/features/customer-auth/CustomerAccountSheet.tsx src/features/customer-auth/PhoneVerificationDialog.tsx src/features/customer-navigation/CustomerBottomTabs.tsx tests/customer-ui-style.test.mjs
git commit -m "refactor: extract customer auth and navigation"
```

---

### Task 3: Extract Customer Cashflow Read UI

**Files:**
- Create: `src/features/cashflow/CashflowDetailPage.tsx`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create `CashflowDetailPage.tsx`**

Move `CashflowAnnualTable`, `ScenarioDetailTable`, `MemberAnnualSummaryTable`, and `CashflowDetailPage` from `CustomerApp.tsx` into `src/features/cashflow/CashflowDetailPage.tsx`. Export `CashflowDetailPage`.

Use these imports at the top:

```tsx
import {
  useState,
  type ReactNode,
} from 'react';
import {
  ChevronLeft,
} from 'lucide-react';
import type {
  CashValueRow,
  CashflowEntry,
  Policy,
  PolicyCashflowPlan,
  ScenarioEntry,
} from '../../api';
import {
  buildMemberAnnualSummaries,
  fillCashflowYears,
} from '../../cashflow-engine.mjs';
import type {
  MemberAnnualSummary,
  MemberYearEntry,
} from '../../api';
import {
  formatCoverageAmount,
} from '../../shared/formatters';
import {
  resolvePolicyValidityStatus,
} from '../../policy-validity.mjs';
```

Keep the moved JSX and class names byte-for-byte where possible. Change the `cashValueDialog` prop type from `React.ReactNode` to imported `ReactNode`.

- [ ] **Step 2: Update `CustomerApp.tsx`**

In `CustomerApp.tsx`:

1. Add:

```tsx
import {
  CashflowDetailPage,
} from '../../features/cashflow/CashflowDetailPage';
```

2. Delete local definitions for:

```tsx
function CashflowAnnualTable(...)
function ScenarioDetailTable(...)
function MemberAnnualSummaryTable(...)
function CashflowDetailPage(...)
```

3. Remove these imports from `CustomerApp.tsx` when the local cashflow functions are deleted:

```tsx
CashflowEntry
MemberAnnualSummary
MemberYearEntry
PolicyCashflowPlan
ScenarioEntry
resolvePolicyValidityStatus
```

Keep `CashValueRow` because it is still used by the cash value dialog state. Keep `buildMemberAnnualSummaries` and `fillCashflowYears` imports only if a remaining local helper still references them; otherwise remove them in the same edit.

- [ ] **Step 3: Confirm source-text test owner discovery**

Open `tests/customer-ui-style.test.mjs` and confirm `customerCashflowFeatureSource` is included in `normalizedCustomerFeatureSource`. The array must contain this entry:

```js
customerCashflowFeatureSource,
```

- [ ] **Step 4: Run verification**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apps/customer/CustomerApp.tsx src/features/cashflow/CashflowDetailPage.tsx tests/customer-ui-style.test.mjs
git commit -m "refactor: extract customer cashflow view"
```

---

### Task 4: Extract Family Report Overview and Planning Storage

**Files:**
- Create: `src/features/family-report/FamilyCoverageOverview.tsx`
- Create: `src/features/family-report/family-planning-storage.ts`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create family planning storage helper**

Create `src/features/family-report/family-planning-storage.ts`:

```ts
import type {
  FamilyPlanningProfile,
} from '../../family-report-engine.mjs';

const FAMILY_PLANNING_PROFILE_KEY = 'policy-ocr-app.familyPlanningProfile';

export function normalizePlanningProfile(value: unknown): FamilyPlanningProfile {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  return {
    annualExpense: Math.max(0, Number(source.annualExpense) || 0),
    debt: Math.max(0, Number(source.debt) || 0),
    educationGoal: Math.max(0, Number(source.educationGoal) || 0),
    retirementGoal: Math.max(0, Number(source.retirementGoal) || 0),
    availableAssets: Math.max(0, Number(source.availableAssets) || 0),
  };
}

export function readFamilyPlanningProfile(): FamilyPlanningProfile {
  try {
    const raw = localStorage.getItem(FAMILY_PLANNING_PROFILE_KEY);
    return raw ? normalizePlanningProfile(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveFamilyPlanningProfile(profile: FamilyPlanningProfile) {
  const normalized = normalizePlanningProfile(profile);
  localStorage.setItem(FAMILY_PLANNING_PROFILE_KEY, JSON.stringify(normalized));
  return normalized;
}
```

- [ ] **Step 2: Create `FamilyCoverageOverview.tsx`**

Move `FamilyCoverageOverview` from `CustomerApp.tsx` into `src/features/family-report/FamilyCoverageOverview.tsx`:

```tsx
import type {
  Policy,
} from '../../api';
import {
  FamilyRadarSection,
} from '../../FamilyReport';
import type {
  FamilyReport,
} from '../../family-report-engine.mjs';

export function FamilyCoverageOverview({
  report,
  policies,
}: {
  report: FamilyReport;
  policies: Policy[];
}) {
  if (!policies.length) return null;

  return (
    <section className="family-report-shell p-4 pb-0 text-[#102033]">
      <FamilyRadarSection report={report} />
    </section>
  );
}
```

- [ ] **Step 3: Update `CustomerApp.tsx` imports and remove local helpers**

In `CustomerApp.tsx`:

1. Add:

```tsx
import {
  FamilyCoverageOverview,
} from '../../features/family-report/FamilyCoverageOverview';
import {
  readFamilyPlanningProfile,
  saveFamilyPlanningProfile,
} from '../../features/family-report/family-planning-storage';
```

2. Remove local declarations for:

```tsx
const FAMILY_PLANNING_PROFILE_KEY = 'policy-ocr-app.familyPlanningProfile';
function normalizePlanningProfile(...)
function readFamilyPlanningProfile(...)
function saveFamilyPlanningProfile(...)
function FamilyCoverageOverview(...)
```

3. Remove `FamilyRadarSection` from the `../../FamilyReport` import, leaving `FamilyReportPage`.

- [ ] **Step 4: Update the radar storage test**

In `tests/customer-ui-style.test.mjs`, the test named `family report renders amount-based radar sections in the agreed order without chart dependencies` currently asserts `normalizedCustomerAppSource` contains `FAMILY_PLANNING_PROFILE_KEY`. Change that assertion to use the new feature source:

```js
assert.match(customerFamilyReportFeatureSource + '\n' + readOptionalSource('../src/features/family-report/family-planning-storage.ts'), /FAMILY_PLANNING_PROFILE_KEY/);
```

Keep the `buildFamilyReport(selectedFamilyPolicies, familyPlanningProfile, { familyId: selectedFamilyId })` assertion against `normalizedCustomerAppSource`.

- [ ] **Step 5: Run verification**

Run:

```bash
npm run typecheck
node --test tests/customer-ui-style.test.mjs
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/apps/customer/CustomerApp.tsx src/features/family-report/FamilyCoverageOverview.tsx src/features/family-report/family-planning-storage.ts tests/customer-ui-style.test.mjs
git commit -m "refactor: extract family report overview"
```

---

### Task 5: Extract Controlled Cash Value Dialog

**Files:**
- Create: `src/features/cash-value/CashValueDialog.tsx`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create `CashValueDialog.tsx`**

Move the current `const cashValueDialog = cashValueDialogOpen ? (...) : null` JSX into a controlled component:

```tsx
import {
  useRef,
  type ChangeEvent,
} from 'react';
import {
  Loader2,
  Plus,
  X,
} from 'lucide-react';
import type {
  CashValueRow,
  CashValueScanResult,
} from '../../api';

export function CashValueDialog({
  editRows,
  loading,
  message,
  open,
  scanResult,
  onAddRow,
  onCancel,
  onCellEdit,
  onConfirm,
  onFileChange,
  onRemoveRow,
  onResetForRescan,
  onStartManualEntry,
}: {
  editRows: CashValueRow[];
  loading: boolean;
  message: string;
  open: boolean;
  scanResult: CashValueScanResult | null;
  onAddRow: () => void;
  onCancel: () => void;
  onCellEdit: (rowIndex: number, field: 'policyYear' | 'age' | 'cashValue', value: string) => void;
  onConfirm: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveRow: (rowIndex: number) => void;
  onResetForRescan: () => void;
  onStartManualEntry: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        {!scanResult ? (
          <div className="text-center">
            <h3 className="mb-2 text-lg font-bold text-slate-800">录入保单现金价值</h3>
            <p className="mb-5 text-sm text-slate-500">拍照上传保单的现金价值页面，系统将自动识别并录入</p>
            {message && <p className="mb-3 text-sm text-red-500">{message}</p>}
            {loading && (
              <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-left" aria-live="polite">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-black text-blue-700">现金价值表识别中</span>
                  <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-blue-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuetext="正在识别现金价值表">
                  <div className="h-full w-1/2 rounded-full bg-blue-500 animate-[cash-value-progress_1.35s_ease-in-out_infinite]" />
                </div>
              </div>
            )}
            <div className="flex flex-wrap justify-center gap-3">
              <button type="button" className="rounded-lg bg-[#0B72B9] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50" disabled={loading} onClick={() => inputRef.current?.click()}>
                拍照上传
              </button>
              <button type="button" className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50" disabled={loading} onClick={onStartManualEntry}>
                手动录入
              </button>
              <button type="button" className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600" onClick={onCancel}>
                暂时跳过
              </button>
            </div>
            <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChange} />
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-slate-800">{scanResult.source === 'manual' ? '录入现金价值' : '现金价值表识别结果'}</h3>
              <span className="text-xs text-slate-400">
                {scanResult.source === 'manual' ? '手动录入' : scanResult.source === 'macos_vision' ? '本机Vision' : scanResult.source === 'vision_llm' ? 'AI识别' : 'Paddle OCR'}
                {scanResult.confidence != null && ` · 置信度 ${Math.round(scanResult.confidence * 100)}%`}
              </span>
            </div>
            {message && <p className="mb-2 text-sm text-red-500">{message}</p>}
            <div className="mb-3 flex justify-end">
              <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 ring-1 ring-emerald-100" onClick={onAddRow}>
                <Plus size={14} />
                添加年度
              </button>
            </div>
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">保单年度</th>
                    {scanResult.tableType === 3 && <th className="px-2 py-1.5 text-left font-bold text-slate-600">年龄</th>}
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">现金价值(元)</th>
                    <th className="w-10 px-2 py-1.5 text-right font-bold text-slate-600">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-1 py-0.5">
                        <input type="text" className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none" defaultValue={row.policyYear} onBlur={(event) => onCellEdit(i, 'policyYear', event.target.value)} />
                      </td>
                      {scanResult.tableType === 3 && (
                        <td className="px-1 py-0.5">
                          <input type="text" className="w-14 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none" defaultValue={row.age ?? ''} onBlur={(event) => onCellEdit(i, 'age', event.target.value)} />
                        </td>
                      )}
                      <td className="px-1 py-0.5">
                        <input type="text" className="w-24 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none" defaultValue={row.cashValue.toLocaleString('zh-CN')} onBlur={(event) => onCellEdit(i, 'cashValue', event.target.value)} />
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-50 text-slate-400 active:bg-red-50 active:text-red-500" onClick={() => onRemoveRow(i)} aria-label="删除现金价值行">
                          <X size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2 justify-center">
              <button type="button" className="rounded-lg bg-[#0B72B9] px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={loading || editRows.length === 0} onClick={onConfirm}>
                确认保存
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-50"
                disabled={loading}
                onClick={() => {
                  onResetForRescan();
                  inputRef.current?.click();
                }}
              >
                {scanResult.source === 'manual' ? '拍照识别' : '重新拍照'}
              </button>
              <button type="button" className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-400" onClick={onCancel}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace `cashValueDialog` in `CustomerApp.tsx`**

In `CustomerApp.tsx`:

1. Add:

```tsx
import {
  CashValueDialog,
} from '../../features/cash-value/CashValueDialog';
```

2. Remove `const cashValueInputRef = useRef<HTMLInputElement | null>(null);`.
3. Delete the local `const cashValueDialog = cashValueDialogOpen ? (...) : null;`.
4. Replace it with:

```tsx
const cashValueDialog = (
  <CashValueDialog
    editRows={cashValueEditRows}
    loading={cashValueLoading}
    message={cashValueMessage}
    open={cashValueDialogOpen}
    scanResult={cashValueScanResult}
    onAddRow={handleAddCashValueRow}
    onCancel={closeCashValueDialog}
    onCellEdit={handleCashValueCellEdit}
    onConfirm={() => void handleCashValueConfirm()}
    onFileChange={(event) => { void handleCashValueFileChange(event); }}
    onRemoveRow={handleRemoveCashValueRow}
    onResetForRescan={() => {
      setCashValueScanResult(null);
      setCashValueEditRows([]);
      setCashValueMessage('');
    }}
    onStartManualEntry={startManualCashValueEntry}
  />
);
```

5. Remove unused `Loader2`, `Plus`, and `X` imports from `CustomerApp.tsx` if no longer used.

- [ ] **Step 3: Update cash value source-text tests**

In `tests/customer-ui-style.test.mjs`, update tests that inspect cash value dialog UI to read the new owner:

```js
const appSource = customerCashValueFeatureSource || componentSource('CustomerApp', null);
```

Use this in:

- `cash value upload dialog shows a progress bar while scanning`
- `cash value upload uses rear camera capture path`

For `customer policy detail can open manual cash value entry`, keep handler/API assertions against `CustomerApp`, but assert the visible strings against `customerCashValueFeatureSource`:

```js
assert.match(customerSource, /openManualCashValueEditor/);
assert.match(customerSource, /startManualCashValueEntry/);
assert.match(customerSource, /handleAddCashValueRow/);
assert.match(customerSource, /handleRemoveCashValueRow/);
assert.match(customerSource, /normalizeCashValueRowsForSaving/);
assert.match(customerSource, /confirmCashValue/);
assert.match(customerCashValueFeatureSource, /手动录入/);
assert.match(customerCashValueFeatureSource, /添加年度/);
```

- [ ] **Step 4: Run verification**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/apps/customer/CustomerApp.tsx src/features/cash-value/CashValueDialog.tsx tests/customer-ui-style.test.mjs
git commit -m "refactor: extract cash value dialog"
```

---

### Task 6: Extract Controlled Admin Panels

**Files:**
- Create: `src/features/admin-shared/AdminStatCard.tsx`
- Create: `src/features/admin-shared/TextField.tsx`
- Create: `src/features/admin-official-domain/AdminOfficialDomainPanel.tsx`
- Create: `src/features/admin-knowledge/AdminKnowledgePanel.tsx`
- Create: `src/features/admin-ocr-config/AdminOcrModePanel.tsx`
- Create: `src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx`
- Create: `src/features/admin-policy-detail/AdminPolicyDetail.tsx`
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create shared admin UI files**

Create `src/features/admin-shared/AdminStatCard.tsx`:

```tsx
export function AdminStatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[22px] border border-slate-200 bg-white p-4">
      <p className="text-xs font-black uppercase text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
    </div>
  );
}
```

Create `src/features/admin-shared/TextField.tsx`:

```tsx
export function TextField(props: {
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
```

- [ ] **Step 2: Create official domain panel**

Move `OfficialDomainForm`, `emptyOfficialDomainForm`, `listToText`, `textToList`, `profileToOfficialDomainForm`, `formToOfficialDomainPayload`, and `AdminOfficialDomainPanel` into `src/features/admin-official-domain/AdminOfficialDomainPanel.tsx`. Export the type, constants, helpers, and panel.

Use imports:

```tsx
import {
  Shield,
} from 'lucide-react';
import type {
  AdminOfficialDomainProfile,
} from '../../api';
```

Keep helper names unchanged because `AdminApp` will import them.

- [ ] **Step 3: Create knowledge panel**

Move `KnowledgeCrawlForm`, `emptyKnowledgeCrawlForm`, and `AdminKnowledgePanel` into `src/features/admin-knowledge/AdminKnowledgePanel.tsx`. Export all three.

Use imports:

```tsx
import {
  Database,
} from 'lucide-react';
import type {
  KnowledgeRecord,
} from '../../api';
```

- [ ] **Step 4: Create OCR config panel**

Move `AdminOcrModePanel` into `src/features/admin-ocr-config/AdminOcrModePanel.tsx`.

Use imports:

```tsx
import {
  Sparkles,
} from 'lucide-react';
import type {
  AdminOcrConfig,
} from '../../api';
import {
  formatDateLabel,
  formatOcrModeLabel,
} from '../../shared/formatters';
```

- [ ] **Step 5: Create governance panel**

Move `AdminOptionalResponsibilityGapPanel` into `src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx`.

Use imports:

```tsx
import type {
  OptionalResponsibilityGap,
} from '../../api';
```

- [ ] **Step 6: Create admin policy detail drawer**

Move `AdminPolicyDetail` into `src/features/admin-policy-detail/AdminPolicyDetail.tsx`.

Use imports:

```tsx
import {
  useRef,
} from 'react';
import {
  Download,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import type {
  Policy,
} from '../../api';
import {
  formatCoverageAmount,
  formatCurrency,
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
```

- [ ] **Step 7: Update `AdminApp.tsx` imports and delete local definitions**

In `src/apps/admin/AdminApp.tsx`:

1. Add imports:

```tsx
import {
  AdminStatCard,
} from '../../features/admin-shared/AdminStatCard';
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
import {
  AdminOcrModePanel,
} from '../../features/admin-ocr-config/AdminOcrModePanel';
import {
  AdminOptionalResponsibilityGapPanel,
} from '../../features/admin-governance/AdminOptionalResponsibilityGapPanel';
import {
  AdminPolicyDetail,
} from '../../features/admin-policy-detail/AdminPolicyDetail';
```

2. Delete local definitions moved to feature files:

```tsx
type OfficialDomainForm
type KnowledgeCrawlForm
const emptyOfficialDomainForm
const emptyKnowledgeCrawlForm
function listToText(...)
function textToList(...)
function profileToOfficialDomainForm(...)
function formToOfficialDomainPayload(...)
function TextField(...)
function AdminStatCard(...)
function AdminOptionalResponsibilityGapPanel(...)
function AdminOfficialDomainPanel(...)
function AdminKnowledgePanel(...)
function AdminOcrModePanel(...)
function AdminPolicyDetail(...)
```

3. Remove these imports from `AdminApp.tsx` when the local panel definitions are deleted:

```tsx
Download
ExternalLink
RefreshCw
Shield
Sparkles
Database
AdminOcrConfig
AdminOfficialDomainProfile
KnowledgeRecord
formatCurrency
formatDateLabel
formatOcrModeLabel
downloadReportPdf
getReportExportControlTitle
MetricBox
ReportText
buildPolicyReportTitle
formatSourceUrlHost
getPolicyResponsibilitySourceLinks
isPolicyReportFailed
isPolicyReportGenerating
```

Keep `OptionalResponsibilityGap` because the governance handlers in `AdminApp.tsx` still type their arguments with it. After editing, run `npm run typecheck`; if TypeScript reports an unused import in `AdminApp.tsx`, remove that exact reported import and rerun `npm run typecheck`.

- [ ] **Step 8: Update admin source-text tests**

In `tests/customer-ui-style.test.mjs`, update the test named `admin app exposes optional responsibility quantification governance list` so panel copy assertions read the new governance owner:

```js
const appText = `${normalizedAdminAppSource}\n${normalizedAdminFeatureSource}`;
```

Keep the API assertions unchanged.

- [ ] **Step 9: Run verification**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add src/apps/admin/AdminApp.tsx src/features/admin-shared/AdminStatCard.tsx src/features/admin-shared/TextField.tsx src/features/admin-official-domain/AdminOfficialDomainPanel.tsx src/features/admin-knowledge/AdminKnowledgePanel.tsx src/features/admin-ocr-config/AdminOcrModePanel.tsx src/features/admin-governance/AdminOptionalResponsibilityGapPanel.tsx src/features/admin-policy-detail/AdminPolicyDetail.tsx tests/customer-ui-style.test.mjs
git commit -m "refactor: extract admin owner panels"
```

---

### Task 7: Final Verification and Owner Map Follow-Up

**Files:**
- Inspect and possibly modify: `docs/architecture/owner-map.md`
- Inspect: `src/apps/customer/CustomerApp.tsx`
- Inspect: `src/apps/admin/AdminApp.tsx`

- [ ] **Step 1: Check file sizes**

Run:

```bash
wc -l src/apps/customer/CustomerApp.tsx src/apps/admin/AdminApp.tsx src/features/customer-auth/*.tsx src/features/customer-navigation/*.tsx src/features/cashflow/*.tsx src/features/family-report/*.tsx src/features/cash-value/*.tsx src/features/admin-*/*.tsx
```

Expected: `CustomerApp.tsx` trends toward 1400-1900 lines, `AdminApp.tsx` trends toward 500-800 lines, and each new owner file is focused. If a new file is over 800 lines, note why before continuing.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm run check
npm run typecheck
npm run build
npm run test
```

Expected: all PASS.

- [ ] **Step 3: Check local stack status**

Run:

```bash
npm run local:status
```

Expected: if the stack is running, note the web URL and perform browser smoke checks for customer policy entry, policy detail, family report, cashflow detail, cash value dialog, and admin panels. If the stack is not running, record that browser verification was not run.

- [ ] **Step 4: Update owner map only if implementation names differ**

Open `docs/architecture/owner-map.md`. If the implemented feature paths match the existing owner map plus this plan, no change is required. If any owner directory name differs from this plan, update the Frontend Owners table with the actual file paths.

- [ ] **Step 5: Commit verification docs if changed**

If `docs/architecture/owner-map.md` changed:

```bash
git add docs/architecture/owner-map.md
git commit -m "docs: refresh frontend owner map"
```

If it did not change, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Customer auth/navigation extraction is covered by Task 2.
- Cashflow extraction is covered by Task 3.
- Family report overview and storage helper extraction is covered by Task 4.
- Cash value controlled dialog extraction is covered by Task 5.
- Admin controlled panel extraction is covered by Task 6.
- Verification and owner map follow-up are covered by Task 7.

Placeholder scan:

- No `TBD`, `TODO`, or unspecified implementation steps remain.
- Each code-changing task includes exact files, imports, commands, and expected results.

Type consistency:

- `CustomerTab`, `OfficialDomainForm`, and `KnowledgeCrawlForm` are exported from their new owner files and imported by app shells.
- Controlled components keep existing callback names and state ownership in app shells.
- Source-text tests are updated before component moves so intermediate tasks remain testable.
