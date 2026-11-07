import {
  type Asset,
  EntriesCursorSchema,
  type EntriesQuery,
  type Entry,
  type EntryInput,
  EntryInputSchema,
  type EntryList,
  type EntryPatch,
  EntryPatchSchema,
  EntrySchema,
  type LikeResponse,
  LikesCursorSchema,
  type PaginationQuery,
  type TagsQuery,
  type User,
} from '@hcl/contracts';
import { and, count, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import { assets, entries, entryTags, likes, tags, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import { hashInput, type Transaction, withIdempotency } from '../idempotency.js';
import type { Database } from '../index.js';

type Reader = Pick<Database, 'select'>;
type NormalizedTag = { name: string; normalizedName: string };
type NormalizedInput = {
  title: string | null;
  body: string;
  assetId: string | null;
  tags: NormalizedTag[];
  declarations: { nsfw: boolean; aiGenerated: boolean };
};
type Cursor = { kind: 'entries'; id: string } | { kind: 'likes'; at: string; id: string };
const maxId = 9223372036854775807n;
const invalid = (message: string): never => {
  throw new DomainError(400, 'VALIDATION_ERROR', message);
};
const notFound = (): never => {
  throw new DomainError(404, 'NOT_FOUND', '条目或图片不存在。');
};

function entryId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) return invalid('条目编号无效。');
  const id = BigInt(value);
  if (id > maxId) return invalid('条目编号超出范围。');
  return id;
}
function length(value: string): number {
  return Array.from(value).length;
}
function normalize(input: EntryInput): NormalizedInput {
  if (!Value.Check(EntryInputSchema, input)) return invalid('条目输入无效。');
  const title = input.title?.trim() || null;
  if (title !== null && length(title) > 200) return invalid('标题最多 200 个字符。');
  if (length(input.body) > 10000) return invalid('正文最多 10000 个字符。');
  const assetId = input.assetId?.toLowerCase() ?? null;
  if (!assetId && !input.body.trim()) return invalid('纯文字条目的正文不能为空。');
  if (assetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(assetId))
    return invalid('图片编号须为 UUID。');
  const normalizedTags = new Map<string, NormalizedTag>();
  for (const raw of input.tags) {
    const name = raw.trim();
    const normalizedName = name.normalize('NFKC').toLowerCase();
    if (
      !name ||
      length(name) > 32 ||
      !normalizedName ||
      length(normalizedName) > 32 ||
      /\p{Cc}/u.test(raw) ||
      /\p{Cc}/u.test(normalizedName)
    )
      return invalid('标签须为 1–32 个字符且不能含控制字符。');
    if (!normalizedTags.has(normalizedName))
      normalizedTags.set(normalizedName, { name, normalizedName });
  }
  // Tags are a set; canonical order also makes reversed submissions the same idempotent input.
  const normalizedTagList = [...normalizedTags.values()].sort((a, b) =>
    a.normalizedName < b.normalizedName ? -1 : a.normalizedName > b.normalizedName ? 1 : 0,
  );
  return {
    title,
    body: input.body,
    assetId,
    tags: normalizedTagList,
    declarations: { nsfw: input.declarations.nsfw, aiGenerated: input.declarations.aiGenerated },
  };
}
function search(value: string | undefined): string {
  const q = value?.trim() ?? '';
  if (length(q) > 100) return invalid('搜索内容最多 100 个字符。');
  return q;
}
function pattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
function limitOf(value: number | undefined, fallback = 30): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return invalid('分页数量须为 1–50。');
  return limit;
}
function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
function decode(
  value: string | undefined,
  kind: 'entries',
): Extract<Cursor, { kind: 'entries' }> | undefined;
function decode(
  value: string | undefined,
  kind: 'likes',
): Extract<Cursor, { kind: 'likes' }> | undefined;
function decode(value: string | undefined, kind: Cursor['kind']): Cursor | undefined {
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
  if (kind === 'likes') {
    if (!Value.Check(LikesCursorSchema, parsed)) return invalid('分页游标类型无效。');
    entryId(parsed.id);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at))
      return invalid('分页时间无效。');
    const date = new Date(parsed.at);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${parsed.at.slice(0, 23)}Z`)
      return invalid('分页时间无效。');
    return parsed;
  }
  if (!Value.Check(EntriesCursorSchema, parsed)) return invalid('分页游标类型无效。');
  entryId(parsed.id);
  return parsed;
}
function publicFilter(q: string): SQL {
  const visible = isNull(entries.deletedAt);
  if (!q) return visible;
  const needle = pattern(q);
  return and(
    visible,
    or(
      sql`${entries.title} ilike ${needle} escape '\\'`,
      sql`${entries.body} ilike ${needle} escape '\\'`,
      sql`exists (select 1 from ${entryTags} join ${tags} on ${tags.id} = ${entryTags.tagId}
      where ${entryTags.entryId} = ${entries.id} and ${tags.name} ilike ${needle} escape '\\')`,
    ),
  )!;
}

export class EntryService {
  constructor(
    private readonly db: Database,
    private readonly boss: PgBoss,
  ) {}

  private async hydrate(db: Reader, ids: bigint[], user: User | null): Promise<Entry[]> {
    if (!ids.length) return [];
    const rows = await db
      .select({
        entry: entries,
        author: { id: users.id, username: users.username, role: users.role },
        asset: assets,
      })
      .from(entries)
      .innerJoin(users, eq(users.id, entries.authorId))
      .leftJoin(assets, eq(assets.id, entries.assetId))
      .where(and(inArray(entries.id, ids), isNull(entries.deletedAt)));
    const tagRows = await db
      .select({ entryId: entryTags.entryId, name: tags.name })
      .from(entryTags)
      .innerJoin(tags, eq(tags.id, entryTags.tagId))
      .where(inArray(entryTags.entryId, ids))
      .orderBy(tags.normalizedName);
    const likeRows = await db
      .select({
        entryId: likes.entryId,
        total: count(),
        mine: user ? sql<boolean>`bool_or(${likes.userId} = ${user.id})` : sql<boolean>`false`,
      })
      .from(likes)
      .where(inArray(likes.entryId, ids))
      .groupBy(likes.entryId);
    const tagMap = new Map<bigint, string[]>();
    for (const row of tagRows) {
      const list = tagMap.get(row.entryId) ?? [];
      list.push(row.name);
      tagMap.set(row.entryId, list);
    }
    const likeMap = new Map(likeRows.map((row) => [row.entryId, row]));
    const result = new Map<bigint, Entry>();
    for (const { entry, author, asset } of rows) {
      let publicAsset: Asset | null = null;
      if (entry.assetId) {
        if (
          !asset ||
          asset.state !== 'ready' ||
          !asset.thumbnailKey ||
          !['jpeg', 'png', 'webp', 'gif'].includes(asset.format ?? '') ||
          !asset.originalWidth ||
          !asset.originalHeight ||
          !asset.width ||
          !asset.height ||
          asset.bytes <= 0n ||
          asset.bytes > BigInt(Number.MAX_SAFE_INTEGER)
        )
          throw new Error('Published asset metadata is invalid');
        publicAsset = {
          id: asset.id,
          format: asset.format as Asset['format'],
          bytes: Number(asset.bytes),
          originalWidth: asset.originalWidth,
          originalHeight: asset.originalHeight,
          width: asset.width,
          height: asset.height,
          originalUrl: `/media/${asset.id}/original`,
          thumbnailUrl: `/media/${asset.id}/thumbnail`,
          downloadUrl: `/media/${asset.id}/download`,
        };
      }
      const own = user?.id === entry.authorId;
      const like = likeMap.get(entry.id);
      result.set(entry.id, {
        id: entry.id.toString(),
        author,
        title: entry.title,
        body: entry.body,
        tags: tagMap.get(entry.id) ?? [],
        declarations: { nsfw: entry.nsfw, aiGenerated: entry.aiGenerated },
        asset: publicAsset,
        likeCount: like?.total ?? 0,
        likedByMe: like?.mine ?? false,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        canEdit: own,
        canDelete: own || user?.role === 'owner',
      });
    }
    return ids.flatMap((id) => {
      const entry = result.get(id);
      return entry ? [entry] : [];
    });
  }

  async list(query: EntriesQuery, user: User | null): Promise<EntryList> {
    const filter = publicFilter(search(query.q));
    const cursor = decode(query.cursor, 'entries');
    const limit = limitOf(query.limit);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const [total] = await tx.select({ value: count() }).from(entries).where(filter);
      const page = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(and(filter, cursor ? lt(entries.id, entryId(cursor.id)) : undefined))
        .orderBy(desc(entries.id))
        .limit(limit + 1);
      const shown = page.slice(0, limit);
      return {
        items: await this.hydrate(
          tx,
          shown.map((row) => row.id),
          user,
        ),
        total: total!.value,
        nextCursor:
          page.length > limit ? encode({ kind: 'entries', id: shown.at(-1)!.id.toString() }) : null,
      };
    });
  }

  async get(id: string, user: User | null): Promise<Entry> {
    const parsedId = entryId(id);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const [entry] = await this.hydrate(tx, [parsedId], user);
      return entry ?? notFound();
    });
  }

  private async replaceTags(
    tx: Transaction,
    id: bigint,
    normalizedTags: NormalizedTag[],
  ): Promise<void> {
    await tx.delete(entryTags).where(eq(entryTags.entryId, id));
    if (!normalizedTags.length) return;
    // Sorted lock acquisition avoids deadlocks between overlapping tag sets.
    const tagIds: string[] = [];
    for (const tag of normalizedTags) {
      await tx.insert(tags).values(tag).onConflictDoNothing({ target: tags.normalizedName });
      const [row] = await tx
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.normalizedName, tag.normalizedName));
      if (!row) throw new Error('Tag insertion returned no row');
      tagIds.push(row.id);
    }
    await tx.insert(entryTags).values(tagIds.map((tagId) => ({ entryId: id, tagId })));
  }

  async create(input: EntryInput, user: User, key: string): Promise<Entry> {
    const normalized = normalize(input);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
      return invalid('幂等键须为 UUID。');
    return withIdempotency(
      this.db,
      {
        userId: user.id,
        operation: 'entry-create',
        key,
        requestHash: hashInput(normalized),
        statusCode: 201,
      },
      (value): value is Entry => Value.Check(EntrySchema, value),
      async (tx) => {
        if (normalized.assetId) {
          const [asset] = await tx
            .select()
            .from(assets)
            .where(and(eq(assets.id, normalized.assetId), eq(assets.ownerId, user.id)))
            .for('update');
          if (!asset) return notFound();
          const [used] = await tx
            .select({ id: entries.id })
            .from(entries)
            .where(eq(entries.assetId, asset.id))
            .limit(1);
          if (used) throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该图片已被使用。');
          if (asset.expiresAt && asset.expiresAt.getTime() <= Date.now())
            throw new DomainError(409, 'UPLOAD_EXPIRED', '该图片已过期。');
          if (asset.state !== 'ready')
            throw new DomainError(409, 'UPLOAD_NOT_READY', '该图片尚未就绪。');
        }
        const [created] = await tx
          .insert(entries)
          .values({
            authorId: user.id,
            title: normalized.title,
            body: normalized.body,
            assetId: normalized.assetId,
            nsfw: normalized.declarations.nsfw,
            aiGenerated: normalized.declarations.aiGenerated,
          })
          .returning({ id: entries.id });
        if (!created) throw new Error('Entry insertion returned no row');
        await this.replaceTags(tx, created.id, normalized.tags);
        const [entry] = await this.hydrate(tx, [created.id], user);
        if (!entry) throw new Error('Created entry disappeared');
        return entry;
      },
    );
  }

  async update(id: string, input: EntryPatch, user: User): Promise<Entry> {
    const parsedId = entryId(id);
    if (!Value.Check(EntryPatchSchema, input)) return invalid('条目修改输入无效。');
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, parsedId), isNull(entries.deletedAt)))
        .for('update');
      if (!existing) return notFound();
      if (existing.authorId !== user.id)
        throw new DomainError(403, 'FORBIDDEN', '只有作者可以编辑条目。');
      const existingTags = await tx
        .select({ name: tags.name })
        .from(entryTags)
        .innerJoin(tags, eq(tags.id, entryTags.tagId))
        .where(eq(entryTags.entryId, parsedId));
      const normalized = normalize({
        title: input.title !== undefined ? input.title : existing.title,
        body: input.body ?? existing.body,
        assetId: existing.assetId,
        tags: input.tags ?? existingTags.map((tag) => tag.name),
        declarations: input.declarations ?? {
          nsfw: existing.nsfw,
          aiGenerated: existing.aiGenerated,
        },
      });
      await tx
        .update(entries)
        .set({
          title: normalized.title,
          body: normalized.body,
          nsfw: normalized.declarations.nsfw,
          aiGenerated: normalized.declarations.aiGenerated,
          updatedAt: new Date(),
        })
        .where(eq(entries.id, parsedId));
      if (input.tags !== undefined) await this.replaceTags(tx, parsedId, normalized.tags);
      const [entry] = await this.hydrate(tx, [parsedId], user);
      if (!entry) throw new Error('Updated entry disappeared');
      return entry;
    });
  }

  async delete(id: string, user: User): Promise<void> {
    const parsedId = entryId(id);
    await this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, parsedId), isNull(entries.deletedAt)))
        .for('update');
      if (!entry) return notFound();
      if (entry.authorId !== user.id && user.role !== 'owner')
        throw new DomainError(403, 'FORBIDDEN', '没有删除该条目的权限。');
      const now = new Date();
      await tx
        .update(entries)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(entries.id, parsedId));
      await tx.delete(likes).where(eq(likes.entryId, parsedId));
      if (entry.assetId) {
        await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, entry.assetId));
        const jobId = await this.boss.send(
          'asset-delete',
          { assetId: entry.assetId },
          { db: fromDrizzle(tx, sql) },
        );
        if (!jobId) throw new Error('Asset deletion enqueue returned no job');
      }
    });
  }

  async setLike(id: string, user: User, liked: boolean): Promise<LikeResponse> {
    const parsedId = entryId(id);
    return this.db.transaction(async (tx) => {
      // Serializes both like operations and deletion, including the returned count.
      const [entry] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, parsedId), isNull(entries.deletedAt)))
        .for('update');
      if (!entry) return notFound();
      if (liked)
        await tx.insert(likes).values({ userId: user.id, entryId: parsedId }).onConflictDoNothing();
      else
        await tx.delete(likes).where(and(eq(likes.userId, user.id), eq(likes.entryId, parsedId)));
      const [total] = await tx
        .select({ value: count() })
        .from(likes)
        .where(eq(likes.entryId, parsedId));
      return { likedByMe: liked, likeCount: total!.value };
    });
  }

  async listLikes(query: PaginationQuery, user: User): Promise<EntryList> {
    const cursor = decode(query.cursor, 'likes');
    const limit = limitOf(query.limit);
    const filter = and(eq(likes.userId, user.id), isNull(entries.deletedAt));
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const [total] = await tx
        .select({ value: count() })
        .from(likes)
        .innerJoin(entries, eq(entries.id, likes.entryId))
        .where(filter);
      // PostgreSQL microseconds must survive cursors; JS Date would truncate and skip ties.
      const page = await tx
        .select({
          id: entries.id,
          at: sql<string>`to_char(${likes.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(likes)
        .innerJoin(entries, eq(entries.id, likes.entryId))
        .where(
          and(
            filter,
            cursor
              ? sql`(${likes.createdAt}, ${likes.entryId}) < (${cursor.at}::timestamptz, ${entryId(cursor.id)}::bigint)`
              : undefined,
          ),
        )
        .orderBy(desc(likes.createdAt), desc(likes.entryId))
        .limit(limit + 1);
      const shown = page.slice(0, limit);
      const last = shown.at(-1);
      return {
        items: await this.hydrate(
          tx,
          shown.map((row) => row.id),
          user,
        ),
        total: total!.value,
        nextCursor:
          page.length > limit && last
            ? encode({ kind: 'likes', id: last.id.toString(), at: last.at })
            : null,
      };
    });
  }

  async suggestTags(query: TagsQuery): Promise<string[]> {
    const q = search(query.q);
    const rows = await this.db
      .select({ name: tags.name })
      .from(tags)
      .where(
        and(
          q ? sql`${tags.name} ilike ${pattern(q)} escape '\\'` : undefined,
          sql`exists (select 1 from ${entryTags} join ${entries} on ${entries.id} = ${entryTags.entryId}
        where ${entryTags.tagId} = ${tags.id} and ${entries.deletedAt} is null)`,
        ),
      )
      .orderBy(tags.normalizedName)
      .limit(limitOf(query.limit, 20));
    return rows.map((row) => row.name);
  }

  async listAdmin(query: PaginationQuery, user: User): Promise<EntryList> {
    if (user.role !== 'owner')
      throw new DomainError(403, 'FORBIDDEN', '只有站点所有者可以管理全站内容。');
    return this.list(query, user);
  }
}
