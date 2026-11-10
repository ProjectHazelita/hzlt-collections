import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { processImage } from '../apps/worker/src/supervisor.js';
import { normalizeUsername } from '../packages/server/src/auth/service.js';
import { createDatabase, LocalStorage, loadConfig } from '../packages/server/src/index.js';

const help = `Usage: pnpm exec tsx scripts/import-101hub.ts --source /absolute/backup --manifest /absolute/private/manifest.json --expect-database hcl --owner SOURCE_ADMIN_USERNAME --visibility public|registered

Requires DATABASE_URL, DATA_DIR and the normal server configuration. Stop the target
API and worker first. Only an empty hcl database and empty media store are accepted.
The source must be a consistent, read-only Hub schema-v4 backup containing
hub.sqlite3 and media/<key>, without a WAL or symlinks. Source files are never edited.
All accounts must be enabled and compatible. The selected source admin becomes the
single owner; all other users become members. Password hashes are copied unchanged;
the current login password policy is NOT changed. Sessions and printing are omitted.
The private manifest is created exclusively (0600); it must not already exist.
On failure after publishing files, partial media is deliberately retained and blocks
reruns. A lost COMMIT acknowledgement is ambiguous: do not delete files or retry;
inspect the isolated destination and manifest, or discard the entire rehearsal.
Errors intentionally omit underlying database/file messages and account secrets.`;

class ImportError extends Error {}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImportError(message);
}
function args() {
  const values = new Map<string, string>();
  const allowed = new Set([
    '--source',
    '--manifest',
    '--expect-database',
    '--owner',
    '--visibility',
  ]);
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    requireCondition(
      allowed.has(key) && !values.has(key) && value && !value.startsWith('--'),
      'Invalid or duplicate arguments; use --help.',
    );
    values.set(key, value);
  }
  requireCondition(
    values.size === allowed.size,
    'Every documented option is required; use --help.',
  );
  const source = values.get('--source')!;
  const manifest = values.get('--manifest')!;
  const visibility = values.get('--visibility')!;
  requireCondition(
    isAbsolute(source) && isAbsolute(manifest),
    'Source and manifest paths must be absolute.',
  );
  requireCondition(
    values.get('--expect-database') === 'hcl',
    'Only --expect-database hcl is allowed.',
  );
  requireCondition(
    visibility === 'public' || visibility === 'registered',
    'Visibility must be explicitly public or registered.',
  );
  return {
    source: resolve(source),
    manifest: resolve(manifest),
    owner: values.get('--owner')!,
    visibility,
  };
}

// Check every path component, not just the final filename. The backup is required
// to be privately mounted read-only; these checks do not replace that prerequisite.
async function noSymlinks(path: string) {
  const absolute = resolve(path);
  let current = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    requireCondition(
      !(await lstat(current)).isSymbolicLink(),
      'Symlinks are not allowed in import paths.',
    );
  }
  return absolute;
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function sourceMedia(root: string, key: string) {
  requireCondition(
    typeof key === 'string' &&
      key.length > 0 &&
      !isAbsolute(key) &&
      !key.includes('\\') &&
      !key.includes('\0') &&
      key.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Unsafe source media key.',
  );
  const path = resolve(root, key);
  requireCondition(path.startsWith(root + sep), 'Source media escapes the backup.');
  await noSymlinks(path);
  requireCondition((await lstat(path)).isFile(), 'Source media must be a regular file.');
  return path;
}
function text(value: unknown, label: string) {
  requireCondition(typeof value === 'string' && !value.includes('\0'), `Invalid source ${label}.`);
  return value;
}
function id(value: unknown) {
  requireCondition(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
    'Source IDs must be positive safe integers.',
  );
  return value;
}
function timestamp(value: unknown) {
  const input = text(value, 'timestamp');
  requireCondition(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) &&
      Number.isFinite(Date.parse(input)),
    'Invalid source timestamp.',
  );
  return input;
}
type Row = Record<string, unknown>;
const sourceColumns: Record<string, string[]> = {
  users: [
    'id',
    'username',
    'nickname',
    'password_hash',
    'role',
    'disabled_at',
    'created_at',
    'avatar_key',
  ],
  posts: [
    'id',
    'author_id',
    'title',
    'original_key',
    'thumbnail_key',
    'original_name',
    'mime_type',
    'byte_size',
    'width',
    'height',
    'created_at',
    'updated_at',
    'deleted_at',
    'deleted_by',
  ],
  comments: [
    'id',
    'post_id',
    'author_id',
    'body',
    'reply_to_id',
    'created_at',
    'deleted_at',
    'deleted_by',
  ],
  likes: ['user_id', 'post_id', 'created_at'],
  tags: ['id', 'name', 'normalized_name'],
  post_tags: ['post_id', 'tag_id'],
};
const applicationTables = [
  'users',
  'sessions',
  'assets',
  'entries',
  'entry_attachments',
  'comments',
  'tags',
  'entry_tags',
  'likes',
  'idempotency_keys',
  'follows',
];

