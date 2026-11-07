import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgBoss } from 'pg-boss';
export * from './config.js';
export { sql } from 'drizzle-orm';
export { migrate } from 'drizzle-orm/node-postgres/migrator';
export { LocalStorage } from './storage/local-storage.js';
export * as schema from './db/schema.js';
export function createDatabase(connectionString:string){const pool=new pg.Pool({connectionString});return {pool,db:drizzle(pool)};}
export async function createQueue(connectionString:string,migrate=false){const boss=new PgBoss({connectionString,migrate});boss.on('error',error=>console.error('Queue error',error.message));await boss.start();return boss;}
export async function initializeQueues(boss:PgBoss){await boss.createQueue('asset-process',{expireInSeconds:60,retryLimit:2,retryDelay:5,retryBackoff:true});await boss.createQueue('asset-delete');await boss.createQueue('maintenance');await boss.schedule('maintenance','*/5 * * * *');}
