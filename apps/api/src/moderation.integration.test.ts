import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { EntryInput, EntryModerationInput, UploadStatus } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';
import { staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

const input = (body = 'visible body'): EntryInput => ({
  body,
  tags: ['moderation-tag'],
  declarations: { nsfw: false, aiGenerated: false },
});
async function mutate(client: Client, path: string, body: unknown, method = 'PATCH') {
  return client.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function publish(client: Client, value = input(), key = randomUUID()) {
  const response = await client.request('/api/v1/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(value),
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function moderate(
  client: Client,
  id: string,
  target: EntryModerationInput['target'],
  hidden = true,
  targetId?: string,
) {
  return mutate(client, `/api/v1/admin/entries/${id}/moderation`, {
    target,
    hidden,
    targetId,
    reason: 'reviewed policy violation',
  });
}

describe('audited content moderation and original-review boundary', () => {
  let fixture: Fixture;
  let owner: Client;
  let author: Client;
  let moderator: Client;
  let visitor: Client;
  let authorId: string;
  let moderatorId: string;
  let worker: { stop(): Promise<unknown> } | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    author = new Client(fixture.address);
    moderator = new Client(fixture.address);
    visitor = new Client(fixture.address);
    for (const [client, username] of [
      [owner, 'moderation_owner'],
      [author, 'moderation_author'],
      [moderator, 'moderation_staff'],
    ] as const)
      expect((await client.auth(username)).response.status).toBe(201);
    const users = await fixture.pool.query('select id,username from users');
    authorId = users.rows.find((row) => row.username === 'moderation_author').id;
    moderatorId = users.rows.find((row) => row.username === 'moderation_staff').id;
    expect(
      (
        await mutate(owner, `/api/v1/admin/users/${moderatorId}/roles`, {
          isAdmin: false,
          isModerator: true,
          reason: 'appoint reviewer',
        })
      ).status,
    ).toBe(200);
  }, 30_000);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture?.close();
  }, 50_000);

  it('redacts partial content on all ordinary reads while keeping author originals for editing and persistent restrictions', async () => {
    const entry = await publish(author, {
      ...input('secret-body-needle'),
      title: 'secret-title-needle',
      links: [{ url: 'https://example.com/private-link' }],
    });
    for (const target of ['title', 'body'] as const)
      expect((await moderate(moderator, entry.id, target)).status).toBe(200);
    const ordinary = await (await author.request(`/api/v1/entries/${entry.id}`)).json();
    expect(ordinary).toMatchObject({
      title: '标题已隐藏',
      body: '',
      moderation: { hidden: false, titleHidden: true, bodyHidden: true },
    });
    for (const needle of ['secret-title-needle', 'secret-body-needle']) {
      const results = await (await visitor.request('/api/v1/entries?q=' + needle)).json();
      expect(results).toMatchObject({ total: 0, items: [] });
    }
    for (const client of [author, moderator, owner]) {
      const review = await client.request(`/api/v1/admin/entries/${entry.id}`);
      expect(review.status).toBe(200);
      expect(await review.json()).toMatchObject({
        entry: { body: 'secret-body-needle', title: 'secret-title-needle' },
      });
    }
    expect((await visitor.request(`/api/v1/admin/entries/${entry.id}`)).status).toBe(401);
    expect((await moderate(author, entry.id, 'body', false)).status).toBe(403);
    expect(
      (
        await mutate(author, `/api/v1/entries/${entry.id}`, {
          body: 'edited original',
          title: 'edited title',
        })
      ).status,
    ).toBe(200);
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      body: '',
      title: '标题已隐藏',
    });
    expect((await moderate(moderator, entry.id, 'body', false)).status).toBe(200);
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      body: 'edited original',
    });
  });

  it('suppresses blank cards before counts and pagination, blocks interactions, restores without losing originals, and sanitizes idempotency replay', async () => {
    const key = randomUUID();
    const original = input('whole-hidden-body');
    const entry = await publish(author, original, key);
    expect((await moderate(moderator, entry.id, 'body')).status).toBe(200);
    expect(await (await visitor.request('/api/v1/entries?limit=1')).json()).toMatchObject({
      total: 0,
      items: [],
      nextCursor: null,
    });
    expect(await (await visitor.request('/api/v1/tags')).json()).toEqual([]);
    expect(await (await author.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      title: '标题已隐藏',
      body: '',
      tags: [],
      moderation: { hidden: true },
      canEdit: true,
    });
    expect(
      (await author.request(`/api/v1/entries/${entry.id}/like`, { method: 'PUT' })).status,
    ).toBe(404);
    expect((await author.request(`/api/v1/entries/${entry.id}/comments`)).status).toBe(404);
    expect(
      (
        await mutate(
          author,
          `/api/v1/entries/${entry.id}/comments`,
          { body: 'blocked comment' },
          'POST',
        )
      ).status,
    ).toBe(404);
    expect((await publish(author, original, key)).body).toBe('');
    const managed = await (await moderator.request('/api/v1/admin/entries')).json();
    expect(managed.items).toHaveLength(1);
    expect(managed.items[0].body).toBe('');
    expect((await moderate(moderator, entry.id, 'body', false)).status).toBe(200);
    expect((await moderate(moderator, entry.id, 'entry')).status).toBe(200);
    expect(await (await visitor.request('/api/v1/entries')).json()).toMatchObject({ total: 0 });
    expect((await moderate(moderator, entry.id, 'entry', false)).status).toBe(200);
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      body: original.body,
    });
    const audit = await (await owner.request('/api/v1/admin/audit')).json();
    expect(
      audit.items.filter((record: { targetId: string }) => record.targetId === entry.id),
    ).toHaveLength(4);
    expect(JSON.stringify(audit)).not.toContain(original.body);
  });

  it('keeps restricted review separate from ordinary visibility and applies scoped delete with current grants', async () => {
    const entry = await publish(author, { ...input('restricted original'), visibility: 'private' });
    const grants = await (await owner.request('/api/v1/admin/permissions')).json();
    expect(
      (
        await mutate(
          owner,
          '/api/v1/admin/permissions',
          {
            ...grants,
            moderator: grants.moderator.filter((value: string) => value !== 'content.restricted'),
            reason: 'restrict review scope',
          },
          'PUT',
        )
      ).status,
    ).toBe(200);
    expect((await moderator.request(`/api/v1/admin/entries/${entry.id}`)).status).toBe(404);
    expect((await moderate(moderator, entry.id, 'entry')).status).toBe(404);
    expect(await (await moderator.request('/api/v1/admin/entries')).json()).toMatchObject({
      total: 0,
      items: [],
    });
    expect((await owner.request(`/api/v1/entries/${entry.id}`)).status).toBe(200);
    expect((await owner.request(`/api/v1/admin/entries/${entry.id}`)).status).toBe(200);
    expect(
      (
        await mutate(
          owner,
          '/api/v1/admin/permissions',
          {
            ...grants,
            moderator: [...grants.moderator, 'content.restricted'],
            reason: 'grant restricted review scope',
          },
          'PUT',
        )
      ).status,
    ).toBe(200);
    expect((await moderator.request(`/api/v1/admin/entries/${entry.id}`)).status).toBe(200);
    expect(
      (await moderator.request(`/api/v1/entries/${entry.id}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect(
      (
        await mutate(
          moderator,
          `/api/v1/admin/entries/${entry.id}`,
          { reason: 'permanent removal' },
          'DELETE',
        )
      ).status,
    ).toBe(204);
    expect((await author.request(`/api/v1/admin/entries/${entry.id}`)).status).toBe(404);
    const audit = await (await owner.request('/api/v1/admin/audit')).json();
    expect(audit.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: moderatorId,
          action: 'content.delete',
          targetId: entry.id,
          reason: 'permanent removal',
        }),
      ]),
    );
  });

  it('keeps URL restrictions after remove/readd and restores only explicitly', async () => {
    const url = 'https://example.com/hidden-link';
    const entry = await publish(author, { ...input(), links: [{ url }] });
    expect((await moderate(moderator, entry.id, 'link', true, url)).status).toBe(200);
    for (const links of [[], [{ url }]])
      expect((await mutate(author, `/api/v1/entries/${entry.id}`, { links })).status).toBe(200);
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      links: [],
      moderation: { hiddenLinkCount: 1 },
    });
    expect((await moderate(moderator, entry.id, 'link', false, url)).status).toBe(200);
    expect(
      (await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).links,
    ).toHaveLength(1);
  });

  it('treats Unicode whitespace exactly like the editor when all attachments are hidden', async () => {
    const url = 'https://example.com/only-substance';
    const entry = await publish(author, {
      ...input('\n\t\u00a0\ufeff'),
      title: 'title is not content',
      links: [{ url }],
    });
    expect((await moderate(moderator, entry.id, 'link', true, url)).status).toBe(200);
    expect(await (await visitor.request('/api/v1/entries')).json()).toMatchObject({
      total: 0,
      items: [],
    });
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      body: '',
      links: [],
      moderation: { hidden: true },
    });
  });

  async function uploadReady(kind: 'image' | 'file') {
    const bytes =
      kind === 'image' ? (await staticImages())[0]!.bytes : Buffer.from('private attachment');
    const body = new FormData();
    body.append('kind', kind);
    body.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: kind === 'image' ? 'image/jpeg' : 'text/plain' }),
      kind === 'image' ? 'image.jpg' : 'attachment.txt',
    );
    const response = await author.request('/api/v1/uploads', {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body,
    });
    expect(response.status).toBe(202);
    const id = (await response.json()).id as string;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const status: UploadStatus = await (await author.request('/api/v1/uploads/' + id)).json();
      if (status.status === 'ready') return id;
      if (status.status === 'failed') throw new Error('Fixture upload failed');
      await delay(100);
    }
    throw new Error('Fixture upload timed out');
  }

  it('revokes hidden image/file bytes immediately and protects moderated avatars while retaining authorized originals', async () => {
    worker = await launchWorker(fixture);
    const imageId = await uploadReady('image');
    const fileId = await uploadReady('file');
    const entry = await publish(author, { ...input(), imageIds: [imageId], fileIds: [fileId] });
    for (const [target, id] of [
      ['image', imageId],
      ['file', fileId],
    ] as const) {
      expect((await moderate(moderator, entry.id, target, true, id)).status).toBe(200);
      for (const kind of target === 'image'
        ? ['thumbnail', 'original', 'download']
        : ['download']) {
        expect((await visitor.request(`/media/${id}/${kind}`)).status).toBe(404);
        for (const client of [author, moderator, owner])
          expect((await client.request(`/media/${id}/${kind}`)).status).toBe(200);
      }
    }
    expect(await (await visitor.request(`/api/v1/entries/${entry.id}`)).json()).toMatchObject({
      images: [],
      files: [],
    });
    expect((await moderate(moderator, entry.id, 'image', false, imageId)).status).toBe(200);
    expect((await visitor.request(`/media/${imageId}/thumbnail`)).status).toBe(200);
    expect((await moderate(moderator, entry.id, 'entry')).status).toBe(200);
    expect((await visitor.request(`/media/${imageId}/thumbnail`)).status).toBe(404);
    const avatarId = await uploadReady('image');
    expect((await mutate(author, '/api/v1/me/profile', { avatarAssetId: avatarId })).status).toBe(
      200,
    );
    expect(
      (
        await mutate(owner, `/api/v1/admin/users/${authorId}/profile-moderation`, {
          field: 'avatar',
          hidden: true,
          reason: 'avatar policy',
        })
      ).status,
    ).toBe(200);
    expect((await visitor.request(`/media/${avatarId}/avatar`)).status).toBe(404);
    expect((await moderator.request(`/media/${avatarId}/avatar`)).status).toBe(404);
    for (const client of [author, owner])
      expect((await client.request(`/media/${avatarId}/avatar`)).status).toBe(200);
  }, 60_000);
});
