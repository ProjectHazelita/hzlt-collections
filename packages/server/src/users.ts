import type { User } from '@hcl/contracts';
import { users } from './db/schema.js';

export const publicUserColumns = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  bio: users.bio,
  role: users.role,
  avatarAssetId: users.avatarAssetId,
};

export type PublicUserRow = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  role: 'owner' | 'member';
  avatarAssetId: string | null;
};

export function toPublicUser(row: PublicUserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    bio: row.bio,
    role: row.role,
    avatarUrl: row.avatarAssetId ? `/media/${row.avatarAssetId}/avatar` : null,
  };
}
