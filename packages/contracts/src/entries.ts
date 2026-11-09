import { type Static, Type } from 'typebox';
import { EntryIdSchema, TimestampSchema, UserSchema, UuidSchema } from './primitives.js';

export const MAX_ENTRY_IMAGES = 20;
export const MAX_ENTRY_FILES = 5;
export const MAX_ENTRY_LINKS = 5;

export const ImageFormatSchema = Type.Union([
  Type.Literal('jpeg'),
  Type.Literal('png'),
  Type.Literal('webp'),
  Type.Literal('gif'),
]);
export type ImageFormat = Static<typeof ImageFormatSchema>;

export const ImageAssetSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ maxLength: 255 }),
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
export type ImageAsset = Static<typeof ImageAssetSchema>;

export const FileAssetSchema = Type.Object(
  {
    id: UuidSchema,
    name: Type.String({ maxLength: 255 }),
    bytes: Type.Integer({ minimum: 1 }),
    extension: Type.String({ maxLength: 16 }),
    downloadUrl: Type.String({ pattern: '^/media/[^/]+/download$' }),
  },
  { additionalProperties: false },
);
export type FileAsset = Static<typeof FileAssetSchema>;

export const EntryLinkSchema = Type.Object(
  {
    url: Type.String({ maxLength: 2048 }),
    host: Type.String({ maxLength: 255 }),
  },
  { additionalProperties: false },
);
export type EntryLink = Static<typeof EntryLinkSchema>;

export const EntryLinkInputSchema = Type.Object(
  {
    url: Type.String({
      maxLength: 2048,
      description: 'Absolute http(s) URL; credentials and non-web schemes are rejected.',
    }),
  },
  { additionalProperties: false },
);
export type EntryLinkInput = Static<typeof EntryLinkInputSchema>;

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
    images: Type.Array(ImageAssetSchema, { maxItems: MAX_ENTRY_IMAGES }),
    files: Type.Array(FileAssetSchema, { maxItems: MAX_ENTRY_FILES }),
    links: Type.Array(EntryLinkSchema, { maxItems: MAX_ENTRY_LINKS }),
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
const ImageIdsSchema = Type.Array(UuidSchema, {
  maxItems: MAX_ENTRY_IMAGES,
  description: 'Ready image uploads owned by the author, in display order.',
});
const FileIdsSchema = Type.Array(UuidSchema, {
  maxItems: MAX_ENTRY_FILES,
  description: 'Ready file uploads owned by the author, in display order.',
});
const LinksSchema = Type.Array(EntryLinkInputSchema, { maxItems: MAX_ENTRY_LINKS });

export const EntryInputSchema = Type.Object(
  {
    title: Type.Optional(TitleInputSchema),
    body: Type.String({
      maxLength: 10000,
      description:
        'Preserves newlines; trimmed body must be nonempty when there are no attachments.',
    }),
    imageIds: Type.Optional(ImageIdsSchema),
    fileIds: Type.Optional(FileIdsSchema),
    links: Type.Optional(LinksSchema),
    tags: TagNamesSchema,
    declarations: DeclarationsSchema,
  },
  { additionalProperties: false },
);
export type EntryInput = Static<typeof EntryInputSchema>;

/** Attachments and text omitted from a patch retain their existing values. */
export const EntryPatchSchema = Type.Object(
  {
    title: Type.Optional(TitleInputSchema),
    body: Type.Optional(Type.String({ maxLength: 10000 })),
    imageIds: Type.Optional(ImageIdsSchema),
    fileIds: Type.Optional(FileIdsSchema),
    links: Type.Optional(LinksSchema),
    tags: Type.Optional(TagNamesSchema),
    declarations: Type.Optional(DeclarationsSchema),
  },
  { additionalProperties: false, minProperties: 1 },
);
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
