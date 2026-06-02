# Family Profile Report Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build family profile based policy entry, report statistics, and report sharing so policies are scoped by `familyId` and grouped by family member IDs.

**Architecture:** Add a small family-profile domain module on the server, persist family profiles and members through the existing SQLite JSON payload pattern, then thread `familyId`, `applicantMemberId`, and `insuredMemberId` through policy creation and updates. The React app keeps the existing single-page entry/report flow but adds a lightweight family selector and core-person setup inside the entry form.

**Tech Stack:** Node.js `node:test`, Express, existing SQLite state store, React 19, TypeScript, Vite, existing source-level UI tests.

---

## Scope Check

The approved spec spans storage, API, entry UI, report engine, family management, and sharing. These are tightly coupled around one invariant: a policy belongs to one family and its participants must be members of that family. This plan keeps one implementation track but splits the work into independently testable tasks.

## File Structure

- Create: `server/family-profile.domain.mjs`
  - Owns family/member normalization, default-family migration, participant matching, and validation.
- Modify: `server/policy-ocr.domain.mjs`
  - Adds `familyProfiles` and `familyMembers` to initial state and allows `buildPolicyFromScan()` to receive family participant bindings.
- Modify: `server/sqlite-state-store.mjs`
  - Persists family profiles and members as first-class DB-owned tables and includes them in `nextId` resolution.
- Modify: `server/app.mjs`
  - Adds family profile/member API routes and validates family participant fields during policy create/update.
- Modify: `src/api.ts`
  - Adds `FamilyProfile`, `FamilyMember`, family API clients, and policy family fields.
- Modify: `src/App.tsx`
  - Adds family state, minimal family selector, core-person setup, member matching, and family management UI.
- Modify: `src/family-report-engine.mjs`
  - Uses family member display metadata and member IDs for grouping where available.
- Modify: `src/family-report-engine.d.mts`
  - Types family-aware report rows.
- Modify: `src/FamilyReport.tsx`
  - Displays family name, core person, household identity, and name-mismatch review hints.
- Test: `tests/family-profile-domain.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/family-report-engine.test.mjs`
- Test: `tests/customer-ui-style.test.mjs`

## Task 1: Family Domain and Persistence

**Files:**
- Create: `server/family-profile.domain.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/family-profile-domain.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write family domain tests**

Create `tests/family-profile-domain.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  ensureDefaultFamilyProfileForPrincipal,
  matchFamilyMemberByPerson,
  normalizeFamilyRelation,
  validatePolicyFamilyBinding,
} from '../server/family-profile.domain.mjs';

test('ensureDefaultFamilyProfileForPrincipal migrates existing policy participants into a default family', () => {
  const state = {
    ...createInitialState(),
    nextId: 10,
    policies: [
      { id: 1, userId: 8, guestId: '', applicant: '张三', insured: '李四', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 2, userId: 8, guestId: '', applicant: '张三', insured: '王小明', createdAt: '2026-05-02T00:00:00.000Z' },
    ],
  };

  const family = ensureDefaultFamilyProfileForPrincipal(state, { userId: 8 });

  assert.equal(family.familyName, '默认家庭');
  assert.equal(state.familyProfiles.length, 1);
  assert.equal(state.familyMembers.length, 3);
  assert.equal(state.familyMembers.find((member) => member.id === family.coreMemberId)?.name, '张三');
  assert.equal(state.familyMembers.find((member) => member.name === '李四')?.relationToCore, 'pending');
  assert.equal(state.policies[0].familyId, family.id);
  assert.ok(state.policies[0].applicantMemberId);
  assert.ok(state.policies[0].insuredMemberId);
});

test('matchFamilyMemberByPerson prefers exact name and birthday matches', () => {
  const members = [
    { id: 1, familyId: 20, name: '张三', birthday: '1980-01-01', idNumberTail: '2222', status: 'active' },
    { id: 2, familyId: 20, name: '张三', birthday: '1990-01-01', idNumberTail: '3333', status: 'active' },
  ];

  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01', idNumberTail: '3333' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1970-01-01' }), null);
});

