import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import {
  EntryModerationInputSchema,
  EntryParamsSchema,
  EntryReviewSchema,
  ErrorResponseSchema,
  UnsafeRequestHeadersSchema,
} from '@hcl/contracts';
import { type Database, DomainError, EntryService, type LocalStorage } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { Type } from 'typebox';

export async function moderationRoutes(
  app: FastifyInstance,
  { db, boss }: { db: Database; boss: PgBoss; storage?: LocalStorage },
): Promise<void> {
  const entries = new EntryService(db, boss);
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.get(
      '/api/v1/admin/entries/:id',
      {
        schema: { params: EntryParamsSchema, response: { 200: EntryReviewSchema, ...errors } },
      },
      async (request) => entries.review(request.params.id, request.requireUser()),
    );
    routes.patch(
      '/api/v1/admin/entries/:id/moderation',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          body: EntryModerationInputSchema,
          response: { 200: EntryReviewSchema, ...errors },
        },
      },
      async (request) => entries.moderate(request.params.id, request.body, request.requireUser()),
    );
    routes.delete(
      '/api/v1/admin/entries/:id',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          body: Type.Object(
            { reason: Type.String({ minLength: 1, maxLength: 2000 }) },
            { additionalProperties: false },
          ),
          response: { 204: Type.Null(), ...errors },
        },
      },
      async (request, reply) => {
        const reason = request.body.reason.trim();
        if (!reason) throw new DomainError(400, 'VALIDATION_ERROR', '请填写管理原因。');
        await entries.delete(request.params.id, request.requireUser(), reason);
        return reply.code(204).send(null);
      },
    );
  };
  await app.register(plugin);
}
