import {
  type Comment,
  type CommentInput,
  CommentInputSchema,
  type CommentList,
  type CommentThread,
  MAX_COMMENT_LENGTH,
  type PaginationQuery,
  type User,
  type UserCommentList,
  type UserCommentsCursor,
  UserCommentsCursorSchema,
} from '@hcl/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Value } from 'typebox/value';
import { comments, entries, users } from '../db/schema.js';
import { publicEntries } from '../entries/access.js';
import { entryId } from '../entries/service.js';
import { DomainError } from '../errors.js';
import type { Database } from '../index.js';
import { UserService } from '../profile/users.js';
import { publicUserColumns, toPublicUser } from '../users.js';

type CommentRow = {
  id: bigint;
  entryId: bigint;
  parentId: bigint | null;
  body: string;
  createdAt: Date;
  author: User;
};
const invalid = (message: string): never => {
  throw new DomainError(400, 'VALIDATION_ERROR', message);
};
const notFound = (): never => {
  throw new DomainError(404, 'NOT_FOUND', '条目或评论不存在。');
};
function toComment(row: CommentRow, replyTo: CommentRow | null): Comment {
  return {
    id: row.id.toString(),
    author: row.author,
    body: row.body,
    parentId: row.parentId?.toString() ?? null,
    replyTo: replyTo ? replyTo.author : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function decodeCursor(value: string | undefined): UserCommentsCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid('分页游标无效。');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return invalid('分页游标无效。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalid('分页游标无效。');
  }
  if (!Value.Check(UserCommentsCursorSchema, parsed)) return invalid('分页游标类型无效。');
  entryId(parsed.id);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at))
    return invalid('分页时间无效。');
  const date = new Date(parsed.at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${parsed.at.slice(0, 23)}Z`)
    return invalid('分页时间无效。');
  return parsed;
}

export class CommentService {
  constructor(private readonly db: Database) {}

  private async visibleEntry(db: Pick<Database, 'select'>, id: bigint, user: User | null) {
    const [entry] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, id), publicEntries(user)))
      .limit(1);
    if (!entry) return notFound();
    return entry;
  }

  async list(entry: string, user: User | null = null): Promise<CommentList> {
    const parsedId = entryId(entry);
    await this.visibleEntry(this.db, parsedId, user);
    const rows: CommentRow[] = (
      await this.db
        .select({
          id: comments.id,
          entryId: comments.entryId,
          parentId: comments.parentId,
          body: comments.body,
          createdAt: comments.createdAt,
          author: publicUserColumns,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(
          and(
            eq(comments.entryId, parsedId),
            sql`exists (select 1 from ${entries} where ${entries.id} = ${comments.entryId} and ${publicEntries(user)})`,
          ),
        )
        .orderBy(asc(comments.createdAt), asc(comments.id))
    ).map((row) => ({ ...row, author: toPublicUser(row.author) }));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const children = new Map<bigint, CommentRow[]>();
    const roots: CommentRow[] = [];
    for (const row of rows) {
      const parent = row.parentId ? byId.get(row.parentId) : undefined;
      if (!parent) {
        roots.push(row);
        continue;
      }
      const list = children.get(parent.id) ?? [];
      list.push(row);
      children.set(parent.id, list);
    }
    const threads: CommentThread[] = roots.map((root) => {
      const replies: Comment[] = [];
      // Every descendant is flattened into one visual level, keeping conversation order.
      const stack = [...(children.get(root.id) ?? [])].reverse();
      while (stack.length) {
        const next = stack.pop();
        if (!next) break;
        const parent = next.parentId ? byId.get(next.parentId) : undefined;
        replies.push(toComment(next, parent ?? root));
        stack.push(...[...(children.get(next.id) ?? [])].reverse());
      }
      return { comment: toComment(root, null), replies };
    });
    return { items: threads, total: rows.length };
  }

  async listUser(
    username: string,
    query: PaginationQuery,
    user: User | null = null,
  ): Promise<UserCommentList> {
    const author = await new UserService(this.db).find(username);
    const cursor = decodeCursor(query.cursor);
    const limit = query.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return invalid('分页数量须为 1–50。');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const page = await tx
        .select({
          id: comments.id,
          entryId: comments.entryId,
          parentId: comments.parentId,
          body: comments.body,
          createdAt: comments.createdAt,
          author: publicUserColumns,
          title: sql<
            string | null
          >`case when coalesce((${entries.moderation}->>'titleHidden')::boolean, false) then null else ${entries.title} end`,
          // Preserve PostgreSQL microseconds instead of truncating the pagination boundary.
          at: sql<string>`to_char(${comments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .innerJoin(entries, eq(entries.id, comments.entryId))
        .where(
          and(
            eq(comments.authorId, author.id),
            publicEntries(user),
            cursor
              ? sql`(${comments.createdAt}, ${comments.id}) < (${cursor.at}::timestamptz, ${entryId(cursor.id)}::bigint)`
              : undefined,
          ),
        )
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(limit + 1);
      const shown = page.slice(0, limit);
      const parentIds = shown.flatMap((row) => (row.parentId === null ? [] : [row.parentId]));
      const parents = parentIds.length
        ? await tx
            .select({
              id: comments.id,
              entryId: comments.entryId,
              parentId: comments.parentId,
              body: comments.body,
              createdAt: comments.createdAt,
              author: publicUserColumns,
            })
            .from(comments)
            .innerJoin(users, eq(users.id, comments.authorId))
            .where(inArray(comments.id, parentIds))
        : [];
      const byId = new Map(
        parents.map((row) => [row.id, { ...row, author: toPublicUser(row.author) }]),
      );
      const last = shown.at(-1);
      return {
        items: shown.map((row) => {
          const parent = row.parentId === null ? undefined : byId.get(row.parentId);
          return {
            comment: toComment(
              { ...row, author: toPublicUser(row.author) },
              parent?.entryId === row.entryId ? parent : null,
            ),
            entry: { id: row.entryId.toString(), title: row.title },
          };
        }),
        nextCursor:
          page.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  kind: 'user-comments',
                  at: last.at,
                  id: last.id.toString(),
                } satisfies UserCommentsCursor),
              ).toString('base64url')
            : null,
      };
    });
  }

  async delete(entry: string, comment: string, user: User): Promise<void> {
    const parsedId = entryId(entry);
    const parsedCommentId = entryId(comment);
    await this.db.transaction(async (tx) => {
      // Match create's entry lock so a reply cannot be inserted into a deleted subtree.
      const [visible] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, parsedId), publicEntries(user)))
        .for('update');
      if (!visible) return notFound();
      const [target] = await tx
        .select({ authorId: comments.authorId })
        .from(comments)
        .where(and(eq(comments.id, parsedCommentId), eq(comments.entryId, parsedId)));
      if (!target) return notFound();
      if (target.authorId !== user.id)
        throw new DomainError(403, 'FORBIDDEN', '只能删除自己的评论。');
      await tx.execute(sql`
        with recursive subtree(id) as (
          select ${comments.id} from ${comments}
          where ${comments.id} = ${parsedCommentId} and ${comments.entryId} = ${parsedId}
          union
          select child.id from ${comments} child
          join subtree parent on child.parent_id = parent.id
          where child.entry_id = ${parsedId}
        )
        delete from ${comments}
        where ${comments.entryId} = ${parsedId}
          and ${comments.id} in (select id from subtree)
      `);
    });
  }

  async create(entry: string, input: CommentInput, user: User): Promise<Comment> {
    const parsedId = entryId(entry);
    if (!Value.Check(CommentInputSchema, input)) return invalid('评论输入无效。');
    const body = input.body.trim();
    if (!body) return invalid('评论内容不能为空。');
    if (Array.from(body).length > MAX_COMMENT_LENGTH) return invalid('评论最多 1000 个字符。');
    if (/\p{Cc}/u.test(body.replaceAll('\n', ''))) return invalid('评论包含无效字符。');
    return this.db.transaction(async (tx) => {
      const [visible] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, parsedId), publicEntries(user)))
        .for('update');
      if (!visible) return notFound();
      let parent: CommentRow | undefined;
      if (input.parentId) {
        const [row] = await tx
          .select({
            id: comments.id,
            entryId: comments.entryId,
            parentId: comments.parentId,
            body: comments.body,
            createdAt: comments.createdAt,
            author: publicUserColumns,
          })
          .from(comments)
          .innerJoin(users, eq(users.id, comments.authorId))
          .where(and(eq(comments.id, BigInt(input.parentId)), eq(comments.entryId, parsedId)))
          .limit(1);
        if (!row) return notFound();
        parent = { ...row, author: toPublicUser(row.author) };
      }
      const [created] = await tx
        .insert(comments)
        .values({
          entryId: parsedId,
          authorId: user.id,
          parentId: parent?.id ?? null,
          body,
        })
        .returning({ id: comments.id, createdAt: comments.createdAt });
      if (!created) throw new Error('Comment insertion returned no row');
      return toComment(
        {
          id: created.id,
          entryId: parsedId,
          parentId: parent?.id ?? null,
          body,
          createdAt: created.createdAt,
          author: { ...user },
        },
        parent ?? null,
      );
    });
  }
}
