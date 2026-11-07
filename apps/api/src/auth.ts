import { randomBytes, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest, Session as StoredSession } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { AuthInputSchema, SessionSchema, type Session, type User } from '@hcl/contracts';
import { AuthService, DomainError, PostgresSessionStore, type Config, type Database } from '@hcl/server';

declare module 'fastify' {
  interface Session {
    userId?: string;
    csrfToken?: string;
    authExpiresAt?: number;
    anonymousExpiresAt?: number;
  }

  interface FastifyRequest {
    currentUser: User | null;
    requireUser(): User;
  }
}

export type AuthSessionData = Pick<StoredSession, 'userId' | 'csrfToken' | 'authExpiresAt' | 'anonymousExpiresAt'>;

const COOKIE_NAME = 'hzlt.sid';
const ANONYMOUS_TTL_MS = 60 * 60 * 1000;
const SAFE_METHODS: Record<string, true | undefined> = { GET: true, HEAD: true, OPTIONS: true };

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function sameToken(actual: string | string[] | undefined, expected: string | undefined): boolean {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Install on the application scope before registering any routes that use authentication. */
export async function installAuth(app: FastifyInstance, { db, config }: { db: Database; config: Config }): Promise<void> {
  const auth = new AuthService(db);
  const store = new PostgresSessionStore(db);
  const expiredRequests = new WeakSet<FastifyRequest>();
  const secure = new URL(config.publicOrigin).protocol === 'https:';
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure };

  // The HTTP-independent store snapshots cookie.toJSON() and generation metadata.
  const sessionStore: FastifyRequest['sessionStore'] = {
    get(id, callback) {
      store.get(id, (error, value) => callback(error, value as unknown as StoredSession | null | undefined));
    },
    set(id, value, callback) {
      const data = value as unknown as Record<string, unknown>;
      store.set(id, data, callback);
    },
    compareAndSet(id, generation, value, callback) {
      const data = value as unknown as Record<string, unknown>;
      store.compareAndSet(id, generation, data, callback);
    },
    destroy(id, callback) {
      store.destroy(id, callback);
    },
  };

  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookieName: COOKIE_NAME,
    cookie: { ...cookieOptions, maxAge: ANONYMOUS_TTL_MS },
    saveUninitialized: false,
    rolling: false,
    store: sessionStore,
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('currentUser', null);
  app.decorateRequest('requireUser', function (this: FastifyRequest): User {
    if (this.currentUser) return this.currentUser;
    if (expiredRequests.has(this)) throw new DomainError(401, 'SESSION_EXPIRED', 'Your session has expired.');
    throw new DomainError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  });

  app.addHook('onRequest', async (request, reply) => {
    const current = request.session;
    if (!current.isPersisted()) {
      if (request.cookies[COOKIE_NAME] !== undefined) expiredRequests.add(request);
      return;
    }

    const expiresAt = current.userId ? current.authExpiresAt : current.anonymousExpiresAt;
    const expired = typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    if (!expired && current.userId) request.currentUser = await auth.getUser(current.userId);
    if (expired || (current.userId && !request.currentUser)) {
      expiredRequests.add(request);
      await current.destroy();
      reply.clearCookie(COOKIE_NAME, cookieOptions);
    }
  });

  // Global to this application scope, including future entry and upload routes.
  // Run before parsing bodies, so untrusted multipart streams do not reach handlers.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS[request.method]) return;
    if (request.headers.origin !== config.publicOrigin) {
      throw new DomainError(403, 'FORBIDDEN', 'The request origin is not allowed.');
    }
    if (expiredRequests.has(request)) throw new DomainError(401, 'SESSION_EXPIRED', 'Your session has expired.');
    if (!sameToken(request.headers['x-csrf-token'], request.session?.csrfToken)) {
      throw new DomainError(403, 'FORBIDDEN', 'The CSRF token is missing or invalid.');
    }
  });

  async function saveSession(request: FastifyRequest, reply: FastifyReply, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      request.currentUser = null;
      expiredRequests.add(request);
      // The stable store key may now belong to a newer generation. Do not destroy it,
      // and do not let the plugin retry this request's stale save in onSend.
      // The plugin's destroy implementation also uses null, despite its declaration.
      const nullableRequest = request as { session: FastifyRequest['session'] | null };
      nullableRequest.session = null;
      reply.clearCookie(COOKIE_NAME, cookieOptions);
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new DomainError(401, 'SESSION_EXPIRED', 'Your session has expired.');
      }
      throw error;
    }
  }

  async function establishIdentity(request: FastifyRequest, reply: FastifyReply, user: User): Promise<Session> {
    await saveSession(request, reply, async () => {
      await request.session.regenerate();
      request.session.userId = user.id;
      request.session.csrfToken = newToken();
      request.session.authExpiresAt = Date.now() + config.sessionTtlSeconds * 1000;
      delete request.session.anonymousExpiresAt;
      request.session.cookie.maxAge = config.sessionTtlSeconds * 1000;
      await request.session.save();
    });
    request.currentUser = user;
    return { user, csrfToken: request.session.csrfToken! };
  }

  const routes = app.withTypeProvider<TypeBoxTypeProvider>();
  routes.get('/api/v1/auth/session', { schema: { response: { 200: SessionSchema } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.session || !request.session.csrfToken || !request.session.isPersisted()) {
      await saveSession(request, reply, async () => {
        // destroy() sets request.session to null; a fresh plugin session is needed.
        if (!request.session) {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          app.decryptSession('', request, (error: unknown) => error ? reject(error) : resolve());
          await promise;
        }
        request.session.csrfToken = newToken();
        request.session.anonymousExpiresAt = Date.now() + ANONYMOUS_TTL_MS;
        request.session.cookie.maxAge = ANONYMOUS_TTL_MS;
        await request.session.save();
      });
    }
    return { user: request.currentUser, csrfToken: request.session.csrfToken! };
  });

  routes.post('/api/v1/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } },
    schema: { body: AuthInputSchema, response: { 201: SessionSchema } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const user = await auth.register(request.body);
    const result = await establishIdentity(request, reply, user);
    return reply.code(201).send(result);
  });

  routes.post('/api/v1/auth/login', {
    config: { rateLimit: { max: 30, timeWindow: 5 * 60 * 1000 } },
    schema: { body: AuthInputSchema, response: { 200: SessionSchema } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return establishIdentity(request, reply, await auth.login(request.body));
  });

  routes.post('/api/v1/auth/logout', async (request, reply) => {
    await request.session.destroy();
    request.currentUser = null;
    reply.header('Cache-Control', 'no-store');
    return reply.clearCookie(COOKIE_NAME, cookieOptions).code(204).send();
  });
}
