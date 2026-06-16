# Admin Backoffice Redesign Design

## Context

The current `/admin` interface mixes several different jobs into one page. `src/apps/admin/AdminApp.tsx` owns the admin shell, login, summary stats, policy list, users, insured people, membership settings, official domain configuration, optional responsibility governance, knowledge crawling, and report issue review. The visible result is that operational work, read-only review, and configuration forms compete for the same left column.

The redesign keeps the existing backend capabilities, but reorganizes the admin frontend into a clearer backoffice: a persistent left menu, a top toolbar, and page-specific work areas. The selected direction is an operator workflow layout: pages that involve selecting records use list plus detail; configuration pages use form plus list or focused settings layouts.

## Goals

- Make `/admin` open to an operation overview by default.
- Replace the current mixed horizontal tabs and crowded side panels with grouped left navigation.
- Split policy operations, users, report issues, optional responsibility gaps, product knowledge, official domains, and membership settings into clear pages.
- Add a read-only `用户` page where admins can select a registered user and view that user's family list.
- On the admin `用户` page, remove all data-changing actions: no policy entry, no family edit, no family delete, and no other create/update/delete controls.
- Preserve existing admin capabilities for policy review, report issue review, product knowledge crawling, official domain maintenance, optional responsibility governance, and membership settings.
- Keep the first implementation focused on frontend information architecture and layout, adding only a thin read-only admin endpoint if current overview data cannot supply the user family list.

## Non-Goals

- Do not redesign customer-facing pages.
- Do not add new write operations for admins on users or families.
- Do not add a full approval workflow for report corrections.
- Do not redesign authentication or admin session behavior.
- Do not change OCR, family report, cashflow, responsibility, or membership domain calculations.

## Navigation

The admin shell uses a persistent left sidebar with grouped menu items:

```text
总览
  运营总览

业务运营
  保单运营
  用户

质检治理
  报告问题
  可选责任缺口

知识配置
  产品知识库
  官方域名

系统
  会员设置
```

The menu item is `用户`, not `用户与被保人`. Insured people are shown as part of policy or family context, not as a primary navigation concept.

The top toolbar stays consistent across pages:

- Page title and short status message.
- Page-aware search input.
- Refresh action.
- Logout action.

Search behavior is scoped to the current page:

- `保单运营`: search user mobile, insurer, product, applicant, insured, date, payment period, and coverage period.
- `用户`: search mobile, masked mobile, user id, family name, and household holder when available.
- `报告问题`: search family name, report metadata, issue title, issue detail, and product/member labels when available.
- Configuration pages: search records relevant to that page when practical; otherwise keep the search hidden or disabled for that page.

## Page Designs

### 运营总览

This is the default page after login.

The first row shows high-level stats:

- 注册账号
- 家庭数
- 被保人数
- 保单总数
- 报告问题
- 知识库资料

Below the stats, the page shows operational queues that link into their owning pages:

- Reports with current issues.
- Pending or notable report corrections.
- Optional responsibility quantification gaps.
- Policies with failed report generation.

The overview is a routing and monitoring page. It should not contain long configuration forms.

### 保单运营

This page uses the selected workflow layout:

- Left content pane: policy list, count, search/filter state, and optional selected-user filter.
- Right content pane: selected policy detail.

Clicking a policy opens the detail in the right pane instead of making the modal sheet the primary experience. The detail should preserve existing admin policy review capabilities:

- OCR source and normalized fields.
- Responsibility analysis and report status.
- Report generation failure state.
- Existing report retry action.

If keeping `AdminPolicyDetail` as a sheet is the fastest safe first step, the first implementation may still use it behind the detail pane boundary, but the target UX is an inline detail pane.

### 用户

This page is read-only.

Flow:

1. Show registered user list.
2. Click a user.
3. Show that user's family list.
4. Click a family action to view existing customer-facing information in admin context.

User list rows show:

- Mobile number, masked when appropriate.
- User id.
- Policy count.
- Family count when available.
- Insured count.
- Last activity or latest policy date when available.

The selected user detail shows family cards similar to the customer family list, but with admin-safe actions only:

- `查看报告`
- `家庭保单`
- `销售建议`

The admin user page must not show:

- `录入保单`
- `编辑家庭`
- `删除家庭`
- Create family controls
- Any other create/update/delete action

If the current admin overview payload does not include family profiles grouped by user, add one read-only admin route such as `GET /api/admin/users/:userId/families`. The route should return only the family data needed to render the list and should not expose mutation actions.

### 报告问题

This page keeps the existing report issue review model, but uses a clearer list plus detail layout:

- Left pane: report issue reports, counts, severity badges, correction status badges.
- Right pane: selected report's issues and correction records.

The page should continue to show:

- Issue severity.
- Category.
- Detail and suggestion.
- Member, product, and dimension labels when available.
- Correction status, reason, original value, corrected value, and not-applied reason.

The first redesign does not add a new approval workflow. It only makes the existing review data easier to read and reach from the sidebar.

### 可选责任缺口

This becomes an independent governance page instead of a card inside the policy page.

The page shows:

- Quantification gap list.
- Product name, insurer, liability, reason, and recent policy count.
- Existing action to mark a gap as not quantifiable.
- Existing action to re-extract optional responsibilities.

This page may use a single-column list at first. It should not share layout space with membership, knowledge, or official domain configuration.

### 产品知识库

This becomes an independent knowledge configuration page.

Layout:

- Crawl form for insurer and product name.
- Knowledge record list with record count, official count, source type, company, product/title, and URL.
- Refresh and crawl actions.

