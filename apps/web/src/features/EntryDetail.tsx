import type { Entry, EntryLink, FileAsset } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, FileText, Link2, Maximize2, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage, useAuth } from '../app/api';
import { useIsMobile } from '../app/useIsMobile';
import { Comments } from '../components/Comments';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';
import { EntryActions } from '../components/EntryActions';
import { EntryIdentity } from '../components/EntryIdentity';
import { AttributeBadges } from '../components/MasonryFeed';
import { UserAvatar } from '../components/UserAvatar';
import '../components/gallery-content.css';

const visibilityLabels: Record<Entry['visibility'], string> = {
  public: '所有人可见',
  registered: '注册用户可见',
  followers: '作者的粉丝可见',
  following: '作者关注的人可见',
  private: '仅自己可见',
};

function dateLine(entry: Entry) {
  const date = new Date(entry.createdAt);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${visibilityLabels[entry.visibility]}`;
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Creator({ entry }: { entry: Entry }) {
  return (
    <Link to={`/users/${encodeURIComponent(entry.author.username)}`} className="creator">
      <UserAvatar user={entry.author} className="avatar avatar-large" />
      <span className="creator-identity">
        <span className="creator-name">{entry.author.displayName}</span>
        {entry.author.bio && <span className="creator-role">{entry.author.bio}</span>}
      </span>
    </Link>
  );
}

function TagList({ entry }: { entry: Entry }) {
  if (!entry.tags.length) return null;
  return (
    <div className="entry-tags">
      {entry.tags.map((tag) => (
        <Link key={tag} to={`/search?q=${encodeURIComponent(tag)}`}>
          # {tag}
        </Link>
      ))}
    </div>
  );
}

function Metadata({ entry }: { entry: Entry }) {
  return (
    <div className="entry-metadata">
      <span className="entry-date">{dateLine(entry)}</span>
      <EntryIdentity id={entry.id} />
    </div>
  );
}

function FileRow({ file }: { file: FileAsset }) {
  return (
    <a className="entry-file" href={file.downloadUrl} download>
      <span className="entry-file-icon">
        <FileText size={18} />
      </span>
      <span className="entry-file-copy">
        <span className="entry-file-name">{file.name}</span>
        <span className="entry-file-meta">
          {file.extension ? `${file.extension.replace('.', '').toUpperCase()} 文件 · ` : '文件 · '}
          {fileSize(file.bytes)}
        </span>
      </span>
      <Download size={16} className="entry-file-download" />
    </a>
  );
}

function LinkRow({ link }: { link: EntryLink }) {
  return (
    <a className="entry-link" href={link.url} target="_blank" rel="noreferrer">
      <span className="entry-file-icon">
        <Link2 size={18} />
      </span>
      <span className="entry-file-copy">
        <span className="entry-file-name">{link.host}</span>
        <span className="entry-file-meta">{link.url}</span>
      </span>
      <ExternalLink size={16} className="entry-file-download" />
    </a>
  );
}

function Attachments({ entry }: { entry: Entry }) {
  if (!entry.files.length && !entry.links.length) return null;
  return (
    <div className="entry-attachments">
      {entry.files.map((file) => (
        <FileRow file={file} key={file.id} />
      ))}
      {entry.links.map((link) => (
        <LinkRow link={link} key={link.url} />
      ))}
    </div>
  );
}

function Gallery({
  entry,
  selected,
  onSelect,
}: {
  entry: Entry;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const image = entry.images[Math.min(selected, entry.images.length - 1)];
  if (!image) return null;
  return (
    <section className="image-viewer">
      <AttributeBadges entry={entry} />
      <div className="image-canvas">
        <img key={image.id} src={image.originalUrl} alt={entry.title ?? `条目 #${entry.id}`} />
      </div>
      {entry.images.length > 1 && (
        <div className="image-thumbs">
          {entry.images.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={index === selected ? 'image-thumb active' : 'image-thumb'}
              aria-label={`查看第 ${index + 1} 张图片`}
              aria-pressed={index === selected}
              onClick={() => onSelect(index)}
            >
              <img src={item.thumbnailUrl} alt="" />
            </button>
          ))}
        </div>
      )}
      <div className="viewer-footer">
        <span className="muted">
          {image.originalWidth} × {image.originalHeight} px · {image.format.toUpperCase()}
        </span>
        <a className="view-original" href={image.originalUrl} target="_blank" rel="noreferrer">
          <Maximize2 size={16} />
          查看原图
        </a>
      </div>
    </section>
  );
}

