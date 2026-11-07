import type { Entry } from '@hcl/contracts';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, invalidateEntries, isCancelled, useAuth } from '../app/api';
export function ConfirmDeleteDialog({
  entry,
  onClose,
  onDeleted,
}: {
  entry: Entry | null;
  onClose: () => void;
  onDeleted: (entry: Entry) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { request, epoch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (entry) {
      setError('');
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [entry]);
  async function remove() {
    if (!entry || busy) return;
    const captured = epoch.current;
    setBusy(true);
    setError('');
    try {
      await request<void>(`/api/v1/entries/${entry.id}`, { method: 'DELETE' });
      if (captured !== epoch.current) return;
      await invalidateEntries();
      if (captured !== epoch.current) return;
      onDeleted(entry);
    } catch (cause) {
      if (captured === epoch.current && !isCancelled(cause)) setError(errorMessage(cause));
    } finally {
      if (captured === epoch.current) setBusy(false);
    }
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Native Escape/onCancel and the cancel button already provide keyboard dismissal.
    <dialog
      ref={dialog}
      className="delete-dialog"
      aria-labelledby="delete-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="delete-dialog-content">
        <h2 id="delete-title">删除条目？</h2>
        <p>条目 #{entry?.id} 及其图片将无法再公开访问。此操作无法撤销。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
