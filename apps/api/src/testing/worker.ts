import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { createFixture } from './fixture.js';

export async function launchWorker(fixture: Awaited<ReturnType<typeof createFixture>>, built = false) {
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = '';
  const entry = join(fixture.config.root, `apps/worker/${built ? 'dist/main.js' : 'src/main.ts'}`);
  const child = spawn(process.execPath, [...(built ? [] : ['--import', 'tsx']), entry], {
    env: {
      ...process.env, NODE_ENV: built ? 'production' : 'development', DATABASE_URL: fixture.config.databaseUrl, DATA_DIR: fixture.storage.root,
      MAX_IMAGE_PIXELS: String(fixture.config.maxImagePixels), MAX_IMAGE_DIMENSION: String(fixture.config.maxImageDimension),
      IMAGE_TIMEOUT_MS: String(fixture.config.imageTimeoutMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startupDeadline = setTimeout(() => {
    child.kill('SIGKILL');
    ready.reject(new Error('Worker readiness deadline exceeded: ' + output));
  }, 15_000);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      output = (output + String(chunk)).slice(-16_384);
      if (output.includes('Worker ready')) {
        clearTimeout(startupDeadline);
        ready.resolve();
      }
    });
  }
  child.once('error', error => { clearTimeout(startupDeadline); ready.reject(error); exited.reject(error); });
  child.once('exit', (code, signal) => {
    clearTimeout(startupDeadline);
    exited.resolve({ code, signal });
    ready.reject(new Error(`Worker exited before readiness (${code ?? signal}): ${output}`));
  });
  await ready.promise;
  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return exited.promise;
      const deadline = setTimeout(() => child.kill('SIGKILL'), 40_000);
      child.kill('SIGTERM');
      const result = await exited.promise;
      clearTimeout(deadline);
      if (result.signal === 'SIGKILL') throw new Error('Worker failed graceful shutdown: ' + output);
      return result;
    },
  };
}