export function EntryDetail({ modal = false }: { modal?: boolean }) {
  const { id } = useParams();
  const { user, request } = useAuth();
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const [selection, setSelection] = useState<{ id: string; index: number } | null>(null);
  const [consentedEntry, setConsentedEntry] = useState<string | null>(null);
  const result = useQuery({
    queryKey: ['entries', 'detail', user?.id ?? 'guest', id],
    queryFn: ({ signal }) => request<Entry>(`/api/v1/entries/${id}`, { signal }),
  });
  const entry = result.data;
  const needsConsent = Boolean(entry?.declarations.nsfw && consentedEntry !== entry.id);
  const close = () => {
    if (needsConsent) {
      navigate('/', { replace: true });
      return;
    }
    if (modal) navigate(-1);
    else navigate('/');
  };
  useEffect(() => {
    if (!modal) return;
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, [modal]);
  const selected = selection && selection.id === entry?.id ? selection.index : 0;
  const selectImage = (index: number) => {
    if (entry) setSelection({ id: entry.id, index });
  };
  const closeButton = (
    <button className="close-button" type="button" aria-label="关闭详情" onClick={close}>
      <X size={18} />
    </button>
  );

  const moderationNotice =
    entry?.moderation &&
    (entry.moderation.titleHidden ||
      entry.moderation.bodyHidden ||
      entry.moderation.hiddenImageCount > 0 ||
      entry.moderation.hiddenFileCount > 0 ||
      entry.moderation.hiddenLinkCount > 0) ? (
      <aside className="entry-moderation-notice" role="status">
        <strong>部分内容已被管理人员隐藏</strong>
        <p>
          {[
            entry.moderation.titleHidden && '标题',
            entry.moderation.bodyHidden && '正文',
            entry.moderation.hiddenImageCount > 0 && `${entry.moderation.hiddenImageCount} 张图片`,
            entry.moderation.hiddenFileCount > 0 && `${entry.moderation.hiddenFileCount} 个文件`,
            entry.moderation.hiddenLinkCount > 0 && `${entry.moderation.hiddenLinkCount} 个链接`,
          ]
            .filter(Boolean)
            .join('、')}
          不可公开查看。
        </p>
      </aside>
    ) : null;
  let content: ReactNode;
  if (!entry) {
    content = (
      <section className="detail-status">
        <div className="detail-header">
          <span />
          {closeButton}
        </div>
        {result.isPending ? (
          <p role="status">正在加载条目…</p>
        ) : (
          <>
            <p className="error" role="alert">
              {errorMessage(result.error)}
            </p>
            <button type="button" className="secondary" onClick={() => void result.refetch()}>
              重试
            </button>
          </>
        )}
      </section>
    );
  } else if (entry.moderation?.hidden) {
    content = (
      <section className="detail-status">
        <div className="detail-header">
          <span>条目管理通知</span>
          {closeButton}
        </div>
        <h1>此条目已隐藏</h1>
        <p>
          该条目已被管理人员限制展示，或已无可公开展示的正文与附件。原始内容不会在此显示，评论及互动已暂停。
        </p>
        {entry.canEdit && (
          <Link to={`/entries/${entry.id}/edit`}>查看原文并编辑（不会自动解除限制）</Link>
        )}
      </section>
    );
  } else if (needsConsent) {
    content = (
      <section className="detail-status nsfw-consent" aria-labelledby="nsfw-consent-title">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <AttributeBadges entry={entry} />
        <h1 id="nsfw-consent-title">此条目包含 NSFW 内容</h1>
        <p>内容可能不适合在公共场合查看。确认后才会展示图片、正文和附件。</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => navigate('/', { replace: true })}
          >
            返回主页
          </button>
          <button type="button" className="primary" onClick={() => setConsentedEntry(entry.id)}>
            确认查看
          </button>
        </div>
      </section>
    );
  } else if (mobile) {
    content = (
      <article className="detail-page">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <Metadata entry={entry} />
        {moderationNotice}
        <Comments key={entry.id} entryId={entry.id}>
          <div className="detail-scroll">
            {entry.images.length > 0 && (
              <>
                <div className="mobile-gallery">
                  <Gallery entry={entry} selected={selected} onSelect={selectImage} />
                </div>
                {entry.title && <h1>{entry.title}</h1>}
              </>
            )}
            {entry.images.length === 0 && entry.title && <h1>{entry.title}</h1>}
            {entry.images.length === 0 && <AttributeBadges entry={entry} />}
            {entry.body && <div className="detail-body">{entry.body}</div>}
            <TagList entry={entry} />
            <Attachments entry={entry} />
          </div>
        </Comments>
        <EntryActions
          entry={entry}
          onDelete={() => setDeleting(entry)}
          variant={entry.images.length ? 'image' : 'text'}
          mobile
        />
      </article>
    );
  } else if (entry.images.length > 0) {
    content = (
      <article className="detail-layout image-detail">
        <Gallery entry={entry} selected={selected} onSelect={selectImage} />
        <section className="detail-information">
          {moderationNotice}
          <Comments key={entry.id} entryId={entry.id}>
            <div className="detail-top">
              <div className="detail-header image-header">{closeButton}</div>
              <div className="detail-artwork">
                <EntryIdentity id={entry.id} />
                {entry.title && <h1>{entry.title}</h1>}
                <span className="entry-date">{dateLine(entry)}</span>
                {entry.body && <div className="detail-body image-body">{entry.body}</div>}
                <TagList entry={entry} />
              </div>
              <Creator entry={entry} />
              <div className="detail-divider" />
              <Attachments entry={entry} />
            </div>
          </Comments>
          <EntryActions entry={entry} onDelete={() => setDeleting(entry)} variant="image" />
        </section>
      </article>
    );
  } else {
    content = (
      <article className="detail-layout text-detail">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <Metadata entry={entry} />
        <AttributeBadges entry={entry} />
        {moderationNotice}
        <Comments key={entry.id} entryId={entry.id}>
          <div className="detail-scroll">
            {entry.title && <h1>{entry.title}</h1>}
            {entry.body && <div className="detail-body">{entry.body}</div>}
            <TagList entry={entry} />
            <Attachments entry={entry} />
          </div>
        </Comments>
        <EntryActions entry={entry} onDelete={() => setDeleting(entry)} variant="text" />
      </article>
    );
  }

  return modal ? (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Backdrop clicks complement native Escape/onCancel and the close button.
    <dialog
      ref={dialog}
      className={[
        'entry-dialog',
        entry?.images.length && !needsConsent ? 'artwork-dialog' : '',
        mobile ? 'mobile-detail' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="条目详情"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }
      }}
    >
      {content}
      <ConfirmDeleteDialog
        entry={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          close();
        }}
      />
    </dialog>
  ) : (
    <main className="standalone-detail">
      {content}
      <ConfirmDeleteDialog
        entry={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          close();
        }}
      />
    </main>
  );
}
