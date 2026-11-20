import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { RouteChat } from './RouteChat';
import { RouteMap } from './RouteMap';
import { PassagePreview } from '../ar/PassagePreview';
import {
  currentOrigin, directionsApi, findRoute, formatMeters, watchLocation,
  type GeoPoint, type Journey, type JourneyProgress, type Place, type RouteMode,
} from './routes';
import { stationName } from '../ar/station';
import './navigation.css';

type Endpoint = 'origin' | 'destination';
const labels = { origin: '출발지', destination: '도착지' };
type Scanner = { enabled: boolean; error: string; status: string; spacePicker: ReactNode; toggle: () => void; retry: () => void };

function RoutePanelToggle({ expanded, onChange, ref }: {
  expanded: boolean; onChange: (expanded: boolean) => void; ref: Ref<HTMLButtonElement>;
}) {
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const handledPointer = useRef(false);
  const label = expanded ? '경로 정보 접기' : '경로 정보 펼치기';

  return <button ref={ref} type="button" className="route-panel-toggle" title={label}
    aria-label={label} aria-expanded={expanded} aria-controls="journey-information"
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      handledPointer.current = false;
      if (event.pointerType === 'mouse') return;
      dragStart.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerCancel={event => { if (event.isPrimary) dragStart.current = null; }}
    onPointerUp={event => {
      if (!event.isPrimary || !dragStart.current) return;
      const dx = event.clientX - dragStart.current.x;
      const dy = event.clientY - dragStart.current.y;
      dragStart.current = null;
      handledPointer.current = true;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) {
        onChange(!expanded);
        return;
      }
      const bottomSheet = window.matchMedia('(max-width: 680px)').matches;
      if (bottomSheet && Math.abs(dy) > Math.abs(dx)) onChange(dy < 0);
      if (!bottomSheet && Math.abs(dx) > Math.abs(dy)) onChange(dx > 0);
    }}
    onClick={event => { if (event.detail === 0 || !handledPointer.current) onChange(!expanded); }}>
    <span>{label}</span>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
  </button>;
}

