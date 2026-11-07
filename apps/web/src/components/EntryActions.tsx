import type { Entry, LikeResponse } from '@hcl/contracts';
import { Heart, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { errorMessage, invalidateEntries, isCancelled, useAuth } from '../app/api';
export function EntryActions({ entry, onDelete }: { entry: Entry; onDelete: () => void }) {
  const { user, request, epoch } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  return (
    <div className="entry-actions">
      <button
        type="button"
        className={entry.likedByMe ? 'like-button liked' : 'like-button'}
        disabled={busy}
        onClick={() => void toggle()}
        aria-pressed={entry.likedByMe}
      >
        <Heart size={20} fill={entry.likedByMe ? 'currentColor' : 'none'} />
        <span>{entry.likeCount}</span>
        <span>{entry.likedByMe ? '取消喜欢' : '喜欢'}</span>
      </button>
      <span className="entry-tools">
        {entry.canEdit && (
          <Link className="icon-button" aria-label="编辑条目" to={`/entries/${entry.id}/edit`}>
            <Pencil size={20} />
          </Link>
        )}
        {entry.canDelete && (
          <button type="button" className="icon-button" aria-label="删除条目" onClick={onDelete}>
            <Trash2 size={20} />
          </button>
        )}
      </span>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
