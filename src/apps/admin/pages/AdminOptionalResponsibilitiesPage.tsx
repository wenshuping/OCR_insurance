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
