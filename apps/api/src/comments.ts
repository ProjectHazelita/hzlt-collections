import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import {
  CommentInputSchema,
  CommentListSchema,
  CommentSchema,
  EntryCommentParamsSchema,
  EntryCommentsParamsSchema,
  ErrorResponseSchema,
  PaginationQuerySchema,
  UnsafeRequestHeadersSchema,
  UserCommentListSchema,
  UsernameParamsSchema,
} from '@hcl/contracts';
import { CommentService, type Database } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

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

    routes.get(
      '/api/v1/users/:username/comments',
      {
        schema: {
          params: UsernameParamsSchema,
          querystring: PaginationQuerySchema,
          response: { 200: UserCommentListSchema, ...errors },
        },
      },
      async (request) =>
        comments.listUser(request.params.username, request.query, request.currentUser),
    );

    routes.delete(
      '/api/v1/entries/:id/comments/:commentId',
      {
        schema: {
          params: EntryCommentParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          response: { 204: Type.Null(), ...errors },
        },
      },
      async (request, reply) => {
        await comments.delete(request.params.id, request.params.commentId, request.requireUser());
        return reply.code(204).send(null);
      },
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
