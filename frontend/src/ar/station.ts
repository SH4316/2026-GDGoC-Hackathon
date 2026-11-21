import { copy, lineLabel, type Language } from '../i18n/language';
import { stationLabel } from '../i18n/stationLabel';
import { trackingLayout, type TagNetwork } from './tagRouting';

export type Point = [number, number];
export type TagModel = { file: string; name: string };
export type Axis = [number, number, number];
export type TagSurface = { heightM: number; right: Axis; up: Axis };
export type StationTag = { walkPoint?: Point; surface?: TagSurface; id: number; center: Point; yawDeg: number; model?: TagModel; modelSizeM?: number };
export type Terrain = { name: string; outline?: Point[]; model?: TagModel };
export type RailStop = { line: string; code: string; name: string };
export type StationLink = RailStop & { routeEndpoint?: 'start' | 'end' };
export const stationName = (name: string) => name.endsWith('역') ? name : name + '역';
export type Station = {
  stationLinks?: StationLink[];
  tagSideM: number;
  tags: StationTag[];
  route: Point[];
  tagGraph?: { startTag: number; endTag: number; edges: [number, number][] };
  autoRoute?: false | { startTag?: number; endTag?: number };
  terrain?: Terrain;
  camera: { diagonalFovDeg?: number; calibration?: {
    width: number; height: number; fx: number; fy: number; cx: number; cy: number; distortion: number[];
  } | null };
};
export type StationDocument = { station: Station; etag: string };
export type SpaceLayout = { id: string; station: Station; network?: TagNetwork };
export function spaceLabel(station: Station, language: Language = 'ko') {
  const name = station.terrain?.name ?? copy[language]('기본 공간');
  const links = station.stationLinks?.map(stop => stationLabel(stationName(stop.name), language) + ' ' + lineLabel(stop.line, language));
  return links?.length ? links.join(' / ') + ' · ' + name : name;
}

export function indoorSpaceName(station: Station, language: Language = 'ko') {
  const start = station.stationLinks?.find(link => link.routeEndpoint === 'start');
  const end = station.stationLinks?.find(link => link.routeEndpoint === 'end');
  if (start && end && stationName(start.name) === stationName(end.name))
    return `${stationLabel(stationName(start.name), language, true)} · ${lineLabel(start.line, language)} → ${lineLabel(end.line, language)}`;
  return spaceLabel(station, language);
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

async function trackingSnapshot(signal: AbortSignal, previous?: { etag: string; version: string }) {
  const id = new URLSearchParams(location.search).get('space');
  const response = await fetch(id ? spaceUrl(id) : stationUrl + '/layouts', {
    signal, cache: 'no-store', headers: previous?.etag ? { 'If-None-Match': previous.etag } : undefined,
  });
  if (response.status === 304 && previous) return;
  await stationResponse(response);
  const etag = stationVersion(response);
  if (etag && etag === previous?.etag) return;
  const body = await response.text(), version = etag || body;
  if (version === previous?.version) return;
  const payload = JSON.parse(body);
  const spaces: SpaceLayout[] = id ? [{ id, station: payload }] : payload;
  return { etag, version, layouts: spaces.map(trackingLayout) };
}

export async function loadTrackingSpaces(signal: AbortSignal) {
  return (await trackingSnapshot(signal))!.layouts;
}

export function watchTrackingSpaces(signal: AbortSignal, paused: () => boolean,
                                   changed: (layouts: SpaceLayout[]) => void, failed: () => void) {
  let previous: { etag: string; version: string } | undefined;
  let loading = false;
  async function refresh() {
    if (loading || signal.aborted || document.hidden || paused()) return;
    loading = true;
    try {
      const next = await trackingSnapshot(signal, previous);
      if (next && !signal.aborted && !paused()) {
        changed(next.layouts);
        previous = { etag: next.etag, version: next.version };
      }
    } catch {
      if (!signal.aborted && !previous) failed();
    } finally { loading = false; }
  }
  const timer = window.setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', refresh, { signal });
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  void refresh();
}
