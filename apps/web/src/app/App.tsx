import { Heart, Home, LogIn, LogOut, Plus, Search, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { ContentManagement } from '../features/admin/ContentManagement';
import { AuthForm } from '../features/auth/AuthForm';
import { EntryComposer } from '../features/composer/EntryComposer';
import { EntryDetail } from '../features/EntryDetail';
import { FeedPage } from '../features/FeedPage';
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
        <Search size={20} />
        <input
          aria-label="搜索条目"
          placeholder="搜索"
          value={value}
          maxLength={100}
          onChange={(event) => setValue(event.target.value)}
        />
        {value && (
          <button
            className="icon-button"
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
        <button className="search-submit" type="submit">
          搜索
        </button>
      </form>
    </search>
  );
}
function Navigation() {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function exit() {
    setBusy(true);
    try {
      await logout();
      setMenu(false);
      navigate('/');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
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
          <Plus size={30} />
        </NavLink>
      </div>
      <div className="navigation-bottom">
        {user?.role === 'owner' && (
          <NavLink to="/settings/content" aria-label="内容管理">
            <Settings size={30} />
          </NavLink>
        )}
        <button
          className="account-trigger"
          type="button"
          aria-label={user ? '账号菜单' : '登录或注册'}
          aria-expanded={menu}
          onClick={() => setMenu((value) => !value)}
        >
          {user?.role === 'owner' ? (
            <span className="avatar">{Array.from(user.username)[0]}</span>
          ) : (
            <Settings size={30} />
          )}
        </button>
        {menu && (
          <div className="account-menu">
            <p>{user?.username ?? '访客'}</p>
            {user ? (
              <button type="button" disabled={busy} onClick={() => void exit()}>
                <LogOut size={18} />
                {busy ? '退出中…' : '退出登录'}
              </button>
            ) : (
              <>
                <Link to="/login" onClick={() => setMenu(false)}>
                  <LogIn size={18} />
                  登录
                </Link>
                <Link to="/register" onClick={() => setMenu(false)}>
                  注册
                </Link>
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="button" onClick={() => setMenu(false)}>
              关闭菜单
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
function AppShell() {
  return (
    <div className="app-shell">
      <Navigation />
      <main className="main-content">
        <SearchBar />
        <Outlet />
      </main>
    </div>
  );
}
function RequireUser({ owner = false }: { owner?: boolean }) {
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
  if (owner && user.role !== 'owner')
    return (
      <div className="request-state">
        <h1>无权访问</h1>
        <Link to="/">返回首页</Link>
      </div>
    );
  return <Outlet />;
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
          </Route>
          <Route element={<RequireUser owner />}>
            <Route path="settings/content" element={<ContentManagement />} />
          </Route>
          <Route path="login" element={<AuthForm kind="login" />} />
          <Route path="register" element={<AuthForm kind="register" />} />
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
