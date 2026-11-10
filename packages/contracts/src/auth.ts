import { type Static, Type } from 'typebox';
import { UserSchema } from './primitives.js';

export const SessionSchema = Type.Object(
  {
    user: Type.Union([UserSchema, Type.Null()]),
    csrfToken: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type Session = Static<typeof SessionSchema>;

export const AuthInputSchema = Type.Object(
  {
    username: Type.String({
      description:
        'Server trims, normalizes NFKC and checks 3–32 Unicode letters/numbers, underscores or hyphens; display spelling retains the trimmed input.',
    }),
    password: Type.String({
      minLength: 12,
      maxLength: 128,
      description: 'Not trimmed or normalized.',
    }),
  },
  { additionalProperties: false },
);
export type AuthInput = Static<typeof AuthInputSchema>;
