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
