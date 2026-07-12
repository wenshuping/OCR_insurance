export function AdminPagination({
  page,
  pageCount,
  totalItems,
  startIndex,
  endIndex,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  totalItems: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-blue-50 pt-3 text-xs font-black text-slate-500">
      <span>{totalItems ? `${startIndex + 1}-${endIndex} / ${totalItems} 条` : '0 条'}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-full border border-blue-100 bg-white px-3 py-1.5 text-blue-700 transition hover:bg-blue-50 disabled:opacity-40"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </button>
        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-blue-700">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="rounded-full border border-blue-100 bg-white px-3 py-1.5 text-blue-700 transition hover:bg-blue-50 disabled:opacity-40"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
