import { type Entry, type EntryModeration, hasPermission } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { invalidateEntries, queryClient, useAuth } from '../../app/api';
import { ReasonDialog, RequestError, useStaffList } from './StaffControls';
import './admin.css';

type Review = { entry: Entry; moderation: EntryModeration };
type Target = {
  target: 'entry' | 'title' | 'body' | 'image' | 'file' | 'link';
  targetId?: string;
  hidden: boolean;
  label: string;
};

function ReviewEntry({ id, onClose }: { id: string; onClose: () => void }) {
  const auth = useAuth();
  const [action, setAction] = useState<Target | 'delete' | null>(null);
  const query = useQuery({
    queryKey: ['staff', 'review', id, auth.user?.id, auth.epoch.current],
    queryFn: ({ signal }) => auth.request<Review>(`/api/v1/admin/entries/${id}`, { signal }),
  });
  const review = query.data;
  const canModerate = hasPermission(auth.user, 'content.moderate');
  function control(target: Target) {
    return canModerate ? (
      <button type="button" className="secondary" onClick={() => setAction(target)}>
        {target.hidden ? '隐藏' : '恢复'}
        {target.label}
      </button>
    ) : null;
  }
  return (
    <section className="settings-card staff-review">
      <div className="staff-row">
        <h2>条目审核 · {id}</h2>
        <button type="button" className="secondary" onClick={onClose}>
          关闭审核
        </button>
      </div>
      <RequestError error={query.error} retry={() => void query.refetch()} />
      {query.isPending && <p role="status">正在读取原始条目…</p>}
      {review && (
        <>
          <p>以下内容为授权查看的原始内容；编辑原文不会解除限制。</p>
          <p>整条状态：{review.moderation.hidden ? '已隐藏（包括无可展示内容）' : '可展示'}</p>
          {review.moderation.reason && <p>最近原因：{review.moderation.reason}</p>}
          <div className="staff-actions">
            {control({ target: 'entry', hidden: !review.moderation.hidden, label: '整个条目' })}
            {hasPermission(auth.user, 'content.delete') && (
              <button type="button" className="secondary" onClick={() => setAction('delete')}>
                永久删除条目
              </button>
            )}
            <Link to={`/entries/${id}`}>查看公开详情</Link>
          </div>
          <section className="staff-piece">
            <h3>标题 · {review.moderation.titleHidden ? '已隐藏' : '正常'}</h3>
            <p>{review.entry.title || '无标题'}</p>
            {control({ target: 'title', hidden: !review.moderation.titleHidden, label: '标题' })}
          </section>
          <section className="staff-piece">
            <h3>正文 · {review.moderation.bodyHidden ? '已隐藏' : '正常'}</h3>
            <div className="staff-original-text">{review.entry.body || '无正文'}</div>
            {control({ target: 'body', hidden: !review.moderation.bodyHidden, label: '整段正文' })}
          </section>
          {review.entry.images.map((image) => {
            const hidden = review.moderation.hiddenImageIds.includes(image.id);
            return (
              <section className="staff-piece" key={image.id}>
                <h3>图片 · {hidden ? '已隐藏' : '正常'}</h3>
                <img className="staff-review-image" src={image.thumbnailUrl} alt={image.name} />
                <p>{image.name}</p>
                {control({ target: 'image', targetId: image.id, hidden: !hidden, label: '此图片' })}
              </section>
            );
          })}
          {review.entry.files.map((file) => {
            const hidden = review.moderation.hiddenFileIds.includes(file.id);
            return (
              <section className="staff-piece" key={file.id}>
                <h3>文件 · {hidden ? '已隐藏' : '正常'}</h3>
                <a href={file.downloadUrl}>{file.name}</a>
                {control({ target: 'file', targetId: file.id, hidden: !hidden, label: '此文件' })}
              </section>
            );
          })}
          {review.entry.links.map((link) => {
            const hidden = review.moderation.hiddenLinkUrls.includes(link.url);
            return (
              <section className="staff-piece" key={link.url}>
                <h3>链接 · {hidden ? '已隐藏' : '正常'}</h3>
                <p>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.url}
                  </a>
                </p>
                {control({ target: 'link', targetId: link.url, hidden: !hidden, label: '此链接' })}
              </section>
            );
          })}
        </>
      )}
      {action && (
        <ReasonDialog
          title={
            action === 'delete'
              ? '永久删除条目'
              : `${action.hidden ? '隐藏' : '恢复'}${action.label}`
          }
          destructive={action === 'delete'}
          onClose={() => setAction(null)}
          onSubmit={async (reason) => {
            if (action === 'delete')
              await auth.request(`/api/v1/admin/entries/${id}`, {
                method: 'DELETE',
                json: { reason },
              });
            else
              await auth.request(`/api/v1/admin/entries/${id}/moderation`, {
                method: 'PATCH',
                json: {
                  target: action.target,
                  ...(action.targetId ? { targetId: action.targetId } : {}),
                  hidden: action.hidden,
                  reason,
                },
              });
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['staff'] }),
              invalidateEntries(),
            ]);
            if (action === 'delete') onClose();
          }}
        />
      )}
    </section>
  );
}

export function ContentManagement() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useStaffList<Entry>('entries', '/api/v1/admin/entries');
  return (
    <section className="content-management">
      <header className="management-heading">
        <h1>内容管理</h1>
        <p>包括已隐藏的条目。受限内容仅对拥有受限内容审核权限的人员开放；审核不修改作者原文。</p>
      </header>
      <RequestError error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <p role="status">正在加载条目…</p>}
      {selected && <ReviewEntry key={selected} id={selected} onClose={() => setSelected(null)} />}
      <div className="management-table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>条目</th>
              <th>作者</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.pages
              .flatMap((page) => page.items)
              .map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <Link to={`/entries/${entry.id}`}>{entry.title || '无标题条目'}</Link>
                    <br />
                    <small>{entry.id}</small>
                  </td>
                  <td>{entry.author.displayName}</td>
                  <td>
                    {entry.moderation?.hidden ? '已隐藏' : '可展示'} · {entry.visibility}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setSelected(entry.id)}
                    >
                      审核原始内容
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {list.data && !list.data.pages.some((page) => page.items.length) && <p>暂无可管理条目。</p>}
      {list.hasNextPage && (
        <button
          className="secondary"
          type="button"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          加载更多条目
        </button>
      )}
    </section>
  );
}
