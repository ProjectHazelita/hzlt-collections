import {
  type Comment,
  type CommentInput,
  CommentInputSchema,
  type CommentList,
  type CommentThread,
  MAX_COMMENT_LENGTH,
  type User,
} from '@hcl/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Value } from 'typebox/value';
import { comments, entries, users } from '../db/schema.js';
import { entryId } from '../entries/service.js';
import { DomainError } from '../errors.js';
import type { Database } from '../index.js';
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

export class CommentService {
  constructor(private readonly db: Database) {}

  private async visibleEntry(db: Pick<Database, 'select'>, id: bigint) {
    const [entry] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, id), isNull(entries.deletedAt)))
      .limit(1);
    if (!entry) return notFound();
    return entry;
  }

  async list(entry: string): Promise<CommentList> {
    const parsedId = entryId(entry);
    await this.visibleEntry(this.db, parsedId);
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
        .where(eq(comments.entryId, parsedId))
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

  async create(entry: string, input: CommentInput, user: User): Promise<Comment> {
    const parsedId = entryId(entry);
    if (!Value.Check(CommentInputSchema, input)) return invalid('评论输入无效。');
    const body = input.body.trim();
    if (!body) return invalid('评论内容不能为空。');
    if (Array.from(body).length > MAX_COMMENT_LENGTH) return invalid('评论最多 1000 个字符。');
    if (/\p{Cc}/u.test(body.replaceAll('\n', ''))) return invalid('评论包含无效字符。');
    return this.db.transaction(async (tx) => {
      await this.visibleEntry(tx, parsedId);
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
