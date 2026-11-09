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
          {user?.role === 'owner' && (
            <>
              <p className="settings-nav-group">站点</p>
              <NavLink to="/settings/content">站点管理</NavLink>
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
