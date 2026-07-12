import type { AdminOfficialDomainProfile } from '../../../api';
import {
  AdminOfficialDomainPanel,
  type OfficialDomainForm,
} from '../../../features/admin-official-domain/AdminOfficialDomainPanel';

export function AdminOfficialDomainsPage({
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
  return (
    <div className="max-w-5xl">
      <AdminOfficialDomainPanel
        profiles={profiles}
        form={form}
        loading={loading}
        saving={saving}
        onChange={onChange}
        onEdit={onEdit}
        onReset={onReset}
        onRefresh={onRefresh}
        onSave={onSave}
        onDelete={onDelete}
      />
    </div>
  );
}
