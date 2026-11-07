import type {
  Entry,
  EntryInput,
  EntryPatch,
  TagsResponse,
  UploadAccepted,
  UploadStatus,
} from '@hcl/contracts';
import { ArrowLeft, ImagePlus, Plus, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, errorMessage, isCancelled, queryClient, useAuth } from '../../app/api';
import './composer.css';

function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const length = (value: string) => Array.from(value).length;
const tagKey = (value: string) => value.trim().normalize('NFKC').toLowerCase();
const imageErrors: Record<string, string> = {
  ANIMATION_NOT_SUPPORTED: '不支持动图，请选择静态图片。',
  UNSUPPORTED_IMAGE_TYPE: '仅支持静态 JPEG、PNG、WebP 和 GIF，不支持 SVG。',
  IMAGE_TOO_LARGE: '图片超过服务器允许的文件大小或尺寸。',
  IMAGE_TIMEOUT: '图片处理超时，请重新选择图片。',
};

function TagInput({
  tags,
  onChange,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
}) {
  const { request, epoch } = useAuth();
  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState<TagsResponse>([]);
  const [error, setError] = useState('');
  const [suggestionError, setSuggestionError] = useState('');
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately reissues failed tag requests.
  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController();
    const captured = epoch.current;
    setSuggestionError('');
    setSuggestions([]);
    const timer = setTimeout(() => {
      void request<TagsResponse>(`/api/v1/tags?q=${encodeURIComponent(value.trim())}&limit=20`, {
        signal: controller.signal,
      })
        .then((next) => {
          if (!controller.signal.aborted && captured === epoch.current) setSuggestions(next);
        })
        .catch((cause) => {
          if (!controller.signal.aborted && captured === epoch.current && !isCancelled(cause))
            setSuggestionError(errorMessage(cause));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, open, disabled, request, epoch, retry]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!field.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  function add(raw: string) {
    const name = raw.trim();
    const normalized = tagKey(name);
    if (!name || length(normalized) > 32 || /\p{Cc}/u.test(name) || /\p{Cc}/u.test(normalized)) {
      setError('标签须为 1–32 个字符，不能包含控制字符。');
      return;
    }
    if (tags.some((tag) => tagKey(tag) === normalized)) {
      setError('该标签已添加。');
      return;
    }
    if (tags.length >= 10) {
      setError('最多添加 10 个标签。');
      return;
    }
    onChange([...tags, name]);
    setValue('');
    setError('');
  }
  return (
    <div className="composer-field composer-tag-field" ref={field}>
      <div className="composer-label">
        <span>标签</span>
      </div>
      <div className="composer-tags">
        {tags.map((tag) => (
          <span className="composer-tag" key={tagKey(tag)}>
            {tag}
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除标签 ${tag}`}
              onClick={() => {
                onChange(tags.filter((item) => item !== tag));
                setError('');
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <button
          className="composer-add-tag"
          type="button"
          disabled={disabled || tags.length >= 10}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Plus size={14} aria-hidden="true" />
          添加标签
        </button>
      </div>
      <small className="composer-hint">输入标签后按回车添加</small>
      {error && (
        <small role="alert" className="error">
          {error}
        </small>
      )}
      {open && !disabled && (
        <div className="composer-tag-picker">
          <input
            ref={input}
            value={value}
            aria-label="标签名称"
            placeholder="输入标签名称…"
            autoComplete="off"
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                add(value);
              }
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          {tags.length > 0 && <p className="composer-hint">已选择：{tags.join('、')}</p>}
          <div className="composer-suggestions">
            {suggestions
              .filter((tag) => !tags.some((selected) => tagKey(selected) === tagKey(tag)))
              .map((tag) => (
                <button
                  type="button"
                  className="composer-suggestion"
                  key={tag}
                  onClick={() => add(tag)}
                >
                  {tag}
                </button>
              ))}
            {suggestionError && (
              <div className="error" role="alert">
                标签建议：{suggestionError}{' '}
                <button type="button" onClick={() => setRetry(retry + 1)}>
                  重试
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="composer-tag-done secondary"
            onClick={() => setOpen(false)}
          >
            完成
          </button>
        </div>
      )}
    </div>
  );
}

export function EntryComposer() {
  const { id } = useParams();
  return <ComposerForm key={id ?? 'new'} id={id} />;
}

function ComposerForm({ id }: { id: string | undefined }) {
  const { request, epoch, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState('');
  const [loadRetry, setLoadRetry] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [nsfw, setNsfw] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [selection, setSelection] = useState<{ file: File; key: string } | null>(null);
  const [preview, setPreview] = useState('');
  const [upload, setUpload] = useState<UploadStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const submitIdentity = useRef<{ signature: string; key: string } | null>(null);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadController.current?.abort();
      saveController.current?.abort();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadRetry deliberately reloads the same entry after failure.
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const captured = epoch.current;
    setLoading(true);
    setLoadError('');
    void request<Entry>(`/api/v1/entries/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted || captured !== epoch.current) return;
        setEntry(next);
        setTitle(next.title ?? '');
        setBody(next.body);
        setTags(next.tags);
        setNsfw(next.declarations.nsfw);
        setAiGenerated(next.declarations.aiGenerated);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && captured === epoch.current && !isCancelled(cause))
          setLoadError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted && captured === epoch.current) setLoading(false);
      });
    return () => controller.abort();
  }, [id, request, epoch, loadRetry]);
  useEffect(() => {
    if (!selection) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(selection.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selection]);
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    uploadController.current = controller;
    const captured = epoch.current;
    let timer: number | undefined;
    const current = () => !controller.signal.aborted && captured === epoch.current;
    setUploading(true);
    setUploadError('');
    setUpload(null);
    async function poll(assetId: string): Promise<void> {
      try {
        const status = await request<UploadStatus>(`/api/v1/uploads/${assetId}`, {
          signal: controller.signal,
        });
        if (!current()) return;
        setUpload(status);
        if (status.status === 'pending')
          timer = window.setTimeout(() => {
            void poll(assetId);
          }, 1000);
        else {
          setUploading(false);
          if (status.status === 'failed')
            setUploadError(
              imageErrors[status.errorCode ?? ''] ??
                `图片处理失败（${status.errorCode ?? '未知错误'}），请重新选择图片。`,
            );
        }
      } catch (cause) {
        fail(cause);
      }
    }
    function fail(cause: unknown) {
      if (current() && !isCancelled(cause)) {
        setUploading(false);
        setUploadError(errorMessage(cause));
      }
    }
    const form = new FormData();
    form.append('file', selection.file);
    void request<UploadAccepted>('/api/v1/uploads', {
      method: 'POST',
      body: form,
      idempotencyKey: selection.key,
      signal: controller.signal,
    })
      .then((accepted) => {
        if (!current()) return;
        setUpload(accepted);
        timer = window.setTimeout(() => {
          void poll(accepted.id);
        }, 1000);
      })
      .catch(fail);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selection, request, epoch]);

  function changed() {
    submitIdentity.current = null;
    setSubmitError('');
    setFields({});
  }
  function choose(file: File | undefined) {
    if (!file || id || savingRef.current) return;
    uploadController.current?.abort();
    changed();
    setUpload(null);
    setUploadError('');
    setSelection({ file, key: uuid() });
  }
  function removeImage() {
    uploadController.current?.abort();
    setSelection(null);
    setUpload(null);
    setUploadError('');
    setUploading(false);
    changed();
  }
  const hasImage = Boolean(entry?.asset || selection);
  const valid =
    length(title.trim()) <= 200 &&
    length(body) <= 10000 &&
    (hasImage || Boolean(body.trim())) &&
    (!selection || upload?.status === 'ready');
  const permitted = !id || Boolean(entry?.canEdit && entry.author.id === user?.id);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || savingRef.current || !permitted || loading) return;
    const captured = epoch.current;
    const controller = new AbortController();
    saveController.current = controller;
    const current = () =>
      mounted.current && !controller.signal.aborted && captured === epoch.current;
    const content: EntryPatch = {
      title: title.trim() || null,
      body,
      tags,
      declarations: { nsfw, aiGenerated },
    };
    const input: EntryInput = {
      ...content,
      body,
      tags,
      declarations: { nsfw, aiGenerated },
      assetId: upload?.status === 'ready' ? upload.id : null,
    };
    const signature = JSON.stringify(input);
    if (submitIdentity.current?.signature !== signature)
      submitIdentity.current = { signature, key: uuid() };
    savingRef.current = true;
    setSaving(true);
    setSubmitError('');
    setFields({});
    try {
      const saved = await request<Entry>(id ? `/api/v1/entries/${id}` : '/api/v1/entries', {
        method: id ? 'PATCH' : 'POST',
        json: id ? content : input,
        idempotencyKey: id ? undefined : submitIdentity.current.key,
        signal: controller.signal,
      });
      if (!current()) return;
      await queryClient.invalidateQueries();
      if (!current()) return;
      navigate(`/entries/${saved.id}`, { state: { backgroundLocation: location } });
    } catch (cause) {
      if (current() && !isCancelled(cause)) {
        setSubmitError(errorMessage(cause));
        if (cause instanceof ApiError) setFields(cause.fields ?? {});
      }
    } finally {
      if (current()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }
  if (loading)
    return (
      <section className="composer-page" aria-busy="true">
        <p role="status">正在加载条目…</p>
      </section>
    );
  if (loadError)
    return (
      <section className="composer-page">
        <p className="error" role="alert">
          {loadError}
        </p>
        <button type="button" onClick={() => setLoadRetry(loadRetry + 1)}>
          重试
        </button>
      </section>
    );
  if (!permitted)
    return (
      <section className="composer-page">
        <h1 className="page-heading">无法编辑此条目</h1>
        <p>只有作者可以编辑自己的条目。</p>
        <Link to={id ? `/entries/${id}` : '/'}>返回条目</Link>
      </section>
    );
  const image = entry?.asset?.originalUrl ?? preview;
  const status = id
    ? entry?.asset
      ? '已发布图片暂不支持替换'
      : '纯文字条目'
    : uploading
      ? '正在上传并校验图片…'
      : uploadError
        ? '上传失败'
        : selection
          ? '已选 1 张图片 · 可移除'
          : '未添加图片（可选）';
  const fileNote = entry?.asset
    ? `${entry.asset.width} × ${entry.asset.height} px · ${entry.asset.format.toUpperCase()}`
    : upload?.width && upload.height
      ? `${upload.width} × ${upload.height} px`
      : '公开发布';
  return (
    <section className="composer-page">
      <form className="composer-workspace" onSubmit={submit}>
        <header className="composer-header">
          <div className="composer-heading">
            <button
              type="button"
              className="composer-back"
              aria-label="返回"
              onClick={() => {
                if (location.key !== 'default') navigate(-1);
                else navigate(id ? `/entries/${id}` : '/');
              }}
            >
              <ArrowLeft size={20} />
            </button>
            <h1>{id ? '编辑条目' : '发布条目'}</h1>
          </div>
          <button className="primary composer-publish" type="submit" disabled={!valid || saving}>
            {saving ? '正在保存…' : id ? '保存修改' : '发布'}
          </button>
        </header>
        {submitError && (
          <div role="alert" className="composer-error">
            <p>{submitError}</p>
            {Object.entries(fields).map(([field, message]) => (
              <p key={field}>{message}</p>
            ))}
          </div>
        )}
        <div className="composer-layout">
          <section
            className="composer-preview"
            aria-label="条目预览"
            onDragOver={(event) => {
              if (!id) event.preventDefault();
            }}
            onDrop={(event) => {
              if (id) return;
              event.preventDefault();
              choose(event.dataTransfer.files?.[0]);
            }}
          >
            <div className="composer-status">
              <span>{status}</span>
              {!id && (
                <div className="composer-status-actions">
                  {selection && (
                    <button
                      type="button"
                      className="composer-small"
                      disabled={saving}
                      onClick={removeImage}
                    >
                      移除
                    </button>
                  )}
                  <button
                    type="button"
                    className="composer-small"
                    disabled={saving}
                    onClick={() => inputRef.current?.click()}
                  >
                    <ImagePlus size={16} aria-hidden="true" />
                    {selection ? '更换图片' : '选择图片'}
                  </button>
                </div>
              )}
            </div>
            {!id && (
              <input
                ref={inputRef}
                className="composer-file-input"
                type="file"
                aria-label="选择一张静态图片"
                accept="image/jpeg,image/png,image/webp,image/gif"
                disabled={saving}
                onChange={(event) => {
                  choose(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            )}
            {image && !uploadError ? (
              <div className="composer-image">
                <img src={image} alt={title.trim() || '所选图片预览'} />
                <div className="composer-badges">
                  {nsfw && <span>NSFW</span>}
                  {aiGenerated && <span>AI 生成</span>}
                </div>
              </div>
            ) : uploadError ? (
              <div className="composer-upload-failed">
                <div className="composer-notice" role="alert">
                  <p>图片未能上传</p>
                  <p>{uploadError}</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={saving}
                  onClick={() => inputRef.current?.click()}
                >
                  重新选择图片
                </button>
              </div>
            ) : (
              <div className="composer-empty">
                <p className="composer-empty-title">纯文字也可以直接发布</p>
                <p className="composer-empty-note">也可以选择或拖入一张图片，为文字附上画面。</p>
              </div>
            )}
            <div className="composer-file-info">
              <span>
                {selection ? selection.file.name : '支持单张图片，暂不支持多图或图文混排'}
              </span>
              <span>{fileNote}</span>
            </div>
            {uploading && !uploadError && (
              <p className="composer-hint" role="status">
                {upload ? '图片已上传，正在校验和处理…' : '正在上传图片…'}
              </p>
            )}
            {id && <small className="composer-hint">已发布条目的图片不可替换或移除。</small>}
            {hasImage && (
              <small className="composer-warning">
                发布后原图将原样公开，可能包含拍摄位置等 EXIF 元数据。请确认图片适合公开。
              </small>
            )}
            {!hasImage && !id && (
              <small className="composer-hint">
                支持静态 JPEG、PNG、WebP、GIF；不支持 SVG 和动图。
              </small>
            )}
          </section>
          <fieldset className="composer-panel" disabled={saving}>
            <legend className="composer-sr-only">条目内容</legend>
            <div className="composer-field">
              <div className="composer-label">
                <span>标题（可选）</span>
              </div>
              <input
                id="composer-title"
                value={title}
                placeholder="给这条内容起个名字，也可以留空"
                maxLength={200}
                onChange={(event) => {
                  changed();
                  setTitle(event.target.value);
                }}
              />
            </div>
            <TagInput
              tags={tags}
              disabled={saving}
              onChange={(next) => {
                changed();
                setTags(next);
              }}
            />
            <div className="composer-field">
              <div className="composer-label">
                <span>正文</span>
                <span className="composer-hint">{hasImage ? '选填' : '必填'}</span>
              </div>
              <textarea
                id="composer-body"
                value={body}
                required={!hasImage}
                rows={5}
                maxLength={10000}
                placeholder="写一点什么…"
                onChange={(event) => {
                  changed();
                  setBody(event.target.value);
                }}
              />
            </div>
            <div className="composer-field">
              <div className="composer-label">
                <span>作品属性</span>
              </div>
              <div className="composer-attributes">
                <label className="composer-attribute">
                  <input
                    type="checkbox"
                    checked={nsfw}
                    onChange={(event) => {
                      changed();
                      setNsfw(event.target.checked);
                    }}
                  />
                  <span className="composer-attribute-text">
                    <span className="composer-attribute-name">NSFW</span>
                    <span className="composer-hint">含不适宜在公共场合浏览的内容</span>
                  </span>
                </label>
                <label className="composer-attribute">
                  <input
                    type="checkbox"
                    checked={aiGenerated}
                    onChange={(event) => {
                      changed();
                      setAiGenerated(event.target.checked);
                    }}
                  />
                  <span className="composer-attribute-text">
                    <span className="composer-attribute-name">AI 生成</span>
                    <span className="composer-hint">作品主要由 AI 生成</span>
                  </span>
                </label>
              </div>
              <small className="composer-hint">选中的标记会显示在作品右上角</small>
            </div>
            <p className="composer-hint">填写正文或选择一张图片后，即可发布。</p>
          </fieldset>
        </div>
      </form>
    </section>
  );
}
