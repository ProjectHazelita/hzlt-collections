import { useState } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Entry, EntryList } from '@hcl/contracts';
import { errorMessage, invalidateEntries, queryClient, useAuth } from '../../app/api';
import { ConfirmDeleteDialog } from '../../components/ConfirmDeleteDialog';
import './admin.css';

const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

export function ContentManagement() {
  const auth = useAuth();
  const identityEpoch = auth.epoch.current;
  const userId = auth.user?.id;
  const queryKey = ['entries', 'admin', userId, identityEpoch] as const;
  const [selected, setSelected] = useState<{ entry: Entry; epoch: number } | null>(null);
  const query = useInfiniteQuery({
    queryKey,
    enabled: auth.user?.role === 'owner' && !auth.loading,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const captured = auth.epoch.current;
      if (captured !== identityEpoch) throw new DOMException('Identity changed', 'AbortError');
      const params = new URLSearchParams({ limit: '30' });
      if (pageParam) params.set('cursor', pageParam);
      const result = await auth.request<EntryList>(`/api/v1/admin/entries?${params}`, { signal });
      if (captured !== auth.epoch.current || signal.aborted) throw new DOMException('Identity changed', 'AbortError');
      return result;
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const authorized = auth.user?.role === 'owner' && !auth.loading;
  const pages = authorized ? query.data?.pages : undefined;
  const entries = pages?.flatMap(page => page.items) ?? [];
  const total = pages?.[0]?.total;

  function deleted(entry: Entry) {
    if (!authorized || identityEpoch !== auth.epoch.current || selected?.epoch !== identityEpoch) return;
    setSelected(null);
    // Remove the confirmed deletion immediately while all other entry lists revalidate.
    queryClient.setQueryData<InfiniteData<EntryList, string | null>>(queryKey, previous => {
      if (!previous || identityEpoch !== auth.epoch.current) return previous;
      return { ...previous, pages: previous.pages.map(page => ({
        ...page,
        items: page.items.filter(item => item.id !== entry.id),
        total: Math.max(0, page.total - 1),
      })) };
    });
    if (identityEpoch === auth.epoch.current) void invalidateEntries();
  }

  return <section className="content-management" aria-labelledby="management-title">
    <h1 id="management-title" className="page-heading">站点管理</h1>
    <p className="muted">owner · 管理全站内容；编辑正文和标签仍由作者完成。</p>
    <div className="management-summary" aria-live="polite"><span>全站条目</span><strong>{total === undefined ? '—' : total.toLocaleString()}</strong></div>
    {authorized && query.isPending && <p role="status" className="muted">正在加载全站内容…</p>}
    {authorized && query.isError && <div className="management-status" role="alert">
      <p className="error">{errorMessage(query.error)}</p>
      <button className="secondary" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} disabled={query.isFetching}>重试</button>
    </div>}
    {pages && entries.length === 0 && <div className="management-status"><h2>还没有条目</h2><p className="muted">已发布的内容会显示在这里。</p></div>}
    {entries.length > 0 && <div className="management-table-scroll" role="region" aria-label="全站内容表格，可横向滚动" tabIndex={0}>
      <table className="management-table">
        <caption className="management-sr-only">全站已发布条目、作者、发布时间与管理操作</caption>
        <thead><tr><th scope="col">条目</th><th scope="col">作者</th><th scope="col">发布时间</th><th scope="col">操作</th></tr></thead>
        <tbody>{entries.map(entry => <tr key={entry.id}>
          <td><div className="management-entry">
            {entry.asset && <img src={entry.asset.thumbnailUrl} alt="" width={56} height={56} loading="lazy" />}
            <div className="management-entry-copy">
              <Link className="management-entry-title" to={`/entries/${entry.id}`}>{entry.title || entry.body || `图片条目 #${entry.id}`}</Link>
              <span className="muted">#{entry.id} · {entry.asset ? '图片' : '文字'} · 公开</span>
            </div>
          </div></td>
          <td><span className="management-author" title={entry.author.username}>{entry.author.username}</span></td>
          <td><time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString('zh-CN')}>{dateFormat.format(new Date(entry.createdAt))}</time></td>
          <td><div className="management-actions">
            <Link className="secondary" to={`/entries/${entry.id}`} aria-label={`查看条目 #${entry.id}`}>查看</Link>
            {entry.canDelete && <button className="secondary management-delete" aria-label={`删除条目 #${entry.id}`} onClick={() => {
              if (identityEpoch === auth.epoch.current) setSelected({ entry, epoch: identityEpoch });
            }}>删除</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div>}
    {authorized && query.hasNextPage && <button className="secondary management-more" onClick={() => void query.fetchNextPage()} disabled={query.isFetching}>
      {query.isFetchingNextPage ? '正在加载…' : '加载更多'}
    </button>}
    <ConfirmDeleteDialog entry={authorized && selected?.epoch === identityEpoch ? selected.entry : null} onClose={() => {
      if (identityEpoch === auth.epoch.current) setSelected(null);
    }} onDeleted={deleted} />
  </section>;
}

export default ContentManagement;
