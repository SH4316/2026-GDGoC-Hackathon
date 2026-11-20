import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { DirectionsFileCache } from './file-cache.js';
import { KakaoDirections } from './kakao.js';
import type { DirectionsProvider, Endpoints, RouteMode } from './provider.js';
import { TmapDirections } from './tmap.js';

function readSettings() {
  const envFile = new URL('../../../.env', import.meta.url);
  const settings = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  return { ...settings, ...process.env };
}

function configureProvider(settings: NodeJS.ProcessEnv): DirectionsProvider | undefined {
  const tmapKey = settings.TMAP_APP_KEY?.trim();
  if (tmapKey) return new TmapDirections(tmapKey);
  const kakaoKey = settings.KAKAO_REST_API_KEY?.trim();
  if (kakaoKey) return new KakaoDirections(kakaoKey);
}

@Injectable()
export class DirectionsService {
  private readonly provider?: DirectionsProvider;
  private readonly cache?: DirectionsFileCache;

  constructor() {
    const settings = readSettings();
    this.provider = configureProvider(settings);
    if (settings.DIRECTIONS_TEST_CACHE === '1') {
      const root = fileURLToPath(new URL('../../../', import.meta.url));
      this.cache = new DirectionsFileCache(resolve(root, settings.DIRECTIONS_CACHE_DIR?.trim() || 'data/directions-cache'));
    }
  }

  async searchPlaces(query: string) {
    const provider = this.activeProvider();
    const load = () => provider.searchPlaces(query);
    return this.cache ? this.cache.getOrLoad(provider.id, 'places', [query], load) : load();
  }

  async findRoute(mode: RouteMode, query: Endpoints) {
    const provider = this.activeProvider();
    const load = () => provider.findRoute(mode, query);
    const { start_x, start_y, end_x, end_y } = query;
    const result = this.cache
      ? await this.cache.getOrLoad(provider.id, mode, [start_x, start_y, end_x, end_y].map(value => String(Number(value))), load)
      : await load();
    return { ...result, provider: provider.id };
  }

  private activeProvider() {
    if (!this.provider) throw new ServiceUnavailableException('Set TMAP_APP_KEY or KAKAO_REST_API_KEY on the server');
    return this.provider;
  }
}
