import { PERMISSIONS, type Permission, type PermissionGrants } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { queryClient, useAuth } from '../../app/api';
import { ReasonDialog, RequestError } from './StaffControls';

export function PermissionSettings() {
  const auth = useAuth();
  const [draft, setDraft] = useState<PermissionGrants | null>(null);
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ['staff', 'permissions', auth.user?.id, auth.epoch.current],
    queryFn: ({ signal }) =>
      auth.request<PermissionGrants>('/api/v1/admin/permissions', { signal }),
  });
  const grants = draft ?? query.data;
  function toggle(group: 'admin' | 'moderator', permission: Permission, checked: boolean) {
    if (grants)
      setDraft({
        ...grants,
        [group]: checked
          ? [...grants[group], permission]
          : grants[group].filter((item) => item !== permission),
      });
  }
  return (
    <section className="content-management">
      <header className="management-heading">
        <h1>职务权限</h1>
        <p>仅 Owner 可配置固定职务组。成员有效权限为所任职务的并集，Owner 始终具备全部权限。</p>
      </header>
      <RequestError error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <p role="status">正在加载权限…</p>}
      {grants && (
        <>
          {(['admin', 'moderator'] as const).map((group) => (
            <section className="settings-card" key={group}>
              <h2>{group === 'admin' ? 'Administrator · 站点管理' : 'Moderator · 内容管理'}</h2>
              <div className="staff-fields">
                {PERMISSIONS.filter(
                  (permission) => permission.group === group || permission.id === 'audit.read',
                ).map((permission) => (
                  <label key={permission.id}>
                    <input
                      type="checkbox"
                      checked={grants[group].includes(permission.id)}
                      onChange={(event) => toggle(group, permission.id, event.target.checked)}
                    />{' '}
                    {permission.label}
                    {permission.id === 'content.restricted' && (
                      <span className="settings-hint">
                        敏感权限：默认关闭；允许越过作者可见范围查看受限内容，请谨慎授予。
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </section>
          ))}
          <button
            type="button"
            className="primary"
            disabled={!draft}
            onClick={() => setConfirm(true)}
          >
            保存职务权限
          </button>
        </>
      )}
      {confirm && grants && (
        <ReasonDialog
          title="修改固定职务权限"
          onClose={() => setConfirm(false)}
          onSubmit={async (reason) => {
            await auth.request('/api/v1/admin/permissions', {
              method: 'PUT',
              json: { ...grants, reason },
            });
            setDraft(null);
            await queryClient.invalidateQueries({ queryKey: ['staff', 'permissions'] });
            await auth.refresh({ silent: true });
          }}
        >
          <p>修改会立即影响该职务的所有成员，未勾选的权限将被撤销。</p>
        </ReasonDialog>
      )}
    </section>
  );
}
