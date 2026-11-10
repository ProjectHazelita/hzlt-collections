import { randomUUID } from 'node:crypto';
import type { EntryInput } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture } from './testing/fixture.js';

const textInput = (body: string): EntryInput => ({
  body,
  tags: [],
  declarations: { nsfw: false, aiGenerated: false },
});

async function create(client: Client, input: EntryInput, key = randomUUID()) {
  const response = await client.request('/api/v1/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(input),
  });
  return { response, data: await response.json() };
}

async function patch(client: Client, id: string, input: unknown) {
  return client.request('/api/v1/entries/' + id, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

describe('real entry lifecycle, authorization and pagination', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let owner: Client;
  let member: Client;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    member = new Client(fixture.address);
    expect((await owner.auth('site_owner')).response.status).toBe(201);
    expect((await member.auth('site_member')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => {
    await fixture?.close();
  });

  it('publishes titleless text publicly and separates visibility from permissions', async () => {
    const visitor = new Client(fixture.address);
    const empty = await visitor.request('/api/v1/entries');
    expect(await empty.json()).toMatchObject({ items: [], total: 0, nextCursor: null });
    const created = await create(member, textInput('正文\n保留换行'));
    expect(created.response.status).toBe(201);
    expect(created.data).toMatchObject({
      id: '1',
      title: null,
      body: '正文\n保留换行',
      images: [],
      files: [],
      links: [],
      canEdit: true,
      canDelete: true,
    });
    const publicDetail = await visitor.request('/api/v1/entries/1');
    expect(await publicDetail.json()).toMatchObject({
      id: '1',
      canEdit: false,
      canDelete: false,
      likedByMe: false,
    });
    const ownerDetail = await owner.request('/api/v1/entries/1');
    expect(await ownerDetail.json()).toMatchObject({ canEdit: false, canDelete: true });
    expect((await patch(owner, '1', { body: 'owner must not edit others' })).status).toBe(403);
    expect((await member.request('/api/v1/admin/entries')).status).toBe(403);
    await visitor.session();
    expect((await create(visitor, textInput('anonymous write'))).response.status).toBe(401);
    const poisoned = await member.request('/api/v1/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ ...textInput('forbidden identity field'), authorId: randomUUID() }),
    });
    expect(poisoned.status).toBe(400);
  });

  it('normalizes tags and searches Chinese text and SQL wildcard characters literally', async () => {
    const input = {
      ...textInput('中文正文包含 100% 与下划线_和反斜线\\'),
      title: '  标题  ',
      tags: [' 中文标签 ', 'Ｔｅｓｔ', 'test'],
    };
    const created = await create(owner, input);
    expect(created.response.status).toBe(201);
    expect(created.data.title).toBe('标题');
    expect(new Set(created.data.tags)).toEqual(new Set(['中文标签', 'Ｔｅｓｔ']));
    await create(owner, textInput('普通内容，不应匹配标点查询'));
    for (const q of ['中文正文', '中文标签', '%', '_', '\\']) {
      const response = await fetch(fixture.address + '/api/v1/entries?q=' + encodeURIComponent(q));
      const data = await response.json();
      expect(data.total).toBe(1);
      expect(data.items.map((entry: { id: string }) => entry.id)).toEqual([created.data.id]);
    }
    const suggestions = await fetch(
      fixture.address + '/api/v1/tags?q=' + encodeURIComponent('中文'),
    );
    expect(await suggestions.json()).toEqual(['中文标签']);
    expect(
      (await create(owner, { ...textInput('invalid tag'), tags: ['bad\nname'] })).response.status,
    ).toBe(400);
    const list = await fetch(fixture.address + '/api/v1/entries?q=' + encodeURIComponent('不存在'));
    expect(await list.json()).toMatchObject({ items: [], total: 0 });
    expect(
      (await owner.request('/api/v1/entries/' + created.data.id, { method: 'DELETE' })).status,
    ).toBe(204);
    expect(await (await fetch(fixture.address + '/api/v1/tags')).json()).toEqual([]);
  });

  it('creates exactly once for concurrent keys and rejects changed input without creating another row', async () => {
    const key = randomUUID();
    const input = textInput('one logical submission');
    const results = await Promise.all([create(owner, input, key), create(owner, input, key)]);
    expect(results.map((result) => result.response.status)).toEqual([201, 201]);
    expect(results[0]!.data).toEqual(results[1]!.data);
    const reordered = await create(
      owner,
      { declarations: input.declarations, tags: [], body: input.body },
      key,
    );
    expect(reordered.data).toEqual(results[0]!.data);
    const conflict = await create(owner, textInput('different logical submission'), key);
    expect(conflict.response.status).toBe(409);
    expect(conflict.data.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const counts = await fixture.pool.query(
      'select (select count(*)::int from entries) as entries, (select count(*)::int from idempotency_keys) as keys',
    );
    expect(counts.rows[0]).toEqual({ entries: 1, keys: 1 });
    const otherUser = await create(member, input, key);
    expect(otherUser.response.status).toBe(201);
    expect(otherUser.data.id).not.toBe(results[0]!.data.id);
  });

  it('keeps partial edits atomic and rejects unknown attachment fields', async () => {
    const created = await create(member, {
      ...textInput('original body'),
      title: 'original title',
      tags: ['keep'],
    });
    const changed = await patch(member, created.data.id, { title: null });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      title: null,
      body: 'original body',
      tags: ['keep'],
    });
    for (const body of [
      { body: '  ' },
      { assetId: randomUUID() },
      { declarations: { nsfw: true } },
      {},
    ]) {
      expect((await patch(member, created.data.id, body)).status).toBe(400);
    }
    const detail = await member.request('/api/v1/entries/' + created.data.id);
    expect(await detail.json()).toMatchObject({
      body: 'original body',
      declarations: { nsfw: false, aiGenerated: false },
      tags: ['keep'],
    });
  });

  it('paginates without duplicates and keeps likes private, idempotent and deletion-consistent', async () => {
    for (const body of ['first', 'middle', 'last']) await create(member, textInput(body));
    const list = await fetch(fixture.address + '/api/v1/entries?limit=2');
    const page1 = await list.json();
    expect(page1.total).toBe(3);
    expect(page1.items.map((entry: { id: string }) => entry.id)).toEqual(['3', '2']);
    const page2 = await (
      await fetch(fixture.address + '/api/v1/entries?limit=2&cursor=' + page1.nextCursor)
    ).json();
    expect(page2.items.map((entry: { id: string }) => entry.id)).toEqual(['1']);
    expect(page2.nextCursor).toBeNull();
    const likes = await Promise.all(
      Array.from({ length: 5 }, () => owner.request('/api/v1/entries/2/like', { method: 'PUT' })),
    );
    expect(likes.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await likes[0]!.json()).toEqual({ likedByMe: true, likeCount: 1 });
    await owner.request('/api/v1/entries/3/like', { method: 'PUT' });
    const mine = await (await owner.request('/api/v1/me/likes?limit=1')).json();
    expect(mine.total).toBe(2);
    const mineNext = await (
      await owner.request('/api/v1/me/likes?limit=1&cursor=' + mine.nextCursor)
    ).json();
    expect(new Set([...mine.items, ...mineNext.items].map((entry) => entry.id))).toEqual(
      new Set(['2', '3']),
    );
    expect(await (await member.request('/api/v1/me/likes')).json()).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await owner.request('/api/v1/me/likes?cursor=' + page1.nextCursor)).status).toBe(400);
    expect(
      (await fetch(fixture.address + '/api/v1/entries?cursor=' + mine.nextCursor)).status,
    ).toBe(400);
    const malformed = Buffer.from(
      JSON.stringify({ kind: 'entries', id: '1', extra: true }),
    ).toString('base64url');
    expect((await fetch(fixture.address + '/api/v1/entries?cursor=' + malformed)).status).toBe(400);
    expect((await owner.request('/api/v1/entries/2', { method: 'DELETE' })).status).toBe(204);
    expect((await owner.request('/api/v1/entries/2', { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(fixture.address + '/api/v1/entries/2')).status).toBe(404);
    expect(await (await owner.request('/api/v1/me/likes')).json()).toMatchObject({ total: 1 });
    expect(await (await owner.request('/api/v1/admin/entries')).json()).toMatchObject({ total: 2 });
    expect(await (await fetch(fixture.address + '/api/v1/entries?q=middle')).json()).toMatchObject({
      items: [],
      total: 0,
    });
    expect((await create(member, textInput('after deletion'))).data.id).toBe('4');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await (await owner.request('/api/v1/entries/3/like', { method: 'DELETE' })).json(),
      ).toEqual({ likedByMe: false, likeCount: 0 });
    }
  });

  it('preserves bigint identities beyond Number.MAX_SAFE_INTEGER and rejects noncanonical IDs', async () => {
    await fixture.pool.query(
      "select setval(pg_get_serial_sequence('entries','id'), 9007199254740992, false)",
    );
    const created = await create(owner, textInput('bigint identity'));
    expect(created.data.id).toBe('9007199254740992');
    expect(
      (await (await fetch(fixture.address + '/api/v1/entries/9007199254740992')).json()).id,
    ).toBe('9007199254740992');
    for (const id of ['0', '01', '1e3', '9223372036854775808'])
      expect((await fetch(fixture.address + '/api/v1/entries/' + id)).status).toBe(400);
    expect((await fetch(fixture.address + '/api/v1/entries/9223372036854775807')).status).toBe(404);
  });

  it('rejects a logged-out cookie on publishing, likes and administration', async () => {
    const created = await create(owner, textInput('public content survives logout'));
    const stale = new Client(fixture.address);
    stale.cookie = owner.cookie;
    stale.csrfToken = owner.csrfToken;
    expect((await owner.request('/api/v1/auth/logout', { method: 'POST' })).status).toBe(204);
    expect((await create(stale, textInput('must not publish'))).response.status).toBe(401);
    expect(
      (await stale.request(`/api/v1/entries/${created.data.id}/like`, { method: 'PUT' })).status,
    ).toBe(401);
    expect((await stale.request('/api/v1/admin/entries')).status).toBe(401);
    expect((await fetch(fixture.address + '/api/v1/entries/' + created.data.id)).status).toBe(200);
  });

  it('stores ordered images, files and links and replaces them atomically on edit', async () => {
    const memberId = (await fixture.pool.query("select id from users where username='site_member'"))
      .rows[0].id as string;
    const ownerId = (await fixture.pool.query("select id from users where username='site_owner'"))
      .rows[0].id as string;
    const makeAsset = async (owner: string, kind: 'image' | 'file') => {
      const id = randomUUID();
      await fixture.pool.query(
        `insert into assets
          (id, owner_id, kind, state, original_key, thumbnail_key, display_name, sha256, bytes,
           format, mime, extension, original_width, original_height, width, height, ready_at)
         values ($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
        [
          id,
          owner,
          kind,
          `originals/${id}.bin`,
          kind === 'image' ? `variants/${id}/${randomUUID()}.webp` : null,
          kind === 'image' ? 'image.png' : 'notes.pdf',
          '0'.repeat(64),
          kind === 'image' ? 128 : 2048,
          kind === 'image' ? 'png' : null,
          kind === 'image' ? null : 'application/octet-stream',
          kind === 'image' ? null : '.pdf',
          kind === 'image' ? 128 : null,
          kind === 'image' ? 128 : null,
          kind === 'image' ? 128 : null,
          kind === 'image' ? 128 : null,
        ],
      );
      return id;
    };
    const first = await makeAsset(memberId, 'image');
    const second = await makeAsset(memberId, 'image');
    const third = await makeAsset(memberId, 'image');
    const file = await makeAsset(memberId, 'file');
    const foreign = await makeAsset(ownerId, 'image');

    const created = await create(member, {
      body: '',
      imageIds: [first, second],
      fileIds: [file],
      links: [{ url: 'https://example.com/a#section' }, { url: 'https://example.org/b' }],
      tags: [],
      declarations: { nsfw: false, aiGenerated: false },
    });
    expect(created.response.status).toBe(201);
    expect(created.data.images.map((image: { id: string }) => image.id)).toEqual([first, second]);
    expect(created.data.files).toMatchObject([{ id: file, name: 'notes.pdf', extension: '.pdf' }]);
    expect(created.data.links.map((link: { host: string }) => link.host)).toEqual([
      'example.com',
      'example.org',
    ]);

    const updated = await patch(member, created.data.id, {
      imageIds: [third, second],
      fileIds: [],
      links: [{ url: 'https://example.net/next' }],
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      body: '',
      images: [{ id: third }, { id: second }],
      files: [],
      links: [{ host: 'example.net' }],
    });
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [first])).rows[0].state,
    ).toBe('deleted');
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [file])).rows[0].state,
    ).toBe('deleted');
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [second])).rows[0].state,
    ).toBe('ready');

    expect((await patch(member, created.data.id, { imageIds: [foreign] })).status).toBe(404);
    for (const invalid of [
      { imageIds: Array.from({ length: 21 }, () => randomUUID()) },
      { fileIds: Array.from({ length: 6 }, () => randomUUID()) },
      { links: Array.from({ length: 6 }, (_, index) => ({ url: `https://e.com/${index}` })) },
      { links: [{ url: 'javascript:alert(1)' }] },
      { links: [{ url: 'https://user:pass@example.com/' }] },
      { body: '   ', imageIds: [], fileIds: [], links: [] },
    ]) {
      expect((await patch(member, created.data.id, invalid)).status).toBe(400);
    }
    expect((await patch(member, created.data.id, { imageIds: [first] })).status).toBe(409);
    expect((await patch(owner, created.data.id, { body: 'owner cannot edit' })).status).toBe(403);

    const reuse = await create(member, {
      body: '',
      imageIds: [second],
      tags: [],
      declarations: { nsfw: false, aiGenerated: false },
    });
    expect(reuse.response.status).toBe(409);
    expect(reuse.data.error.code).toBe('UPLOAD_ALREADY_USED');
  });

  it('accepts twenty images, five files and five links together', async () => {
    const memberId = (await fixture.pool.query("select id from users where username='site_member'"))
      .rows[0].id as string;
    const makeAsset = async (kind: 'image' | 'file', index: number) => {
      const id = randomUUID();
      await fixture.pool.query(
        `insert into assets
          (id, owner_id, kind, state, original_key, thumbnail_key, display_name, sha256, bytes,
           format, mime, extension, original_width, original_height, width, height, ready_at)
         values ($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())`,
        [
          id,
          memberId,
          kind,
          `originals/${id}.bin`,
          kind === 'image' ? `variants/${id}/${randomUUID()}.webp` : null,
          kind === 'image' ? `image-${index}.png` : `file-${index}.pdf`,
          '0'.repeat(64),
          kind === 'image' ? 256 : 1024,
          kind === 'image' ? 'png' : null,
          kind === 'image' ? null : 'application/octet-stream',
          kind === 'image' ? null : '.pdf',
          kind === 'image' ? 256 : null,
          kind === 'image' ? 256 : null,
          kind === 'image' ? 256 : null,
          kind === 'image' ? 256 : null,
        ],
      );
      return id;
    };
    const imageIds = [];
    for (let index = 0; index < 20; index++) imageIds.push(await makeAsset('image', index));
    const fileIds = [];
    for (let index = 0; index < 5; index++) fileIds.push(await makeAsset('file', index));
    const links = Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.com/${index}`,
    }));
    const created = await create(member, {
      body: '',
      imageIds,
      fileIds,
      links,
      tags: ['组合'],
      declarations: { nsfw: false, aiGenerated: false },
    });
    expect(created.response.status).toBe(201);
    expect(created.data.images.map((image: { id: string }) => image.id)).toEqual(imageIds);
    expect(created.data.files.map((file: { id: string }) => file.id)).toEqual(fileIds);
    expect(created.data.links.map((link: { url: string }) => link.url)).toEqual(
      links.map((link) => new URL(link.url).toString()),
    );
    expect(
      (await fixture.pool.query('select count(*)::int as count from entry_attachments')).rows[0]
        .count,
    ).toBe(30);
  });
});
