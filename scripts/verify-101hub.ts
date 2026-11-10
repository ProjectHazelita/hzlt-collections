import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { Entry } from '../packages/contracts/src/index.js';
import { normalizeUsername } from '../packages/server/src/auth/service.js';
import { createDatabase, LocalStorage } from '../packages/server/src/index.js';

// No sessions, credentials, migrations, storage initialization, or write-capable SQL.
const sharp = createRequire(new URL('../apps/api/package.json', import.meta.url))('sharp');
type UserMap = { sourceId: number; targetId: string };
type PostMap = UserMap & { assetId: string };
type AvatarMap = { sourceUserId: number; assetId: string };
type Manifest = {
  version: 1;
  sourceDatabaseSha256: string;
  visibility: 'public' | 'registered';
  counts: Record<
    'users' | 'posts' | 'avatars' | 'comments' | 'tags' | 'postTags' | 'likes',
    number
  >;
  users: UserMap[];
  posts: PostMap[];
  avatars: AvatarMap[];
  comments: UserMap[];
};
type SourceUser = {
  id: number;
  username: string;
  nickname: string;
  password_hash: string;
  role: string;
  disabled_at: string | null;
  created_at: string;
  avatar_key: string | null;
};
type SourcePost = {
  id: number;
  author_id: number;
  title: string;
  original_key: string;
  original_name: string;
  created_at: string;
  updated_at: string;
};
type SourceComment = {
  id: number;
  post_id: number;
  author_id: number;
  body: string;
  reply_to_id: number | null;
  created_at: string;
};
type SourceLike = { user_id: number; post_id: number; created_at: string };
type SourceTag = { id: number; name: string; normalized_name: string };
type SourcePostTag = { post_id: number; tag_id: number };
type Row = Record<string, any>;
class VerificationError extends Error {}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new VerificationError(message);
}
function same(actual: unknown, expected: unknown, message: string) {
  check(actual === expected, message);
}
function date(value: unknown, label: string) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  check(Number.isFinite(timestamp), label + ': invalid date');
  return timestamp;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decimal = /^[1-9][0-9]*$/;
