import type { ProfileInput, User } from '@hcl/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { assets, entryAttachments, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import type { Transaction } from '../idempotency.js';
import type { Database } from '../index.js';
import { publicUserColumns, toPublicUser } from '../users.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizedDisplayName(value: string): string {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 32 || /\p{Cc}/u.test(value)) {
    throw new DomainError(400, 'VALIDATION_ERROR', '昵称须为 1–32 个字符且不能含控制字符。', {
      displayName: '昵称须为 1–32 个字符且不能含控制字符。',
    });
  }
  return name;
}

export class ProfileService {
  constructor(
    private readonly db: Database,
    private readonly boss: PgBoss,
  ) {}

  private async retireAvatar(tx: Transaction, id: string) {
    const [attached] = await tx
      .select({ id: entryAttachments.id })
      .from(entryAttachments)
      .where(eq(entryAttachments.assetId, id))
      .limit(1);
    if (attached) return;
    const [used] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.avatarAssetId, id))
      .limit(1);
    if (used) return;
    await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, id));
    const jobId = await this.boss.send(
      'asset-delete',
      { assetId: id },
      { db: fromDrizzle(tx, sql) },
    );
    if (!jobId) throw new Error('Avatar deletion enqueue returned no job');
  }

  async update(id: string, input: ProfileInput): Promise<User> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!existing) throw new DomainError(404, 'NOT_FOUND', '账号不存在。');
      const displayName =
        input.displayName !== undefined
          ? normalizedDisplayName(input.displayName)
          : existing.displayName;
      let avatarAssetId = existing.avatarAssetId;
      if (input.avatarAssetId !== undefined) {
        if (input.avatarAssetId === null) avatarAssetId = null;
        else {
          const assetId = input.avatarAssetId.toLowerCase();
          if (!uuid.test(assetId)) throw new DomainError(400, 'VALIDATION_ERROR', '头像编号无效。');
          const [asset] = await tx
            .select()
            .from(assets)
            .where(and(eq(assets.id, assetId), eq(assets.ownerId, id)))
            .for('update');
          if (!asset) throw new DomainError(404, 'NOT_FOUND', '头像文件不存在。');
          if (asset.kind !== 'image' || asset.state !== 'ready')
            throw new DomainError(409, 'UPLOAD_NOT_READY', '头像尚未处理完成。');
          if (asset.expiresAt && asset.expiresAt.getTime() <= Date.now())
            throw new DomainError(409, 'UPLOAD_EXPIRED', '头像文件已过期。');
          const [attached] = await tx
            .select({ id: entryAttachments.id })
            .from(entryAttachments)
            .where(eq(entryAttachments.assetId, assetId))
            .limit(1);
          if (attached) throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该图片已被条目使用。');
          const [other] = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.avatarAssetId, assetId), ne(users.id, id)))
            .limit(1);
          if (other) throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该图片已作为他人头像。');
          avatarAssetId = assetId;
          await tx.update(assets).set({ expiresAt: null }).where(eq(assets.id, assetId));
        }
      }
      const [updated] = await tx
        .update(users)
        .set({ displayName, avatarAssetId })
        .where(eq(users.id, id))
        .returning(publicUserColumns);
      if (!updated) throw new Error('Profile update returned no row');
      if (existing.avatarAssetId && existing.avatarAssetId !== avatarAssetId) {
        await this.retireAvatar(tx, existing.avatarAssetId);
      }
      return toPublicUser(updated);
    });
  }
}
