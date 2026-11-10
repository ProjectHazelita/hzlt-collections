import { type Site, type SitePatch, SitePatchSchema, type User } from '@hcl/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import { assets, entryAttachments, siteSettings, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import type { Transaction } from '../idempotency.js';
import type { Database } from '../index.js';
import { freshUser, requirePermission, writeAudit } from '../staff.js';
import { webUrl } from '../urls.js';

export class SiteService {
  constructor(
    private readonly db: Database,
    private readonly boss: PgBoss,
  ) {}

  async get(): Promise<Site> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.id, 1));
    if (!row) throw new Error('Site settings migration missing');
    const { id: _id, ...site } = row;
    return {
      ...site,
      logoUrl: site.logoAssetId ? `/media/${site.logoAssetId}/site-logo` : site.logoUrl,
    };
  }

  private async retireLogo(tx: Transaction, id: string) {
    // Serialize with other upload associations and worker deletion.
    await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, id)).for('update');
    const [attached] = await tx
      .select({ id: entryAttachments.id })
      .from(entryAttachments)
      .where(eq(entryAttachments.assetId, id))
      .limit(1);
    const [avatar] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.avatarAssetId, id))
      .limit(1);
    const [logo] = await tx
      .select({ id: siteSettings.id })
      .from(siteSettings)
      .where(eq(siteSettings.logoAssetId, id))
      .limit(1);
    if (attached || avatar || logo) return;
    await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, id));
    const jobId = await this.boss.send(
      'asset-delete',
      { assetId: id },
      { db: fromDrizzle(tx, sql) },
    );
    if (!jobId) throw new Error('Site logo deletion enqueue returned no job');
  }

  async update(input: SitePatch, user: User): Promise<Site> {
    if (!Value.Check(SitePatchSchema, input))
      throw new DomainError(400, 'VALIDATION_ERROR', '站点设置无效。');
    const title = input.title?.trim();
    if (title !== undefined && !title)
      throw new DomainError(400, 'VALIDATION_ERROR', '站点标题不能为空。');
    if (input.logoAssetId && input.logoUrl != null)
      throw new DomainError(400, 'VALIDATION_ERROR', '不能同时选择上传 Logo 和外部地址。');
    const externalUrl = input.logoUrl == null ? input.logoUrl : webUrl(input.logoUrl);
    await this.db.transaction(async (tx) => {
      const actor = await freshUser(tx, user.id);
      if (input.registrationOpen !== undefined) requirePermission(actor, 'site.registration');
      if (Object.keys(input).some((key) => key !== 'registrationOpen'))
        requirePermission(actor, 'site.brand');
      // Share the registration lock so closure and concurrent registration have a defined order.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hcl:first-owner'))`);
      const [existing] = await tx
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.id, 1))
        .for('update');
      if (!existing) throw new Error('Site settings migration missing');
      let logoAssetId = existing.logoAssetId;
      let logoUrl = existing.logoUrl;
      if (input.logoAssetId !== undefined) logoAssetId = input.logoAssetId?.toLowerCase() ?? null;
      if (input.logoUrl !== undefined) {
        logoUrl = externalUrl ?? null;
        if (externalUrl !== null) logoAssetId = null;
      }
      if (input.logoAssetId) {
        const [asset] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, logoAssetId!), eq(assets.ownerId, user.id)))
          .for('update');
        if (!asset) throw new DomainError(404, 'NOT_FOUND', 'Logo 文件不存在。');
        if (asset.kind !== 'image' || asset.state !== 'ready' || !asset.thumbnailKey)
          throw new DomainError(409, 'UPLOAD_NOT_READY', 'Logo 尚未处理完成。');
        if (asset.expiresAt && asset.expiresAt.getTime() <= Date.now())
          throw new DomainError(409, 'UPLOAD_EXPIRED', 'Logo 文件已过期。');
        const [attached] = await tx
          .select({ id: entryAttachments.id })
          .from(entryAttachments)
          .where(eq(entryAttachments.assetId, asset.id))
          .limit(1);
        const [avatar] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.avatarAssetId, asset.id))
          .limit(1);
        if (attached || avatar)
          throw new DomainError(409, 'UPLOAD_ALREADY_USED', '该图片已被其他内容使用。');
        logoUrl = null;
        await tx.update(assets).set({ expiresAt: null }).where(eq(assets.id, asset.id));
      }
      await tx
        .update(siteSettings)
        .set({
          ...input,
          ...(title !== undefined ? { title } : {}),
          logoAssetId,
          logoUrl,
        })
        .where(eq(siteSettings.id, 1));
      if (existing.logoAssetId && existing.logoAssetId !== logoAssetId)
        await this.retireLogo(tx, existing.logoAssetId);
      await writeAudit(tx, {
        actorId: user.id,
        action: 'site.update',
        targetType: 'site',
        targetId: '1',
        reason: '站点设置更新',
      });
    });
    return this.get();
  }
}
