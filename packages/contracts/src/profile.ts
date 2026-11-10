import { type Static, Type } from 'typebox';
import { ProfileFieldSchema } from './permissions.js';
import { UserSchema, UuidSchema } from './primitives.js';

export const PronounsSchema = Type.Union([
  Type.Literal('they/them'),
  Type.Literal('he/him'),
  Type.Literal('she/her'),
  Type.Literal('not specified'),
]);
export type Pronouns = Static<typeof PronounsSchema>;
export const SocialLinksSchema = Type.Array(
  Type.Object(
    {
      label: Type.String({ maxLength: 50 }),
      url: Type.String({ maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 5 },
);
export type SocialLink = Static<typeof SocialLinksSchema>[number];
const profileFields = {
  bio: Type.String({ maxLength: 160 }),
  email: Type.String({ maxLength: 254 }),
  pronouns: PronounsSchema,
  location: Type.String({ maxLength: 100 }),
  socialLinks: SocialLinksSchema,
  showEmail: Type.Boolean(),
  showLocation: Type.Boolean(),
  showSocialLinks: Type.Boolean(),
  showFollowing: Type.Boolean(),
  showFollowers: Type.Boolean(),
};
export const ProfileSchema = Type.Object(
  {
    displayName: Type.String({ maxLength: 32 }),
    avatarAssetId: Type.Union([UuidSchema, Type.Null()]),
    ...profileFields,
    hiddenFields: Type.Array(ProfileFieldSchema),
  },
  { additionalProperties: false },
);
export type Profile = Static<typeof ProfileSchema>;
export const UserProfileSchema = Type.Object(
  {
    user: UserSchema,
    pronouns: PronounsSchema,
    email: Type.Union([Type.String(), Type.Null()]),
    location: Type.Union([Type.String(), Type.Null()]),
    socialLinks: SocialLinksSchema,
    followingCount: Type.Integer({ minimum: 0 }),
    followerCount: Type.Integer({ minimum: 0 }),
    followingByMe: Type.Boolean(),
    showFollowing: Type.Boolean(),
    showFollowers: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type UserProfile = Static<typeof UserProfileSchema>;
export const UserListSchema = Type.Object(
  { items: Type.Array(UserSchema) },
  { additionalProperties: false },
);
export const FollowResponseSchema = Type.Object(
  {
    followingByMe: Type.Boolean(),
    followingCount: Type.Integer({ minimum: 0 }),
    followerCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type FollowResponse = Static<typeof FollowResponseSchema>;
export const UsernameParamsSchema = Type.Object(
  { username: Type.String({ maxLength: 128 }) },
  { additionalProperties: false },
);
export const ProfileInputSchema = Type.Object(
  {
    ...Type.Partial(Type.Object(profileFields)).properties,
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
