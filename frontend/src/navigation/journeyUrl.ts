import type { JourneyProgress, Place, RouteMode } from './routes';

export type Endpoint = 'origin' | 'destination';
export type JourneyView = 'home' | 'map' | 'indoor' | 'transfer' | 'field';

export function encodePlace(place: Place) {
  return JSON.stringify([...place.point, place.name, place.detail]);
}

export function decodePlace(value: string | null): Place | undefined {
  if (!value) return;
  try {
    const data: unknown = JSON.parse(value);
    if (!Array.isArray(data) || data.length !== 4) return;
    const [lon, lat, name, detail] = data;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90 ||
        typeof name !== 'string' || !name.trim() || typeof detail !== 'string') return;
    return { point: [lon, lat], name, detail };
  } catch { return; }
}

export function journeyView(value: string | null, hasEndpoints: boolean): JourneyView {
  if (value === 'ar') return 'field'; // Published recording-camera links.
  if (value === 'indoor') return 'indoor';
  if ((value === 'map' || value === 'transfer') && hasEndpoints) return value;
  return 'home';
}

export function routeKey(origin: Place, destination: Place, mode: RouteMode) {
  return JSON.stringify([encodePlace(origin), encodePlace(destination), mode]);
}

export function integerParam(value: string | null, min: number, max: number) {
  if (value === null || !/^-?\d+$/.test(value)) return;
  const n = Number(value);
  if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
}

export function readProgress(params: URLSearchParams, steps: number): JourneyProgress {
  return {
    step: Math.min(steps, integerParam(params.get('step'), 0, Number.MAX_SAFE_INTEGER) ?? 0),
    station: params.get('station') || undefined,
    stopIndex: integerParam(params.get('stop'), -1, Number.MAX_SAFE_INTEGER),
    tagTime: integerParam(params.get('tagTime'), 0, Date.now()),
  };
}

export const clearGuidance = {
  map: null, step: null, station: null, stop: null, tagTime: null, scan: null, panel: null,
  target: null, targetSpace: null, preferredSpace: null, dialog: null, passage: null, stage: null,
};

export const clearJourney = {
  ...clearGuidance, from: null, to: null, mode: null, autoOrigin: null, pick: null,
  q: null, search: null, view: null, space: null,
};

export const journeyCache = 'station-journey-v1';
export const chatCache = 'station-route-chat-v1';
