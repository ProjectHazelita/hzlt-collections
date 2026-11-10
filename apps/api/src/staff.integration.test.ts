import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture, type Fixture } from './testing/fixture.js';

const change = (client: Client, path: string, body: unknown, method = 'PATCH') =>
  client.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('independent staff grants, user protections and audited moderation', () => {
  let fixture: Fixture;
  let owner: Client;
  let admin: Client;
  let mod: Client;
  let member: Client;
  let ids: { owner: string; admin: string; mod: string; member: string };
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    admin = new Client(fixture.address);
    mod = new Client(fixture.address);
    member = new Client(fixture.address);
    ids = {
      owner: (await owner.auth('staff_owner')).data.user.id,
      admin: (await admin.auth('staff_admin')).data.user.id,
      mod: (await mod.auth('staff_moderator')).data.user.id,
      member: (await member.auth('staff_member')).data.user.id,
    };
    expect(
      (
        await change(owner, `/api/v1/admin/users/${ids.admin}/roles`, {
          isAdmin: true,
          isModerator: false,
          reason: '任命管理员',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await change(owner, `/api/v1/admin/users/${ids.mod}/roles`, {
          isAdmin: false,
          isModerator: true,
          reason: '任命版主',
        })
      ).status,
    ).toBe(200);
  }, 40_000);
  afterEach(async () => {
    await fixture?.close();
  });

  it('unions independent grants, applies revocations to existing sessions and audits atomically', async () => {
    const a = (await admin.session()).data.user;
    const m = (await mod.session()).data.user;
    expect(a).toMatchObject({ isAdmin: true, isModerator: false });
    expect(a.permissions).toContain('users.manage');
    expect(a.permissions).not.toContain('content.moderate');
    expect(m).toMatchObject({ isAdmin: false, isModerator: true });
    expect(m.permissions).toContain('content.moderate');
    expect((await mod.request('/api/v1/admin/users')).status).toBe(403);
    expect(m.permissions).not.toContain('content.restricted');
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.member}/roles`, {
          isAdmin: true,
          isModerator: true,
          reason: '越权任命',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await change(owner, `/api/v1/admin/users/${ids.admin}/roles`, {
          isAdmin: true,
          isModerator: true,
          reason: '兼任版主',
        })
      ).status,
    ).toBe(200);
    expect((await admin.session()).data.user.permissions).toEqual(
      expect.arrayContaining(['users.manage', 'content.moderate']),
    );
    expect(
      (
        await change(
          owner,
          '/api/v1/admin/permissions',
          { admin: ['users.manage'], moderator: ['content.moderate'], reason: '最小授权' },
          'PUT',
        )
      ).status,
    ).toBe(200);
    expect((await admin.session()).data.user.permissions).toEqual(
      expect.arrayContaining(['users.manage', 'content.moderate']),
    );
    expect((await admin.request('/api/v1/admin/audit')).status).toBe(403);
    expect((await change(admin, '/api/v1/site', { title: '越权改名' })).status).toBe(403);
    expect(
      (
        await change(
          owner,
          '/api/v1/admin/permissions',
          { admin: ['content.delete'], moderator: [], reason: '非法范围' },
          'PUT',
        )
      ).status,
    ).toBe(400);
    const audit = await (await owner.request('/api/v1/admin/audit?limit=2')).json();
    expect(audit.items).toHaveLength(2);
    expect(audit.nextCursor).not.toBeNull();
    const next = await (
      await owner.request(`/api/v1/admin/audit?limit=2&cursor=${audit.nextCursor}`)
    ).json();
    expect(
      next.items.every(
        (r: { id: string }) => !audit.items.some((s: { id: string }) => r.id === s.id),
      ),
    ).toBe(true);
    const stored = await fixture.pool.query('select action from audit_records order by id');
    expect(stored.rows).toHaveLength(4);
  });

  it('bans ordinary members, rejects protected targets, invalidates saved sessions and blocks login', async () => {
    for (const id of [ids.owner, ids.admin, ids.mod])
      expect(
        (await change(admin, `/api/v1/admin/users/${id}/ban`, { banned: true, reason: '越权封禁' }))
          .status,
      ).toBe(403);
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.member}/ban`, {
          banned: true,
          reason: '违规封禁',
        })
      ).status,
    ).toBe(200);
    expect((await member.request('/test/private')).status).toBe(401);
    expect((await new Client(fixture.address).auth('staff_member', 'login')).response.status).toBe(
      401,
    );
    const sessions = await fixture.pool.query(
      "select count(*)::integer as n from sessions where payload->>'userId'=$1",
      [ids.member],
    );
    expect(sessions.rows[0].n).toBe(0);
    expect(
      (
        await change(owner, `/api/v1/admin/users/${ids.mod}/ban`, {
          banned: true,
          reason: '所有者处理版主',
        })
      ).status,
    ).toBe(200);
    expect((await mod.request('/api/v1/admin/entries')).status).toBe(401);
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.member}/ban`, {
          banned: false,
          reason: '解除封禁',
        })
      ).status,
    ).toBe(200);
    expect((await new Client(fixture.address).auth('staff_member', 'login')).response.status).toBe(
      200,
    );
  });

  it('keeps hidden profile originals private and restrictions survive author edits across projections', async () => {
    expect(
      (
        await change(member, '/api/v1/me/profile', {
          displayName: 'hidden-original-name',
          bio: 'hidden-original-bio',
          email: 'hidden@example.test',
          location: 'hidden-location',
          pronouns: 'they/them',
          socialLinks: [{ label: 'hidden-link', url: 'https://example.test/' }],
          showEmail: true,
          showLocation: true,
          showSocialLinks: true,
        })
      ).status,
    ).toBe(200);
    const created = await member.request('/api/v1/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        body: 'public entry',
        tags: [],
        declarations: { nsfw: false, aiGenerated: false },
      }),
    });
    const entry = await created.json();
    expect(created.status).toBe(201);
    const comment = await change(
      member,
      `/api/v1/entries/${entry.id}/comments`,
      { body: 'public comment' },
      'POST',
    );
    expect(comment.status).toBe(201);
    const commentId = (await comment.json()).id;
    expect(
      (
        await change(
          admin,
          `/api/v1/entries/${entry.id}/comments`,
          { body: 'reply', parentId: commentId },
          'POST',
        )
      ).status,
    ).toBe(201);
    expect(
      (await member.request('/api/v1/users/staff_owner/follow', { method: 'PUT' })).status,
    ).toBe(200);
    for (const field of ['displayName', 'bio', 'email', 'location', 'pronouns', 'socialLinks'])
      expect(
        (
          await change(admin, `/api/v1/admin/users/${ids.member}/profile-moderation`, {
            field,
            hidden: true,
            reason: '资料违规',
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await change(member, '/api/v1/me/profile', {
          displayName: 'replacement-hidden',
          bio: 'replacement-bio',
        })
      ).status,
    ).toBe(200);
    const visitor = new Client(fixture.address);
    for (const path of [
      '/api/v1/users/staff_member',
      '/api/v1/users/staff_owner/followers',
      `/api/v1/entries/${entry.id}`,
      `/api/v1/entries/${entry.id}/comments`,
      '/api/v1/entries',
    ]) {
      const response = await visitor.request(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toMatch(
        /hidden-original|replacement-hidden|replacement-bio|hidden@example|hidden-location|hidden-link/,
      );
    }
    const own = await (await member.request('/api/v1/me/profile')).json();
    expect(own).toMatchObject({
      displayName: 'replacement-hidden',
      bio: 'replacement-bio',
      email: 'hidden@example.test',
    });
    expect(own.hiddenFields).toContain('displayName');
    expect((await admin.request(`/api/v1/admin/users/${ids.member}/profile`)).status).toBe(403);
    expect(
      await (await owner.request(`/api/v1/admin/users/${ids.member}/profile`)).json(),
    ).toMatchObject({ displayName: 'replacement-hidden' });
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.owner}/profile-moderation`, {
          field: 'bio',
          hidden: true,
          reason: '越权',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await change(owner, `/api/v1/admin/users/${ids.admin}/profile-moderation`, {
          field: 'bio',
          hidden: true,
          reason: '职员违规',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.admin}/profile-moderation`, {
          field: 'bio',
          hidden: false,
          reason: '自行恢复',
        })
      ).status,
    ).toBe(403);
    const auditText = JSON.stringify(
      (await (await owner.request('/api/v1/admin/audit')).json()).items,
    );
    expect(auditText).not.toMatch(/replacement-hidden|replacement-bio|hidden@example/);
  });

  it('splits brand and registration permissions and records successful site changes only', async () => {
    expect(
      (
        await change(
          owner,
          '/api/v1/admin/permissions',
          { admin: ['site.brand'], moderator: ['audit.read'], reason: '品牌专员' },
          'PUT',
        )
      ).status,
    ).toBe(200);
    expect((await change(admin, '/api/v1/site', { title: 'new site brand' })).status).toBe(200);
    expect(
      (await change(admin, '/api/v1/site', { title: 'must not apply', registrationOpen: false }))
        .status,
    ).toBe(403);
    expect((await (await owner.request('/api/v1/site')).json()).title).toBe('new site brand');
    const rows = await fixture.pool.query("select * from audit_records where action='site.update'");
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('new site brand');
  });

  it('does not resurrect a banned session when an already-running request saves late', async () => {
    const gate = fixture.lateSave();
    const pending = member.request('/test/late-save', { method: 'POST' });
    await gate.started;
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.member}/ban`, {
          banned: true,
          reason: '并发封禁',
        })
      ).status,
    ).toBe(200);
    gate.release();
    expect((await pending).status).not.toBe(200);
    expect(
      (
        await change(admin, `/api/v1/admin/users/${ids.member}/ban`, {
          banned: false,
          reason: '解除封禁',
        })
      ).status,
    ).toBe(200);
    expect((await member.request('/test/private')).status).toBe(401);
  });

  it('rolls back a staff appointment when the audit write fails', async () => {
    await fixture.pool.query(
      `create function hcl_test_reject_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end $$`,
    );
    await fixture.pool.query(
      'create trigger hcl_test_reject_audit before insert on audit_records for each row execute function hcl_test_reject_audit()',
    );
    try {
      expect(
        (
          await change(owner, `/api/v1/admin/users/${ids.member}/roles`, {
            isAdmin: true,
            isModerator: true,
            reason: '必须原子提交',
          })
        ).status,
      ).toBe(500);
      const row = await fixture.pool.query('select is_admin, is_moderator from users where id=$1', [
        ids.member,
      ]);
      expect(row.rows[0]).toEqual({ is_admin: false, is_moderator: false });
    } finally {
      await fixture.pool.query('drop trigger hcl_test_reject_audit on audit_records');
      await fixture.pool.query('drop function hcl_test_reject_audit()');
    }
  });
});
