import { randomUUID } from 'node:crypto';
import type { Comment, CommentList, Entry, EntryInput } from '@hcl/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';

const text = (body: string): EntryInput => ({
  body,
  tags: [],
  declarations: { nsfw: false, aiGenerated: false },
});

describe('entry comments with a single visual level', () => {
  let fixture: Fixture;
  let owner: Client;
  let member: Client;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    member = new Client(fixture.address);
    expect((await owner.auth('comment_owner')).response.status).toBe(201);
    expect((await member.auth('comment_member')).response.status).toBe(201);
  }, 30_000);
  afterEach(async () => {
    await fixture?.close();
  });

  async function entry(client: Client, body = 'comment target') {
    const response = await client.request('/api/v1/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(text(body)),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Entry;
  }
  async function comment(client: Client, entryId: string, body: string, parentId?: string) {
    return client.request(`/api/v1/entries/${entryId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, parentId: parentId ?? null }),
    });
  }
  async function list(entryId: string): Promise<CommentList> {
    return (await fetch(`${fixture.address}/api/v1/entries/${entryId}/comments`)).json();
  }

  it('flattens deeper replies into one visual level while keeping the reply target', async () => {
    const created = await entry(member);
    expect(await list(created.id)).toEqual({ items: [], total: 0 });
    const root = await comment(member, created.id, '  第一层  ');
    expect(root.status).toBe(201);
    const rootComment = (await root.json()) as Comment;
    expect(rootComment.body).toBe('第一层');
    expect(rootComment.parentId).toBeNull();
    expect(rootComment.replyTo).toBeNull();
    const direct = (await (
      await comment(owner, created.id, '回复第一层', rootComment.id)
    ).json()) as Comment;
    const nested = (await (
      await comment(member, created.id, '回复回复', direct.id)
    ).json()) as Comment;
    expect(nested.replyTo).toMatchObject({ username: 'comment_owner' });

    const threads = await list(created.id);
    expect(threads.total).toBe(3);
    expect(threads.items).toHaveLength(1);
    expect(threads.items[0]!.comment.body).toBe('第一层');
    expect(threads.items[0]!.replies.map((reply) => reply.body)).toEqual([
      '回复第一层',
      '回复回复',
    ]);
    expect(threads.items[0]!.replies.map((reply) => reply.replyTo?.username)).toEqual([
      'comment_member',
      'comment_owner',
    ]);
  });

  it('validates entry, parent and body without accepting guest writes', async () => {
    const created = await entry(member);
    const other = await entry(member, 'other target');
    const foreign = (await (await comment(member, other.id, 'foreign parent')).json()) as Comment;
    const visitor = new Client(fixture.address);
    await visitor.session();
    expect((await comment(visitor, created.id, 'anonymous')).status).toBe(401);
    expect((await comment(member, '999', 'missing entry')).status).toBe(404);
    expect((await comment(member, created.id, 'parent outside entry', foreign.id)).status).toBe(
      404,
    );
    for (const body of ['', '   ', 'x'.repeat(1001)]) {
      expect((await comment(member, created.id, body)).status).toBe(400);
    }
    expect(
      (await (await fetch(`${fixture.address}/api/v1/entries/${created.id}/comments`)).json())
        .total,
    ).toBe(0);
  });

  it('retains comments across edits and removes them with the entry', async () => {
    const created = await entry(member);
    await comment(owner, created.id, '会保留');
    const edited = await member.request(`/api/v1/entries/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'edited' }),
    });
    expect(edited.status).toBe(200);
    expect((await list(created.id)).total).toBe(1);
    expect(
      (await owner.request(`/api/v1/entries/${created.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect((await fetch(`${fixture.address}/api/v1/entries/${created.id}/comments`)).status).toBe(
      404,
    );
    expect(
      (await fixture.pool.query('select count(*)::int as count from comments')).rows[0].count,
    ).toBe(0);
  });
});
