import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { LanguageSelect, useLanguage } from '../i18n/LanguageSelect';
import { placeLabel, routeInstruction } from './routeInstruction';
import { lineLabel, type Translate, type Language } from '../i18n/language';
import { stationLabel } from '../i18n/stationLabel';
import { updateUrl, useQuery } from '../urlState';
import { encodePlace, type Endpoint } from './journeyUrl';
import type { useJourneyUrl } from './useJourneyUrl';
import { RouteChat } from './RouteChat';
import { RouteMap } from './RouteMap';
import { HomeButton } from './HomeButton';
import { PassagePreview } from '../ar/PassagePreview';
import {
  currentOrigin, directionsApi, findRoute, formatMeters, watchLocation,
  type GeoPoint, type Journey, type Place, type RouteStep,
} from './routes';
import { stationName } from '../ar/station';
import { prepareIndoorVoice } from '../ar/IndoorVoice';
import { awaitingBoarding, type RouteTransfer } from './stationProgress';
import './navigation.css';

const labels = { origin: '출발지', destination: '도착지' };
type Scanner = { enabled: boolean; ready: boolean; error: string; status: string; spacePicker: ReactNode; motionControl: ReactNode; toggle: () => void; retry: () => void };

function transferHint(transfer: RouteTransfer, step: number, t: Translate, language: Language) {
  return step < transfer.transferStep ? t('{station}에 도착하면 환승 통로의 태그를 비추세요.', { station: stationLabel(transfer.station, language, true) })
    : t('환승 통로의 태그를 비추세요.');
}

function isGenericTransferWalk(leg: RouteStep, transfer: RouteTransfer) {
  return leg.kind === '도보' && (leg.instruction === '도보 이동' ||
    [transfer.station, transfer.station.slice(0, -1)].some(name => leg.instruction === name + '까지 도보 이동'));
}

function boardingInstruction(leg: RouteStep, line: string, language: Language) {
  const stop = leg.rail?.stops.at(-1)?.name.trim();
  if (!stop) return routeInstruction(leg, language);
  if (language === 'en') return 'Take ' + lineLabel(line, language) + ' and get off at ' + stationLabel(stop, language) + '.';
  const last = line.charCodeAt(line.length - 1);
  const particle = last >= 0xac00 && last <= 0xd7a3 ? ((last - 0xac00) % 28 ? '을' : '를') : ' 열차를';
  return line + particle + ' 타고 ' + stationName(stop) + '에서 내리세요.';
}

function ScanControls({ scanner, transfer, step }: { scanner: Scanner; transfer?: RouteTransfer; step: number }) {
  const { t, language } = useLanguage();
  const readyHint = transfer ? transferHint(transfer, step, t, language) : t('역 안의 태그를 비추세요.');
  const title = transfer ? t(step < transfer.transferStep ? '다음 환승 · {station}' : '{station} 환승',
    { station: stationLabel(transfer.station, language, true) }) : t('역 안 안내');
  return <section className="scan-controls" data-transfer={!!transfer} aria-label={title}>
    <h2>{title}</h2>
    {transfer && <strong>{lineLabel(transfer.fromLine, language)} → {lineLabel(transfer.toLine, language)}</strong>}
    {scanner.enabled && <p role="status" className={scanner.error ? 'nav-error' : undefined}>
      {t(scanner.error) || t(scanner.status) || (scanner.ready ? readyHint : t('카메라 연결 중'))}
    </p>}
    {scanner.enabled && scanner.spacePicker}
    <div className="scan-actions">
      {scanner.enabled && scanner.motionControl}
      {scanner.enabled && scanner.error && <button type="button" onClick={scanner.retry}>{t('카메라 다시 연결')}</button>}
      <button type="button" onClick={scanner.toggle}>{scanner.enabled ? t('태그 인식 끄기') : t('역 안 안내 시작')}</button>
    </div>
  </section>;
}

