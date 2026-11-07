import type { Entry } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { Maximize2, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage, useAuth } from '../app/api';
import { useIsMobile } from '../app/useIsMobile';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';
import { EntryActions } from '../components/EntryActions';
import { EntryIdentity } from '../components/EntryIdentity';
import { AttributeBadges } from '../components/MasonryFeed';

function dateLine(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 公开`;
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

function TagList({ entry, inline = false }: { entry: Entry; inline?: boolean }) {
  if (!entry.tags.length) return null;
  return (
    <div className={inline ? 'entry-tags inline' : 'entry-tags'}>
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

export function EntryDetail({ modal = false }: { modal?: boolean }) {
  const { id } = useParams();
  const { user, request } = useAuth();
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [deleting, setDeleting] = useState<Entry | null>(null);
  const result = useQuery({
    queryKey: ['entries', 'detail', user?.id ?? 'guest', id],
    queryFn: ({ signal }) => request<Entry>(`/api/v1/entries/${id}`, { signal }),
  });
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
  const entry = result.data;
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
  } else if (entry.asset && mobile) {
    content = (
      <article className="detail-page">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <Metadata entry={entry} />
        <AttributeBadges entry={entry} />
        <div className="detail-scroll">
          <img
            className="mobile-artwork"
            src={entry.asset.originalUrl}
            alt={entry.title ?? `条目 #${entry.id}`}
          />
          {entry.title && <h1>{entry.title}</h1>}
          {entry.body && <div className="detail-body image-body">{entry.body}</div>}
          <TagList entry={entry} inline />
        </div>
        <EntryActions entry={entry} onDelete={() => setDeleting(entry)} variant="image" mobile />
      </article>
    );
  } else if (entry.asset) {
    content = (
      <article className="detail-layout image-detail">
        <section className="image-viewer">
          <AttributeBadges entry={entry} />
          <div className="image-canvas">
            <img src={entry.asset.originalUrl} alt={entry.title ?? `条目 #${entry.id}`} />
          </div>
          <div className="viewer-footer">
            <span className="muted">
              {entry.asset.width} × {entry.asset.height} px · {entry.asset.format.toUpperCase()}
            </span>
            <a
              className="view-original"
              href={entry.asset.originalUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Maximize2 size={16} />
              查看原图
            </a>
          </div>
        </section>
        <section className="detail-information">
          <div className="detail-top">
            <div className="detail-header image-header">{closeButton}</div>
            <div className="detail-artwork">
              <EntryIdentity id={entry.id} />
              {entry.title && <h1>{entry.title}</h1>}
              <TagList entry={entry} />
              {entry.body && <div className="detail-body image-body">{entry.body}</div>}
              <span className="entry-date">{dateLine(entry.createdAt)}</span>
            </div>
            <Creator entry={entry} />
            <div className="detail-divider" />
          </div>
          <EntryActions entry={entry} onDelete={() => setDeleting(entry)} variant="image" />
        </section>
      </article>
    );
  } else if (mobile) {
    content = (
      <article className="detail-page">
        <div className="detail-header">
          <Creator entry={entry} />
          {closeButton}
        </div>
        <Metadata entry={entry} />
        <AttributeBadges entry={entry} />
        <div className="detail-scroll">
          <div className="detail-body">
            {entry.title && <h1>{entry.title}</h1>}
            {entry.body}
          </div>
          <TagList entry={entry} inline />
        </div>
        <EntryActions entry={entry} onDelete={() => setDeleting(entry)} variant="text" mobile />
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
        <div className="detail-body">
          {entry.title && <h1>{entry.title}</h1>}
          {entry.body}
        </div>
        <TagList entry={entry} />
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
        entry?.asset ? 'artwork-dialog' : '',
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
