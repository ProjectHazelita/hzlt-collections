import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';

export { sql } from 'drizzle-orm';
export { migrate } from 'drizzle-orm/node-postgres/migrator';
export * from './config.js';
export * as schema from './db/schema.js';
export { DomainError } from './errors.js';
export { LocalStorage } from './storage/local-storage.js';
export type Database = ReturnType<typeof createDatabase>['db'];
export { AssetService } from './assets/service.js';
export { AuthService } from './auth/service.js';
export { PostgresSessionStore } from './auth/session-store.js';
export { CommentService } from './comments/service.js';
export { EntryService } from './entries/service.js';
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { pool, db: drizzle(pool) };
}
export async function createQueue(connectionString: string, migrate = false) {
  const boss = new PgBoss({ connectionString, migrate });
  boss.on('error', (error) => console.error('Queue error', error.message));
  await boss.start();
  return boss;
}
export async function initializeQueues(boss: PgBoss) {
  await boss.createQueue('asset-process', {
    expireInSeconds: 60,
    retryLimit: 2,
    retryDelay: 5,
    retryBackoff: true,
  });
  await boss.createQueue('asset-delete');
  await boss.createQueue('maintenance');
  await boss.schedule('maintenance', '*/5 * * * *');
}