function RoutePanelToggle({ expanded, onChange, ref }: {
  expanded: boolean; onChange: (expanded: boolean) => void; ref: Ref<HTMLButtonElement>;
}) {
  const { t } = useLanguage();
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const handledPointer = useRef(false);
  const label = t(expanded ? '경로 정보 접기' : '경로 정보 펼치기');

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
  const { t, language } = useLanguage();
  const params = useQuery();
  const query = params.get('q')?.slice(0, 80) ?? '';
  const submitted = params.get('search') === '1' && query.trim();
  const [places, setPlaces] = useState<Place[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, retry] = useState(0);
  const label = t(labels[endpoint]).toLowerCase();
  useEffect(() => {
    setPlaces(undefined); setError('');
    if (!submitted) { setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    void directionsApi<Place[]>('/places?' + new URLSearchParams({ q: submitted }), controller.signal).then(results => {
      if (!controller.signal.aborted) setPlaces(results);
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '다시 검색해 주세요.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [submitted, attempt]);

  function search(event: FormEvent) {
    event.preventDefault();
    if (submitted) retry(n => n + 1);
    else if (query.trim()) updateUrl({ search: '1' });
  }
  return <div className="place-search">
    <form role="search" onSubmit={search}>
      <input type="search" aria-label={t('{place} 검색', { place: label })} placeholder={t('장소 또는 역 이름')}
        value={query} maxLength={80} onChange={e => updateUrl({ q: e.target.value || null, search: null })} />
      <button type="submit" disabled={!query.trim() || busy}>{t(busy ? '검색 중' : '검색')}</button>
    </form>
    <p className="nav-note">{t('지도에서 {place}를 직접 선택할 수 있습니다.', { place: label })}</p>
    {error && <p className="nav-error" role="alert">{t(error)}</p>}
    <p role="status" className={submitted && places ? 'nav-note' : 'route-announcement'}>
      {submitted && places && (places.length ? t('검색 결과 {n}개', { n: places.length }) : t('검색 결과가 없습니다. 다른 이름으로 검색해 주세요.'))}
    </p>
    {submitted && !!places?.length && <ul className="place-results" aria-label={t('{place} 검색 결과', { place: label })}>
      {places.map((place, i) => <li key={i}><button type="button" onClick={() => select(place)}>
        <strong>{placeLabel(place.name, language)}</strong><small>{place.detail}</small>
      </button></li>)}
    </ul>}
  </div>;
}

export function Navigation({ navigation, transfers, pendingTransfer, updateGps, indoor, scanner, startIndoor, adminUrl }: {
  navigation: ReturnType<typeof useJourneyUrl>; transfers: RouteTransfer[]; pendingTransfer?: RouteTransfer; updateGps: (point: GeoPoint, accuracy: number, timestamp: number) => void;
  indoor: boolean; scanner: Scanner; startIndoor: () => void; adminUrl: string;
}) {
  const { origin, destination, picking, mode, trip, progress, params, start, finish } = navigation;
  const { language, locale, t } = useLanguage();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');
  const { step, position } = progress;
  const panelOpen = params.get('panel') !== 'closed';
  const setPanelOpen = (open: boolean) => updateUrl({ panel: open ? null : 'closed' });
  const routeRequest = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panelToggle = useRef<HTMLButtonElement>(null);
  const endpointButtons = useRef<Partial<Record<Endpoint, HTMLButtonElement | null>>>({});
  const selectedEndpoint = useRef<Endpoint | null>(null);
  useLayoutEffect(() => {
    if (selectedEndpoint.current) {
      endpointButtons.current[selectedEndpoint.current]?.focus();
      selectedEndpoint.current = null;
    }
  }, [origin, destination, picking]);
  useEffect(() => {
    const cancel = () => { routeRequest.current?.abort(); routeRequest.current = null; setBusy(''); setError(''); };
    window.addEventListener('popstate', cancel);
    return () => { window.removeEventListener('popstate', cancel); routeRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!trip || indoor) return;
    const focusFrame = requestAnimationFrame(() => {
      if (panel.current) panel.current.scrollTop = 0;
      const focusTarget = heading.current?.offsetHeight ? heading.current : panelToggle.current;
      focusTarget?.focus({ preventScroll: true });
    });
    let active = true;
    const stop = watchLocation((point, accuracy, timestamp) => {
      if (!active) return;
      updateGps(point, accuracy, timestamp); setGpsError('');
    }, message => { if (active) setGpsError(message); });
    return () => { active = false; cancelAnimationFrame(focusFrame); stop?.(); };
  }, [trip, indoor, updateGps]);

  function select(endpoint: Endpoint, place?: Place) {
    selectedEndpoint.current = endpoint;
    updateUrl({ [endpoint === 'origin' ? 'from' : 'to']: place ? encodePlace(place) : null,
      pick: endpoint === 'origin' && !destination ? 'destination' : 'none', q: null, search: null, map: null });
    setError('');
  }

  function startJourney(journey: Journey, position?: GeoPoint) {
    setGpsError(''); start(journey, position);
  }

  async function begin() {
    if (!destination || routeRequest.current) return;
    prepareIndoorVoice('경로를 확인합니다.', language);
    const controller = new AbortController();
    routeRequest.current = controller;
    setError(''); setBusy(origin ? '경로 탐색 중…' : '현재 위치 확인 중…');
    try {
      let from = origin;
      if (!from) {
        try { from = await currentOrigin(); }
        catch (e) {
          if (!controller.signal.aborted) updateUrl({ pick: 'origin', q: null, search: null });
          throw new Error(t(e instanceof Error ? e.message : '현재 위치를 확인할 수 없습니다.') + ' ' + t('출발지를 검색하거나 지도에서 선택하세요.'));
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
  const currentStep = step > 0 || progress.station || (position && !gpsError) ? step : undefined;
  const arrived = !!trip && step === trip.steps.length;
  const boardingTransfer = transfers.find(transfer => transfer.boardingStep === currentStep && !awaitingBoarding(progress, transfer.boardingStep));
  const activeLeg = trip?.steps[step];
  let action = activeLeg ? routeInstruction(activeLeg, language) : '';
  let stepLabel = t(currentStep === undefined ? '첫 구간' : '현재 구간');
  if (arrived) {
    action = t('도착지에 도착했습니다.');
    stepLabel = placeLabel(trip.destination.name, language);
  } else if (boardingTransfer && activeLeg) {
    action = boardingInstruction(activeLeg, boardingTransfer.toLine, language);
    stepLabel = t('{station} 환승 완료', { station: stationLabel(boardingTransfer.station, language, true) });
  } else if (activeLeg && pendingTransfer && step >= pendingTransfer.transferStep &&
      (step === pendingTransfer.boardingStep || isGenericTransferWalk(activeLeg, pendingTransfer))) {
    action = t('{line} 환승 통로로 이동하세요.', { line: lineLabel(pendingTransfer.toLine, language) });
  }
  return <div className="navigation" hidden={indoor}>
    <header className="journey-header">
      <span className="journey-brand"><svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m2 5 6-2 8 3 6-2v15l-6 2-8-3-6 2zM8 3v15m8-12v15" /></svg>{t('역 길안내')}</span>
      <LanguageSelect />
      <nav aria-label={t('첫 화면 메뉴')}>
        <HomeButton onClick={navigation.reset} />
        {!trip ? <>
        <a href={adminUrl} aria-label={t('관리자 페이지')}>{t('관리자')}</a>
        <button type="button" className="start-indoor" onClick={() => {
          routeRequest.current?.abort(); routeRequest.current = null; setBusy(''); setError(''); startIndoor();
        }}>{t('역 안 안내 시작')}</button>
        </> : <button type="button" onClick={finish}>{t('안내 종료')}</button>}
      </nav>
    </header>
    <div className="journey-body" data-guiding={!!trip} data-collapsed={!!trip && !panelOpen}>
      {trip && <RoutePanelToggle ref={panelToggle} expanded={panelOpen} onChange={setPanelOpen} />}
      <section ref={panel} key={trip ? 'guidance' : 'setup'} id="journey-information" className="journey-panel" hidden={!!trip && !panelOpen}
        aria-label={trip ? t('현재 경로 안내') : t('도착지 설정')}>
        {!trip ? <>
          <div className="setup-heading"><h1>{t('도착지 설정')}</h1>
            <RouteChat origin={origin} destination={destination} mode={mode} disabled={!!busy}
              accept={journey => {
                prepareIndoorVoice('길 안내를 시작합니다.', language);
                setError(''); startJourney(journey);
              }}/>
          </div>
          <fieldset disabled={!!busy} className="route-fields">
            {(['origin', 'destination'] as const).map(endpoint => {
              const place = endpoint === 'origin' ? origin : destination;
              const value = place ? placeLabel(place.name, language) : t(endpoint === 'origin' ? '현재 위치' : '도착지를 선택하세요');
              return <div className="endpoint-field" key={endpoint} data-end={endpoint === 'destination'}>
                <div className="endpoint-row">
                  <span className="field-label">{t(labels[endpoint])}</span>
                  {(picking !== endpoint || place || endpoint === 'origin') && <button type="button" className="endpoint-value"
                    ref={button => { endpointButtons.current[endpoint] = button; }}
                    aria-label={t(picking === endpoint ? '{place} 선택 유지' : '{place} 변경', { place: t(labels[endpoint]).toLowerCase() }) + ', ' + value} aria-expanded={picking === endpoint}
                    onClick={() => { if (picking === endpoint) select(endpoint, place); else { updateUrl({ pick: endpoint, q: null, search: null }); setError(''); } }}>
                    {value}
                    <span className="edit-mark" aria-hidden="true">{picking === endpoint ? t('선택 유지') : t('변경')}</span>
                  </button>}
                </div>
                {place?.detail && <small className="endpoint-detail">{place.detail}</small>}
                {picking === endpoint && <>
                  {endpoint === 'origin' && origin && <button className="text-action" type="button" onClick={() => select('origin')}>{t('현재 위치 사용')}</button>}
                  <PlaceSearch endpoint={endpoint} select={place => select(endpoint, place)} />
                </>}
              </div>;
            })}
            <div className="travel-mode" role="group" aria-label={t('이동 수단')}>
              <button type="button" aria-pressed={mode === 'transit'} onClick={() => updateUrl({ mode: 'transit' })}>{t('대중교통')}</button>
              <button type="button" aria-pressed={mode === 'walk'} onClick={() => updateUrl({ mode: 'walk' })}>{t('도보')}</button>
            </div>
          </fieldset>
          {error && <p role="alert" className="nav-error">{t(error)}</p>}
          <button className="start-route" type="button" disabled={!!busy || !destination || !!picking}
            onClick={() => void begin()}>{t(busy || '길 안내 시작')}</button>
          <PassagePreview disabled={!!busy} />
        </> : <>
          <p className="step-label">{stepLabel}</p>
          <h1 ref={heading} tabIndex={-1} className="step-action">{action}</h1>
          {(trip.seconds !== undefined || trip.meters !== undefined) && <p className="route-summary">
            <span>{t('전체 경로')}</span>
            {trip.seconds !== undefined && <strong>{t('약 {minutes}분', { minutes: Math.max(1, Math.round(trip.seconds / 60)) })}</strong>}
            {trip.meters !== undefined && <span>{formatMeters(trip.meters, locale)}</span>}
          </p>}
          {gpsError && <p className="nav-note" role="status">{t(gpsError)}</p>}
          {progress.station && !boardingTransfer && <p className="nav-note" role="status">{t('태그로 확인한 역')} · {stationLabel(stationName(progress.station), language, true)}</p>}
          {pendingTransfer && !arrived && <ScanControls scanner={scanner} transfer={pendingTransfer} step={step} />}
          <ol className="route-timeline" aria-label={t('전체 경로 안내')} role="list">
            <li className="timeline-endpoint">
              <span className="timeline-marker">{t('출발')}</span>
              <strong>{placeLabel(trip.origin.name, language)}</strong>
            </li>
            {trip.steps.map((leg, index) => {
              const transfer = transfers.find(item => item.transferStep === index);
              const genericWalk = transfer && isGenericTransferWalk(leg, transfer);
              return <li key={index} aria-current={index === currentStep ? 'step' : undefined}>
                <span className="timeline-marker" aria-hidden="true">{index + 1}</span>
                <div className="timeline-leg">
                  <div className="leg-meta">
                    <b>{transfer ? t('{station} 환승', { station: stationLabel(transfer.station, language, true) }) : t(leg.kind)}</b>
                    {leg.meters !== undefined && <span>{formatMeters(leg.meters, locale)}</span>}
                    {index === currentStep && <em>{t('현재 구간')}</em>}
                  </div>
                  {transfer && <p className="transfer-lines">{lineLabel(transfer.fromLine, language)} → {lineLabel(transfer.toLine, language)}</p>}
                  {!genericWalk && <p>{routeInstruction(leg, language)}</p>}
                  {transfer && awaitingBoarding(progress, transfer.boardingStep) && <small>{transferHint(transfer, step, t, language)}</small>}
                </div>
              </li>;
            })}
            <li className="timeline-endpoint" aria-current={arrived ? 'step' : undefined}>
              <span className="timeline-marker">{t('도착')}</span>
              <strong>{placeLabel(trip.destination.name, language)}</strong>
            </li>
          </ol>
          {!arrived && !pendingTransfer && <ScanControls scanner={scanner} step={step} />}
          {trip.provider && <small className="route-source">{t('경로 제공')} · {trip.provider === 'tmap' ? 'TMAP' : t('카카오맵')}</small>}
        </>}
      </section>
      <RouteMap origin={trip?.origin ?? origin} destination={trip?.destination ?? destination} trip={trip} transfers={transfers}
        step={currentStep} position={trip ? position : undefined} onPick={!trip && picking && !busy ? pickPoint : undefined} />
    </div>
    {trip && <p className="route-announcement" role="status">
      {stepLabel}. {action}
    </p>}
  </div>;
}
