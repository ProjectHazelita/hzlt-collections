import { type Static, Type } from 'typebox';
import { CursorSchema } from './entries.js';
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

export const UserCommentSchema = Type.Object(
  {
    comment: CommentSchema,
    entry: Type.Object(
      { id: EntryIdSchema, title: Type.Union([Type.Null(), Type.String()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type UserComment = Static<typeof UserCommentSchema>;

export const UserCommentListSchema = Type.Object(
  {
    items: Type.Array(UserCommentSchema),
    nextCursor: Type.Union([CursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type UserCommentList = Static<typeof UserCommentListSchema>;

export const UserCommentsCursorSchema = Type.Object(
  { kind: Type.Literal('user-comments'), at: TimestampSchema, id: CommentIdSchema },
  { additionalProperties: false },
);
export type UserCommentsCursor = Static<typeof UserCommentsCursorSchema>;

export const EntryCommentParamsSchema = Type.Object(
  { id: EntryIdSchema, commentId: CommentIdSchema },
  { additionalProperties: false },
);
export type EntryCommentParams = Static<typeof EntryCommentParamsSchema>;
