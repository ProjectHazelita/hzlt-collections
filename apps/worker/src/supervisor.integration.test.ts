import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processImage } from './supervisor.js';

async function children() {
  const value = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
  return value.trim().split(/\s+/).filter(Boolean).sort();
}

describe('real native media child lifetime', () => {
  let directory: string;
  let original: Buffer;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hcl-child-'));
    original = await sharp({
      create: { width: 40, height: 10, channels: 4, background: '#8839ef' },
    })
      .png()
      .toBuffer();
    await writeFile(join(directory, 'original.bin'), original);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const options = () => ({
    inputPath: join(directory, 'original.bin'),
    outputPath: join(directory, 'attempt.webp'),
    maxImagePixels: 40_000_000,
    maxImageDimension: 20_000,
    timeoutMs: 30_000,
  });

  it('fully decodes an oriented derivative while leaving original bytes unchanged', async () => {
    const baseline = await children();
    expect(await processImage(options())).toEqual({
      format: 'png',
      originalWidth: 40,
      originalHeight: 10,
      width: 40,
      height: 10,
    });
    const derivative = await sharp(join(directory, 'attempt.webp'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(derivative.info).toMatchObject({ width: 40, height: 10 });
    expect(await sharp(join(directory, 'attempt.webp')).metadata()).toMatchObject({
      format: 'webp',
    });
    expect(await readFile(join(directory, 'original.bin'))).toEqual(original);
    expect(await children()).toEqual(baseline);
  }, 30_000);

  it('enforces a hard one-millisecond deadline and reaps the child before rejection', async () => {
    const baseline = await children();
    await expect(processImage({ ...options(), timeoutMs: 1 })).rejects.toMatchObject({
      errorCode: 'IMAGE_TIMEOUT',
      retryable: false,
    });
    expect(await children()).toEqual(baseline);
    // The task slot remains usable after the killed process, not just after a timeout promise.
    expect(await processImage(options())).toMatchObject({ format: 'png', width: 40, height: 10 });
  }, 30_000);

  it('kills and reaps an aborted child instead of leaving native work running', async () => {
    const baseline = await children();
    const controller = new AbortController();
    const result = processImage({ ...options(), signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(await children()).toEqual(baseline);
  }, 30_000);

  it('rejects truncated pixel data after metadata rather than publishing a partial image', async () => {
    const jpeg = await sharp(original).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, jpeg.length - 2);
    expect(await sharp(truncated).metadata()).toMatchObject({ width: 40, height: 10 });
    await writeFile(join(directory, 'original.bin'), truncated);
    await expect(processImage(options())).rejects.toMatchObject({
      errorCode: 'INVALID_IMAGE',
      retryable: false,
    });
  }, 30_000);
});
