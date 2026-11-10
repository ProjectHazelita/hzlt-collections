import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { errorMessage, isCancelled, useAuth } from '../../app/api';
import './admin.css';

export function useStaffList<T>(kind: string, path: string) {
  const auth = useAuth();
  return useInfiniteQuery({
    queryKey: ['staff', kind, path, auth.user?.id, auth.epoch.current],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      auth.request<{ items: T[]; nextCursor: string | null }>(
        `${path}${path.includes('?') ? '&' : '?'}limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!auth.user && !auth.loading,
  });
}

export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error || isCancelled(error)) return null;
  return (
    <div role="alert">
      <p className="error">{errorMessage(error)}</p>
      {retry && (
        <button type="button" className="secondary" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}

export function ReasonDialog({
  title,
  destructive = false,
  children,
  onClose,
  onSubmit,
}: {
  title: string;
  destructive?: boolean;
  children?: React.ReactNode;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const auth = useAuth();
  const captured = useRef(auth.epoch.current);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="staff-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !reason.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(reason.trim());
            if (captured.current === auth.epoch.current) onClose();
          } catch (cause) {
            if (captured.current === auth.epoch.current) setError(cause);
          } finally {
            if (captured.current === auth.epoch.current) setBusy(false);
          }
        }}
      >
        <h2>{title}</h2>
        {children}
        {destructive && <p>此操作会永久删除条目及其附件，无法撤销。</p>}
        <label className="settings-field">
          <span>操作原因（必填，将记录到审计日志）</span>
          <textarea
            autoFocus
            required
            maxLength={500}
            rows={3}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <RequestError error={error} />
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !reason.trim()}>
            {busy ? '提交中…' : destructive ? '确认永久删除' : '确认操作'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
