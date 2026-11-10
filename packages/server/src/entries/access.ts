import { hasPermission, type User } from '@hcl/contracts';
import { and, eq, isNull, or, type SQL, sql } from 'drizzle-orm';
import { entries, entryAttachments, follows } from '../db/schema.js';

// Match String.trim() so whitespace-only text never preserves an otherwise empty card.
const whitespace =
  '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
/** Visibility is separate from staff capabilities and moderation state. */
export function visibleEntries(user: User | null): SQL {
  const publicEntry = eq(entries.visibility, 'public');
  if (!user) return and(isNull(entries.deletedAt), publicEntry)!;
  if (hasPermission(user, 'content.restricted')) return isNull(entries.deletedAt);
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

/** Apply before counts/pagination: a title alone does not constitute entry substance. */
export function unhiddenEntries(): SQL {
  return sql`not coalesce((${entries.moderation}->>'hidden')::boolean, false) and (
    (not coalesce((${entries.moderation}->>'bodyHidden')::boolean, false) and length(btrim(${entries.body}, ${whitespace})) > 0)
    or exists (select 1 from ${entryAttachments} where ${entryAttachments.entryId} = ${entries.id} and (
      (${entryAttachments.kind} = 'image' and not (coalesce(${entries.moderation}->'hiddenImageIds', '[]'::jsonb) ? ${entryAttachments.assetId}::text))
      or (${entryAttachments.kind} = 'file' and not (coalesce(${entries.moderation}->'hiddenFileIds', '[]'::jsonb) ? ${entryAttachments.assetId}::text))
      or (${entryAttachments.kind} = 'link' and not (coalesce(${entries.moderation}->'hiddenLinkUrls', '[]'::jsonb) ? ${entryAttachments.url}))
    ))
  )`;
}
export function publicEntries(user: User | null): SQL {
  return and(visibleEntries(user), unhiddenEntries())!;
}

export function canReviewEntry(user: User | null): boolean {
  return hasPermission(user, 'content.moderate') || hasPermission(user, 'content.delete');
}
