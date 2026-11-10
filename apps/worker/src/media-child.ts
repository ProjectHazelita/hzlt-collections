import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ImageErrorCode, ImageFormat } from '@hcl/contracts';
import { type MediaMetadata, sniffImageFormat } from '@hcl/server/media';
import sharp from 'sharp';

class ImageFailure extends Error {
  constructor(readonly errorCode: ImageErrorCode) {
    super(errorCode);
  }
}

type Input = {
  inputPath: string;
  outputPath: string;
  maxImagePixels: number;
  maxImageDimension: number;
};

function validInput(value: unknown): value is Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4 ||
    !['inputPath', 'outputPath', 'maxImagePixels', 'maxImageDimension'].every((key) =>
      Object.hasOwn(input, key),
    )
  )
    return false;
  return (
    [input.inputPath, input.outputPath].every(
      (path) =>
        typeof path === 'string' &&
        isAbsolute(path) &&
        normalize(path) === path &&
        !path.includes('\0'),
    ) &&
    input.inputPath !== input.outputPath &&
    (input.outputPath as string).endsWith('.webp') &&
    [input.maxImagePixels, input.maxImageDimension].every(
      (limit) => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0,
    )
  );
}

async function readExactly(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new ImageFailure('INVALID_IMAGE');
    offset += bytesRead;
  }
}

/** Inspect container structure with constant-size reads, never allocating declared chunk sizes. */
async function preflight(file: FileHandle): Promise<ImageFormat> {
  const info = await file.stat();
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 3)
    throw new ImageFailure('INVALID_IMAGE');
  const header = Buffer.alloc(Math.min(12, info.size));
  await readExactly(file, header, 0);
  const format = sniffImageFormat(header);
  if (!format) throw new ImageFailure('UNSUPPORTED_IMAGE_TYPE');
  const chunk = Buffer.alloc(8);
  if (format === 'png') {
    let position = 8;
    // A finite chunk budget bounds adversarial containers with millions of empty chunks.
    for (let count = 0; count < 65_536; count++) {
      if (position + 12 > info.size) throw new ImageFailure('INVALID_IMAGE');
      await readExactly(file, chunk, position);
      const length = chunk.readUInt32BE(0);
      const type = chunk.toString('ascii', 4, 8);
      if (length > 0x7fffffff || length > info.size - position - 12)
        throw new ImageFailure('INVALID_IMAGE');
      if (type === 'acTL') throw new ImageFailure('ANIMATION_NOT_SUPPORTED');
      position += length + 12;
      if (type === 'IEND') {
        if (length !== 0 || position !== info.size) throw new ImageFailure('INVALID_IMAGE');
        return format;
      }
    }
    throw new ImageFailure('INVALID_IMAGE');
  }
  if (format === 'webp') {
    if (header.readUInt32LE(4) + 8 !== info.size) throw new ImageFailure('INVALID_IMAGE');
    let position = 12;
    for (let count = 0; count < 65_536 && position < info.size; count++) {
      if (position + 8 > info.size) throw new ImageFailure('INVALID_IMAGE');
      await readExactly(file, chunk, position);
      const type = chunk.toString('ascii', 0, 4);
      const length = chunk.readUInt32LE(4);
      if (length > info.size - position - 8) throw new ImageFailure('INVALID_IMAGE');
      if (type === 'ANIM' || type === 'ANMF') throw new ImageFailure('ANIMATION_NOT_SUPPORTED');
      if (type === 'VP8X') {
        if (length !== 10) throw new ImageFailure('INVALID_IMAGE');
        await readExactly(file, chunk.subarray(0, 1), position + 8);
        if ((chunk[0]! & 0x02) !== 0) throw new ImageFailure('ANIMATION_NOT_SUPPORTED');
      }
      position += 8 + length + (length & 1);
      if (position === info.size) return format;
      if (position > info.size) throw new ImageFailure('INVALID_IMAGE');
    }
    throw new ImageFailure('INVALID_IMAGE');
  }
  return format;
}

async function processInput(input: Input): Promise<MediaMetadata> {
  sharp.cache(false);
  sharp.concurrency(1);
  const file = await open(input.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let format: ImageFormat;
  try {
    format = await preflight(file);
  } finally {
    await file.close();
  }
  const image = sharp(input.inputPath, {
    failOn: 'warning',
    limitInputPixels: input.maxImagePixels,
    unlimited: false,
    sequentialRead: true,
    pages: 1,
    animated: false,
  }).timeout({ seconds: 20 });
  let output: FileHandle | undefined;
  try {
    const metadata = await image.metadata();
    if (metadata.format !== format) throw new ImageFailure('UNSUPPORTED_IMAGE_TYPE');
    if ((metadata.pages ?? 1) > 1) throw new ImageFailure('ANIMATION_NOT_SUPPORTED');
    const { width, height } = metadata;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new ImageFailure('INVALID_IMAGE');
    if (
      width > input.maxImageDimension ||
      height > input.maxImageDimension ||
      width * height > input.maxImagePixels
    )
      throw new ImageFailure('IMAGE_TOO_LARGE');
    const swapped =
      metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    output = await open(input.outputPath, 'wx', 0o600);
    await pipeline(
      image
        .autoOrient()
        .resize({
          width: 768,
          height: 2048,
          fit: 'inside',
          withoutEnlargement: true,
          fastShrinkOnLoad: false,
        })
        .webp({ quality: 82 }),
      output.createWriteStream(),
    );
    return {
      format,
      originalWidth: width,
      originalHeight: height,
      width: swapped ? height : width,
      height: swapped ? width : height,
    };
  } catch (error) {
    image.destroy();
    // Keep storage/OS failures retryable; malformed data and native decode warnings are terminal.
    if (error instanceof ImageFailure) throw error;
    if (error instanceof Error && 'code' in error) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit|exceeds.*pixels/i.test(message)) throw new ImageFailure('IMAGE_TOO_LARGE');
    if (/timeout|timed out/i.test(message)) throw new ImageFailure('IMAGE_TIMEOUT');
    if (
      /write error|unable to write|no space left|permission denied|input file is missing/i.test(
        message,
      )
    )
      throw error;
    throw new ImageFailure('INVALID_IMAGE');
  } finally {
    await output?.close();
  }
}
// IPC EOF also covers an abruptly killed parent; do not allow detached native work.
process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));
process.once('SIGTERM', () => process.kill(process.pid, 'SIGKILL'));
process.once('SIGINT', () => process.kill(process.pid, 'SIGKILL'));
if (!process.connected || !process.send) process.exit(1);
process.once('message', async (value: unknown) => {
  let result:
    | { ok: true; metadata: MediaMetadata }
    | { ok: false; errorCode: ImageErrorCode; retryable: boolean };
  try {
    if (!validInput(value)) throw new ImageFailure('IMAGE_PROCESSING_FAILED');
    result = { ok: true, metadata: await processInput(value) };
  } catch (error) {
    const errorCode = error instanceof ImageFailure ? error.errorCode : 'IMAGE_PROCESSING_FAILED';
    result = { ok: false, errorCode, retryable: errorCode === 'IMAGE_PROCESSING_FAILED' };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 4096 || !process.connected || !process.send)
    process.exit(1);
  process.send(result, (error) => process.exit(error ? 1 : 0));
});