function PlaceSearch({ endpoint, select }: { endpoint: Endpoint; select: (place: Place) => void }) {
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setPlaces(undefined);
    try {
      const results = await directionsApi<Place[]>('/places?' + new URLSearchParams({ q: query.trim() }), controller.signal);
      if (!controller.signal.aborted) setPlaces(results);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '다시 검색해 주세요.'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <div className="place-search">
    <form role="search" onSubmit={search}>
      <input type="search" aria-label={labels[endpoint] + ' 검색'} placeholder="장소 또는 역 이름"
        value={query} maxLength={80} onChange={e => {
          request.current?.abort(); setBusy(false); setQuery(e.target.value); setPlaces(undefined); setError('');
        }} />
      <button type="submit" disabled={!query.trim() || busy}>{busy ? '검색 중' : '검색'}</button>
    </form>
    <p className="nav-note">지도에서 {labels[endpoint]}를 직접 선택할 수 있습니다.</p>
    {error && <p className="nav-error" role="alert">{error}</p>}
    {places && (places.length ? <ul className="place-results" aria-label={labels[endpoint] + ' 검색 결과'}>
      {places.map((place, i) => <li key={i}><button type="button" onClick={() => select(place)}>
        <strong>{place.name}</strong><small>{place.detail}</small>
      </button></li>)}
    </ul> : <p role="status" className="nav-note">검색 결과가 없습니다. 다른 이름으로 검색해 주세요.</p>)}
  </div>;
}

export function Navigation({ trip, progress, updateGps, indoor, scanner, start, startIndoor, finish, openField, adminUrl }: {
  trip?: Journey; progress: JourneyProgress; updateGps: (point: GeoPoint, accuracy: number, timestamp: number) => void;
  indoor: boolean; scanner: Scanner; start: (journey: Journey, position?: GeoPoint) => void;
  startIndoor: () => void; finish: () => void; openField: () => void; adminUrl: string;
}) {
  const [origin, setOrigin] = useState<Place>();
  const [destination, setDestination] = useState<Place>();
  const [picking, setPicking] = useState<Endpoint | null>('destination');
  const [mode, setMode] = useState<RouteMode>('transit');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');
  const { step, position } = progress;
  const [panelOpen, setPanelOpen] = useState(true);
  const routeRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panelToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => () => routeRequest.current?.abort(), []);

  useEffect(() => {
    if (!trip || indoor) return;
    const focusTarget = heading.current?.offsetHeight ? heading.current : panelToggle.current;
    focusTarget?.focus({ preventScroll: true });
    let active = true;
    const stop = watchLocation((point, accuracy, timestamp) => {
      if (!active) return;
      updateGps(point, accuracy, timestamp); setGpsError('');
    }, message => { if (active) setGpsError(message); });
    return () => { active = false; stop?.(); };
  }, [trip, indoor, updateGps]);

  function select(endpoint: Endpoint, place?: Place) {
    if (endpoint === 'origin') setOrigin(place);
    else setDestination(place);
    setPicking(endpoint === 'origin' && !destination ? 'destination' : null);
    setError('');
  }

  function startJourney(journey: Journey, position?: GeoPoint) {
    setGpsError(''); setPanelOpen(true); start(journey, position);
  }

  async function begin() {
    if (!destination || routeRequest.current) return;
    const controller = new AbortController();
    routeRequest.current = controller;
    setError(''); setBusy(origin ? '경로 탐색 중…' : '현재 위치 확인 중…');
    try {
      let from = origin;
      if (!from) {
        try { from = await currentOrigin(); }
        catch (e) {
          if (!controller.signal.aborted) setPicking('origin');
          throw new Error((e instanceof Error ? e.message : '현재 위치를 확인할 수 없습니다.') + ' 출발지를 검색하거나 지도에서 선택하세요.');
        }
      }
      controller.signal.throwIfAborted();
      setBusy('경로 탐색 중…');
      const journey = await findRoute(from, destination, mode, controller.signal);
      if (!controller.signal.aborted) {
        startJourney(journey, origin ? undefined : from.point);
      }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '경로를 찾지 못했습니다.'); }
    finally {
      if (routeRequest.current === controller) routeRequest.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  }

  function pickPoint(point: GeoPoint) {
    if (picking) select(picking, { name: '지도에서 선택한 ' + labels[picking],
      detail: point[1].toFixed(5) + ', ' + point[0].toFixed(5), point });
  }
  const currentStep = progress.station || (position && !gpsError) ? step : undefined;
  const arrived = !!trip && step === trip.steps.length;
  return <div className="navigation" hidden={indoor}>
    <header className="journey-header">
      <span className="journey-brand"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m2 5 6-2 8 3 6-2v15l-6 2-8-3-6 2zM8 3v15m8-12v15" /></svg>역 길안내</span>
      {!trip && <nav aria-label="첫 화면 메뉴"><button type="button" onClick={openField}>AR 카메라</button><a href={adminUrl}>관리자 페이지</a></nav>}
      {trip && <button type="button" onClick={finish}>안내 종료</button>}
    </header>
    <div className="journey-body" data-guiding={!!trip} data-collapsed={!!trip && !panelOpen}>
      {trip && <RoutePanelToggle ref={panelToggle} expanded={panelOpen} onChange={setPanelOpen} />}
      <section key={trip ? 'guidance' : 'setup'} id="journey-information" className="journey-panel" hidden={!!trip && !panelOpen}
        aria-label={trip ? '현재 경로 안내' : '도착지 설정'}>
        {!trip ? <>
          <div className="setup-heading"><h1>도착지 설정</h1>
            <RouteChat origin={origin} destination={destination} mode={mode} disabled={!!busy}
              accept={journey => {
                setOrigin(journey.origin); setDestination(journey.destination); setMode(journey.mode);
                setPicking(null); setError(''); startJourney(journey);
              }}/>
          </div>
          <fieldset disabled={!!busy} className="route-fields">
            {(['origin', 'destination'] as const).map(endpoint => {
              const place = endpoint === 'origin' ? origin : destination;
              return <div className="endpoint-field" key={endpoint} data-end={endpoint === 'destination'}>
                <div className="endpoint-row">
                  <span className="field-label">{labels[endpoint]}</span>
                  {(picking !== endpoint || place || endpoint === 'origin') && <button type="button" className="endpoint-value"
                    aria-label={labels[endpoint] + (picking === endpoint ? ' 선택 유지' : ' 변경')} aria-expanded={picking === endpoint}
                    onClick={() => { if (picking === endpoint) select(endpoint, place); else { setPicking(endpoint); setError(''); } }}>
                    {place?.name ?? (endpoint === 'origin' ? '현재 위치' : '도착지를 선택하세요')}
                    <span className="edit-mark" aria-hidden="true">{picking === endpoint ? '선택 유지' : '변경'}</span>
                  </button>}
                </div>
                {place?.detail && <small className="endpoint-detail">{place.detail}</small>}
                {picking === endpoint && <>
                  {endpoint === 'origin' && origin && <button className="text-action" type="button" onClick={() => select('origin')}>현재 위치 사용</button>}
                  <PlaceSearch endpoint={endpoint} select={place => select(endpoint, place)} />
                </>}
              </div>;
            })}
            <div className="travel-mode" role="group" aria-label="이동 수단">
              <button type="button" aria-pressed={mode === 'transit'} onClick={() => setMode('transit')}>대중교통</button>
              <button type="button" aria-pressed={mode === 'walk'} onClick={() => setMode('walk')}>도보</button>
            </div>
          </fieldset>
          {error && <p role="alert" className="nav-error">{error}</p>}
          <button className="start-route" type="button" disabled={!!busy || !destination || !!picking}
            onClick={() => void begin()}>{busy || '길 안내 시작'}</button>
          <PassagePreview disabled={!!busy} />
          <button className="start-indoor" type="button" onClick={() => {
            routeRequest.current?.abort(); routeRequest.current = null; setBusy(''); setError(''); startIndoor();
          }}>태그로 실내 안내</button>
        </> : <>
          <h1 ref={heading} tabIndex={-1}>2D 길 안내</h1>
          {(trip.seconds !== undefined || trip.meters !== undefined) && <p className="route-summary">
            {trip.seconds !== undefined && <strong>약 {Math.max(1, Math.round(trip.seconds / 60))}분</strong>}
            {trip.meters !== undefined && <span>{formatMeters(trip.meters)}</span>}
          </p>}
          {gpsError && <p className="nav-note" role="status">{gpsError}</p>}
          {progress.station && <p className="nav-note" role="status">태그로 확인한 역 · {stationName(progress.station)}</p>}
          <ol className="route-timeline" aria-label="전체 경로 안내" role="list">
            <li className="timeline-endpoint">
              <span className="timeline-marker">출발</span>
              <strong>{trip.origin.name}</strong>
            </li>
            {trip.steps.map((leg, index) => <li key={index} aria-current={index === currentStep ? 'step' : undefined}>
              <span className="timeline-marker" aria-hidden="true">{index + 1}</span>
              <div className="timeline-leg">
                <div className="leg-meta">
                  <b>{leg.kind}</b>
                  {leg.meters !== undefined && <span>{formatMeters(leg.meters)}</span>}
                  {index === currentStep && <em>현재 구간</em>}
                </div>
                <p>{leg.instruction}</p>
              </div>
            </li>)}
            <li className="timeline-endpoint" aria-current={arrived ? 'step' : undefined}>
              <span className="timeline-marker">도착</span>
              <strong>{trip.destination.name}</strong>
            </li>
          </ol>
          {arrived && <p className="arrival-status">도착지에 도착했습니다.</p>}
          <div className="scan-controls">
            <strong>역 안 AR 안내</strong>
            <p role="status">{scanner.error || (scanner.enabled ? scanner.status : '태그 인식이 꺼져 있습니다.')}</p>
            {scanner.enabled && scanner.spacePicker}
            <div>
              {scanner.enabled && scanner.error && <button type="button" onClick={scanner.retry}>다시 연결</button>}
              <button type="button" onClick={scanner.toggle}>{scanner.enabled ? '인식 끄기' : '태그 인식 켜기'}</button>
            </div>
          </div>
          {trip.provider && <small className="route-source">경로 제공 · {trip.provider === 'tmap' ? 'TMAP' : '카카오맵'}</small>}
        </>}
      </section>
      <RouteMap origin={trip?.origin ?? origin} destination={trip?.destination ?? destination} trip={trip}
        step={currentStep} position={trip ? position : undefined} onPick={!trip && picking && !busy ? pickPoint : undefined} />
    </div>
    {trip && <p className="route-announcement" role="status">
      {arrived ? '도착지에 도착했습니다.' : currentStep !== undefined && trip.steps[currentStep]?.instruction}
    </p>}
  </div>;
}
