import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, errorMessage, isCancelled, safeReturnTo, useAuth } from '../../app/api';
import { useSite } from '../../app/site';
import logo from '../../assets/logo.svg';
import './auth.css';

type Kind = 'login' | 'register';
type FieldErrors = { username?: string; password?: string; confirmation?: string };

export function AuthForm({ kind }: { kind: Kind }) {
  return <AuthFields key={kind} kind={kind} />;
}

function AuthFields({ kind }: { kind: Kind }) {
  const auth = useAuth();
  const { site, loading: siteLoading, error: siteError, refresh: refreshSite } = useSite();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get('returnTo'));
  const register = kind === 'register';
  const id = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<{ title: string; note?: string } | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  const [availability, setAvailability] = useState<{
    username: string;
    status: 'checking' | 'available' | 'taken' | 'error';
    message?: string;
  } | null>(null);
  const normalizedUsername = username.trim().normalize('NFKC');
  const validUsername = /^[\p{L}\p{N}_-]{3,32}$/u.test(normalizedUsername);
  const usernameStatus = availability?.username === normalizedUsername ? availability : null;
  const registrationClosed = register && !site.registrationOpen;

  useEffect(() => {
    if (
      !register ||
      !validUsername ||
      registrationClosed ||
      siteLoading ||
      auth.loading ||
      auth.user
    )
      return;
    const controller = new AbortController();
    const captured = auth.epoch.current;
    const timer = window.setTimeout(() => {
      setAvailability({ username: normalizedUsername, status: 'checking' });
      void auth
        .request<{ available: boolean }>(
          `/api/v1/auth/username-availability?${new URLSearchParams({ username: normalizedUsername })}`,
          { signal: controller.signal },
        )
        .then((result) => {
          if (controller.signal.aborted || captured !== auth.epoch.current) return;
          setAvailability({
            username: normalizedUsername,
            status: result.available ? 'available' : 'taken',
          });
        })
        .catch((cause) => {
          if (controller.signal.aborted || captured !== auth.epoch.current || isCancelled(cause))
            return;
          setAvailability({
            username: normalizedUsername,
            status: 'error',
            message: errorMessage(cause),
          });
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    register,
    normalizedUsername,
    validUsername,
    registrationClosed,
    siteLoading,
    auth.loading,
    auth.user,
    auth.request,
    auth.epoch,
  ]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (auth.user && !auth.loading) void navigate(returnTo, { replace: true });
  }, [auth.user, auth.loading, navigate, returnTo]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy.current ||
      auth.loading ||
      auth.error ||
      auth.user ||
      needsSession ||
      (register && (siteLoading || siteError || registrationClosed))
    )
      return;
    const next: FieldErrors = {};
    const name = username.trim();
    const normalized = name.normalize('NFKC');
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(normalized))
      next.username = '用户名需为 3–32 个字符，仅可使用字母、数字、下划线和短横线。';
    else if (register && usernameStatus?.status === 'taken')
      next.username = '这个用户名已被使用，请换一个。';
    const length = Array.from(password).length;
    if (length < 12 || length > 128) next.password = '密码需为 12–128 个字符。';
    if (register && password !== confirmation) next.confirmation = '两次输入的密码不一致。';
    setFields(next);
    setFailure(null);
    if (Object.keys(next).length) return;
    const captured = auth.epoch.current;
    busy.current = true;
    setSubmitting(true);
    let failureEpoch = captured;
    try {
      // authenticate owns the successful identity transition. The user effect redirects.
      await auth.authenticate(kind, { username: name, password });
    } catch (cause) {
      // A rejected login deliberately clears identity and advances the shared epoch.
      const rejectedCredentials =
        cause instanceof ApiError &&
        cause.code === 'INVALID_CREDENTIALS' &&
        auth.epoch.current === captured + 1;
      if (
        !active.current ||
        isCancelled(cause) ||
        (captured !== auth.epoch.current && !rejectedCredentials)
      )
        return;
      failureEpoch = auth.epoch.current;
      if (cause instanceof ApiError && cause.code === 'USERNAME_TAKEN') {
        setFailure({ title: '这个用户名已被使用', note: '请换一个用户名，再试一次。' });
      } else if (
        rejectedCredentials ||
        (cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS')
      ) {
        setFailure({ title: '用户名或密码不正确', note: '请检查后重试。' });
      } else {
        setFailure({ title: errorMessage(cause) });
      }
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403))
        setNeedsSession(true);
    } finally {
      busy.current = false;
      if (active.current && auth.epoch.current === failureEpoch) setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-brand" aria-label={site.title}>
        <img className="auth-logo" src={site.logoUrl ?? logo} alt="" />
        <p className="auth-wordmark">{site.title}</p>
        <p className="auth-description">{site.description}</p>
        <Link className="auth-browse" to="/">
          先随便看看
        </Link>
      </section>
      <form
        className="auth-card"
        onSubmit={submit}
        noValidate
        aria-labelledby={`${id}-title`}
        aria-busy={submitting || auth.loading}
      >
        <h1 id={`${id}-title`}>{register ? `加入 ${site.title}` : '欢迎回来'}</h1>
        <p className="muted">
          {register ? '注册后，就可以开始分享。' : '登录后继续发布和喜欢内容。'}
        </p>
        {register && siteLoading && (
          <p role="status" className="muted">
            正在获取注册设置…
          </p>
        )}
        {register && registrationClosed && !siteLoading && (
          <p role="status" className="auth-notice">
            站点暂未开放注册，你仍可浏览或登录已有账号。
          </p>
        )}
        {register && Boolean(siteError) && (
          <div className="auth-notice" role="alert">
            <p>无法获取注册设置：{errorMessage(siteError)}</p>
            <button type="button" className="secondary" onClick={() => void refreshSite()}>
              重试
            </button>
          </div>
        )}
        <div className="auth-field">
          <label htmlFor={`${id}-username`}>用户名</label>
          <input
            id={`${id}-username`}
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            disabled={submitting}
            onChange={(event) => {
              setUsername(event.target.value);
              if (event.target.value.trim().normalize('NFKC') !== normalizedUsername)
                setAvailability(null);
              setFields((current) => ({ ...current, username: undefined }));
              setFailure(null);
            }}
            placeholder="输入用户名"
            aria-invalid={
              Boolean(fields.username) || (register && usernameStatus?.status === 'taken')
            }
            aria-describedby={`${id}-username-status${fields.username ? ` ${id}-username-error` : ''}`}
          />
          {fields.username && (
            <small className="error" id={`${id}-username-error`}>
              {fields.username}
            </small>
          )}
          <small
            id={`${id}-username-status`}
            className={usernameStatus?.status === 'taken' ? 'error' : 'auth-hint'}
            role="status"
          >
            {register && username && !validUsername
              ? '用户名需为 3–32 个字符，仅可使用字母、数字、下划线和短横线。'
              : register && validUsername && !registrationClosed
                ? usernameStatus?.status === 'available'
                  ? '这个用户名可以使用。'
                  : usernameStatus?.status === 'taken'
                    ? '这个用户名已被使用，请换一个。'
                    : usernameStatus?.status === 'error'
                      ? `暂时无法查询用户名：${usernameStatus.message}，提交时将再次校验。`
                      : '正在检查用户名…'
                : ''}
          </small>
        </div>
        <div className="auth-field">
          <label htmlFor={`${id}-password`}>密码</label>
          <input
            id={`${id}-password`}
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            value={password}
            disabled={submitting}
            onChange={(event) => {
              const next = event.target.value;
              setPassword(next);
              const length = Array.from(next).length;
              setFields((current) => ({
                ...current,
                password: length >= 12 && length <= 128 ? undefined : current.password,
                confirmation: next === confirmation ? undefined : current.confirmation,
              }));
            }}
            placeholder="输入密码"
            aria-invalid={Boolean(fields.password)}
            aria-describedby={fields.password ? `${id}-password-error` : undefined}
          />
          {fields.password && (
            <small className="error" id={`${id}-password-error`}>
              {fields.password}
            </small>
          )}
        </div>
        {register && (
          <div className="auth-field">
            <label htmlFor={`${id}-confirmation`}>确认密码</label>
            <input
              id={`${id}-confirmation`}
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              value={confirmation}
              disabled={submitting}
              onChange={(event) => {
                const next = event.target.value;
                setConfirmation(next);
                if (next === password)
                  setFields((current) => ({ ...current, confirmation: undefined }));
              }}
              placeholder="再次输入密码"
              aria-invalid={Boolean(fields.confirmation)}
              aria-describedby={`${id}-confirmation-hint${fields.confirmation ? ` ${id}-confirmation-error` : ''}`}
            />
            <small className="auth-hint" id={`${id}-confirmation-hint`}>
              使用较长且不重复的密码。
            </small>
            {fields.confirmation && (
              <small className="error" id={`${id}-confirmation-error`}>
                {fields.confirmation}
              </small>
            )}
          </div>
        )}
        {auth.loading && (
          <p role="status" className="muted">
            正在准备安全会话…
          </p>
        )}
        {Boolean(failure || auth.error) && (
          <div role="alert" className="auth-notice">
            <p className="auth-notice-title">{failure?.title ?? errorMessage(auth.error)}</p>
            {failure?.note && <p className="auth-notice-note">{failure.note}</p>}
          </div>
        )}
        {Boolean(auth.error || needsSession) && (
          <button
            type="button"
            className="secondary"
            disabled={auth.loading || submitting}
            onClick={async () => {
              const captured = auth.epoch.current;
              await auth.refresh();
              if (active.current && captured === auth.epoch.current) setNeedsSession(false);
            }}
          >
            重新获取安全会话
          </button>
        )}
        <button
          className="primary"
          type="submit"
          disabled={
            submitting ||
            auth.loading ||
            Boolean(auth.error) ||
            needsSession ||
            Boolean(auth.user) ||
            (register &&
              (siteLoading ||
                Boolean(siteError) ||
                registrationClosed ||
                usernameStatus?.status === 'taken'))
          }
        >
          {submitting ? (register ? '正在注册…' : '正在登录…') : register ? '注册并进入' : '登录'}
        </button>
        {(register || site.registrationOpen) && (
          <Link
            className="auth-switch secondary"
            to={`/${register ? 'login' : 'register'}?${new URLSearchParams({ returnTo })}`}
          >
            {register ? '已有账号？登录' : '没有账号？注册'}
          </Link>
        )}
      </form>
    </main>
  );
}

export default AuthForm;
