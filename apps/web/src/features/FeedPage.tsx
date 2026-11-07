import type { EntryList } from '@hcl/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Heart, Search } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { errorMessage, useAuth } from '../app/api';
import { MasonryFeed } from '../components/MasonryFeed';
export function FeedPage({ kind = 'home' }: { kind?: 'home' | 'likes' | 'search' }) {
  const { user, request } = useAuth();
  const [params] = useSearchParams();
  const q = kind === 'search' ? (params.get('q') ?? '') : '';
  const result = useInfiniteQuery({
    queryKey: ['entries', kind, user?.id ?? 'guest', q],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: '30' });
      if (q) query.set('q', q);
      if (pageParam) query.set('cursor', pageParam);
      return request<EntryList>(
        `${kind === 'likes' ? '/api/v1/me/likes' : '/api/v1/entries'}?${query}`,
        { signal },
      );
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = result.data?.pages.flatMap((page) => page.items) ?? [];
  const total = result.data?.pages[0]?.total;
  return (
    <>
      {kind !== 'home' && (
        <header className="page-heading">
          <h1>
            {kind === 'likes' ? (
              <>
                <Heart fill="currentColor" size={24} />
                喜欢
              </>
            ) : (
              <>
                <Search size={24} />
                搜索
              </>
            )}
          </h1>
          {total !== undefined && <span>{total}</span>}
          {kind === 'search' && <span className="muted">{q ? `“${q}”` : '全部条目'}</span>}
        </header>
      )}
      {result.isPending ? (
        <div className="request-state" role="status">
          正在加载…
        </div>
      ) : result.isError && !items.length ? (
        <div className="request-state">
          <p className="error" role="alert">
            {errorMessage(result.error)}
          </p>
          <button type="button" className="secondary" onClick={() => void result.refetch()}>
            重试
          </button>
        </div>
      ) : !items.length ? (
        <div className="request-state">
          <h2>
            {kind === 'likes'
              ? '还没有喜欢的条目'
              : kind === 'search'
                ? '没有找到相关条目'
                : '这里还没有条目'}
          </h2>
          <p className="muted">
            {kind === 'likes'
              ? '浏览条目，留下你的喜欢。'
              : kind === 'search'
                ? '试试其他关键词。'
                : '登录后发布第一个条目吧。'}
          </p>
        </div>
      ) : (
        <MasonryFeed entries={items} />
      )}
      <div className="pagination">
        {result.isFetchNextPageError && (
          <p className="error" role="alert">
            加载失败，请重试。
          </p>
        )}
        {result.hasNextPage && (
          <button
            type="button"
            className="secondary"
            disabled={result.isFetchingNextPage}
            onClick={() => void result.fetchNextPage()}
          >
            {result.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        )}
      </div>
    </>
  );
}
