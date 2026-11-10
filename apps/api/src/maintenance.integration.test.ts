import { randomUUID } from 'node:crypto';
import { utimes, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture } from './testing/fixture.js';
import { staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

describe('real maintenance reconciliation', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let worker: Awaited<ReturnType<typeof launchWorker>> | undefined;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
  });
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture.close();
  });

  it('fails cancelled uploads but preserves delayed pending work and recent files while reclaiming old orphans', async () => {
    const owner = new Client(fixture.address);
    await owner.auth('maintenance_owner');
    const image = (await staticImages())[0]!;
    const upload = async () => {
      const body = new FormData();
      body.append('file', new Blob([new Uint8Array(image.bytes)]), 'image.bin');
      const response = await owner.request('/api/v1/uploads', {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body,
      });
      expect(response.status).toBe(202);
      const { id } = await response.json();
      return (
        await fixture.pool.query('select id, original_key, job_id from assets where id=$1', [id])
      ).rows[0] as { id: string; original_key: string; job_id: string };
    };
    const cancelled = await upload();
    const delayed = await upload();
    await fixture.boss.cancel('asset-process', cancelled.job_id);
    await fixture.boss.cancel('asset-process', delayed.job_id);
    const delayedJob = await fixture.boss.send(
      'asset-process',
      { assetId: delayed.id },
      { startAfter: new Date(Date.now() + 60 * 60 * 1000) },
    );
    if (!delayedJob) throw new Error('Delayed job was not accepted');
    await fixture.pool.query(
      "update assets set job_id=$1, created_at=now()-interval '2 days' where id=$2",
      [delayedJob, delayed.id],
    );
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(fixture.storage.path(delayed.original_key), old, old);
    const oldOrphan = `originals/${randomUUID()}.bin`;
    const oldTemporary = `tmp/${randomUUID()}`;
    const recentOrphan = `tmp/${randomUUID()}`;
    for (const key of [oldOrphan, oldTemporary, recentOrphan])
      await writeFile(fixture.storage.path(key), 'private orphan', { flag: 'wx', mode: 0o600 });
    for (const key of [oldOrphan, oldTemporary]) await utimes(fixture.storage.path(key), old, old);
    const maintenanceId = await fixture.boss.send('maintenance', {});
    if (!maintenanceId) throw new Error('Maintenance job was not accepted');
    worker = await launchWorker(fixture);
    let state: string | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      state = (await fixture.boss.findJobs('maintenance', { id: maintenanceId }))[0]?.state;
      if (state === 'completed' || state === 'failed') break;
      await delay(100);
    }
    expect(state).toBe('completed');
    expect(
      (await fixture.pool.query('select state,error_code from assets where id=$1', [cancelled.id]))
        .rows[0],
    ).toEqual({ state: 'failed', error_code: 'IMAGE_PROCESSING_FAILED' });
    expect(
      (await fixture.pool.query('select state from assets where id=$1', [delayed.id])).rows[0]
        .state,
    ).toBe('pending');
    const remaining = await fixture.storage.files();
    expect(remaining).toContain(delayed.original_key);
    expect(remaining).toContain(recentOrphan);
    expect(remaining).not.toContain(cancelled.original_key);
    expect(remaining).not.toContain(oldOrphan);
    expect(remaining).not.toContain(oldTemporary);
  }, 30_000);
});
