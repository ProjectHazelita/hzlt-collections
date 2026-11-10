import type {
  Profile as EditableProfile,
  Pronouns,
  Session,
  UploadAccepted,
  UploadStatus,
} from '@hcl/contracts';
import { ImagePlus, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage, isCancelled, useAuth } from '../../app/api';
import { uuid } from '../../app/uuid';
import './settings.css';

const avatarId = (url: string | null) => url?.match(/^\/media\/([^/]+)\/avatar$/)?.[1] ?? null;

function avatarError(status: UploadStatus) {
  const messages: Record<string, string> = {
    ANIMATION_NOT_SUPPORTED: '不支持动图，请选择静态图片。',
    UNSUPPORTED_IMAGE_TYPE: '仅支持静态 JPEG、PNG、WebP 和 GIF。',
    IMAGE_TOO_LARGE: '图片超过服务器允许的大小或尺寸。',
    IMAGE_TIMEOUT: '图片处理超时，请重新选择。',
  };
  if (status.status !== 'failed') return '';
  return messages[status.errorCode ?? ''] ?? '头像处理失败，请重新选择图片。';
}

export function SettingsProfile() {
  const { user } = useAuth();
  const [loadAttempt, setLoadAttempt] = useState(0);
  return user ? (
    <ProfileEditor
      key={`${user.id}:${loadAttempt}`}
      onRetry={() => setLoadAttempt((value) => value + 1)}
    />
  ) : null;
}

