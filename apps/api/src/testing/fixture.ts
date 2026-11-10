import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDatabase,
  createQueue,
  initializeQueues,
  LocalStorage,
  loadConfig,
  migrate,
  sql,
} from '@hcl/server';
import { buildApp } from '../app.js';

export async function createFixture(environment: Record<string, string> = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || new URL(databaseUrl).pathname !== '/hcl_test') {
    throw new Error('Integration runner requires the dedicated hcl_test database');
  }
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'hcl-integration-'));
  const config = loadConfig(root, {
    ...process.env,
    PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    ...environment,
    DATABASE_URL: databaseUrl,
    DATA_DIR: directory,
  });
  const { db, pool } = createDatabase(databaseUrl);
  const actual = await pool.query<{ name: string }>('select current_database() as name');
  if (actual.rows[0]?.name !== 'hcl_test') throw new Error('Refusing non-test database');
  await migrate(db, { migrationsFolder: join(root, 'packages/server/drizzle') });
  const boss = await createQueue(databaseUrl, true);
  await initializeQueues(boss);
  const storage = new LocalStorage(directory);
  await storage.initialize();
  const app = await buildApp({ db, boss, storage, config });
  let releaseLateSave: () => void = () => {};
  let lateStarted: () => void = () => {};
  let gate = Promise.resolve();
  let started = Promise.resolve();
  app.post('/test/late-save', async (request) => {
    request.requireUser();
    lateStarted();
    await gate;
    await request.session.save();
    return { saved: true };
  });
  app.get('/test/private', (request) => request.requireUser());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    db,
    pool,
    boss,
    storage,
    config,
    address,
    lateSave() {
      const released = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      gate = released.promise;
      releaseLateSave = released.resolve;
      started = entered.promise;
      lateStarted = entered.resolve;
      return { started, release: () => releaseLateSave() };
    },
    async reset() {
      await db.execute(
        sql`truncate table audit_records, staff_grants, comments, entry_attachments, entry_tags, likes, entries, assets, tags, idempotency_keys, sessions, users restart identity cascade`,
      );
      await db.execute(sql`insert into site_settings (id) values (1)`);
      await db.execute(sql`insert into staff_grants (id) values (1)`);
    },
    async close() {
      releaseLateSave();
      await app.close();
      await boss.stop();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export class Client {
  cookie = '';
  csrfToken = '';
  constructor(
    readonly base: string,
    readonly origin = 'http://127.0.0.1:5173',
  ) {}
  async request(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    if (options.method && !['GET', 'HEAD'].includes(options.method)) {
      if (!headers.has('origin')) headers.set('origin', this.origin);
      if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', this.csrfToken);
    }
    const response = await fetch(this.base + path, { ...options, headers });
    const cookies = response.headers.getSetCookie();
    const cookie = cookies.find((value) => value.startsWith('hzlt.sid='));
    if (cookie) this.cookie = cookie.split(';', 1)[0]!;
    return response;
  }
  async session() {
    const response = await this.request('/api/v1/auth/session');
    if (!response.ok) throw new Error('Session bootstrap failed: ' + response.status);
    const data = await response.json();
    this.csrfToken = data.csrfToken;
    return { response, data };
  }
  async auth(username: string, action: 'register' | 'login' = 'register') {
    await this.session();
    const response = await this.request('/api/v1/auth/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'correct horse battery staple' }),
    });
    const data = await response.json();
    if (response.ok) this.csrfToken = data.csrfToken;
    return { response, data };
  }
}
