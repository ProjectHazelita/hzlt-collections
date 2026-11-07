import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { crc32, createDeflate } from 'node:zlib';
import { animatedImages, staticImages } from '../apps/api/src/testing/images.js';
import type {
  Entry,
  EntryInput,
  EntryList,
  Session,
  UploadAccepted,
  UploadStatus,
} from '../packages/contracts/src/index.js';
import { createDatabase, loadConfig } from '../packages/server/src/index.js';

const sharp = createRequire(new URL('../apps/api/package.json', import.meta.url))('sharp');
const base = process.env.API_BASE_URL;
const project = process.env.COMPOSE_PROJECT_NAME;
// Check every isolation prerequisite before even bootstrapping an anonymous session.
assert(
  project && /^hcl-proof-api-[a-z0-9][a-z0-9-]*$/.test(project),
  'Refusing a non-isolated API proof project',
);
assert.equal(
  base,
  'http://api:3000',
  'Run this script in the tools container against its API service',
);
const config = loadConfig(fileURLToPath(new URL('../', import.meta.url)));
assert.equal(new URL(config.databaseUrl).pathname, '/hcl', 'Refusing any database other than hcl');
const { pool } = createDatabase(config.databaseUrl);
let requests = 0;
let published = 0;
let rejected = 0;
const password = randomUUID() + randomUUID();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (body: string): EntryInput => ({
  body,
  tags: [],
  declarations: { nsfw: false, aiGenerated: false },
});
const entryPath = (id: string) => '/api/v1/entries/' + id;
const mediaKinds = ['original', 'thumbnail', 'download'] as const;

