import type { Site, UploadAccepted, UploadStatus } from '@hcl/contracts';
import { ImagePlus, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, isCancelled, useAuth } from '../../app/api';
import { useSite } from '../../app/site';
import { uuid } from '../../app/uuid';
import defaultLogo from '../../assets/logo.svg';
import './site-settings.css';

export function SiteSettings() {
  const { user, epoch } = useAuth();
  return user ? <SiteSettingsEditor key={`${user.id}:${epoch.current}`} /> : null;
}

const logoErrors: Record<string, string> = {
  ANIMATION_NOT_SUPPORTED: '不支持动图，请选择静态图片。',
  UNSUPPORTED_IMAGE_TYPE: '仅支持静态 JPEG、PNG、WebP 和 GIF。',
  IMAGE_TOO_LARGE: '图片超过服务器允许的大小或尺寸。',
  FILE_TOO_LARGE: '图片文件过大，请选择较小的图片。',
  INVALID_IMAGE: '图片无效或已损坏，请重新选择。',
  IMAGE_PROCESSING_FAILED: 'Logo 处理失败，请重新选择图片。',
  IMAGE_TIMEOUT: '图片处理超时，请重新选择。',
};

function SiteSettingsEditor() {
  const { request, epoch } = useAuth();
  const { site, loading, error: loadError, refresh } = useSite();
  const [draft, setDraft] = useState(site);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploadPhase, setUploadPhase] = useState<'uploading' | 'processing' | null>(null);
  const [uploadError, setUploadError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const saving = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const mounted = useRef(true);

  const clearUpload = useCallback(() => {
    upload.current?.abort();
    upload.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearUpload();
      saving.current?.abort();
    };
  }, [clearUpload]);

  useEffect(() => {
    clearUpload();
    setPreview(null);
    setUploadPhase(null);
    setUploadError('');
    setDraft(site);
  }, [site, clearUpload]);

  async function chooseLogo(file: File | undefined) {
    if (!file || busy) return;
    clearUpload();
    setSaved(false);
    setError('');
    setUploadError('');
    const local = URL.createObjectURL(file);
    objectUrl.current = local;
    setPreview(local);
    setUploadPhase('uploading');
    const current = new AbortController();
    upload.current = current;
    const captured = epoch.current;
    const active = () =>
      mounted.current &&
      captured === epoch.current &&
      upload.current === current &&
      !current.signal.aborted;
    try {
      const form = new FormData();
      form.append('kind', 'image');
      form.append('file', file);
      const accepted = await request<UploadAccepted>('/api/v1/uploads', {
        method: 'POST',
        body: form,
        idempotencyKey: uuid(),
        signal: current.signal,
      });
      if (!active()) return;
      setUploadPhase('processing');
      let status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
        signal: current.signal,
      });
      while (status.status === 'pending' && active()) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            window.clearTimeout(timer);
            current.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = window.setTimeout(finish, 800);
          current.signal.addEventListener('abort', finish, { once: true });
        });
        if (!active()) return;
        status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
          signal: current.signal,
        });
      }
      if (!active()) return;
      if (status.status !== 'ready')
        throw new Error(logoErrors[status.errorCode ?? ''] ?? 'Logo 处理失败，请重新选择图片。');
      setDraft((previous) => ({ ...previous, logoAssetId: accepted.id, logoUrl: null }));
      setUploadPhase(null);
    } catch (cause) {
      if (!active() || isCancelled(cause)) return;
      clearUpload();
      setPreview(null);
      setDraft((previous) => ({
        ...previous,
        logoAssetId: site.logoAssetId,
        logoUrl: site.logoUrl,
      }));
      setUploadPhase(null);
      setUploadError(
        cause instanceof ApiError
          ? (logoErrors[cause.code] ?? errorMessage(cause))
          : errorMessage(cause),
      );
    }
  }

  function changeLogoUrl(logoUrl: string | null) {
    if (busy) return;
    clearUpload();
    setPreview(null);
    setUploadPhase(null);
    setUploadError('');
    setSaved(false);
    setDraft((previous) => ({ ...previous, logoAssetId: null, logoUrl }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || uploadPhase) return;
    const current = new AbortController();
    saving.current = current;
    const captured = epoch.current;
    const active = () => mounted.current && !current.signal.aborted && captured === epoch.current;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const next = await request<Site>('/api/v1/site', {
        method: 'PATCH',
        signal: current.signal,
        json: {
          title: draft.title.trim(),
          description: draft.description.trim(),
          registrationOpen: draft.registrationOpen,
          logoAssetId: draft.logoAssetId,
          ...(draft.logoAssetId ? {} : { logoUrl: draft.logoUrl?.trim() || null }),
        },
      });
      if (!active()) return;
      clearUpload();
      setPreview(null);
      setDraft(next);
      await refresh();
      if (active()) setSaved(true);
    } catch (cause) {
      if (active() && !isCancelled(cause)) setError(errorMessage(cause));
    } finally {
      if (active()) setBusy(false);
    }
  }
  if (loading)
    return (
      <div className="request-state" role="status">
        正在加载站点设置…
      </div>
    );
  if (loadError)
    return (
      <div className="request-state">
        <p className="error" role="alert">
          {errorMessage(loadError)}
        </p>
        <button className="secondary" type="button" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  return (
    <form
      className="settings-stack"
      onSubmit={(event) => void submit(event)}
      onChange={() => setSaved(false)}
    >
      <section className="settings-card" aria-labelledby="site-brand-title">
        <header className="settings-section-heading">
          <h2 id="site-brand-title">站点资料</h2>
          <p>用于页面标题、导航和登录／注册页面，保存后全站同步。</p>
        </header>
        <label className="settings-field">
          <span className="settings-label">站点标题</span>
          <input
            required
            maxLength={100}
            disabled={busy}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="settings-field">
          <span className="settings-label">站点介绍</span>
          <textarea
            rows={4}
            disabled={busy}
            maxLength={500}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <div className="site-logo-preview">
          <img
            src={preview || draft.logoUrl || defaultLogo}
            alt="站点 Logo 预览"
            referrerPolicy="no-referrer"
          />
          <div className="settings-avatar-actions">
            <span className="settings-avatar-title">站点 Logo</span>
            <span className="settings-hint">上传静态 JPEG、PNG、WebP 或 GIF，保存后公开显示。</span>
            <div className="settings-button-row">
              <button
                className="secondary settings-small-button"
                type="button"
                disabled={busy}
                onClick={() => input.current?.click()}
              >
                <ImagePlus size={16} />
                {preview || draft.logoUrl || draft.logoAssetId ? '更换 Logo' : '上传 Logo'}
              </button>
              {(preview || draft.logoUrl || draft.logoAssetId || uploadPhase) && (
                <button
                  className="settings-text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => changeLogoUrl(null)}
                >
                  <X size={14} />
                  恢复默认 Logo
                </button>
              )}
            </div>
            <input
              ref={input}
              className="settings-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="选择站点 Logo"
              disabled={busy}
              onChange={(event) => {
                void chooseLogo(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        </div>
        <div className="site-logo-status" role="status" aria-live="polite">
          {uploadPhase ? (
            <>
              <progress
                aria-label={uploadPhase === 'uploading' ? '正在上传 Logo' : '正在处理 Logo'}
              />
              <span>
                {uploadPhase === 'uploading' ? '正在上传 Logo…' : '正在处理 Logo，请稍候…'}
              </span>
            </>
          ) : preview ? (
            <span>Logo 已准备好，保存后生效。当前预览仅在本地显示。</span>
          ) : (
            <span>{draft.logoUrl ? '保存后使用此 Logo。' : '未选择图片时使用默认 Logo。'}</span>
          )}
        </div>
        {uploadError && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
        <details className="site-logo-alternate">
          <summary>其他方式：使用外部图片地址</summary>
          <label className="settings-field">
            <span className="settings-label">外部 Logo 地址（可选）</span>
            <input
              type="url"
              pattern="https?://.+"
              maxLength={2048}
              disabled={busy}
              placeholder="https://example.com/logo.png"
              value={draft.logoAssetId || preview ? '' : (draft.logoUrl ?? '')}
              onChange={(event) => changeLogoUrl(event.target.value || null)}
            />
            <span className="settings-hint">
              填写 HTTP(S) 图片地址将替代上传的 Logo。访客会从此地址加载图片。
            </span>
          </label>
        </details>
      </section>
      <section className="settings-card" aria-labelledby="site-registration-title">
        <header className="settings-section-heading">
          <h2 id="site-registration-title">注册开放性</h2>
          <p>关闭后现有用户仍可登录，访客不能创建新账号。</p>
        </header>
        <label className="site-registration-toggle">
          <input
            type="checkbox"
            disabled={busy}
            checked={draft.registrationOpen}
            onChange={(event) => setDraft({ ...draft, registrationOpen: event.target.checked })}
          />
          <span>开放注册</span>
        </label>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="settings-success" role="status">
          站点设置已保存。
        </p>
      )}
      <footer className="settings-card-footer">
        <button
          className="primary"
          disabled={busy || !!uploadPhase || !draft.title.trim()}
          type="submit"
        >
          {busy ? '保存中…' : '保存站点设置'}
        </button>
      </footer>
    </form>
  );
}
