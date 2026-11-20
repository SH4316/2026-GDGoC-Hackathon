import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TemporaryProviderError, type DirectionsProvider, type RouteMode, type RouteResult } from './provider.js';

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
    const pathFor = (version: number) => {
      const hash = createHash('sha256').update(JSON.stringify([version, provider, operation, input])).digest('hex');
      return join(this.directory, `${provider}-${operation}-${hash}.json`);
    };
    const path = pathFor(version);
    const pending = this.pending.get(path);
    if (pending) return pending as Promise<T>;

    const result = this.readOrWrite(path, load).catch(async error => {
      if (version === 2 && error instanceof TemporaryProviderError) {
        const previous: RouteResult | undefined = await this.read(pathFor(1));
        if (previous?.status === 'OK' && Array.isArray(previous.routes) &&
          previous.routes.some(route => Array.isArray(route?.steps) && route.steps.some(step => step?.path?.points?.length >= 2))) {
          return previous as T;
        }
      }
      throw error;
    });
    this.pending.set(path, result);
    try {
      return await result;
    } finally {
      this.pending.delete(path);
    }
  }

  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async readOrWrite<T>(path: string, load: () => Promise<T>): Promise<T> {
    const saved = await this.read<T>(path);
    if (saved !== undefined) return saved;
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
