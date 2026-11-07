import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { X, ExternalLink, Download } from 'lucide-react';
import type { Entry } from '@hcl/contracts';
import { useAuth, errorMessage } from '../app/api';
import { EntryIdentity } from '../components/EntryIdentity';
import { EntryActions } from '../components/EntryActions';
import { AttributeBadges, Author } from '../components/MasonryFeed';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';
export function EntryDetail({ modal = false }: { modal?: boolean }) {
  const { id } = useParams(); const { user, request } = useAuth(); const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null); const [deleting, setDeleting] = useState<Entry | null>(null);
  const result = useQuery({ queryKey: ['entries', 'detail', user?.id ?? 'guest', id], queryFn: ({ signal }) => request<Entry>(`/api/v1/entries/${id}`, { signal }) });
  const close = () => { if (modal) navigate(-1); else navigate('/'); };
  useEffect(() => { if (!modal) return; const element = dialog.current; element?.showModal(); return () => element?.close(); }, [modal]);
  const entry = result.data;
  const header = <div className="detail-header"><h1>{entry?.title ?? (entry?.asset ? '图片条目' : '文字条目')}</h1><button className="icon-button" type="button" aria-label="关闭详情" onClick={close}><X size={24}/></button></div>;
  const content = <>{!entry ? <section className="detail-status">{header}{result.isPending ? <p role="status">正在加载条目…</p> : <><p className="error" role="alert">{errorMessage(result.error)}</p><button className="secondary" onClick={() => void result.refetch()}>重试</button></>}</section> : <article className={entry.asset ? 'detail-layout image-detail' : 'detail-layout text-detail'}>{entry.asset && <section className="image-viewer"><AttributeBadges entry={entry}/><div className="image-canvas"><img src={entry.asset.originalUrl} alt={entry.title ?? `条目 #${entry.id}`}/></div><div className="viewer-footer"><span className="muted">{entry.asset.width} × {entry.asset.height}</span><span><a className="secondary" href={entry.asset.originalUrl} target="_blank" rel="noreferrer"><ExternalLink size={16}/>原图</a><a className="secondary" href={entry.asset.downloadUrl}><Download size={16}/>下载</a></span></div></section>}<section className="detail-information">{header}<div className="detail-metadata"><Author entry={entry}/><EntryIdentity id={entry.id}/></div><time className="muted" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time>{!entry.asset && <AttributeBadges entry={entry}/>}<div className="detail-body">{entry.body}</div><div className="entry-tags">{entry.tags.map(tag => <Link key={tag} to={`/search?q=${encodeURIComponent(tag)}`}>#{tag}</Link>)}</div><EntryActions entry={entry} onDelete={() => setDeleting(entry)}/></section></article>}<ConfirmDeleteDialog entry={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); close(); }}/></>;
  return modal ? <dialog ref={dialog} className={`entry-dialog${entry?.asset ? ' artwork-dialog' : ''}`} aria-label="条目详情" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>{content}</dialog> : <main className="standalone-detail">{content}</main>;
}
