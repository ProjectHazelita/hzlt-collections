import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Site, UploadStatus } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';
import { staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

async function upload(client: Client, bytes: Uint8Array, kind: 'image' | 'file' = 'image') {
  const body = new FormData();
  body.append('kind', kind);
  body.append(
    'file',
    new Blob([new Uint8Array(bytes)], {
      type: kind === 'image' ? 'image/png' : 'text/plain',
    }),
    kind === 'image' ? 'logo.png' : 'logo.txt',
  );
  const response = await client.request('/api/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body,
  });
  expect(response.status).toBe(202);
  return (await response.json()).id as string;
}

async function ready(client: Client, id: string) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await client.request(`/api/v1/uploads/${id}`);
    expect(response.status).toBe(200);
    const status: UploadStatus = await response.json();
    if (status.status !== 'pending') {
      expect(status.status).toBe('ready');
      return id;
    }
    await delay(100);
  }
  throw new Error('Logo processing did not finish');
}

const patch = (client: Client, body: unknown) =>
  client.request('/api/v1/site', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const profile = (client: Client, id: string) =>
  client.request('/api/v1/me/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ avatarAssetId: id }),
  });
const entry = (client: Client, id: string) =>
  client.request('/api/v1/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      body: '',
      imageIds: [id],
      tags: [],
      declarations: { nsfw: false, aiGenerated: false },
    }),
  });

