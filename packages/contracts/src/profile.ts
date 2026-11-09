import { type Static, Type } from 'typebox';
import { UuidSchema } from './primitives.js';

export const ProfileInputSchema = Type.Object(
  {
    displayName: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'Trimmed public nickname, 1–32 Unicode characters, no control characters. Login username is unchanged.',
      }),
    ),
    avatarAssetId: Type.Optional(
      Type.Union([UuidSchema, Type.Null()], {
        description:
          'Ready image upload owned by the user; null removes the avatar. Avatar assets cannot be attached to entries.',
      }),
    ),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type ProfileInput = Static<typeof ProfileInputSchema>;

export const PasswordChangeInputSchema = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 128 }),
    newPassword: Type.String({ minLength: 12, maxLength: 128 }),
  },
  { additionalProperties: false },
);
export type PasswordChangeInput = Static<typeof PasswordChangeInputSchema>;
