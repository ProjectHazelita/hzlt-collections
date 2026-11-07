import { fork } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageErrorCode } from '@hcl/contracts';
import type { MediaMetadata } from '@hcl/server/media';

export class MediaProcessingError extends Error {
  constructor(readonly errorCode: ImageErrorCode, readonly retryable: boolean) {
    super(errorCode);
    this.name = 'MediaProcessingError';
  }
}

export type ProcessImageOptions = {
  inputPath: string;
  outputPath: string;
  maxImagePixels: number;
  maxImageDimension: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

function abortError(): Error {
  const error = new Error('Media processing aborted');
  error.name = 'AbortError';
  return error;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validMetadata(value: unknown, options: ProcessImageOptions): value is MediaMetadata {
  if (!record(value) || !exactKeys(value, ['format', 'originalWidth', 'originalHeight', 'width', 'height'])) return false;
  if (typeof value.format !== 'string' || !['jpeg', 'png', 'webp', 'gif'].includes(value.format)) return false;
  const dimensions = [value.originalWidth, value.originalHeight, value.width, value.height];
  if (!dimensions.every((dimension) => typeof dimension === 'number' && Number.isSafeInteger(dimension) && dimension > 0 && dimension <= options.maxImageDimension)) return false;
  const { originalWidth, originalHeight, width, height } = value as MediaMetadata;
  return originalWidth * originalHeight <= options.maxImagePixels &&
    ((width === originalWidth && height === originalHeight) || (width === originalHeight && height === originalWidth));
}

const errorCodes: readonly string[] = ['UNSUPPORTED_IMAGE_TYPE', 'ANIMATION_NOT_SUPPORTED', 'IMAGE_TOO_LARGE', 'INVALID_IMAGE', 'IMAGE_TIMEOUT', 'IMAGE_PROCESSING_FAILED'];

/** Resolves or rejects only after the native child has actually exited. */
export async function processImage(options: ProcessImageOptions): Promise<MediaMetadata> {
  const { inputPath, outputPath, maxImagePixels, maxImageDimension, timeoutMs, signal } = options;
  if (![inputPath, outputPath].every((path) => typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !path.includes('\0')) ||
      inputPath === outputPath || !outputPath.endsWith('.webp') ||
      ![maxImagePixels, maxImageDimension, timeoutMs].every((limit) => Number.isSafeInteger(limit) && limit > 0) || timeoutMs > 2_147_483_647) {
    throw new MediaProcessingError('IMAGE_PROCESSING_FAILED', false);
  }
  if (signal?.aborted) throw abortError();
  const development = import.meta.url.endsWith('.ts');
  const childPath = fileURLToPath(new URL(development ? './media-child.ts' : './media-child.js', import.meta.url));
  const { promise, resolve, reject } = Promise.withResolvers<MediaMetadata>();
  const child = fork(childPath, [], {
    execArgv: ['--max-old-space-size=128', ...(development ? ['--import', 'tsx'] : [])],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
    killSignal: 'SIGKILL',
  });
  let metadata: MediaMetadata | undefined;
  let failure: Error | undefined;
  let received = false;
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  const fail = (error: Error) => { failure ??= error; kill(); };
  const onAbort = () => { failure = abortError(); kill(); };
  const timer = setTimeout(() => fail(new MediaProcessingError('IMAGE_TIMEOUT', false)), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  process.once('exit', kill);
  child.on('error', () => fail(new MediaProcessingError('IMAGE_PROCESSING_FAILED', true)));
  child.on('message', (message: unknown) => {
    let length: number;
    try { length = Buffer.byteLength(JSON.stringify(message)); } catch { length = Infinity; }
    if (received || length > 4096 || !record(message)) {
      fail(new MediaProcessingError('IMAGE_PROCESSING_FAILED', true));
      return;
    }
    received = true;
    if (exactKeys(message, ['ok', 'metadata']) && message.ok === true && validMetadata(message.metadata, options)) {
      metadata = message.metadata;
    } else if (exactKeys(message, ['ok', 'errorCode', 'retryable']) && message.ok === false &&
        typeof message.errorCode === 'string' && errorCodes.includes(message.errorCode) && typeof message.retryable === 'boolean' &&
        message.retryable === (message.errorCode === 'IMAGE_PROCESSING_FAILED')) {
      failure ??= new MediaProcessingError(message.errorCode as ImageErrorCode, message.retryable);
    } else {
      fail(new MediaProcessingError('IMAGE_PROCESSING_FAILED', true));
    }
  });
  child.once('close', (code, exitSignal) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    process.removeListener('exit', kill);
    if (failure) reject(failure);
    else if (code !== 0 || exitSignal !== null || !metadata) reject(new MediaProcessingError('IMAGE_PROCESSING_FAILED', true));
    else resolve(metadata);
  });
  child.send({ inputPath, outputPath, maxImagePixels, maxImageDimension }, (error) => {
    if (error) fail(new MediaProcessingError('IMAGE_PROCESSING_FAILED', true));
  });
  // An abort between the initial check and listener registration must still kill the child.
  if (signal?.aborted) onAbort();
  return promise;
}
