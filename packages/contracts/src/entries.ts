import { type Static, Type } from 'typebox';
import { EntryIdSchema, TimestampSchema, UserSchema, UuidSchema } from './primitives.js';

export const ImageFormatSchema = Type.Union([
  Type.Literal('jpeg'),
  Type.Literal('png'),
  Type.Literal('webp'),
  Type.Literal('gif'),
]);
export type ImageFormat = Static<typeof ImageFormatSchema>;

export const AssetSchema = Type.Object(
  {
    id: UuidSchema,
    format: ImageFormatSchema,
    bytes: Type.Integer({ minimum: 1 }),
    originalWidth: Type.Integer({ minimum: 1 }),
    originalHeight: Type.Integer({ minimum: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    originalUrl: Type.String({ pattern: '^/media/[^/]+/original$' }),
    thumbnailUrl: Type.String({ pattern: '^/media/[^/]+/thumbnail$' }),
    downloadUrl: Type.String({ pattern: '^/media/[^/]+/download$' }),
  },
  { additionalProperties: false },
);
export type Asset = Static<typeof AssetSchema>;

export const DeclarationsSchema = Type.Object(
  {
    nsfw: Type.Boolean(),
    aiGenerated: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Declarations = Static<typeof DeclarationsSchema>;

/** Normalized lengths/control characters are checked by the server after trim/NFKC. */
export const TagNameSchema = Type.String({
  description:
    'Trimmed display name, 1–32 Unicode characters, no control characters; NFKC lowercase is the uniqueness key.',
});
export type TagName = Static<typeof TagNameSchema>;
export const TagNamesSchema = Type.Array(TagNameSchema, { maxItems: 10 });
export type TagNames = Static<typeof TagNamesSchema>;

export const EntrySchema = Type.Object(
  {
    id: EntryIdSchema,
    author: UserSchema,
    title: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
    body: Type.String({ maxLength: 10000 }),
    tags: TagNamesSchema,
    declarations: DeclarationsSchema,
    asset: Type.Union([AssetSchema, Type.Null()]),
    likeCount: Type.Integer({ minimum: 0 }),
    likedByMe: Type.Boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    canEdit: Type.Boolean(),
    canDelete: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type Entry = Static<typeof EntrySchema>;

const TitleInputSchema = Type.Union([
  Type.String({
    description:
      'Server trims; empty becomes null, normalized display length at most 200 characters.',
  }),
  Type.Null(),
]);

export const EntryInputSchema = Type.Object(
  {
    title: Type.Optional(TitleInputSchema),
    body: Type.String({
      maxLength: 10000,
      description: 'Preserves newlines; trimmed body must be nonempty when there is no asset.',
    }),
    assetId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
    tags: TagNamesSchema,
    declarations: DeclarationsSchema,
  },
  { additionalProperties: false },
);
export type EntryInput = Static<typeof EntryInputSchema>;

/** Asset identity is immutable after publication; omitted fields retain their values. */
export const EntryPatchSchema = Type.Partial(Type.Omit(EntryInputSchema, ['assetId']), {
  additionalProperties: false,
  minProperties: 1,
});
export type EntryPatch = Static<typeof EntryPatchSchema>;

export const LikeResponseSchema = Type.Object(
  {
    likedByMe: Type.Boolean(),
    likeCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type LikeResponse = Static<typeof LikeResponseSchema>;

export const CursorSchema = Type.String({
  pattern: '^[A-Za-z0-9_-]+$',
  description: 'Base64url JSON cursor. Server validates the decoded shape and route-specific kind.',
});
export type Cursor = Static<typeof CursorSchema>;
export const EntriesCursorSchema = Type.Object(
  {
    kind: Type.Literal('entries'),
    id: EntryIdSchema,
  },
  { additionalProperties: false },
);
export type EntriesCursor = Static<typeof EntriesCursorSchema>;
export const LikesCursorSchema = Type.Object(
  {
    kind: Type.Literal('likes'),
    at: TimestampSchema,
    id: EntryIdSchema,
  },
  { additionalProperties: false },
);
export type LikesCursor = Static<typeof LikesCursorSchema>;

export const PaginationQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 30 })),
  },
  { additionalProperties: false },
);
export type PaginationQuery = Static<typeof PaginationQuerySchema>;
export const EntriesQuerySchema = Type.Object(
  {
    ...PaginationQuerySchema.properties,
    q: Type.Optional(
      Type.String({
        description:
          'Trimmed search text, at most 100 characters; blank means no filter. Matches literal text, not SQL wildcards.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type EntriesQuery = Static<typeof EntriesQuerySchema>;

export const EntryListSchema = Type.Object(
  {
    items: Type.Array(EntrySchema),
    total: Type.Integer({ minimum: 0 }),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type EntryList = Static<typeof EntryListSchema>;

export const TagsQuerySchema = Type.Object(
  {
    q: Type.Optional(
      Type.String({ description: 'Trimmed tag suggestion search text, at most 100 characters.' }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  },
  { additionalProperties: false },
);
export type TagsQuery = Static<typeof TagsQuerySchema>;
export const TagsResponseSchema = Type.Array(TagNameSchema);
export type TagsResponse = Static<typeof TagsResponseSchema>;