test('validatePolicyFamilyBinding rejects participants outside the selected family', () => {
  const state = {
    ...createInitialState(),
    familyProfiles: [{ id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' }],
    familyMembers: [
      { id: 10, familyId: 1, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 20, familyId: 2, name: '李四', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
    ],
  };

  assert.throws(
    () => validatePolicyFamilyBinding(state, { familyId: 1, applicantMemberId: 10, insuredMemberId: 20 }),
    /POLICY_FAMILY_MEMBER_MISMATCH/,
  );
});

test('normalizeFamilyRelation maps common labels to stable values', () => {
  assert.deepEqual(normalizeFamilyRelation('儿子'), { relationToCore: 'son', relationLabel: '儿子', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('核心人员'), { relationToCore: 'self', relationLabel: '本人', role: 'core' });
  assert.deepEqual(normalizeFamilyRelation(''), { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' });
});
```

- [ ] **Step 2: Run domain tests and verify they fail**

Run:

```bash
node --test tests/family-profile-domain.test.mjs
```

Expected: FAIL with `Cannot find module '../server/family-profile.domain.mjs'`.

- [ ] **Step 3: Implement family domain helpers**

Create `server/family-profile.domain.mjs`:

```js
import { allocateId, normalizeDateOnly, normalizeGuestId, normalizeIdNumber } from './policy-ocr.domain.mjs';

function trim(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function normalizeFamilyRelation(value) {
  const text = trim(value);
  if (['本人', '核心人员', '家庭关系中心', 'self'].includes(text)) return { relationToCore: 'self', relationLabel: '本人', role: 'core' };
  if (['配偶', '丈夫', '妻子', '夫妻'].includes(text)) return { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' };
  if (['儿子', '子'].includes(text)) return { relationToCore: 'son', relationLabel: '儿子', role: 'child' };
  if (['女儿', '女'].includes(text)) return { relationToCore: 'daughter', relationLabel: '女儿', role: 'child' };
  if (['子女', '孩子', '小孩'].includes(text)) return { relationToCore: 'child', relationLabel: '子女', role: 'child' };
  if (['父亲', '爸爸'].includes(text)) return { relationToCore: 'father', relationLabel: '父亲', role: 'elder' };
  if (['母亲', '妈妈'].includes(text)) return { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' };
  if (['父母', '长辈'].includes(text)) return { relationToCore: 'parent', relationLabel: '父母', role: 'elder' };
  if (['其他'].includes(text)) return { relationToCore: 'other', relationLabel: '其他', role: 'unknown' };
  return { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' };
}

export function normalizeFamilyName(value) {
  return trim(value).slice(0, 80) || '默认家庭';
}

export function normalizeFamilyMemberInput(input = {}) {
  const relation = normalizeFamilyRelation(input.relationLabel || input.relationToCore);
  const idNumber = normalizeIdNumber(input.idNumber || input.idNumberTail || input.insuredIdNumber);
  return {
    name: trim(input.name).slice(0, 80),
    relationToCore: input.relationToCore && input.relationLabel ? trim(input.relationToCore) : relation.relationToCore,
    relationLabel: trim(input.relationLabel) || relation.relationLabel,
    role: trim(input.role) || relation.role,
    gender: ['male', 'female', 'unknown'].includes(trim(input.gender)) ? trim(input.gender) : 'unknown',
    birthday: normalizeDateOnly(input.birthday || input.insuredBirthday),
    idNumberTail: idNumber ? idNumber.slice(-4) : trim(input.idNumberTail).slice(-4),
    mobile: trim(input.mobile).slice(0, 20),
    notes: trim(input.notes).slice(0, 500),
    status: input.status === 'archived' ? 'archived' : 'active',
  };
}

export function createFamilyProfile(state, input = {}, owner = {}) {
  if (!Array.isArray(state.familyProfiles)) state.familyProfiles = [];
  const now = nowIso();
  const family = {
    id: allocateId(state),
    ownerUserId: owner.userId ? Number(owner.userId) : null,
    ownerGuestId: owner.guestId ? normalizeGuestId(owner.guestId) : '',
    familyName: normalizeFamilyName(input.familyName),
    coreMemberId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  state.familyProfiles.push(family);
  return family;
}

export function createFamilyMember(state, familyId, input = {}) {
  if (!Array.isArray(state.familyMembers)) state.familyMembers = [];
  const data = normalizeFamilyMemberInput(input);
  if (!data.name) {
    const error = new Error('家庭成员姓名不能为空');
    error.code = 'FAMILY_MEMBER_NAME_REQUIRED';
    error.status = 400;
    throw error;
  }
  const now = nowIso();
  const member = {
    id: allocateId(state),
    familyId: Number(familyId),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  state.familyMembers.push(member);
  return member;
}

export function familyOwnerMatches(family, owner = {}) {
  if (owner.userId) return Number(family.ownerUserId || 0) === Number(owner.userId);
  return normalizeGuestId(family.ownerGuestId) === normalizeGuestId(owner.guestId);
}

export function listFamilyProfilesForOwner(state, owner = {}) {
  return (Array.isArray(state.familyProfiles) ? state.familyProfiles : [])
    .filter((family) => family.status !== 'archived' && familyOwnerMatches(family, owner));
}

export function listFamilyMembers(state, familyId, options = {}) {
  return (Array.isArray(state.familyMembers) ? state.familyMembers : [])
    .filter((member) => Number(member.familyId) === Number(familyId))
    .filter((member) => options.includeArchived || member.status !== 'archived');
}

export function matchFamilyMemberByPerson(members = [], person = {}) {
  const name = trim(person.name);
  if (!name) return null;
  const birthday = normalizeDateOnly(person.birthday || person.insuredBirthday);
  const idTail = normalizeIdNumber(person.idNumber || person.idNumberTail || person.insuredIdNumber).slice(-4);
  const candidates = members.filter((member) => trim(member.name) === name && member.status !== 'archived');
  if (!candidates.length) return null;
  if (idTail) {
    const matched = candidates.find((member) => trim(member.idNumberTail) === idTail);
    if (matched) return matched;
  }
  if (birthday) {
    const matched = candidates.find((member) => trim(member.birthday) === birthday);
    if (matched) return matched;
    return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function policyParticipantNames(policy = {}) {
  return [policy.applicant, policy.insured]
    .map((name) => trim(name))
    .filter(Boolean);
}

export function ensureDefaultFamilyProfileForPrincipal(state, owner = {}) {
  const existing = listFamilyProfilesForOwner(state, owner)[0];
  if (existing) return existing;

  const family = createFamilyProfile(state, { familyName: '默认家庭' }, owner);
  const policies = (Array.isArray(state.policies) ? state.policies : []).filter((policy) => {
    if (owner.userId) return Number(policy.userId || 0) === Number(owner.userId);
    return normalizeGuestId(policy.guestId) === normalizeGuestId(owner.guestId) && !policy.userId;
  });
  const counts = new Map();
  for (const policy of policies) {
    for (const name of policyParticipantNames(policy)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const orderedNames = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([name]) => name);
  const membersByName = new Map();
  orderedNames.forEach((name, index) => {
    const member = createFamilyMember(state, family.id, {
      name,
      relationLabel: index === 0 ? '本人' : '待确认',
    });
    if (index === 0) {
      family.coreMemberId = member.id;
      member.relationToCore = 'self';
      member.relationLabel = '本人';
      member.role = 'core';
    }
    membersByName.set(name, member);
  });
  const now = nowIso();
  family.updatedAt = now;
  for (const policy of policies) {
    const applicant = membersByName.get(trim(policy.applicant));
    const insured = membersByName.get(trim(policy.insured));
    policy.familyId = family.id;
    if (applicant) policy.applicantMemberId = applicant.id;
    if (insured) policy.insuredMemberId = insured.id;
    policy.applicantNameSnapshot = trim(policy.applicant);
    policy.insuredNameSnapshot = trim(policy.insured);
    policy.participantReviewStatus = applicant && insured ? 'ok' : 'pending_member';
    policy.updatedAt = now;
  }
  return family;
}

export function validatePolicyFamilyBinding(state, input = {}) {
  const familyId = Number(input.familyId || 0);
  const applicantMemberId = Number(input.applicantMemberId || 0);
  const insuredMemberId = Number(input.insuredMemberId || 0);
  const family = (state.familyProfiles || []).find((row) => Number(row.id) === familyId && row.status !== 'archived');
  if (!family) {
    const error = new Error('请选择家庭档案');
    error.code = 'POLICY_FAMILY_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (!family.coreMemberId) {
    const error = new Error('请先设置家庭关系中心');
    error.code = 'POLICY_FAMILY_CORE_REQUIRED';
    error.status = 400;
    throw error;
  }
  const members = listFamilyMembers(state, familyId);
  const applicant = members.find((member) => Number(member.id) === applicantMemberId);
  const insured = members.find((member) => Number(member.id) === insuredMemberId);
  if (!applicant || !insured) {
    const error = new Error('投保人和被保险人必须属于当前家庭');
    error.code = 'POLICY_FAMILY_MEMBER_MISMATCH';
    error.status = 400;
    throw error;
  }
  return { family, applicant, insured };
}
```

- [ ] **Step 4: Add family state defaults**

Modify `server/policy-ocr.domain.mjs` in `createInitialState()`:

```js
export function createInitialState() {
  return {
    users: [],
    sessions: [],
    adminSessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    officialDomainProfiles: [],
    familyProfiles: [],
    familyMembers: [],
    familyReportShares: [],
    nextId: 1,
  };
}
```

- [ ] **Step 5: Extend SQLite state store persistence tests**

Append to the first test seed and assertions in `tests/sqlite-state-store.test.mjs`:

```js
familyProfiles: [{ id: 8, ownerUserId: 1, ownerGuestId: '', familyName: '张三家庭', coreMemberId: 9, status: 'active', createdAt: '2026-05-01T00:09:00.000Z', updatedAt: '2026-05-01T00:09:00.000Z' }],
familyMembers: [{ id: 9, familyId: 8, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active', createdAt: '2026-05-01T00:09:00.000Z', updatedAt: '2026-05-01T00:09:00.000Z' }],
```

Add assertions after the first load and reload:

```js
assert.equal(imported.familyProfiles.length, 1);
assert.equal(imported.familyMembers[0].name, '张三');
assert.equal(reloaded.familyProfiles[0].familyName, '张三家庭');
assert.equal(reloadedAfterRestart.familyMembers[0].relationLabel, '本人');
```

- [ ] **Step 6: Run SQLite test and verify it fails**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern="imports JSON once"
```

Expected: FAIL because `familyProfiles` and `familyMembers` are not DB-owned persisted arrays yet.

- [ ] **Step 7: Persist family tables in SQLite store**

Modify `server/sqlite-state-store.mjs`:

```js
const DB_OWNED_KEYS = new Set([
  'users',
  'sessions',
  'adminSessions',
  'smsCodes',
  'policies',
  'pendingScans',
  'sourceRecords',
  'knowledgeRecords',
  'insuranceIndicatorRecords',
  'optionalResponsibilityRecords',
  'officialDomainProfiles',
  'familyProfiles',
  'familyMembers',
  'familyReportShares',
  'nextId',
]);
```

Include family IDs in `resolveNextId()`:

```js
const maxId = Math.max(
  maxNumericId(state.users),
  maxNumericId(state.smsCodes),
  maxNumericId(state.policies),
  maxNumericId(state.sourceRecords),
  maxNumericId(state.knowledgeRecords),
  maxNumericId(state.familyProfiles),
  maxNumericId(state.familyMembers),
  maxNumericId(state.familyReportShares),
);
```

Add schema tables:

```sql
CREATE TABLE IF NOT EXISTS family_profiles (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER,
  owner_guest_id TEXT,
  family_name TEXT,
  core_member_id INTEGER,
  status TEXT,
  created_at TEXT,
  updated_at TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_family_profiles_owner_user_id ON family_profiles(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_family_profiles_owner_guest_id ON family_profiles(owner_guest_id);

CREATE TABLE IF NOT EXISTS family_members (
  id INTEGER PRIMARY KEY,
  family_id INTEGER,
  name TEXT,
  relation_to_core TEXT,
  status TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_family_members_family_id ON family_members(family_id);

CREATE TABLE IF NOT EXISTS family_report_shares (
  id INTEGER PRIMARY KEY,
  token TEXT UNIQUE,
  family_id INTEGER,
  created_at TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_family_report_shares_token ON family_report_shares(token);
```

Add insert blocks in `insertRows()`:

```js
const insertFamilyProfile = db.prepare(`
  INSERT INTO family_profiles (id, owner_user_id, owner_guest_id, family_name, core_member_id, status, created_at, updated_at, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
for (const family of normalizeArray(state.familyProfiles)) {
  insertFamilyProfile.run(
    Number(family.id),
    Number(family.ownerUserId || 0) || null,
    String(family.ownerGuestId || ''),
    String(family.familyName || ''),
    Number(family.coreMemberId || 0) || null,
    String(family.status || 'active'),
    String(family.createdAt || ''),
    String(family.updatedAt || ''),
    jsonPayload(family),
  );
}

const insertFamilyMember = db.prepare(`
  INSERT INTO family_members (id, family_id, name, relation_to_core, status, payload)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const member of normalizeArray(state.familyMembers)) {
  insertFamilyMember.run(
    Number(member.id),
    Number(member.familyId || 0) || null,
    String(member.name || ''),
    String(member.relationToCore || ''),
    String(member.status || 'active'),
    jsonPayload(member),
  );
}

const insertFamilyReportShare = db.prepare(`
  INSERT INTO family_report_shares (id, token, family_id, created_at, payload)
  VALUES (?, ?, ?, ?, ?)
`);
for (const share of normalizeArray(state.familyReportShares)) {
  insertFamilyReportShare.run(
    Number(share.id),
    String(share.token || ''),
    Number(share.familyId || 0) || null,
    String(share.createdAt || ''),
    jsonPayload(share),
  );
}
```

Add deletes in `clearDbOwnedTables()` before `DELETE FROM users;`:

```sql
DELETE FROM family_report_shares;
DELETE FROM family_members;
DELETE FROM family_profiles;
```

Add loads in `loadDbOwnedState()`:

```js
familyProfiles: loadPayloadRows(db, 'family_profiles', 'id ASC'),
familyMembers: loadPayloadRows(db, 'family_members', 'family_id ASC, id ASC'),
familyReportShares: loadPayloadRows(db, 'family_report_shares', 'created_at ASC, id ASC'),
```

- [ ] **Step 8: Run task tests**

Run:

```bash
node --test tests/family-profile-domain.test.mjs tests/sqlite-state-store.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit domain and persistence**

```bash
git add server/family-profile.domain.mjs server/policy-ocr.domain.mjs server/sqlite-state-store.mjs tests/family-profile-domain.test.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: add family profile domain"
```

## Task 2: Family APIs and Policy Participant Validation

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add API flow tests**

Append to `tests/policy-ocr-flow.test.mjs`:

```js
test('family APIs create family, set core member, and save policy with participant member ids', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({
      ocrText: '投保人:张三\n被保险人:李四',
      data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' },
    }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyRes = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: '张三家庭' }),
    });
    assert.equal(familyRes.response.status, 201);
    const familyId = familyRes.payload.family.id;

    const coreRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const insuredRes = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyId}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '配偶' }),
    });

    const scanRes = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family',
        scan: { ocrText: '投保人:张三\n被保险人:李四', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId,
          applicantMemberId: coreRes.payload.member.id,
          insuredMemberId: insuredRes.payload.member.id,
        },
      }),
    });

    assert.equal(scanRes.response.status, 201);
    assert.equal(scanRes.payload.policy.familyId, familyId);
    assert.equal(scanRes.payload.policy.applicantMemberId, coreRes.payload.member.id);
    assert.equal(scanRes.payload.policy.insuredMemberName, '李四');
    assert.equal(scanRes.payload.policy.insuredRelationLabel, '配偶');
  } finally {
    await server.close();
  }
});

test('policy save rejects applicant and insured members from different families', async () => {
  const state = createInitialState();
  const app = createPolicyOcrApp({
    state,
    persist: async () => {},
    scanner: async () => ({ ocrText: '', data: { company: '新华保险', name: '测试保单' } }),
    analyzer: async () => ({ report: 'ok', coverageTable: [] }),
  });
  const server = await listen(app);
  try {
    const familyA = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: 'A家庭' }),
    });
    const familyB = await jsonFetch(server.baseUrl, '/api/family-profiles?guestId=guest-family', {
      method: 'POST',
      body: JSON.stringify({ familyName: 'B家庭' }),
    });
    const coreA = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyA.payload.family.id}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '张三', relationLabel: '本人', setAsCore: true }),
    });
    const coreB = await jsonFetch(server.baseUrl, `/api/family-profiles/${familyB.payload.family.id}/members?guestId=guest-family`, {
      method: 'POST',
      body: JSON.stringify({ name: '李四', relationLabel: '本人', setAsCore: true }),
    });

    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-family',
        scan: { ocrText: '', data: { company: '新华保险', name: '测试保单', applicant: '张三', insured: '李四' } },
        analysis: { report: 'ok', coverageTable: [] },
        manualData: {
          familyId: familyA.payload.family.id,
          applicantMemberId: coreA.payload.member.id,
          insuredMemberId: coreB.payload.member.id,
        },
      }),
    });

    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'POLICY_FAMILY_MEMBER_MISMATCH');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern="family APIs|different families"
