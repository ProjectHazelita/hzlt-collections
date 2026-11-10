import {
  hasPermission,
  type ManagedUser,
  PERMISSIONS,
  type Permission,
  type PermissionGrants,
  type ProfileField,
  type User,
} from '@hcl/contracts';
import { and, desc, eq, gt, ilike, lt, or, sql } from 'drizzle-orm';
import { auditRecords, sessions, staffGrants, users } from './db/schema.js';
import { DomainError } from './errors.js';
import type { Transaction } from './idempotency.js';
import type { Database } from './index.js';
import { publicUserColumns, toPublicUser } from './users.js';

type Db = Database | Transaction;
export function requirePermission(user: User | null, permission: Permission): User {
  if (!user) throw new DomainError(401, 'AUTH_REQUIRED', '请先登录。');
  if (!hasPermission(user, permission))
    throw new DomainError(403, 'FORBIDDEN', '没有执行此操作的权限。');
  return user;
}
export async function freshUser(db: Db, id: string): Promise<User> {
  const [row] = await db
    .select({ ...publicUserColumns, banned: users.banned })
    .from(users)
    .where(eq(users.id, id));
  if (!row || row.banned) throw new DomainError(401, 'SESSION_EXPIRED', '登录状态已失效。');
  return toPublicUser(row);
}
export async function writeAudit(
  db: Db,
  record: { actorId: string; action: string; targetType: string; targetId: string; reason: string },
): Promise<void> {
  await db.insert(auditRecords).values({ ...record, reason: record.reason.trim() });
}
function owner(user: User) {
  if (user.role !== 'owner') throw new DomainError(403, 'FORBIDDEN', '仅站点所有者可执行此操作。');
}
function reason(value: string) {
  if (!value.trim() || value.length > 500)
    throw new DomainError(400, 'VALIDATION_ERROR', '请填写不超过 500 字的原因。');
  return value.trim();
}
function cursorId(cursor?: string): bigint | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[1-9][0-9]{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)
    throw new DomainError(400, 'VALIDATION_ERROR', '无效的分页游标。');
  return BigInt(cursor);
}
export class StaffService {
  constructor(private readonly db: Database) {}
  private async managed(db: Db, id: string): Promise<ManagedUser> {
    const [row] = await db
      .select({ ...publicUserColumns, banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, id));
    if (!row) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
    return {
      user: toPublicUser(row),
      banned: row.banned,
      banReason: row.banReason,
      hiddenFields: row.hiddenProfileFields,
    };
  }
  async list(query: { q?: string; cursor?: string; limit?: number }, actor: User) {
    const current = await freshUser(this.db, actor.id);
    if (
      !['users.manage', 'users.ban', 'users.profile'].some((permission) =>
        hasPermission(current, permission as Permission),
      )
    )
      requirePermission(current, 'users.manage');
    if (
      query.cursor &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.cursor)
    )
      throw new DomainError(400, 'VALIDATION_ERROR', '无效的分页游标。');
    const limit = query.limit ?? 30;
    const q = query.q?.trim().replace(/[\\%_]/g, '\\$&');
    const rows = await this.db
      .select({ ...publicUserColumns, banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(
        and(
          query.cursor ? gt(users.id, query.cursor) : undefined,
          q
            ? or(
                ilike(users.username, `%${q}%`),
                and(
                  sql`not (${users.hiddenProfileFields} @> '["displayName"]'::jsonb)`,
                  ilike(users.displayName, `%${q}%`),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(users.id)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        user: toPublicUser(row),
        banned: row.banned,
        banReason: row.banReason,
        hiddenFields: row.hiddenProfileFields,
      })),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    };
  }
  async roles(
    id: string,
    input: { isAdmin: boolean; isModerator: boolean; reason: string },
    actor: User,
  ) {
    const why = reason(input.reason);
    return this.db.transaction(async (tx) => {
      owner(await freshUser(tx, actor.id));
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
      if (target.role === 'owner')
        throw new DomainError(403, 'FORBIDDEN', '站点所有者的能力不可更改。');
      await tx
        .update(users)
        .set({ isAdmin: input.isAdmin, isModerator: input.isModerator })
        .where(eq(users.id, id));
      await writeAudit(tx, {
        actorId: actor.id,
        action: `users.roles.admin.${input.isAdmin}.moderator.${input.isModerator}`,
        targetType: 'user',
        targetId: id,
        reason: why,
      });
      return this.managed(tx, id);
    });
  }
  async ban(id: string, input: { banned: boolean; reason: string }, actor: User) {
    const why = reason(input.reason);
    return this.db.transaction(async (tx) => {
      const current = requirePermission(await freshUser(tx, actor.id), 'users.ban');
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
      if (
        id === actor.id ||
        target.role === 'owner' ||
        (current.role !== 'owner' && (target.isAdmin || target.isModerator))
      )
        throw new DomainError(403, 'FORBIDDEN', '不能封禁自己、所有者或越权处理职员。');
      await tx
        .update(users)
        .set({ banned: input.banned, banReason: input.banned ? why : null })
        .where(eq(users.id, id));
      if (input.banned)
        await tx.delete(sessions).where(sql`${sessions.payload}->>'userId' = ${id}`);
      await writeAudit(tx, {
        actorId: actor.id,
        action: input.banned ? 'users.ban' : 'users.unban',
        targetType: 'user',
        targetId: id,
        reason: why,
      });
      return this.managed(tx, id);
    });
  }
  async profile(
    id: string,
    input: { field: ProfileField; hidden: boolean; reason: string },
    actor: User,
  ) {
    const why = reason(input.reason);
    return this.db.transaction(async (tx) => {
      requirePermission(await freshUser(tx, actor.id), 'users.profile');
      const [target] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!target) throw new DomainError(404, 'NOT_FOUND', '用户不存在。');
      if ((target.role === 'owner' && id !== actor.id) || (id === actor.id && !input.hidden))
        throw new DomainError(403, 'FORBIDDEN', '不能更改此资料限制。');
      const hiddenProfileFields = target.hiddenProfileFields.filter(
        (field) => field !== input.field,
      );
      if (input.hidden) hiddenProfileFields.push(input.field);
      await tx.update(users).set({ hiddenProfileFields }).where(eq(users.id, id));
      await writeAudit(tx, {
        actorId: actor.id,
        action: `users.profile.${input.field}.${input.hidden ? 'hide' : 'restore'}`,
        targetType: 'user',
        targetId: id,
        reason: why,
      });
      return this.managed(tx, id);
    });
  }
  async grants(actor: User): Promise<PermissionGrants> {
    owner(await freshUser(this.db, actor.id));
    const [row] = await this.db.select().from(staffGrants).where(eq(staffGrants.id, 1));
    if (!row) throw new Error('Staff grants migration missing');
    return { admin: row.admin, moderator: row.moderator };
  }
  async setGrants(input: PermissionGrants & { reason: string }, actor: User) {
    const why = reason(input.reason);
    for (const group of ['admin', 'moderator'] as const) {
      const allowed = PERMISSIONS.filter((p) => p.group === group || p.id === 'audit.read').map(
        (p) => p.id,
      );
      if (
        input[group].some((p) => !allowed.includes(p)) ||
        new Set(input[group]).size !== input[group].length
      )
        throw new DomainError(400, 'VALIDATION_ERROR', '权限不属于对应职务范围。');
    }
    return this.db.transaction(async (tx) => {
      owner(await freshUser(tx, actor.id));
      await tx
        .update(staffGrants)
        .set({ admin: input.admin, moderator: input.moderator })
        .where(eq(staffGrants.id, 1));
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'permissions.update',
        targetType: 'site',
        targetId: '1',
        reason: why,
      });
      return { admin: input.admin, moderator: input.moderator };
    });
  }
  async audit(query: { cursor?: string; limit?: number }, actor: User) {
    requirePermission(await freshUser(this.db, actor.id), 'audit.read');
    const cursor = cursorId(query.cursor);
    const limit = query.limit ?? 30;
    const rows = await this.db
      .select()
      .from(auditRecords)
      .where(cursor ? lt(auditRecords.id, cursor) : undefined)
      .orderBy(desc(auditRecords.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        ...row,
        id: String(row.id),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null,
    };
  }
}
