import type { User, UserProfile } from '@hcl/contracts';
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { normalizeUsername } from '../auth/service.js';
import { follows, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import type { Database } from '../index.js';
import { effectivePermissionsColumn, publicUserColumns, toPublicUser } from '../users.js';

export class UserService {
  constructor(private readonly db: Database) {}
  async find(username: string) {
    const { usernameKey } = normalizeUsername(username);
    const [row] = await this.db
      .select({ ...getTableColumns(users), permissions: effectivePermissionsColumn })
      .from(users)
      .where(eq(users.usernameKey, usernameKey));
    if (!row) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
    return row;
  }
  private async counts(id: string, viewer: User | null) {
    const [row] = await this.db
      .select({
        followingCount: sql<number>`(select count(*)::integer from ${follows} where ${follows.followerId} = ${id})`,
        followerCount: sql<number>`(select count(*)::integer from ${follows} where ${follows.followedId} = ${id})`,
        followingByMe: viewer
          ? sql<boolean>`exists (select 1 from ${follows} where ${follows.followerId} = ${viewer.id} and ${follows.followedId} = ${id})`
          : sql<boolean>`false`,
      })
      .from(users)
      .where(eq(users.id, id));
    if (!row) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
    return row;
  }
  async get(username: string, viewer: User | null): Promise<UserProfile> {
    const row = await this.find(username);
    const self = row.id === viewer?.id;
    return {
      user: toPublicUser(row),
      pronouns: row.hiddenProfileFields.includes('pronouns') ? 'not specified' : row.pronouns,
      email:
        !row.hiddenProfileFields.includes('email') && (self || row.showEmail) ? row.email : null,
      location:
        !row.hiddenProfileFields.includes('location') && (self || row.showLocation)
          ? row.location
          : null,
      socialLinks:
        !row.hiddenProfileFields.includes('socialLinks') && (self || row.showSocialLinks)
          ? row.socialLinks
          : [],
      showFollowing: row.showFollowing,
      showFollowers: row.showFollowers,
      ...(await this.counts(row.id, viewer)),
    };
  }
  async list(username: string, kind: 'following' | 'followers', viewer: User | null) {
    const row = await this.find(username);
    if (row.id !== viewer?.id && !(kind === 'following' ? row.showFollowing : row.showFollowers))
      throw new DomainError(403, 'FORBIDDEN', '该列表未公开。');
    const following = kind === 'following';
    const rows = await this.db
      .select(publicUserColumns)
      .from(follows)
      .innerJoin(users, eq(users.id, following ? follows.followedId : follows.followerId))
      .where(eq(following ? follows.followerId : follows.followedId, row.id))
      .orderBy(desc(follows.createdAt), users.id);
    return { items: rows.map(toPublicUser) };
  }
  async follow(username: string, viewer: User, following: boolean) {
    const row = await this.find(username);
    if (row.id === viewer.id) throw new DomainError(400, 'VALIDATION_ERROR', '不能关注自己。');
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${'hcl:follow:' + viewer.id + ':' + row.id}))`,
      );
      if (following)
        await tx
          .insert(follows)
          .values({ followerId: viewer.id, followedId: row.id })
          .onConflictDoNothing();
      else
        await tx
          .delete(follows)
          .where(and(eq(follows.followerId, viewer.id), eq(follows.followedId, row.id)));
    });
    return this.counts(row.id, viewer);
  }
}
