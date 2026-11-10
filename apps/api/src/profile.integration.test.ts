import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Comment, Session, UploadStatus } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';
import { staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

async function upload(client: Client, bytes: Uint8Array) {
  const body = new FormData();
  body.append('kind', 'image');
  body.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'avatar.png');
  const response = await client.request('/api/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body,
  });
  expect(response.status).toBe(202);
  return (await response.json()).id as string;
}

async function terminal(client: Client, id: string): Promise<UploadStatus> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const response = await client.request(`/api/v1/uploads/${id}`);
    expect(response.status).toBe(200);
    const status: UploadStatus = await response.json();
    if (status.status !== 'pending') return status;
    await delay(200);
  }
  throw new Error('Avatar processing did not finish');
}

async function readyAvatar(client: Client, bytes: Uint8Array) {
  const id = await upload(client, bytes);
  expect((await terminal(client, id)).status).toBe('ready');
  return id;
}

function staleCopy(client: Client) {
  const copy = new Client(client.base);
  copy.cookie = client.cookie;
  copy.csrfToken = client.csrfToken;
  return copy;
}

describe('profile, avatar and password settings', () => {
  let fixture: Fixture;
  let member: Client;
  let worker: Awaited<ReturnType<typeof launchWorker>> | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    member = new Client(fixture.address);
    expect((await member.auth('profile_member')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture?.close();
  }, 50_000);

  const profile = (client: Client, body: unknown) =>
    client.request('/api/v1/me/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('updates the public nickname everywhere the author is displayed', async () => {
    const changed = await profile(member, { displayName: '  新的昵称  ' });
    expect(changed.status).toBe(200);
    const session = (await changed.json()) as Session;
    expect(session.user).toMatchObject({
      username: 'profile_member',
      displayName: '新的昵称',
      avatarUrl: null,
    });
    expect((await (await member.request('/api/v1/auth/session')).json()).user).toMatchObject({
      displayName: '新的昵称',
    });
    const created = await member.request('/api/v1/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        body: 'nickname propagation',
        tags: [],
        declarations: { nsfw: false, aiGenerated: false },
      }),
    });
    const entry = await created.json();
    expect(entry.author.displayName).toBe('新的昵称');
    const comment = await member.request(`/api/v1/entries/${entry.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'comment nickname' }),
    });
    expect(((await comment.json()) as Comment).author.displayName).toBe('新的昵称');
    for (const displayName of ['', '   ', 'x'.repeat(33), 'bad\nname']) {
      expect((await profile(member, { displayName })).status).toBe(400);
    }
  }, 40_000);

  it('sets, replaces and removes a processed avatar while keeping it out of entries', async () => {
    worker = await launchWorker(fixture);
    const images = await staticImages();
    const first = await readyAvatar(member, images[0]!.bytes);
    const set = await profile(member, { avatarAssetId: first });
    expect(set.status).toBe(200);
    const session = (await set.json()) as Session;
    expect(session.user?.avatarUrl).toBe(`/media/${first}/avatar`);

    const avatar = await fetch(`${fixture.address}/media/${first}/avatar`);
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('content-type')).toBe('image/webp');
    expect(avatar.headers.get('cache-control')).toBe('no-store');
    expect(avatar.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await avatar.arrayBuffer()).byteLength).toBeGreaterThan(0);

    expect(
      (
        await member.request('/api/v1/entries', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            body: '',
            imageIds: [first],
            tags: [],
            declarations: { nsfw: false, aiGenerated: false },
          }),
        })
      ).status,
    ).toBe(400);

    const attached = await readyAvatar(member, images[1]!.bytes);
    expect(
      (
        await member.request('/api/v1/entries', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
          body: JSON.stringify({
            body: '',
            imageIds: [attached],
            tags: [],
            declarations: { nsfw: false, aiGenerated: false },
          }),
        })
      ).status,
    ).toBe(201);
    expect((await profile(member, { avatarAssetId: attached })).status).toBe(409);

    const other = new Client(fixture.address);
    await other.auth('profile_other');
    expect((await profile(other, { avatarAssetId: first })).status).toBe(404);

    const third = await readyAvatar(member, images[2]!.bytes);
    expect((await profile(member, { avatarAssetId: third })).status).toBe(200);
    expect((await fetch(`${fixture.address}/media/${first}/avatar`)).status).toBe(404);
    expect((await fetch(`${fixture.address}/media/${third}/avatar`)).status).toBe(200);
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [first])).rows[0].state,
    ).toBe('deleted');

    expect((await profile(member, { avatarAssetId: null })).status).toBe(200);
    expect((await fetch(`${fixture.address}/media/${third}/avatar`)).status).toBe(404);
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [third])).rows[0].state,
    ).toBe('deleted');

    const firstRow = (
      await fixture.pool.query('select original_key from assets where id=$1', [first])
    ).rows[0];
    const deadline = Date.now() + 10_000;
    while ((await fixture.storage.files()).includes(firstRow.original_key) && Date.now() < deadline)
      await delay(100);
    expect(await fixture.storage.files()).not.toContain(firstRow.original_key);
  }, 60_000);

  it('changes the password, invalidates other sessions and requires the new password', async () => {
    const secondDevice = new Client(fixture.address);
    await secondDevice.session();
    const login = await secondDevice.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'profile_member',
        password: 'correct horse battery staple',
      }),
    });
    expect(login.status).toBe(200);
    secondDevice.csrfToken = ((await login.json()) as Session).csrfToken;
    const stale = staleCopy(member);
    const wrong = await member.request('/api/v1/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'wrong password',
        newPassword: 'another good password',
      }),
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.fields.currentPassword).toBeTruthy();
    const short = await member.request('/api/v1/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'correct horse battery staple',
        newPassword: 'short',
      }),
    });
    expect(short.status).toBe(400);
    const changed = await member.request('/api/v1/me/password', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'correct horse battery staple',
        newPassword: 'a brand new long password',
      }),
    });
    expect(changed.status).toBe(200);
    member.csrfToken = ((await changed.json()) as Session).csrfToken;
    expect((await member.request('/api/v1/me/likes')).status).toBe(200);
    const staleWrite = await stale.request('/api/v1/me/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'stale token' }),
    });
    expect(staleWrite.status).toBe(403);
    expect((await secondDevice.request('/api/v1/me/likes')).status).toBe(401);

    const oldPasswordClient = new Client(fixture.address);
    await oldPasswordClient.session();
    const oldPassword = await oldPasswordClient.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'profile_member',
        password: 'correct horse battery staple',
      }),
    });
    expect(oldPassword.status).toBe(401);
    const newPasswordClient = new Client(fixture.address);
    await newPasswordClient.session();
    const newPassword = await newPasswordClient.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'profile_member',
        password: 'a brand new long password',
      }),
    });
    expect(newPassword.status).toBe(200);
  }, 40_000);
});
