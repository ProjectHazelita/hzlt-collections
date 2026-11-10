import { type Static, Type } from 'typebox';
import { UuidSchema } from './primitives.js';
export const SiteSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 100 }),
    description: Type.String({ maxLength: 500 }),
    logoUrl: Type.Union([Type.Null(), Type.String({ maxLength: 2048 })]),
    logoAssetId: Type.Union([UuidSchema, Type.Null()]),
    registrationOpen: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Site = Static<typeof SiteSchema>;
export const SitePatchSchema = Type.Partial(SiteSchema, { minProperties: 1 });
export type SitePatch = Static<typeof SitePatchSchema>;
export const UsernameAvailabilityQuerySchema = Type.Object(
  { username: Type.String({ maxLength: 128 }) },
  { additionalProperties: false },
);
export const UsernameAvailabilitySchema = Type.Object(
  { available: Type.Boolean() },
  { additionalProperties: false },
);