describe('site logo publication and lifecycle', () => {
  let fixture: Fixture;
  let owner: Client;
  let worker: { stop(): Promise<unknown> } | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    expect((await owner.auth('logo_owner')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture?.close();
  }, 50_000);

  const media = (id: string, kind = 'site-logo') => fetch(`${fixture.address}/media/${id}/${kind}`);
  const row = async (id: string) =>
    (
      await fixture.pool.query(
        'select state, expires_at, original_key, thumbnail_key from assets where id=$1',
        [id],
      )
    ).rows[0];
  const waitJob = async (name: string, id: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = (await fixture.boss.findJobs(name, { id }))[0]?.state;
      if (state === 'completed' || state === 'failed') {
        expect(state).toBe('completed');
        return;
      }
      await delay(100);
    }
    throw new Error(`${name} did not complete`);
  };

  it('rejects unauthorized, foreign, pending, failed, expired, file and already used uploads', async () => {
    const images = await staticImages();
    const pending = await upload(owner, images[0]!.bytes);
    expect((await patch(owner, { logoAssetId: pending })).status).toBe(409);
    expect((await media(pending)).status).toBe(404);
    const guest = new Client(fixture.address);
    await guest.session();
    expect((await patch(guest, { logoAssetId: pending })).status).toBe(401);
    const member = new Client(fixture.address);
    expect((await member.auth('logo_member')).response.status).toBe(201);
    expect((await patch(member, { logoAssetId: pending })).status).toBe(403);
    const foreign = await upload(member, images[1]!.bytes);
    expect((await patch(owner, { logoAssetId: foreign })).status).toBe(404);
    worker = await launchWorker(fixture);
    await ready(owner, pending);
    const file = await upload(owner, new TextEncoder().encode('not an image'), 'file');
    await ready(owner, file);
    expect((await patch(owner, { logoAssetId: file })).status).toBe(409);
    const expired = await ready(owner, await upload(owner, images[1]!.bytes));
    await fixture.pool.query("update assets set expires_at=now()-interval '1 hour' where id=$1", [
      expired,
    ]);
    expect((await patch(owner, { logoAssetId: expired })).status).toBe(409);
    const failed = await upload(owner, images[0]!.bytes.subarray(0, 40));
    const deadline = Date.now() + 25_000;
    while ((await row(failed)).state === 'pending' && Date.now() < deadline) await delay(100);
    expect((await row(failed)).state).toBe('failed');
    expect((await patch(owner, { logoAssetId: failed })).status).toBe(409);
    expect((await media(failed)).status).toBe(404);
    expect((await profile(owner, pending)).status).toBe(200);
    expect((await patch(owner, { logoAssetId: pending })).status).toBe(409);
    const attached = await ready(owner, await upload(owner, images[2]!.bytes));
    expect((await entry(owner, attached)).status).toBe(201);
    expect((await patch(owner, { logoAssetId: attached })).status).toBe(409);
    expect(
      (await patch(owner, { logoAssetId: attached, logoUrl: 'https://example.com/logo.png' }))
        .status,
    ).toBe(400);
  }, 90_000);
  it('publishes only the saved thumbnail, persists all fields, and protects the logo during maintenance', async () => {
    worker = await launchWorker(fixture);
    const id = await ready(owner, await upload(owner, (await staticImages())[0]!.bytes));
    for (const kind of ['site-logo', 'avatar', 'original', 'thumbnail', 'download'])
      expect((await media(id, kind)).status).toBe(404);
    const saved = await patch(owner, {
      logoAssetId: id,
      title: 'Local brand',
      description: 'Uploaded logo',
      registrationOpen: false,
    });
    expect(saved.status).toBe(200);
    const expected: Site = {
      logoAssetId: id,
      logoUrl: `/media/${id}/site-logo`,
      title: 'Local brand',
      description: 'Uploaded logo',
      registrationOpen: false,
    };
    expect(await saved.json()).toEqual(expected);
    expect(await (await fetch(`${fixture.address}/api/v1/site`)).json()).toEqual(expected);
    expect((await row(id)).expires_at).toBeNull();
    const published = await media(id);
    expect(published.status).toBe(200);
    expect(published.headers.get('content-type')).toBe('image/webp');
    expect(published.headers.get('cache-control')).toBe('no-store');
    expect(published.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await published.arrayBuffer()).byteLength).toBeGreaterThan(0);
    for (const kind of ['avatar', 'original', 'thumbnail', 'download'])
      expect((await media(id, kind)).status).toBe(404);
    expect((await entry(owner, id)).status).toBe(400);
    expect((await profile(owner, id)).status).toBe(409);
    const asset = await row(id);
    // Even a stale expiry/deletion job must not destroy a saved association.
    await fixture.pool.query("update assets set expires_at=now()-interval '1 hour' where id=$1", [
      id,
    ]);
    const maintenanceId = await fixture.boss.send('maintenance', {});
    expect(maintenanceId).toBeTypeOf('string');
    await waitJob('maintenance', maintenanceId!);
    const deletionId = await fixture.boss.send('asset-delete', { assetId: id });
    expect(deletionId).toBeTypeOf('string');
    await waitJob('asset-delete', deletionId!);
    expect((await row(id)).state).toBe('ready');
    expect(await fixture.storage.files()).toContain(asset.original_key);
    expect(await fixture.storage.files()).toContain(asset.thumbnail_key);
    expect((await media(id)).status).toBe(200);
    await fixture.storage.remove(asset.thumbnail_key);
    expect((await media(id)).status).toBe(404);
  }, 90_000);

  it('revokes replaced and defaulted logos immediately and queues unreferenced files for cleanup', async () => {
    worker = await launchWorker(fixture);
    const images = await staticImages();
    const first = await ready(owner, await upload(owner, images[0]!.bytes));
    const second = await ready(owner, await upload(owner, images[1]!.bytes));
    expect((await patch(owner, { logoAssetId: first })).status).toBe(200);
    const firstRow = await row(first);
    expect((await patch(owner, { logoAssetId: second })).status).toBe(200);
    expect((await media(first)).status).toBe(404);
    expect((await row(first)).state).toBe('deleted');
    expect((await media(second)).status).toBe(200);
    const reset = await patch(owner, { logoAssetId: null, logoUrl: null });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ logoAssetId: null, logoUrl: null });
    expect((await media(second)).status).toBe(404);
    expect((await row(second)).state).toBe('deleted');
    const secondRow = await row(second);
    const keys = [
      firstRow.original_key,
      firstRow.thumbnail_key,
      secondRow.original_key,
      secondRow.thumbnail_key,
    ];
    const deadline = Date.now() + 15_000;
    while (
      (await fixture.storage.files()).some((key) => keys.includes(key)) &&
      Date.now() < deadline
    )
      await delay(100);
    for (const key of keys) expect(await fixture.storage.files()).not.toContain(key);
    expect((await patch(owner, { logoAssetId: first })).status).toBe(409);
    const external = await patch(owner, {
      logoAssetId: null,
      logoUrl: 'https://example.com/logo.png',
    });
    expect(external.status).toBe(200);
    expect(await external.json()).toMatchObject({
      logoAssetId: null,
      logoUrl: 'https://example.com/logo.png',
    });
    const third = await ready(owner, await upload(owner, images[2]!.bytes));
    expect((await patch(owner, { logoAssetId: third })).status).toBe(200);
    expect(
      (await patch(owner, { logoAssetId: null, logoUrl: 'https://example.com/next.png' })).status,
    ).toBe(200);
    expect((await media(third)).status).toBe(404);
    expect((await row(third)).state).toBe('deleted');
    expect((await patch(owner, { logoAssetId: null, logoUrl: 'javascript:alert(1)' })).status).toBe(
      400,
    );
  }, 90_000);
});
