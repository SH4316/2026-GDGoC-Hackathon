import { z } from 'zod';
import type { DirectionsService } from '../directions/service.js';
import type { Place, RouteMode, RouteResult, RouteStep } from '../directions/provider.js';

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
export const place = z.strictObject({
  name: z.string().trim().min(1).max(240), detail: z.string().max(500), point,
});
const query = z.strictObject({ query: z.string().trim().min(1).max(80) });
const endpoints = z.strictObject({
  origin_id: z.string().min(1).max(40), destination_id: z.string().min(1).max(40),
  mode: z.enum(['walk', 'transit']),
});

function tool(name: string, description: string, schema: typeof query | typeof endpoints) {
  return { type: 'function', function: { name, description, parameters: z.toJSONSchema(schema, { target: 'draft-7' }) } };
}

export const tools = [
  tool('search_places', 'Search the configured map provider for a named place or station. Returns IDs, names and addresses for this turn.', query),
  tool('search_information', 'Search Korean Wikipedia for published background on stations, lines and places. Returns article extracts and sources. For live schedules, tell the user live data is unavailable.', query),
  tool('propose_route', 'Look up a real route using two place IDs from this turn. On success the user gets a card they can accept to start guidance. Use when the user wants a route.', endpoints),
];

const articleResponse = z.object({ query: z.object({ pages: z.array(z.object({
  title: z.string(), pageid: z.number().int().positive(), index: z.number(), extract: z.string().optional(),
})) }).optional() });

async function searchInformation(term: string, signal: AbortSignal) {
  const url = new URL('https://ko.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2',
    generator: 'search', gsrsearch: term, gsrlimit: '3', prop: 'extracts', exintro: '1',
    explaintext: '1', exchars: '500', exlimit: '3' }).toString();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: { 'User-Agent': 'StationNavigation/1.0 (station route information search)' } });
  if (!response.ok) throw new Error('Search unavailable');
  const result = articleResponse.parse(await response.json());
  return (result.query?.pages ?? []).sort((a, b) => a.index - b.index).map(page => ({
    title: page.title, url: 'https://ko.wikipedia.org/?curid=' + page.pageid, extract: page.extract ?? '',
  }));
}

function mappable(steps: RouteStep[] | undefined) {
  return steps?.some(step => step?.path?.points?.filter(p => point.safeParse(p).success).length >= 2);
}

function selectRoute(result: RouteResult, mode: RouteMode) {
  if (result.status !== 'OK') return;
  if (mode === 'walk') {
    if (mappable(result.route?.legs?.flatMap(leg => leg.steps))) return { status: 'OK', route: result.route };
  } else {
    const route = result.routes?.find(option => mappable(option.steps));
    if (route) return { status: 'OK', routes: [route] };
  }
}

export type SearchSource = { title: string; url: string };
export type Proposal = {
  origin: Place; destination: Place; mode: RouteMode; data: RouteResult & { provider: 'kakao' | 'tmap' };
};

export class RouteTools {
  readonly places = new Map<string, Place>();
  readonly sources = new Map<string, SearchSource>();
  proposal?: Proposal;

  constructor(private readonly directions: DirectionsService) {}

  async execute(name: string, args: unknown, signal: AbortSignal) {
    if (name === 'propose_route') {
      const parsed = endpoints.safeParse(args);
      if (!parsed.success) return { error: '출발지·도착지 ID와 이동 수단을 확인하세요.' };
      const { origin_id, destination_id, mode } = parsed.data;
      const origin = this.places.get(origin_id), destination = this.places.get(destination_id);
      if (!origin || !destination) return { error: '장소 검색 결과 또는 선택된 장소의 ID를 사용하세요.' };
      const [x, y] = origin.point, [endX, endY] = destination.point;
      if (x === endX && y === endY) return { error: '출발지와 도착지가 같습니다.' };
      const result = await this.directions.findRoute(mode, {
        start_x: x.toFixed(7), start_y: y.toFixed(7), end_x: endX.toFixed(7), end_y: endY.toFixed(7),
      });
      const route = selectRoute(result, mode);
      if (!route) return { error: '이 구간에서 지도에 표시할 수 있는 경로를 찾지 못했습니다. 다른 지점이나 이동 수단을 물어보세요.' };
      this.proposal = { origin, destination, mode, data: { ...route, provider: result.provider } };
      return { proposed: true };
    }
    const parsed = query.safeParse(args);
    if (!parsed.success) return { error: '1~80자의 검색어가 필요합니다.' };
    if (name === 'search_places') {
      const results = await this.directions.searchPlaces(parsed.data.query);
      return { places: results.slice(0, 8).map(place => {
        const id = 'place_' + this.places.size;
        this.places.set(id, place);
        return { id, name: place.name, address: place.detail };
      }) };
    }
    if (name === 'search_information') {
      const articles = await searchInformation(parsed.data.query, signal);
      for (const { title, url } of articles) this.sources.set(url, { title, url });
      return { articles };
    }
    return { error: '지원하지 않는 도구입니다.' };
  }
}
