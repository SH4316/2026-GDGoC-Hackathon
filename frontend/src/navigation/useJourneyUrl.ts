import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateUrl, useQuery } from '../urlState';
import { findRoute, type GeoPoint, type Journey, type JourneyProgress, type RouteMode } from './routes';
import { chatCache, clearGuidance, clearJourney, decodePlace, encodePlace, journeyCache, journeyView, readProgress, routeKey, type Endpoint } from './journeyUrl';

// Route geometry can exceed URL limits. Keep one exact result for reloads in this tab.
// The URL contains both endpoints and the mode, so a new tab can retrieve the route itself.
function cachedJourney(key: string) {
  try {
    const trip: Journey = JSON.parse(sessionStorage.getItem(journeyCache) ?? 'null');
    if (trip && Array.isArray(trip.steps) && trip.steps.length &&
        routeKey(trip.origin, trip.destination, trip.mode) === key) return trip;
  } catch { /* The route can also be loaded without browser storage. */ }
}

function cacheJourney(trip: Journey) {
  try { sessionStorage.setItem(journeyCache, JSON.stringify(trip)); } catch { /* Storage is optional. */ }
}

export function useJourneyUrl() {
  const params = useQuery();
  const from = params.get('from'), to = params.get('to');
  const origin = useMemo(() => decodePlace(from), [from]);
  const destination = useMemo(() => decodePlace(to), [to]);
  const mode: RouteMode = params.get('mode') === 'walk' ? 'walk' : 'transit';
  const view = journeyView(params.get('view'), !!origin && !!destination);
  const guiding = view === 'map' || view === 'transfer';
  const key = guiding ? routeKey(origin!, destination!, mode) : undefined;
  const pick = params.get('pick');
  const picking: Endpoint | null = pick === 'origin' || pick === 'destination' ? pick : pick === 'none' || destination ? null : 'destination';
  const [loaded, setLoaded] = useState<{ key: string; trip: Journey } | undefined>(() => {
    const trip = key && cachedJourney(key);
    return key && trip ? { key, trip } : undefined;
  });
  const trip = key && loaded?.key === key ? loaded.trip : undefined;
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [attempt, retry] = useState(0);
  const [fix, setFix] = useState<{ key: string; point?: GeoPoint }>();
  const latestFix = useRef(fix);
  const [resetCount, setResetCount] = useState(0);

  useEffect(() => {
    if (!key || trip || !origin || !destination) return;
    const cached = cachedJourney(key);
    if (cached) { setLoaded({ key, trip: cached }); return; }
    const controller = new AbortController();
    setFailure(undefined);
    void findRoute(origin, destination, mode, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      cacheJourney(result);
      setLoaded({ key, trip: result });
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : '경로를 찾지 못했습니다.' });
    });
    return () => controller.abort();
  }, [key, trip, origin, destination, mode, attempt]);

  function start(result: Journey, position?: GeoPoint) {
    const key = routeKey(result.origin, result.destination, result.mode);
    cacheJourney(result);
    setLoaded({ key, trip: result });
    latestFix.current = { key, point: position };
    setFix(latestFix.current);
    updateUrl({ ...clearGuidance, view: 'map', from: encodePlace(result.origin), to: encodePlace(result.destination),
      mode: result.mode, autoOrigin: position ? '1' : null, pick: null, q: null, search: null }, 'push');
  }

  function finish() {
    updateUrl({ ...clearGuidance, view: null, autoOrigin: null, ...(params.has('autoOrigin') ? { from: null } : {}) }, 'push');
  }

  function reset() {
    updateUrl(clearJourney);
    try {
      sessionStorage.removeItem(journeyCache);
      sessionStorage.removeItem(chatCache);
    } catch { /* Storage is optional. */ }
    latestFix.current = undefined;
    setFix(undefined);
    setLoaded(undefined);
    setFailure(undefined);
    setResetCount(n => n + 1);
  }

  const progress = readProgress(params, trip?.steps.length ?? 0);
  progress.position = fix?.key === key ? fix?.point : undefined;
  const advance = useCallback((change: (previous: JourneyProgress) => JourneyProgress) => {
    if (!key || !trip) return;
    const now = new URLSearchParams(location.search);
    if (!['map', 'transfer'].includes(now.get('view') ?? '') || now.get('from') !== from || now.get('to') !== to ||
        (now.get('mode') === 'walk' ? 'walk' : 'transit') !== mode) return;
    const previous = readProgress(now, trip.steps.length);
    previous.position = latestFix.current?.key === key ? latestFix.current.point : undefined;
    const next = change(previous);
    if (previous === next) return;
    if (next.position !== previous.position) {
      latestFix.current = { key, point: next.position };
      setFix(latestFix.current);
    }
    if (next.step !== previous.step || next.station !== previous.station || next.stopIndex !== previous.stopIndex || next.tagTime !== previous.tagTime)
      updateUrl({ step: next.step || null, station: next.station ?? null, stop: next.stopIndex ?? null, tagTime: next.tagTime ?? null });
  }, [key, trip, from, to, mode]);

  return { params, view, origin, destination, picking, mode, trip, guiding, progress, advance, start, finish, reset, resetCount,
    restoreError: failure?.key === key ? failure?.message : undefined, retry: () => retry(n => n + 1) };
}
