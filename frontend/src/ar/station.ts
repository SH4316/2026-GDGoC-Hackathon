export type Point = [number, number];
export type TagModel = { file: string; name: string };
export type Axis = [number, number, number];
export type TagSurface = { heightM: number; right: Axis; up: Axis };
export type StationTag = { surface?: TagSurface; id: number; center: Point; yawDeg: number; model?: TagModel; modelSizeM?: number };
export type Terrain = { name: string; outline?: Point[]; model?: TagModel };
export type RailStop = { line: string; code: string; name: string };
export type StationLink = RailStop & { routeEndpoint?: 'start' | 'end' };
export const stationName = (name: string) => name.endsWith('역') ? name : name + '역';
export type Station = {
  stationLinks?: StationLink[];
  tagSideM: number;
  tags: StationTag[];
  route: Point[];
  terrain?: Terrain;
  camera: { diagonalFovDeg?: number; calibration?: {
    width: number; height: number; fx: number; fy: number; cx: number; cy: number; distortion: number[];
  } | null };
};
export type StationDocument = { station: Station; etag: string };
export type SpaceLayout = { id: string; station: Station };
export function spaceLabel(station: Station) {
  const name = station.terrain?.name ?? '기본 공간';
  const links = station.stationLinks?.map(stop => stationName(stop.name) + ' ' + stop.line);
  return links?.length ? links.join(' / ') + ' · ' + name : name;
}
export const stationUrl = import.meta.env.BASE_URL + 'api/station';

export function stationVersion(response: Response) {
  // A compression proxy may mark the same server revision as a weak ETag.
  return (response.headers.get('etag') ?? '').replace(/^W\//, '');
}

export async function stationResponse(response: Response) {
  if (response.ok) return response;
  const error = await response.json().catch(() => null);
  const message = response.status === 413 ? '32 MiB 이하의 모델 파일을 선택하세요.' : error?.message;
  throw new Error(typeof message === 'string' ? message : '배치 서버에 연결할 수 없습니다.');
}

export function spaceUrl(id: string) {
  return id === 'default' ? stationUrl : stationUrl + '/spaces/' + encodeURIComponent(id);
}

export const currentSpace = () => new URLSearchParams(location.search).get('space') || 'default';

export async function loadStation(signal?: AbortSignal, id = currentSpace()): Promise<StationDocument> {
  const response = await stationResponse(await fetch(spaceUrl(id), { cache: 'no-store', signal }));
  return { station: await response.json(), etag: stationVersion(response) };
}

export async function loadLayouts(signal?: AbortSignal): Promise<SpaceLayout[]> {
  const response = await stationResponse(await fetch(stationUrl + '/layouts', { cache: 'no-store', signal }));
  return response.json();
}

export async function loadTrackingSpaces(signal: AbortSignal): Promise<SpaceLayout[]> {
  const id = new URLSearchParams(location.search).get('space');
  return id ? [{ id, station: (await loadStation(signal, id)).station }] : loadLayouts(signal);
}
