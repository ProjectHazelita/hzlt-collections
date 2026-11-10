import type { UserCommentList } from '@hcl/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router';
import { errorMessage, useAuth } from '../../app/api';
import { CommentDeleteButton } from '../../components/CommentDeleteButton';

export function UserComments({ username }: { username: string }) {
  const { user, request, epoch } = useAuth();
  const location = useLocation();
  const result = useInfiniteQuery({
    queryKey: ['user-comments', username, user?.id ?? 'guest', epoch.current],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      request<UserCommentList>(
        `/api/v1/users/${encodeURIComponent(username)}/comments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = result.data?.pages.flatMap((page) => page.items) ?? [];
  if (result.isPending)
    return (
      <div className="state-block" role="status">
        正在加载评论…
      </div>
    );
  if (result.isError && !items.length)
    return (
      <div className="state-block">
        <p className="error" role="alert">
          {errorMessage(result.error)}
        </p>
        <button type="button" className="secondary" onClick={() => void result.refetch()}>
          重试
        </button>
      </div>
    );
  if (!items.length)
    return (
      <div className="state-block">
        <p className="state-title">暂无可见评论</p>
        <p>这里会展示该用户在你有权查看的条目下发表的评论和回复。</p>
      </div>
    );
  return (
    <div className="user-comments">
      <ul className="user-comment-list">
        {items.map(({ comment, entry }) => (
          <li className="user-comment" key={comment.id}>
            <div className="user-comment-meta">
              <time dateTime={comment.createdAt}>
                {new Date(comment.createdAt).toLocaleString('zh-CN')}
              </time>
              {comment.replyTo ? (
                <span>
                  回复{' '}
                  <Link to={`/users/${encodeURIComponent(comment.replyTo.username)}`}>
                    {comment.replyTo.displayName}
                  </Link>
                </span>
              ) : (
                <span>发表了评论</span>
              )}
              <span className="comment-spacer" />
              <CommentDeleteButton entryId={entry.id} comment={comment} />
            </div>
            <p className="user-comment-body">{comment.body}</p>
            <Link
              className="user-comment-entry"
              to={`/entries/${entry.id}`}
              state={{ backgroundLocation: location }}
            >
              所属条目：{entry.title || `条目 #${entry.id}`}
            </Link>
          </li>
        ))}
      </ul>
      {result.isError && (
        <div className="user-load-more">
          <p className="error" role="alert">
            {errorMessage(result.error)}
          </p>
          {!result.isFetchNextPageError && (
            <button
              type="button"
              className="secondary"
              disabled={result.isFetching}
              onClick={() => void result.refetch()}
            >
              重试
            </button>
          )}
        </div>
      )}
      {result.hasNextPage && (
        <div className="user-load-more">
          <button
            type="button"
            className="secondary"
            disabled={result.isFetching}
            onClick={() => void result.fetchNextPage()}
          >
            {result.isFetchingNextPage
              ? '正在加载…'
              : result.isFetchNextPageError
                ? '重试加载'
                : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
