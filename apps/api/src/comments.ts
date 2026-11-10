import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import {
  CommentInputSchema,
  CommentListSchema,
  CommentSchema,
  EntryCommentsParamsSchema,
  ErrorResponseSchema,
  UnsafeRequestHeadersSchema,
} from '@hcl/contracts';
import { CommentService, type Database } from '@hcl/server';
import type { FastifyInstance } from 'fastify';

export async function installComments(
  app: FastifyInstance,
  { db }: { db: Database },
): Promise<void> {
  const comments = new CommentService(db);
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    routes.get(
      '/api/v1/entries/:id/comments',
      {
        schema: {
          params: EntryCommentsParamsSchema,
          response: { 200: CommentListSchema, ...errors },
        },
      },
      async (request) => comments.list(request.params.id, request.currentUser),
    );

    routes.post(
      '/api/v1/entries/:id/comments',
      {
        schema: {
          params: EntryCommentsParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          body: CommentInputSchema,
          response: { 201: CommentSchema, ...errors },
        },
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: 20,
            timeWindow: 60_000,
            keyGenerator: (request) => request.requireUser().id,
          },
        },
      },
      async (request, reply) => {
        const result = await comments.create(
          request.params.id,
          request.body,
          request.requireUser(),
        );
        return reply.code(201).send(result);
      },
    );
  };
  await app.register(plugin);
}
