import { Type } from 'typebox';
export const PERMISSIONS = [
  { id: 'site.brand', group: 'admin', label: '管理站点品牌' },
  { id: 'site.registration', group: 'admin', label: '管理公开注册' },
  { id: 'users.manage', group: 'admin', label: '查看用户管理' },
  { id: 'users.ban', group: 'admin', label: '封禁普通用户' },
  { id: 'users.profile', group: 'admin', label: '限制用户资料' },
  { id: 'content.moderate', group: 'moderator', label: '隐藏及恢复内容' },
  { id: 'content.delete', group: 'moderator', label: '永久删除内容' },
  { id: 'content.restricted', group: 'moderator', label: '查看受限内容' },
  { id: 'audit.read', group: 'admin', label: '查看审计记录' },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['id'];
export const PermissionSchema = Type.Union([
  Type.Literal('site.brand'),
  Type.Literal('site.registration'),
  Type.Literal('users.manage'),
  Type.Literal('users.ban'),
  Type.Literal('users.profile'),
  Type.Literal('content.moderate'),
  Type.Literal('content.delete'),
  Type.Literal('content.restricted'),
  Type.Literal('audit.read'),
]);
export function hasPermission(
  user: { role: 'owner' | 'member'; permissions: readonly Permission[] } | null,
  permission: Permission,
): boolean {
  return !!user && (user.role === 'owner' || user.permissions.includes(permission));
}
export const ProfileFieldSchema = Type.Union([
  Type.Literal('displayName'),
  Type.Literal('avatar'),
  Type.Literal('bio'),
  Type.Literal('pronouns'),
  Type.Literal('email'),
  Type.Literal('location'),
  Type.Literal('socialLinks'),
]);
export type ProfileField =
  | 'displayName'
  | 'avatar'
  | 'bio'
  | 'pronouns'
  | 'email'
  | 'location'
  | 'socialLinks';
