import type { User } from '@hcl/contracts';
import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { entries, follows } from '../db/schema.js';

/** Apply in SQL, before pagination/counting, to every entry-backed read. */
export function visibleEntries(user: User | null): SQL {
  const publicEntry = eq(entries.visibility, 'public');
  if (!user) return and(isNull(entries.deletedAt), publicEntry)!;
  if (user.role === 'owner') return isNull(entries.deletedAt);
  return and(
    isNull(entries.deletedAt),
    or(
      publicEntry,
      eq(entries.authorId, user.id),
      eq(entries.visibility, 'registered'),
      and(
        eq(entries.visibility, 'followers'),
        sql`exists (select 1 from ${follows} where ${follows.followerId} = ${user.id} and ${follows.followedId} = ${entries.authorId})`,
      ),
      and(
        eq(entries.visibility, 'following'),
        sql`exists (select 1 from ${follows} where ${follows.followerId} = ${entries.authorId} and ${follows.followedId} = ${user.id})`,
      ),
    ),
  )!;
}
