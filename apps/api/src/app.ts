import Fastify from 'fastify';
import { HealthResponseSchema } from '@hcl/contracts';
import { DomainError, sql, type Config, type Database, type createQueue, type LocalStorage } from '@hcl/server';
import { installAuth } from './auth.js';
import { installErrors } from './errors.js';

export async function buildApp({ db, boss, storage, config, serveWeb = false }: {
  db: Database;
  boss: Awaited<ReturnType<typeof createQueue>>;
  storage: LocalStorage;
  config: Config;
  serveWeb?: boolean;
}) {
  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.x-csrf-token', 'req.body.password'] },
    trustProxy: config.trustProxy,
    bodyLimit: 65536,
    // Fastify's default AJV compiler already installs ajv-formats.
    ajv: { customOptions: { removeAdditional: false } },
  });
  installErrors(app);
  await installAuth(app, { db, config });
  app.get('/api/v1/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => {
    await db.execute(sql`select 1`);
    if (!await boss.getQueue('asset-process')) throw new DomainError(503, 'INTERNAL_ERROR', 'Service unavailable.');
    return { status: 'ok' };
  });
  return app;
}
