import { join } from 'node:path';
import type { createDatabase } from '@hcl/server';
import { migrate } from '@hcl/server';
export async function migrator(db: ReturnType<typeof createDatabase>['db'], root: string) {
  await migrate(db, { migrationsFolder: join(root, 'packages/server/drizzle') });
}
