import { BadGatewayException, BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { z } from 'zod';
import { coordinate, providerError, requestJson } from './provider.js';
import type { DirectionsProvider, Endpoints, GeoPoint, Place, RouteMode, RouteStep } from './provider.js';

const origin = 'https://apis.openapi.sk.com';
const coordinateSystem = 'WGS84GEO';
const noRoute = { status: 'NO_RESULTS' };

const pointSchema = z.tuple([
  z.union([z.number().min(-180).max(180), coordinate(180).transform(Number)]),
  z.union([z.number().min(-90).max(90), coordinate(90).transform(Number)]),
]);
const poiSchema = z.object({
  name: z.string().trim().min(1),
  pnsLon: z.unknown().optional(), pnsLat: z.unknown().optional(),
  frontLon: z.unknown().optional(), frontLat: z.unknown().optional(),
  noorLon: z.unknown().optional(), noorLat: z.unknown().optional(),
  upperAddrName: z.string().nullish(), middleAddrName: z.string().nullish(),
  lowerAddrName: z.string().nullish(), detailAddrName: z.string().nullish(),
  firstNo: z.string().nullish(), secondNo: z.string().nullish(),
  newAddressList: z.object({ newAddress: z.array(z.object({ fullAddressRoad: z.string().nullish() })).nullish() }).nullish(),
});
const placesSchema = z.object({
  searchPoiInfo: z.object({
    totalCount: z.union([z.string(), z.number()]).optional(),
    pois: z.object({ poi: z.array(z.unknown()).nullish() }).nullish(),
  }),
});
const pedestrianSchema = z.object({
  features: z.array(z.object({
    geometry: z.object({ type: z.string(), coordinates: z.unknown() }),
    properties: z.object({
      description: z.string().nullish(), distance: z.number().optional(),
      totalTime: z.number().optional(), totalDistance: z.number().optional(),
    }),
  })),
});
const stopSchema = z.object({ name: z.string().nullish(), lon: z.unknown().optional(), lat: z.unknown().optional() });
const passStops = z.array(stopSchema.extend({ stationName: z.string().nullish() })).nullish();
const transitLegSchema = z.object({
  mode: z.string(), route: z.string().nullish(), distance: z.number().optional(),
  start: stopSchema, end: stopSchema,
  steps: z.array(z.object({
    description: z.string().nullish(), distance: z.number().optional(), linestring: z.string().nullish(),
  })).nullish(),
  passShape: z.object({ linestring: z.string().nullish() }).nullish(),
  passStopList: z.object({ stations: passStops, stationList: passStops }).nullish(),
});
const transitSchema = z.object({
  metaData: z.object({ plan: z.object({ itineraries: z.array(z.object({
    totalTime: z.number().optional(), totalDistance: z.number().optional(), transferCount: z.number().optional(),
    fare: z.object({ regular: z.object({ totalFare: z.number().optional() }).nullish() }).nullish(),
    legs: z.array(transitLegSchema),
  })) }) }),
});
const transitErrorSchema = z.object({ result: z.object({ status: z.number() }) });

function points(coordinates: unknown[]): GeoPoint[] {
  return coordinates.flatMap(pair => {
    const { data } = pointSchema.safeParse(pair);
    return data ? [data] : [];
  });
}

function linePoints(line: string | null | undefined) {
  return points(line?.trim().split(/\s+/).map(pair => pair.split(',')) ?? []);
}

function mapPlace(raw: unknown): Place[] {
  const { data: poi } = poiSchema.safeParse(raw);
  if (!poi) return [];
  const point = points([[poi.pnsLon, poi.pnsLat], [poi.frontLon, poi.frontLat], [poi.noorLon, poi.noorLat]])
    .find(([lon, lat]) => lon !== 0 && lat !== 0);
  if (!point) return [];
  const roadAddress = poi.newAddressList?.newAddress?.find(address => address.fullAddressRoad?.trim())?.fullAddressRoad;
  const lotNumber = [poi.firstNo, poi.secondNo].filter(value => value && Number(value) !== 0).join('-');
  const lotAddress = [poi.upperAddrName, poi.middleAddrName, poi.lowerAddrName, poi.detailAddrName, lotNumber]
    .map(value => value?.trim()).filter(Boolean).join(' ');
  return [{ name: poi.name, detail: roadAddress?.trim() || lotAddress, point }];
}

function walkingStep(path: GeoPoint[], guidance?: string | null, distance?: number): RouteStep {
  return { properties: { type: 'WALKING', guidance: guidance?.trim() || undefined, distance }, path: { points: path } };
}

function routeStop(stop: z.infer<typeof stopSchema>, name = stop.name) {
  return { name: name?.trim() ?? '', point: pointSchema.safeParse([stop.lon, stop.lat]).data };
}

function transitSteps(leg: z.infer<typeof transitLegSchema>): RouteStep[] {
  const shape = linePoints(leg.passShape?.linestring);
  const end = leg.end.name?.trim();
  if (leg.mode === 'WALK') {
    const steps = (leg.steps ?? []).map(step => walkingStep(linePoints(step.linestring), step.description, step.distance));
    if (steps.length && steps.every(step => step.path.points.length >= 2)) return steps;
    return [walkingStep(shape.length >= 2 ? shape : points([[leg.end.lon, leg.end.lat]]),
      end ? `${end}까지 도보 이동` : undefined, leg.distance)];
  }
  const type = leg.mode === 'BUS' ? 'BUS' : leg.mode === 'SUBWAY' ? 'SUBWAY' : 'TRANSIT';
  const route = leg.route?.trim() || ({ BUS: '버스', SUBWAY: '지하철', TRANSIT: '대중교통' })[type];
  const start = leg.start.name?.trim();
  const guidance = [start ? `${start}에서 ${route} 탑승` : `${route} 탑승`, end && `${end}에서 하차`]
    .filter(Boolean).join(' → ');
  const stationList = leg.passStopList?.stations ?? leg.passStopList?.stationList ?? [];
  const intermediate = stationList.map(stop => routeStop(stop, stop.stationName ?? stop.name));
  const first = routeStop(leg.start), last = routeStop(leg.end);
  if (start && intermediate[0]?.name === start) {
    const duplicate = intermediate.shift()!;
    first.point ??= duplicate.point;
  }
  if (end && intermediate.at(-1)?.name === end) {
    const duplicate = intermediate.pop()!;
    last.point ??= duplicate.point;
  }
  const stops = [first, ...intermediate, last];
  const properties: RouteStep['properties'] = { type, guidance, distance: leg.distance };
  if (type === 'SUBWAY') {
    properties.stops = stops;
    properties.vehicles = leg.route ? [{ name: leg.route.trim() }] : [];
  }
  return [{
    properties,
    path: { points: shape.length >= 2 ? shape : stops.flatMap(stop => stop.point ? [stop.point] : []) },
  }];
}

export class TmapDirections implements DirectionsProvider {
  readonly id = 'tmap';

  constructor(private readonly key: string) {}

  async searchPlaces(query: string) {
    const url = new URL('/tmap/pois', origin);
    url.search = new URLSearchParams({
      version: '1', searchKeyword: query, count: '8', resCoordType: coordinateSystem, multiPoint: 'Y',
    }).toString();
    const body = await this.request(url);
    if (body === null) return [];
    const { data } = placesSchema.safeParse(body);
    if (!data) throw new BadGatewayException('Invalid TMAP place response');
    const { pois, totalCount } = data.searchPoiInfo;
    if (!pois?.poi && totalCount !== 0 && totalCount !== '0') {
      throw new BadGatewayException('Invalid TMAP place results');
    }
    return (pois?.poi ?? []).flatMap(mapPlace);
  }

  async findRoute(mode: RouteMode, endpoints: Endpoints) {
    const { start_x: startX, start_y: startY, end_x: endX, end_y: endY } = endpoints;
    const coordinates = { startX, startY, endX, endY };
    if (mode === 'transit') {
      const body = await this.request(new URL('/transit/routes', origin), { ...coordinates, count: 3, lang: 0, format: 'json' });
      const code = transitErrorSchema.safeParse(body).data?.result.status;
      if (body === null || (code !== undefined && [11, 12, 13, 14].includes(code))) return noRoute;
      const { data } = transitSchema.safeParse(body);
      if (!data) throw new BadGatewayException('Invalid TMAP transit response');
      const routes = data.metaData.plan.itineraries.map(({ legs, totalTime, totalDistance, transferCount, fare }) => {
        const totalFare = fare?.regular?.totalFare;
        return {
          properties: { totalTime, totalDistance, transfers: transferCount, fare: totalFare === undefined ? undefined : { value: totalFare } },
          steps: legs.flatMap(transitSteps),
        };
      });
      return routes.length ? { status: 'OK', routes } : noRoute;
    }

    const body = await this.request(new URL('/tmap/routes/pedestrian?version=1', origin), {
      startX: Number(startX), startY: Number(startY), endX: Number(endX), endY: Number(endY),
      reqCoordType: coordinateSystem, resCoordType: coordinateSystem,
      startName: encodeURIComponent('출발지'), endName: encodeURIComponent('도착지'), sort: 'index',
    });
    if (body === null) return noRoute;
    const { data } = pedestrianSchema.safeParse(body);
    if (!data) throw new BadGatewayException('Invalid TMAP pedestrian response');
    const steps: RouteStep[] = [];
    let guidance: string | undefined;
    for (const { geometry, properties } of data.features) {
      if (geometry.type === 'Point') {
        guidance = properties.description?.trim() || undefined;
      } else if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
        const path = points(geometry.coordinates);
        if (path.length >= 2) steps.push(walkingStep(path, guidance ?? properties.description, properties.distance));
        guidance = undefined;
      }
    }
    if (!steps.length) return noRoute;
    const summary = data.features.find(({ properties }) => properties.totalDistance !== undefined || properties.totalTime !== undefined)?.properties;
    return { status: 'OK', route: {
      properties: { totalDistance: summary?.totalDistance, totalTime: summary?.totalTime }, legs: [{ steps }],
    } };
  }

  private async request(url: URL, payload?: object) {
    const headers = { appKey: this.key, Accept: 'application/json' };
    const { status, body } = await requestJson(url, payload ? {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    } : { headers });
    if (status === 204) return null;
    const code = transitErrorSchema.safeParse(body).data?.result.status;
    if (code === 31) throw new GatewayTimeoutException('TMAP request timed out');
    if (status === 400 && code !== undefined && [21, 22, 23, 24].includes(code)) {
      throw new BadRequestException('TMAP rejected the route parameters');
    }
    if (status >= 200 && status < 300 && body !== null) return body;
    throw providerError(status);
  }
}
