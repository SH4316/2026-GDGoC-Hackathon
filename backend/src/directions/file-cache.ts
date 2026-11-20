import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirectionsProvider, RouteMode } from './provider.js';

export class DirectionsFileCache {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async getOrLoad<T>(
    provider: DirectionsProvider['id'],
    operation: 'places' | RouteMode,
    input: readonly string[],
    load: () => Promise<T>,
  ): Promise<T> {
    // Older TMAP transit entries discarded station names and coordinates.
    const version = provider === 'tmap' && operation === 'transit' ? 2 : 1;
    const hash = createHash('sha256').update(JSON.stringify([version, provider, operation, input])).digest('hex');
    const path = join(this.directory, `${provider}-${operation}-${hash}.json`);
    const pending = this.pending.get(path);
    if (pending) return pending as Promise<T>;

    const result = this.readOrWrite(path, load);
    this.pending.set(path, result);
    try {
      return await result;
    } finally {
      this.pending.delete(path);
    }
  }

  private async readOrWrite<T>(path: string, load: () => Promise<T>): Promise<T> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const value = await load();
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return value;
  }
}
