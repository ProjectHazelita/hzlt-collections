import {
  EntriesCursorSchema,
  type Entry,
  type EntryInput,
  EntryInputSchema,
  type EntryLink,
  type EntryList,
  type EntryModerationInput,
  EntryModerationInputSchema,
  type EntryPatch,
  EntryPatchSchema,
  type EntryReview,
  EntrySchema,
  type FileAsset,
  hasPermission,
  type ImageAsset,
  type ImageFormat,
  type LikeResponse,
  LikesCursorSchema,
  MAX_ENTRY_FILES,
  MAX_ENTRY_IMAGES,
  MAX_ENTRY_LINKS,
  type PaginationQuery,
  type TagsQuery,
  type User,
} from '@hcl/contracts';
import { and, count, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import {
  assets,
  comments,
  entries,
  entryAttachments,
  entryTags,
  likes,
  siteSettings,
  tags,
  users,
} from '../db/schema.js';
import { DomainError } from '../errors.js';
import { hashInput, type Transaction, withIdempotency } from '../idempotency.js';
import type { Database } from '../index.js';
import { freshUser, requirePermission, writeAudit } from '../staff.js';
import { publicUserColumns, toPublicUser } from '../users.js';
import { canReviewEntry, publicEntries, visibleEntries } from './access.js';

type Reader = Pick<Database, 'select'>;
type NormalizedTag = { name: string; normalizedName: string };
type NormalizedAttachment =
  | { kind: 'image' | 'file'; assetId: string }
  | { kind: 'link'; url: string };
type NormalizedInput = {
  title: string | null;
  visibility: Entry['visibility'];
  body: string;
  images: string[];
  files: string[];
  links: { url: string; host: string }[];
  attachments: NormalizedAttachment[];
  tags: NormalizedTag[];
  declarations: { nsfw: boolean; aiGenerated: boolean };
};
type Cursor = { kind: 'entries'; id: string } | { kind: 'likes'; at: string; id: string };
const maxId = 9223372036854775807n;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = (message: string): never => {
  throw new DomainError(400, 'VALIDATION_ERROR', message);
};
const notFound = (): never => {
  throw new DomainError(404, 'NOT_FOUND', '条目或附件不存在。');
};

export function entryId(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) return invalid('条目编号无效。');
  const id = BigInt(value);
  if (id > maxId) return invalid('条目编号超出范围。');
  return id;
}
function normalizeUuidList(values: string[], label: string, limit: number): string[] {
  if (values.length > limit) return invalid(`${label}最多 ${limit} 个。`);
  const seen = new Set<string>();
  for (const value of values) {
    const id = value.toLowerCase();
    if (!uuid.test(id)) return invalid(`${label}编号无效。`);
    if (seen.has(id)) return invalid(`${label}不能重复。`);
    seen.add(id);
  }
  return [...seen];
}
function normalizeLink(raw: string): { url: string; host: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid('链接地址无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return invalid('链接仅支持 http 或 https。');
  if (parsed.username || parsed.password) return invalid('链接不能包含账号或密码。');
  if (!parsed.hostname) return invalid('链接地址无效。');
  const url = parsed.toString();
  if (url.length > 2048) return invalid('链接最多 2048 个字符。');
  return { url, host: parsed.host };
}
function normalize(input: EntryInput): NormalizedInput {
  if (!Value.Check(EntryInputSchema, input)) return invalid('条目输入无效。');
  const title = input.title?.trim() || null;
  if (title !== null && Array.from(title).length > 200) return invalid('标题最多 200 个字符。');
  if (Array.from(input.body).length > 10000) return invalid('正文最多 10000 个字符。');
  const images = normalizeUuidList(input.imageIds ?? [], '图片', MAX_ENTRY_IMAGES);
  const files = normalizeUuidList(input.fileIds ?? [], '文件', MAX_ENTRY_FILES);
  for (const id of images)
    if (files.includes(id)) return invalid('同一文件不能同时作为图片和文件。');
  const links: { url: string; host: string }[] = [];
  const seenLinks = new Set<string>();
  for (const link of input.links ?? []) {
    const normalized = normalizeLink(link.url);
    if (!seenLinks.has(normalized.url)) {
      seenLinks.add(normalized.url);
      links.push(normalized);
    }
  }
  if (links.length > MAX_ENTRY_LINKS) return invalid(`链接最多 ${MAX_ENTRY_LINKS} 个。`);
  if (!input.body.trim() && !images.length && !files.length && !links.length)
    return invalid('条目正文或附件不能为空。');
  const normalizedTags = new Map<string, NormalizedTag>();
  for (const raw of input.tags) {
    const name = raw.trim();
    const normalizedName = name.normalize('NFKC').toLowerCase();
    if (
      !name ||
      Array.from(name).length > 32 ||
      !normalizedName ||
      Array.from(normalizedName).length > 32 ||
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
    visibility: input.visibility ?? 'public',
    body: input.body,
    images,
    files,
    links,
    attachments: [
      ...images.map((assetId) => ({ kind: 'image' as const, assetId })),
      ...files.map((assetId) => ({ kind: 'file' as const, assetId })),
      ...links.map((link) => ({ kind: 'link' as const, url: link.url })),
    ],
    tags: normalizedTagList,
    declarations: { nsfw: input.declarations.nsfw, aiGenerated: input.declarations.aiGenerated },
  };
}
function search(value: string | undefined): string {
  const q = value?.trim() ?? '';
  if (Array.from(q).length > 100) return invalid('搜索内容最多 100 个字符。');
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
function publicFilter(q: string, user: User | null): SQL {
  const visible = publicEntries(user);
  if (!q) return visible;
  const needle = pattern(q);
  return and(
    visible,
    or(
      sql`(not coalesce((${entries.moderation}->>'titleHidden')::boolean, false) and ${entries.title} ilike ${needle} escape '\\')`,
      sql`(not coalesce((${entries.moderation}->>'bodyHidden')::boolean, false) and ${entries.body} ilike ${needle} escape '\\')`,
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

  private async hydrate(
    db: Reader,
    ids: bigint[],
    user: User | null,
    original = false,
  ): Promise<Entry[]> {
    if (!ids.length) return [];
    const rows = await db
      .select({
        entry: entries,
        author: publicUserColumns,
      })
      .from(entries)
      .innerJoin(users, eq(users.id, entries.authorId))
      .where(and(inArray(entries.id, ids), visibleEntries(user)));
    const attachmentRows = await db
      .select({ attachment: entryAttachments, asset: assets })
      .from(entryAttachments)
      .leftJoin(assets, eq(assets.id, entryAttachments.assetId))
      .where(inArray(entryAttachments.entryId, ids))
      .orderBy(entryAttachments.entryId, entryAttachments.position);
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
    const attachmentsMap = new Map<
      bigint,
      { images: ImageAsset[]; files: FileAsset[]; links: EntryLink[] }
    >();
    for (const { attachment, asset } of attachmentRows) {
      let bundle = attachmentsMap.get(attachment.entryId);
      if (!bundle) {
        bundle = { images: [], files: [], links: [] };
        attachmentsMap.set(attachment.entryId, bundle);
      }
      if (attachment.kind === 'link') {
        if (!attachment.url) throw new Error('Published link has no URL');
        bundle.links.push({ url: attachment.url, host: new URL(attachment.url).host });
        continue;
      }
      if (
        !asset ||
        asset.state !== 'ready' ||
        asset.kind !== attachment.kind ||
        asset.bytes <= 0n ||
        asset.bytes > BigInt(Number.MAX_SAFE_INTEGER)
      )
        throw new Error('Published attachment is invalid');
      if (attachment.kind === 'file') {
        bundle.files.push({
          id: asset.id,
          name: asset.displayName.slice(0, 255),
          bytes: Number(asset.bytes),
          extension: (asset.extension ?? '').slice(0, 16),
          downloadUrl: `/media/${asset.id}/download`,
        });
        continue;
      }
      if (
        !asset.thumbnailKey ||
        !['jpeg', 'png', 'webp', 'gif'].includes(asset.format ?? '') ||
        !asset.originalWidth ||
        !asset.originalHeight ||
        !asset.width ||
        !asset.height
      )
        throw new Error('Published image metadata is invalid');
      bundle.images.push({
        id: asset.id,
        name: asset.displayName.slice(0, 255),
        format: asset.format as ImageFormat,
        bytes: Number(asset.bytes),
        originalWidth: asset.originalWidth,
        originalHeight: asset.originalHeight,
        width: asset.width,
        height: asset.height,
        originalUrl: `/media/${asset.id}/original`,
        thumbnailUrl: `/media/${asset.id}/thumbnail`,
        downloadUrl: `/media/${asset.id}/download`,
      });
    }
    const result = new Map<bigint, Entry>();
    for (const { entry, author } of rows) {
      const own = user?.id === entry.authorId;
      const like = likeMap.get(entry.id);
      const bundle = attachmentsMap.get(entry.id) ?? { images: [], files: [], links: [] };
      const moderation = entry.moderation;
      const images = bundle.images.filter((item) => !moderation.hiddenImageIds.includes(item.id));
      const files = bundle.files.filter((item) => !moderation.hiddenFileIds.includes(item.id));
      const links = bundle.links.filter((item) => !moderation.hiddenLinkUrls.includes(item.url));
      const hidden =
        moderation.hidden ||
        ((!entry.body.trim() || moderation.bodyHidden) &&
          !images.length &&
          !files.length &&
          !links.length);
      result.set(entry.id, {
        id: entry.id.toString(),
        visibility: entry.visibility,
        author: toPublicUser(author),
        title: original
          ? entry.title
          : hidden || moderation.titleHidden
            ? '标题已隐藏'
            : entry.title,
        body: original ? entry.body : hidden || moderation.bodyHidden ? '' : entry.body,
        tags: hidden && !original ? [] : (tagMap.get(entry.id) ?? []),
        declarations: { nsfw: entry.nsfw, aiGenerated: entry.aiGenerated },
        images: original ? bundle.images : hidden ? [] : images,
        files: original ? bundle.files : hidden ? [] : files,
        links: original ? bundle.links : hidden ? [] : links,
        likeCount: like?.total ?? 0,
        likedByMe: like?.mine ?? false,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        canEdit: own,
        canDelete: own || user?.role === 'owner',
        moderation: {
          hidden,
          titleHidden: moderation.titleHidden,
          bodyHidden: moderation.bodyHidden,
          hiddenImageCount: bundle.images.length - images.length,
          hiddenFileCount: bundle.files.length - files.length,
          hiddenLinkCount: bundle.links.length - links.length,
        },
      });
    }
    return ids.flatMap((id) => {
      const entry = result.get(id);
      return entry ? [entry] : [];
    });
  }

  async list(
    query: { q?: string; cursor?: string; limit?: number },
    user: User | null,
    authorId?: string,
    manage = false,
  ): Promise<EntryList> {
    const filter = and(
      manage
        ? and(
            visibleEntries(user),
            hasPermission(user, 'content.restricted')
              ? undefined
              : or(
                  eq(entries.visibility, 'public'),
                  eq(entries.visibility, 'registered'),
                  eq(entries.authorId, user!.id),
                ),
          )
        : publicFilter(search(query.q), user),
      authorId ? eq(entries.authorId, authorId) : undefined,
    )!;
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

  private async validateAssets(
    tx: Transaction,
    user: User,
    input: NormalizedInput,
    currentEntryId: bigint | null,
  ): Promise<void> {
    const expected = new Map<string, 'image' | 'file'>();
    for (const id of input.images) expected.set(id, 'image');
    for (const id of input.files) expected.set(id, 'file');
    if (!expected.size) return;
    const ids = [...expected.keys()];
    const rows = await tx
      .select()
      .from(assets)
      .where(and(inArray(assets.id, ids), eq(assets.ownerId, user.id)))
      .for('update');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const used = await tx
      .select({ assetId: entryAttachments.assetId, entryId: entryAttachments.entryId })
      .from(entryAttachments)
      .where(inArray(entryAttachments.assetId, ids));
    const usedAsAvatar = await tx
      .select({ assetId: users.avatarAssetId })
      .from(users)
      .where(inArray(users.avatarAssetId, ids));
    if (usedAsAvatar.length) return invalid('头像图片不能作为条目附件。');
    const usedAsLogo = await tx
      .select({ assetId: siteSettings.logoAssetId })
      .from(siteSettings)
      .where(inArray(siteSettings.logoAssetId, ids));
    if (usedAsLogo.length) return invalid('站点 Logo 不能作为条目附件。');
    const usedByOther = new Set<string>();
    const attachedToCurrent = new Set<string>();
    for (const row of used) {
      if (!row.assetId) continue;
      if (row.entryId === currentEntryId) attachedToCurrent.add(row.assetId);
      else usedByOther.add(row.assetId);
    }
    for (const [id, kind] of expected) {
      const asset = byId.get(id);
      if (!asset) return notFound();
      if (asset.kind !== kind) return invalid('附件类型不匹配。');
      if (usedByOther.has(id))
        throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该附件已被其他条目使用。');
      if (!attachedToCurrent.has(id) && asset.expiresAt && asset.expiresAt.getTime() <= Date.now())
        throw new DomainError(409, 'UPLOAD_EXPIRED', '该附件已过期。');
      if (asset.state !== 'ready')
        throw new DomainError(409, 'UPLOAD_NOT_READY', '该附件尚未就绪。');
    }
    await tx.update(assets).set({ expiresAt: null }).where(inArray(assets.id, ids));
  }

  private async insertAttachments(
    tx: Transaction,
    id: bigint,
    input: NormalizedInput,
  ): Promise<void> {
    if (!input.attachments.length) return;
    await tx.insert(entryAttachments).values(
      input.attachments.map((attachment, position) => ({
        entryId: id,
        kind: attachment.kind,
        assetId: attachment.kind === 'link' ? null : attachment.assetId,
        url: attachment.kind === 'link' ? attachment.url : null,
        position,
      })),
    );
  }

  async create(input: EntryInput, user: User, key: string): Promise<Entry> {
    const normalized = normalize(input);
    if (!uuid.test(key)) return invalid('幂等键须为 UUID。');
    const result = await withIdempotency(
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
        await this.validateAssets(tx, user, normalized, null);
        const [created] = await tx
          .insert(entries)
          .values({
            authorId: user.id,
            title: normalized.title,
            body: normalized.body,
            visibility: normalized.visibility,
            nsfw: normalized.declarations.nsfw,
            aiGenerated: normalized.declarations.aiGenerated,
          })
          .returning({ id: entries.id });
        if (!created) throw new Error('Entry insertion returned no row');
        await this.replaceTags(tx, created.id, normalized.tags);
        await this.insertAttachments(tx, created.id, normalized);
        const [entry] = await this.hydrate(tx, [created.id], user);
        if (!entry) throw new Error('Created entry disappeared');
        return entry;
      },
    );
    // Stored idempotency responses must never revive a subsequently hidden original.
    return this.get(result.id, user);
  }

  async update(id: string, input: EntryPatch, user: User): Promise<Entry> {
    const parsedId = entryId(id);
    if (!Value.Check(EntryPatchSchema, input)) return invalid('条目修改输入无效。');
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, parsedId), visibleEntries(user)))
        .for('update');
      if (!existing) return notFound();
      if (existing.authorId !== user.id)
        throw new DomainError(403, 'FORBIDDEN', '只有作者可以编辑条目。');
      const existingTags = await tx
        .select({ name: tags.name })
        .from(entryTags)
        .innerJoin(tags, eq(tags.id, entryTags.tagId))
        .where(eq(entryTags.entryId, parsedId));
      const existingAttachments = await tx
        .select()
        .from(entryAttachments)
        .where(eq(entryAttachments.entryId, parsedId))
        .orderBy(entryAttachments.position);
      const existingImages: string[] = [];
      const existingFiles: string[] = [];
      const existingLinks: { url: string }[] = [];
      for (const row of existingAttachments) {
        if (row.kind === 'image' && row.assetId) existingImages.push(row.assetId);
        else if (row.kind === 'file' && row.assetId) existingFiles.push(row.assetId);
        else if (row.kind === 'link' && row.url) existingLinks.push({ url: row.url });
      }
      const normalized = normalize({
        title: input.title !== undefined ? input.title : existing.title,
        body: input.body ?? existing.body,
        visibility: input.visibility ?? existing.visibility,
        imageIds: input.imageIds ?? existingImages,
        fileIds: input.fileIds ?? existingFiles,
        links: input.links ?? existingLinks,
        tags: input.tags ?? existingTags.map((tag) => tag.name),
        declarations: input.declarations ?? {
          nsfw: existing.nsfw,
          aiGenerated: existing.aiGenerated,
        },
      });
      await this.validateAssets(tx, user, normalized, parsedId);
      await tx
        .update(entries)
        .set({
          title: normalized.title,
          body: normalized.body,
          visibility: normalized.visibility,
          nsfw: normalized.declarations.nsfw,
          aiGenerated: normalized.declarations.aiGenerated,
          updatedAt: new Date(),
        })
        .where(eq(entries.id, parsedId));
      if (input.tags !== undefined) await this.replaceTags(tx, parsedId, normalized.tags);
      const attachmentsChanged =
        input.imageIds !== undefined || input.fileIds !== undefined || input.links !== undefined;
      if (attachmentsChanged) {
        await tx.delete(entryAttachments).where(eq(entryAttachments.entryId, parsedId));
        await this.insertAttachments(tx, parsedId, normalized);
        const kept = new Set([...normalized.images, ...normalized.files]);
        const removed: string[] = [];
        for (const row of existingAttachments) {
          if (row.assetId && !kept.has(row.assetId)) removed.push(row.assetId);
        }
        for (const assetId of removed) {
          await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, assetId));
          const jobId = await this.boss.send(
            'asset-delete',
            { assetId },
            { db: fromDrizzle(tx, sql) },
          );
          if (!jobId) throw new Error('Asset deletion enqueue returned no job');
        }
      }
      const [entry] = await this.hydrate(tx, [parsedId], user);
      if (!entry) throw new Error('Updated entry disappeared');
      return entry;
    });
  }

  async delete(id: string, user: User, reason?: string): Promise<void> {
    const parsedId = entryId(id);
    await this.db.transaction(async (tx) => {
      user = await freshUser(tx, user.id);
      const [entry] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, parsedId), visibleEntries(user)))
        .for('update');
      if (!entry) return notFound();
      if (reason !== undefined) {
        requirePermission(user, 'content.delete');
        this.requireRestrictedReview(entry.visibility, entry.authorId, user);
      }
      if (reason === undefined && entry.authorId !== user.id && user.role !== 'owner')
        throw new DomainError(403, 'FORBIDDEN', '没有删除该条目的权限。');
      if (reason !== undefined || entry.authorId !== user.id)
        await writeAudit(tx, {
          actorId: user.id,
          action: 'content.delete',
          targetType: 'entry',
          targetId: id,
          reason: reason ?? 'Owner deleted entry',
        });
      const now = new Date();
      await tx
        .update(entries)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(entries.id, parsedId));
      await tx.delete(likes).where(eq(likes.entryId, parsedId));
      await tx.delete(comments).where(eq(comments.entryId, parsedId));
      const attachments = await tx
        .select({ assetId: entryAttachments.assetId })
        .from(entryAttachments)
        .where(eq(entryAttachments.entryId, parsedId));
      await tx.delete(entryAttachments).where(eq(entryAttachments.entryId, parsedId));
      for (const { assetId } of attachments) {
        if (!assetId) continue;
        await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, assetId));
        const jobId = await this.boss.send(
          'asset-delete',
          { assetId },
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
        .where(and(eq(entries.id, parsedId), publicEntries(user)))
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
    const filter = and(eq(likes.userId, user.id), publicEntries(user));
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

  async suggestTags(query: TagsQuery, user: User | null = null): Promise<string[]> {
    const q = search(query.q);
    const rows = await this.db
      .select({ name: tags.name })
      .from(tags)
      .where(
        and(
          q ? sql`${tags.name} ilike ${pattern(q)} escape '\\'` : undefined,
          sql`exists (select 1 from ${entryTags} join ${entries} on ${entries.id} = ${entryTags.entryId}
        where ${entryTags.tagId} = ${tags.id} and ${publicEntries(user)})`,
        ),
      )
      .orderBy(tags.normalizedName)
      .limit(limitOf(query.limit, 20));
    return rows.map((row) => row.name);
  }

  private requireRestrictedReview(
    visibility: Entry['visibility'],
    authorId: string,
    user: User,
  ): void {
    if (authorId !== user.id && visibility !== 'public' && visibility !== 'registered')
      requirePermission(user, 'content.restricted');
  }

  async review(id: string, user: User): Promise<EntryReview> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read`);
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, entryId(id)), visibleEntries(user)));
      if (!row) return notFound();
      if (row.authorId !== user.id) {
        if (!canReviewEntry(user)) requirePermission(user, 'content.moderate');
        this.requireRestrictedReview(row.visibility, row.authorId, user);
      }
      const [entry] = await this.hydrate(tx, [row.id], user, true);
      if (!entry) return notFound();
      return { entry, moderation: row.moderation };
    });
  }

  async moderate(id: string, input: EntryModerationInput, user: User): Promise<EntryReview> {
    if (!Value.Check(EntryModerationInputSchema, input)) return invalid('管理输入无效。');
    requirePermission(user, 'content.moderate');
    const reason = input.reason.trim();
    if (!reason) return invalid('请填写管理原因。');
    await this.db.transaction(async (tx) => {
      user = await freshUser(tx, user.id);
      requirePermission(user, 'content.moderate');
      const [row] = await tx
        .select()
        .from(entries)
        .where(and(eq(entries.id, entryId(id)), visibleEntries(user)))
        .for('update');
      if (!row) return notFound();
      this.requireRestrictedReview(row.visibility, row.authorId, user);
      if (row.authorId === user.id && !input.hidden)
        throw new DomainError(403, 'FORBIDDEN', '不能解除对自己内容的限制。');
      const moderation = {
        ...row.moderation,
        hiddenImageIds: [...row.moderation.hiddenImageIds],
        hiddenFileIds: [...row.moderation.hiddenFileIds],
        hiddenLinkUrls: [...row.moderation.hiddenLinkUrls],
        reason,
      };
      if (input.target === 'entry') moderation.hidden = input.hidden;
      else if (input.target === 'title') moderation.titleHidden = input.hidden;
      else if (input.target === 'body') moderation.bodyHidden = input.hidden;
      else {
        const targetId = input.targetId;
        if (!targetId) return invalid('请选择需要处理的附件。');
        const key =
          input.target === 'image'
            ? 'hiddenImageIds'
            : input.target === 'file'
              ? 'hiddenFileIds'
              : 'hiddenLinkUrls';
        const [attachment] = await tx
          .select()
          .from(entryAttachments)
          .where(
            and(
              eq(entryAttachments.entryId, row.id),
              eq(entryAttachments.kind, input.target),
              input.target === 'link'
                ? eq(entryAttachments.url, targetId)
                : uuid.test(targetId)
                  ? eq(entryAttachments.assetId, targetId)
                  : sql`false`,
            ),
          );
        if (!attachment && !moderation[key].includes(targetId)) return notFound();
        moderation[key] = input.hidden
          ? [...new Set([...moderation[key], targetId])]
          : moderation[key].filter((value) => value !== targetId);
      }
      await tx
        .update(entries)
        .set({ moderation, updatedAt: new Date() })
        .where(eq(entries.id, row.id));
      await writeAudit(tx, {
        actorId: user.id,
        action: `content.${input.hidden ? 'hide' : 'restore'}.${input.target}`,
        targetType: 'entry',
        targetId: id,
        reason,
      });
    });
    return this.review(id, user);
  }

  async listAdmin(query: PaginationQuery, user: User): Promise<EntryList> {
    if (!canReviewEntry(user)) requirePermission(user, 'content.moderate');
    return this.list(query, user, undefined, true);
  }
}