function mappings(rows: UserMap[], ids: number[], targetPattern: RegExp, label: string) {
  check(Array.isArray(rows), label + ': missing manifest mappings');
  same(rows.length, ids.length, label + ': mapping count mismatch');
  const expected = new Set(ids);
  const targets = new Set<string>();
  const result = new Map<number, string>();
  for (const row of rows) {
    check(
      Number.isSafeInteger(row.sourceId) && expected.has(row.sourceId),
      label + ': unknown source ID',
    );
    check(!result.has(row.sourceId), label + ': duplicate source ID');
    check(
      typeof row.targetId === 'string' && targetPattern.test(row.targetId),
      label + ': invalid target ID',
    );
    check(!targets.has(row.targetId), label + ': duplicate target ID');
    result.set(row.sourceId, row.targetId);
    targets.add(row.targetId);
  }
  return result;
}
function indexed(rows: Row[], key = 'id') {
  return new Map(rows.map((row) => [String(row[key]), row]));
}
function equalSet(actual: string[], expected: string[], label: string) {
  same(actual.length, expected.length, label + ': count mismatch');
  const wanted = new Set(expected);
  same(wanted.size, expected.length, label + ': duplicate expected relationship');
  for (const item of actual)
    check(wanted.delete(item), label + ': unexpected or duplicate relationship');
  same(wanted.size, 0, label + ': missing relationship');
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function containedFile(root: string, path: string, label: string) {
  const resolved = await realpath(path);
  check(resolved.startsWith(root + sep), label + ': file escapes media root');
  check((await stat(resolved)).isFile(), label + ': not a regular file');
  return resolved;
}
async function webp(bytes: Uint8Array, label: string) {
  const image = sharp(bytes, { failOn: 'warning' });
  const metadata = await image.metadata();
  check(
    metadata.format === 'webp' && metadata.width > 0 && metadata.height > 0,
    label + ': invalid WebP',
  );
  // metadata alone does not detect a truncated pixel stream.
  await image.raw().toBuffer();
}

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      manifest: { type: 'string' },
      'expect-database': { type: 'string' },
      owner: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx scripts/verify-101hub.ts --source /snapshot --manifest /private/manifest.json --expect-database hcl [--owner SOURCE_USERNAME]',
    );
    console.log(
      'Required environment: DATABASE_URL, DATA_DIR (absolute). Optional: API_BASE_URL (exact HTTP origin).',
    );
    console.log(
      'Read-only DB/file verification; API_BASE_URL adds health/avatar checks and public-entry/media checks. Registered entries remain DB-only.',
    );
    return;
  }
  check(
    values.source && isAbsolute(values.source),
    '--source must be an absolute snapshot directory',
  );
  check(
    values.manifest && isAbsolute(values.manifest),
    '--manifest must be an absolute private manifest path',
  );
  same(values['expect-database'], 'hcl', '--expect-database must explicitly equal hcl');
  const databaseUrl = process.env.DATABASE_URL;
  const dataDir = process.env.DATA_DIR;
  check(databaseUrl, 'DATABASE_URL is required');
  check(dataDir && isAbsolute(dataDir), 'DATA_DIR must be an absolute destination media directory');
  const database = new URL(databaseUrl);
  check(
    ['postgres:', 'postgresql:'].includes(database.protocol),
    'DATABASE_URL must use PostgreSQL',
  );
  same(database.pathname, '/hcl', 'Destination URL database mismatch');
  const manifest = JSON.parse(await readFile(values.manifest, 'utf8')) as Manifest;
  same(manifest.version, 1, 'Unsupported manifest version');
  check(['public', 'registered'].includes(manifest.visibility), 'Invalid manifest visibility');
  check(/^[0-9a-f]{64}$/.test(manifest.sourceDatabaseSha256), 'Invalid source database digest');
  check(manifest.counts && typeof manifest.counts === 'object', 'Missing manifest counts');
  const snapshot = await realpath(values.source);
  const sourceMedia = await realpath(resolve(snapshot, 'media'));
  const targetMedia = await realpath(dataDir);
  const sourcePath = await containedFile(
    snapshot,
    resolve(snapshot, 'hub.sqlite3'),
    'Source database',
  );
  same(await digest(sourcePath), manifest.sourceDatabaseSha256, 'Source database digest mismatch');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const { pool } = createDatabase(databaseUrl);
  const client = await pool.connect();
  let requests = 0;
  try {
    source.exec('PRAGMA query_only = ON; BEGIN');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    same(
      (await client.query('SELECT current_database() AS name')).rows[0]?.name,
      values['expect-database'],
      'Connected database mismatch',
    );
    const users = source.prepare('SELECT * FROM users ORDER BY id').all() as SourceUser[];
    const posts = source
      .prepare('SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY id')
      .all() as SourcePost[];
    const allPostIds = new Set(
      (source.prepare('SELECT id FROM posts').all() as { id: number }[]).map((row) => row.id),
    );
    const livePostIds = new Set(posts.map((row) => row.id));
    const liveComments = source
      .prepare('SELECT * FROM comments WHERE deleted_at IS NULL ORDER BY id')
      .all() as SourceComment[];
    for (const comment of liveComments)
      check(
        allPostIds.has(comment.post_id),
        'Source comment ' + comment.id + ': dangling post reference',
      );
    const comments = liveComments.filter((comment) => livePostIds.has(comment.post_id));
    const likes = source
      .prepare('SELECT l.* FROM likes l JOIN posts p ON p.id=l.post_id WHERE p.deleted_at IS NULL')
      .all() as SourceLike[];
    const postTags = source
      .prepare(
        'SELECT pt.* FROM post_tags pt JOIN posts p ON p.id=pt.post_id WHERE p.deleted_at IS NULL',
      )
      .all() as SourcePostTag[];
    const tags = source
      .prepare(
        'SELECT DISTINCT t.* FROM tags t JOIN post_tags pt ON pt.tag_id=t.id JOIN posts p ON p.id=pt.post_id WHERE p.deleted_at IS NULL',
      )
      .all() as SourceTag[];
    const sourceAvatars = users.filter((user) => user.avatar_key !== null);
    const counts = {
      users: users.length,
      posts: posts.length,
      avatars: sourceAvatars.length,
      comments: comments.length,
      tags: tags.length,
      postTags: postTags.length,
      likes: likes.length,
    };
    for (const key of Object.keys(counts) as (keyof typeof counts)[])
      same(manifest.counts[key], counts[key], 'Manifest ' + key + ': count mismatch');
    const userMap = mappings(
      manifest.users,
      users.map((row) => row.id),
      uuid,
      'Users',
    );
    const postMap = mappings(
      manifest.posts,
      posts.map((row) => row.id),
      decimal,
      'Posts',
    );
    const commentMap = mappings(
      manifest.comments,
      comments.map((row) => row.id),
      decimal,
      'Comments',
    );
    check(Array.isArray(manifest.avatars), 'Missing avatar mappings');
    const avatarMap = mappings(
      manifest.avatars.map((row) => ({ sourceId: row.sourceUserId, targetId: row.assetId })),
      sourceAvatars.map((row) => row.id),
      uuid,
      'Avatars',
    );
    const assetIds = [...manifest.posts.map((row) => row.assetId), ...avatarMap.values()];
    check(
      assetIds.every((id) => typeof id === 'string' && uuid.test(id)),
      'Invalid asset mapping',
    );
    same(new Set(assetIds).size, assetIds.length, 'Duplicate mapped asset');
    const tables = [
      'users',
      'entries',
      'assets',
      'entry_attachments',
      'comments',
      'likes',
      'tags',
      'entry_tags',
    ] as const;
    const target = {} as Record<(typeof tables)[number], Row[]>;
    for (const table of tables) target[table] = (await client.query('SELECT * FROM ' + table)).rows;
    for (const [table, count] of Object.entries({
      users: counts.users,
      entries: counts.posts,
      assets: assetIds.length,
      entry_attachments: counts.posts,
      comments: counts.comments,
      likes: counts.likes,
      tags: counts.tags,
      entry_tags: counts.postTags,
    }))
      same(
        target[table as keyof typeof target].length,
        count,
        table + ': destination count mismatch',
      );
    // Fresh destination login sessions are allowed; session provenance is not inferable here.
    for (const table of ['follows', 'idempotency_keys'])
      same(
        Number((await client.query('SELECT count(*) AS n FROM ' + table)).rows[0].n),
        0,
        table + ': unexpected migrated state',
      );
    const targetUsers = indexed(target.users);
    const targetEntries = indexed(target.entries);
    const targetAssets = indexed(target.assets);
    const targetComments = indexed(target.comments);
    const owners = target.users.filter((row) => row.role === 'owner');
    same(owners.length, 1, 'Destination must have exactly one owner');
    const owner = users.find((row) => userMap.get(row.id) === owners[0]!.id);
    check(owner && owner.role === 'admin', 'Owner must map to a source admin');
    if (values.owner !== undefined)
      same(owner.username, values.owner, 'Explicit owner selection mismatch');
    for (const user of users) {
      const label = 'Source user ' + user.id;
      check(
        user.disabled_at === null && ['admin', 'user'].includes(user.role),
        label + ': account not importable',
      );
      const row = targetUsers.get(userMap.get(user.id)!);
      check(row, label + ': mapped user missing');
      const normalized = normalizeUsername(user.username);
      same(row.username, normalized.username, label + ': username mismatch');
      same(row.username_key, normalized.usernameKey, label + ': username key mismatch');
      same(row.display_name, user.nickname, label + ': display name mismatch');
      same(row.password_hash, user.password_hash, label + ': password hash mismatch');
      same(row.role, user.id === owner.id ? 'owner' : 'member', label + ': role mismatch');
      same(
        date(row.created_at, label),
        date(user.created_at, label),
        label + ': creation date mismatch',
      );
      same(
        row.avatar_asset_id,
        avatarMap.get(user.id) ?? null,
        label + ': avatar reference mismatch',
      );
    }
    const sourceDigests = new Map<string, string>();
    const thumbnailDigests = new Map<string, string>();
    const storage = new LocalStorage(targetMedia);
    async function asset(id: string, sourceKey: string, ownerId: string, label: string) {
      check(
        /^[0-9a-f]{32}\.(jpg|png|gif|webp)$/.test(sourceKey),
        label + ': invalid source media key',
      );
      const row = targetAssets.get(id);
      check(row, label + ': asset missing');
      same(row.owner_id, ownerId, label + ': asset owner mismatch');
      same(row.kind, 'image', label + ': asset kind mismatch');
      same(row.state, 'ready', label + ': asset is not ready');
      same(row.expires_at, null, label + ': asset expiry must be null');
      check(
        row.ready_at !== null &&
          row.error_code === null &&
          row.job_id === null &&
          row.attempt_token === null,
        label + ': stale processing state',
      );
      check(typeof row.thumbnail_key === 'string', label + ': thumbnail missing');
      const original = await containedFile(targetMedia, storage.path(row.original_key), label);
      const sourceFile = await containedFile(sourceMedia, resolve(sourceMedia, sourceKey), label);
      const expected = await digest(sourceFile);
      same(await digest(original), expected, label + ': stored image bytes differ');
      same(row.sha256, expected, label + ': asset SHA256 mismatch');
      same(
        String(row.bytes),
        String((await stat(sourceFile)).size),
        label + ': asset byte count mismatch',
      );
      const thumbnail = await containedFile(targetMedia, storage.path(row.thumbnail_key), label);
      await webp(await readFile(thumbnail), label);
      sourceDigests.set(id, expected);
      thumbnailDigests.set(id, await digest(thumbnail));
    }
    const attachmentRows = new Map<string, Row[]>();
    for (const row of target.entry_attachments) {
      const key = String(row.entry_id);
      attachmentRows.set(key, [...(attachmentRows.get(key) ?? []), row]);
    }
    const mappedPosts = new Map(manifest.posts.map((row) => [row.sourceId, row]));
    for (const post of posts) {
      const label = 'Source post ' + post.id;
      const mapping = mappedPosts.get(post.id)!;
      const row = targetEntries.get(mapping.targetId);
      check(row, label + ': entry missing');
      same(row.author_id, userMap.get(post.author_id), label + ': author mismatch');
      same(row.title, post.title, label + ': title mismatch');
      same(row.body, '', label + ': body must be empty');
      same(row.visibility, manifest.visibility, label + ': visibility mismatch');
      same(row.deleted_at, null, label + ': entry deleted');
      same(row.nsfw, false, label + ': unexpected declaration');
      same(row.ai_generated, false, label + ': unexpected declaration');
      same(
        date(row.created_at, label),
        date(post.created_at, label),
        label + ': creation date mismatch',
      );
      same(
        date(row.updated_at, label),
        date(post.updated_at, label),
        label + ': update date mismatch',
      );
      const attachments = attachmentRows.get(mapping.targetId) ?? [];
      same(attachments.length, 1, label + ': expected exactly one attachment');
      const attachment = attachments[0]!;
      check(
        attachment.kind === 'image' &&
          attachment.asset_id === mapping.assetId &&
          attachment.url === null &&
          attachment.position === 0,
        label + ': attachment mismatch',
      );
      await asset(mapping.assetId, post.original_key, userMap.get(post.author_id)!, label);
      same(
        targetAssets.get(mapping.assetId)!.display_name,
        post.original_name,
        label + ': original name mismatch',
      );
    }
    for (const user of sourceAvatars)
      await asset(
        avatarMap.get(user.id)!,
        user.avatar_key!,
        userMap.get(user.id)!,
        'Source avatar user ' + user.id,
      );
    const sourceComments = new Map(comments.map((row) => [row.id, row]));
    for (const comment of comments) {
      const label = 'Source comment ' + comment.id;
      const row = targetComments.get(commentMap.get(comment.id)!);
      check(row, label + ': comment missing');
      check(
        postMap.has(comment.post_id) && userMap.has(comment.author_id),
        label + ': dangling source reference',
      );
      same(String(row.entry_id), postMap.get(comment.post_id), label + ': entry mismatch');
      same(row.author_id, userMap.get(comment.author_id), label + ': author mismatch');
      same(row.body, comment.body, label + ': body mismatch');
      same(
        date(row.created_at, label),
        date(comment.created_at, label),
        label + ': creation date mismatch',
      );
      if (comment.reply_to_id !== null) {
        const parent = sourceComments.get(comment.reply_to_id);
        check(
          parent && parent.post_id === comment.post_id,
          label + ': dangling or cross-entry reply',
        );
      }
      same(
        row.parent_id === null ? null : String(row.parent_id),
        comment.reply_to_id === null ? null : commentMap.get(comment.reply_to_id),
        label + ': reply mismatch',
      );
    }
    equalSet(
      target.likes.map((row) =>
        JSON.stringify([row.user_id, String(row.entry_id), date(row.created_at, 'Like')]),
      ),
      likes.map((row) => {
        check(
          userMap.has(row.user_id) && postMap.has(row.post_id),
          'Like: dangling source reference',
        );
        return JSON.stringify([
          userMap.get(row.user_id),
          postMap.get(row.post_id),
          date(row.created_at, 'Like'),
        ]);
      }),
      'Likes',
    );
    const targetTags = new Map(target.tags.map((row) => [row.normalized_name, row]));
    same(targetTags.size, tags.length, 'Tags: duplicate normalized names');
    const sourceTagMap = new Map<number, string>();
    for (const tag of tags) {
      const row = targetTags.get(tag.normalized_name);
      check(row, 'Source tag ' + tag.id + ': tag missing');
      same(row.name, tag.name, 'Source tag ' + tag.id + ': name mismatch');
      sourceTagMap.set(tag.id, row.id);
    }
    equalSet(
      target.entry_tags.map((row) => JSON.stringify([String(row.entry_id), row.tag_id])),
      postTags.map((row) => {
        check(
          postMap.has(row.post_id) && sourceTagMap.has(row.tag_id),
          'Tag relationship: dangling reference',
        );
        return JSON.stringify([postMap.get(row.post_id), sourceTagMap.get(row.tag_id)]);
      }),
      'Entry tags',
    );
    const base = process.env.API_BASE_URL;
    if (base) {
      const url = new URL(base);
      check(
        ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.origin === base,
        'API_BASE_URL must be an exact HTTP origin without credentials',
      );
      async function get(path: string) {
        check(path.startsWith('/') && !path.startsWith('//'), 'Invalid API verification path');
        requests++;
        const response = await fetch(base + path, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(150_000),
        });
        same(response.status, 200, 'HTTP ' + path + ': unexpected status');
        return response;
      }
      await (await get('/api/v1/health')).arrayBuffer();
      if (manifest.visibility === 'public') {
        for (const post of posts) {
          const mapping = mappedPosts.get(post.id)!;
          const label = 'HTTP entry ' + mapping.targetId;
          const entry = (await (await get('/api/v1/entries/' + mapping.targetId)).json()) as Entry;
          check(
            entry.id === mapping.targetId &&
              entry.author.id === userMap.get(post.author_id) &&
              entry.title === post.title &&
              entry.body === '' &&
              entry.visibility === 'public',
            label + ': content mismatch',
          );
          same(
            date(entry.createdAt, label),
            date(post.created_at, label),
            label + ': creation date mismatch',
          );
          same(
            date(entry.updatedAt, label),
            date(post.updated_at, label),
            label + ': update date mismatch',
          );
          check(
            entry.images.length === 1 &&
              entry.images[0]!.id === mapping.assetId &&
              entry.files.length === 0 &&
              entry.links.length === 0,
            label + ': attachments mismatch',
          );
          equalSet(
            entry.tags,
            postTags
              .filter((row) => row.post_id === post.id)
              .map((row) => tags.find((tag) => tag.id === row.tag_id)!.name),
            label + ': tags',
          );
          same(
            entry.likeCount,
            likes.filter((row) => row.post_id === post.id).length,
            label + ': like count mismatch',
          );
          const originalPath = '/media/' + mapping.assetId + '/original';
          const thumbnailPath = '/media/' + mapping.assetId + '/thumbnail';
          same(entry.images[0]!.originalUrl, originalPath, label + ': original URL mismatch');
          same(entry.images[0]!.thumbnailUrl, thumbnailPath, label + ': thumbnail URL mismatch');
          const original = new Uint8Array(await (await get(originalPath)).arrayBuffer());
          same(
            createHash('sha256').update(original).digest('hex'),
            sourceDigests.get(mapping.assetId),
            label + ': HTTP original digest mismatch',
          );
          const thumbnailResponse = await get(thumbnailPath);
          check(
            thumbnailResponse.headers.get('content-type')?.startsWith('image/webp'),
            label + ': thumbnail content type mismatch',
          );
          const thumbnail = new Uint8Array(await thumbnailResponse.arrayBuffer());
          await webp(thumbnail, label);
          same(
            createHash('sha256').update(thumbnail).digest('hex'),
            thumbnailDigests.get(mapping.assetId),
            label + ': HTTP thumbnail digest mismatch',
          );
        }
      }
      for (const mapping of manifest.avatars) {
        const response = await get('/media/' + mapping.assetId + '/avatar');
        check(
          response.headers.get('content-type')?.startsWith('image/webp'),
          'HTTP avatar ' + mapping.assetId + ': content type mismatch',
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        await webp(bytes, 'HTTP avatar ' + mapping.assetId);
        same(
          createHash('sha256').update(bytes).digest('hex'),
          thumbnailDigests.get(mapping.assetId),
          'HTTP avatar ' + mapping.assetId + ': digest mismatch',
        );
      }
    }
    same(
      await digest(sourcePath),
      manifest.sourceDatabaseSha256,
      'Source database changed during verification',
    );
    console.log(
      JSON.stringify({
        verified: true,
        counts,
        visibility: manifest.visibility,
        http: base
          ? manifest.visibility === 'public'
            ? 'public entries and avatars'
            : 'health and avatars; registered entries DB-only'
          : 'not requested; DB/files only',
        requests,
      }),
    );
  } finally {
    // Roll back both read snapshots: never commit or initialize anything.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
    source.close();
  }
}
main().catch((error: unknown) => {
  // Driver, decoder and assertion diagnostics can contain private SQL values or paths.
  console.error(
    error instanceof VerificationError
      ? error.message
      : 'Verification failed (private diagnostic suppressed).',
  );
  process.exitCode = 1;
});
