import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const workerRequire = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const serverRequire = createRequire(new URL('../packages/server/package.json', import.meta.url));
const sharp = workerRequire('sharp');
const argon2 = serverRequire('argon2');
const png = await sharp({
  create: { width: 2, height: 2, channels: 4, background: { r: 100, g: 50, b: 200, alpha: 1 } },
})
  .png()
  .toBuffer();
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
assert.equal(info.width, 2);
assert.equal(info.height, 2);
assert.deepEqual([...data.subarray(0, 4)], [100, 50, 200, 255]);
const hash = await argon2.hash('native-smoke-password', {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
assert(await argon2.verify(hash, 'native-smoke-password'));
assert.equal(await argon2.verify(hash, 'wrong-password'), false);
console.log('Sharp 2×2 PNG encode/decode and Argon2id hash/verify passed.');
