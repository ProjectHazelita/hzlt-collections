import type { Entry, LikeResponse } from '@hcl/contracts';
import { Download, Heart, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { errorMessage, invalidateEntries, isCancelled, useAuth } from '../app/api';

export function EntryActions({
  entry,
  onDelete,
  variant,
  mobile = false,
}: {
  entry: Entry;
  onDelete: () => void;
  variant: 'image' | 'text';
  mobile?: boolean;
}) {
  const { user, request, epoch } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!tools.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);
  async function toggle() {
    if (!user) {
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    if (busy) return;
    const captured = epoch.current;
    setBusy(true);
    setError('');
    try {
      await request<LikeResponse>(`/api/v1/entries/${entry.id}/like`, {
        method: entry.likedByMe ? 'DELETE' : 'PUT',
      });
      if (captured !== epoch.current) return;
      await invalidateEntries();
    } catch (cause) {
      if (captured === epoch.current && !isCancelled(cause)) setError(errorMessage(cause));
    } finally {
      if (captured === epoch.current) setBusy(false);
    }
  }
  const label = entry.likedByMe ? '已喜欢' : '喜欢';
  const download =
    variant === 'image' && entry.asset ? (
      mobile ? (
        <a className="tool-button tool-button-label" href={entry.asset.downloadUrl} download>
          下载原图
        </a>
      ) : (
        <a className="tool-button" href={entry.asset.downloadUrl} download aria-label="下载原图">
          <Download size={20} />
        </a>
      )
    ) : null;
  return (
    <div className="entry-actions">
      <div className="action-group">
        <button
          type="button"
          className={entry.likedByMe ? 'like-button liked' : 'like-button'}
          disabled={busy}
          onClick={() => void toggle()}
          aria-pressed={entry.likedByMe}
        >
          <Heart size={20} fill={entry.likedByMe ? 'currentColor' : 'none'} />
          <span>
            {variant === 'text' ? `${label}\u00a0\u00a0${entry.likeCount}` : entry.likeCount}
          </span>
        </button>
        {mobile ? null : download}
      </div>
      <div className="entry-tools" ref={tools}>
        {mobile ? download : null}
        {(entry.canEdit || entry.canDelete) && (
          <button
            className={mobile ? 'tool-button tool-button-label' : 'tool-button'}
            type="button"
            aria-label={mobile ? undefined : '更多操作'}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((value) => !value)}
          >
            {mobile ? '更多' : <MoreHorizontal size={20} />}
          </button>
        )}
        {menu && (
          <div className="entry-menu" role="menu" aria-label="条目操作">
            {entry.canEdit && (
              <Link
                className="menu-button"
                role="menuitem"
                to={`/entries/${entry.id}/edit`}
                onClick={() => setMenu(false)}
              >
                编辑文字和标签
              </Link>
            )}
            {entry.canDelete && (
              <button
                className="menu-button"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onDelete();
                }}
              >
                删除条目
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
