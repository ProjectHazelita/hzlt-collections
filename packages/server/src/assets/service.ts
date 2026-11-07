import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import {
  ImageFormatSchema, UploadAcceptedSchema, UploadStatusSchema,
  type ImageFormat, type UploadAccepted, type UploadStatus,
} from '@hcl/contracts';
import type { Database } from '../index.js';
import type { LocalStorage } from '../storage/local-storage.js';
import { assets, entries } from '../db/schema.js';
import { DomainError } from '../errors.js';
import { withIdempotency } from '../idempotency.js';

export class AssetService {
  constructor(
    private readonly db: Database,
    private readonly boss: PgBoss,
    private readonly storage: LocalStorage,
  ) {}

  async create(input: {
    id: string; ownerId: string; key: string; temporaryKey: string;
    displayName: string; sha256: string; bytes: number; format: ImageFormat;
  }): Promise<UploadAccepted> {
    const originalKey = `originals/${input.id}.bin`;
    let moved = false;
    let committed = false;
    try {
      const result = await withIdempotency<UploadAccepted>(this.db, {
        userId: input.ownerId, operation: 'upload-create', key: input.key.toLowerCase(),
        requestHash: input.sha256, statusCode: 202,
      }, (value): value is UploadAccepted => Value.Check(UploadAcceptedSchema, value), async tx => {
        // Coordinate with orphan reclamation, including a transaction stalled after rename.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'hcl:asset:' + input.id}))`);
        await this.storage.move(input.temporaryKey, originalKey);
        moved = true;
        await tx.insert(assets).values({
          id: input.id, ownerId: input.ownerId, state: 'pending', originalKey,
          displayName: input.displayName, sha256: input.sha256,
          bytes: BigInt(input.bytes), format: input.format,
        });
        const jobId = await this.boss.send('asset-process', { assetId: input.id }, { db: fromDrizzle(tx, sql) });
        if (!jobId) throw new Error('Image processing job was not created');
        await tx.update(assets).set({ jobId }).where(eq(assets.id, input.id));
        return { id: input.id, status: 'pending' };
      });
      committed = true;
      return result;
    } finally {
      // Replays never touch the committed winner: only this request's generated keys.
      if (moved && !committed) {
        // A failed COMMIT acknowledgement is not proof of rollback. Keep a referenced
        // original; if the DB is unavailable, leave it private for later reconciliation.
        const [persisted] = await this.db.select({ originalKey: assets.originalKey }).from(assets)
          .where(eq(assets.id, input.id)).limit(1);
        if (!persisted) await this.storage.remove(originalKey);
      }
      await this.storage.remove(input.temporaryKey);
    }
  }

  async published(id: string) {
    const [asset] = await this.db.select({
      entryId: entries.id, originalKey: assets.originalKey,
      thumbnailKey: assets.thumbnailKey, format: assets.format,
    }).from(assets).innerJoin(entries, eq(entries.assetId, assets.id))
      .where(and(eq(assets.id, id), eq(assets.state, 'ready'), isNull(entries.deletedAt))).limit(1);
    if (!asset || !asset.thumbnailKey || !Value.Check(ImageFormatSchema, asset.format)) {
      throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
    }
    return { ...asset, thumbnailKey: asset.thumbnailKey, format: asset.format };
  }

  async get(id: string, userId: string): Promise<UploadStatus> {
    const [asset] = await this.db.select({
      id: assets.id, status: assets.state, errorCode: assets.errorCode,
      width: assets.width, height: assets.height,
    }).from(assets).where(and(eq(assets.id, id), eq(assets.ownerId, userId), ne(assets.state, 'deleted'))).limit(1);
    if (!asset) throw new DomainError(404, 'NOT_FOUND', 'Upload not found.');
    const result = {
      id: asset.id, status: asset.status,
      ...(asset.status === 'failed' && asset.errorCode ? { errorCode: asset.errorCode } : {}),
      ...(asset.status === 'ready' ? { width: asset.width, height: asset.height } : {}),
    };
    if (!Value.Check(UploadStatusSchema, result)) throw new Error('Invalid stored upload status');
    return result;
  }
}
