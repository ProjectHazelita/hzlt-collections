import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ImageErrorCode } from '@hcl/contracts';
import { type Config, type Database, type LocalStorage, schema, sql } from '@hcl/server';
import { and, eq, isNull, lte, or } from 'drizzle-orm';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { MediaProcessingError, processImage } from './supervisor.js';

const { assets, entries, entryAttachments, sessions, idempotencyKeys, siteSettings, users } =
  schema;
const workOptions = {
  batchSize: 1,
  localConcurrency: 1,
  pollingIntervalSeconds: 2,
  includeMetadata: true,
} as const;
export type WorkerHandle = { stop(): Promise<void> };
type AssetJob = { assetId: string };
type Options = { db: Database; boss: PgBoss; storage: LocalStorage; config: Config };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attemptKey = (id: string, token: string) => `variants/${id}/${token}.webp`;
const abortError = () => new DOMException('Worker processing interrupted', 'AbortError');

export async function startWorker({ db, boss, storage, config }: Options): Promise<WorkerHandle> {
  await storage.initialize();
  const shutdown = new AbortController();
  const running = new Set<Promise<void>>();
  const registrations: { name: string; id: string }[] = [];
  let stopping: Promise<void> | undefined;
  const track = (action: () => Promise<void>) => {
    const task = Promise.resolve().then(() => {
      if (shutdown.signal.aborted) throw abortError();
      return action();
    });
    running.add(task);
    void task.then(
      () => running.delete(task),
      () => running.delete(task),
    );
    return task;
  };
  const failAttempt = async (id: string, token: string, errorCode: ImageErrorCode) => {
    await db
      .update(assets)
      .set({ state: 'failed', errorCode })
      .where(and(eq(assets.id, id), eq(assets.state, 'pending'), eq(assets.attemptToken, token)));
  };
  const discardAttempt = async (id: string, key: string) => {
    await db.transaction(async (tx) => {
      const [asset] = await tx.select().from(assets).where(eq(assets.id, id)).for('update');
      // A lost COMMIT acknowledgement must not cause removal of a published winner.
      if (asset?.thumbnailKey === key && asset.state === 'ready') return;
      await storage.remove(key);
    });
  };

  const processAsset = async (job: JobWithMetadata<AssetJob>) => {
    if (!job.data || !uuid.test(job.data.assetId)) throw new Error('Invalid asset job');
    const signal = AbortSignal.any([job.signal, shutdown.signal]);
    if (signal.aborted) throw abortError();
    const token = randomUUID();
    const asset = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(assets)
        .where(eq(assets.id, job.data.assetId))
        .for('update');
      if (!current || current.state !== 'pending' || current.jobId !== job.id) return undefined;
      await tx
        .update(assets)
        .set({ attemptToken: token, errorCode: null })
        .where(eq(assets.id, current.id));
      return current;
    });
    if (!asset) return;
    if (asset.kind === 'file') {
      const now = new Date();
      const updated = await db
        .update(assets)
        .set({
          readyAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          state: 'ready',
          errorCode: null,
        })
        .where(
          and(eq(assets.id, asset.id), eq(assets.state, 'pending'), eq(assets.attemptToken, token)),
        )
        .returning({ id: assets.id });
      if (updated.length === 0) throw new Error('File asset state changed during processing');
      return;
    }
    const key = attemptKey(asset.id, token);
    try {
      if (signal.aborted) throw abortError();
      await mkdir(dirname(storage.path(key)), { recursive: true, mode: 0o700 });
      const metadata = await processImage({
        inputPath: storage.path(asset.originalKey),
        outputPath: storage.path(key),
        maxImagePixels: config.maxImagePixels,
        maxImageDimension: config.maxImageDimension,
        timeoutMs: config.imageTimeoutMs,
        signal,
      });
      if (signal.aborted) throw abortError();
      const updated = await db.transaction(async (tx) => {
        const now = new Date();
        return tx
          .update(assets)
          .set({
            ...metadata,
            thumbnailKey: key,
            readyAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            state: 'ready',
            errorCode: null,
          })
          .where(
            and(
              eq(assets.id, asset.id),
              eq(assets.state, 'pending'),
              eq(assets.attemptToken, token),
            ),
          )
          .returning({ id: assets.id });
      });
      if (updated.length === 0) await discardAttempt(asset.id, key);
    } catch (error) {
      // The supervisor rejects only after the native process has actually exited.
      await discardAttempt(asset.id, key);
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError'))
        throw abortError();
      const deterministic = error instanceof MediaProcessingError && !error.retryable;
      if (deterministic || job.retryCount >= job.retryLimit) {
        await failAttempt(
          asset.id,
          token,
          error instanceof MediaProcessingError ? error.errorCode : 'IMAGE_PROCESSING_FAILED',
        );
      }
      if (!deterministic) throw error;
    }
  };

  // Lock the asset across authorization and unlink so publishing cannot race cleanup.
  const deleteAsset = async (id: string) => {
    await db.transaction(async (tx) => {
      const [asset] = await tx.select().from(assets).where(eq(assets.id, id)).for('update');
      if (!asset) return;
      const [published] = await tx
        .select({ id: entryAttachments.id })
        .from(entryAttachments)
        .innerJoin(entries, eq(entries.id, entryAttachments.entryId))
        .where(and(eq(entryAttachments.assetId, id), isNull(entries.deletedAt)))
        .limit(1);
      if (published) return;
      const [avatar] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.avatarAssetId, id))
        .limit(1);
      if (avatar) return;
      const [logo] = await tx
        .select({ id: siteSettings.id })
        .from(siteSettings)
        .where(eq(siteSettings.logoAssetId, id))
        .limit(1);
      if (logo) return;
      const expired =
        asset.state === 'ready' && asset.expiresAt !== null && asset.expiresAt <= new Date();
      if (asset.state !== 'deleted' && asset.state !== 'failed' && !expired) return;
      if (expired) await tx.update(assets).set({ state: 'deleted' }).where(eq(assets.id, id));
      await storage.remove(asset.originalKey);
      if (asset.thumbnailKey) await storage.remove(asset.thumbnailKey);
      if (asset.attemptToken) await storage.remove(attemptKey(id, asset.attemptToken));
    });
  };

  const reconcilePending = async () => {
    const candidates = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.state, 'pending'));
    for (const candidate of candidates) {
      if (shutdown.signal.aborted) throw abortError();
      await db.transaction(async (tx) => {
        const [asset] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, candidate.id), eq(assets.state, 'pending')))
          .for('update', { skipLocked: true });
        if (!asset) return;
        const jobs = asset.jobId ? await boss.findJobs('asset-process', { id: asset.jobId }) : [];
        const job = jobs[0];
        if (!job || job.state === 'failed' || job.state === 'cancelled') {
          await tx
            .update(assets)
            .set({ state: 'failed', errorCode: 'IMAGE_PROCESSING_FAILED' })
            .where(and(eq(assets.id, asset.id), eq(assets.state, 'pending')));
        }
      });
    }
  };

  const cleanOrphanFiles = async () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const key of await storage.files()) {
      if (shutdown.signal.aborted) throw abortError();
      // Ignore anything outside the generated namespace; never follow arbitrary keys.
      const original = /^originals\/([0-9a-f-]+)\.bin$/.exec(key);
      const variant = /^variants\/([0-9a-f-]+)\/([0-9a-f-]+)\.webp$/.exec(key);
      const temporary = /^tmp\/[0-9a-f-]+$/.test(key);
      if (!original && !variant && !temporary) continue;
      let mtime: number;
      try {
        mtime = (await storage.info(key)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (mtime >= cutoff) continue;
      const id = original?.[1] ?? variant?.[1];
      if (!id) {
        // HTTP uploads have a 120 second deadline, well below this one-hour grace.
        await storage.remove(key);
        continue;
      }
      if (!uuid.test(id)) continue;
      await db.transaction(async (tx) => {
        // Upload creation acquires this same lock before moving its immutable original.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'hcl:asset:' + id}))`);
        const [asset] = await tx.select().from(assets).where(eq(assets.id, id)).for('update');
        if (
          asset &&
          (asset.originalKey === key ||
            asset.thumbnailKey === key ||
            (asset.state === 'pending' &&
              asset.attemptToken !== null &&
              attemptKey(asset.id, asset.attemptToken) === key))
        )
          return;
        // A failed/deleted asset can still have its old native attempt exiting. The
        // one-hour grace exceeds its hard deadline; an active pending token is protected.
        await storage.remove(key);
      });
    }
  };

  const maintenance = async () => {
    await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
    await db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, new Date()));
    await reconcilePending();
    const candidates = await db
      .select({ id: assets.id })
      .from(assets)
      .where(
        or(
          eq(assets.state, 'failed'),
          eq(assets.state, 'deleted'),
          and(eq(assets.state, 'ready'), lte(assets.expiresAt, new Date())),
        ),
      );
    for (const candidate of candidates) {
      if (shutdown.signal.aborted) throw abortError();
      await deleteAsset(candidate.id);
    }
    await cleanOrphanFiles();
  };

  const stop = () =>
    (stopping ??= (async () => {
      shutdown.abort();
      const results = await Promise.allSettled(
        registrations.map(({ name, id }) => boss.offWork(name, { id, wait: true })),
      );
      await Promise.allSettled([...running]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })());

  try {
    registrations.push({
      name: 'asset-process',
      id: await boss.work<AssetJob, void, typeof workOptions>(
        'asset-process',
        workOptions,
        async ([job]) => {
          if (job) await track(() => processAsset(job));
        },
      ),
    });
    registrations.push({
      name: 'asset-delete',
      id: await boss.work<AssetJob, void, typeof workOptions>(
        'asset-delete',
        workOptions,
        async ([job]) => {
          if (job)
            await track(async () => {
              if (!job.data || !uuid.test(job.data.assetId))
                throw new Error('Invalid deletion job');
              await deleteAsset(job.data.assetId);
            });
        },
      ),
    });
    registrations.push({
      name: 'maintenance',
      id: await boss.work('maintenance', workOptions, async ([job]) => {
        if (job) await track(maintenance);
      }),
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop };
}
