import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Entry, EntryVisibility } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';
import { staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('profile privacy, visibility and site registration', () => {
  let fixture: Fixture;
  let owner: Client;
  let author: Client;
  let reader: Client;
  let visitor: Client;
  let worker: Awaited<ReturnType<typeof launchWorker>> | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    author = new Client(fixture.address);
    reader = new Client(fixture.address);
    visitor = new Client(fixture.address);
    expect((await owner.auth('site_owner')).response.status).toBe(201);
    expect((await author.auth('entry_author')).response.status).toBe(201);
    expect((await reader.auth('entry_reader')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture?.close();
  }, 50_000);
  const patch = (client: Client, path: string, body: unknown) =>
    client.request(path, json('PATCH', body));
  async function create(
    visibility?: EntryVisibility,
    imageIds?: string[],
    fileIds?: string[],
  ): Promise<Entry> {
    const response = await author.request('/api/v1/entries', {
      ...json('POST', {
        body: 'privacy regression unique',
        visibility,
        imageIds,
        fileIds,
        tags: ['private-tag'],
        declarations: { nsfw: false, aiGenerated: false },
      }),
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    });
    expect(response.status).toBe(201);
    return response.json();
  }
  const follow = (client: Client, username: string, on = true) =>
    client.request(`/api/v1/users/${username}/follow`, { method: on ? 'PUT' : 'DELETE' });
  async function visible(client: Client, entry: Entry, allowed: boolean) {
    expect((await client.request(`/api/v1/entries/${entry.id}`)).status).toBe(allowed ? 200 : 404);
    expect((await client.request(`/api/v1/entries/${entry.id}/comments`)).status).toBe(
      allowed ? 200 : 404,
    );
    for (const path of ['/api/v1/entries?q=privacy', '/api/v1/users/entry_author/entries']) {
      const response = await client.request(path);
      const data = await response.json();
      expect(data.items.some((item: Entry) => item.id === entry.id)).toBe(allowed);
      expect(data.total).toBe(allowed ? 1 : 0);
    }
    const tags = await (await client.request('/api/v1/tags?q=private-tag')).json();
    expect(tags.includes('private-tag')).toBe(allowed);
  }

  it('defaults existing-compatible entries to public and checks both follow directions dynamically', async () => {
    const entry = await create();
    expect(entry.visibility).toBe('public');
    expect(entry.author.bio).toBe('');
    await visible(visitor, entry, true);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'registered' });
    await visible(visitor, entry, false);
    await visible(reader, entry, true);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'followers' });
    await visible(reader, entry, false);
    expect((await follow(author, 'entry_reader')).status).toBe(200);
    await visible(reader, entry, false); // author following reader is the opposite direction
    expect((await follow(reader, 'entry_author')).status).toBe(200);
    await visible(reader, entry, true);
    expect((await follow(reader, 'entry_author', false)).status).toBe(200);
    await visible(reader, entry, false);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'following' });
    await visible(reader, entry, true);
    await follow(author, 'entry_reader', false);
    await visible(reader, entry, false);
    await follow(reader, 'entry_author');
    await visible(reader, entry, false);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'private' });
    await visible(reader, entry, false);
    await visible(author, entry, true);
    await visible(owner, entry, true);
    expect((await reader.request('/api/v1/admin/entries')).status).toBe(403);
    expect((await (await owner.request('/api/v1/admin/entries')).json()).items[0].id).toBe(
      entry.id,
    );
    expect((await follow(author, 'entry_author')).status).toBe(400);
  }, 40_000);

  it('revokes comments, likes and liked lists immediately on a visibility change', async () => {
    const entry = await create();
    expect(
      (await reader.request(`/api/v1/entries/${entry.id}/like`, { method: 'PUT' })).status,
    ).toBe(200);
    expect(
      (
        await reader.request(
          `/api/v1/entries/${entry.id}/comments`,
          json('POST', { body: 'previously public comment' }),
        )
      ).status,
    ).toBe(201);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'private' });
    expect(
      (await reader.request(`/api/v1/entries/${entry.id}/like`, { method: 'PUT' })).status,
    ).toBe(404);
    expect(
      (await reader.request(`/api/v1/entries/${entry.id}/like`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(
      (
        await reader.request(
          `/api/v1/entries/${entry.id}/comments`,
          json('POST', { body: 'not permitted' }),
        )
      ).status,
    ).toBe(404);
    const likes = await (await reader.request('/api/v1/me/likes')).json();
    expect(likes).toMatchObject({ items: [], total: 0 });
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'registered' });
    expect((await (await reader.request('/api/v1/me/likes')).json()).items[0].id).toBe(entry.id);
  }, 40_000);

  it('guards original, thumbnail and download after privacy and relationship transitions', async () => {
    worker = await launchWorker(fixture);
    const image = (await staticImages())[0]!;
    const body = new FormData();
    body.append(
      'file',
      new Blob([new Uint8Array(image.bytes)], { type: 'image/png' }),
      'privacy.png',
    );
    const response = await author.request('/api/v1/uploads', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body,
    });
    expect(response.status).toBe(202);
    const { id } = await response.json();
    const deadline = Date.now() + 25_000;
    let status = 'pending';
    while (Date.now() < deadline && status === 'pending') {
      status = (await (await author.request(`/api/v1/uploads/${id}`)).json()).status;
      if (status === 'pending') await delay(200);
    }
    expect(status).toBe('ready');
    const fileBody = new FormData();
    fileBody.append('kind', 'file');
    fileBody.append('file', new Blob(['private attachment']), 'private.txt');
    const fileResponse = await author.request('/api/v1/uploads', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: fileBody,
    });
    expect(fileResponse.status).toBe(202);
    const fileId = (await fileResponse.json()).id;
    const fileDeadline = Date.now() + 25_000;
    let fileStatus = 'pending';
    while (Date.now() < fileDeadline && fileStatus === 'pending') {
      fileStatus = (await (await author.request(`/api/v1/uploads/${fileId}`)).json()).status;
      if (fileStatus === 'pending') await delay(200);
    }
    expect(fileStatus).toBe('ready');
    const entry = await create('public', [id], [fileId]);
    const media = async (client: Client, allowed: boolean) => {
      for (const kind of ['original', 'thumbnail', 'download']) {
        const result = await client.request(`/media/${id}/${kind}`);
        expect(result.status).toBe(allowed ? 200 : 404);
        expect(result.headers.get('cache-control')).toBe('no-store');
        await result.arrayBuffer();
      }
      const file = await client.request(`/media/${fileId}/download`);
      expect(file.status).toBe(allowed ? 200 : 404);
      expect(file.headers.get('cache-control')).toBe('no-store');
      await file.arrayBuffer();
    };
    await media(visitor, true);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'followers' });
    await media(visitor, false);
    await media(reader, false);
    await follow(reader, 'entry_author');
    await media(reader, true);
    await follow(reader, 'entry_author', false);
    await media(reader, false);
    await patch(author, `/api/v1/entries/${entry.id}`, { visibility: 'following' });
    await follow(reader, 'entry_author');
    await media(reader, false);
    await follow(author, 'entry_reader');
    await media(reader, true);
    await follow(author, 'entry_reader', false);
    await media(reader, false);
    await media(author, true);
    await media(owner, true);
  }, 60_000);

  it('keeps private profile data out of author serialization and respects independent graph privacy flags', async () => {
    const data = {
      bio: '公开签名',
      email: 'author@example.com',
      location: '私密地址',
      pronouns: 'they/them',
      socialLinks: [{ label: '主页', url: 'https://example.com/' }],
      showEmail: false,
      showLocation: false,
      showSocialLinks: false,
      showFollowing: false,
      showFollowers: false,
    };
    expect((await patch(author, '/api/v1/me/profile', data)).status).toBe(200);
    expect(await (await author.request('/api/v1/me/profile')).json()).toMatchObject(data);
    const own = await (await author.request('/api/v1/users/entry_author')).json();
    expect(own.email).toBe(data.email);
    await follow(reader, 'entry_author');
    await follow(author, 'entry_reader');
    const publicProfile = await (await visitor.request('/api/v1/users/entry_author')).json();
    expect(publicProfile).toMatchObject({
      user: { bio: data.bio },
      email: null,
      location: null,
      socialLinks: [],
      followingCount: 1,
      followerCount: 1,
    });
    for (const kind of ['following', 'followers']) {
      expect((await visitor.request(`/api/v1/users/entry_author/${kind}`)).status).toBe(403);
      expect((await reader.request(`/api/v1/users/entry_author/${kind}`)).status).toBe(403);
      expect((await author.request(`/api/v1/users/entry_author/${kind}`)).status).toBe(200);
    }
    const entry = await create();
    expect(entry.author).toMatchObject({ bio: data.bio });
    for (const field of ['email', 'location', 'socialLinks', 'passwordHash', 'usernameKey'])
      expect(entry.author).not.toHaveProperty(field);
    await patch(author, '/api/v1/me/profile', {
      showEmail: true,
      showLocation: true,
      showSocialLinks: true,
      showFollowing: true,
    });
    const revealed = await (await visitor.request('/api/v1/users/entry_author')).json();
    expect(revealed).toMatchObject({
      email: data.email,
      location: data.location,
      socialLinks: data.socialLinks,
    });
    expect((await visitor.request('/api/v1/users/entry_author/following')).status).toBe(200);
    expect((await visitor.request('/api/v1/users/entry_author/followers')).status).toBe(403);
    expect(
      (
        await patch(author, '/api/v1/me/profile', {
          socialLinks: [{ label: 'x', url: 'javascript:alert(1)' }],
        })
      ).status,
    ).toBe(400);
  }, 40_000);

  it('enforces registration closure, owner-only settings, URL validation and normalized username checks', async () => {
    expect((await patch(reader, '/api/v1/site', { registrationOpen: false })).status).toBe(403);
    expect((await patch(owner, '/api/v1/site', { logoUrl: 'file:///etc/passwd' })).status).toBe(
      400,
    );
    expect(
      (
        await patch(owner, '/api/v1/site', {
          title: '新站点',
          description: '新介绍',
          registrationOpen: false,
          logoUrl: 'https://example.com/logo.png',
        })
      ).status,
    ).toBe(200);
    expect(await (await visitor.request('/api/v1/site')).json()).toMatchObject({
      title: '新站点',
      registrationOpen: false,
    });
    expect((await new Client(fixture.address).auth('closed_new_user')).response.status).toBe(403);
    expect((await new Client(fixture.address).auth('entry_reader', 'login')).response.status).toBe(
      200,
    );
    expect(
      await (
        await visitor.request('/api/v1/auth/username-availability?username=ENTRY_READER')
      ).json(),
    ).toEqual({ available: false });
    expect(
      await (
        await visitor.request('/api/v1/auth/username-availability?username=unused_name')
      ).json(),
    ).toEqual({ available: true });
    expect((await visitor.request('/api/v1/auth/username-availability?username=x')).status).toBe(
      400,
    );
    await patch(owner, '/api/v1/site', { registrationOpen: true });
    expect((await new Client(fixture.address).auth('reopened_user')).response.status).toBe(201);
    await fixture.reset();
    await fixture.pool.query('update site_settings set registration_open = false where id = 1');
    const bootstrap = await new Client(fixture.address).auth('bootstrap_owner');
    expect(bootstrap.response.status).toBe(201);
    expect(bootstrap.data.user.role).toBe('owner');
  }, 40_000);
});