Existing `AdminKnowledgePanel` behavior is preserved, but the panel should be adapted to page width instead of staying as a narrow sidebar card.

### 官方域名

This becomes an independent configuration page.

Layout:

- Official domain form.
- Alias, official domain, and search domain fields.
- Profile list with system/custom labels.
- Edit custom profile, delete custom profile, refresh, save, and reset actions.

Existing `AdminOfficialDomainPanel` behavior is preserved, but the panel should be adapted to page width.

### 会员设置

This becomes an independent system page.

The page shows:

- Whether membership purchase is enabled.
- Registered user's free saved-policy quota.
- Static membership terms: 300 yuan per year, 365 days.
- Save action.

Existing membership config behavior is preserved.

## Component Structure

The implementation should split the current `AdminApp` into a shell and focused pages.

Proposed frontend modules:

- `src/apps/admin/AdminApp.tsx`: authentication state, initial admin data loading, high-level routing between admin pages.
- `src/apps/admin/AdminShell.tsx`: sidebar, top toolbar, page title, page-aware search, refresh, logout.
- `src/apps/admin/pages/AdminOverviewPage.tsx`: overview stats and queues.
- `src/apps/admin/pages/AdminPoliciesPage.tsx`: policy list and selected policy detail.
- `src/apps/admin/pages/AdminUsersPage.tsx`: user list and selected user's family list.
- `src/apps/admin/pages/AdminReportIssuesPage.tsx`: report issue list and detail.
- `src/apps/admin/pages/AdminOptionalResponsibilitiesPage.tsx`: optional responsibility gap governance.
- `src/apps/admin/pages/AdminKnowledgePage.tsx`: product knowledge configuration.
- `src/apps/admin/pages/AdminOfficialDomainsPage.tsx`: official domain configuration.
- `src/apps/admin/pages/AdminMembershipPage.tsx`: membership settings.

Existing feature components can be reused and widened before creating new abstractions:

- `AdminKnowledgePanel`
- `AdminOfficialDomainPanel`
- `AdminOptionalResponsibilityGapPanel`
- `AdminPolicyDetail`
- `AdminStatCard`
- `TextField`

The split is for readability and page ownership. It should not introduce a new state management library.

## Data Flow

The first implementation should reuse existing admin API calls where possible:

- `adminLogin`
- `getAdminOverview`
- `getAdminReportIssues`
- `getAdminReportIssueDetail`
- `getAdminMembershipConfig`
- `updateAdminMembershipConfig`
- `getAdminOfficialDomainProfiles`
- `createAdminOfficialDomainProfile`
- `updateAdminOfficialDomainProfile`
- `deleteAdminOfficialDomainProfile`
- `getAdminKnowledgeRecords`
- `crawlAdminKnowledge`
- `markOptionalResponsibilityNotQuantifiable`
- `reextractOptionalResponsibilities`
- `regeneratePolicyReport`

`getAdminOverview` remains the primary initial read. It can continue to provide summary, users, insureds, policies, knowledge counts, and optional responsibility gaps.

For the `用户` page, choose the smallest sufficient data path:

1. If existing overview data can derive the selected user's family list safely, derive it in frontend helpers.
2. If family profiles are missing from overview, add a read-only admin endpoint for selected user's families.

No admin family mutation endpoints are part of this design.

## Loading and Error States

- Unauthorized responses clear admin auth state and return to login.
- Global admin messages remain visible in the top toolbar.
- Each page shows local loading states for its own refresh or save operations.
- Empty states should be page-specific:
  - No policies match search.
  - No users match search.
  - Selected user has no families.
  - No report issues.
  - No knowledge records.
  - No official domain profiles.
  - No optional responsibility gaps.
- Configuration save failures keep the form state intact and show the error message.

## Responsive Behavior

Desktop:

- Sidebar stays visible.
- Workflow pages use list plus detail.
- Configuration pages use form plus list or single focused settings layout.

Narrow screens:

- Sidebar collapses to icon-sized navigation or a compact vertical rail.
- List and detail panes stack vertically.
- Tables should become scroll-contained lists rather than forcing page-wide horizontal overflow.

## Visual Direction

The admin UI should feel like a dense operational tool:

- Dark left sidebar.
- Light main work area.
- Clear table/list/detail hierarchy.
- Fewer nested cards.
- Cards only for repeated records, panels, and settings groups.
- Moderate radius, ideally lower than the current large rounded-card style.
- Icons plus labels for primary navigation and actions when existing icon library supports them.
- Dangerous actions only on pages that intentionally own mutations. The `用户` page has no dangerous or modifying actions.

## Verification

Because this is a frontend admin redesign, implementation verification should run:

```bash
npm run typecheck
npm run build
```

If an admin read-only families endpoint is added, also run:

```bash
npm run check
npm test
```

Focused UI checks:

- Logging in opens `运营总览`.
- Sidebar switches all pages.
- `保单运营` still lists policies and opens a policy detail.
- `用户` lists users, opens selected user's family list, and shows no policy entry, edit family, delete family, create family, or other mutation controls.
- `报告问题` still loads report list and report detail.
- Knowledge, official domain, optional responsibility, and membership actions still work from their new pages.

## Implementation Notes

- Keep route handlers thin if a read-only user-family endpoint is needed.
- Keep business logic out of React components when it belongs in existing domain or service modules.
- Do not add dependencies for layout or routing; local React state is enough.
- Preserve existing admin token storage key unless authentication is explicitly redesigned later.
- Keep edits surgical: reorganize admin frontend ownership and only add backend data support if the read-only user page cannot be built from existing payloads.
