import type {
  FastifyPluginAsyncTypebox,
  TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox';
import {
  EntriesQuerySchema,
  EntryInputSchema,
  EntryListSchema,
  EntryParamsSchema,
  EntryPatchSchema,
  EntrySchema,
  ErrorResponseSchema,
  IdempotentRequestHeadersSchema,
  LikeResponseSchema,
  PaginationQuerySchema,
  TagsQuerySchema,
  TagsResponseSchema,
  UnsafeRequestHeadersSchema,
} from '@hcl/contracts';
import { type Database, DomainError, EntryService } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { Type } from 'typebox';

export async function installEntries(
  app: FastifyInstance,
  { db, boss }: { db: Database; boss: PgBoss },
): Promise<void> {
  const entries = new EntryService(db, boss);
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };

  const plugin: FastifyPluginAsyncTypebox = async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    // Entries include identity-dependent likes and permissions, even on public reads.
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    routes.get(
      '/api/v1/entries',
      {
        schema: { querystring: EntriesQuerySchema, response: { 200: EntryListSchema, ...errors } },
      },
      async (request) => entries.list(request.query, request.currentUser),
    );

    routes.get(
      '/api/v1/entries/:id',
      {
        schema: { params: EntryParamsSchema, response: { 200: EntrySchema, ...errors } },
      },
      async (request) => entries.get(request.params.id, request.currentUser),
    );

    routes.post(
      '/api/v1/entries',
      {
        schema: {
          headers: IdempotentRequestHeadersSchema,
          body: EntryInputSchema,
          response: { 201: EntrySchema, ...errors },
        },
      },
      async (request, reply) => {
        const result = await entries.create(
          request.body,
          request.requireUser(),
          request.headers['idempotency-key'],
        );
        return reply.code(201).send(result);
      },
    );

    routes.patch(
      '/api/v1/entries/:id',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          body: EntryPatchSchema,
          response: { 200: EntrySchema, ...errors },
        },
      },
      async (request) => entries.update(request.params.id, request.body, request.requireUser()),
    );

    routes.delete(
      '/api/v1/entries/:id',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          response: { 204: Type.Null(), ...errors },
        },
      },
      async (request, reply) => {
        await entries.delete(request.params.id, request.requireUser());
        return reply.code(204).send(null);
      },
    );

    routes.put(
      '/api/v1/entries/:id/like',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          response: { 200: LikeResponseSchema, ...errors },
        },
      },
      async (request) => entries.setLike(request.params.id, request.requireUser(), true),
    );

    routes.delete(
      '/api/v1/entries/:id/like',
      {
        schema: {
          params: EntryParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          response: { 200: LikeResponseSchema, ...errors },
        },
      },
      async (request) => entries.setLike(request.params.id, request.requireUser(), false),
    );

    routes.get(
      '/api/v1/me/likes',
      {
        schema: {
          querystring: PaginationQuerySchema,
          response: { 200: EntryListSchema, ...errors },
        },
      },
      async (request) => entries.listLikes(request.query, request.requireUser()),
    );

    routes.get(
      '/api/v1/tags',
      {
        schema: { querystring: TagsQuerySchema, response: { 200: TagsResponseSchema, ...errors } },
      },
      async (request) => entries.suggestTags(request.query, request.currentUser),
    );

    routes.get(
      '/api/v1/admin/entries',
      {
        schema: {
          querystring: PaginationQuerySchema,
          response: { 200: EntryListSchema, ...errors },
        },
      },
      async (request) => {
        const user = request.requireUser();
        if (user.role !== 'owner')
          throw new DomainError(403, 'FORBIDDEN', 'Only the site owner can manage all entries.');
        return entries.listAdmin(request.query, user);
      },
    );
  };

  await app.register(plugin);
}
