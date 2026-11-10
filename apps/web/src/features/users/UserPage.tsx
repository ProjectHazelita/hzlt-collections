import type {
  EntryList,
  FollowResponse as FollowResult,
  UserProfile as PublicProfile,
  User,
} from '@hcl/contracts';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ApiError, errorMessage, isCancelled, useAuth } from '../../app/api';
import { uuid } from '../../app/uuid';
import { MasonryFeed } from '../../components/MasonryFeed';
import './users.css';

type View = 'works' | 'following' | 'followers';

export function UserPage() {
  const { username = '' } = useParams<{ username: string }>();
  const { user, epoch, loading } = useAuth();
  if (loading)
    return (
      <div className="state-block" role="status">
        正在加载…
      </div>
    );
  return (
    <UserProfile key={`${username}:${user?.id ?? 'guest'}:${epoch.current}`} username={username} />
  );
}

function UserProfile({ username }: { username: string }) {
  const { user, request, epoch } = useAuth();
  const location = useLocation();
  const client = useQueryClient();
  const [view, setView] = useState<View>('works');
  const [following, setFollowing] = useState(false);
  const [followError, setFollowError] = useState('');
  const mounted = useRef(true);
  const root = `/api/v1/users/${encodeURIComponent(username)}`;
  const profileKey = ['user-profile', username, user?.id ?? 'guest', epoch.current] as const;
  const profile = useQuery({
    queryKey: profileKey,
    queryFn: ({ signal }) => request<PublicProfile>(root, { signal }),
  });
  const socialLinks = useMemo(
    () => profile.data?.socialLinks.map((link) => ({ ...link, key: uuid() })) ?? [],
    [profile.data?.socialLinks],
  );
  const works = useInfiniteQuery({
    queryKey: ['entries', 'user', username, user?.id ?? 'guest', epoch.current],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      request<EntryList>(
        `${root}/entries${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(profile.data),
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function toggleFollow() {
    if (!user || !profile.data || following) return;
    const captured = epoch.current;
    setFollowing(true);
    setFollowError('');
    try {
      const result = await request<FollowResult>(`${root}/follow`, {
        method: profile.data.followingByMe ? 'DELETE' : 'PUT',
      });
      if (!mounted.current || captured !== epoch.current) return;
      client.setQueryData<PublicProfile>(profileKey, (current) =>
        current ? { ...current, ...result } : current,
      );
      void client.resetQueries({ queryKey: ['entries'] });
      void client.invalidateQueries({ queryKey: ['user-list'] });
    } catch (cause) {
      if (mounted.current && captured === epoch.current && !isCancelled(cause))
        setFollowError(errorMessage(cause));
    } finally {
      if (mounted.current && captured === epoch.current) setFollowing(false);
    }
  }

  if (profile.isPending)
    return (
      <div className="state-block" role="status">
        正在加载个人主页…
      </div>
    );
  if (profile.isError)
    return (
      <div className="state-block">
        <h1 className="state-title">
          {profile.error instanceof ApiError && profile.error.status === 404
            ? '用户不存在'
            : '个人主页加载失败'}
        </h1>
        <p role="alert">{errorMessage(profile.error)}</p>
        <button className="secondary" type="button" onClick={() => void profile.refetch()}>
          重试
        </button>
      </div>
    );
  const person = profile.data;
  const own = person.user.id === user?.id;
  const canViewFollowing = own || person.showFollowing;
  const canViewFollowers = own || person.showFollowers;
  const items = works.data?.pages.flatMap((page) => page.items) ?? [];
  const login = `/login?returnTo=${encodeURIComponent(location.pathname)}`;

  return (
    <section className="user-page">
      <header className="user-profile-card">
        <div className="user-profile-avatar" aria-hidden="true">
          {person.user.avatarUrl ? (
            <img src={person.user.avatarUrl} alt="" />
          ) : (
            Array.from(person.user.displayName || person.user.username)[0]
          )}
        </div>
        <div className="user-profile-info">
          <h1>{person.user.displayName}</h1>
          <p className="user-profile-username">
            @{person.user.username}
            {person.pronouns !== 'not specified' && <span> · {person.pronouns}</span>}
          </p>
          {person.user.bio && <p className="user-profile-bio">{person.user.bio}</p>}
          <div className="user-profile-metadata">
            {person.location && <span>{person.location}</span>}
            {person.email && <a href={`mailto:${person.email}`}>{person.email}</a>}
            {socialLinks.map((link) => (
              <a key={link.key} href={link.url} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            ))}
          </div>
          <div className="user-profile-counts">
            <button
              type="button"
              disabled={!canViewFollowing}
              onClick={() => setView('following')}
              aria-label={`关注 ${person.followingCount} 人${canViewFollowing ? '' : '，列表不公开'}`}
            >
              <strong>{person.followingCount}</strong> 关注
              {!canViewFollowing && <span> · 列表不公开</span>}
            </button>
            <button
              type="button"
              disabled={!canViewFollowers}
              onClick={() => setView('followers')}
              aria-label={`粉丝 ${person.followerCount} 人${canViewFollowers ? '' : '，列表不公开'}`}
            >
              <strong>{person.followerCount}</strong> 粉丝
              {!canViewFollowers && <span> · 列表不公开</span>}
            </button>
          </div>
        </div>
        <div className="user-profile-actions">
          {own ? (
            <Link className="secondary" to="/settings/profile">
              编辑个人资料
            </Link>
          ) : user ? (
            <button
              type="button"
              className={person.followingByMe ? 'secondary' : 'primary'}
              disabled={following}
              onClick={() => void toggleFollow()}
            >
              {following ? '正在更新…' : person.followingByMe ? '取消关注' : '关注'}
            </button>
          ) : (
            <Link className="primary" to={login}>
              登录后关注
            </Link>
          )}
          {followError && (
            <p className="error" role="alert">
              {followError}
            </p>
          )}
        </div>
      </header>
      <nav className="user-tabs" aria-label="个人主页内容">
        <button
          type="button"
          aria-current={view === 'works' ? 'page' : undefined}
          onClick={() => setView('works')}
        >
          作品{works.data ? ` · ${works.data.pages[0]?.total ?? items.length}` : ''}
        </button>
        <button
          type="button"
          aria-current={view === 'following' ? 'page' : undefined}
          disabled={!canViewFollowing}
          onClick={() => setView('following')}
        >
          关注 · {person.followingCount}
        </button>
        <button
          type="button"
          aria-current={view === 'followers' ? 'page' : undefined}
          disabled={!canViewFollowers}
          onClick={() => setView('followers')}
        >
          粉丝 · {person.followerCount}
        </button>
      </nav>
      {view === 'works' ? (
        <div className="user-works">
          {works.isPending ? (
            <div className="state-block" role="status">
              正在加载作品…
            </div>
          ) : works.isError && !items.length ? (
            <div className="state-block">
              <p className="error" role="alert">
                {errorMessage(works.error)}
              </p>
              <button className="secondary" type="button" onClick={() => void works.refetch()}>
                重试
              </button>
            </div>
          ) : !items.length ? (
            <div className="state-block">
              <p className="state-title">暂无可见作品</p>
              <p>这里会展示你有权查看的已发布条目。</p>
            </div>
          ) : (
            <MasonryFeed entries={items} />
          )}
          {works.isFetchNextPageError && (
            <p className="error" role="alert">
              {errorMessage(works.error)}
            </p>
          )}
          {works.hasNextPage && (
            <div className="user-load-more">
              <button
                className="secondary"
                type="button"
                disabled={works.isFetchingNextPage}
                onClick={() => void works.fetchNextPage()}
              >
                {works.isFetchingNextPage
                  ? '正在加载…'
                  : works.isFetchNextPageError
                    ? '重试加载'
                    : '加载更多'}
              </button>
            </div>
          )}
        </div>
      ) : (view === 'following' ? canViewFollowing : canViewFollowers) ? (
        <UserList key={view} username={username} kind={view} />
      ) : (
        <div className="state-block">该列表不公开。</div>
      )}
    </section>
  );
}

function UserList({ username, kind }: { username: string; kind: 'following' | 'followers' }) {
  const { request, user, epoch } = useAuth();
  const list = useQuery({
    queryKey: ['user-list', username, kind, user?.id ?? 'guest', epoch.current],
    queryFn: ({ signal }) =>
      request<{ items: User[] }>(`/api/v1/users/${encodeURIComponent(username)}/${kind}`, {
        signal,
      }),
  });
  if (list.isPending)
    return (
      <div className="state-block" role="status">
        正在加载用户列表…
      </div>
    );
  if (list.isError)
    return (
      <div className="state-block">
        <p className="error" role="alert">
          {list.error instanceof ApiError && list.error.status === 403
            ? '该列表不公开。'
            : errorMessage(list.error)}
        </p>
        <button type="button" className="secondary" onClick={() => void list.refetch()}>
          重试
        </button>
      </div>
    );
  if (!list.data.items.length)
    return (
      <div className="state-block">
        {kind === 'following' ? '还没有关注任何人。' : '还没有粉丝。'}
      </div>
    );
  return (
    <ul className="user-list">
      {list.data.items.map((person) => (
        <li key={person.id}>
          <Link to={`/users/${encodeURIComponent(person.username)}`} className="user-list-person">
            <span className="user-list-avatar" aria-hidden="true">
              {person.avatarUrl ? (
                <img src={person.avatarUrl} alt="" />
              ) : (
                Array.from(person.displayName || person.username)[0]
              )}
            </span>
            <span className="user-list-info">
              <strong>{person.displayName}</strong>
              <span>@{person.username}</span>
              {person.bio && <span className="user-list-bio">{person.bio}</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
