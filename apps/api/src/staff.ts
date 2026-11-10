import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  AuditListSchema,
  ErrorResponseSchema,
  ManagedUserListSchema,
  ManagedUserSchema,
  PermissionGrantsInputSchema,
  PermissionGrantsSchema,
  ProfileModerationInputSchema,
  ProfileSchema,
  StaffBanInputSchema,
  StaffPageQuerySchema,
  StaffRolesInputSchema,
  StaffUsersQuerySchema,
  UnsafeRequestHeadersSchema,
  UserIdParamsSchema,
} from '@hcl/contracts';
import { type Database, DomainError, freshUser, ProfileService, StaffService } from '@hcl/server';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
export async function installStaff(
  app: FastifyInstance,
  { db, boss }: { db: Database; boss: PgBoss },
) {
  const service = new StaffService(db);
  const profiles = new ProfileService(db, boss);
  const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
  await app.register(async (scope) => {
    const routes = scope.withTypeProvider<TypeBoxTypeProvider>();
    routes.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    routes.get(
      '/api/v1/admin/users',
      {
        schema: {
          querystring: StaffUsersQuerySchema,
          response: { 200: ManagedUserListSchema, ...errors },
        },
      },
      async (request) => service.list(request.query, request.requireUser()),
    );
    routes.patch(
      '/api/v1/admin/users/:id/roles',
      {
        schema: {
          headers: UnsafeRequestHeadersSchema,
          params: UserIdParamsSchema,
          body: StaffRolesInputSchema,
          response: { 200: ManagedUserSchema, ...errors },
        },
      },
      async (request) => service.roles(request.params.id, request.body, request.requireUser()),
    );
    routes.patch(
      '/api/v1/admin/users/:id/ban',
      {
        schema: {
          headers: UnsafeRequestHeadersSchema,
          params: UserIdParamsSchema,
          body: StaffBanInputSchema,
          response: { 200: ManagedUserSchema, ...errors },
        },
      },
      async (request) => service.ban(request.params.id, request.body, request.requireUser()),
    );
    routes.patch(
      '/api/v1/admin/users/:id/profile-moderation',
      {
        schema: {
          headers: UnsafeRequestHeadersSchema,
          params: UserIdParamsSchema,
          body: ProfileModerationInputSchema,
          response: { 200: ManagedUserSchema, ...errors },
        },
      },
      async (request) => service.profile(request.params.id, request.body, request.requireUser()),
    );
    routes.get(
      '/api/v1/admin/users/:id/profile',
      { schema: { params: UserIdParamsSchema, response: { 200: ProfileSchema, ...errors } } },
      async (request) => {
        const actor = await freshUser(db, request.requireUser().id);
        if (actor.role !== 'owner')
          throw new DomainError(403, 'FORBIDDEN', '仅站点所有者可查看原始资料。');
        return profiles.get(request.params.id);
      },
    );
    routes.get(
      '/api/v1/admin/permissions',
      { schema: { response: { 200: PermissionGrantsSchema, ...errors } } },
      async (request) => service.grants(request.requireUser()),
    );
    routes.put(
      '/api/v1/admin/permissions',
      {
        schema: {
          headers: UnsafeRequestHeadersSchema,
          body: PermissionGrantsInputSchema,
          response: { 200: PermissionGrantsSchema, ...errors },
        },
      },
      async (request) => service.setGrants(request.body, request.requireUser()),
    );
    routes.get(
      '/api/v1/admin/audit',
      {
        schema: {
          querystring: StaffPageQuerySchema,
          response: { 200: AuditListSchema, ...errors },
        },
      },
      async (request) => service.audit(request.query, request.requireUser()),
    );
  });
}
