import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import {
  ErrorResponseSchema,
  IdempotentRequestHeadersSchema,
  UploadAcceptedSchema,
  UploadParamsSchema,
  UploadStatusSchema,
} from '@hcl/contracts';
import {
  AssetService,
  type Config,
  type Database,
  DomainError,
  type LocalStorage,
} from '@hcl/server';
import { sniffImageFormat } from '@hcl/server/media';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';

const invalidMultipart = () =>
  new DomainError(
    400,
    'VALIDATION_ERROR',
    'Upload exactly one file in the file field, without other parts.',
  );
const tooLarge = () =>
  new DomainError(413, 'IMAGE_TOO_LARGE', 'The image exceeds the upload size limit.');

export async function installUploads(
  app: FastifyInstance,
  {
    db,
    boss,
    storage,
    config,
  }: {
    db: Database;
    boss: PgBoss;
    storage: LocalStorage;
    config: Config;
  },
): Promise<void> {
  const assets = new AssetService(db, boss, storage);
  const limits = {
    files: 1,
    fields: 0,
    parts: 1,
    fileSize: config.maxUploadBytes,
    fieldNameSize: 100,
    headerPairs: 100,
  };
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    await scope.register(multipart, { limits, throwFileSizeLimit: false });
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    routes.post(
      '/api/v1/uploads',
      {
        // No JSON body schema: request.parts owns parsing and limits. OpenAPI's
        // requestBody is supplied separately from UploadRequestBodyDocumentation.
        schema: {
          consumes: ['multipart/form-data'],
          headers: IdempotentRequestHeadersSchema,
          response: { 202: UploadAcceptedSchema, ...errors },
        },
        onRequest: async (request) => {
          request.requireUser();
        },
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: 10,
            timeWindow: 60_000,
            keyGenerator: (request) => request.requireUser().id,
          },
        },
      },
      async (request, reply) => {
        const user = request.requireUser();
        if (!request.isMultipart()) throw invalidMultipart();
        const temporaryKey = `tmp/${randomUUID()}`;
        const abort = new AbortController();
        const disconnected = () => abort.abort(new Error('Upload disconnected'));
        request.raw.once('aborted', disconnected);
        // A hard upload deadline, independent of JSON bodyLimit and socket activity.
        const deadline = setTimeout(() => {
          abort.abort(new Error('Upload deadline exceeded'));
          request.raw.destroy();
        }, 120_000);
        deadline.unref();
        let bytes = 0;
        let headerLength = 0;
        const header = Buffer.alloc(64);
        const hash = createHash('sha256');
        let displayName = '';
        let seenFile = false;
        let invalid = false;
        let oversized = false;
        try {
          for await (const part of request.parts({ limits })) {
            if (part.type !== 'file') {
              invalid = true;
              continue;
            }
            if (seenFile || part.fieldname !== 'file') {
              invalid = true;
              // Never leave an unconsumed stream blocking the multipart iterator.
              for await (const _chunk of part.file) {
                /* discard rejected part */
              }
              continue;
            }
            seenFile = true;
            displayName = part.filename;
            const inspect = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > config.maxUploadBytes) {
                  callback(tooLarge());
                  return;
                }
                hash.update(chunk);
                const count = Math.min(header.length - headerLength, chunk.length);
                if (count > 0) {
                  chunk.copy(header, headerLength, 0, count);
                  headerLength += count;
                }
                callback(null, chunk);
              },
            });
            await pipeline(part.file, inspect, await storage.create(temporaryKey), {
              signal: abort.signal,
            });
            if (part.file.truncated) oversized = true;
          }
          // Only act after the complete multipart iterator has accepted the terminator
          // and rejected extra parts; file-stream completion alone is not acceptance.
          if (abort.signal.aborted || request.raw.aborted || !request.raw.complete)
            throw invalidMultipart();
          if (oversized) throw tooLarge();
          if (!seenFile || invalid) throw invalidMultipart();
          const format = sniffImageFormat(header.subarray(0, headerLength));
          if (!format)
            throw new DomainError(
              415,
              'UNSUPPORTED_IMAGE_TYPE',
              'Only static JPEG, PNG, WebP and GIF images are supported.',
            );
          const result = await assets.create({
            id: randomUUID(),
            ownerId: user.id,
            key: request.headers['idempotency-key'],
            temporaryKey,
            displayName,
            sha256: hash.digest('hex'),
            bytes,
            format,
          });
          return reply.code(202).send(result);
        } catch (error) {
          if (error instanceof DomainError) throw error;
          const code =
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
              ? error.code
              : undefined;
          if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
          if (
            abort.signal.aborted ||
            code?.startsWith('FST_') ||
            (error instanceof Error &&
              /^(Unexpected end of (form|file|multipart data)|Premature close|Multipart:)/.test(
                error.message,
              ))
          ) {
            throw invalidMultipart();
          }
          throw error;
        } finally {
          clearTimeout(deadline);
          request.raw.removeListener('aborted', disconnected);
          await storage.remove(temporaryKey);
        }
      },
    );
    routes.get(
      '/api/v1/uploads/:id',
      {
        schema: { params: UploadParamsSchema, response: { 200: UploadStatusSchema, ...errors } },
      },
      async (request) => {
        if (!request.currentUser) throw new DomainError(404, 'NOT_FOUND', 'Upload not found.');
        return assets.get(request.params.id, request.currentUser.id);
      },
    );
  };
  await app.register(plugin);
}
