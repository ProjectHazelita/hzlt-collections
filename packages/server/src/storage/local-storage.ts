import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
export class LocalStorage {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  path(key: string) {
    if (
      !/^(tmp\/[0-9a-f-]+|originals\/[0-9a-f-]+\.bin|variants\/[0-9a-f-]+\/[0-9a-f-]+\.webp)$/.test(
        key,
      )
    )
      throw new Error('Invalid generated storage key');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Storage path outside root');
    return path;
  }
  async initialize() {
    for (const key of ['tmp', 'originals', 'variants'])
      await mkdir(resolve(this.root, key), { recursive: true, mode: 0o700 });
  }
  async create(key: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return createWriteStream(path, { flags: 'wx', mode: 0o600 });
  }
  read(key: string) {
    return createReadStream(this.path(key));
  }
  async move(from: string, to: string) {
    await mkdir(dirname(this.path(to)), { recursive: true, mode: 0o700 });
    await rename(this.path(from), this.path(to));
  }
  async remove(key: string) {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async info(key: string) {
    return stat(this.path(key));
  }
  async files() {
    const walk = async (path: string): Promise<string[]> => {
      const found = await readdir(path, { withFileTypes: true });
      const result: string[] = [];
      for (const item of found) {
        const full = resolve(path, item.name);
        if (item.isDirectory()) result.push(...(await walk(full)));
        else if (item.isFile()) result.push(relative(this.root, full));
      }
      return result;
    };
    return walk(this.root);
  }
}
