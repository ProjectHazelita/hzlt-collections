import type {
  Entry,
  EntryInput,
  EntryPatch,
  TagsResponse,
  UploadAccepted,
  UploadKind,
  UploadStatus,
} from '@hcl/contracts';
import { ArrowLeft, FileText, Link2, Plus, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, type Location, useLocation, useNavigate, useParams } from 'react-router';
import { ApiError, errorMessage, isCancelled, queryClient, useAuth } from '../../app/api';
import './composer.css';

const MAX_IMAGES = 20;
const MAX_FILES = 5;
const MAX_LINKS = 5;

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
const uploadError = (status: UploadStatus) =>
  status.kind === 'file'
    ? '文件处理失败，请重新选择。'
    : (imageErrors[status.errorCode ?? ''] ??
      `图片处理失败（${status.errorCode ?? '未知错误'}），请重新选择图片。`);
const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const formatLabel = (extension: string) =>
  extension ? `${extension.replace('.', '').toUpperCase()} 文件` : '文件';
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

type ImageItem = {
  key: string;
  assetId?: string;
  file?: File;
  preview: string;
  name: string;
  uploading: boolean;
  error: string;
  upload?: UploadStatus;
};
type FileItem = {
  key: string;
  assetId?: string;
  file?: File;
  name: string;
  bytes: number;
  extension: string;
  uploading: boolean;
  error: string;
  upload?: UploadStatus;
};
type LinkItem = { key: string; url: string };

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
  const [images, setImages] = useState<ImageItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const replaceImage = useRef<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const objectUrls = useRef(new Set<string>());
  const saveController = useRef<AbortController | null>(null);
  const submitIdentity = useRef<{ signature: string; key: string } | null>(null);
  const savingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
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
        setImages(
          next.images.map((image) => ({
            key: image.id,
            assetId: image.id,
            preview: image.thumbnailUrl,
            name: image.name,
            uploading: false,
            error: '',
            upload: {
              id: image.id,
              kind: 'image',
              name: image.name,
              status: 'ready',
              width: image.width,
              height: image.height,
            },
          })),
        );
        setFiles(
          next.files.map((file) => ({
            key: file.id,
            assetId: file.id,
            name: file.name,
            bytes: file.bytes,
            extension: file.extension,
            uploading: false,
            error: '',
            upload: {
              id: file.id,
              kind: 'file',
              name: file.name,
              status: 'ready',
            },
          })),
        );
        setLinks(next.links.map((link) => ({ key: uuid(), url: link.url })));
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

  const patchImage = (key: string, patch: Partial<ImageItem>) =>
    setImages((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  const patchFile = (key: string, patch: Partial<FileItem>) =>
    setFiles((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  async function poll(
    kind: UploadKind,
    key: string,
    accepted: UploadAccepted,
    controller: AbortController,
  ) {
    await pause(1000, controller.signal);
    if (controller.signal.aborted) return;
    let status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
      signal: controller.signal,
    });
    while (status.status === 'pending') {
      await pause(1000, controller.signal);
      if (controller.signal.aborted) return;
      status = await request<UploadStatus>(`/api/v1/uploads/${accepted.id}`, {
        signal: controller.signal,
      });
    }
    if (!mounted.current || controller.signal.aborted) return;
    if (kind === 'image') {
      patchImage(key, {
        upload: status,
        uploading: false,
        error: status.status === 'failed' ? uploadError(status) : '',
        assetId: status.status === 'ready' ? accepted.id : undefined,
      });
    } else {
      patchFile(key, {
        upload: status,
        uploading: false,
        error: status.status === 'failed' ? uploadError(status) : '',
        assetId: status.status === 'ready' ? accepted.id : undefined,
      });
    }
  }

  async function startUpload(kind: UploadKind, file: File, key: string) {
    const controller = new AbortController();
    controllers.current.set(key, controller);
    const captured = epoch.current;
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    try {
      const accepted = await request<UploadAccepted>('/api/v1/uploads', {
        method: 'POST',
        body: form,
        idempotencyKey: key,
        signal: controller.signal,
      });
      if (!mounted.current || captured !== epoch.current) return;
      if (kind === 'image') patchImage(key, { assetId: accepted.id });
      else patchFile(key, { assetId: accepted.id });
      await poll(kind, key, accepted, controller);
    } catch (cause) {
      if (!mounted.current || captured !== epoch.current || isCancelled(cause)) return;
      if (kind === 'image') patchImage(key, { uploading: false, error: errorMessage(cause) });
      else patchFile(key, { uploading: false, error: errorMessage(cause) });
    } finally {
      controllers.current.delete(key);
    }
  }

  function changed() {
    submitIdentity.current = null;
    setSubmitError('');
    setFields({});
  }

  function addImages(selected: FileList | null) {
    if (!selected?.length) return;
    const replacing = replaceImage.current;
    replaceImage.current = null;
    const room = MAX_IMAGES - images.length + (replacing ? 1 : 0);
    if (room <= 0) {
      setSubmitError(`最多添加 ${MAX_IMAGES} 张图片。`);
      return;
    }
    const list = Array.from(selected).slice(0, replacing ? 1 : room);
    if (!replacing && selected.length > room) setSubmitError(`最多添加 ${MAX_IMAGES} 张图片。`);
    if (replacing) removeImage(replacing);
    for (const file of list) {
      const key = uuid();
      const preview = URL.createObjectURL(file);
      objectUrls.current.add(preview);
      const item: ImageItem = {
        key,
        file,
        preview,
        name: file.name,
        uploading: true,
        error: '',
      };
      setImages((current) => [...current, item]);
      void startUpload('image', file, key);
    }
    changed();
  }

  function addFiles(selected: FileList | null, replaceKey?: string) {
    if (!selected?.length) return;
    const room = replaceKey ? 1 : MAX_FILES - files.length;
    if (room <= 0) {
      setSubmitError(`最多添加 ${MAX_FILES} 个文件。`);
      return;
    }
    const list = Array.from(selected).slice(0, room);
    if (!replaceKey && selected.length > room) setSubmitError(`最多添加 ${MAX_FILES} 个文件。`);
    const items = list.map((file) => ({
      key: uuid(),
      file,
      name: file.name,
      bytes: file.size,
      extension: file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '',
      uploading: true,
      error: '',
    }));
    if (replaceKey) {
      const replacement = items[0];
      if (!replacement) return;
      setFiles((current) =>
        current.map((entry) => (entry.key === replaceKey ? replacement : entry)),
      );
    } else {
      setFiles((current) => [...current, ...items]);
    }
    for (const [index, item] of items.entries()) {
      const file = list[index];
      if (file) void startUpload('file', file, item.key);
    }
    changed();
  }

  function removeImage(key: string) {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setImages((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item?.file && objectUrls.current.delete(item.preview)) URL.revokeObjectURL(item.preview);
      return current.filter((entry) => entry.key !== key);
    });
    changed();
  }

  function removeFile(key: string) {
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    setFiles((current) => current.filter((entry) => entry.key !== key));
    changed();
  }

  function addLink() {
    if (links.length >= MAX_LINKS) {
      setSubmitError(`最多添加 ${MAX_LINKS} 个链接。`);
      return;
    }
    setLinks((current) => [...current, { key: uuid(), url: '' }]);
    changed();
  }

  const linkValid = (value: string) => {
    if (!value.trim()) return false;
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  };
  const filledLinks = links.filter((link) => link.url.trim());
  const invalidLink = filledLinks.find((link) => !linkValid(link.url));
  const allReady =
    images.every((item) => !item.uploading && !item.error && item.assetId) &&
    files.every((item) => !item.uploading && !item.error && item.assetId);
  const hasAttachment = images.length > 0 || files.length > 0 || filledLinks.length > 0;
  const valid =
    length(title.trim()) <= 200 &&
    length(body) <= 10000 &&
    (hasAttachment || Boolean(body.trim())) &&
    allReady &&
    !invalidLink;
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
      imageIds: images.map((item) => item.assetId!),
      fileIds: files.map((item) => item.assetId!),
      links: filledLinks.map((link) => ({ url: link.url.trim() })),
      tags,
      declarations: { nsfw, aiGenerated },
    };
    const input: EntryInput = { ...content, body, tags, declarations: { nsfw, aiGenerated } };
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
      const home: Location = { pathname: '/', search: '', hash: '', state: null, key: 'home' };
      if (id && location.key !== 'default') {
        // Editing returns to the view that opened the editor, usually the entry modal over its feed.
        navigate(-1);
      } else {
        // Publishing replaces the form with the feed, then opens the new entry over it.
        navigate('/', { replace: true });
        navigate(`/entries/${saved.id}`, { state: { backgroundLocation: home } });
      }
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

  const typeLabel = images.length
    ? '图片条目'
    : files.length && filledLinks.length
      ? '文件与链接条目'
      : files.length
        ? '文件条目'
        : filledLinks.length
          ? '链接条目'
          : '文字条目';

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
          <section className="composer-editor" aria-label="条目内容">
            <div className="composer-field">
              <div className="composer-label">
                <span>标题（可选）</span>
              </div>
              <input
                id="composer-title"
                value={title}
                placeholder="给这条内容起个名字"
                maxLength={200}
                onChange={(event) => {
                  changed();
                  setTitle(event.target.value);
                }}
              />
            </div>
            <div className="composer-attach-toolbar">
              <button
                type="button"
                className="composer-attach"
                disabled={saving || images.length >= MAX_IMAGES}
                onClick={() => imageInput.current?.click()}
              >
                ＋ 图片
              </button>
              <button
                type="button"
                className="composer-attach"
                disabled={saving || links.length >= MAX_LINKS}
                onClick={addLink}
              >
                ↗ 链接
              </button>
              <button
                type="button"
                className="composer-attach"
                disabled={saving || files.length >= MAX_FILES}
                onClick={() => fileInput.current?.click()}
              >
                ＋ 文件
              </button>
            </div>
            <input
              ref={imageInput}
              className="composer-file-input"
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="选择图片"
              disabled={saving}
              onChange={(event) => {
                addImages(event.target.files);
                event.target.value = '';
              }}
            />
            <input
              ref={fileInput}
              className="composer-file-input"
              type="file"
              multiple
              aria-label="选择文件"
              disabled={saving}
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <input
              ref={replaceInput}
              className="composer-file-input"
              type="file"
              aria-label="更换文件"
              disabled={saving}
              onChange={(event) => {
                if (replaceTarget.current) addFiles(event.target.files, replaceTarget.current);
                replaceTarget.current = null;
                event.target.value = '';
              }}
            />

            {images.length > 0 && (
              <div className="composer-attachments">
                <div className="composer-attachment-header">
                  <span>已选 {images.length} 张图片</span>
                  <span className="composer-attachment-actions">
                    {images.length === 1 && (
                      <button
                        type="button"
                        className="composer-text-button framed"
                        disabled={saving || images[0]?.uploading}
                        onClick={() => {
                          replaceImage.current = images[0]?.key ?? null;
                          imageInput.current?.click();
                        }}
                      >
                        更换图片
                      </button>
                    )}
                    <button
                      type="button"
                      className="composer-text-button"
                      disabled={saving}
                      onClick={() => {
                        for (const item of images) removeImage(item.key);
                      }}
                    >
                      移除{images.length > 1 ? '全部' : ''}
                    </button>
                  </span>
                </div>
                <div
                  className={
                    images.length === 1 ? 'composer-image-grid single' : 'composer-image-grid'
                  }
                >
                  {images.map((item, index) => {
                    const long =
                      item.upload?.width && item.upload.height
                        ? item.upload.height / item.upload.width > 2.5
                        : false;
                    return (
                      <figure className="composer-image-tile" key={item.key}>
                        <div className="composer-image-frame">
                          <img src={item.preview} alt={item.name} />
                          {(nsfw || aiGenerated || long) && (
                            <span className="composer-image-badges">
                              {nsfw && <span>NSFW</span>}
                              {aiGenerated && <span>AI 生成</span>}
                              {long && <span>长图</span>}
                            </span>
                          )}
                          {item.uploading && <span className="composer-image-status">上传中…</span>}
                          {item.error && (
                            <span className="composer-image-status error" title={item.error}>
                              失败
                            </span>
                          )}
                          <button
                            type="button"
                            className="composer-image-remove"
                            aria-label={`移除图片 ${item.name}`}
                            disabled={saving}
                            onClick={() => removeImage(item.key)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                        <figcaption>
                          <span>{item.name}</span>
                          <span>
                            {item.upload?.width && item.upload.height
                              ? `${item.upload.width} × ${item.upload.height} px`
                              : index === 0
                                ? '第 1 张'
                                : `第 ${index + 1} 张`}
                          </span>
                        </figcaption>
                        {item.error && <p className="composer-item-error">{item.error}</p>}
                      </figure>
                    );
                  })}
                </div>
                <small className="composer-hint">
                  最多 {MAX_IMAGES} 张。发布后原图将原样公开，可能包含拍摄位置等 EXIF 元数据。
                </small>
              </div>
            )}

            {files.map((item) => (
              <div className="composer-attachment" key={item.key}>
                <div className="composer-attachment-header">
                  <span>文件附件</span>
                  <span className="composer-attachment-actions">
                    <button
                      type="button"
                      className="composer-text-button framed"
                      disabled={saving || item.uploading}
                      onClick={() => {
                        replaceTarget.current = item.key;
                        replaceInput.current?.click();
                      }}
                    >
                      更换文件
                    </button>
                    <button
                      type="button"
                      className="composer-text-button"
                      disabled={saving}
                      onClick={() => removeFile(item.key)}
                    >
                      移除
                    </button>
                  </span>
                </div>
                <div className="composer-file-row">
                  <span className="composer-file-icon">
                    <FileText size={20} />
                  </span>
                  <span className="composer-file-copy">
                    <span className="composer-file-name">{item.name}</span>
                    <span className="composer-file-meta">
                      {formatLabel(item.extension)} · {fileSize(item.bytes)}
                      {item.uploading ? ' · 上传中…' : item.error ? ' · 失败' : ''}
                    </span>
                  </span>
                </div>
                {item.error && <p className="composer-item-error">{item.error}</p>}
                <small className="composer-hint">
                  已添加 {files.length} 个文件，发布成功后可供下载。
                </small>
              </div>
            ))}

            {links.map((item) => (
              <div className="composer-attachment" key={item.key}>
                <div className="composer-attachment-header">
                  <span>网页链接</span>
                  <button
                    type="button"
                    className="composer-text-button"
                    disabled={saving}
                    onClick={() => {
                      setLinks((current) => current.filter((link) => link.key !== item.key));
                      changed();
                    }}
                  >
                    移除
                  </button>
                </div>
                <label className="composer-link-row">
                  <span className="composer-file-icon">
                    <Link2 size={20} />
                  </span>
                  <input
                    value={item.url}
                    placeholder="https://"
                    inputMode="url"
                    maxLength={2048}
                    aria-label="链接地址"
                    onChange={(event) => {
                      setLinks((current) =>
                        current.map((link) =>
                          link.key === item.key ? { ...link, url: event.target.value } : link,
                        ),
                      );
                      changed();
                    }}
                  />
                </label>
                <small className="composer-hint">将以链接条目发布，正文可补充介绍。</small>
                {item.url.trim() && !linkValid(item.url) && (
                  <small className="error" role="alert">
                    请输入有效的 http 或 https 链接。
                  </small>
                )}
              </div>
            ))}

            <div className="composer-field">
              <div className="composer-label">
                <span>正文</span>
                <span className="composer-hint">{hasAttachment ? '选填' : '必填'}</span>
              </div>
              <textarea
                id="composer-body"
                value={body}
                required={!hasAttachment}
                rows={7}
                maxLength={10000}
                placeholder="记录一个想法，或者分享一些近况……"
                onChange={(event) => {
                  changed();
                  setBody(event.target.value);
                }}
              />
            </div>
            <div className="composer-counts">
              图片 {images.length}/{MAX_IMAGES} · 文件 {files.length}/{MAX_FILES} · 链接{' '}
              {filledLinks.length}/{MAX_LINKS}
            </div>
          </section>
          <fieldset className="composer-panel" disabled={saving}>
            <legend className="composer-sr-only">条目设置</legend>
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
                <span>内容声明</span>
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
              <small className="composer-hint">选中的声明将随内容一同展示</small>
            </div>
            <p className="composer-hint">填写正文或添加图片、文件、链接后，即可发布。</p>
            <div className="composer-summary">
              <span>{typeLabel}</span>
              <span>公开发布</span>
            </div>
          </fieldset>
        </div>
      </form>
    </section>
  );
}