```

Expected: FAIL with `404` for family routes.

- [ ] **Step 3: Import family helpers in `server/app.mjs`**

Add:

```js
import {
  createFamilyMember,
  createFamilyProfile,
  ensureDefaultFamilyProfileForPrincipal,
  familyOwnerMatches,
  listFamilyMembers,
  listFamilyProfilesForOwner,
  validatePolicyFamilyBinding,
} from './family-profile.domain.mjs';
```

Add a helper near auth helpers:

```js
function requestOwner(req, user) {
  return user
    ? { userId: Number(user.id), guestId: '' }
    : { userId: null, guestId: normalizeGuestId(req.query?.guestId || req.body?.guestId) };
}
```

- [ ] **Step 4: Add family routes**

Insert before policy routes in `server/app.mjs`:

```js
app.get('/api/family-profiles', async (req, res) => {
  try {
    const user = resolveAuthUser(req, state);
    const owner = requestOwner(req, user);
    if (!owner.userId && !owner.guestId) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    const profiles = listFamilyProfilesForOwner(state, owner);
    res.json({
      ok: true,
      familyProfiles: profiles.map((family) => ({
        ...family,
        members: listFamilyMembers(state, family.id, { includeArchived: true }),
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/family-profiles', async (req, res) => {
  try {
    const user = resolveAuthUser(req, state);
    const owner = requestOwner(req, user);
    if (!owner.userId && !owner.guestId) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    const family = createFamilyProfile(state, req.body || {}, owner);
    await persist(state);
    res.status(201).json({ ok: true, family, members: [] });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post('/api/family-profiles/default', async (req, res) => {
  try {
    const user = resolveAuthUser(req, state);
    const owner = requestOwner(req, user);
    if (!owner.userId && !owner.guestId) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    const family = ensureDefaultFamilyProfileForPrincipal(state, owner);
    await persist(state);
    res.json({ ok: true, family, members: listFamilyMembers(state, family.id, { includeArchived: true }) });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.post('/api/family-profiles/:id/members', async (req, res) => {
  try {
    const user = resolveAuthUser(req, state);
    const owner = requestOwner(req, user);
    const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(req.params.id));
    if (!family || !familyOwnerMatches(family, owner)) return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    const member = createFamilyMember(state, family.id, req.body || {});
    if (req.body?.setAsCore || !family.coreMemberId) {
      for (const row of listFamilyMembers(state, family.id, { includeArchived: true })) {
        if (Number(row.id) === Number(member.id)) {
          row.relationToCore = 'self';
          row.relationLabel = '本人';
          row.role = 'core';
        } else if (row.role === 'core') {
          row.role = row.relationToCore === 'self' ? 'adult' : row.role;
          row.relationToCore = row.relationToCore === 'self' ? 'pending' : row.relationToCore;
          row.relationLabel = row.relationLabel === '本人' ? '待确认' : row.relationLabel;
        }
      }
      family.coreMemberId = member.id;
    }
    family.updatedAt = new Date().toISOString();
    await persist(state);
    res.status(201).json({ ok: true, member, family });
  } catch (error) {
    sendError(res, error, 400);
  }
});
```

- [ ] **Step 5: Add family fields to policy creation**

Modify `server/policy-ocr.domain.mjs` `buildPolicyFromScan()` signature and returned policy:

```js
export function buildPolicyFromScan({ state, userId = null, guestId = '', scan, analysis, familyBinding = null }) {
  // existing body
  return {
    id: allocateId(state),
    userId: userId ? Number(userId) : null,
    guestId: userId ? '' : normalizeGuestId(guestId),
    familyId: familyBinding?.familyId || null,
    applicantMemberId: familyBinding?.applicantMemberId || null,
    insuredMemberId: familyBinding?.insuredMemberId || null,
    applicantNameSnapshot: familyBinding?.applicantNameSnapshot || data.applicant,
    insuredNameSnapshot: familyBinding?.insuredNameSnapshot || data.insured,
    applicantRelationSnapshot: familyBinding?.applicantRelationSnapshot || data.applicantRelation,
    insuredRelationSnapshot: familyBinding?.insuredRelationSnapshot || data.insuredRelation,
    participantReviewStatus: familyBinding?.participantReviewStatus || '',
    insuredMemberName: familyBinding?.insuredMemberName || '',
    insuredRelationLabel: familyBinding?.insuredRelationLabel || '',
    applicantMemberName: familyBinding?.applicantMemberName || '',
    applicantRelationLabel: familyBinding?.applicantRelationLabel || '',
    // keep the existing fields below
  };
}
```

- [ ] **Step 6: Validate family binding in policy scan route**

In `/api/policies/scan`, before `buildPolicyFromScan()`:

```js
const manualData = req.body?.manualData && typeof req.body.manualData === 'object' ? req.body.manualData : {};
const familyInput = {
  familyId: manualData.familyId || req.body?.familyId,
  applicantMemberId: manualData.applicantMemberId || req.body?.applicantMemberId,
  insuredMemberId: manualData.insuredMemberId || req.body?.insuredMemberId,
};
const familyBindingSource = validatePolicyFamilyBinding(state, familyInput);
const familyBinding = {
  familyId: familyBindingSource.family.id,
  applicantMemberId: familyBindingSource.applicant.id,
  insuredMemberId: familyBindingSource.insured.id,
  applicantNameSnapshot: normalizedScan?.data?.applicant || familyBindingSource.applicant.name,
  insuredNameSnapshot: normalizedScan?.data?.insured || familyBindingSource.insured.name,
  applicantRelationSnapshot: normalizedScan?.data?.applicantRelation || '',
  insuredRelationSnapshot: normalizedScan?.data?.insuredRelation || '',
  participantReviewStatus:
    String(normalizedScan?.data?.applicant || '').trim() !== familyBindingSource.applicant.name ||
    String(normalizedScan?.data?.insured || '').trim() !== familyBindingSource.insured.name
      ? 'name_mismatch'
      : 'ok',
  applicantMemberName: familyBindingSource.applicant.name,
  applicantRelationLabel: familyBindingSource.applicant.relationLabel,
  insuredMemberName: familyBindingSource.insured.name,
  insuredRelationLabel: familyBindingSource.insured.relationLabel,
};
```

Pass `familyBinding` into `buildPolicyFromScan()`.

- [ ] **Step 7: Allow family fields in policy updates**

In `normalizePolicyUpdateData()` allow:

```js
for (const key of ['familyId', 'applicantMemberId', 'insuredMemberId']) {
  if (!hasOwn(input, key)) continue;
  const id = Number(input[key] || 0);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error(`${key} 格式不正确`);
    error.code = 'INVALID_POLICY_FAMILY_ID';
    error.status = 400;
    throw error;
  }
  data[key] = id;
}
```

In `/api/policies/:id` PATCH, if any family field is present, call `validatePolicyFamilyBinding()` and copy the member display fields onto `updates`.

- [ ] **Step 8: Return family metadata from policy list**

Add a helper in `server/app.mjs`:

```js
function attachPolicyFamilyDisplay(policy, state) {
  const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(policy.familyId));
  const applicant = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.applicantMemberId));
  const insured = (state.familyMembers || []).find((row) => Number(row.id) === Number(policy.insuredMemberId));
  return {
    ...policy,
    familyName: family?.familyName || '',
    applicantMemberName: applicant?.name || policy.applicantMemberName || '',
    applicantRelationLabel: applicant?.relationLabel || policy.applicantRelationLabel || '',
    insuredMemberName: insured?.name || policy.insuredMemberName || '',
    insuredRelationLabel: insured?.relationLabel || policy.insuredRelationLabel || '',
  };
}
```

Use this helper in policy responses:

```js
const policiesWithIndicators = attachPoliciesCoverageIndicators(
  policies.map((policy) => attachPolicyFamilyDisplay(policy, state)),
  state.insuranceIndicatorRecords,
  state.knowledgeRecords,
  state.optionalResponsibilityRecords,
);
```

For single-policy responses, wrap before indicator attachment:

```js
const enrichedPolicy = attachPolicyFamilyDisplay(policy, state);
const responsePolicy = attachPolicyCoverageIndicators(
  enrichedPolicy,
  state.insuranceIndicatorRecords,
  state.knowledgeRecords,
  state.optionalResponsibilityRecords,
);
```

- [ ] **Step 9: Run API tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern="family APIs|different families"
```

Expected: PASS.

- [ ] **Step 10: Commit API validation**

```bash
git add server/app.mjs server/policy-ocr.domain.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: validate policy family participants"
```

## Task 3: Frontend API Types and Clients

**Files:**
- Modify: `src/api.ts`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add API source test**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('client API exposes family profile types and endpoints', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /export type FamilyProfile/);
  assert.match(apiSource, /export type FamilyMember/);
  assert.match(apiSource, /listFamilyProfiles/);
  assert.match(apiSource, /createFamilyProfile/);
  assert.match(apiSource, /createFamilyMember/);
  assert.match(apiSource, /ensureDefaultFamilyProfile/);
  assert.match(apiSource, /familyId\?: number/);
  assert.match(apiSource, /applicantMemberId\?: number/);
  assert.match(apiSource, /insuredMemberId\?: number/);
});
```

- [ ] **Step 2: Run source test and verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile types"
```

Expected: FAIL because family types and clients are missing.

- [ ] **Step 3: Add TypeScript types**

Modify `src/api.ts`:

```ts
export type FamilyRelationToCore =
  | 'self'
  | 'spouse'
  | 'son'
  | 'daughter'
  | 'father'
  | 'mother'
  | 'parent'
  | 'parent_in_law'
  | 'grandparent'
  | 'sibling'
  | 'other'
  | 'pending';

export type FamilyMember = {
  id: number;
  familyId: number;
  name: string;
  relationToCore: FamilyRelationToCore;
  relationLabel: string;
  role: 'core' | 'adult' | 'child' | 'elder' | 'unknown';
  gender?: 'male' | 'female' | 'unknown';
  birthday?: string;
  idNumberTail?: string;
  mobile?: string;
  notes?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type FamilyProfile = {
  id: number;
  ownerUserId?: number | null;
  ownerGuestId?: string;
  familyName: string;
  coreMemberId: number | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  members?: FamilyMember[];
};
```

Extend `Policy` and `PolicyFormData`:

```ts
familyId?: number | null;
applicantMemberId?: number | null;
insuredMemberId?: number | null;
applicantNameSnapshot?: string;
insuredNameSnapshot?: string;
applicantRelationSnapshot?: string;
insuredRelationSnapshot?: string;
participantReviewStatus?: 'ok' | 'name_mismatch' | 'pending_member' | string;
familyName?: string;
applicantMemberName?: string;
applicantRelationLabel?: string;
insuredMemberName?: string;
insuredRelationLabel?: string;
```

- [ ] **Step 4: Add API clients**

Add to `src/api.ts`:

```ts
function authQuery(input: { guestId?: string } = {}) {
  return input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
}

export function listFamilyProfiles(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; familyProfiles: FamilyProfile[] }>(`/api/family-profiles${authQuery(input)}`, { token: input.token });
}

export function createFamilyProfile(input: { token?: string; guestId?: string; familyName: string }) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles${authQuery(input)}`, {
    token: input.token,
    body: { familyName: input.familyName },
  });
}

export function ensureDefaultFamilyProfile(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles/default${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}

export function createFamilyMember(input: {
  token?: string;
  guestId?: string;
  familyId: number;
  name: string;
  relationLabel: string;
  birthday?: string;
  idNumberTail?: string;
  setAsCore?: boolean;
}) {
  return request<{ ok: true; family: FamilyProfile; member: FamilyMember }>(`/api/family-profiles/${input.familyId}/members${authQuery(input)}`, {
    token: input.token,
    body: {
      name: input.name,
      relationLabel: input.relationLabel,
      birthday: input.birthday,
      idNumberTail: input.idNumberTail,
      setAsCore: input.setAsCore,
    },
  });
}
```

- [ ] **Step 5: Run type/client test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile types"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit frontend API clients**

```bash
git add src/api.ts tests/customer-ui-style.test.mjs
git commit -m "feat: add family profile client api"
```

## Task 4: Minimal Policy Entry Family Interaction

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add UI source tests for minimal entry interaction**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('entry form requires a family profile and supports core-person setup after OCR', () => {
  const pageSource = componentSource('UploadPolicyPage', 'AnalysisReportPage');
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(pageSource, /家庭档案/);
  assert.match(pageSource, /新建家庭档案/);
  assert.match(pageSource, /家庭关系中心/);
  assert.match(pageSource, /以谁作为家庭关系基准/);
  assert.match(pageSource, /新增为家庭成员/);
  assert.match(customerSource, /familyProfiles/);
  assert.match(customerSource, /selectedFamilyId/);
  assert.match(customerSource, /createFamilyProfile/);
  assert.match(customerSource, /createFamilyMember/);
  assert.match(customerSource, /applicantMemberId/);
  assert.match(customerSource, /insuredMemberId/);
});
```

- [ ] **Step 2: Run UI source test and verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile and supports core"
```

Expected: FAIL because the entry form has no family controls.

- [ ] **Step 3: Import family API clients and types**

Modify `src/App.tsx` imports:

```ts
import type { FamilyMember, FamilyProfile } from './api';
import {
  createFamilyMember,
  createFamilyProfile,
  ensureDefaultFamilyProfile,
  listFamilyProfiles,
} from './api';
```

Keep these in the existing grouped import from `./api`.

- [ ] **Step 4: Add family state in `CustomerApp`**

Add near policy state:

```ts
const [familyProfiles, setFamilyProfiles] = useState<FamilyProfile[]>([]);
const [selectedFamilyId, setSelectedFamilyId] = useState<number | null>(null);
const selectedFamily = useMemo(
  () => familyProfiles.find((family) => Number(family.id) === Number(selectedFamilyId)) || familyProfiles[0] || null,
  [familyProfiles, selectedFamilyId],
);
const selectedFamilyMembers = selectedFamily?.members || [];
```

Add loader:

```ts
async function refreshFamilyProfiles(nextToken = token) {
  const payload = await listFamilyProfiles({ token: nextToken || undefined, guestId: nextToken ? undefined : guestId });
  setFamilyProfiles(payload.familyProfiles);
  setSelectedFamilyId((current) => current && payload.familyProfiles.some((family) => Number(family.id) === Number(current))
    ? current
    : payload.familyProfiles[0]?.id ?? null);
}
```

Call it in the existing `useEffect()` that refreshes policies:

```ts
refreshFamilyProfiles().catch(() => {});
```

- [ ] **Step 5: Add small family helpers in `CustomerApp`**

Add:

```ts
function findFamilyMemberByName(name: string) {
  const normalized = name.trim();
  if (!normalized) return null;
  const matches = selectedFamilyMembers.filter((member) => member.status !== 'archived' && member.name.trim() === normalized);
  return matches.length === 1 ? matches[0] : null;
}

async function ensureFamilyBeforeSave() {
  let family = selectedFamily;
  if (!family) {
    const created = await createFamilyProfile({ token: token || undefined, guestId: token ? undefined : guestId, familyName: '默认家庭' });
    family = { ...created.family, members: created.members };
    setFamilyProfiles([family]);
    setSelectedFamilyId(family.id);
  }
  return family;
}

async function createMemberForCurrentFamily(input: { name: string; relationLabel: string; setAsCore?: boolean }) {
  const family = await ensureFamilyBeforeSave();
  const payload = await createFamilyMember({
    token: token || undefined,
    guestId: token ? undefined : guestId,
    familyId: family.id,
    name: input.name,
    relationLabel: input.relationLabel,
    setAsCore: input.setAsCore,
  });
  await refreshFamilyProfiles();
  return payload.member;
}
```

- [ ] **Step 6: Pass family props into `UploadPolicyPage`**

Extend `UploadPolicyPage` props:

```ts
familyProfiles: FamilyProfile[];
selectedFamilyId: number | null;
selectedFamilyMembers: FamilyMember[];
onSelectFamily: (familyId: number) => void;
onCreateFamily: (familyName: string) => Promise<void>;
onCreateFamilyMember: (input: { name: string; relationLabel: string; setAsCore?: boolean }) => Promise<FamilyMember>;
```

Pass from `CustomerApp`.

- [ ] **Step 7: Render minimal family controls**

Inside `UploadPolicyPage`, before the OCR card:

```tsx
<section className="rounded-2xl border border-slate-200 bg-white p-4">
  <div className="flex items-center justify-between gap-3">
    <div>
      <h2 className="text-sm font-black text-slate-900">家庭档案</h2>
      <p className="mt-1 text-xs font-semibold text-slate-500">录入保单前先确认家庭，报告只统计这个家庭的数据</p>
    </div>
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100"
      onClick={() => {
        const familyName = window.prompt('请输入家庭名称', '默认家庭');
        if (familyName?.trim()) void onCreateFamily(familyName.trim());
      }}
    >
      <Plus size={14} />
      新建家庭档案
    </button>
  </div>
  <select
    className="mt-3 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm font-bold text-slate-800"
    value={selectedFamilyId || ''}
    onChange={(event) => onSelectFamily(Number(event.target.value))}
  >
    <option value="">请选择家庭档案</option>
    {familyProfiles.map((family) => (
      <option key={family.id} value={family.id}>{family.familyName}</option>
    ))}
  </select>
  {selectedFamilyId && !familyProfiles.find((family) => Number(family.id) === Number(selectedFamilyId))?.coreMemberId ? (
    <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-3 text-xs font-semibold text-amber-800">
      <p className="font-black">请设置家庭关系中心</p>
      <p className="mt-1">OCR 识别后，可从投保人或被保险人中选择“以谁作为家庭关系基准”。</p>
    </div>
  ) : null}
</section>
```

- [ ] **Step 8: Add family member selection controls**

Replace the simple applicant/insured text fields with select-plus-add controls:

```tsx
<FamilyParticipantPicker
  label="投保人"
  textValue={formData.applicant}
  memberId={formData.applicantMemberId || null}
  members={selectedFamilyMembers}
  onTextChange={(value) => onUpdateForm('applicant', value)}
  onMemberChange={(memberId) => onUpdateForm('applicantMemberId', String(memberId))}
  onCreateMember={(relationLabel, setAsCore) => onCreateFamilyMember({ name: formData.applicant, relationLabel, setAsCore })} />
<FamilyParticipantPicker
  label="被保险人"
  textValue={formData.insured}
  memberId={formData.insuredMemberId || null}
  members={selectedFamilyMembers}
  onTextChange={(value) => onUpdateForm('insured', value)}
  onMemberChange={(memberId) => onUpdateForm('insuredMemberId', String(memberId))}
  onCreateMember={(relationLabel, setAsCore) => onCreateFamilyMember({ name: formData.insured, relationLabel, setAsCore })} />
```

Add `FamilyParticipantPicker` before `UploadPolicyPage`:

```tsx
function FamilyParticipantPicker(props: {
  label: string;
  textValue: string;
  memberId: number | null;
  members: FamilyMember[];
  onTextChange: (value: string) => void;
  onMemberChange: (memberId: number) => void;
  onCreateMember: (relationLabel: string, setAsCore: boolean) => Promise<FamilyMember>;
}) {
  const [relationLabel, setRelationLabel] = useState('待确认');
  const canCreate = props.textValue.trim().length > 0;
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <TextField label={props.label} value={props.textValue} onChange={props.onTextChange} placeholder="姓名" />
      <select
        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800"
        value={props.memberId || ''}
        onChange={(event) => props.onMemberChange(Number(event.target.value))}
      >
        <option value="">选择家庭成员</option>
        {props.members.map((member) => (
          <option key={member.id} value={member.id}>{member.name}｜{member.relationLabel}</option>
        ))}
      </select>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-800">
          {['本人', '配偶', '儿子', '女儿', '父亲', '母亲', '其他', '待确认'].map((option) => <option key={option}>{option}</option>)}
        </select>
        <button
          type="button"
          disabled={!canCreate}
          className="rounded-xl bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100 disabled:opacity-40"
          onClick={() => void props.onCreateMember(relationLabel, relationLabel === '本人')}
        >
          新增为家庭成员
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Save family IDs with policy form data**

Before `scanPolicy()` in `handleSubmit()`:

```ts
const family = await ensureFamilyBeforeSave();
const applicantMember = formData.applicantMemberId
  ? selectedFamilyMembers.find((member) => Number(member.id) === Number(formData.applicantMemberId))
  : findFamilyMemberByName(formData.applicant) || await createMemberForCurrentFamily({ name: formData.applicant, relationLabel: family.coreMemberId ? '待确认' : '本人', setAsCore: !family.coreMemberId });
const insuredMember = formData.insuredMemberId
  ? selectedFamilyMembers.find((member) => Number(member.id) === Number(formData.insuredMemberId))
  : findFamilyMemberByName(formData.insured) || await createMemberForCurrentFamily({ name: formData.insured, relationLabel: '待确认' });
if (!applicantMember || !insuredMember) {
  setMessage('请先确认投保人和被保险人的家庭成员身份');
  return;
}
```

Pass:

```ts
manualData: {
  ...formData,
  familyId: family.id,
  applicantMemberId: applicantMember.id,
  insuredMemberId: insuredMember.id,
},
```

- [ ] **Step 10: Run UI and type checks**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile and supports core"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit minimal entry interaction**

```bash
git add src/App.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: add family selection to policy entry"
```

## Task 5: Family-Aware Report Grouping

**Files:**
- Modify: `src/family-report-engine.mjs`
- Modify: `src/family-report-engine.d.mts`
- Modify: `src/FamilyReport.tsx`
- Test: `tests/family-report-engine.test.mjs`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add report engine tests**

Append to `tests/family-report-engine.test.mjs`:

```js
test('buildFamilyReport groups members by insuredMemberId when available', () => {
  const report = buildFamilyReport([
    makePolicy({ id: 1, familyId: 10, insured: '小明', insuredMemberId: 101, insuredMemberName: '王小明', insuredRelationLabel: '儿子', applicant: '张三', applicantMemberName: '张三', applicantRelationLabel: '本人', amount: 100000 }),
    makePolicy({ id: 2, familyId: 10, insured: '小明 OCR 错字', insuredMemberId: 101, insuredMemberName: '王小明', insuredRelationLabel: '儿子', applicant: '张三', applicantMemberName: '张三', applicantRelationLabel: '本人', amount: 200000 }),
  ]);

  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.insuredGroups.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].member, '王小明');
  assert.equal(report.policyInventory.insuredGroups[0].relationLabel, '儿子');
  assert.equal(report.policyInventory.insuredGroups[0].policies.length, 2);
});

test('buildFamilyReport can filter by selected family id', () => {
  const report = buildFamilyReport([
    makePolicy({ id: 1, familyId: 10, insured: '张三', insuredMemberId: 101, insuredMemberName: '张三', amount: 100000 }),
    makePolicy({ id: 2, familyId: 20, insured: '李四', insuredMemberId: 201, insuredMemberName: '李四', amount: 200000 }),
  ], null, { familyId: 10 });

  assert.equal(report.summary.policyCount, 1);
  assert.equal(report.summary.totalCoverage, 100000);
});
```

- [ ] **Step 2: Run report tests and verify they fail**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="insuredMemberId|selected family id"
```

Expected: FAIL because grouping still uses raw `insured` names.

- [ ] **Step 3: Add member identity helpers**

Modify `src/family-report-engine.mjs` near `memberName()`:

```js
function memberId(policy) {
  const id = Number(policy?.insuredMemberId || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function memberKey(policy) {
  return memberId(policy) ? `member:${memberId(policy)}` : `name:${memberName(policy)}`;
}

function memberName(policy) {
  const linkedName = String(policy?.insuredMemberName || '').trim();
  if (linkedName) return linkedName;
  const name = String(policy?.insured || '').trim();
  return name || '未识别被保人';
}

function memberRelationLabel(policy) {
  return String(policy?.insuredRelationLabel || '').trim();
}

function reportPoliciesForFamily(policies = [], options = {}) {
  const familyId = Number(options?.familyId || 0);
  if (!familyId) return policies;
  return policies.filter((policy) => Number(policy?.familyId || 0) === familyId);
}
```

- [ ] **Step 4: Replace member grouping keys**

In `buildCriticalIllnessSection()`, `buildAccidentSection()`, `buildWealthSection()`, `buildPolicyInventory()`, and radar member grouping, use `memberKey(policy)` as the map key and store:

```js
{
  member: memberName(policy),
  memberId: memberId(policy),
  relationLabel: memberRelationLabel(policy),
}
```

For map initialization in inventory:

```js
const key = row.memberKey || row.member;
```

- [ ] **Step 5: Filter selected family in `buildFamilyReport()`**

Change export signature:

```js
export function buildFamilyReport(policies = [], planningProfile = null, options = {}) {
  const reportPolicies = reportPoliciesForFamily(policies, options);
  return {
    summary: buildFamilyReportSummary(reportPolicies),
    policyInventory: buildPolicyInventory(reportPolicies),
    criticalIllness: buildCriticalIllnessSection(reportPolicies),
    accident: buildAccidentSection(reportPolicies),
    wealth: buildWealthSection(reportPolicies),
    radar: buildFamilyRadarReport(reportPolicies, planningProfile),
    optionalResponsibilityGaps: buildOptionalResponsibilityGaps(reportPolicies),
    appendix: buildFamilyAppendix(reportPolicies),
  };
}
```

- [ ] **Step 6: Update types**

Modify `src/family-report-engine.d.mts`:

```ts
export type FamilyPolicyInventoryRow = {
  policyId: number;
  memberKey?: string;
  memberId?: number | null;
  member: string;
  relationLabel?: string;
  applicant?: string;
  applicantMemberId?: number | null;
  applicantRelationLabel?: string;
  participantReviewStatus?: string;
  // keep existing fields
};

export type FamilyInsuredPolicyGroup = {
  memberKey?: string;
  memberId?: number | null;
  member: string;
  relationLabel?: string;
  policies: FamilyPolicyInventoryRow[];
  annualPremium: number;
  totalCoverage: number;
  cashValueTotal: number;
  futurePayoutTotal: number;
};

export function buildFamilyReport(policies: Policy[], planningProfile?: FamilyPlanningProfile | null, options?: { familyId?: number | null }): FamilyReport;
```

- [ ] **Step 7: Display relation labels in family report UI**

Modify `src/FamilyReport.tsx` in inventory and section headings:

```tsx
<h3 className="font-black">
  {group.member}
  {group.relationLabel ? <span className="ml-2 text-xs font-black text-slate-400">｜{group.relationLabel}</span> : null}
</h3>
```

Add columns in `FamilyPolicyInventoryTable`:

```tsx
{['投保人', '被保人', '家庭身份', '保单/产品', '类型', '年交保费', '保障/保额', '现金价值', '数据状态'].map(...)}
```

Render `row.applicant`, `row.member`, `row.relationLabel || '-'`, and show `姓名待核对` when `row.participantReviewStatus === 'name_mismatch'`.

- [ ] **Step 8: Add UI source tests**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('family report displays household identity and participant review status', () => {
  const reportSource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(reportSource, /家庭身份/);
  assert.match(reportSource, /投保人/);
  assert.match(reportSource, /姓名待核对/);
  assert.match(reportSource, /relationLabel/);
});
```

- [ ] **Step 9: Run report tests**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="insuredMemberId|selected family id"
node --test tests/customer-ui-style.test.mjs --test-name-pattern="household identity"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit report grouping**

```bash
git add src/family-report-engine.mjs src/family-report-engine.d.mts src/FamilyReport.tsx tests/family-report-engine.test.mjs tests/customer-ui-style.test.mjs
git commit -m "feat: group family reports by member id"
```

## Task 6: Family Management UI

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add source test for family management**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('customer app exposes family profile management surface', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  assert.match(customerSource, /FamilyProfileManager/);
  assert.match(customerSource, /家庭档案列表/);
  assert.match(customerSource, /成员数/);
  assert.match(customerSource, /查看报告/);
  assert.match(customerSource, /编辑家庭/);
  assert.match(customerSource, /录入保单/);
});
```

- [ ] **Step 2: Run source test and verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile management"
```

Expected: FAIL because the management surface is missing.

- [ ] **Step 3: Add customer tab**

Change:

```ts
type CustomerTab = 'entry' | 'policies' | 'families';
```

Add a bottom/header action to switch to `families`.

- [ ] **Step 4: Add `FamilyProfileManager` component**

Add before `UploadPolicyPage`:

```tsx
function FamilyProfileManager(props: {
  familyProfiles: FamilyProfile[];
  selectedFamilyId: number | null;
  onSelectFamily: (familyId: number) => void;
  onCreateFamily: (familyName: string) => Promise<void>;
  onBackToEntry: () => void;
  onOpenReport: (familyId: number) => void;
}) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-4">
        <h1 className="text-lg font-black text-slate-900">家庭档案列表</h1>
        <button type="button" className="rounded-full bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100" onClick={() => {
          const name = window.prompt('请输入家庭名称', '默认家庭');
          if (name?.trim()) void props.onCreateFamily(name.trim());
        }}>新建家庭档案</button>
      </header>
      <main className="mx-auto max-w-3xl space-y-3 p-4">
        {props.familyProfiles.map((family) => {
          const members = family.members || [];
          const core = members.find((member) => Number(member.id) === Number(family.coreMemberId));
          return (
            <article key={family.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-black text-slate-900">{family.familyName}</h2>
                  <p className="mt-1 text-xs font-semibold text-slate-500">核心人员：{core?.name || '待设置'} · 成员数：{members.filter((member) => member.status !== 'archived').length}</p>
                </div>
                <span className="rounded-full bg-slate-50 px-2 py-1 text-[11px] font-black text-slate-500">{Number(family.id) === Number(props.selectedFamilyId) ? '当前家庭' : '可切换'}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white" onClick={() => props.onOpenReport(family.id)}>查看报告</button>
                <button type="button" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-700" onClick={() => props.onSelectFamily(family.id)}>编辑家庭</button>
                <button type="button" className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 ring-1 ring-emerald-100" onClick={() => { props.onSelectFamily(family.id); props.onBackToEntry(); }}>录入保单</button>
              </div>
            </article>
          );
        })}
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Render manager from `CustomerApp`**

Before normal entry render:

```tsx
if (activeTab === 'families') {
  return (
    <FamilyProfileManager
      familyProfiles={familyProfiles}
      selectedFamilyId={selectedFamilyId}
      onSelectFamily={setSelectedFamilyId}
      onCreateFamily={async (familyName) => {
        await createFamilyProfile({ token: token || undefined, guestId: token ? undefined : guestId, familyName });
        await refreshFamilyProfiles();
      }}
      onBackToEntry={() => setActiveTab('entry')}
      onOpenReport={(familyId) => {
        setSelectedFamilyId(familyId);
        setShowFamilyReport(true);
      }}
    />
  );
}
```

- [ ] **Step 6: Run UI test**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile management"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit family management UI**

```bash
git add src/App.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: add family profile management"
```

## Task 7: Share Scope and Final Verification

**Files:**
- Modify: `server/app.mjs`
- Modify: `src/api.ts`
- Modify: `src/App.tsx`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add share API tests**

Append to `tests/policy-ocr-flow.test.mjs`:

```js
test('family report share snapshots only include selected family policies', async () => {
  const state = createInitialState();
  state.familyProfiles = [
    { id: 1, ownerGuestId: 'guest-share', familyName: 'A家庭', coreMemberId: 10, status: 'active', createdAt: '', updatedAt: '' },
    { id: 2, ownerGuestId: 'guest-share', familyName: 'B家庭', coreMemberId: 20, status: 'active', createdAt: '', updatedAt: '' },
  ];
  state.familyMembers = [
    { id: 10, familyId: 1, name: '张三', relationLabel: '本人', relationToCore: 'self', role: 'core', status: 'active' },
    { id: 20, familyId: 2, name: '李四', relationLabel: '本人', relationToCore: 'self', role: 'core', status: 'active' },
  ];
  state.policies = [
    { id: 1, guestId: 'guest-share', familyId: 1, applicantMemberId: 10, insuredMemberId: 10, company: '新华保险', name: 'A保单', insured: '张三', amount: 100000, firstPremium: 1000, createdAt: '2026-05-01T00:00:00.000Z' },
    { id: 2, guestId: 'guest-share', familyId: 2, applicantMemberId: 20, insuredMemberId: 20, company: '平安人寿', name: 'B保单', insured: '李四', amount: 200000, firstPremium: 2000, createdAt: '2026-05-01T00:00:00.000Z' },
  ];
  const app = createPolicyOcrApp({ state, persist: async () => {} });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/family-profiles/1/share?guestId=guest-share', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(created.response.status, 201);
    const fetched = await jsonFetch(server.baseUrl, `/api/family-report-shares/${created.payload.share.token}`);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.payload.family.familyName, 'A家庭');
    assert.equal(fetched.payload.policies.length, 1);
    assert.equal(fetched.payload.policies[0].name, 'A保单');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run share test and verify it fails**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern="share snapshots"
```

Expected: FAIL because share routes do not exist.

- [ ] **Step 3: Add share routes**

In `server/app.mjs`, import `crypto` is already available. Add:

```js
app.post('/api/family-profiles/:id/share', async (req, res) => {
  try {
    const user = resolveAuthUser(req, state);
    const owner = requestOwner(req, user);
    const family = (state.familyProfiles || []).find((row) => Number(row.id) === Number(req.params.id));
    if (!family || !familyOwnerMatches(family, owner)) return res.status(404).json({ ok: false, code: 'FAMILY_NOT_FOUND', message: '家庭档案不存在' });
    const token = crypto.randomUUID().replace(/-/g, '');
    const policies = (state.policies || []).filter((policy) => Number(policy.familyId) === Number(family.id));
    const members = listFamilyMembers(state, family.id, { includeArchived: true });
    const now = new Date().toISOString();
    const share = {
      id: allocateId(state),
      token,
      familyId: family.id,
      createdAt: now,
      payload: { family, members, policies, snapshotAt: now },
    };
    if (!Array.isArray(state.familyReportShares)) state.familyReportShares = [];
    state.familyReportShares.push(share);
    await persist(state);
    res.status(201).json({ ok: true, share: { id: share.id, token, familyId: family.id, createdAt: now } });
  } catch (error) {
    sendError(res, error, 400);
  }
});

app.get('/api/family-report-shares/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  const share = (state.familyReportShares || []).find((row) => String(row.token || '') === token);
  if (!share) return res.status(404).json({ ok: false, code: 'SHARE_NOT_FOUND', message: '分享报告不存在' });
  res.json({ ok: true, ...share.payload });
});
```

- [ ] **Step 4: Add share client APIs**

In `src/api.ts`:

```ts
export function createFamilyReportShare(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; share: { id: number; token: string; familyId: number; createdAt: string } }>(
    `/api/family-profiles/${input.familyId}/share${authQuery(input)}`,
    { token: input.token, body: {} },
  );
}

export function getFamilyReportShare(shareToken: string) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[]; policies: Policy[]; snapshotAt: string }>(
    `/api/family-report-shares/${encodeURIComponent(shareToken)}`,
  );
}
```

- [ ] **Step 5: Add share UI source test**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('family report share flow is scoped to selected family', () => {
  const customerSource = componentSource('CustomerApp', 'CashflowAnnualTable');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /createFamilyReportShare/);
  assert.match(apiSource, /getFamilyReportShare/);
  assert.match(customerSource, /handleShareFamilyReport/);
  assert.match(customerSource, /selectedFamilyId/);
  assert.match(customerSource, /navigator\.clipboard\.writeText/);
});
```

- [ ] **Step 6: Add share action in `CustomerApp`**

Import `createFamilyReportShare`. Add:

```ts
async function handleShareFamilyReport() {
  if (!selectedFamilyId) {
    setMessage('请先选择家庭档案');
    return;
  }
  try {
    const payload = await createFamilyReportShare({ token: token || undefined, guestId: token ? undefined : guestId, familyId: selectedFamilyId });
    const url = `${window.location.origin}${window.location.pathname}#/family-share/${payload.share.token}`;
    await navigator.clipboard.writeText(url);
    setMessage('家庭报告分享链接已复制');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '分享失败，请稍后重试');
  }
}
```

Modify `src/FamilyReport.tsx` `FamilyReportPageProps`:

```ts
type FamilyReportPageProps = {
  report: FamilyReport;
  planningProfile: FamilyPlanningProfile;
  onPlanningProfileChange: (profile: FamilyPlanningProfile) => void;
  onBack: () => void;
  onExport: (target: HTMLElement | null, title: string) => void | Promise<void>;
  onShare: () => void | Promise<void>;
};
```

Add a share button next to the existing export button:

```tsx
<button
  type="button"
  onClick={() => void onShare()}
  className="family-report-action inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-3 text-xs font-black text-[#0B72B9] ring-1 ring-[#D7E5F2]"