function ProfileEditor({ onRetry }: { onRetry: () => void }) {
  const { user, request, epoch, applySession } = useAuth();
  const [details, setDetails] = useState<Omit<EditableProfile, 'displayName' | 'avatarAssetId'>>({
    bio: '',
    email: '',
    pronouns: 'not specified',
    location: '',
    socialLinks: [],
    showEmail: false,
    showLocation: false,
    showSocialLinks: false,
    showFollowing: true,
    showFollowers: true,
  });
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const mounted = useRef(true);
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [avatarAssetId, setAvatarAssetId] = useState<string | null>(
    avatarId(user?.avatarUrl ?? null),
  );
  const [preview, setPreview] = useState(user?.avatarUrl ?? '');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileFields, setProfileFields] = useState<Record<string, string>>({});
  const [profileSuccess, setProfileSuccess] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const socialLinkKeys = useRef<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordFields, setPasswordFields] = useState<Record<string, string>>({});
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setLoadError('');
    void request<EditableProfile>('/api/v1/me/profile', { signal: abort.signal })
      .then((profile) => {
        if (abort.signal.aborted) return;
        const { displayName: name, avatarAssetId: avatar, ...rest } = profile;
        setDisplayName(name);
        setAvatarAssetId(avatar);
        socialLinkKeys.current = rest.socialLinks.map(() => uuid());
        setDetails(rest);
        setBaseline(JSON.stringify(rest));
        setLoading(false);
      })
      .catch((cause) => {
        if (abort.signal.aborted || isCancelled(cause)) return;
        setLoadError(errorMessage(cause));
        setLoading(false);
      });
    return () => abort.abort();
  }, [request]);

  function updateDetails<K extends keyof typeof details>(key: K, value: (typeof details)[K]) {
    setDetails((previous) => ({ ...previous, [key]: value }));
    setProfileSuccess('');
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  function showPreview(url: string) {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
    if (url.startsWith('blob:')) objectUrl.current = url;
    setPreview(url);
  }

  async function chooseAvatar(file: File | undefined) {
    if (!file) return;
    setUploadError('');
    setProfileSuccess('');
    const local = URL.createObjectURL(file);
    showPreview(local);
    setUploading(true);
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const captured = epoch.current;
    const key = uuid();
    try {
      const form = new FormData();
      form.append('kind', 'image');
      form.append('file', file);
      const accepted = await request<UploadAccepted>('/api/v1/uploads', {
        method: 'POST',
        body: form,
        idempotencyKey: key,
        signal: current.signal,
      });
      let status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
        signal: current.signal,
      });
      while (status.status === 'pending') {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, 800);
          current.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (current.signal.aborted) return;
        status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
          signal: current.signal,
        });
      }
      if (captured !== epoch.current || current.signal.aborted) return;
      if (status.status === 'ready') {
        setAvatarAssetId(accepted.id);
        setUploading(false);
      } else {
        setUploadError(avatarError(status));
        setUploading(false);
        showPreview(user?.avatarUrl ?? '');
      }
    } catch (cause) {
      if (captured !== epoch.current || isCancelled(cause)) return;
      setUploading(false);
      setUploadError(errorMessage(cause));
      showPreview(user?.avatarUrl ?? '');
    }
  }

  function removeAvatar() {
    controller.current?.abort();
    setUploading(false);
    setUploadError('');
    setAvatarAssetId(null);
    showPreview('');
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (Array.from(name).length < 1 || Array.from(name).length > 32) {
      setProfileFields({ displayName: '昵称须为 1–32 个字符。' });
      return;
    }
    if (!user || saving || uploading) return;
    setSaving(true);
    setProfileError('');
    setProfileFields({});
    setProfileSuccess('');
    try {
      const next = await request<Session>('/api/v1/me/profile', {
        method: 'PATCH',
        json: { displayName: name, avatarAssetId, ...details },
      });
      if (!mounted.current) return;
      setBaseline(JSON.stringify(details));
      applySession(next);
      setDisplayName(next.user?.displayName ?? name);
      setAvatarAssetId(avatarId(next.user?.avatarUrl ?? null));
      showPreview(next.user?.avatarUrl ?? '');
      setProfileSuccess('个人资料已更新。');
    } catch (cause) {
      if (mounted.current && !isCancelled(cause)) {
        if (cause instanceof ApiError && cause.fields && Object.keys(cause.fields).length) {
          setProfileFields(cause.fields);
        } else {
          setProfileError(errorMessage(cause));
        }
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError('');
    setPasswordFields({});
    setPasswordSuccess('');
    if (!currentPassword) {
      setPasswordFields({ currentPassword: '请输入当前密码。' });
      return;
    }
    if (Array.from(newPassword).length < 12 || Array.from(newPassword).length > 128) {
      setPasswordFields({ newPassword: '新密码须为 12–128 个字符。' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFields({ confirmPassword: '两次输入的新密码不一致。' });
      return;
    }
    if (changingPassword) return;
    setChangingPassword(true);
    try {
      const next = await request<Session>('/api/v1/me/password', {
        method: 'PUT',
        json: { currentPassword, newPassword },
      });
      if (!mounted.current) return;
      applySession(next);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('密码已更新，其他设备上的登录已失效。');
    } catch (cause) {
      if (mounted.current && !isCancelled(cause)) {
        if (cause instanceof ApiError && cause.fields && Object.keys(cause.fields).length) {
          setPasswordFields(cause.fields);
        } else {
          setPasswordError(errorMessage(cause));
        }
      }
    } finally {
      if (mounted.current) setChangingPassword(false);
    }
  }

  if (!user) return null;
  const nameDirty = displayName.trim() !== user.displayName;
  const avatarDirty = avatarAssetId !== avatarId(user.avatarUrl);
  const detailsDirty = JSON.stringify(details) !== baseline;
  const profileValid =
    Array.from(displayName.trim()).length >= 1 &&
    Array.from(displayName.trim()).length <= 32 &&
    !uploading;

  if (loading)
    return (
      <div className="state-block" role="status">
        正在加载个人资料…
      </div>
    );
  if (loadError)
    return (
      <div className="settings-card">
        <p className="error" role="alert">
          {loadError}
        </p>
        <button className="secondary" type="button" onClick={onRetry}>
          重新加载
        </button>
      </div>
    );
  return (
    <div className="settings-stack">
      <form className="settings-card" onSubmit={saveProfile}>
        <header className="settings-section-heading">
          <h2>个人资料</h2>
          <p>昵称、头像、个性签名和代词公开显示，其他信息由你选择是否公开。</p>
        </header>
        <div className="settings-avatar-row">
          <div className="settings-avatar">
            {preview ? (
              <img src={preview} alt="当前头像" />
            ) : (
              <span>{Array.from(displayName.trim() || user.username)[0]}</span>
            )}
            {uploading && <span className="settings-avatar-progress">上传中…</span>}
          </div>
          <div className="settings-avatar-actions">
            <span className="settings-avatar-title">头像</span>
            <span className="settings-hint">静态图片，方形裁切显示。</span>
            <div className="settings-button-row">
              <button
                type="button"
                className="secondary settings-small-button"
                disabled={uploading || saving}
                onClick={() => input.current?.click()}
              >
                <ImagePlus size={16} />
                {preview ? '更换头像' : '上传头像'}
              </button>
              {preview && (
                <button
                  type="button"
                  className="settings-text-button"
                  disabled={uploading || saving}
                  onClick={removeAvatar}
                >
                  <X size={14} />
                  移除
                </button>
              )}
            </div>
            <input
              ref={input}
              className="settings-file-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="选择头像"
              onChange={(event) => {
                void chooseAvatar(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        </div>
        {uploadError && (
          <p className="error" role="alert">
            {uploadError}
          </p>
        )}
        <label className="settings-field">
          <span className="settings-label">昵称</span>
          <input
            value={displayName}
            maxLength={64}
            autoComplete="nickname"
            aria-invalid={Boolean(profileFields.displayName)}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setProfileSuccess('');
            }}
          />
          <span className="settings-hint">1–32 个字符，公开显示。</span>
          {profileFields.displayName && (
            <span className="error" role="alert">
              {profileFields.displayName}
            </span>
          )}
        </label>
        <div className="settings-field">
          <span className="settings-label">登录用户名</span>
          <span className="settings-readonly">@{user.username}</span>
          <span className="settings-hint">登录用户名创建后不可修改。</span>
        </div>
        <label className="settings-field">
          <span className="settings-label">个性签名</span>
          <textarea
            value={details.bio}
            maxLength={160}
            rows={3}
            onChange={(event) => updateDetails('bio', event.target.value)}
          />
          <span className="settings-hint">最多 160 个字符，将显示在作品署名和个人主页。</span>
        </label>
        <label className="settings-field">
          <span className="settings-label">代词</span>
          <select
            value={details.pronouns}
            onChange={(event) => updateDetails('pronouns', event.target.value as Pronouns)}
          >
            <option value="not specified">不指定</option>
            <option value="they/them">they/them</option>
            <option value="he/him">he/him</option>
            <option value="she/her">she/her</option>
          </select>
        </label>
        <div className="settings-field">
          <label className="settings-label" htmlFor="profile-email">
            邮箱
          </label>
          <input
            id="profile-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={details.email}
            onChange={(event) => updateDetails('email', event.target.value)}
          />
          <label className="settings-check">
            <input
              type="checkbox"
              checked={details.showEmail}
              onChange={(event) => updateDetails('showEmail', event.target.checked)}
            />
            公开邮箱
          </label>
        </div>
        <div className="settings-field">
          <label className="settings-label" htmlFor="profile-location">
            所在地
          </label>
          <input
            id="profile-location"
            maxLength={100}
            autoComplete="address-level2"
            value={details.location}
            onChange={(event) => updateDetails('location', event.target.value)}
          />
          <label className="settings-check">
            <input
              type="checkbox"
              checked={details.showLocation}
              onChange={(event) => updateDetails('showLocation', event.target.checked)}
            />
            公开所在地
          </label>
        </div>
        <fieldset className="settings-social">
          <legend className="settings-label">自定义社交链接</legend>
          <p className="settings-hint">最多 5 个，支持 HTTP 或 HTTPS 链接。</p>
          {details.socialLinks.map((link, index) => (
            <div className="settings-social-row" key={socialLinkKeys.current[index]}>
              <label className="settings-field">
                <span className="settings-label">链接 {index + 1} 名称</span>
                <input
                  required
                  maxLength={50}
                  value={link.label}
                  onChange={(event) =>
                    updateDetails(
                      'socialLinks',
                      details.socialLinks.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label className="settings-field">
                <span className="settings-label">网址</span>
                <input
                  required
                  type="url"
                  pattern="https?://.+"
                  maxLength={2048}
                  value={link.url}
                  onChange={(event) =>
                    updateDetails(
                      'socialLinks',
                      details.socialLinks.map((item, i) =>
                        i === index ? { ...item, url: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="settings-text-button"
                aria-label={`移除链接 ${index + 1}`}
                onClick={() => {
                  socialLinkKeys.current.splice(index, 1);
                  updateDetails(
                    'socialLinks',
                    details.socialLinks.filter((_, i) => i !== index),
                  );
                }}
              >
                <X size={16} />
              </button>
            </div>
          ))}
          <button
            className="secondary settings-small-button"
            type="button"
            disabled={details.socialLinks.length >= 5}
            onClick={() => {
              socialLinkKeys.current.push(uuid());
              updateDetails('socialLinks', [...details.socialLinks, { label: '', url: '' }]);
            }}
          >
            添加链接
          </button>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={details.showSocialLinks}
              onChange={(event) => updateDetails('showSocialLinks', event.target.checked)}
            />
            公开社交链接
          </label>
        </fieldset>
        <fieldset className="settings-social">
          <legend className="settings-label">关注隐私</legend>
          <p className="settings-hint">关闭后，其他人只能查看人数，无法查看列表成员。</p>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={details.showFollowing}
              onChange={(event) => updateDetails('showFollowing', event.target.checked)}
            />
            公开我关注的用户列表
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={details.showFollowers}
              onChange={(event) => updateDetails('showFollowers', event.target.checked)}
            />
            公开我的粉丝列表
          </label>
        </fieldset>
        {Object.entries(profileFields)
          .filter(([key]) => key !== 'displayName')
          .map(([key, message]) => (
            <p className="error" role="alert" key={key}>
              {message}
            </p>
          ))}
        {profileError && (
          <p className="error" role="alert">
            {profileError}
          </p>
        )}
        {profileSuccess && (
          <p className="settings-success" role="status">
            {profileSuccess}
          </p>
        )}
        <div className="settings-card-footer">
          <button
            className="primary"
            type="submit"
            disabled={
              !profileValid || saving || uploading || (!nameDirty && !avatarDirty && !detailsDirty)
            }
          >
            {saving ? '正在保存…' : '保存个人资料'}
          </button>
        </div>
      </form>

      <form className="settings-card" onSubmit={changePassword}>
        <header className="settings-section-heading">
          <h2>登录密码</h2>
          <p>修改后其他设备上的登录会立即失效，当前设备保持登录。</p>
        </header>
        <label className="settings-field">
          <span className="settings-label">当前密码</span>
          <input
            type="password"
            value={currentPassword}
            autoComplete="current-password"
            aria-invalid={Boolean(passwordFields.currentPassword)}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setPasswordSuccess('');
            }}
          />
          {passwordFields.currentPassword && (
            <span className="error" role="alert">
              {passwordFields.currentPassword}
            </span>
          )}
        </label>
        <label className="settings-field">
          <span className="settings-label">新密码</span>
          <input
            type="password"
            value={newPassword}
            autoComplete="new-password"
            aria-invalid={Boolean(passwordFields.newPassword)}
            onChange={(event) => {
              setNewPassword(event.target.value);
              setPasswordSuccess('');
            }}
          />
          <span className="settings-hint">12–128 个字符，空格不会被移除。</span>
          {passwordFields.newPassword && (
            <span className="error" role="alert">
              {passwordFields.newPassword}
            </span>
          )}
        </label>
        <label className="settings-field">
          <span className="settings-label">确认新密码</span>
          <input
            type="password"
            value={confirmPassword}
            autoComplete="new-password"
            aria-invalid={Boolean(passwordFields.confirmPassword)}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setPasswordSuccess('');
            }}
          />
          {passwordFields.confirmPassword && (
            <span className="error" role="alert">
              {passwordFields.confirmPassword}
            </span>
          )}
        </label>
        {passwordError && (
          <p className="error" role="alert">
            {passwordError}
          </p>
        )}
        {passwordSuccess && (
          <p className="settings-success" role="status">
            {passwordSuccess}
          </p>
        )}
        <div className="settings-card-footer">
          <button
            className="primary"
            type="submit"
            disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
          >
            {changingPassword ? '正在更新…' : '更新密码'}
          </button>
        </div>
      </form>
    </div>
  );
}
