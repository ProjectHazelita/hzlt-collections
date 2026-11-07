import { fileURLToPath } from 'node:url';
import { createDatabase, createQueue, initializeQueues, loadConfig } from '@hcl/server';
import { migrator } from './migration-runner.js';

const config = loadConfig(fileURLToPath(new URL('../../../', import.meta.url)));
const { pool, db } = createDatabase(config.databaseUrl);
try {
  await migrator(db, config.root);
  const boss = await createQueue(config.databaseUrl, true);
  try {
    await initializeQueues(boss);
  } finally {
    await boss.stop();
  }
} finally {
  await pool.end();
}
