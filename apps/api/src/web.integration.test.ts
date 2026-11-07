import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { installWeb } from './web.js';
import { createFixture, Client } from './testing/fixture.js';

const html = '<!doctype html><html><head><title>production fixture</title></head><body><div id="root"></div></body></html>';
const javascript = Buffer.from('export const productionAsset = "真实构建资源";\n');
const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]);

// Unlike fetch, node:http preserves raw dot segments and percent encodings, so
// traversal assertions exercise the server rather than URL client normalization.
function request(address: string, path: string, method = 'GET', accept = 'text/html') {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>();
  const req = httpRequest(address, { path, method, headers: { accept } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  req.on('error', reject);
  req.end();
  return promise;
}

describe('production web build over real HTTP', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let app: FastifyInstance;
  let directory: string;
  let root: string;
  let address: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hcl-web-boundary-'));
    root = join(directory, 'dist');
    await mkdir(join(root, 'assets', 'directory'), { recursive: true });
    await writeFile(join(root, 'index.html'), html);
    await writeFile(join(root, 'assets', 'app-abcdefgh.js'), javascript);
    await writeFile(join(root, 'assets', 'app-abcdefgh.css'), 'body { color: #4c4f69; }');
    await writeFile(join(root, 'assets', 'inter-abcdefgh.woff2'), font);
    await writeFile(join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'assets', 'app.js.map'), '{"sources":["secret.ts"]}');
    await writeFile(join(root, 'assets', 'source.ts'), 'private source');
    await writeFile(join(root, '.env'), 'SESSION_SECRET=private');
    await writeFile(join(directory, 'outside.js'), 'private media or source bytes');
    await symlink(join(directory, 'outside.js'), join(root, 'assets', 'escape.js'));
    await symlink(directory, join(root, 'assets', 'escape-directory'));
    fixture = await createFixture();
    await fixture.reset();
    app = await buildApp({ db: fixture.db, boss: fixture.boss, storage: fixture.storage, config: fixture.config, serveWeb: true }, { root });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 30_000);

  it('serves every declared direct-refresh route only for explicit HTML GET/HEAD requests', async () => {
    for (const route of ['/', '/entries/1', '/entries/9007199254740993', '/entries/9223372036854775807', '/publish', '/entries/1/edit', '/likes', '/search?q=%E4%B8%AD%E6%96%87', '/login', '/register', '/settings/content']) {
      const response = await request(address, route, 'GET', 'application/json, text/html;q=0.8');
      expect(response.status, route).toBe(200);
      expect(response.body.toString()).toBe(html);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toContain('Accept');
      const head = await request(address, route, 'HEAD');
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
    }
    for (const accept of ['application/json', '*/*', 'text/*', 'application/xhtml+xml', 'application/not-text/html', 'text/html;q=0']) {
      expect((await request(address, '/entries/1', 'GET', accept)).status, accept).toBe(404);
    }
    const client = new Client(address);
    await client.session();
    expect((await client.request('/login', { method: 'POST', headers: { accept: 'text/html' } })).status).toBe(404);
  });

  it('streams exact build bytes with correct MIME and cache policy without exposing source files', async () => {
    for (const [path, bytes, mime] of [
      ['/assets/app-abcdefgh.js', javascript, /^(text|application)\/javascript/],
      ['/assets/inter-abcdefgh.woff2', font, /^font\/woff2/],
      ['/assets/app-abcdefgh.css', Buffer.from('body { color: #4c4f69; }'), /^text\/css/],
      ['/assets/logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), /^image\/svg\+xml/],
    ] as const) {
      const response = await request(address, path, 'GET', '*/*');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(bytes);
      expect(response.headers['content-type']).toMatch(mime);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cache-control']).toBe(path.endsWith('logo.svg') ? 'no-cache' : 'public, max-age=31536000, immutable');
    }
    expect((await request(address, '/assets/app-abcdefgh.js', 'HEAD', '*/*')).body.length).toBe(0);
  });

  it('returns real JSON 404 for unknown namespaces, invalid IDs, directories, dotfiles and raw or encoded traversal', async () => {
    for (const path of [
      '/unknown', '/index.html', '/api/unknown', '/api/v1/missing', '/media/unknown', '/media',
      '/assets', '/assets/', '/assets/directory', '/assets/directory/', '/assets/missing.js',
      '/.env', '/assets/.env', '/assets/source.ts', '/assets/app.js.map', '/src/main.tsx',
      '/assets/escape.js', '/assets/escape-directory/outside.js', '/outside.js',
      '/assets/../outside.js', '/assets/../login', '/assets/%2e%2e/outside.js',
      '/assets/%2e%2e%2foutside.js', '/%2e/login', '/%252e%252e/login',
      '/assets/%5c../outside.js', '/entries/%31', '/entries/0', '/entries/01',
      '/entries/9223372036854775808', '/entries/12345678901234567890', '/entries/1/other', '/login/',
    ]) {
      const response = await request(address, path);
      expect(response.status, path).toBe(404);
      expect(response.headers['content-type'], path).toMatch(/^application\/json/);
      expect(JSON.parse(response.body.toString()).error.code, path).toBe('NOT_FOUND');
    }
  });

  it('does not replace API routes, authentication headers or media validation with HTML', async () => {
    expect((await request(address, '/api/v1/health')).status).toBe(200);
    const client = new Client(address);
    const session = await client.session();
    expect(session.data.user).toBeNull();
    expect(session.response.headers.get('cache-control')).toBe('no-store');
    const denied = await request(address, '/api/v1/me/likes');
    expect(denied.status).toBe(401);
    expect(JSON.parse(denied.body.toString()).error.code).toBe('AUTH_REQUIRED');
    const media = await request(address, '/media/00000000-0000-4000-8000-000000000000/original');
    expect(media.status).toBe(404);
    expect(media.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(media.body.toString()).error.code).toBe('NOT_FOUND');
    const document = await request(address, '/api/v1/openapi.json');
    expect(document.status).toBe(200);
    expect(JSON.parse(document.body.toString()).openapi).toBeDefined();
    expect((await request(fixture.address, '/')).status).toBe(404);
  });

  it('rechecks files before serving if an asset is replaced by a symlink', async () => {
    const path = join(root, 'assets', 'app-abcdefgh.css');
    await rm(path);
    await symlink(join(directory, 'outside.js'), path);
    expect((await request(address, '/assets/app-abcdefgh.css')).status).toBe(404);
  });

  it('fails startup clearly for missing builds, absent index and symlinked index', async () => {
    for (const candidate of [join(directory, 'missing'), join(root, 'assets')]) {
      const server = Fastify();
      try {
        await expect(installWeb(server, candidate)).rejects.toThrow('Production web build is missing or invalid');
      } finally { await server.close(); }
    }
    const linked = join(directory, 'linked-dist');
    await mkdir(linked);
    await symlink(join(root, 'index.html'), join(linked, 'index.html'));
    const server = Fastify();
    try {
      await expect(installWeb(server, linked)).rejects.toThrow('Production web build is missing or invalid');
    } finally { await server.close(); }
  });
});
