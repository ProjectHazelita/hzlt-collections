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
import { Link, useNavigate, useParams } from 'react-router';
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
  const [focused, setFocused] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately reissues failed tag requests.
  useEffect(() => {
    if (!focused || disabled) return;
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
  }, [value, focused, disabled, request, epoch, retry]);
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
    <div className="composer-field">
      <label htmlFor="composer-tag">
        标签 <span className="muted">{tags.length}/10</span>
      </label>
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
        <div className="composer-tag-entry">
          <input
            id="composer-tag"
            value={value}
            disabled={disabled || tags.length >= 10}
            autoComplete="off"
            aria-describedby="composer-tag-help"
            onFocus={() => setFocused(true)}
            onChange={(event) => {
              setValue(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                add(value);
              }
              if (event.key === 'Escape') setFocused(false);
            }}
          />
          <button
            type="button"
            disabled={disabled || !value.trim() || tags.length >= 10}
            onClick={() => add(value)}
            aria-label="添加标签"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <small id="composer-tag-help" className="muted">
        输入标签后按回车或点击加号添加，每个最多 32 字符。
      </small>
      {error && (
        <small role="alert" className="error">
          {error}
        </small>
      )}
      {focused && !disabled && (
        <div className="composer-suggestions">
          {suggestions
            .filter((tag) => !tags.some((selected) => tagKey(selected) === tagKey(tag)))
            .map((tag) => (
              <button type="button" className="secondary" key={tag} onClick={() => add(tag)}>
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
          <button type="button" className="composer-tag-done" onClick={() => setFocused(false)}>
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
  const [uploadRetry, setUploadRetry] = useState(0);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: uploadRetry deliberately restarts processing of the selected file.
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
  }, [selection, uploadRetry, request, epoch]);

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
      navigate(`/entries/${saved.id}`);
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
  return (
    <section className="composer-page">
      <form className="composer-workspace" onSubmit={submit}>
        <header className="composer-header">
          <div>
            <Link to={id ? `/entries/${id}` : '/'} aria-label="返回" className="composer-back">
              <ArrowLeft size={20} />
            </Link>
            <h1 className="page-heading">{id ? '编辑条目' : '发布条目'}</h1>
          </div>
          <button className="primary" type="submit" disabled={!valid || saving}>
            {saving ? '正在保存…' : id ? '保存修改' : '发布条目'}
          </button>
        </header>
        {submitError && (
          <div role="alert" className="error">
            {submitError}
            {Object.entries(fields).map(([field, message]) => (
              <p key={field}>
                {field}：{message}
              </p>
            ))}
          </div>
        )}
        <div className="composer-layout">
          <section className="composer-preview" aria-label="条目预览">
            <div className="composer-preview-toolbar">
              <span>{hasImage ? (id ? '已发布图片' : '已选 1 张图片') : '纯文字条目'}</span>
              {!id && (
                <div>
                  {selection && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={saving}
                      onClick={removeImage}
                    >
                      移除
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={saving}
                    onClick={() => inputRef.current?.click()}
                  >
                    <ImagePlus size={16} aria-hidden="true" />
                    {selection ? '更换图片' : '添加图片'}
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
            {image ? (
              <div className="composer-image">
                <img src={image} alt={title.trim() || '所选图片预览'} />
                <div className="composer-badges">
                  {nsfw && <span>NSFW</span>}
                  {aiGenerated && <span>AI 生成</span>}
                </div>
              </div>
            ) : (
              <div className="composer-text-preview">
                {title.trim() && <h2>{title}</h2>}
                {body ? (
                  <p>{body}</p>
                ) : (
                  <div className="composer-empty">
                    <ImagePlus size={32} aria-hidden="true" />
                    <p>写下正文即可发布纯文字条目，也可以添加一张静态图片。</p>
                  </div>
                )}
              </div>
            )}
            {selection && (
              <div className="composer-file-info">
                <span>{selection.file.name}</span>
                <span>
                  {(selection.file.size / 1024 / 1024).toFixed(2)} MiB
                  {upload?.width && upload.height ? ` · ${upload.width} × ${upload.height} px` : ''}
                </span>
              </div>
            )}
            {uploading && (
              <p className="muted" role="status">
                {upload ? '图片已上传，正在校验和处理…' : '正在上传图片…'}
              </p>
            )}
            {upload?.status === 'ready' && <p role="status">图片已就绪</p>}
            {uploadError && (
              <div role="alert" className="error">
                <p>{uploadError}</p>
                {upload?.status !== 'failed' && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setUploadRetry(uploadRetry + 1)}
                  >
                    重试上传
                  </button>
                )}
                <button type="button" disabled={saving} onClick={() => inputRef.current?.click()}>
                  重新选择图片
                </button>
              </div>
            )}
            {id && <small className="muted">已发布条目的图片不可替换或移除。</small>}
            {hasImage && (
              <small className="composer-warning">
                发布后原图将原样公开，可能包含拍摄位置等 EXIF 元数据。请确认图片适合公开。
              </small>
            )}
            {!hasImage && !id && (
              <small className="muted">支持静态 JPEG、PNG、WebP、GIF；不支持 SVG 和动图。</small>
            )}
          </section>
          <fieldset className="composer-panel" disabled={saving}>
            <legend className="composer-sr-only">条目内容</legend>
            <div className="composer-field">
              <label htmlFor="composer-title">
                标题（可选）<span className="muted">{length(title.trim())}/200</span>
              </label>
              <input
                id="composer-title"
                value={title}
                onChange={(event) => {
                  changed();
                  setTitle(event.target.value);
                }}
                aria-invalid={length(title.trim()) > 200}
              />
              {length(title.trim()) > 200 && <small className="error">标题最多 200 字符。</small>}
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
              <label htmlFor="composer-body">
                正文
                <span className="muted">
                  {hasImage ? '选填' : '必填'} · {length(body)}/10000
                </span>
              </label>
              <textarea
                id="composer-body"
                value={body}
                required={!hasImage}
                rows={6}
                onChange={(event) => {
                  changed();
                  setBody(event.target.value);
                }}
                aria-invalid={length(body) > 10000}
              />
              {length(body) > 10000 && <small className="error">正文最多 10000 字符。</small>}
            </div>
            <div className="composer-field">
              <span>条目属性</span>
              <label className="composer-choice">
                <input
                  type="checkbox"
                  checked={nsfw}
                  onChange={(event) => {
                    changed();
                    setNsfw(event.target.checked);
                  }}
                />
                <span>
                  NSFW<small>含不适宜在公共场合浏览的内容</small>
                </span>
              </label>
              <label className="composer-choice">
                <input
                  type="checkbox"
                  checked={aiGenerated}
                  onChange={(event) => {
                    changed();
                    setAiGenerated(event.target.checked);
                  }}
                />
                <span>
                  AI 生成<small>条目主要由 AI 生成</small>
                </span>
              </label>
              <small className="muted">仅选中的标记会显示在条目上。</small>
            </div>
          </fieldset>
        </div>
      </form>
    </section>
  );
}
