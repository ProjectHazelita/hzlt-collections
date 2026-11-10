import { PERMISSIONS, type Permission, type ProfileField, type User } from '@hcl/contracts';
import { sql } from 'drizzle-orm';
import { staffGrants, users } from './db/schema.js';

export const effectivePermissionsColumn = sql<
  Permission[]
>`coalesce((select array_agg(distinct grant_id) from ${staffGrants}, jsonb_array_elements_text((case when ${users.isAdmin} then ${staffGrants.admin} else '[]'::jsonb end) || (case when ${users.isModerator} then ${staffGrants.moderator} else '[]'::jsonb end)) as grants(grant_id) where ${staffGrants.id} = 1), array[]::text[])`;
export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  role: users.role,
  avatarAssetId: users.avatarAssetId,
  isAdmin: users.isAdmin,
  isModerator: users.isModerator,
  permissions: effectivePermissionsColumn,
  hiddenProfileFields: users.hiddenProfileFields,
};
export type PublicUserRow = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  role: 'owner' | 'member';
  avatarAssetId: string | null;
  isAdmin: boolean;
  isModerator: boolean;
  permissions?: Permission[];
  hiddenProfileFields: ProfileField[];
};
export function toPublicUser(row: PublicUserRow): User {
  const hidden = row.hiddenProfileFields;
  return {
    id: row.id,
    username: row.username,
    displayName: hidden.includes('displayName') ? row.username : row.displayName,
    bio: hidden.includes('bio') ? '' : row.bio,
    role: row.role,
    isAdmin: row.role === 'owner' || row.isAdmin,
    isModerator: row.role === 'owner' || row.isModerator,
    permissions: row.role === 'owner' ? PERMISSIONS.map(({ id }) => id) : (row.permissions ?? []),
    avatarUrl:
      row.avatarAssetId && !hidden.includes('avatar') ? `/media/${row.avatarAssetId}/avatar` : null,
  };
}
