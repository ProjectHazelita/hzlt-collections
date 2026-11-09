import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { sessions } from '../db/schema.js';
import type { Database } from '../index.js';

export type SessionPayload = Record<string, unknown>;
type WriteCallback = (error?: Error | null) => void;
type ReadCallback = (error: Error | null, session?: SessionPayload | null) => void;

function storeError(code: 'ENOENT' | 'EINVAL', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: 'SessionStoreError', code });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Session persistence failed', { cause: error });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8.64e15)
    return value;
  if (typeof value === 'string') {
    const date = new Date(value);
    const milliseconds = date.getTime();
    // No locale-dependent date parsing, numeric strings, seconds or relative TTLs.
    if (Number.isFinite(milliseconds) && milliseconds > 0 && date.toISOString() === value)
      return milliseconds;
  }
  throw storeError(
    'EINVAL',
    'Session expiry must be epoch milliseconds or a canonical ISO timestamp',
  );
}

function snapshot(session: SessionPayload): {
  payload: SessionPayload;
  generation: string;
  expiresAt: Date;
} {
  // The plugin Cookie has toJSON(); serializing also excludes its methods and internal symbols.
  // Do not rebuild cookie/metadata objects: the plugin needs all of their persisted fields.
  const serialized: unknown = JSON.parse(JSON.stringify(session));
  if (!isObject(serialized)) throw storeError('EINVAL', 'Session payload must be an object');
  const metadata = serialized.__fastifySessionMetadata;
  if (
    !isObject(metadata) ||
    typeof metadata.generation !== 'string' ||
    !metadata.generation.length
  ) {
    throw storeError('EINVAL', 'Session generation metadata is required');
  }
  const cookie = serialized.cookie;
  if (!isObject(cookie)) throw storeError('EINVAL', 'Session cookie is required');
  const expiries: number[] = [];
  for (const key of ['authExpiresAt', 'anonymousExpiresAt'] as const) {
    if (Object.hasOwn(serialized, key)) expiries.push(timestamp(serialized[key]));
  }
  if (cookie.expires !== undefined && cookie.expires !== null)
    expiries.push(timestamp(cookie.expires));
  // regenerate() initially saves only the new generation and cookie; the HTTP layer installs
  // the new auth deadline in its subsequent CAS save. A finite cookie deadline is mandatory then.
  if (!expiries.length) throw storeError('EINVAL', 'Session requires an absolute expiry');
  return {
    payload: serialized,
    generation: metadata.generation,
    expiresAt: new Date(Math.min(...expiries)),
  };
}

export class PostgresSessionStore {
  constructor(private readonly db: Database) {}

  get(id: string, callback: ReadCallback): void {
    void this.read(id).then(
      (session) => callback(null, session),
      (error) => callback(asError(error)),
    );
  }

  set(id: string, session: SessionPayload, callback: WriteCallback): void {
    void this.insert(id, session).then(
      () => callback(null),
      (error) => callback(asError(error)),
    );
  }

  destroy(id: string, callback: WriteCallback): void {
    void this.db
      .delete(sessions)
      .where(eq(sessions.storeId, id))
      .then(
        () => callback(null),
        (error) => callback(asError(error)),
      );
  }

  compareAndSet(
    id: string,
    expectedGeneration: string,
    session: SessionPayload,
    callback: WriteCallback,
  ): void {
    void this.update(id, expectedGeneration, session).then(
      () => callback(null),
      (error) => callback(asError(error)),
    );
  }

  async destroyForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.db
      .delete(sessions)
      .where(
        and(
          sql`${sessions.payload}->>'userId' = ${userId}`,
          exceptSessionId ? ne(sessions.storeId, exceptSessionId) : undefined,
        ),
      );
  }

  private async read(id: string): Promise<SessionPayload | null> {
    const [row] = await this.db
      .select({ payload: sessions.payload, generation: sessions.generation })
      .from(sessions)
      .where(and(eq(sessions.storeId, id), gt(sessions.expiresAt, sql`now()`)))
      .limit(1);
    if (!row) return null;
    if (!isObject(row.payload)) throw storeError('EINVAL', 'Invalid stored session payload');
    const saved = snapshot(row.payload);
    if (saved.generation !== row.generation)
      throw storeError('EINVAL', 'Stored session generation mismatch');
    return saved.expiresAt.getTime() > Date.now() ? saved.payload : null;
  }

  private async insert(id: string, session: SessionPayload): Promise<void> {
    const saved = snapshot(session);
    if (saved.expiresAt.getTime() <= Date.now()) throw storeError('ENOENT', 'Session has expired');
    // set is solely the first insertion, never an upsert or a refresh of an existing ID.
    const [created] = await this.db
      .insert(sessions)
      .values({ storeId: id, ...saved })
      .onConflictDoNothing({ target: sessions.storeId })
      .returning({ storeId: sessions.storeId });
    if (!created) throw storeError('ENOENT', 'Session already exists');
  }

  private async update(
    id: string,
    expectedGeneration: string,
    session: SessionPayload,
  ): Promise<void> {
    const saved = snapshot(session);
    if (saved.expiresAt.getTime() <= Date.now()) throw storeError('ENOENT', 'Session has expired');
    // A destroyed, expired or regenerated session cannot be resurrected by a late request.
    const [updated] = await this.db
      .update(sessions)
      .set(saved)
      .where(
        and(
          eq(sessions.storeId, id),
          eq(sessions.generation, expectedGeneration),
          gt(sessions.expiresAt, sql`now()`),
          sql`${saved.expiresAt}::timestamptz > now()`,
        ),
      )
      .returning({ storeId: sessions.storeId });
    if (!updated) throw storeError('ENOENT', 'Session is missing, expired or has changed');
  }
}
