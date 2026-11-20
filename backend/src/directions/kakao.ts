import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { coordinate, providerError, requestJson } from './provider.js';
import type { DirectionsProvider, Endpoints, RouteMode } from './provider.js';

const placesSchema = z.object({
  documents: z.array(z.object({
    place_name: z.string(), address_name: z.string(), road_address_name: z.string().optional(),
    x: coordinate(180), y: coordinate(90),
  })),
});
const routeSchema = z.looseObject({ status: z.string() });
const errorSchema = z.object({ code: z.number() });

export class KakaoDirections implements DirectionsProvider {
  readonly id = 'kakao';

  constructor(private readonly key: string) {}

  async searchPlaces(query: string) {
    const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json');
    url.search = new URLSearchParams({ query, size: '8' }).toString();
    const result = placesSchema.safeParse(await this.request(url));
    if (!result.success) throw new BadGatewayException('Invalid Kakao Maps place response');
    return result.data.documents.map(({ place_name, address_name, road_address_name, x, y }) => ({
      name: place_name, detail: road_address_name || address_name, point: [Number(x), Number(y)] as [number, number],
    }));
  }

  async findRoute(mode: RouteMode, endpoints: Endpoints) {
    const url = new URL(mode === 'walk' ? 'walk' : 'publictraffic', 'https://dapi.kakao.com/v2/routing/');
    url.search = new URLSearchParams(endpoints).toString();
    const result = routeSchema.safeParse(await this.request(url));
    if (!result.success) throw new BadGatewayException('Invalid Kakao Maps routing response');
    return result.data;
  }

  private async request(url: URL) {
    const { status, body } = await requestJson(url, {
      headers: { Authorization: `KakaoAK ${this.key}`, Accept: 'application/json' },
    });
    if (status >= 200 && status < 300) return body;
    const code = errorSchema.safeParse(body).data?.code;
    if (code === -10 || code === -11) throw providerError(429);
    if (status === 400 && code === -2) throw new BadRequestException('Kakao Maps rejected the route parameters');
    throw providerError(status);
  }
}
