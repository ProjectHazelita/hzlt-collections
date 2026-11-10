import type { Comment } from '@hcl/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage, isCancelled, queryClient, useAuth } from '../app/api';

export function CommentDeleteButton({ entryId, comment }: { entryId: string; comment: Comment }) {
  const { user, request, epoch } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const identity = epoch.current;
  useEffect(() => {
    if (identity !== epoch.current) return;
    mounted.current = true;
    setBusy(false);
    setError('');
    dialog.current?.close();
    return () => {
      mounted.current = false;
    };
  }, [identity, epoch]);

  async function remove() {
    if (!user || user.id !== comment.author.id || busy) return;
    const captured = epoch.current;
    setBusy(true);
    setError('');
    try {
      await request<void>(`/api/v1/entries/${entryId}/comments/${comment.id}`, {
        method: 'DELETE',
      });
      if (captured !== epoch.current) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['comments', entryId] }),
        queryClient.invalidateQueries({ queryKey: ['user-comments'] }),
      ]);
      if (mounted.current && captured === epoch.current) dialog.current?.close();
    } catch (cause) {
      if (mounted.current && captured === epoch.current && !isCancelled(cause))
        setError(errorMessage(cause));
    } finally {
      if (mounted.current && captured === epoch.current) setBusy(false);
    }
  }

  if (user?.id !== comment.author.id) return null;
  return (
    <>
      <button
        type="button"
        className="comment-reply-button"
        disabled={busy}
        onClick={() => {
          setError('');
          dialog.current?.showModal();
        }}
      >
        删除
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Native Escape/onCancel and cancel button provide keyboard dismissal. */}
      <dialog
        ref={dialog}
        className="delete-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) dialog.current?.close();
        }}
      >
        <div className="delete-dialog-content">
          <h2 id={titleId}>删除这条{comment.parentId ? '回复' : '评论'}？</h2>
          <p>
            删除后不可恢复。这条评论及其下的所有回复（包括多层回复和其他人的回复）都会一并删除。
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              取消
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
