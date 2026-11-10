import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = new URL('../.env', import.meta.url);
const administratorPassword = randomBytes(32).toString('hex');
const applicationPassword = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(48).toString('hex');

const contents = `# Generated locally. Do not commit or copy this file into an image.
POSTGRES_PASSWORD=${administratorPassword}
HCL_DB_PASSWORD=${applicationPassword}
DATABASE_URL=postgresql://hcl:${applicationPassword}@127.0.0.1:55432/hcl
TEST_DATABASE_URL=postgresql://hcl:${applicationPassword}@127.0.0.1:55432/hcl_test
SESSION_SECRET=${sessionSecret}
PUBLIC_ORIGIN=http://127.0.0.1:5173
DATA_DIR=var/media
API_PORT=3000
API_HOST_PORT=3000
WEB_PORT=5173
DEV_DB_PORT=55432
PRODUCTION_ORIGIN=http://127.0.0.1:18080
HTTP_PORT=18080
TRUST_PROXY=false
MAX_UPLOAD_BYTES=20971520
MAX_IMAGE_PIXELS=40000000
MAX_IMAGE_DIMENSION=20000
IMAGE_TIMEOUT_MS=30000
SESSION_TTL_SECONDS=604800
`;

try {
  await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${fileURLToPath(destination)} with private, randomly generated secrets.`);
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
  console.log('Existing .env preserved; no values were changed.');
}
