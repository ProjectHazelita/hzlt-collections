import { randomUUID } from 'node:crypto';
import type { Comment, CommentList, Entry, EntryInput, UserCommentList } from '@hcl/contracts';
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
  async function history(client?: Client, query = ''): Promise<UserCommentList> {
    const path = `/api/v1/users/comment_member/comments${query}`;
    const response = client ? await client.request(path) : await fetch(fixture.address + path);
    expect(response.status).toBe(200);
    return response.json();
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

  it('lists authored roots and nested replies with entry context and sanitized parent authors', async () => {
    const created = await entry(owner);
    const root = (await (await comment(member, created.id, 'authored root')).json()) as Comment;
    const parent = (await (await comment(owner, created.id, 'parent', root.id)).json()) as Comment;
    const reply = (await (
      await comment(member, created.id, 'authored reply', parent.id)
    ).json()) as Comment;
    await fixture.pool.query(
      `update entries set title = 'hidden title',
       moderation = jsonb_set(moderation, '{titleHidden}', 'true') where id = $1`,
      [created.id],
    );
    await fixture.pool.query(
      `update users set display_name = 'hidden display', bio = 'hidden biography',
       hidden_profile_fields = '["displayName", "bio"]'::jsonb where username = 'comment_owner'`,
    );

    const result = await history();
    expect(result.nextCursor).toBeNull();
    expect(result.items.map((item) => item.comment.id)).toEqual([reply.id, root.id]);
    expect(result.items.map((item) => item.entry)).toEqual([
      { id: created.id, title: null },
      { id: created.id, title: null },
    ]);
    expect(result.items[0]!.comment).toMatchObject({
      parentId: parent.id,
      replyTo: { username: 'comment_owner', displayName: 'comment_owner', bio: '' },
    });
    expect(result.items[1]!.comment.replyTo).toBeNull();
    expect((await fetch(`${fixture.address}/api/v1/users/nonexistent/comments`)).status).toBe(404);
  });

  it('filters history before pagination for each viewer and never exposes hidden or deleted entries', async () => {
    const viewer = new Client(fixture.address);
    expect((await viewer.auth('comment_viewer')).response.status).toBe(201);
    const visible: Record<string, string> = {};
    for (const visibility of ['public', 'registered', 'followers', 'following', 'private']) {
      const created = await entry(owner, `content for ${visibility}`);
      await comment(member, created.id, `comment on ${visibility}`);
      await fixture.pool.query('update entries set visibility = $1, title = $1 where id = $2', [
        visibility,
        created.id,
      ]);
      visible[visibility] = created.id;
    }
    for (const kind of ['hidden', 'bodyHidden', 'deleted']) {
      const created = await entry(owner, kind);
      await comment(member, created.id, `secret ${kind}`);
      if (kind === 'deleted')
        await fixture.pool.query('update entries set deleted_at = now() where id = $1', [
          created.id,
        ]);
      else
        await fixture.pool.query(
          'update entries set moderation = jsonb_set(moderation, $1::text[], $2::jsonb) where id = $3',
          [[kind], 'true', created.id],
        );
    }
    expect((await history()).items.map((item) => item.entry.id)).toEqual([visible.public]);
    const first = await history(viewer, '?limit=1');
    expect(first.items.map((item) => item.entry.id)).toEqual([visible.registered]);
    expect(first.nextCursor).not.toBeNull();
    const second = await history(viewer, `?limit=1&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.entry.id)).toEqual([visible.public]);
    expect(second.nextCursor).toBeNull();
    expect((await history(member)).items.map((item) => item.entry.id)).toEqual([
      visible.registered,
      visible.public,
    ]);
    await fixture.pool.query(
      `insert into follows (follower_id, followed_id)
       select a.id, b.id from users a cross join users b
       where (a.username = 'comment_viewer' and b.username = 'comment_owner')
          or (a.username = 'comment_owner' and b.username = 'comment_viewer')`,
    );
    expect((await history(viewer)).items.map((item) => item.entry.id)).toEqual([
      visible.following,
      visible.followers,
      visible.registered,
      visible.public,
    ]);
    expect((await history(owner)).items.map((item) => item.entry.id)).toEqual([
      visible.private,
      visible.following,
      visible.followers,
      visible.registered,
      visible.public,
    ]);
  });

  it('paginates newest first using microseconds and IDs without skips when new comments arrive', async () => {
    const created = await entry(owner);
    const authored: Comment[] = [];
    for (let index = 0; index < 5; index++)
      authored.push((await (await comment(member, created.id, `page ${index}`)).json()) as Comment);
    await fixture.pool.query(
      `update comments set created_at = '2026-01-01T00:00:00.000001Z'::timestamptz
       where id = any($1::bigint[])`,
      [authored.slice(0, 2).map((item) => item.id)],
    );
    await fixture.pool.query(
      `update comments set created_at = '2026-01-01T00:00:00.000002Z'::timestamptz
       where id = any($1::bigint[])`,
      [authored.slice(2).map((item) => item.id)],
    );
    const first = await history(undefined, '?limit=2');
    expect(first.items.map((item) => item.comment.id)).toEqual([authored[4]!.id, authored[3]!.id]);
    expect(first.nextCursor).not.toBeNull();
    await comment(member, created.id, 'newer than the first page');
    const second = await history(undefined, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.comment.id)).toEqual([authored[2]!.id, authored[1]!.id]);
    expect(second.nextCursor).not.toBeNull();
    const third = await history(undefined, `?limit=2&cursor=${second.nextCursor}`);
    expect(third.items.map((item) => item.comment.id)).toEqual([authored[0]!.id]);
    expect(third.nextCursor).toBeNull();
  });

  it('rejects malformed, cross-route and out-of-range history cursors and limits', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const cursors = [
      'not-json',
      encode({ kind: 'entries', id: '1' }),
      encode({
        kind: 'user-comments',
        id: '9999999999999999999',
        at: '2026-01-01T00:00:00.000001Z',
      }),
      encode({ kind: 'user-comments', id: '1', at: 'not-a-date' }),
      encode({ kind: 'user-comments', id: '1', at: '2026-02-30T00:00:00.000001Z' }),
    ];
    for (const cursor of cursors)
      expect(
        (await fetch(`${fixture.address}/api/v1/users/comment_member/comments?cursor=${cursor}`))
          .status,
      ).toBe(400);
    for (const limit of ['0', '51', '1.5'])
      expect(
        (await fetch(`${fixture.address}/api/v1/users/comment_member/comments?limit=${limit}`))
          .status,
      ).toBe(400);
  });

  it('requires authentication, CSRF and comment ownership even for the owner', async () => {
    const created = await entry(owner);
    const target = (await (await comment(member, created.id, 'only mine')).json()) as Comment;
    const path = `/api/v1/entries/${created.id}/comments/${target.id}`;
    const visitor = new Client(fixture.address);
    await visitor.session();
    expect((await visitor.request(path, { method: 'DELETE' })).status).toBe(401);
    expect((await owner.request(path, { method: 'DELETE' })).status).toBe(403);
    expect(
      (
        await member.request(path, {
          method: 'DELETE',
          headers: { 'x-csrf-token': 'incorrect' },
        })
      ).status,
    ).toBe(403);
    const other = await entry(member);
    expect(
      (
        await member.request(`/api/v1/entries/${other.id}/comments/${target.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await member.request(`/api/v1/entries/${created.id}/comments/999`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
    expect((await list(created.id)).total).toBe(1);
    const removed = await member.request(path, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect((await member.request(path, { method: 'DELETE' })).status).toBe(404);
  });

  it('physically deletes all descendant levels for replies and roots without deleting siblings', async () => {
    const created = await entry(owner);
    const other = await entry(member);
    const root = (await (await comment(member, created.id, 'root')).json()) as Comment;
    const target = (await (
      await comment(member, created.id, 'remove reply', root.id)
    ).json()) as Comment;
    const child = (await (await comment(owner, created.id, 'child', target.id)).json()) as Comment;
    const grandchild = (await (
      await comment(member, created.id, 'grandchild', child.id)
    ).json()) as Comment;
    const deepest = (await (
      await comment(owner, created.id, 'deepest', grandchild.id)
    ).json()) as Comment;
    const sibling = (await (
      await comment(owner, created.id, 'sibling', root.id)
    ).json()) as Comment;
    const siblingChild = (await (
      await comment(member, created.id, 'sibling child', sibling.id)
    ).json()) as Comment;
    const otherRoot = (await (await comment(owner, created.id, 'other root')).json()) as Comment;
    const otherEntry = (await (await comment(member, other.id, 'other entry')).json()) as Comment;
    expect(
      (
        await member.request(`/api/v1/entries/${created.id}/comments/${target.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect((await list(created.id)).total).toBe(4);
    expect((await list(created.id)).items[0]!.replies.map((item) => item.id)).toEqual([
      sibling.id,
      siblingChild.id,
    ]);
    expect(
      (
        await fixture.pool.query('select id from comments where id = any($1::bigint[])', [
          [target.id, child.id, grandchild.id, deepest.id],
        ])
      ).rows,
    ).toEqual([]);
    expect((await history()).items.map((item) => item.comment.id)).toEqual([
      otherEntry.id,
      siblingChild.id,
      root.id,
    ]);
    expect(
      (await comment(owner, created.id, 'cannot reply to deleted parent', deepest.id)).status,
    ).toBe(404);
    expect(
      (
        await member.request(`/api/v1/entries/${created.id}/comments/${root.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    expect((await list(created.id)).items.map((item) => item.comment.id)).toEqual([otherRoot.id]);
    expect((await fixture.pool.query('select id::text from comments order by id')).rows).toEqual([
      { id: otherRoot.id },
      { id: otherEntry.id },
    ]);
  });
});
