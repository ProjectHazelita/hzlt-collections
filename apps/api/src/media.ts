import { once } from 'node:events';
import type { ReadStream } from 'node:fs';
import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import { ErrorResponseSchema, type ImageFormat, MediaParamsSchema } from '@hcl/contracts';
import { AssetService, type Database, DomainError, type LocalStorage } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { Type } from 'typebox';

const formats: Record<ImageFormat, { mime: string; extension: string }> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
  gif: { mime: 'image/gif', extension: 'gif' },
};
function attachmentName(name: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Header values must not carry controls.
  const ascii = name.replace(/[\x00-\x1f\x7f"\\]/g, '').replace(/[^\x20-\x7e]/g, '_');
  return `filename="${ascii || 'download'}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function installMedia(
  app: FastifyInstance,
  {
    db,
    boss,
    storage,
  }: {
    db: Database;
    boss: PgBoss;
    storage: LocalStorage;
  },
): Promise<void> {
  const assets = new AssetService(db, boss, storage);
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
    });
    for (const kind of ['original', 'thumbnail', 'download'] as const) {
      routes.get(
        `/media/:assetId/${kind}`,
        {
          schema: {
            params: MediaParamsSchema,
            response: {
              200: Type.Unsafe<ReadStream>({ type: 'string', format: 'binary' }),
              '4xx': ErrorResponseSchema,
              '5xx': ErrorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const asset = await assets.published(request.params.assetId);
          if (asset.kind === 'file' && kind !== 'download')
            throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
          if (asset.kind === 'image' && kind === 'thumbnail' && !asset.thumbnailKey)
            throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
          const key = kind === 'thumbnail' ? asset.thumbnailKey : asset.originalKey;
          if (!key) throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
          const stream = storage.read(key);
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
          if (asset.kind === 'file') {
            reply.type('application/octet-stream');
            reply.header('Content-Disposition', `attachment; ${attachmentName(asset.displayName)}`);
            return reply.send(stream);
          }
          const format = formats[asset.format];
          reply.type(kind === 'thumbnail' ? 'image/webp' : format.mime);
          const extension = kind === 'thumbnail' ? 'webp' : format.extension;
          reply.header(
            'Content-Disposition',
            `${
              kind === 'download' ? 'attachment' : 'inline'
            }; filename="entry-${asset.entryId}-${asset.position}.${extension}"`,
          );
          return reply.send(stream);
        },
      );
    }
  };
  await app.register(plugin);
}
