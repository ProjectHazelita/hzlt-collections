import type { Comment, CommentList } from '@hcl/contracts';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle, SendHorizontal, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { errorMessage, isCancelled, queryClient, useAuth } from '../app/api';
import { UserAvatar } from './UserAvatar';
import './gallery-content.css';

function CommentRow({
  comment,
  fresh,
  onReply,
}: {
  comment: Comment;
  fresh: boolean;
  onReply: (comment: Comment) => void;
}) {
  const { user } = useAuth();
  return (
    <div className={fresh ? 'comment-row comment-new' : 'comment-row'}>
      <Link
        to={`/users/${encodeURIComponent(comment.author.username)}`}
        aria-label={`查看 ${comment.author.displayName} 的主页`}
      >
        <UserAvatar user={comment.author} className="avatar comment-avatar" />
      </Link>
      <div className="comment-content">
        <div className="comment-attribution">
          <Link
            className="comment-name"
            to={`/users/${encodeURIComponent(comment.author.username)}`}
          >
            {comment.author.displayName}
          </Link>
          {comment.replyTo && (
            <span className="comment-reply-to">回复 {comment.replyTo.displayName}</span>
          )}
          <span className="comment-spacer" />
          {user && (
            <button type="button" className="comment-reply-button" onClick={() => onReply(comment)}>
              回复
            </button>
          )}
        </div>
        <p className="comment-body">{comment.body}</p>
      </div>
    </div>
  );
}

export function Comments({ entryId, children }: { entryId: string; children: ReactNode }) {
  const { user, request, epoch } = useAuth();
  const location = useLocation();
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [freshId, setFreshId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const result = useQuery({
    queryKey: ['comments', entryId],
    queryFn: ({ signal }) =>
      request<CommentList>(`/api/v1/entries/${entryId}/comments`, { signal }),
  });

  function reply(comment: Comment) {
    setReplyTo(comment);
    input.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body.trim();
    if (!user || !text || sending) return;
    const captured = epoch.current;
    setSending(true);
    setError('');
    try {
      const created = await request<Comment>(`/api/v1/entries/${entryId}/comments`, {
        method: 'POST',
        json: { body: text, parentId: replyTo?.id ?? null },
      });
      if (captured !== epoch.current) return;
      setBody('');
      setReplyTo(null);
      setFreshId(created.id);
      await queryClient.invalidateQueries({ queryKey: ['comments', entryId] });
      window.setTimeout(() => setFreshId(null), 1200);
    } catch (cause) {
      if (captured === epoch.current && !isCancelled(cause)) setError(errorMessage(cause));
    } finally {
      if (captured === epoch.current) setSending(false);
    }
  }

  const total = result.data?.total ?? 0;
  return (
    <div className="comments">
      <div className="comments-scroll">
        {children}
        <section className="comments-thread" aria-label="评论">
          <div className="comments-header">
            <h2>评论</h2>
            <span>{total}</span>
          </div>
          {result.isPending ? (
            <p className="comments-status" role="status">
              正在加载评论…
            </p>
          ) : result.isError ? (
            <p className="comments-status error" role="alert">
              {errorMessage(result.error)}
            </p>
          ) : total === 0 ? (
            <p className="comments-status">还没有评论，来说第一句吧。</p>
          ) : (
            <div className="comment-list">
              {result.data.items.map((thread) => (
                <div className="comment-thread" key={thread.comment.id}>
                  <CommentRow
                    comment={thread.comment}
                    fresh={thread.comment.id === freshId}
                    onReply={reply}
                  />
                  {thread.replies.length > 0 && (
                    <div className="comment-replies">
                      {thread.replies.map((comment) => (
                        <CommentRow
                          key={comment.id}
                          comment={comment}
                          fresh={comment.id === freshId}
                          onReply={reply}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {user ? (
        <form className="comment-composer" onSubmit={submit}>
          <UserAvatar user={user} className="avatar comment-composer-avatar" />
          <div className="comment-input">
            {replyTo && (
              <span className="comment-target">
                回复 {replyTo.author.displayName}
                <button
                  type="button"
                  aria-label="取消回复"
                  onClick={() => {
                    setReplyTo(null);
                    input.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            <input
              ref={input}
              value={body}
              maxLength={1000}
              placeholder={replyTo ? `回复 ${replyTo.author.displayName}…` : '说点什么…'}
              aria-label="评论内容"
              onChange={(event) => setBody(event.target.value)}
            />
            <button
              type="submit"
              className="comment-send"
              aria-label="发送评论"
              disabled={sending || !body.trim()}
            >
              <SendHorizontal size={14} />
            </button>
          </div>
        </form>
      ) : (
        <Link
          className="comment-composer guest"
          to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
        >
          <span className="avatar comment-composer-avatar guest">
            <MessageCircle size={18} />
          </span>
          <span className="comment-input guest">登录后发表评论…</span>
        </Link>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
