import { type Static, Type } from 'typebox';
import { EntryIdSchema, TimestampSchema, UserSchema } from './primitives.js';

export const MAX_COMMENT_LENGTH = 1000;

export const CommentIdSchema = Type.String({
  pattern: '^[1-9][0-9]{0,18}$',
  description: 'Canonical positive decimal bigint for a comment.',
});
export type CommentId = Static<typeof CommentIdSchema>;

export const CommentSchema = Type.Object(
  {
    id: CommentIdSchema,
    author: UserSchema,
    body: Type.String({ maxLength: MAX_COMMENT_LENGTH }),
    /** The comment this one answers; null for a top-level comment. */
    parentId: Type.Union([Type.Null(), CommentIdSchema]),
    /** Display name of the parent comment author, for the single-level reply label. */
    replyTo: Type.Union([Type.Null(), UserSchema]),
    createdAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type Comment = Static<typeof CommentSchema>;

export const CommentThreadSchema = Type.Object(
  {
    comment: CommentSchema,
    /** Every descendant, flattened in conversation order; never nested again in the UI. */
    replies: Type.Array(CommentSchema),
  },
  { additionalProperties: false },
);
export type CommentThread = Static<typeof CommentThreadSchema>;

export const CommentListSchema = Type.Object(
  {
    items: Type.Array(CommentThreadSchema),
    total: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CommentList = Static<typeof CommentListSchema>;

export const CommentInputSchema = Type.Object(
  {
    body: Type.String({
      maxLength: MAX_COMMENT_LENGTH,
      description: 'Trimmed text, 1–1000 characters; newlines are preserved.',
    }),
    parentId: Type.Optional(Type.Union([Type.Null(), CommentIdSchema])),
  },
  { additionalProperties: false },
);
export type CommentInput = Static<typeof CommentInputSchema>;

export const EntryCommentsParamsSchema = Type.Object(
  { id: EntryIdSchema },
  { additionalProperties: false },
);
export type EntryCommentsParams = Static<typeof EntryCommentsParamsSchema>;
