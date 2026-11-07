import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import type { UploadStatus } from '@hcl/contracts';
import { Client, createFixture } from './testing/fixture.js';
import { launchWorker } from './testing/worker.js';
import { staticImages } from './testing/images.js';

const kinds = ['original', 'thumbnail', 'download'] as const;
const media = (id: string, kind: typeof kinds[number]) => `/media/${id}/${kind}`;

async function upload(client: Client, bytes: Uint8Array) {
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), '../../unsafe".html');
  const response = await client.request('/api/v1/uploads', { method: 'POST', headers: { 'idempotency-key': randomUUID() }, body });
  expect(response.status).toBe(202);
  return (await response.json()).id as string;
}

async function terminal(client: Client, id: string): Promise<UploadStatus> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await client.request('/api/v1/uploads/' + id);
    expect(response.status).toBe(200);
    const result: UploadStatus = await response.json();
    if (result.status !== 'pending') return result;
    await delay(250);
  }
  throw new Error('Media processing did not finish');
}

async function publish(client: Client, assetId: string) {
  return client.request('/api/v1/entries', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ body: 'published media lifecycle', assetId, tags: ['media'], declarations: { nsfw: false, aiGenerated: false } }),
  });
}

describe('real HTTP published media authorization and deletion', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let owner: Client;
  let author: Client;
  let worker: Awaited<ReturnType<typeof launchWorker>> | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address); author = new Client(fixture.address);
    expect((await owner.auth('media_owner')).response.status).toBe(201);
    expect((await author.auth('media_author')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => { await worker?.stop(); worker = undefined; await fixture?.close(); }, 50_000);

  async function privateToEveryone(id: string) {
    for (const client of [author, owner, new Client(fixture.address)]) {
      for (const kind of kinds) expect((await client.request(media(id, kind))).status).toBe(404);
    }
  }

  it('publishes actual MIME and immutable bytes only after entry association for every selected format', async () => {
    worker = await launchWorker(fixture);
    const visitor = new Client(fixture.address);
    for (const image of await staticImages()) {
      const id = await upload(author, image.bytes);
      expect((await terminal(author, id)).status).toBe('ready');
      await privateToEveryone(id);
      const created = await publish(author, id);
      expect(created.status).toBe(201);
      const entry = await created.json();
      const format = image.name === 'rotated-jpeg' ? 'jpeg' : image.name;
      for (const kind of kinds) {
        const response = await visitor.request(media(id, kind));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-type')).toBe(kind === 'thumbnail' ? 'image/webp' : 'image/' + format);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (kind === 'thumbnail') {
          const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
          expect([decoded.info.width, decoded.info.height]).toEqual([image.width, image.height]);
          expect((await sharp(bytes).metadata()).orientation).toBeUndefined();
        } else {
          expect(bytes).toEqual(image.bytes);
          const extension = format === 'jpeg' ? 'jpg' : format;
          expect(response.headers.get('content-disposition')).toBe(`${kind === 'download' ? 'attachment' : 'inline'}; filename="entry-${entry.id}.${extension}"`);
        }
      }
    }
  }, 60_000);

  it('denies pending, failed, unknown and traversal paths without exposing private storage', async () => {
    const id = await upload(author, Buffer.from([255, 216, 255]));
    await privateToEveryone(id);
    expect((await publish(author, id)).status).toBe(409);
    worker = await launchWorker(fixture);
    expect((await terminal(author, id)).status).toBe('failed');
    await privateToEveryone(id);
    expect((await publish(author, id)).status).toBe(409);
    await privateToEveryone(randomUUID());
    for (const path of ['/media/', '/originals/' + id + '.bin', '/media/' + id + '/../../originals/' + id + '.bin', '/media/%2e%2e%2foriginals%2ffile/original']) {
      const response = await fetch(fixture.address + path);
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain(fixture.storage.root);
    }
    expect((await fetch(fixture.address + '/media/not-a-uuid/original')).status).toBe(400);
  }, 30_000);

  it('revokes every new read before disk cleanup and removes the entry from every public and private collection', async () => {
    worker = await launchWorker(fixture);
    const id = await upload(author, (await staticImages())[0]!.bytes);
    expect((await terminal(author, id)).status).toBe('ready');
    const created = await publish(author, id);
    expect(created.status).toBe(201);
    const entry = await created.json();
    expect((await owner.request(`/api/v1/entries/${entry.id}/like`, { method: 'PUT' })).status).toBe(200);
    const row = (await fixture.pool.query('select original_key,thumbnail_key from assets where id=$1', [id])).rows[0];
    await worker.stop(); worker = undefined;
    expect((await owner.request('/api/v1/entries/' + entry.id, { method: 'DELETE' })).status).toBe(204);
    expect(await readFile(fixture.storage.path(row.original_key))).toEqual((await staticImages())[0]!.bytes);
    expect((await fixture.storage.files()).includes(row.thumbnail_key)).toBe(true);
    await privateToEveryone(id);
    for (const kind of kinds) {
      expect((await fetch(fixture.address + media(id, kind), { headers: { range: 'bytes=0-9', 'if-none-match': '*' } })).status).toBe(404);
    }
    expect((await author.request('/api/v1/entries/' + entry.id)).status).toBe(404);
    expect((await owner.request(`/api/v1/entries/${entry.id}/like`, { method: 'PUT' })).status).toBe(404);
    for (const path of ['/api/v1/entries', '/api/v1/entries?q=media', '/api/v1/me/likes', '/api/v1/admin/entries']) {
      expect(await (await owner.request(path)).json()).toMatchObject({ items: [], total: 0 });
    }
    worker = await launchWorker(fixture);
    const deadline = Date.now() + 10_000;
    while ((await fixture.storage.files()).length && Date.now() < deadline) await delay(100);
    expect(await fixture.storage.files()).toEqual([]);
    const jobId = await fixture.boss.send('asset-delete', { assetId: id });
    expect(jobId).toBeTypeOf('string');
    const retryDeadline = Date.now() + 10_000;
    let state;
    do { state = (await fixture.boss.findJobs('asset-delete', { id: jobId! }))[0]?.state; if (state === 'completed') break; await delay(100); } while (Date.now() < retryDeadline);
    expect(state).toBe('completed');
  }, 40_000);

  it('returns 404 for missing files even while their published database association remains active', async () => {
    worker = await launchWorker(fixture);
    const id = await upload(author, (await staticImages())[1]!.bytes);
    expect((await terminal(author, id)).status).toBe('ready');
    expect((await publish(author, id)).status).toBe(201);
    const row = (await fixture.pool.query('select original_key,thumbnail_key from assets where id=$1', [id])).rows[0];
    await fixture.storage.remove(row.original_key);
    const visitor = new Client(fixture.address);
    expect((await visitor.request(media(id, 'original'))).status).toBe(404);
    expect((await visitor.request(media(id, 'download'))).status).toBe(404);
    expect((await visitor.request(media(id, 'thumbnail'))).status).toBe(200);
    await fixture.storage.remove(row.thumbnail_key);
    await privateToEveryone(id);
    expect((await fixture.pool.query('select state from assets where id=$1', [id])).rows[0].state).toBe('ready');
  }, 30_000);
});