>
  <SendHorizontal size={16} />
  分享报告
</button>
```

Pass `onShare={handleShareFamilyReport}` from `CustomerApp` when rendering `FamilyReportPage`.

- [ ] **Step 7: Ensure selected family is used when building report**

Change:

```ts
const familyReport = useMemo(
  () => buildFamilyReport(policies, familyPlanningProfile, { familyId: selectedFamilyId }),
  [policies, familyPlanningProfile, selectedFamilyId],
);
```

- [ ] **Step 8: Run final targeted tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern="family APIs|different families|share snapshots"
node --test tests/family-profile-domain.test.mjs
node --test tests/family-report-engine.test.mjs --test-name-pattern="insuredMemberId|selected family id"
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family profile|household identity|share flow"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Run broad validation**

Run:

```bash
npm run check
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit sharing and validation**

```bash
git add server/app.mjs src/api.ts src/App.tsx tests/policy-ocr-flow.test.mjs tests/customer-ui-style.test.mjs
git commit -m "feat: share family scoped reports"
```

## Self-Review

- Spec coverage: The plan covers family profiles, member IDs, one-policy-one-family validation, lightweight family creation, core-person setup during policy entry, old-data default-family migration, report grouping by `insuredMemberId`, family profile management, sharing, export scope, and tests.
- Placeholder scan: No `TBD`, `TODO`, or vague implementation markers remain.
- Type consistency: The plan uses `FamilyProfile`, `FamilyMember`, `familyId`, `applicantMemberId`, `insuredMemberId`, `coreMemberId`, `relationToCore`, and `relationLabel` consistently across server, client, report engine, and tests.
- Scope control: The plan avoids building a full relationship graph, hard delete, cross-family natural-person reuse, product recommendation, or editable share pages.
