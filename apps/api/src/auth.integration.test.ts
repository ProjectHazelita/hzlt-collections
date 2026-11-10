import { randomUUID } from 'node:crypto';
import { PostgresSessionStore, sql } from '@hcl/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture } from './testing/fixture.js';

describe('PostgreSQL authentication and session boundaries', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
  }, 30_000);
  afterEach(async () => {
    await fixture?.close();
  });

  it('serializes concurrent first-owner registrations and enforces the database constraint', async () => {
    const clients = [new Client(fixture.address), new Client(fixture.address)];
    const results = await Promise.all(clients.map((client, index) => client.auth('用户_' + index)));
    expect(results.map((result) => result.response.status)).toEqual([201, 201]);
    expect(results.map((result) => result.data.user.role).sort()).toEqual(['member', 'owner']);
    const rows = await fixture.pool.query(
      'select role, count(*)::int as count from users group by role order by role',
    );
    expect(rows.rows).toEqual([
      { role: 'member', count: 1 },
      { role: 'owner', count: 1 },
    ]);
    await expect(
      fixture.pool.query(
        "insert into users (username, username_key, display_name, password_hash, role) values ('illegal', 'illegal', 'illegal', 'irrelevant', 'owner')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  }, 30_000);

  it('does not consume ownership on failed registration and normalizes username uniqueness', async () => {
    const client = new Client(fixture.address);
    await client.session();
    const invalid = await client.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'correct horse battery staple' }),
    });
    expect(invalid.status).toBe(400);
    const owner = await client.auth('Ｔｅｓｔ');
    expect(owner.response.status).toBe(201);
    expect(owner.data.user).toMatchObject({ username: 'Ｔｅｓｔ', role: 'owner' });
    const duplicate = await new Client(fixture.address).auth('test');
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.data.error.code).toBe('USERNAME_TAKEN');
    const next = await new Client(fixture.address).auth('another');
    expect(next.data.user.role).toBe('member');
  }, 30_000);

  it('rotates generations, rejects old and expired cookies, and keeps cookies opaque', async () => {
    const client = new Client(fixture.address);
    const anonymous = await client.session();
    const oldCookie = client.cookie;
    const registered = await client.auth('cookie_user');
    expect(registered.response.status).toBe(201);
    expect(client.cookie).not.toBe(oldCookie);
    const cookie = registered.response.headers.getSetCookie().join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/cookie_user|password|csrfToken/);
    const stale = new Client(fixture.address);
    stale.cookie = oldCookie;
    expect((await stale.request('/test/private')).status).toBe(401);
    expect((await client.request('/test/private')).status).toBe(200);
    await fixture.db.execute(sql`update sessions set expires_at = now() - interval '1 second'`);
    const expired = await client.request('/test/private');
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.code).toBe('SESSION_EXPIRED');
  }, 30_000);

  it('requires bound CSRF and exact Origin even for anonymous auth endpoints', async () => {
    const client = new Client(fixture.address);
    await client.session();
    for (const headers of [
      { origin: client.origin, 'x-csrf-token': '' },
      { origin: 'https://untrusted.example', 'x-csrf-token': client.csrfToken },
      { origin: client.origin, 'x-csrf-token': 'wrong' },
    ]) {
      const response = await client.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'someone', password: 'correct horse battery staple' }),
      });
      expect(response.status).toBe(403);
    }
    const response = await fetch(fixture.address + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone', password: 'correct horse battery staple' }),
    });
    expect(response.status).toBe(403);
  });

  it('does not reveal whether a failed login username exists', async () => {
    await new Client(fixture.address).auth('existing_user');
    const client = new Client(fixture.address);
    await client.session();
    for (const username of ['existing_user', 'missing_user']) {
      const response = await client.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'incorrect password value' }),
      });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
    }
  }, 30_000);

  it('cannot resurrect a destroyed session through CAS or a real late HTTP save', async () => {
    const client = new Client(fixture.address);
    await client.auth('late_save_user');
    const originalCookie = client.cookie;
    const gate = fixture.lateSave();
    const late = client.request('/test/late-save', { method: 'POST' });
    await gate.started;
    const logout = await client.request('/api/v1/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(204);
    gate.release();
    expect((await late).status).toBe(401);
    expect(
      (await fixture.pool.query('select count(*)::int as count from sessions')).rows[0].count,
    ).toBe(0);
    const stale = new Client(fixture.address);
    stale.cookie = originalCookie;
    expect((await stale.request('/test/private')).status).toBe(401);

    const store = new PostgresSessionStore(fixture.db);
    const id = randomUUID();
    const payload = {
      cookie: { expires: new Date(Date.now() + 60_000).toISOString() },
      __fastifySessionMetadata: { generation: 'generation-a' },
      anonymousExpiresAt: Date.now() + 60_000,
    };
    const set = Promise.withResolvers<void>();
    store.set(id, payload, (error) => (error ? set.reject(error) : set.resolve()));
    await set.promise;
    const destroyed = Promise.withResolvers<void>();
    store.destroy(id, (error) => (error ? destroyed.reject(error) : destroyed.resolve()));
    await destroyed.promise;
    const swapped = Promise.withResolvers<void>();
    store.compareAndSet(id, 'generation-a', payload, (error) =>
      error ? swapped.reject(error) : swapped.resolve(),
    );
    await expect(swapped.promise).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (
        await fixture.pool.query('select count(*)::int as count from sessions where store_id=$1', [
          id,
        ])
      ).rows[0].count,
    ).toBe(0);
  }, 30_000);

  it('limits registration attempts without trusting forwarded client addresses', async () => {
    const client = new Client(fixture.address);
    await client.session();
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await client.request('/api/v1/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `192.0.2.${attempt + 1}`,
        },
        body: JSON.stringify({ username: 'x', password: 'correct horse battery staple' }),
      });
      expect(response.status).toBe(attempt < 10 ? 400 : 429);
      if (attempt === 10) expect((await response.json()).error.code).toBe('RATE_LIMITED');
    }
  });

  it('marks cookies Secure for the HTTPS public origin behind a trusted proxy', async () => {
    await fixture.close();
    fixture = await createFixture({
      PUBLIC_ORIGIN: 'https://collections.example',
      TRUST_PROXY: '127.0.0.1',
    });
    const response = await fetch(fixture.address + '/api/v1/auth/session', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(';')).toMatch(/;\s*Secure/i);
  });
});
