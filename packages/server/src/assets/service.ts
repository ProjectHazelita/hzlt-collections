import { and, eq, ne, sql } from 'drizzle-orm';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { Value } from 'typebox/value';
import {
  ImageFormatSchema,
  UploadAcceptedSchema,
  UploadStatusSchema,
  type ImageFormat,
  type UploadAccepted,
  type UploadKind,
  type UploadStatus,
} from '@hcl/contracts';
import type { User } from '@hcl/contracts';
import { visibleEntries } from '../entries/access.js';
import type { Database } from '../index.js';
import type { LocalStorage } from '../storage/local-storage.js';
import { assets, entries, entryAttachments, siteSettings, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import { withIdempotency } from '../idempotency.js';

export class AssetService {
  constructor(
    private readonly db: Database,
    private readonly boss: PgBoss,
    private readonly storage: LocalStorage,
  ) {}

  async create(input: {
    id: string;
    ownerId: string;
    key: string;
    temporaryKey: string;
    displayName: string;
    sha256: string;
    bytes: number;
    kind: UploadKind;
    format: ImageFormat | null;
    mime: string | null;
    extension: string | null;
  }): Promise<UploadAccepted> {
    const originalKey = `originals/${input.id}.bin`;
    let moved = false;
    let committed = false;
    try {
      const result = await withIdempotency<UploadAccepted>(
        this.db,
        {
          userId: input.ownerId,
          operation: 'upload-create',
          key: input.key.toLowerCase(),
          requestHash: input.sha256,
          statusCode: 202,
        },
        (value): value is UploadAccepted => Value.Check(UploadAcceptedSchema, value),
        async (tx) => {
          // Coordinate with orphan reclamation, including a transaction stalled after rename.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'hcl:asset:' + input.id}))`);
          await this.storage.move(input.temporaryKey, originalKey);
          moved = true;
          await tx.insert(assets).values({
            id: input.id,
            ownerId: input.ownerId,
            kind: input.kind,
            state: 'pending',
            originalKey,
            displayName: input.displayName,
            sha256: input.sha256,
            bytes: BigInt(input.bytes),
            format: input.format,
            mime: input.mime,
            extension: input.extension,
          });
          const jobId = await this.boss.send(
            'asset-process',
            { assetId: input.id },
            { db: fromDrizzle(tx, sql) },
          );
          if (!jobId) throw new Error('Asset processing job was not created');
          await tx.update(assets).set({ jobId }).where(eq(assets.id, input.id));
          return { id: input.id, kind: input.kind, status: 'pending' as const };
        },
      );
      committed = true;
      return result;
    } finally {
      // Replays never touch the committed winner: only this request's generated keys.
      if (moved && !committed) {
        // A failed COMMIT acknowledgement is not proof of rollback. Keep a referenced
        // original; if the DB is unavailable, leave it private for later reconciliation.
        const [persisted] = await this.db
          .select({ originalKey: assets.originalKey })
          .from(assets)
          .where(eq(assets.id, input.id))
          .limit(1);
        if (!persisted) await this.storage.remove(originalKey);
      }
      await this.storage.remove(input.temporaryKey);
    }
  }

  /** Resolve an asset only while it is ready and attached to a published entry. */
  async published(id: string, user: User | null = null) {
    const [asset] = await this.db
      .select({
        entryId: entries.id,
        kind: assets.kind,
        originalKey: assets.originalKey,
        thumbnailKey: assets.thumbnailKey,
        format: assets.format,
        mime: assets.mime,
        extension: assets.extension,
        displayName: assets.displayName,
        position: entryAttachments.position,
      })
      .from(assets)
      .innerJoin(entryAttachments, eq(entryAttachments.assetId, assets.id))
      .innerJoin(entries, eq(entries.id, entryAttachments.entryId))
      .where(
        and(
          eq(assets.id, id),
          eq(assets.state, 'ready'),
          visibleEntries(user),
          ne(entryAttachments.kind, 'link'),
        ),
      )
      .limit(1);
    if (!asset) throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
    if (asset.kind === 'image') {
      if (!asset.thumbnailKey || !Value.Check(ImageFormatSchema, asset.format))
        throw new DomainError(404, 'NOT_FOUND', 'Media not found.');
      return { ...asset, kind: 'image' as const, format: asset.format as ImageFormat };
    }
    return { ...asset, kind: 'file' as const };
  }

  /** Resolve a ready image that a user has selected as their avatar. */
  async avatar(id: string) {
    const [asset] = await this.db
      .select({
        thumbnailKey: assets.thumbnailKey,
      })
      .from(assets)
      .innerJoin(users, eq(users.avatarAssetId, assets.id))
      .where(and(eq(assets.id, id), eq(assets.state, 'ready'), eq(assets.kind, 'image')))
      .limit(1);
    const thumbnailKey = asset?.thumbnailKey;
    if (!thumbnailKey) throw new DomainError(404, 'NOT_FOUND', 'Avatar not found.');
    return { thumbnailKey };
  }

  /** Only the processed thumbnail of the saved site logo is public. */
  async siteLogo(id: string) {
    const [asset] = await this.db
      .select({ thumbnailKey: assets.thumbnailKey })
      .from(assets)
      .innerJoin(siteSettings, eq(siteSettings.logoAssetId, assets.id))
      .where(and(eq(assets.id, id), eq(assets.state, 'ready'), eq(assets.kind, 'image')))
      .limit(1);
    if (!asset?.thumbnailKey) throw new DomainError(404, 'NOT_FOUND', 'Site logo not found.');
    return { thumbnailKey: asset.thumbnailKey };
  }

  async get(id: string, userId: string): Promise<UploadStatus> {
    const [asset] = await this.db
      .select({
        id: assets.id,
        kind: assets.kind,
        name: assets.displayName,
        status: assets.state,
        errorCode: assets.errorCode,
        width: assets.width,
        height: assets.height,
      })
      .from(assets)
      .where(
        and(eq(assets.id, id), eq(assets.ownerId, userId), ne(assets.state, 'deleted')),
      )
      .limit(1);
    if (!asset) throw new DomainError(404, 'NOT_FOUND', 'Upload not found.');
    const image = asset.kind === 'image';
    const result = {
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      status: asset.status,
      ...(asset.status === 'failed' && asset.errorCode ? { errorCode: asset.errorCode } : {}),
      ...(asset.status === 'ready' && image
        ? { width: asset.width, height: asset.height }
        : {}),
    };
    if (!Value.Check(UploadStatusSchema, result)) throw new Error('Invalid stored upload status');
    return result;
  }
}
