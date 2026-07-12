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
  onReview,
}: {
  records: KnowledgeRecord[];
  form: KnowledgeCrawlForm;
  loading: boolean;
  crawling: boolean;
  onChange: (form: KnowledgeCrawlForm) => void;
  onRefresh: () => void;
  onCrawl: () => void;
  onReview: (record: KnowledgeRecord, action: 'approved' | 'rejected') => void;
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
        onReview={onReview}
      />
    </div>
  );
}
