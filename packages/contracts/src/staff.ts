import { type Static, Type } from 'typebox';
import { PermissionSchema, ProfileFieldSchema } from './permissions.js';
import { TimestampSchema, UserSchema, UuidSchema } from './primitives.js';

export * from './permissions.js';

export const ManagedUserSchema = Type.Object(
  {
    user: UserSchema,
    banned: Type.Boolean(),
    banReason: Type.Union([Type.String(), Type.Null()]),
    hiddenFields: Type.Array(ProfileFieldSchema),
  },
  { additionalProperties: false },
);
export type ManagedUser = Static<typeof ManagedUserSchema>;
export const StaffPageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 128 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  },
  { additionalProperties: false },
);
export const StaffUsersQuerySchema = Type.Object(
  { ...StaffPageQuerySchema.properties, q: Type.Optional(Type.String({ maxLength: 100 })) },
  { additionalProperties: false },
);
export const ManagedUserListSchema = Type.Object(
  { items: Type.Array(ManagedUserSchema), nextCursor: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
export const UserIdParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
const reason = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
export const StaffRolesInputSchema = Type.Object(
  { isAdmin: Type.Boolean(), isModerator: Type.Boolean(), reason },
  { additionalProperties: false },
);
export const StaffBanInputSchema = Type.Object(
  { banned: Type.Boolean(), reason },
  { additionalProperties: false },
);
export const ProfileModerationInputSchema = Type.Object(
  { field: ProfileFieldSchema, hidden: Type.Boolean(), reason },
  { additionalProperties: false },
);
export const PermissionGrantsSchema = Type.Object(
  {
    admin: Type.Array(PermissionSchema, { uniqueItems: true }),
    moderator: Type.Array(PermissionSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);
export type PermissionGrants = Static<typeof PermissionGrantsSchema>;
export const PermissionGrantsInputSchema = Type.Object(
  { ...PermissionGrantsSchema.properties, reason },
  { additionalProperties: false },
);
export const AuditRecordSchema = Type.Object(
  {
    id: Type.String(),
    actorId: UuidSchema,
    action: Type.String(),
    targetType: Type.String(),
    targetId: Type.String(),
    reason: Type.String(),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type AuditRecord = Static<typeof AuditRecordSchema>;
export const AuditListSchema = Type.Object(
  { items: Type.Array(AuditRecordSchema), nextCursor: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
