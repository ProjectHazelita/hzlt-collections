import { hasPermission } from '@hcl/contracts';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../../app/api';
import './settings.css';

export function SettingsLayout() {
  const { user } = useAuth();
  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <header className="settings-heading">
        <h1 id="settings-title">设置</h1>
        <p>管理公开资料、登录安全与站点内容。</p>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分区">
          <p className="settings-nav-group">账号</p>
          <NavLink to="/settings/profile">个人资料</NavLink>
          {(['site.brand', 'site.registration'] as const).some((permission) =>
            hasPermission(user, permission),
          ) && (
            <>
              <p className="settings-nav-group">站点</p>
              <NavLink to="/settings/site">站点设置</NavLink>
            </>
          )}
          {(['users.manage', 'users.ban', 'users.profile'] as const).some((permission) =>
            hasPermission(user, permission),
          ) && (
            <>
              <p className="settings-nav-group">人员</p>
              <NavLink to="/settings/users">用户管理与任免</NavLink>
            </>
          )}
          {user?.role === 'owner' && <NavLink to="/settings/permissions">职务权限</NavLink>}
          {(['content.moderate', 'content.delete'] as const).some((permission) =>
            hasPermission(user, permission),
          ) && (
            <>
              <p className="settings-nav-group">内容</p>
              <NavLink to="/settings/content">内容管理</NavLink>
            </>
          )}
          {hasPermission(user, 'audit.read') && (
            <>
              <p className="settings-nav-group">监督</p>
              <NavLink to="/settings/audit">审计日志</NavLink>
            </>
          )}
        </nav>
        <div className="settings-content">
          <Outlet />
        </div>
      </div>
    </section>
  );
}
