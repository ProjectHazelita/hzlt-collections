import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, errorMessage, isCancelled, safeReturnTo, useAuth } from '../../app/api';
import './auth.css';

type Kind = 'login' | 'register';
type FieldErrors = { username?: string; password?: string; confirmation?: string };

export function AuthForm({ kind }: { kind: Kind }) {
  return <AuthFields key={kind} kind={kind} />;
}

function AuthFields({ kind }: { kind: Kind }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get('returnTo'));
  const register = kind === 'register';
  const id = useId();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (auth.user && !auth.loading) void navigate(returnTo, { replace: true });
  }, [auth.user, auth.loading, navigate, returnTo]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || auth.loading || auth.error || auth.user || needsSession) return;
    const next: FieldErrors = {};
    const name = username.trim();
    const normalized = name.normalize('NFKC');
    if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(normalized)) next.username = '用户名需为 3–32 个字符，仅可使用字母、数字、下划线和短横线。';
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
      const rejectedCredentials = cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS'
        && auth.epoch.current === captured + 1;
      if (!active.current || isCancelled(cause) || (captured !== auth.epoch.current && !rejectedCredentials)) return;
      failureEpoch = auth.epoch.current;
      if (cause instanceof ApiError && cause.code === 'USERNAME_TAKEN') {
        setFields({ username: '这个用户名已被使用，请换一个。' });
        setFailure('这个用户名已被使用。');
      } else if (rejectedCredentials || (cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS')) {
        setFailure('用户名或密码不正确，请检查后重试。');
      } else {
        setFailure(errorMessage(cause));
      }
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setNeedsSession(true);
    } finally {
      busy.current = false;
      if (active.current && auth.epoch.current === failureEpoch) setSubmitting(false);
    }
  }

  return <main className="auth-page">
    <section className="auth-brand" aria-label="hzlt!Collections">
      <p className="auth-wordmark">hzlt!Collections</p>
      <p className="auth-tagline">把创作、日常和灵光一闪，<br />留在同一个地方。</p>
      <p className="muted">一个属于社群的内容分享空间。<br />无需登录也可以浏览，注册后即可发布和喜欢。</p>
      <Link className="auth-browse" to="/">先随便看看</Link>
    </section>
    <form className="auth-card" onSubmit={submit} noValidate aria-labelledby={`${id}-title`} aria-busy={submitting || auth.loading}>
      <h1 id={`${id}-title`}>{register ? '加入 hzlt!Collections' : '欢迎回来'}</h1>
      <p className="muted">{register ? '注册后，就可以开始分享。' : '登录后继续发布和喜欢内容。'}</p>
      <div className="auth-field">
        <label htmlFor={`${id}-username`}>用户名</label>
        <input id={`${id}-username`} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} disabled={submitting}
          onChange={event => setUsername(event.target.value)} aria-invalid={Boolean(fields.username)} aria-describedby={`${id}-username-hint${fields.username ? ` ${id}-username-error` : ''}`} />
        <small className="muted" id={`${id}-username-hint`}>3–32 个字母、数字、下划线或短横线</small>
        {fields.username && <small className="error" id={`${id}-username-error`}>{fields.username}</small>}
      </div>
      <div className="auth-field">
        <label htmlFor={`${id}-password`}>密码</label>
        <input id={`${id}-password`} name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required value={password} disabled={submitting}
          onChange={event => setPassword(event.target.value)} aria-invalid={Boolean(fields.password)} aria-describedby={`${id}-password-hint${fields.password ? ` ${id}-password-error` : ''}`} />
        <small className="muted" id={`${id}-password-hint`}>12–128 个字符，保留输入的空格</small>
        {fields.password && <small className="error" id={`${id}-password-error`}>{fields.password}</small>}
      </div>
      {register && <div className="auth-field">
        <label htmlFor={`${id}-confirmation`}>确认密码</label>
        <input id={`${id}-confirmation`} name="confirmation" type="password" autoComplete="new-password" required value={confirmation} disabled={submitting}
          onChange={event => setConfirmation(event.target.value)} aria-invalid={Boolean(fields.confirmation)} aria-describedby={`${id}-confirmation-hint${fields.confirmation ? ` ${id}-confirmation-error` : ''}`} />
        <small className="muted" id={`${id}-confirmation-hint`}>使用较长且不重复的密码。</small>
        {fields.confirmation && <small className="error" id={`${id}-confirmation-error`}>{fields.confirmation}</small>}
      </div>}
      {auth.loading && <p role="status" className="muted">正在准备安全会话…</p>}
      {Boolean(failure || auth.error) && <div role="alert" className="auth-notice error">{failure || errorMessage(auth.error)}</div>}
      {Boolean(auth.error || needsSession) && <button type="button" className="secondary" disabled={auth.loading || submitting} onClick={async () => {
        const captured = auth.epoch.current;
        await auth.refresh();
        if (active.current && captured === auth.epoch.current) setNeedsSession(false);
      }}>重新获取安全会话</button>}
      <button className="primary" type="submit" disabled={submitting || auth.loading || Boolean(auth.error) || needsSession || Boolean(auth.user)}>
        {submitting ? (register ? '正在注册…' : '正在登录…') : (register ? '注册并进入' : '登录')}
      </button>
      <Link className="auth-switch secondary" to={`/${register ? 'login' : 'register'}?${new URLSearchParams({ returnTo })}`}>{register ? '已有账号？登录' : '没有账号？注册'}</Link>
    </form>
  </main>;
}

export default AuthForm;
