import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { UploadStatus } from '@hcl/contracts';
import { initializeQueues } from '@hcl/server';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createFixture } from './testing/fixture.js';
import { animatedImages, staticImages } from './testing/images.js';
import { launchWorker } from './testing/worker.js';

async function upload(client: Client, bytes: Uint8Array, key = randomUUID(), extra = false) {
  const body = new FormData();
  body.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
    'untrusted-name.jpg',
  );
  if (extra) body.append('unexpected', 'not permitted');
  return client.request('/api/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body,
  });
}

async function terminal(client: Client, id: string, timeoutMs = 25_000): Promise<UploadStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.request('/api/v1/uploads/' + id);
    if (!response.ok) throw new Error('Upload status failed: ' + response.status);
    const status: UploadStatus = await response.json();
    if (status.status !== 'pending') return status;
    await delay(250);
  }
  throw new Error('Upload remained pending beyond the processing deadline');
}

async function nativeChild(workerPid: number | undefined) {
  if (!workerPid) throw new Error('Worker did not have a process identifier');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ids = (await readFile(`/proc/${workerPid}/task/${workerPid}/children`, 'utf8')).trim();
    if (ids) return Number(ids.split(/\s+/)[0]);
    await delay(5);
  }
  throw new Error('No active native child was observed');
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('private multipart uploads with a real independent Worker', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let worker: Awaited<ReturnType<typeof launchWorker>> | undefined;
  let owner: Client;
  let other: Client;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.reset();
    owner = new Client(fixture.address);
    other = new Client(fixture.address);
    await owner.auth('image_owner');
    await other.auth('image_other');
  }, 30_000);
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await fixture?.close();
  }, 50_000);

  it('processes four real static formats and EXIF orientation without exposing unpublished bytes', async () => {
    worker = await launchWorker(fixture);
    for (const image of await staticImages()) {
      const accepted = await upload(owner, image.bytes);
      expect(accepted.status).toBe(202);
      const pending = await accepted.json();
      expect(pending).toEqual({ id: expect.any(String), status: 'pending' });
      expect((await other.request('/api/v1/uploads/' + pending.id)).status).toBe(404);
      expect((await fetch(fixture.address + '/api/v1/uploads/' + pending.id)).status).toBe(404);
      const status = await terminal(owner, pending.id);
      expect(status).toMatchObject({ status: 'ready', width: image.width, height: image.height });
      for (const kind of ['original', 'thumbnail', 'download'])
        expect((await fetch(`${fixture.address}/media/${pending.id}/${kind}`)).status).toBe(404);
      const row = (await fixture.pool.query('select * from assets where id=$1', [pending.id]))
        .rows[0];
      expect(row.original_width).toBe(image.originalWidth);
      expect(row.original_height).toBe(image.originalHeight);
      expect(row.sha256).toBe(sha256(image.bytes));
      const original = await readFile(fixture.storage.path(row.original_key));
      expect(sha256(original)).toBe(sha256(image.bytes));
      const thumbnail = await readFile(fixture.storage.path(row.thumbnail_key));
      const decoded = await sharp(thumbnail).raw().toBuffer({ resolveWithObject: true });
      expect(await sharp(thumbnail).metadata()).toMatchObject({
        format: 'webp',
        width: image.width,
        height: image.height,
      });
      expect(decoded.info.width).toBe(image.width);
      expect(decoded.info.height).toBe(image.height);
      expect((await sharp(thumbnail).metadata()).exif).toBeUndefined();
    }
  }, 60_000);

  it('deduplicates concurrent content submissions and recovers queued work after Worker startup', async () => {
    const image = (await staticImages())[0]!;
    const key = randomUUID();
    const responses = await Promise.all([
      upload(owner, image.bytes, key),
      upload(owner, image.bytes, key),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const accepted = await responses[0]!.json();
    expect(await responses[1]!.json()).toEqual(accepted);
    expect(
      (await fixture.pool.query('select count(*)::int as count from assets')).rows[0].count,
    ).toBe(1);
    expect((await owner.request('/api/v1/uploads/' + accepted.id)).status).toBe(200);
    const changed = await upload(owner, (await staticImages())[1]!.bytes, key);
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');
    worker = await launchWorker(fixture);
    expect((await terminal(owner, accepted.id)).status).toBe('ready');
    expect((await fixture.storage.files()).filter((key) => key.startsWith('tmp/'))).toEqual([]);
  }, 60_000);

  it('rejects fake MIME, extra multipart fields and truncated decoding without publishing anything', async () => {
    const svg = await upload(
      owner,
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      ),
    );
    expect(svg.status).toBe(415);
    expect((await svg.json()).error.code).toBe('UNSUPPORTED_IMAGE_TYPE');
    const image = (await staticImages())[1]!;
    expect((await upload(owner, image.bytes, randomUUID(), true)).status).toBe(400);
    expect(
      (await fixture.pool.query('select count(*)::int as count from assets')).rows[0].count,
    ).toBe(0);
    worker = await launchWorker(fixture);
    const broken = await upload(owner, image.bytes.subarray(0, 48));
    expect(broken.status).toBe(202);
    const accepted = await broken.json();
    expect(await terminal(owner, accepted.id)).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_IMAGE',
    });
    expect((await fetch(`${fixture.address}/media/${accepted.id}/original`)).status).toBe(404);
    expect((await fixture.storage.files()).filter((key) => key.startsWith('tmp/'))).toEqual([]);
  }, 60_000);

  it('rejects actual animated GIF, WebP and APNG rather than silently publishing frame one', async () => {
    worker = await launchWorker(fixture);
    for (const image of await animatedImages()) {
      if (image.name !== 'apng') expect((await sharp(image.bytes).metadata()).pages).toBe(2);
      const response = await upload(owner, image.bytes);
      expect(response.status).toBe(202);
      const accepted = await response.json();
      expect(await terminal(owner, accepted.id)).toMatchObject({
        status: 'failed',
        errorCode: 'ANIMATION_NOT_SUPPORTED',
      });
      expect((await fetch(`${fixture.address}/media/${accepted.id}/thumbnail`)).status).toBe(404);
    }
  }, 60_000);

  it('enforces byte limits before persistence and pixel/dimension limits inside the child', async () => {
    await fixture.close();
    fixture = await createFixture({ MAX_UPLOAD_BYTES: '64' });
    await fixture.reset();
    owner = new Client(fixture.address);
    await owner.auth('size_owner');
    const image = (await staticImages())[1]!;
    const tooBig = await upload(owner, image.bytes);
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error.code).toBe('IMAGE_TOO_LARGE');
    expect(
      (await fixture.pool.query('select count(*)::int as count from assets')).rows[0].count,
    ).toBe(0);
    expect(await fixture.storage.files()).toEqual([]);
    await fixture.close();
    fixture = await createFixture({ MAX_IMAGE_PIXELS: '100', MAX_IMAGE_DIMENSION: '10' });
    await fixture.reset();
    owner = new Client(fixture.address);
    await owner.auth('pixel_owner');
    worker = await launchWorker(fixture);
    for (const dimensions of [
      { width: 20, height: 20 },
      { width: 20, height: 2 },
    ]) {
      const bytes = await sharp({ create: { ...dimensions, channels: 3, background: '#8839ef' } })
        .png()
        .toBuffer();
      const accepted = await upload(owner, bytes);
      expect(accepted.status).toBe(202);
      expect(await terminal(owner, (await accepted.json()).id)).toMatchObject({
        status: 'failed',
        errorCode: 'IMAGE_TOO_LARGE',
      });
    }
  }, 60_000);

  it('rolls back asset creation and removes private files when the real queue is unavailable', async () => {
    await fixture.boss.deleteQueue('asset-process');
    const image = (await staticImages())[0]!;
    const response = await upload(owner, image.bytes);
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(
      (await fixture.pool.query('select count(*)::int as count from assets')).rows[0].count,
    ).toBe(0);
    expect(
      (await fixture.pool.query('select count(*)::int as count from idempotency_keys')).rows[0]
        .count,
    ).toBe(0);
    expect(await fixture.storage.files()).toEqual([]);
    await initializeQueues(fixture.boss);
    expect(await fixture.boss.findJobs('asset-process')).toEqual([]);
  }, 30_000);

  it('retries an unexpectedly killed media child without leaking secrets or publishing a partial result', async () => {
    worker = await launchWorker(fixture);
    const image = await sharp({
      create: { width: 8000, height: 5000, channels: 3, background: '#8839ef' },
    })
      .jpeg()
      .toBuffer();
    const accepted = await upload(owner, image);
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json();
    const childPid = await nativeChild(worker.child.pid);
    const environmentKeys = (await readFile(`/proc/${childPid}/environ`, 'utf8'))
      .split('\0')
      .map((entry) => entry.split('=', 1)[0]);
    expect(environmentKeys).not.toContain('DATABASE_URL');
    expect(environmentKeys).not.toContain('SESSION_SECRET');
    const oldToken = (
      await fixture.pool.query('select attempt_token from assets where id=$1', [id])
    ).rows[0].attempt_token;
    process.kill(childPid, 'SIGKILL');
    expect((await terminal(owner, id)).status).toBe('ready');
    const row = (
      await fixture.pool.query('select attempt_token, thumbnail_key from assets where id=$1', [id])
    ).rows[0];
    expect(row.attempt_token).not.toBe(oldToken);
    expect(await sharp(fixture.storage.path(row.thumbnail_key)).metadata()).toMatchObject({
      format: 'webp',
    });
  }, 60_000);

  it('reaps native work after a hard Worker crash and resumes the expired queue lease after restart', async () => {
    worker = await launchWorker(fixture);
    const image = await sharp({
      create: { width: 8000, height: 5000, channels: 3, background: '#8839ef' },
    })
      .jpeg()
      .toBuffer();
    const response = await upload(owner, image);
    expect(response.status).toBe(202);
    const { id } = await response.json();
    const childPid = await nativeChild(worker.child.pid);
    const oldToken = (
      await fixture.pool.query('select attempt_token from assets where id=$1', [id])
    ).rows[0].attempt_token;
    const exited = once(worker.child, 'exit');
    worker.child.kill('SIGKILL');
    await exited;
    let childGone = false;
    const reapDeadline = Date.now() + 5_000;
    while (Date.now() < reapDeadline) {
      try {
        await readFile(`/proc/${childPid}/stat`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        childGone = true;
        break;
      }
      await delay(50);
    }
    expect(childGone).toBe(true);
    expect((await owner.request('/api/v1/uploads/' + id)).status).toBe(200);
    expect((await fetch(`${fixture.address}/media/${id}/original`)).status).toBe(404);
    worker = await launchWorker(fixture);
    expect((await terminal(owner, id, 150_000)).status).toBe('ready');
    const row = (
      await fixture.pool.query(
        'select attempt_token,original_key,thumbnail_key from assets where id=$1',
        [id],
      )
    ).rows[0];
    expect(row.attempt_token).not.toBe(oldToken);
    expect(sha256(await readFile(fixture.storage.path(row.original_key)))).toBe(sha256(image));
    expect(await sharp(fixture.storage.path(row.thumbnail_key)).metadata()).toMatchObject({
      format: 'webp',
    });
  }, 180_000);

  it('removes a streamed partial upload after a real client disconnect without persisting an asset', async () => {
    const boundary = 'hcl-' + randomUUID();
    const request = httpRequest(fixture.address + '/api/v1/uploads', {
      method: 'POST',
      headers: {
        cookie: owner.cookie,
        origin: owner.origin,
        'x-csrf-token': owner.csrfToken,
        'idempotency-key': randomUUID(),
        'content-type': 'multipart/form-data; boundary=' + boundary,
      },
    });
    request.on('error', () => {
      /* Expected socket reset when this client aborts. */
    });
    let beganStreaming = false;
    try {
      request.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
      );
      request.write((await staticImages())[0]!.bytes.subarray(0, 64));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await fixture.storage.files()).some((key) => key.startsWith('tmp/'))) {
          beganStreaming = true;
          break;
        }
        await delay(20);
      }
      expect(beganStreaming).toBe(true);
    } finally {
      request.destroy();
    }
    const cleanupDeadline = Date.now() + 5_000;
    while ((await fixture.storage.files()).length && Date.now() < cleanupDeadline) await delay(20);
    expect(await fixture.storage.files()).toEqual([]);
    expect(
      (await fixture.pool.query('select count(*)::int as count from assets')).rows[0].count,
    ).toBe(0);
    expect(
      (await fixture.pool.query('select count(*)::int as count from idempotency_keys')).rows[0]
        .count,
    ).toBe(0);
  }, 15_000);
});
