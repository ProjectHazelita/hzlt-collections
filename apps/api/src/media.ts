import { once } from 'node:events';
import type { ReadStream } from 'node:fs';
import { Type } from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncTypebox, TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { PgBoss } from 'pg-boss';
import { ErrorResponseSchema, MediaParamsSchema, type ImageFormat } from '@hcl/contracts';
import { AssetService, DomainError, type Database, type LocalStorage } from '@hcl/server';

const formats: Record<ImageFormat, { mime: string; extension: string }> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
  gif: { mime: 'image/gif', extension: 'gif' },
};

export async function installMedia(app: FastifyInstance, { db, boss, storage }: {
  db: Database; boss: PgBoss; storage: LocalStorage;
}): Promise<void> {
  const assets = new AssetService(db, boss, storage);
  const plugin: FastifyPluginAsyncTypebox = async scope => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
    });
    for (const kind of ['original', 'thumbnail', 'download'] as const) {
      routes.get(`/media/:assetId/${kind}`, {
        schema: { params: MediaParamsSchema, response: { 200: Type.Unsafe<ReadStream>({ type: 'string', format: 'binary' }), '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema } },
      }, async (request, reply) => {
        const asset = await assets.published(request.params.assetId);
        const format = formats[asset.format];
        const stream = storage.read(kind === 'thumbnail' ? asset.thumbnailKey : asset.originalKey);
        try {
          // Open before sending headers: a missing file is a normal 404, not a broken 200 stream.
          await once(stream, 'open');
        } catch (error) {
          stream.destroy();
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
          }
          throw error;
        }
        reply.type(kind === 'thumbnail' ? 'image/webp' : format.mime);
        const extension = kind === 'thumbnail' ? 'webp' : format.extension;
        reply.header('Content-Disposition', `${kind === 'download' ? 'attachment' : 'inline'}; filename="entry-${asset.entryId}.${extension}"`);
        return reply.send(stream);
      });
    }
  };
  await app.register(plugin);
}
