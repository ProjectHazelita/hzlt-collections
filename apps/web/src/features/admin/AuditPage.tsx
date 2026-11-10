import type { AuditRecord } from '@hcl/contracts';
import { RequestError, useStaffList } from './StaffControls';

export function AuditPage() {
  const list = useStaffList<AuditRecord>('audit', '/api/v1/admin/audit');
  return (
    <section className="content-management">
      <header className="management-heading">
        <h1>审计日志</h1>
        <p>按时间查看管理操作、操作者、目标及原因。日志不记录被隐藏的原始内容。</p>
      </header>
      <RequestError error={list.error} retry={() => void list.refetch()} />
      {list.isPending && <p role="status">正在加载审计日志…</p>}
      <div className="management-table-scroll">
        <table className="management-table">
          <thead>
            <tr>
              <th>时间 / 操作者</th>
              <th>操作</th>
              <th>目标</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.pages
              .flatMap((page) => page.items)
              .map((record) => (
                <tr key={record.id}>
                  <td>
                    <time dateTime={record.createdAt}>
                      {new Date(record.createdAt).toLocaleString('zh-CN')}
                    </time>
                    <br />
                    <small>{record.actorId}</small>
                  </td>
                  <td>{record.action}</td>
                  <td>
                    {record.targetType}
                    <br />
                    <small>{record.targetId}</small>
                  </td>
                  <td>{record.reason}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {list.data && !list.data.pages.some((page) => page.items.length) && <p>暂无审计记录。</p>}
      {list.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          加载更多记录
        </button>
      )}
    </section>
  );
}