class Client {
  cookie = '';
  csrfToken = '';
  async request(path: string, options: RequestInit = {}): Promise<Response> {
    assert(path.startsWith('/') && !path.startsWith('//'), 'Only local API paths are allowed');
    const headers = new Headers(options.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (!['GET', 'HEAD'].includes(options.method ?? 'GET')) {
      if (!headers.has('origin')) headers.set('origin', config.publicOrigin);
      if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', this.csrfToken);
    }
    requests++;
    const response = await fetch(base + path, {
      ...options,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(150_000),
    });
    for (const value of response.headers.getSetCookie()) {
      if (value.startsWith('hzlt.sid=')) this.cookie = value.split(';', 1)[0]!;
    }
    return response;
  }
  async json<T>(path: string, expected = 200, options: RequestInit = {}): Promise<T> {
    const response = await this.request(path, options);
    assert.equal(
      response.status,
      expected,
      `${options.method ?? 'GET'} ${path}: unexpected HTTP status`,
    );
    return response.json() as Promise<T>;
  }
  async session() {
    const session = await this.json<Session>('/api/v1/auth/session');
    this.csrfToken = session.csrfToken;
    return session;
  }
  snapshot() {
    const client = new Client();
    client.cookie = this.cookie;
    client.csrfToken = this.csrfToken;
    return client;
  }
}
const jsonBody = (body: unknown, method = 'POST', key?: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body),
});
async function error(
  client: Client,
  path: string,
  status: number,
  code: string,
  options: RequestInit = {},
) {
  const body = await client.json<{ error: { code: string; requestId: string; message: string } }>(
    path,
    status,
    options,
  );
  assert.equal(body.error.code, code, `${path}: unexpected error code`);
  assert(
    body.error.requestId && body.error.message,
    'Structured errors must include requestId and message',
  );
}
async function create(client: Client, input: EntryInput, key = randomUUID()) {
  const entry = await client.json<Entry>('/api/v1/entries', 201, jsonBody(input, 'POST', key));
  assert.equal(typeof entry.id, 'string');
  assert.match(entry.id, /^[1-9][0-9]*$/);
  return entry;
}
async function absentMedia(client: Client, id: string) {
  for (const kind of mediaKinds) await error(client, `/media/${id}/${kind}`, 404, 'NOT_FOUND');
}
async function upload(client: Client, bytes: Uint8Array, key = randomUUID(), extra = false) {
  const body = new FormData();
  // Intentionally false MIME and hostile filename: only actual bytes determine format.
  body.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
    '../../untrusted.html',
  );
  if (extra) body.append('unexpected', 'must reject');
  return client.request('/api/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body,
  });
}
async function accepted(response: Response): Promise<UploadAccepted> {
  assert.equal(response.status, 202, 'Expected asynchronous upload acceptance');
  const result = (await response.json()) as UploadAccepted;
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.status, 'pending');
  return result;
}
async function terminal(client: Client, id: string): Promise<UploadStatus> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const result = await client.json<UploadStatus>('/api/v1/uploads/' + id);
    assert.equal(result.id, id);
    if (result.status !== 'pending') return result;
    await delay(500);
  }
  throw new Error('Independent Worker did not finish an upload within 150 seconds');
}
async function failedUpload(client: Client, bytes: Uint8Array, code: string) {
  const { id } = await accepted(await upload(client, bytes));
  const result = await terminal(client, id);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, code);
  await absentMedia(client, id);
  await error(
    client,
    '/api/v1/entries',
    409,
    'UPLOAD_NOT_READY',
    jsonBody({ ...text(''), assetId: id }, 'POST', randomUUID()),
  );
  rejected++;
}
function pngChunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
// Compress one repeated scanline at a time; never allocate the oversized decoded image.
async function overPixelPng() {
  const width = Math.floor(Math.sqrt(config.maxImagePixels)) + 1;
  const height = Math.floor(config.maxImagePixels / width) + 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  const row = Buffer.alloc(width + 1);
  const compressed: Buffer[] = [];
  const compressor = createDeflate();
  compressor.on('data', (chunk: Buffer) => compressed.push(chunk));
  await pipeline(
    Readable.from(
      (async function* () {
        for (let y = 0; y < height; y++) yield row;
      })(),
    ),
    compressor,
  );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', Buffer.concat(compressed)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
async function overByteUpload(client: Client) {
  const boundary = 'hcl-' + randomUUID();
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="oversize.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = config.maxUploadBytes + 1;
  const block = Buffer.alloc(64 * 1024);
  const body = Readable.from(
    (async function* () {
      yield prefix;
      yield Buffer.from([255, 216, 255]);
      for (let remaining = Math.max(0, size - 3); remaining > 0; ) {
        const count = Math.min(block.length, remaining);
        yield block.subarray(0, count);
        remaining -= count;
      }
      yield suffix;
    })(),
  );
  const response = await client.request('/api/v1/uploads', {
    method: 'POST',
    headers: {
      'idempotency-key': randomUUID(),
      'content-type': 'multipart/form-data; boundary=' + boundary,
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'IMAGE_TOO_LARGE');
  rejected++;
}

try {
  const guard = await pool.query<{ name: string; users: string; entries: string }>(
    'select current_database() as name, (select count(*) from users) as users, (select count(*) from entries) as entries',
  );
  assert.deepEqual(
    guard.rows[0],
    { name: 'hcl', users: '0', entries: '0' },
    'Refusing a nonempty database; no existing data will be reset',
  );
  console.log('SMOKE guard: isolated proof project, actual hcl database, empty users/entries');
  const visitor = new Client();
  assert.deepEqual(await visitor.json('/api/v1/health'), { status: 'ok' });
  const document = await visitor.json<any>('/api/v1/openapi.json');
  const multipart =
    document.paths?.['/api/v1/uploads']?.post?.requestBody?.content?.['multipart/form-data']
      ?.schema;
  assert.equal(multipart?.type, 'object');
  assert(multipart.required?.includes('file'));
  assert.equal(multipart.properties?.file?.type, 'string');
  assert.equal(multipart.properties?.file?.format, 'binary');
  assert(multipart.properties.file.description?.includes('static'));
  assert.deepEqual(await visitor.json('/api/v1/entries'), {
    items: [],
    total: 0,
    nextCursor: null,
  });

  const owner = new Client();
  const member = new Client();
  await owner.session();
  const preLogin = owner.snapshot();
  const ownerResponse = await owner.request(
    '/api/v1/auth/register',
    jsonBody({ username: 'owner_' + randomUUID().replaceAll('-', '').slice(0, 20), password }),
  );
  assert.equal(ownerResponse.status, 201);
  const ownerSession = (await ownerResponse.json()) as Session;
  assert.equal(ownerSession.user?.role, 'owner');
  owner.csrfToken = ownerSession.csrfToken;
  assert(owner.cookie !== preLogin.cookie, 'Registration must regenerate the session cookie');
  const setCookie = ownerResponse.headers
    .getSetCookie()
    .find((value) => value.startsWith('hzlt.sid='));
  assert(setCookie && /; HttpOnly/i.test(setCookie) && /; SameSite=Lax/i.test(setCookie));
  assert.equal(/; Secure(?:;|$)/i.test(setCookie), config.secureCookie);
  assert(!owner.cookie.includes(ownerSession.user!.id), 'Cookie must not contain user payload');
  await member.session();
  const username = 'member_' + randomUUID().replaceAll('-', '').slice(0, 20);
  const memberSession = await member.json<Session>(
    '/api/v1/auth/register',
    201,
    jsonBody({ username, password }),
  );
  assert.equal(memberSession.user?.role, 'member');
  member.csrfToken = memberSession.csrfToken;
  const roles = await pool.query(
    'select role, count(*)::int as count from users group by role order by role',
  );
  assert.deepEqual(roles.rows, [
    { role: 'member', count: 1 },
    { role: 'owner', count: 1 },
  ]);
  await error(member, '/api/v1/admin/entries', 403, 'FORBIDDEN');
  await visitor.session();
  await error(
    visitor,
    '/api/v1/entries',
    401,
    'AUTH_REQUIRED',
    jsonBody(text('anonymous'), 'POST', randomUUID()),
  );
  const deniedWrite = jsonBody(text('forbidden'), 'POST', randomUUID());
  await error(owner, '/api/v1/entries', 403, 'FORBIDDEN', {
    ...deniedWrite,
    headers: { ...deniedWrite.headers, 'x-csrf-token': '' },
  });
  await error(owner, '/api/v1/entries', 403, 'FORBIDDEN', {
    ...deniedWrite,
    headers: { ...deniedWrite.headers, origin: 'https://cross-origin.invalid' },
  });
  await error(preLogin, '/api/v1/entries', 401, 'SESSION_EXPIRED', deniedWrite);
  console.log(
    'SMOKE auth: real owner/member, database roles, cookie flags, CSRF/origin and pre-login cookie rejection',
  );

  const source = {
    ...text('中文正文 100% 下划线_ 反斜线\\'),
    tags: [' 中文标签 ', 'Ｔｅｓｔ', 'test'],
  };
  const first = await create(member, source);
  published++;
  assert.equal(first.title, null);
  assert.equal(first.asset, null);
  assert.deepEqual(new Set(first.tags), new Set(['中文标签', 'Ｔｅｓｔ']));
  const publicEntry = await visitor.json<Entry>(entryPath(first.id));
  assert.equal(publicEntry.id, first.id);
  assert.equal(publicEntry.canEdit, false);
  assert.equal(publicEntry.canDelete, false);
  await error(
    owner,
    entryPath(first.id),
    403,
    'FORBIDDEN',
    jsonBody({ body: 'owner cannot edit others' }, 'PATCH'),
  );
  const second = await create(owner, text('ordinary second'));
  published++;
  await error(
    member,
    entryPath(second.id),
    403,
    'FORBIDDEN',
    jsonBody({ body: 'member cannot edit others' }, 'PATCH'),
  );
  await error(member, entryPath(second.id), 403, 'FORBIDDEN', { method: 'DELETE' });
  const key = randomUUID();
  const concurrent = await Promise.all([
    create(owner, text('idempotent third'), key),
    create(owner, text('idempotent third'), key),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  published++;
  await error(
    owner,
    '/api/v1/entries',
    409,
    'IDEMPOTENCY_CONFLICT',
    jsonBody(text('changed input'), 'POST', key),
  );
  assert.equal((await pool.query('select count(*)::int as count from entries')).rows[0].count, 3);
  for (const q of ['中文正文', '中文标签', '%', '_', '\\']) {
    const result = await visitor.json<EntryList>('/api/v1/entries?q=' + encodeURIComponent(q));
    assert.equal(result.total, 1);
    assert.deepEqual(
      result.items.map((item) => item.id),
      [first.id],
    );
  }
  assert.deepEqual(await visitor.json('/api/v1/tags?q=' + encodeURIComponent('中文')), [
    '中文标签',
  ]);
  const page1 = await visitor.json<EntryList>('/api/v1/entries?limit=2');
  assert.equal(page1.total, 3);
  assert(page1.nextCursor);
  const page2 = await visitor.json<EntryList>('/api/v1/entries?limit=2&cursor=' + page1.nextCursor);
  assert.equal(page2.total, 3);
  assert.equal(page2.nextCursor, null);
  assert.equal(new Set([...page1.items, ...page2.items].map((item) => item.id)).size, 3);
  assert.deepEqual(
    [...page1.items, ...page2.items].map((item) => item.id),
    [concurrent[0]!.id, second.id, first.id],
  );
  const edited = await member.json<Entry>(
    entryPath(first.id),
    200,
    jsonBody({ title: '标题', declarations: { nsfw: true, aiGenerated: false } }, 'PATCH'),
  );
  assert.equal(edited.body, source.body);
  assert.equal(edited.title, '标题');
  assert.equal(edited.declarations.nsfw, true);
  const cleared = await member.json<Entry>(
    entryPath(first.id),
    200,
    jsonBody({ title: null }, 'PATCH'),
  );
  assert.equal(cleared.title, null);
  for (const invalid of [
    { body: ' ' },
    { assetId: randomUUID() },
    {},
    { declarations: { nsfw: true } },
  ]) {
    await error(member, entryPath(first.id), 400, 'VALIDATION_ERROR', jsonBody(invalid, 'PATCH'));
  }
  const likes = await Promise.all(
    Array.from({ length: 4 }, () =>
      owner.json(entryPath(first.id) + '/like', 200, { method: 'PUT' }),
    ),
  );
  for (const like of likes) assert.deepEqual(like, { likedByMe: true, likeCount: 1 });
  await owner.json(entryPath(second.id) + '/like', 200, { method: 'PUT' });
  const likes1 = await owner.json<EntryList>('/api/v1/me/likes?limit=1');
  assert.equal(likes1.total, 2);
  assert(likes1.nextCursor);
  const likes2 = await owner.json<EntryList>(
    '/api/v1/me/likes?limit=1&cursor=' + likes1.nextCursor,
  );
  assert.equal(likes2.total, 2);
  assert.equal(likes2.nextCursor, null);
  assert.deepEqual(
    new Set([...likes1.items, ...likes2.items].map((item) => item.id)),
    new Set([first.id, second.id]),
  );
  assert.equal((await member.json<EntryList>('/api/v1/me/likes')).total, 0);
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await owner.json(entryPath(second.id) + '/like', 200, { method: 'DELETE' }), {
      likedByMe: false,
      likeCount: 0,
    });
  await error(owner, '/api/v1/me/likes?cursor=' + page1.nextCursor, 400, 'VALIDATION_ERROR');
  await error(visitor, '/api/v1/entries?cursor=' + likes1.nextCursor, 400, 'VALIDATION_ERROR');
  for (const id of ['0', '01', '9223372036854775808'])
    await error(visitor, entryPath(id), 400, 'VALIDATION_ERROR');
  await error(visitor, entryPath('9007199254740993'), 404, 'NOT_FOUND');
  assert.equal((await owner.json<EntryList>('/api/v1/admin/entries')).total, 3);
  console.log(
    'SMOKE entries: string IDs, actual CRUD, Chinese/literal search, concurrent idempotency/likes, private pagination and permissions',
  );

  const images = await staticImages();
  const imageEntries: Entry[] = [];
  for (const [index, image] of images.entries()) {
    const uploadKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: index === 0 ? 2 : 1 }, () => upload(member, image.bytes, uploadKey)),
    );
    const uploads = await Promise.all(responses.map(accepted));
    const pending = uploads[0]!;
    if (uploads.length === 2) {
      assert.deepEqual(uploads[0], uploads[1]);
      const conflict = await upload(member, images[1]!.bytes, uploadKey);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
    }
    await error(owner, '/api/v1/uploads/' + pending.id, 404, 'NOT_FOUND');
    await error(visitor, '/api/v1/uploads/' + pending.id, 404, 'NOT_FOUND');
    const ready = await terminal(member, pending.id);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.width, image.width);
    assert.equal(ready.height, image.height);
    await absentMedia(member, pending.id);
    await absentMedia(visitor, pending.id);
    const entry = await create(member, { ...text(''), assetId: pending.id, tags: ['媒体验收'] });
    published++;
    imageEntries.push(entry);
    assert(entry.asset);
    assert.equal(entry.asset.id, pending.id);
    assert.equal(entry.asset.originalWidth, image.originalWidth);
    assert.equal(entry.asset.originalHeight, image.originalHeight);
    assert.equal(entry.asset.width, image.width);
    assert.equal(entry.asset.height, image.height);
    assert.equal(entry.asset.bytes, image.bytes.length);
    const format = image.name === 'rotated-jpeg' ? 'jpeg' : image.name;
    assert.equal(entry.asset.format, format);
    const row = (await pool.query('select sha256 from assets where id=$1', [pending.id])).rows[0];
    assert.equal(row.sha256, sha256(image.bytes));
    for (const kind of mediaKinds) {
      const response = await visitor.request(`/media/${pending.id}/${kind}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(
        response.headers.get('content-type'),
        kind === 'thumbnail' ? 'image/webp' : 'image/' + format,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (kind === 'thumbnail') {
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.format, 'webp');
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.orientation, undefined);
        const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
        assert.equal(decoded.info.width, image.width);
        assert.equal(decoded.info.height, image.height);
      } else {
        assert.equal(sha256(bytes), sha256(image.bytes));
        assert.equal(
          response.headers.get('content-disposition'),
          `${kind === 'download' ? 'attachment' : 'inline'}; filename="entry-${entry.id}.${format === 'jpeg' ? 'jpg' : format}"`,
        );
      }
    }
  }
  assert.equal((await pool.query('select count(*)::int as count from assets')).rows[0].count, 5);
  const extra = await upload(member, images[1]!.bytes, randomUUID(), true);
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'VALIDATION_ERROR');
  rejected++;
  console.log(
    'SMOKE media: five static/EXIF fixtures, independent Worker, private ready assets, exact original/download SHA256 and decoded WebP',
  );

  const svg = await upload(
    owner,
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'),
  );
  assert.equal(svg.status, 415);
  assert.equal((await svg.json()).error.code, 'UNSUPPORTED_IMAGE_TYPE');
  rejected++;
  for (const animation of await animatedImages()) {
    if (animation.name !== 'apng') assert.equal((await sharp(animation.bytes).metadata()).pages, 2);
    await failedUpload(owner, animation.bytes, 'ANIMATION_NOT_SUPPORTED');
  }
  await failedUpload(owner, images[1]!.bytes.subarray(0, 48), 'INVALID_IMAGE');
  await failedUpload(owner, await overPixelPng(), 'IMAGE_TOO_LARGE');
  const beforeOversize = (await pool.query('select count(*)::int as count from assets')).rows[0]
    .count;
  await overByteUpload(owner);
  assert.equal(
    (await pool.query('select count(*)::int as count from assets')).rows[0].count,
    beforeOversize,
  );
  console.log(
    'SMOKE rejection: forged SVG, real GIF/APNG/WebP animation, truncation, streamed byte limit, compressed over-pixel PNG and extra multipart part',
  );

  const removed = imageEntries[0]!;
  await owner.json(entryPath(removed.id) + '/like', 200, { method: 'PUT' });
  assert.equal((await owner.request(entryPath(removed.id), { method: 'DELETE' })).status, 204);
  await error(visitor, entryPath(removed.id), 404, 'NOT_FOUND');
  await error(owner, entryPath(removed.id), 404, 'NOT_FOUND', { method: 'DELETE' });
  await absentMedia(visitor, removed.asset!.id);
  for (const path of [
    '/api/v1/entries',
    '/api/v1/entries?q=' + encodeURIComponent('媒体验收'),
    '/api/v1/me/likes',
    '/api/v1/admin/entries',
  ]) {
    const result = await owner.json<EntryList>(path);
    assert(
      !result.items.some((item) => item.id === removed.id),
      'Deleted entry leaked into a collection',
    );
  }
  assert.equal((await owner.json<EntryList>('/api/v1/me/likes')).total, 1);
  assert.equal((await owner.json<EntryList>('/api/v1/admin/entries')).total, published - 1);
  assert.equal(
    (await visitor.json<EntryList>('/api/v1/entries?q=' + encodeURIComponent('媒体验收'))).total,
    4,
  );
  assert.equal((await member.request(entryPath(first.id), { method: 'DELETE' })).status, 204);
  assert.equal(
    (await visitor.json<EntryList>('/api/v1/entries?q=' + encodeURIComponent('中文正文'))).total,
    0,
  );
  assert.equal((await owner.json<EntryList>('/api/v1/me/likes')).total, 0);
  const afterDelete = await create(member, text('identity after deletion'));
  published++;
  assert(
    BigInt(afterDelete.id) > BigInt(imageEntries.at(-1)!.id),
    'Deleted identities must not be reused',
  );

  const stale = member.snapshot();
  assert.equal((await member.request('/api/v1/auth/logout', { method: 'POST' })).status, 204);
  await error(
    stale,
    '/api/v1/entries',
    401,
    'SESSION_EXPIRED',
    jsonBody(text('logged out'), 'POST', randomUUID()),
  );
  await error(stale, entryPath(second.id) + '/like', 401, 'SESSION_EXPIRED', { method: 'PUT' });
  await error(stale, '/api/v1/admin/entries', 401, 'SESSION_EXPIRED');
  const loggedOut = await member.session();
  assert.equal(loggedOut.user, null);
  const login = await member.json<Session>(
    '/api/v1/auth/login',
    200,
    jsonBody({ username, password }),
  );
  member.csrfToken = login.csrfToken;
  assert.equal(login.user?.id, memberSession.user?.id);
  assert.equal(login.user?.role, 'member');
  assert.equal((await member.session()).user?.id, memberSession.user?.id);
  console.log(
    'SMOKE lifecycle: immediate deleted detail/media/list/search/likes revocation, non-reused IDs, logout stale-cookie denial and real login',
  );
  console.log(
    'SMOKE scope: container restart/recovery, process kills, timeout/CAS races and browser behavior require separate integration/deployment proofs',
  );
  console.log(
    `SMOKE_API_OK requests=${requests} users=2 published=${published} staticImages=${images.length} rejected=${rejected} remainingEntries=${published - 2}`,
  );
} finally {
  await pool.end();
}
