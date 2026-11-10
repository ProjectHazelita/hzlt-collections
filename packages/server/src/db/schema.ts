import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    usernameKey: text('username_key').notNull().unique(),
    displayName: text('display_name').notNull(),
    avatarAssetId: uuid('avatar_asset_id').references((): AnyPgColumn => assets.id),
    bio: text('bio').notNull().default(''),
    email: text('email').notNull().default(''),
    pronouns: text('pronouns')
      .$type<'they/them' | 'he/him' | 'she/her' | 'not specified'>()
      .notNull()
      .default('not specified'),
    location: text('location').notNull().default(''),
    socialLinks: jsonb('social_links')
      .$type<{ label: string; url: string }[]>()
      .notNull()
      .default([]),
    showEmail: boolean('show_email').notNull().default(false),
    showLocation: boolean('show_location').notNull().default(false),
    showSocialLinks: boolean('show_social_links').notNull().default(false),
    showFollowing: boolean('show_following').notNull().default(true),
    showFollowers: boolean('show_followers').notNull().default(true),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<'owner' | 'member'>().notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('single_owner').on(t.role).where(sql`${t.role} = 'owner'`),
    uniqueIndex('users_avatar_asset_unique').on(t.avatarAssetId),
    check('valid_role', sql`${t.role} in ('owner','member')`),
    check('valid_display_name', sql`char_length(${t.displayName}) between 1 and 32`),
  ],
);
export const sessions = pgTable(
  'sessions',
  {
    storeId: text('store_id').primaryKey(),
    generation: text('generation').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [index('session_expiry').on(t.expiresAt)],
);
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references((): AnyPgColumn => users.id),
    kind: text('kind').$type<'image' | 'file'>().notNull().default('image'),
    state: text('state').$type<'pending' | 'ready' | 'failed' | 'deleted'>().notNull(),
    originalKey: text('original_key').notNull(),
    thumbnailKey: text('thumbnail_key'),
    displayName: text('display_name').notNull(),
    sha256: text('sha256').notNull(),
    bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
    format: text('format'),
    mime: text('mime'),
    extension: text('extension'),
    originalWidth: integer('original_width'),
    originalHeight: integer('original_height'),
    width: integer('width'),
    height: integer('height'),
    jobId: uuid('job_id'),
    attemptToken: uuid('attempt_token'),
    errorCode: text('error_code'),
    createdAt: time('created_at').notNull().defaultNow(),
    readyAt: time('ready_at'),
    expiresAt: time('expires_at'),
  },
  (t) => [
    check('asset_state', sql`${t.state} in ('pending','ready','failed','deleted')`),
    check('asset_kind', sql`${t.kind} in ('image','file')`),
  ],
);
export const entries = pgTable(
  'entries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    title: text('title'),
    body: text('body').notNull(),
    visibility: text('visibility')
      .$type<'public' | 'registered' | 'followers' | 'following' | 'private'>()
      .notNull()
      .default('public'),
    nsfw: boolean('nsfw').notNull().default(false),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
    deletedAt: time('deleted_at'),
  },
  (t) => [
    check(
      'valid_visibility',
      sql`${t.visibility} in ('public','registered','followers','following','private')`,
    ),
  ],
);
export const entryAttachments = pgTable(
  'entry_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryId: bigint('entry_id', { mode: 'bigint' })
      .notNull()
      .references(() => entries.id),
    kind: text('kind').$type<'image' | 'file' | 'link'>().notNull(),
    assetId: uuid('asset_id').references(() => assets.id),
    url: text('url'),
    position: integer('position').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('entry_attachment_position').on(t.entryId, t.position),
    uniqueIndex('entry_attachment_asset').on(t.assetId),
    index('entry_attachment_entry').on(t.entryId, t.kind, t.position),
    check('attachment_kind', sql`${t.kind} in ('image','file','link')`),
    check(
      'attachment_target',
      sql`(${t.kind} in ('image','file') and ${t.assetId} is not null and ${t.url} is null)
        or (${t.kind} = 'link' and ${t.assetId} is null and ${t.url} is not null)`,
    ),
  ],
);
export const comments = pgTable(
  'comments',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    entryId: bigint('entry_id', { mode: 'bigint' })
      .notNull()
      .references(() => entries.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    parentId: bigint('parent_id', { mode: 'bigint' }),
    body: text('body').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('comments_entry').on(t.entryId, t.createdAt, t.id),
    index('comments_parent').on(t.parentId),
  ],
);
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
});
export const entryTags = pgTable(
  'entry_tags',
  {
    entryId: bigint('entry_id', { mode: 'bigint' })
      .notNull()
      .references(() => entries.id),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.tagId] })],
);
export const likes = pgTable(
  'likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    entryId: bigint('entry_id', { mode: 'bigint' })
      .notNull()
      .references(() => entries.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.entryId] }),
    index('likes_page').on(t.userId, t.createdAt, t.entryId),
  ],
);
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    operation: text('operation').notNull(),
    key: uuid('key').notNull(),
    requestHash: text('request_hash').notNull(),
    httpStatus: integer('http_status').notNull(),
    response: jsonb('response').notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.operation, t.key] })],
);

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followedId: uuid('followed_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followedId] }),
    index('follows_followed').on(t.followedId),
    check('follows_not_self', sql`${t.followerId} <> ${t.followedId}`),
  ],
);
export const siteSettings = pgTable(
  'site_settings',
  {
    id: integer('id').primaryKey().default(1),
    title: text('title').notNull().default('hzlt!Collections'),
    description: text('description').notNull().default('登录后继续发布和喜欢内容。'),
    logoUrl: text('logo_url'),
    logoAssetId: uuid('logo_asset_id').references(() => assets.id),
    registrationOpen: boolean('registration_open').notNull().default(true),
  },
  (t) => [check('site_singleton', sql`${t.id} = 1`)],
);
