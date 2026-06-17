import { useId, useMemo, useState } from 'react';
import { Shield } from 'lucide-react';

import type { AdminOfficialDomainProfile } from '../../api';
import { AdminPagination } from '../admin-shared/AdminPagination';
import { filterAdminList, getAdminPageWindow } from '../admin-shared/fuzzyList';

const OFFICIAL_DOMAIN_PAGE_SIZE = 8;
const OFFICIAL_DOMAIN_SUGGESTION_LIMIT = 10;

export type OfficialDomainForm = {
  id: string;
  company: string;
  aliasesText: string;
  siteDomainsText: string;
  officialDomainsText: string;
};

export const emptyOfficialDomainForm: OfficialDomainForm = {
  id: '',
  company: '',
  aliasesText: '',
  siteDomainsText: '',
  officialDomainsText: '',
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

export function profileToOfficialDomainForm(profile: AdminOfficialDomainProfile): OfficialDomainForm {
  return {
    id: profile.id,
    company: profile.company || '',
    aliasesText: listToText(profile.aliases || []),
    siteDomainsText: listToText(profile.siteDomains || []),
    officialDomainsText: listToText(profile.officialDomains || []),
  };
}

export function formToOfficialDomainPayload(form: OfficialDomainForm) {
  return {
    company: form.company,
    aliases: textToList(form.aliasesText),
    siteDomains: textToList(form.siteDomainsText),
    officialDomains: textToList(form.officialDomainsText),
  };
}

export function AdminOfficialDomainPanel({
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
  const searchListId = useId();
  const [query, setQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const customCount = profiles.filter((profile) => profile.source === 'custom').length;
  const filteredProfiles = useMemo(
    () => filterAdminList(profiles, query, getOfficialDomainSearchFields),
    [profiles, query],
  );
  const { page, pageCount, startIndex, endIndex } = getAdminPageWindow(filteredProfiles.length, requestedPage, OFFICIAL_DOMAIN_PAGE_SIZE);
  const pageProfiles = filteredProfiles.slice(startIndex, endIndex);
  const suggestions = filteredProfiles.slice(0, OFFICIAL_DOMAIN_SUGGESTION_LIMIT);

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
        <button className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-500" type="button" disabled={loading} onClick={onRefresh}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>

      {editing ? (
        <div className="space-y-2 rounded-[16px] border border-blue-100 bg-blue-50/50 p-3">
          <input
            className="h-10 w-full rounded-xl border border-blue-100 bg-white px-3 text-sm outline-none focus:border-blue-300"
            value={form.company}
            onChange={(event) => onChange({ ...form, company: event.target.value })}
            placeholder="保险公司名称"
          />
          <textarea
            className="min-h-[64px] w-full resize-none rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
            value={form.aliasesText}
            onChange={(event) => onChange({ ...form, aliasesText: event.target.value })}
            placeholder="别名，一行一个，例如：平安保险"
          />
          <textarea
            className="min-h-[72px] w-full resize-none rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
            value={form.officialDomainsText}
            onChange={(event) => onChange({ ...form, officialDomainsText: event.target.value })}
            placeholder="官方域名，一行一个，例如：life.pingan.com"
          />
          <textarea
            className="min-h-[56px] w-full resize-none rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
            value={form.siteDomainsText}
            onChange={(event) => onChange({ ...form, siteDomainsText: event.target.value })}
            placeholder="搜索域名，可留空，默认同官方域名"
          />
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          className={editing ? 'rounded-xl bg-blue-600 px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-60' : 'rounded-xl bg-blue-50 px-3 py-2 text-xs font-black text-blue-700 ring-1 ring-blue-100'}
          type="button"
          disabled={editing && (saving || !form.company.trim() || !form.officialDomainsText.trim())}
          onClick={() => {
            if (!editing) {
              onReset();
              setEditing(true);
              return;
            }
            onSave();
          }}
        >
          {editing ? (saving ? '保存中' : '保存白名单') : '新增白名单'}
        </button>
        {editing ? (
          <button
            className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-500"
            type="button"
            onClick={() => {
              onReset();
              setEditing(false);
            }}
          >
            取消
          </button>
        ) : (
          <span className="rounded-xl bg-slate-50 px-3 py-2 text-center text-xs font-black text-slate-400">点击列表可编辑</span>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{profiles.length} 条白名单</span>
        <span>{customCount} 条自定义</span>
      </div>
      <label className="mt-3 block">
        <span className="sr-only">搜索保险公司名称</span>
        <input
          type="search"
          list={searchListId}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setRequestedPage(1);
          }}
          placeholder="保险公司名称"
          className="h-11 w-full rounded-xl border border-blue-100 bg-blue-50/60 px-3 text-sm font-semibold outline-none transition focus:border-blue-400 focus:bg-white"
        />
        <datalist id={searchListId}>
          {suggestions.map((profile) => (
            <option key={profile.id} value={getOfficialDomainSuggestionLabel(profile)} />
          ))}
        </datalist>
      </label>
      <div className="mt-3 flex items-center justify-between text-xs font-black text-slate-400">
        <span>{filteredProfiles.length} / {profiles.length} 条匹配</span>
        <span>每页 {OFFICIAL_DOMAIN_PAGE_SIZE} 条</span>
      </div>
      <div className="mt-2 space-y-2">
        {pageProfiles.map((profile) => {
          const custom = profile.source === 'custom';
          return (
            <div key={profile.id} className="rounded-[16px] border border-slate-100 bg-slate-50 px-3 py-2.5 text-sm">
              <div className="flex items-start justify-between gap-2">
                <button className="min-w-0 text-left" type="button" onClick={() => {
                  onEdit(profile);
                  setEditing(true);
                }}>
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
        {profiles.length && !filteredProfiles.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-8 text-center text-sm font-bold text-slate-400">没有匹配的保险公司</p> : null}
        {!profiles.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无白名单配置</p> : null}
      </div>
      <AdminPagination
        page={page}
        pageCount={pageCount}
        totalItems={filteredProfiles.length}
        startIndex={startIndex}
        endIndex={endIndex}
        onPageChange={setRequestedPage}
      />
    </section>
  );
}

function getOfficialDomainSearchFields(profile: AdminOfficialDomainProfile) {
  return [
    profile.company,
    profile.aliases?.join(' '),
    profile.companyAliases?.join(' '),
  ];
}

function getOfficialDomainSuggestionLabel(profile: AdminOfficialDomainProfile) {
  return profile.company || profile.aliases?.[0] || profile.id;
}
