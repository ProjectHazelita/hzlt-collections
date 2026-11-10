import { createHash } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { idempotencyKeys } from './db/schema.js';
import { DomainError } from './errors.js';
import type { Database } from './index.js';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Object property order must not turn the same logical JSON request into a conflict. */
export function hashInput(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, current: unknown) => {
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return current;
  });
  if (serialized === undefined) throw new Error('Idempotency input must be JSON');
  return createHash('sha256').update(serialized).digest('hex');
}

export async function withIdempotency<T>(
  db: Database,
  options: {
    userId: string;
    operation: string;
    key: string;
    requestHash: string;
    statusCode: number;
  },
  validate: (value: unknown) => value is T,
  action: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // This transaction lock also serializes the not-yet-inserted key; hash collisions only
    // serialize unrelated requests and never change which composite key is read/written.
    const scope = JSON.stringify([options.userId, options.operation, options.key]);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
    const predicate = and(
      eq(idempotencyKeys.userId, options.userId),
      eq(idempotencyKeys.operation, options.operation),
      eq(idempotencyKeys.key, options.key),
    );
    await tx
      .delete(idempotencyKeys)
      .where(and(predicate, lte(idempotencyKeys.expiresAt, sql`now()`)));
    const [existing] = await tx.select().from(idempotencyKeys).where(predicate).limit(1);
    if (existing) {
      if (existing.requestHash !== options.requestHash) {
        throw new DomainError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '该提交标识已用于不同的内容，请重新提交。',
        );
      }
      const response = existing.response;
      if (existing.httpStatus !== options.statusCode || !validate(response)) {
        throw new Error('Invalid persisted idempotency response');
      }
      return response;
    }
    const response = await action(tx);
    if (!validate(response)) throw new Error('Invalid idempotent operation response');
    await tx.insert(idempotencyKeys).values({
      userId: options.userId,
      operation: options.operation,
      key: options.key,
      requestHash: options.requestHash,
      httpStatus: options.statusCode,
      response,
      expiresAt: sql`now() + interval '24 hours'`,
    });
    return response;
  });
}
