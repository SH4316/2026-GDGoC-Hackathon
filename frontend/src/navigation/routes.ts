export type GeoPoint = [longitude: number, latitude: number];
export type Place = { name: string; detail: string; point: GeoPoint };
export type RouteMode = 'transit' | 'walk';
type RouteProvider = 'kakao' | 'tmap';
type RouteStop = { name: string; point?: GeoPoint };
export type RouteStep = {
  instruction: string; kind: '도보' | '지하철' | '버스' | '대중교통'; points: GeoPoint[]; meters?: number;
  rail?: { stops: RouteStop[]; lines: string[] };
};
export type Journey = {
  origin: Place; destination: Place; mode: RouteMode;
  provider?: RouteProvider;
  steps: RouteStep[]; meters?: number; seconds?: number;
};
export type JourneyProgress = {
  step: number; position?: GeoPoint;
  station?: string; stopIndex?: number; tagTime?: number;
};

export async function directionsApi<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(import.meta.env.BASE_URL + 'api/directions' + path, { signal, cache: 'no-store' }); }
  catch { throw new Error('길찾기 서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도하세요.'); }
  if (response.status === 503) throw new Error('길찾기 서비스에 연결할 수 없습니다. 서버의 API 키와 사용 설정을 확인하세요.');
  if (response.status === 429) throw new Error('길찾기 요청이 많습니다. 잠시 후 다시 시도하세요.');
  if (!response.ok) throw new Error('길찾기 서버에서 응답을 받지 못했습니다. 잠시 후 다시 시도하세요.');
  return response.json();
}

type ApiStep = {
  properties?: { guidance?: string; type?: string; distance?: number; stops?: RouteStop[]; vehicles?: { name: string }[] };
  path?: { points?: unknown[] };
};
type ApiRoute = {
  properties?: { totalDistance?: number; totalTime?: number };
  legs?: { steps?: ApiStep[] }[]; steps?: ApiStep[];
};
type ApiResponse = { status?: string; provider?: RouteProvider; route?: ApiRoute; routes?: ApiRoute[] };
const geoPoint = (p: unknown): p is GeoPoint => Array.isArray(p) && p.length === 2 &&
  Number.isFinite(p[0]) && Math.abs(p[0]) <= 180 && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90;

// Older normalized TMAP responses retained the adapter's exact instruction and polyline,
// but omitted structured stops. Recover endpoints only for two connecting subway legs.
function recoverCachedTransferStops(steps: RouteStep[]) {
  function cachedLeg(step: RouteStep) {
    if (step.kind !== '지하철' || step.rail || step.points.length < 2) return;
    const match = /^(.+?)에서 (.+?) 탑승 → (.+?)에서 하차$/.exec(step.instruction);
    if (!match) return;
    const [first, last] = [step.points[0], step.points.at(-1)!];
    return { step, from: { name: match[1], point: first }, to: { name: match[3], point: last }, line: match[2] };
  }
  let previous: ReturnType<typeof cachedLeg>;
  for (const step of steps) {
    if (step.kind === '도보') continue;
    const next = cachedLeg(step);
    // Platforms in one interchange can be hundreds of metres apart.
    if (previous && next && previous.to.name === next.from.name && distanceMeters(previous.to.point, next.from.point) <= 1000) {
      for (const leg of [previous, next]) {
        leg.step.rail = { stops: [leg.from, leg.to], lines: [leg.line] };
      }
    }
    previous = next;
  }
}

export async function findRoute(origin: Place, destination: Place, mode: RouteMode, signal: AbortSignal): Promise<Journey> {
  const [x, y] = origin.point, [endX, endY] = destination.point;
  if (x === endX && y === endY) throw new Error('출발지와 도착지가 같습니다. 다른 지점을 선택하세요.');
  const query = new URLSearchParams({ start_x: x.toFixed(7), start_y: y.toFixed(7), end_x: endX.toFixed(7), end_y: endY.toFixed(7) });
  const data = await directionsApi<ApiResponse>('/' + mode + '?' + query, signal);
  return readRoute(data, origin, destination, mode);
}