async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(help);
    return;
  }
  const options = args();
  const config = loadConfig(fileURLToPath(new URL('../', import.meta.url)));
  requireCondition(
    process.env.DATA_DIR && isAbsolute(process.env.DATA_DIR),
    'An explicit absolute DATA_DIR is required.',
  );
  requireCondition(
    decodeURIComponent(new URL(config.databaseUrl).pathname) === '/hcl',
    'DATABASE_URL must select hcl.',
  );
  await noSymlinks(options.source);
  const sourceDatabase = await noSymlinks(join(options.source, 'hub.sqlite3'));
  requireCondition(
    (await lstat(sourceDatabase)).isFile(),
    'Source database must be a regular file.',
  );
  for (const suffix of ['-wal', '-journal'])
    requireCondition(
      !(await exists(sourceDatabase + suffix)),
      'Source must be a checkpointed consistent backup without WAL/journal sidecars.',
    );
  const mediaRoot = await noSymlinks(join(options.source, 'media'));
  requireCondition((await lstat(mediaRoot)).isDirectory(), 'Source media must be a directory.');
  await noSymlinks(dirname(options.manifest));
  requireCondition(
    !(await exists(options.manifest)),
    'Manifest already exists; refusing overwrite.',
  );
  // The manifest must not be placed inside either store, or emptiness checks and
  // source read-only guarantees would become misleading.
  const targetRoot = resolve(config.dataDir);
  requireCondition(
    options.manifest !== targetRoot &&
      !options.manifest.startsWith(targetRoot + sep) &&
      options.manifest !== options.source &&
      !options.manifest.startsWith(options.source + sep),
    'Manifest must be outside source and destination media.',
  );
  requireCondition(
    targetRoot !== options.source &&
      !targetRoot.startsWith(options.source + sep) &&
      !options.source.startsWith(targetRoot + sep),
    'Source and target stores must be disjoint.',
  );
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await noSymlinks(targetRoot);
  requireCondition(
    (await realpath(targetRoot)) === targetRoot,
    'Target media path must be canonical.',
  );

  const sourceDatabaseSha256 = await hashFile(sourceDatabase);
  const source = new DatabaseSync(sourceDatabase, { readOnly: true });
  const { pool } = createDatabase(config.databaseUrl);
  const client = await pool.connect().catch(async () => {
    source.close();
    await pool.end();
    throw new ImportError('Cannot connect to the isolated destination database.');
  });
  let lockOwned = false;
  let stage: string | undefined;
  let manifestHandle: FileHandle | undefined;
  let transaction = false;
  let commitAttempted = false;
  let committed = false;
  const lockPath = join(targetRoot, '.import-101hub.lock');
  try {
    source.exec('PRAGMA query_only = ON; BEGIN');
    requireCondition(
      (source.prepare('PRAGMA user_version').get() as Row).user_version === 4,
      'Only Hub schema version 4 is supported.',
    );
    for (const [table, columns] of Object.entries(sourceColumns)) {
      const found = source.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      requireCondition(
        found.length === columns.length &&
          found.every((column, index) => column.name === columns[index]),
        'Unrecognized source table schema.',
      );
    }
    const rows = (table: string) => source.prepare(`SELECT * FROM ${table}`).all() as Row[];
    const users = rows('users');
    const allPosts = rows('posts');
    const posts = allPosts.filter((post) => post.deleted_at === null);
    const postIds = new Set(posts.map((post) => id(post.id)));
    const allPostIds = new Set(allPosts.map((post) => id(post.id)));
    const allComments = rows('comments');
    const comments = allComments.filter(
      (comment) => comment.deleted_at === null && postIds.has(id(comment.post_id)),
    );
    const allTags = rows('tags');
    const postTags = rows('post_tags').filter((relation) => {
      requireCondition(allPostIds.has(id(relation.post_id)), 'Dangling source tag/post reference.');
      return postIds.has(id(relation.post_id));
    });
    const tagIds = new Set(postTags.map((relation) => id(relation.tag_id)));
    const tags = allTags.filter((tag) => tagIds.has(id(tag.id)));
    requireCondition(tags.length === tagIds.size, 'Dangling source tag reference.');
    const likes = rows('likes').filter((like) => {
      requireCondition(allPostIds.has(id(like.post_id)), 'Dangling source like/post reference.');
      return postIds.has(id(like.post_id));
    });
    for (const comment of allComments)
      requireCondition(
        allPostIds.has(id(comment.post_id)),
        'Dangling source comment/post reference.',
      );

    const userMap = new Map<number, string>();
    const normalizedUsers = new Map<
      number,
      { username: string; usernameKey: string; displayName: string }
    >();
    const usernameKeys = new Set<string>();
    let ownerId: number | undefined;
    for (const user of users) {
      const sourceId = id(user.id);
      requireCondition(
        user.disabled_at === null && (user.role === 'user' || user.role === 'admin'),
        'Disabled or unrecognized source account; refusing import.',
      );
      const username = text(user.username, 'username');
      let normalized: { username: string; usernameKey: string };
      try {
        normalized = normalizeUsername(username);
      } catch {
        throw new ImportError('A source username is incompatible with target normalization.');
      }
      requireCondition(
        normalized.username === username && !usernameKeys.has(normalized.usernameKey),
        'Source username normalization changes or collides.',
      );
      usernameKeys.add(normalized.usernameKey);
      const displayName = text(user.nickname, 'display name');
      requireCondition(
        Array.from(displayName).length >= 1 &&
          Array.from(displayName).length <= 32 &&
          displayName.trim() === displayName &&
          !/\p{Cc}/u.test(displayName),
        'A source display name is incompatible with the target.',
      );
      // Hub uses argon2-cffi's Argon2id PHC encoding. Restrict costs before
      // allowing existing hashes into the target authentication path.
      const passwordHash = text(user.password_hash, 'password encoding');
      const phc =
        /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
          passwordHash,
        );
      requireCondition(
        phc &&
          Number(phc[1]) >= 8 * Number(phc[3]) &&
          Number(phc[1]) <= 262144 &&
          Number(phc[2]) >= 1 &&
          Number(phc[2]) <= 10 &&
          Number(phc[3]) >= 1 &&
          Number(phc[3]) <= 16 &&
          Buffer.from(phc[4], 'base64').length >= 8 &&
          Buffer.from(phc[5], 'base64').length >= 16,
        'Unsupported source password encoding or costs.',
      );
      timestamp(user.created_at);
      requireCondition(
        user.avatar_key === null || typeof user.avatar_key === 'string',
        'Invalid source avatar key.',
      );
      if (username === options.owner) {
        requireCondition(user.role === 'admin', 'Selected owner must be a source admin.');
        ownerId = sourceId;
      }
      userMap.set(sourceId, randomUUID());
      normalizedUsers.set(sourceId, { ...normalized, displayName });
    }
    requireCondition(ownerId !== undefined, 'Selected source owner was not found.');
    const author = (value: unknown) => {
      const target = userMap.get(id(value));
      requireCondition(target, 'Dangling source author/user reference.');
      return target;
    };
    for (const post of posts) {
      author(post.author_id);
      text(post.title, 'post title');
      requireCondition(
        Array.from(post.title as string).length <= 200,
        'Source title exceeds target limit.',
      );
      text(post.original_name, 'image name');
      timestamp(post.created_at);
      timestamp(post.updated_at);
    }
    const commentMap = new Map(comments.map((comment) => [id(comment.id), comment]));
    for (const comment of comments) {
      author(comment.author_id);
      text(comment.body, 'comment');
      timestamp(comment.created_at);
      if (comment.reply_to_id !== null) {
        const parent = commentMap.get(id(comment.reply_to_id));
        requireCondition(
          parent && parent.post_id === comment.post_id && parent.id !== comment.id,
          'Live comment has a dangling, deleted, self, or cross-post reply reference.',
        );
      }
      const visited = new Set<number>();
      let current: Row | undefined = comment;
      while (current) {
        const currentId = id(current.id);
        requireCondition(!visited.has(currentId), 'Source comment replies contain a cycle.');
        visited.add(currentId);
        current =
          current.reply_to_id === null ? undefined : commentMap.get(id(current.reply_to_id));
      }
    }
    for (const like of likes) {
      author(like.user_id);
      timestamp(like.created_at);
    }
    const normalizedTags = new Set<string>();
    for (const tag of tags) {
      const name = text(tag.name, 'tag');
      const normalized = name.normalize('NFKC').toLowerCase();
      requireCondition(
        name.trim() === name &&
          Array.from(name).length >= 1 &&
          Array.from(name).length <= 32 &&
          Array.from(normalized).length <= 32 &&
          !/\p{Cc}/u.test(name + normalized) &&
          !normalizedTags.has(normalized),
        'Source tags are incompatible or collide after target normalization.',
      );
      normalizedTags.add(normalized);
    }
    // Resolve every input before acquiring a destination write lock or copying.
    const postMedia = new Map<number, string>();
    const avatarMedia = new Map<number, string>();
    for (const post of posts)
      postMedia.set(
        id(post.id),
        await sourceMedia(mediaRoot, text(post.original_key, 'image key')),
      );
    for (const user of users)
      if (user.avatar_key !== null)
        avatarMedia.set(
          id(user.id),
          await sourceMedia(mediaRoot, text(user.avatar_key, 'avatar key')),
        );

    requireCondition(
      (await client.query('SELECT current_database() AS name')).rows[0].name === 'hcl',
      'Connected database is not hcl.',
    );
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    requireCondition(
      (await client.query('SELECT pg_try_advisory_xact_lock(101, 20261110) AS locked')).rows[0]
        .locked,
      'Another Hub import is running.',
    );
    await client.query(
      `LOCK TABLE ${[...applicationTables, 'site_settings'].map((name) => `"${name}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`,
    );
    for (const table of applicationTables)
      requireCondition(
        (await client.query(`SELECT 1 FROM "${table}" LIMIT 1`)).rowCount === 0,
        'Destination application tables must all be empty.',
      );
    requireCondition(
      (
        await client.query(
          'SELECT 1 FROM site_settings WHERE logo_asset_id IS NOT NULL OR logo_url IS NOT NULL LIMIT 1',
        )
      ).rowCount === 0,
      'Destination site media must be empty.',
    );
    await mkdir(lockPath, { mode: 0o700 });
    lockOwned = true;
    for (const entry of await readdir(targetRoot, { withFileTypes: true })) {
      if (entry.name === '.import-101hub.lock') continue;
      requireCondition(
        ['tmp', 'originals', 'variants'].includes(entry.name) &&
          entry.isDirectory() &&
          (await readdir(join(targetRoot, entry.name))).length === 0,
        'Destination media must be empty, including temporary and partial files.',
      );
    }
    manifestHandle = await open(options.manifest, 'wx', 0o600);
    await chmod(options.manifest, 0o600);
    stage = await mkdtemp(join(targetRoot, '.hub-import-'));
    await chmod(stage, 0o700);
    const stagedStorage = new LocalStorage(stage);
    const storage = new LocalStorage(targetRoot);
    await stagedStorage.initialize();
    await storage.initialize();
    const manifest = {
      version: 1,
      sourceDatabaseSha256,
      visibility: options.visibility,
      counts: {
        users: users.length,
        posts: posts.length,
        avatars: avatarMedia.size,
        comments: comments.length,
        tags: tags.length,
        postTags: postTags.length,
        likes: likes.length,
      },
      users: [] as { sourceId: number; targetId: string }[],
      posts: [] as { sourceId: number; targetId: string; assetId: string }[],
      avatars: [] as { sourceUserId: number; assetId: string }[],
      comments: [] as { sourceId: number; targetId: string }[],
    };
    for (const user of users) {
      const sourceId = id(user.id);
      const normalized = normalizedUsers.get(sourceId)!;
      const targetId = userMap.get(sourceId)!;
      await client.query(
        'INSERT INTO users (id, username, username_key, display_name, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          targetId,
          normalized.username,
          normalized.usernameKey,
          normalized.displayName,
          user.password_hash,
          sourceId === ownerId ? 'owner' : 'member',
          user.created_at,
        ],
      );
      manifest.users.push({ sourceId, targetId });
    }
    const stagedKeys: string[] = [];
    const asset = async (input: string, owner: string, displayName: string, createdAt: string) => {
      const assetId = randomUUID();
      const originalKey = `originals/${assetId}.bin`;
      const thumbnailKey = `variants/${assetId}/${randomUUID()}.webp`;
      // O_NOFOLLOW guards the final component as well as the earlier path check.
      const sourceHandle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const sourceInfo = await sourceHandle.stat();
        requireCondition(sourceInfo.isFile(), 'Source image is no longer a regular file.');
        requireCondition(
          sourceInfo.size > 0 && sourceInfo.size <= config.maxUploadBytes,
          'Source image exceeds the configured target upload size limit or is empty.',
        );
        await pipeline(
          sourceHandle.createReadStream({ autoClose: false }),
          await stagedStorage.create(originalKey),
        );
      } finally {
        await sourceHandle.close();
      }
      await mkdir(dirname(stagedStorage.path(thumbnailKey)), { recursive: true, mode: 0o700 });
      const metadata = await processImage({
        inputPath: stagedStorage.path(originalKey),
        outputPath: stagedStorage.path(thumbnailKey),
        maxImagePixels: config.maxImagePixels,
        maxImageDimension: config.maxImageDimension,
        timeoutMs: config.imageTimeoutMs,
      });
      await chmod(stagedStorage.path(thumbnailKey), 0o600);
      const originalInfo = await stagedStorage.info(originalKey);
      const sha256 = await hashFile(stagedStorage.path(originalKey));
      const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
      await client!.query(
        `INSERT INTO assets (id,owner_id,kind,state,original_key,thumbnail_key,display_name,sha256,bytes,format,mime,extension,original_width,original_height,width,height,created_at,ready_at,expires_at) VALUES ($1,$2,'image','ready',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),NULL)`,
        [
          assetId,
          owner,
          originalKey,
          thumbnailKey,
          displayName,
          sha256,
          originalInfo.size,
          metadata.format,
          `image/${metadata.format}`,
          extension,
          metadata.originalWidth,
          metadata.originalHeight,
          metadata.width,
          metadata.height,
          createdAt,
        ],
      );
      stagedKeys.push(originalKey, thumbnailKey);
      return assetId;
    };
    for (const user of users) {
      const sourceUserId = id(user.id);
      const input = avatarMedia.get(sourceUserId);
      if (!input) continue;
      const assetId = await asset(
        input,
        author(sourceUserId),
        'avatar',
        timestamp(user.created_at),
      );
      await client.query('UPDATE users SET avatar_asset_id=$1 WHERE id=$2', [
        assetId,
        author(sourceUserId),
      ]);
      manifest.avatars.push({ sourceUserId, assetId });
    }
    const entryMap = new Map<number, string>();
    for (const post of posts) {
      const sourceId = id(post.id);
      const assetId = await asset(
        postMedia.get(sourceId)!,
        author(post.author_id),
        text(post.original_name, 'image name'),
        timestamp(post.created_at),
      );
      const targetId = String(
        (
          await client.query(
            'INSERT INTO entries (author_id,title,body,visibility,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [
              author(post.author_id),
              post.title,
              '',
              options.visibility,
              post.created_at,
              post.updated_at,
            ],
          )
        ).rows[0].id,
      );
      await client.query(
        "INSERT INTO entry_attachments (entry_id,kind,asset_id,position,created_at) VALUES ($1,'image',$2,0,$3)",
        [targetId, assetId, post.created_at],
      );
      entryMap.set(sourceId, targetId);
      manifest.posts.push({ sourceId, targetId, assetId });
    }
    const targetTags = new Map<number, string>();
    for (const tag of tags) {
      const targetId = randomUUID();
      const name = text(tag.name, 'tag');
      await client.query('INSERT INTO tags (id,name,normalized_name) VALUES ($1,$2,$3)', [
        targetId,
        name,
        name.normalize('NFKC').toLowerCase(),
      ]);
      targetTags.set(id(tag.id), targetId);
    }
    for (const relation of postTags)
      await client.query('INSERT INTO entry_tags (entry_id,tag_id) VALUES ($1,$2)', [
        entryMap.get(id(relation.post_id)),
        targetTags.get(id(relation.tag_id)),
      ]);
    const targetComments = new Map<number, string>();
    for (const comment of comments) {
      const sourceId = id(comment.id);
      const targetId = String(
        (
          await client.query(
            'INSERT INTO comments (entry_id,author_id,body,created_at) VALUES ($1,$2,$3,$4) RETURNING id',
            [
              entryMap.get(id(comment.post_id)),
              author(comment.author_id),
              comment.body,
              comment.created_at,
            ],
          )
        ).rows[0].id,
      );
      targetComments.set(sourceId, targetId);
      manifest.comments.push({ sourceId, targetId });
    }
    for (const comment of comments)
      if (comment.reply_to_id !== null)
        await client.query('UPDATE comments SET parent_id=$1 WHERE id=$2', [
          targetComments.get(id(comment.reply_to_id)),
          targetComments.get(id(comment.id)),
        ]);
    for (const like of likes)
      await client.query('INSERT INTO likes (user_id,entry_id,created_at) VALUES ($1,$2,$3)', [
        author(like.user_id),
        entryMap.get(id(like.post_id)),
        like.created_at,
      ]);
    requireCondition(
      (await hashFile(sourceDatabase)) === sourceDatabaseSha256,
      'Source database changed during import.',
    );
    for (const key of stagedKeys) {
      await mkdir(dirname(storage.path(key)), { recursive: true, mode: 0o700 });
      await rename(stagedStorage.path(key), storage.path(key));
      const handle = await open(storage.path(key), 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    // Flush directories before database publication; files are never removed by a
    // catch handler, even if the connection drops around COMMIT.
    for (const path of [
      join(targetRoot, 'originals'),
      ...manifest.posts.map((post) => join(targetRoot, 'variants', post.assetId)),
      ...manifest.avatars.map((avatar) => join(targetRoot, 'variants', avatar.assetId)),
      join(targetRoot, 'variants'),
      targetRoot,
    ]) {
      const handle = await open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await manifestHandle.writeFile(JSON.stringify(manifest, null, 2) + '\n');
    await manifestHandle.sync();
    await manifestHandle.close();
    manifestHandle = undefined;
    const manifestDirectory = await open(dirname(options.manifest), 'r');
    try {
      await manifestDirectory.sync();
    } finally {
      await manifestDirectory.close();
    }
    commitAttempted = true;
    await client.query('COMMIT');
    transaction = false;
    committed = true;
    console.log(
      JSON.stringify({
        version: 1,
        status: 'committed',
        visibility: options.visibility,
        counts: manifest.counts,
      }),
    );
  } catch (error) {
    if (transaction && !commitAttempted && client) {
      try {
        await client.query('ROLLBACK');
        transaction = false;
      } catch {
        /* Retain all artifacts if rollback cannot be confirmed. */
      }
    }
    if (commitAttempted && !committed)
      throw new ImportError(
        'COMMIT outcome is ambiguous; retain media and manifest, inspect the isolated destination before any cleanup.',
      );
    throw error;
  } finally {
    await manifestHandle?.close().catch(() => {});
    // This private staging tree has never been referenced by the database.
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (lockOwned && !commitAttempted) await rm(lockPath, { recursive: true }).catch(() => {});
    if (lockOwned && committed) await rm(lockPath, { recursive: true }).catch(() => {});
    source.close();
    client.release(transaction);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ImportError
      ? error.message
      : 'Import failed; underlying error details withheld to protect source secrets. Retain partial media/manifest and inspect the isolated rehearsal.',
  );
  process.exitCode = 1;
});
