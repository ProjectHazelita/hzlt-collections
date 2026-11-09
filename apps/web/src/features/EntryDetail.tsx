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

function dateLine(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 公开`;
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Creator({ entry }: { entry: Entry }) {
  return (
    <span className="creator">
      <span className="avatar avatar-large">{Array.from(entry.author.username)[0]}</span>
      <span className="creator-identity">
        <span className="creator-name">{entry.author.username}</span>
        <span className="creator-role">
          {entry.author.role === 'owner' ? '站点所有者' : '注册用户'}
        </span>
      </span>
    </span>
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
      <span className="entry-date">{dateLine(entry.createdAt)}</span>
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
  const result = useQuery({
    queryKey: ['entries', 'detail', user?.id ?? 'guest', id],
    queryFn: ({ signal }) => request<Entry>(`/api/v1/entries/${id}`, { signal }),
  });
  const entry = result.data;
  const close = () => {
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
  } else if (mobile) {
    content = (
      <article className="detail-page">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <Metadata entry={entry} />
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
          <Comments entryId={entry.id} />
        </div>
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
          <div className="detail-top">
            <div className="detail-header image-header">{closeButton}</div>
            <div className="detail-artwork">
              <EntryIdentity id={entry.id} />
              {entry.title && <h1>{entry.title}</h1>}
              <span className="entry-date">{dateLine(entry.createdAt)}</span>
              {entry.body && <div className="detail-body image-body">{entry.body}</div>}
              <TagList entry={entry} />
            </div>
            <Creator entry={entry} />
            <div className="detail-divider" />
            <Attachments entry={entry} />
          </div>
          <Comments entryId={entry.id} />
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
        <div className="detail-scroll">
          {entry.title && <h1>{entry.title}</h1>}
          {entry.body && <div className="detail-body">{entry.body}</div>}
          <TagList entry={entry} />
          <Attachments entry={entry} />
          <Comments entryId={entry.id} />
        </div>
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
        entry?.images.length ? 'artwork-dialog' : '',
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
