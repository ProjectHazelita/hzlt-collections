import { type Static, Type } from 'typebox';

/** IDs remain strings across the HTTP boundary, including values beyond JS safe integers. */
export const ENTRY_ID_MAX = '9223372036854775807';
export const EntryIdSchema = Type.String({
  pattern: '^[1-9][0-9]{0,18}$',
  description:
    'Canonical positive decimal bigint; the server also enforces <= 9223372036854775807.',
});
export type EntryId = Static<typeof EntryIdSchema>;

export const UuidSchema = Type.String({ format: 'uuid' });
export type Uuid = Static<typeof UuidSchema>;
export const TimestampSchema = Type.String({ format: 'date-time' });
export type Timestamp = Static<typeof TimestampSchema>;

export const UserRoleSchema = Type.Union([Type.Literal('owner'), Type.Literal('member')]);
export type UserRole = Static<typeof UserRoleSchema>;
export const UserSchema = Type.Object(
  {
    id: UuidSchema,
    username: Type.String(),
    role: UserRoleSchema,
  },
  { additionalProperties: false },
);
export type User = Static<typeof UserSchema>;

export const EntryParamsSchema = Type.Object(
  { id: EntryIdSchema },
  { additionalProperties: false },
);
export type EntryParams = Static<typeof EntryParamsSchema>;
export const UploadParamsSchema = Type.Object({ id: UuidSchema }, { additionalProperties: false });
export type UploadParams = Static<typeof UploadParamsSchema>;
export const MediaParamsSchema = Type.Object(
  { assetId: UuidSchema },
  { additionalProperties: false },
);
export type MediaParams = Static<typeof MediaParamsSchema>;

/** Standard HTTP headers must remain permitted; JSON input objects are closed instead. */
export const UnsafeRequestHeadersSchema = Type.Object(
  {
    origin: Type.String({ format: 'uri' }),
    'x-csrf-token': Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);
export type UnsafeRequestHeaders = Static<typeof UnsafeRequestHeadersSchema>;
export const IdempotentRequestHeadersSchema = Type.Object(
  {
    origin: Type.String({ format: 'uri' }),
    'x-csrf-token': Type.String({ minLength: 1 }),
    'idempotency-key': UuidSchema,
  },
  { additionalProperties: true },
);
export type IdempotentRequestHeaders = Static<typeof IdempotentRequestHeadersSchema>;

export const HealthResponseSchema = Type.Object(
  { status: Type.Literal('ok') },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;
