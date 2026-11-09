import { FilePlusCorner, Heart, Home, Search, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Link,
  type Location,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import logo from '../assets/logo.svg';
import { UserAvatar } from '../components/UserAvatar';
import { ContentManagement } from '../features/admin/ContentManagement';
import { AuthForm } from '../features/auth/AuthForm';
import { EntryComposer } from '../features/composer/EntryComposer';
import { EntryDetail } from '../features/EntryDetail';
import { FeedPage } from '../features/FeedPage';
import { SettingsLayout } from '../features/settings/SettingsLayout';
import { SettingsProfile } from '../features/settings/SettingsProfile';
import { errorMessage, useAuth } from './api';

function SearchBar() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [value, setValue] = useState(params.get('q') ?? '');
  useEffect(() => {
    setValue(location.pathname === '/search' ? (params.get('q') ?? '') : '');
  }, [location.pathname, params]);
  return (
    <search className="search-region">
      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(`/search?q=${encodeURIComponent(value.trim())}`);
        }}
      >
        <Search size={16} />
        <input
          aria-label="搜索条目"
          placeholder="搜索"
          value={value}
          maxLength={100}
          onChange={(event) => setValue(event.target.value)}
        />
        {value && (
          <button
            className="search-clear"
            aria-label="清除搜索"
            type="button"
            onClick={() => {
              setValue('');
              if (location.pathname === '/search') navigate('/search?q=');
            }}
          >
            <X size={18} />
          </button>
        )}
      </form>
    </search>
  );
}

function AccountArea() {
  const { user, loading, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!slot.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (loading) return null;
  if (!user) {
    return (
      <Link
        className="login-entry"
        to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
      >
        登录
      </Link>
    );
  }
  async function exit() {
    setBusy(true);
    setError('');
    try {
      await logout();
      setOpen(false);
      navigate('/');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-slot" ref={slot}>
      <button
        className="account-avatar"
        type="button"
        aria-label="账号菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar user={user} className="account-avatar-inner" />
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="账号">
          <p className="account-name">{user.displayName}</p>
          <p className="account-role">
            @{user.username} · {user.role === 'owner' ? '站点所有者' : '注册用户'}
          </p>
          <Link
            className="menu-button"
            role="menuitem"
            to="/settings/profile"
            onClick={() => setOpen(false)}
          >
            个人设置
          </Link>
          <Link
            className="menu-button"
            role="menuitem"
            to="/publish"
            onClick={() => setOpen(false)}
          >
            发布条目
          </Link>
          {user.role === 'owner' && (
            <Link
              className="menu-button"
              role="menuitem"
              to="/settings/content"
              onClick={() => setOpen(false)}
            >
              站点管理
            </Link>
          )}
          <button
            className="menu-button"
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void exit()}
          >
            {busy ? '退出中…' : '退出登录'}
          </button>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Navigation() {
  return (
    <nav className="navigation" aria-label="主导航">
      <div className="navigation-top">
        <Link to="/" className="brand" aria-label="hzlt!Collections 首页">
          <img src={logo} alt="hzlt!Collections" />
        </Link>
        <NavLink end to="/" aria-label="首页">
          <Home size={30} />
        </NavLink>
        <NavLink to="/likes" aria-label="喜欢">
          <Heart size={30} />
        </NavLink>
        <NavLink to="/publish" aria-label="发布条目">
          <FilePlusCorner size={30} />
        </NavLink>
      </div>
      <div className="navigation-bottom">
        <NavLink to="/settings" aria-label="设置">
          <Settings size={30} />
        </NavLink>
      </div>
    </nav>
  );
}

function AppShell() {
  const location = useLocation();
  const composer =
    location.pathname === '/publish' || /^\/entries\/[^/]+\/edit/.test(location.pathname);
  return (
    <div className="app-shell">
      <Navigation />
      <main className={composer ? 'main-content composer-main' : 'main-content'}>
        {!composer && (
          <div className="top-bar">
            <Link to="/" className="mobile-brand" aria-label="hzlt!Collections 首页">
              h!Cl
            </Link>
            <SearchBar />
            <AccountArea />
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}

function RequireUser() {
  const { user, loading, error, refresh } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="request-state" role="status">
        正在确认登录状态…
      </div>
    );
  if (error)
    return (
      <div className="request-state">
        <p className="error" role="alert">
          {errorMessage(error)}
        </p>
        <button type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  if (!user)
    return (
      <Navigate
        replace
        to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
      />
    );
  return <Outlet />;
}

function OwnerSettings() {
  const { user } = useAuth();
  if (user?.role !== 'owner') return <Navigate replace to="/settings/profile" />;
  return <ContentManagement />;
}

export function App() {
  const location = useLocation();
  const state = location.state as { backgroundLocation?: Location } | null;
  const background = state?.backgroundLocation;
  return (
    <>
      <Routes location={background ?? location}>
        <Route element={<AppShell />}>
          <Route index element={<FeedPage />} />
          <Route path="search" element={<FeedPage kind="search" />} />
          <Route element={<RequireUser />}>
            <Route path="likes" element={<FeedPage kind="likes" />} />
            <Route path="publish" element={<EntryComposer />} />
            <Route path="entries/:id/edit" element={<EntryComposer />} />
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<Navigate replace to="profile" />} />
              <Route path="profile" element={<SettingsProfile />} />
              <Route path="content" element={<OwnerSettings />} />
            </Route>
          </Route>
          <Route
            path="*"
            element={
              <div className="request-state">
                <h1>页面不存在</h1>
                <Link to="/">返回首页</Link>
              </div>
            }
          />
        </Route>
        <Route path="login" element={<AuthForm kind="login" />} />
        <Route path="register" element={<AuthForm kind="register" />} />
        <Route path="entries/:id" element={<EntryDetail />} />
      </Routes>
      {background && (
        <Routes>
          <Route path="entries/:id" element={<EntryDetail modal />} />
        </Routes>
      )}
    </>
  );
}
