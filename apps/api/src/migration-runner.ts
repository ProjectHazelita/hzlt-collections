import { migrate } from '@hcl/server';
import type { createDatabase } from '@hcl/server';
import { join } from 'node:path';
export async function migrator(db:ReturnType<typeof createDatabase>['db'],root:string){await migrate(db,{migrationsFolder:join(root,'packages/server/drizzle')});}