export function readRoute(data: ApiResponse, origin: Place, destination: Place, mode: RouteMode): Journey {
  if (data.status !== 'OK') throw new Error('이 구간의 경로를 찾을 수 없습니다. 이동 수단이나 출발·도착지를 변경하세요.');
  const candidates = mode === 'walk' ? [data.route] : data.routes ?? [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const rows = mode === 'walk' ? candidate.legs?.flatMap(leg => leg.steps ?? []) : candidate.steps;
    if (!rows?.length) continue;
    const steps: RouteStep[] = rows.map(row => {
      const p = row.properties;
      const kind = mode === 'walk' || p?.type === 'WALKING' ? '도보' : p?.type === 'SUBWAY' ? '지하철' : p?.type === 'BUS' ? '버스' : '대중교통';
      const rail = kind === '지하철' && p?.stops?.length ? {
        stops: p.stops.map(stop => ({ name: stop.name ?? '', point: geoPoint(stop.point) ? stop.point : undefined })),
        lines: p.vehicles?.map(vehicle => vehicle.name).filter(Boolean) ?? [],
      } : undefined;
      return { kind, instruction: p?.guidance?.trim() || kind + ' 이동', meters: p?.distance, rail,
        points: row.path?.points?.filter(geoPoint) ?? [] };
    });
    if (steps.some(step => step.points.length >= 2)) {
      if (mode === 'transit' && data.provider === 'tmap') recoverCachedTransferStops(steps);
      return { origin, destination, mode, provider: data.provider, steps,
        meters: candidate.properties?.totalDistance, seconds: candidate.properties?.totalTime };
    }
  }
  throw new Error('지도에 표시할 경로 좌표가 없습니다. 다른 출발·도착지를 선택하세요.');
}

export function displayPlaceName(name: string) {
  const station = /^(.+역)\s*\[([^\[\]]+)\]$/.exec(name);
  if (!station) return name;
  const line = station[2].trim();
  if (!/(?:선|철도|경전철|라인)$|^GTX-[A-Z]$/i.test(line)) return name;
  return station[1] + ' · ' + line.replace(/^수도권\s*(?=\d+호선)/, '');
}

export function formatMeters(meters: number, locale = 'ko-KR') {
  return meters < 1000 ? Math.round(meters) + ' m' : (meters / 1000).toLocaleString(locale, { maximumFractionDigits: 1 }) + ' km';
}

const gpsOptions = { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 };

export function locationMessage(code?: number) {
  return code === 1 ? '위치 권한이 꺼져 있습니다.' : '현재 위치를 확인할 수 없습니다.';
}

export function currentOrigin(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error(locationMessage())); return; }
    navigator.geolocation.getCurrentPosition(({ coords }) => resolve({
      name: '현재 위치', detail: '', point: [coords.longitude, coords.latitude],
    }), error => reject(new Error(locationMessage(error.code))), gpsOptions);
  });
}

export function watchLocation(update: (point: GeoPoint, accuracy: number, timestamp: number) => void, onError: (message: string) => void) {
  if (!navigator.geolocation) { onError(locationMessage()); return; }
  const watch = navigator.geolocation.watchPosition(({ coords, timestamp }) => update([coords.longitude, coords.latitude], coords.accuracy, timestamp),
    error => onError(locationMessage(error.code)), gpsOptions);
  return () => navigator.geolocation.clearWatch(watch);
}

export function nextStepAt(steps: RouteStep[], index: number, point: GeoPoint, accuracy: number, destination?: GeoPoint) {
  if (!steps[index] || !Number.isFinite(accuracy) || accuracy > 50) return index;
  let next = index + 1;
  let end = steps[index].points.at(-1);
  if (!end) {
    // Instructions without geometry share the boundary where the next mapped leg starts.
    while (next < steps.length && !steps[next].points.length) next++;
    end = steps[next]?.points[0] ?? destination;
  }
  if (!end) return index;
  return distanceMeters(end, point) <= Math.max(10, Math.min(accuracy, 22)) ? next : index;
}

function distanceMeters(a: GeoPoint, b: GeoPoint) {
  const dx = (a[0] - b[0]) * Math.cos(b[1] * Math.PI / 180);
  return Math.hypot(dx, a[1] - b[1]) * 111_195;
}

export function progressAtGps(trip: Journey, current: JourneyProgress, position: GeoPoint, accuracy: number, time: number): JourneyProgress {
  const step = nextStepAt(trip.steps, current.step, position, accuracy, trip.destination.point);
  if (current.tagTime !== undefined) {
    if (time <= current.tagTime || !Number.isFinite(accuracy) || accuracy > 50 || current.step === trip.steps.length) return current;
    // A GPS fix from outside the station can arrive immediately after leaving the indoor view.
    if (step === current.step && current.position && distanceMeters(current.position, position) > 50) return current;
  }
  return { ...current, step, position, tagTime: undefined, stopIndex: step === current.step ? current.stopIndex : undefined };
}
