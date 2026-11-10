import type { EntryList } from '@hcl/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../app/api';
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
  const empty = !result.isPending && !items.length;

  const feed = result.isPending ? (
    <div className="state-block" role="status">
      <p className="state-title">正在加载…</p>
    </div>
  ) : result.isError && !items.length ? (
    <div className="state-block">
      <p className="state-title">连接似乎出了点问题</p>
      <p className="state-note">请检查网络后重试。你已发布的内容不会因此丢失。</p>
      <button type="button" className="secondary" onClick={() => void result.refetch()}>
        重新加载
      </button>
    </div>
  ) : empty ? (
    kind === 'likes' ? (
      <div className="state-block">
        <p className="state-title">还没有喜欢的内容</p>
        <p className="state-note">遇到喜欢的文字或图片时，点一下心形就能在这里找到。</p>
        <Link className="secondary" to="/">
          去看看
        </Link>
      </div>
    ) : kind === 'search' ? (
      <div className="state-block">
        <span className="state-icon">
          <Search size={16} />
        </span>
        <p className="state-heading">没有找到相关内容</p>
        <p className="state-note">试试更短的关键词，或换个说法。</p>
      </div>
    ) : (
      <div className="state-block">
        <p className="state-title">从第一条分享开始</p>
        <p className="state-note">一段文字或一张图片，都可以。</p>
        <Link className="secondary" to="/publish">
          发布第一条内容
        </Link>
      </div>
    )
  ) : (
    <MasonryFeed entries={items} />
  );

  const pagination = !result.isPending && items.length > 0 && (
    <div className="feed-footer">
      {result.hasNextPage ? (
        <button
          type="button"
          className="secondary"
          disabled={result.isFetchingNextPage}
          onClick={() => void result.fetchNextPage()}
        >
          {result.isFetchingNextPage
            ? '加载中…'
            : result.isFetchNextPageError
              ? '加载失败，点击重试'
              : '加载更多'}
        </button>
      ) : (
        <p>
          {kind === 'likes'
            ? '已展示全部喜欢'
            : kind === 'search'
              ? '已展示全部结果'
              : '已展示全部内容'}
        </p>
      )}
    </div>
  );

  if (kind === 'home') {
    return (
      <>
        {empty && !result.isError && (
          <header className="home-heading">
            <h1>欢迎来到 hzlt!Collections</h1>
            <p>这里会展示社群成员发布的文字与图片。</p>
          </header>
        )}
        {result.isError && !items.length && (
          <header className="home-heading">
            <h1>内容暂时没有加载出来</h1>
          </header>
        )}
        {feed}
        {pagination}
      </>
    );
  }

  return (
    <section className="feed-section">
      <header className="section-heading">
        <h1>{kind === 'likes' ? '喜欢' : '搜索结果'}</h1>
        {total !== undefined && (
          <span className="section-count">{kind === 'likes' ? total : `${total} 项`}</span>
        )}
      </header>
      {feed}
      {pagination}
    </section>
  );
}
