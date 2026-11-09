import swagger from '@fastify/swagger';
import { HealthResponseSchema, UploadRequestBodyDocumentation } from '@hcl/contracts';
import {
  type Config,
  type createQueue,
  type Database,
  DomainError,
  type LocalStorage,
  sql,
} from '@hcl/server';
import Fastify from 'fastify';
import { installAuth } from './auth.js';
import { installComments } from './comments.js';
import { installEntries } from './entries.js';
import { installErrors } from './errors.js';
import { installMedia } from './media.js';
import { installUploads } from './uploads.js';
import { installWeb } from './web.js';

export async function buildApp(
  {
    db,
    boss,
    storage,
    config,
    serveWeb = false,
  }: {
    db: Database;
    boss: Awaited<ReturnType<typeof createQueue>>;
    storage: LocalStorage;
    config: Config;
    serveWeb?: boolean;
  },
  webOptions?: { root: string },
) {
  const app = Fastify({
    logger: { redact: ['req.headers.cookie', 'req.headers.x-csrf-token', 'req.body.password'] },
    trustProxy: config.trustProxy,
    bodyLimit: 65536,
    // Fastify's default AJV compiler already installs ajv-formats.
    ajv: { customOptions: { removeAdditional: false } },
  });
  installErrors(app);
  await app.register(swagger, {
    openapi: {
      info: { title: 'hzlt!Collections API', version: '0.1.0-dev.0' },
      servers: [{ url: config.publicOrigin }],
    },
  });
  await installAuth(app, { db, config, boss });
  await installEntries(app, { db, boss });
  await installComments(app, { db });
  await installUploads(app, { db, boss, storage, config });
  await installMedia(app, { db, boss, storage });
  app.get('/api/v1/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => {
    await db.execute(sql`select 1`);
    if (!(await boss.getQueue('asset-process')))
      throw new DomainError(503, 'INTERNAL_ERROR', 'Service unavailable.');
    return { status: 'ok' };
  });
  app.get('/api/v1/openapi.json', async () => {
    const document = app.swagger();
    if (!('openapi' in document))
      throw new Error('OpenAPI generation returned an unsupported document');
    const operation = document.paths?.['/api/v1/uploads']?.post;
    if (operation) operation.requestBody = UploadRequestBodyDocumentation;
    return document;
  });
  if (serveWeb) await installWeb(app, webOptions?.root);
  return app;
}
