import { resolve } from 'node:path';
export function loadConfig(root: string, env = process.env) {
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error('Missing configuration: ' + name);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error('Invalid configuration: ' + name);
    return n;
  };
  const databaseUrl = required('DATABASE_URL');
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol))
    throw new Error('Invalid DATABASE_URL');
  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET requires 32 characters');
  const publicOrigin = new URL(required('PUBLIC_ORIGIN'));
  if (
    !['http:', 'https:'].includes(publicOrigin.protocol) ||
    publicOrigin.origin !== env.PUBLIC_ORIGIN
  )
    throw new Error('PUBLIC_ORIGIN must be an exact HTTP origin');
  const proxy = env.TRUST_PROXY ?? 'false';
  if (proxy === 'true') throw new Error('TRUST_PROXY must list explicit trusted addresses');
  return {
    root,
    databaseUrl,
    sessionSecret,
    publicOrigin: publicOrigin.origin,
    secureCookie: publicOrigin.protocol === 'https:',
    trustProxy: proxy === 'false' ? false : proxy.split(',').map((v) => v.trim()),
    dataDir: resolve(root, env.DATA_DIR ?? 'var/media'),
    port: integer('API_PORT', 3000, 1, 65535),
    maxUploadBytes: integer('MAX_UPLOAD_BYTES', 20971520, 1, 1073741824),
    maxImagePixels: integer('MAX_IMAGE_PIXELS', 40000000, 1, 100000000),
    maxImageDimension: integer('MAX_IMAGE_DIMENSION', 20000, 1, 100000),
    imageTimeoutMs: integer('IMAGE_TIMEOUT_MS', 30000, 1, 60000),
    sessionTtlSeconds: integer('SESSION_TTL_SECONDS', 604800, 60, 31536000),
  };
}
export type Config = ReturnType<typeof loadConfig>;
