import type { ReactNode } from 'react';
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
  children: ReactNode;
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
        <aside className="sticky top-0 h-screen overflow-y-auto bg-blue-950 px-4 py-5 text-white max-[900px]:px-2">
          <div className="mb-8 flex items-center gap-3 px-2">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <span className="text-sm font-black">P</span>
            </div>
            <div className="min-w-0 max-[900px]:hidden">
              <p className="text-base font-black leading-tight">运营后台</p>
              <p className="mt-1 text-xs font-bold text-blue-200">保单 OCR 管理台</p>
            </div>
          </div>

          <nav className="space-y-5">
            {ADMIN_PAGE_GROUPS.map((group) => (
              <div key={group.group}>
                <p className="mb-2 px-2 text-xs font-black text-blue-200 max-[900px]:sr-only">{group.group}</p>
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
                          active ? 'bg-blue-50 text-blue-700 shadow-sm' : 'text-blue-200/75 hover:bg-blue-900/70 hover:text-white',
                        ].join(' ')}
                        title={item.label}
                      >
                        <Icon size={18} />
                        <span className="min-w-0 flex-1 truncate max-[900px]:sr-only">{item.label}</span>
                        {badge ? (
                          <span className={active ? 'rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700 max-[900px]:hidden' : 'rounded-full bg-blue-900 px-2 py-0.5 text-xs text-blue-100 max-[900px]:hidden'}>
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
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-blue-300" />
                  <input
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                    placeholder={`搜索${page.label}`}
                    className="h-10 w-full rounded-xl border border-blue-100 bg-blue-50/50 pl-10 pr-3 text-sm font-semibold outline-none transition focus:border-blue-400 focus:bg-white"
                  />
                </label>
                <button
                  type="button"
                  className="flex h-10 items-center gap-2 rounded-xl border border-blue-100 bg-white px-3 text-sm font-black text-blue-700 shadow-sm transition hover:border-blue-300 hover:bg-blue-50"
                  onClick={onRefresh}
                >
                  <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                  <span className="max-[900px]:sr-only">刷新</span>
                </button>
                <button
                  type="button"
                  className="flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-black text-white shadow-[0_14px_36px_-24px_rgba(37,99,235,0.75)] transition hover:bg-blue-700"
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
