import { type Profile, type ProfileInput, ProfileInputSchema, type User } from '@hcl/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import { assets, entryAttachments, siteSettings, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import type { Transaction } from '../idempotency.js';
import type { Database } from '../index.js';
import { webUrl } from '../urls.js';
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

  async get(id: string): Promise<Profile> {
    const [row] = await this.db
      .select({
        displayName: users.displayName,
        avatarAssetId: users.avatarAssetId,
        bio: users.bio,
        email: users.email,
        pronouns: users.pronouns,
        location: users.location,
        socialLinks: users.socialLinks,
        showEmail: users.showEmail,
        showLocation: users.showLocation,
        showSocialLinks: users.showSocialLinks,
        showFollowing: users.showFollowing,
        showFollowers: users.showFollowers,
        hiddenFields: users.hiddenProfileFields,
      })
      .from(users)
      .where(eq(users.id, id));
    if (!row) throw new DomainError(404, 'NOT_FOUND', '账号不存在。');
    return row;
  }

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
    const [logo] = await tx
      .select({ id: siteSettings.id })
      .from(siteSettings)
      .where(eq(siteSettings.logoAssetId, id))
      .limit(1);
    if (logo) return;
    await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, id));
    const jobId = await this.boss.send(
      'asset-delete',
      { assetId: id },
      { db: fromDrizzle(tx, sql) },
    );
    if (!jobId) throw new Error('Avatar deletion enqueue returned no job');
  }

  async update(id: string, input: ProfileInput): Promise<User> {
    if (!Value.Check(ProfileInputSchema, input))
      throw new DomainError(400, 'VALIDATION_ERROR', '个人资料无效。');
    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email))
      throw new DomainError(400, 'VALIDATION_ERROR', '电子邮箱格式无效。', {
        email: '请输入有效邮箱。',
      });
    const { displayName: _displayName, avatarAssetId: _avatar, ...fields } = input;
    if (fields.socialLinks)
      fields.socialLinks = fields.socialLinks.map((link) => ({
        label: link.label.trim(),
        url: webUrl(link.url),
      }));
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
          const [logo] = await tx
            .select({ id: siteSettings.id })
            .from(siteSettings)
            .where(eq(siteSettings.logoAssetId, assetId))
            .limit(1);
          if (logo) throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该图片已作为站点 Logo。');
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
        .set({ ...fields, displayName, avatarAssetId })
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
