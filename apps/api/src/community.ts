import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  EntriesQuerySchema,
  EntryListSchema,
  ErrorResponseSchema,
  FollowResponseSchema,
  SitePatchSchema,
  SiteSchema,
  UnsafeRequestHeadersSchema,
  UserListSchema,
  UsernameParamsSchema,
  UserProfileSchema,
} from '@hcl/contracts';
import { type Database, EntryService, SiteService, UserService } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
export async function installCommunity(
  app: FastifyInstance,
  { db, boss }: { db: Database; boss: PgBoss },
) {
  const site = new SiteService(db, boss);
  const users = new UserService(db);
  const entries = new EntryService(db, boss);
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  await app.register(async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.get('/api/v1/site', { schema: { response: { 200: SiteSchema, ...errors } } }, async () =>
      site.get(),
    );
    routes.patch(
      '/api/v1/site',
      {
        schema: {
          headers: UnsafeRequestHeadersSchema,
          body: SitePatchSchema,
          response: { 200: SiteSchema, ...errors },
        },
      },
      async (request) => site.update(request.body, request.requireUser()),
    );
    routes.get(
      '/api/v1/users/:username',
      { schema: { params: UsernameParamsSchema, response: { 200: UserProfileSchema, ...errors } } },
      async (request) => users.get(request.params.username, request.currentUser),
    );
    routes.get(
      '/api/v1/users/:username/entries',
      {
        schema: {
          params: UsernameParamsSchema,
          querystring: EntriesQuerySchema,
          response: { 200: EntryListSchema, ...errors },
        },
      },
      async (request) => {
        const author = await users.find(request.params.username);
        return entries.list(request.query, request.currentUser, author.id);
      },
    );
    for (const kind of ['following', 'followers'] as const) {
      routes.get(
        `/api/v1/users/:username/${kind}`,
        { schema: { params: UsernameParamsSchema, response: { 200: UserListSchema, ...errors } } },
        async (request) => users.list(request.params.username, kind, request.currentUser),
      );
    }
    for (const method of ['PUT', 'DELETE'] as const) {
      routes.route({
        method,
        url: '/api/v1/users/:username/follow',
        schema: {
          params: UsernameParamsSchema,
          headers: UnsafeRequestHeadersSchema,
          response: { 200: FollowResponseSchema, ...errors },
        },
        handler: async (request) =>
          users.follow(request.params.username, request.requireUser(), method === 'PUT'),
      });
    }
  });
}
