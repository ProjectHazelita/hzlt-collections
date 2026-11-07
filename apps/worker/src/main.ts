import { fileURLToPath } from 'node:url';
import type { PgBoss } from 'pg-boss';
import { loadConfig, createDatabase, createQueue, LocalStorage } from '@hcl/server';
import { startWorker, type WorkerHandle } from './worker.js';

const config = loadConfig(fileURLToPath(new URL('../../../', import.meta.url)));
const { db, pool } = createDatabase(config.databaseUrl);
let boss: PgBoss | undefined;
let worker: WorkerHandle | undefined;
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= (async () => {
  try {
    // Abort and reap all native children before closing their queue/database owners.
    await worker?.stop();
  } finally {
    try { await boss?.stop(); }
    finally { await pool.end(); }
  }
})();

try {
  await pool.query('select 1');
  boss = await createQueue(config.databaseUrl);
  worker = await startWorker({ db, boss, storage: new LocalStorage(config.dataDir), config });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void stop().catch(error => {
        console.error('Worker shutdown failed', error instanceof Error ? error.message : 'Unknown error');
        process.exitCode = 1;
      });
    });
  }
  console.info('Worker ready');
} catch (error) {
  await stop();
  throw error;
}
