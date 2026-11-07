import {fileURLToPath} from 'node:url';
import {loadConfig,createDatabase,createQueue} from '@hcl/server';
const config=loadConfig(fileURLToPath(new URL('../../../',import.meta.url)));
const {pool}=createDatabase(config.databaseUrl);await pool.query('select 1');
const boss=await createQueue(config.databaseUrl);
await boss.work('maintenance',{batchSize:1,localConcurrency:1,pollingIntervalSeconds:2},async()=>{await pool.query('delete from sessions where expires_at <= now()');await pool.query('delete from idempotency_keys where expires_at <= now()');});
console.info('Worker ready');
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,async()=>{await boss.stop();await pool.end();});
