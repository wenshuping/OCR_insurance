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
