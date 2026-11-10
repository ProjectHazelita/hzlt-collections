import { hasPermission, type ManagedUser, type Profile, type ProfileField } from '@hcl/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { queryClient, useAuth } from '../../app/api';
import { ReasonDialog, RequestError, useStaffList } from './StaffControls';

export const profileLabels: Record<ProfileField, string> = {
  displayName: '昵称',
  avatar: '头像',
  bio: '个性签名',
  pronouns: '代词',
  email: '邮箱',
  location: '所在地',
  socialLinks: '社交链接',
};
type Action = {
  person: ManagedUser;
  kind: 'roles' | 'ban' | 'profile';
  field?: ProfileField;
  hidden?: boolean;
};

export function UserManagement() {
  const auth = useAuth();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [roles, setRoles] = useState({ isAdmin: false, isModerator: false });
  const [original, setOriginal] = useState<Profile | null>(null);
  const [originalError, setOriginalError] = useState<unknown>(null);
  const list = useStaffList<ManagedUser>('users', `/api/v1/admin/users?q=${encodeURIComponent(q)}`);
  const owner = auth.user?.role === 'owner';
  return (
    <section className="content-management">
      <header className="management-heading">
        <h1>用户管理</h1>
        <p>管理独立、可组合的职务和公开资料限制。隐藏不会改写用户原始资料。</p>
      </header>
      <form
        className="staff-search"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(search.trim());
        }}
      >
        <label>
          搜索用户
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="用户名或昵称"
          />
        </label>
        <button type="submit" className="secondary">
          搜索
        </button>
      </form>
      <RequestError error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <p role="status">正在加载用户…</p>}
      {list.data?.pages
        .flatMap((page) => page.items)
        .map((person) => {
          const user = person.user;
          const self = user.id === auth.user?.id;
          const protectedOwner = user.role === 'owner' && !owner;
          const canBan =
            hasPermission(auth.user, 'users.ban') &&
            !self &&
            user.role !== 'owner' &&
            (owner || (!user.isAdmin && !user.isModerator));
          return (
            <section className="settings-card" key={user.id}>
              <div className="staff-row">
                <div>
                  <h2>
                    <Link to={`/users/${encodeURIComponent(user.username)}`}>
                      {user.displayName}
                    </Link>{' '}
                    <small>@{user.username}</small>
                  </h2>
                  <p>
                    {user.role === 'owner'
                      ? 'Owner'
                      : [user.isAdmin && 'Administrator', user.isModerator && 'Moderator']
                          .filter(Boolean)
                          .join(' + ') || '普通成员'}{' '}
                    · {person.banned ? '已封禁' : '正常'}
                  </p>
                  {person.banReason && <p>封禁原因：{person.banReason}</p>}
                </div>
                <div className="staff-actions">
                  {owner && user.role !== 'owner' && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => {
                        setRoles({ isAdmin: user.isAdmin, isModerator: user.isModerator });
                        setAction({ person, kind: 'roles' });
                      }}
                    >
                      任免职务
                    </button>
                  )}
                  {canBan && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setAction({ person, kind: 'ban' })}
                    >
                      {person.banned ? '解除封禁' : '封禁账号'}
                    </button>
                  )}
                  {owner && (
                    <button
                      className="secondary"
                      type="button"
                      onClick={async () => {
                        setOriginal(null);
                        setOriginalError(null);
                        try {
                          setOriginal(
                            await auth.request<Profile>(`/api/v1/admin/users/${user.id}/profile`),
                          );
                        } catch (cause) {
                          setOriginalError(cause);
                        }
                      }}
                    >
                      查看原始资料
                    </button>
                  )}
                </div>
              </div>
              {hasPermission(auth.user, 'users.profile') && !protectedOwner && (
                <div className="staff-fields">
                  {(Object.keys(profileLabels) as ProfileField[]).map((field) => {
                    const hidden = person.hiddenFields.includes(field);
                    return (
                      <div className="staff-row" key={field}>
                        <span>
                          {profileLabels[field]}：{hidden ? '已隐藏' : '正常'}
                        </span>
                        <button
                          className="secondary"
                          type="button"
                          disabled={self && hidden}
                          onClick={() =>
                            setAction({ person, kind: 'profile', field, hidden: !hidden })
                          }
                        >
                          {hidden ? '恢复公开' : '隐藏'}
                        </button>
                      </div>
                    );
                  })}
                  {self && <p className="settings-hint">不能自行恢复自己的资料限制。</p>}
                </div>
              )}
            </section>
          );
        })}
      {list.data && !list.data.pages.some((page) => page.items.length) && <p>没有匹配的用户。</p>}
      {list.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          加载更多用户
        </button>
      )}
      <RequestError error={originalError} />
      {original && (
        <section className="settings-card">
          <h2>原始资料（只读）</h2>
          {original.avatarAssetId && (
            <img
              className="staff-avatar"
              src={`/media/${original.avatarAssetId}/avatar`}
              alt="原始头像"
            />
          )}
          <dl>
            {(Object.keys(profileLabels) as ProfileField[])
              .filter((field) => field !== 'avatar')
              .map((field) => (
                <div key={field}>
                  <dt>{profileLabels[field]}</dt>
                  <dd>
                    {field === 'socialLinks'
                      ? original.socialLinks.map((link) => `${link.label}: ${link.url}`).join('、')
                      : String(original[field] || '未填写')}
                  </dd>
                </div>
              ))}
          </dl>
          <button type="button" className="secondary" onClick={() => setOriginal(null)}>
            关闭原始资料
          </button>
        </section>
      )}
      {action && (
        <ReasonDialog
          title={`${action.kind === 'roles' ? '任免职务' : action.kind === 'ban' ? (action.person.banned ? '解除封禁' : '封禁账号') : `${action.hidden ? '隐藏' : '恢复'}${profileLabels[action.field!]}`} · @${action.person.user.username}`}
          onClose={() => setAction(null)}
          onSubmit={async (reason) => {
            const suffix = action.kind === 'profile' ? 'profile-moderation' : action.kind;
            const json =
              action.kind === 'roles'
                ? { ...roles, reason }
                : action.kind === 'ban'
                  ? { banned: !action.person.banned, reason }
                  : { field: action.field, hidden: action.hidden, reason };
            await auth.request(`/api/v1/admin/users/${action.person.user.id}/${suffix}`, {
              method: 'PATCH',
              json,
            });
            await queryClient.invalidateQueries({ queryKey: ['staff', 'users'] });
            await auth.refresh({ silent: true });
          }}
        >
          {action.kind === 'roles' && (
            <div className="staff-fields">
              <label>
                <input
                  type="checkbox"
                  checked={roles.isAdmin}
                  onChange={(event) => setRoles({ ...roles, isAdmin: event.target.checked })}
                />{' '}
                Administrator（站点管理）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={roles.isModerator}
                  onChange={(event) => setRoles({ ...roles, isModerator: event.target.checked })}
                />{' '}
                Moderator（内容管理）
              </label>
              <p>两种职务可独立指派或同时拥有；没有逐用户权限覆盖。</p>
            </div>
          )}
        </ReasonDialog>
      )}
    </section>
  );
}
