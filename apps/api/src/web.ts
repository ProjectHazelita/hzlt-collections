import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import staticFiles from '@fastify/static';
import { ENTRY_ID_MAX, EntryIdSchema } from '@hcl/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Value } from 'typebox/value';

const fixedRoutes = [
  '/',
  '/publish',
  '/likes',
  '/search',
  '/login',
  '/register',
  '/settings',
  '/settings/profile',
  '/settings/content',
  '/settings/site',
];
const assetExtensions: Record<string, true> = {
  '.js': true,
  '.css': true,
  '.woff': true,
  '.woff2': true,
  '.ttf': true,
  '.otf': true,
  '.svg': true,
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
  '.avif': true,
  '.ico': true,
};
function pathname(request: FastifyRequest): string | undefined {
  const path = request.raw.url?.split('?', 1)[0];
  if (path?.startsWith('/users/')) {
    try {
      const username = decodeURIComponent(path.slice('/users/'.length)).normalize('NFKC');
      if (/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) return path;
    } catch {
      return undefined;
    }
    return undefined;
  }
  // Built names and declared routes are canonical ASCII paths. Never normalize a
  // traversal or encoded separator into an otherwise valid application route.
  if (
    !path?.startsWith('/') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in untrusted URL paths.
    /[%\\\x00-\x20\x7f]/.test(path) ||
    path.split('/').some((part) => part.startsWith('.'))
  )
    return undefined;
  return path;
}

function acceptsHtml(request: FastifyRequest): boolean {
  return (request.headers.accept ?? '').split(',').some((range) => {
    const [type, ...parameters] = range.trim().toLowerCase().split(';');
    if (type !== 'text/html') return false;
    return parameters.every((parameter) => {
      if (!/^\s*q\s*=/.test(parameter)) return true;
      const quality = Number(parameter.split('=')[1]);
      return Number.isFinite(quality) && quality > 0 && quality <= 1;
    });
  });
}

/** The optional root is internal test injection, never an environment setting. */
export async function installWeb(
  app: FastifyInstance,
  directory = fileURLToPath(new URL('../../web/dist/', import.meta.url)),
): Promise<void> {
  let root: string;
  try {
    root = await realpath(directory);
    if (!(await lstat(root)).isDirectory()) throw new Error('Not a directory');
    const index = join(root, 'index.html');
    if (!(await lstat(index)).isFile() || (await realpath(index)) !== index)
      throw new Error('Missing regular index.html');
  } catch (cause) {
    throw new Error(
      'Production web build is missing or invalid; build apps/web before starting the API.',
      { cause },
    );
  }

  async function regularFile(file: string): Promise<boolean> {
    const absolute = resolve(root, file);
    const fromRoot = relative(root, absolute);
    if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..') return false;
    try {
      return (await lstat(absolute)).isFile() && (await realpath(absolute)) === absolute;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }

  // Register only regular, recognized build assets, not a directory wildcard.
  // In particular neither index.html, source maps nor arbitrary dist files gain
  // an independent public URL, and no static handler owns /api or /media.
  const assets: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(entry.name)) continue;
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && assetExtensions[extname(file)]) assets.push(file);
    }
  }
  try {
    if ((await lstat(join(root, 'assets'))).isDirectory()) await collect('assets');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await app.register(async (scope) => {
    await scope.register(staticFiles, {
      root,
      serve: false,
      cacheControl: false,
      index: false,
      dotfiles: 'deny',
    });
    const sendOptions = {
      // Recheck the actual selected file immediately before static sends it.
      onFile: async (selected: string) => {
        if (!(await regularFile(relative(root, selected))))
          throw Object.assign(new Error('Not found'), { statusCode: 404 });
      },
    };
    for (const asset of assets) {
      scope.get('/' + asset, { schema: { hide: true } }, async (request, reply) => {
        if (pathname(request) !== '/' + asset || !(await regularFile(asset)))
          return reply.callNotFound();
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header(
          'Cache-Control',
          /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(basename(asset))
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
        return reply.sendFile(asset, sendOptions);
      });
    }
    for (const route of [...fixedRoutes, '/entries/:id', '/entries/:id/edit', '/users/:username']) {
      scope.get<{ Params: { id?: string; username?: string } }>(
        route,
        { schema: { hide: true } },
        async (request, reply) => {
          const path = pathname(request);
          const id = request.params.id;
          if (
            !path ||
            !acceptsHtml(request) ||
            (id !== undefined &&
              (!Value.Check(EntryIdSchema, id) ||
                (id.length === ENTRY_ID_MAX.length && id > ENTRY_ID_MAX))) ||
            !(await regularFile('index.html'))
          )
            return reply.callNotFound();
          reply.header('Vary', 'Accept');
          reply.header('Cache-Control', 'no-store');
          reply.header('X-Content-Type-Options', 'nosniff');
          return reply.sendFile('index.html', sendOptions);
        },
      );
    }
  });
}
