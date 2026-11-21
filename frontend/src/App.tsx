import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { SignReader } from './SignReader';
import { openPassage, type GuideDirection, type TagReference } from './ar/camera';
import { IndoorMinimap } from './ar/IndoorMinimap';
import { LivePassageProgress } from './ar/PassageProgress';
import { ScreenDoorCapture } from './ar/ScreenDoorCapture';
import { indoorCue, type IndoorCue } from './ar/indoorGuidance';
import { IndoorVoice, prepareIndoorVoice } from './ar/IndoorVoice';
import { ArDebugControls, useArDebug } from './ar/ArDebugControls';
import type { MinimapPose } from './ar/indoorTracking';
import { motionAccess, requestMotionAccess, type MotionAccess } from './ar/motion';
import { FieldRecorder, idleView } from './ar/recording';
import { currentSpace, indoorSpaceName, watchTrackingSpaces, spaceLabel, type Point, type SpaceLayout } from './ar/station';
import { tagNetwork } from './ar/tagRouting';
import { uploadNotice } from './i18n/language';
import { LanguageSelect, useDocumentLanguage, useLanguage } from './i18n/LanguageSelect';
import { updateUrl, withQuery } from './urlState';
import { integerParam, clearGuidance } from './navigation/journeyUrl';
import { useJourneyUrl } from './navigation/useJourneyUrl';
import { Navigation } from './navigation/Navigation';
import { HomeButton } from './navigation/HomeButton';
import { placeLabel } from './navigation/routeInstruction';
import { progressAtGps, type GeoPoint } from './navigation/routes';
import { awaitingBoarding, boardingTarget, orientTransferLayout, progressAtIndoorArrival, progressAtTag, routeTransfers, upcomingIndoorTransfer } from './navigation/stationProgress';

type DoorProximity = { spaceId: string; selectedTag?: number };

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const guideCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const modelCanvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const indoorHeading = useRef<HTMLHeadingElement>(null);
  const client = useRef<FieldRecorder | null>(null);
  const navigation = useJourneyUrl();
  const { params, view, trip, progress, advance } = navigation;
  const { t, language, locale } = useLanguage();
  useDocumentLanguage('역 길안내');
  const indoor = view === 'indoor' || view === 'transfer';
  const updateGps = useCallback((position: GeoPoint, accuracy: number, timestamp: number) => {
    if (trip) advance(current => progressAtGps(trip, current, position, accuracy, timestamp));
  }, [trip, advance]);
  const fullCamera = view === 'field' || (indoor && (!navigation.guiding || !!trip));
  const spaceFilter = params.get('space');
  const [spaces, setSpaces] = useState<SpaceLayout[]>([]);
  const transfers = useMemo(() => trip ? routeTransfers(trip, spaces.map(layout => orientTransferLayout(trip, layout, progress.step))) : [],
    [trip, spaces, progress.step]);
  const pendingTransfer = transfers.find(transfer => awaitingBoarding(progress, transfer.boardingStep));
  const atTransfer = !!pendingTransfer && progress.step >= pendingTransfer.transferStep;
  const scanPreference = params.get('scan');
  const scanning = view === 'map' && !!trip && progress.step < trip.steps.length &&
    (scanPreference === 'on' || (scanPreference !== 'off' && atTransfer));
  const cameraActive = fullCamera || scanning;
  const [space, setSpace] = useState<SpaceLayout>();
  const [arrivedSpace, setArrivedSpace] = useState<SpaceLayout>();
  const [currentCue, setIndoorCue] = useState<IndoorCue>();
  const [guideBearing, setGuideBearing] = useState<{ direction: GuideDirection; angleDeg?: number }>();
  const [requestedMotion, setRequestedMotion] = useState<MotionAccess>();
  const [nearDestinationSpace, setNearDestinationSpace] = useState<string>();
  const [nearDoor, setNearDoor] = useState<DoorProximity>();
  const [dismissedDoor, setDismissedDoor] = useState<DoorProximity>();
  const updateProximity = useCallback((near?: string, spaceId?: string, selectedTag?: number) => {
    setNearDestinationSpace(near);
    setNearDoor(previous => {
      if (!spaceId) return undefined;
      if (previous?.spaceId === spaceId && previous.selectedTag === selectedTag) return previous;
      return { spaceId, selectedTag };
    });
  }, []);
  const [referenceTag, setReferenceTag] = useState<TagReference>();
  const [minimapPose, setMinimapPose] = useState<MinimapPose>();
  const [candidates, setCandidates] = useState<string[]>([]);
  const preferredSpace = params.get('preferredSpace');
  const targetSpace = params.get('targetSpace');
  const targetId = integerParam(params.get('target'), 0, 586);
  const selectedTarget = useMemo(() => targetSpace && targetId !== undefined
    ? { spaceId: targetSpace, id: targetId } : undefined, [targetSpace, targetId]);
  const getTarget = useEffectEvent(() => selectedTarget);
  const getChoice = useEffectEvent(() => preferredSpace ? { preferredSpace } : undefined);
  const [activeRoute, setActiveRoute] = useState<{ spaceId: string; points: Point[] }>();
  const recordingSpace = useRef<string>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [indoorHint, setIndoorHint] = useState('');
  const [modelMessage, setModelMessage] = useState<{ text: string; id?: number }>();
  const modelNotice = modelMessage && t(modelMessage.text, modelMessage.id === undefined ? undefined : { id: modelMessage.id });
  const [camera, setCamera] = useState('태그 배치 불러오는 중');
  const [record, setRecord] = useState(idleView);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [available, setAvailable] = useState(false);
  const debug = useArDebug();
  const { current: debugSession, stop: stopDebug } = debug;
  const forJourney = useEffectEvent((layouts: SpaceLayout[]) =>
    trip ? layouts.map(layout => orientTransferLayout(trip, layout, progress.step)) : layouts);

  const getLanguage = useEffectEvent(() => language);
  const allowGuidance = useEffectEvent((layout: SpaceLayout) => {
    if (!trip || upcomingIndoorTransfer(trip, progress, layout.station, view === 'transfer')) return true;
    if (indoor) updateUrl({ view: 'map', scan: null, dialog: null });
    return false;
  });

  useEffect(() => {
    const recorder = new FieldRecorder(setRecord);
    client.current = recorder;
    void recorder.restore();
    return () => { recorder.dispose(); client.current = null; };
  }, []);

  useEffect(() => {
    if (!trip || cameraActive) return;
    const controller = new AbortController();
    watchTrackingSpaces(controller.signal, () => false, setSpaces, () => {});
    return () => controller.abort();
  }, [trip, cameraActive, spaceFilter]);

  useEffect(() => {
    if (!cameraActive) return;
    const controller = new AbortController();
    let passage: ReturnType<typeof openPassage> | undefined;
    let layouts: SpaceLayout[] = [];
    let previousTag: TagReference | undefined;
    setActiveRoute(undefined);
    setSpace(undefined); setReferenceTag(undefined); setMinimapPose(undefined); setCandidates([]);
    setArrivedSpace(undefined); setIndoorCue(undefined); updateProximity();
    setCameraError(''); setModelMessage(undefined); setIndoorHint(''); setCamera('태그 배치 불러오는 중');
    watchTrackingSpaces(controller.signal, () => !!recordingSpace.current, next => {
      layouts = forJourney(next);
      setSpaces(layouts);
      if (passage) {
        const target = getTarget();
        if (target && !layouts.some(s => s.id === target.spaceId)) {
          updateUrl({ targetSpace: null, target: null });
        }
        if (getChoice() && !layouts.some(s => s.id === getChoice()?.preferredSpace)) updateUrl({ preferredSpace: null });
        previousTag = undefined;
        setSpace(old => layouts.find(s => s.id === old?.id));
        setReferenceTag(undefined); setCandidates([]); setArrivedSpace(undefined);
        setActiveRoute(target && { spaceId: target.spaceId, points: [] });
        updateProximity(); setIndoorCue(undefined); setIndoorHint('새 배치에서 위치를 확인하려면 태그를 비추세요.');
        passage.updateLayouts(layouts);
        return;
      }
      passage = openPassage(video.current!, guideCanvas.current!, overlay.current!, modelCanvas.current!, layouts, {
        language: () => getLanguage(),
        ready() { setCameraError(''); setAvailable(true); setCamera('태그 탐색 중'); },
        allowGuidance,
        selection: getChoice,
        destination: getTarget,
        route: (spaceId, points) => setActiveRoute({ spaceId, points }),
        recordingSpace: () => recordingSpace.current,
        debug: () => debugSession.current,
        minimap: setMinimapPose,
        destinationNearby: updateProximity,
        cue: setIndoorCue,
        direction: (direction, angleDeg) => setGuideBearing(direction && { direction, angleDeg }),
        arrived(layout) {
          setArrivedSpace(layout);
          const time = Date.now();
          if (trip) advance(current => progressAtIndoorArrival(trip, current, layout, time));
        },
        chooseSpace(ids) {
          setCandidates(previous => previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids);
        },
        tagSeen(tag) {
          setReferenceTag(previous => previous?.spaceId === tag.spaceId && previous.id === tag.id ? previous : tag);
          setCandidates(previous => previous.length ? [] : previous);
          if (trip && (tag.spaceId !== previousTag?.spaceId || tag.id !== previousTag.id)) {
            const layout = layouts.find(layout => layout.id === tag.spaceId);
            const time = Date.now();
            if (layout) advance(current => progressAtTag(trip, current, layout.station, tag.id, time));
          }
          previousTag = tag;
        },
        located(layout) {
          if (getChoice() && getChoice()?.preferredSpace !== layout.id) updateUrl({ preferredSpace: null });
          setArrivedSpace(previous => previous?.id === layout.id ? previous : undefined);
          setSpace(layout); setReferenceTag(tag => tag?.spaceId === layout.id ? tag : undefined); setCandidates([]);
          if (new URLSearchParams(location.search).get('view') === 'map') updateUrl({ view: 'transfer', dialog: null }, 'push');
        },
        error: setCameraError, modelNotice: (text, id) => setModelMessage(text ? { text, id } : undefined),
        state(status, hint = '') { setCamera(status); setIndoorHint(hint); },
        frame: (canvas, at, time, intrinsics, fix) => client.current?.capture(canvas, at, time, intrinsics, fix),
        pause() {
          stopDebug();
          updateProximity(); setAvailable(false); setIndoorHint(''); setCamera('카메라 대기');
          void client.current?.stop('interrupted');
        },
      });
    }, () => setCameraError('역의 태그 배치를 불러올 수 없습니다. 다시 연결해 주세요.'));
    return () => { controller.abort(); passage?.close(); };
  }, [cameraActive, attempt, debugSession, stopDebug, trip, advance, spaceFilter, updateProximity]);

  function returnToMap() {
    if (view === 'transfer') updateUrl({ view: 'map', scan: 'off', dialog: null }, 'push');
    else navigation.finish();
  }

  async function toggle() {
    setWorking(true); setMessage('');
    try {
      if (record.phase === 'recording') await client.current?.stop();
      else if (available && cameraLayout && video.current) {
        recordingSpace.current = cameraLayout.id;
        await client.current?.start(cameraLayout.station, video.current);
      }
    } catch (e) {
      recordingSpace.current = undefined;
      setMessage(e instanceof Error ? e.message : '기기 저장 공간과 브라우저 권한을 확인하세요');
    }
    finally { setWorking(false); }
  }

  useEffect(() => {
    if (record.phase !== 'recording' && !working) recordingSpace.current = undefined;
  }, [record.phase, working]);

  async function attach(scan: File | undefined) {
    if (!scan) return;
    setWorking(true); setMessage('스캔을 전송하는 중');
    try { await client.current?.attach(scan); setMessage('스캔 첨부 완료'); }
    catch (e) { setMessage(e instanceof Error ? e.message : '연결을 확인하고 다시 첨부하세요'); }
    finally { setWorking(false); }
  }

  let detail = camera;
  if (record.phase !== 'idle') {
    const parts = [t('{count}장 저장', { count: record.sent })];
    if (record.total > record.sent) parts.push(t('{count}장 전송 대기', { count: record.total - record.sent }));
    if (record.capture) {
      const samples = record.accelerationSamples ?? 0;
      parts.push(samples ? t('가속도 {count}건', { count: samples.toLocaleString(locale) })
        : t(record.capture.motionPermission === 'denied' ? '모션 권한 거부됨'
        : record.capture.motionPermission === 'unavailable' ? '가속도 센서 미지원' : '가속도 수신 없음'));
      if (record.phase === 'done' && !record.videoBytes) parts.push(t('영상 없음'));
    }
    if (record.phase === 'done' && !record.capture && !record.cloud) parts.push(t('3D 계산 중'));
    if (record.cloud?.state === 'ready') parts.push(t('3D 점 {count}개', { count: record.cloud.points.toLocaleString(locale) }));
    if (record.cloud?.state === 'insufficient') parts.push(t('3D 대응점 부족'));
    if (record.cloud?.state === 'error') parts.push(t('3D 계산 실패'));
    detail = parts.join(' · ');
  }
  const recording = record.phase === 'recording';
  const tagLayout = referenceTag && spaces.find(layout => layout.id === referenceTag.spaceId);
  const cameraLayout = tagLayout ?? spaces.find(layout => layout.id === (preferredSpace ?? selectedTarget?.spaceId)) ?? space ??
    (spaces.length === 1 ? spaces[0] : view === 'field' ? spaces.find(layout => layout.id === 'default') : undefined);
  const customTarget = cameraLayout && selectedTarget?.spaceId === cameraLayout.id ? selectedTarget.id : undefined;
  const visibleRoute = activeRoute && activeRoute.spaceId === cameraLayout?.id ? activeRoute.points : undefined;
  const targetIds = useMemo(() => cameraLayout ? Object.keys((cameraLayout.network ?? tagNetwork(cameraLayout.station)).anchors).map(Number) : [], [cameraLayout]);
  const defaultTarget = cameraLayout?.station.tagGraph?.endTag ?? (cameraLayout?.station.autoRoute || undefined)?.endTag;
  const nearDestination = nearDestinationSpace !== undefined && nearDestinationSpace === cameraLayout?.id && !candidates.length;
  const atArrival = !!arrivedSpace && arrivedSpace.id === cameraLayout?.id && !candidates.length;
  const doorInRange = indoor && fullCamera && available && !cameraError && !candidates.length &&
    !!nearDoor && nearDoor.spaceId === cameraLayout?.id && nearDoor.selectedTag === customTarget &&
    (!preferredSpace || preferredSpace === nearDoor.spaceId);
  const doorTarget = useMemo(() => doorInRange && cameraLayout
    ? boardingTarget(cameraLayout.station, trip, progress.step, customTarget) : undefined,
    [doorInRange, cameraLayout, trip, progress.step, customTarget]);
  const showDoor = !!doorTarget && dismissedDoor !== nearDoor;
  useEffect(() => {
    if (indoor && !showDoor) indoorHeading.current?.focus({ preventScroll: true });
  }, [fullCamera, indoor, showDoor]);
  const adminSpace = view === 'field' && space ? space.id : currentSpace();
  const adminUrl = withQuery(new URL(import.meta.env.BASE_URL + 'admin/', location.origin), {
    space: adminSpace === 'default' ? null : adminSpace, lang: params.get('lang'), vp: params.get('vp'),
  }).href;
  const retryCamera = () => setAttempt(a => a + 1);
  const estimating = minimapPose?.source === 'motion' && minimapPose.spaceId === cameraLayout?.id;
  const trackingStatus = estimating && camera === '태그 탐색 중' ? '위치 추정 중' : camera;
  let trackingHint = indoorHint;
  if (available && !trackingHint) {
    if (estimating) trackingHint = '다음 태그를 비추면 추정 위치가 보정됩니다.';
    else if (minimapPose?.source === 'last' && minimapPose.spaceId === cameraLayout?.id)
      trackingHint = '위치 추적을 재개하려면 등록된 태그를 다시 비추세요.';
    else trackingHint = '현재 위치를 확인하려면 태그를 비추세요.';
  }
  const arrivalCue = atArrival ? indoorCue(arrivedSpace, undefined, true, customTarget, language) : undefined;
  const latestCue = arrivalCue ?? currentCue;
  const visibleCue = available && !cameraError && !candidates.length && latestCue?.language === language ? latestCue : undefined;
  const guideHint = visibleCue?.text ?? (nearDestination && camera !== '위치 인식'
    ? '마지막으로 확인한 위치가 도착 지점 근처입니다.' : trackingHint);
  const turn = visibleCue?.turn;
  const reorient = available && !cameraError && !candidates.length ? guideBearing?.direction : undefined;
  const compass = reorient && !showDoor &&
    <svg className="passage-reorient" data-direction={reorient} viewBox="0 0 24 24" fill="none" role="img"
      aria-label={t({ forward: '앞쪽', left: '왼쪽', right: '오른쪽', behind: '뒤쪽' }[reorient])}>
      <path d="M12 20V4m-7 7 7-7 7 7"
        transform={`rotate(${guideBearing?.angleDeg ?? { forward: 0, left: -90, right: 90, behind: 180 }[reorient]} 12 12)`}
        stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>;
  function enableMotion() {
    if (motionAccess() === 'prompt') void requestMotionAccess().then(setRequestedMotion);
  }
  const sensorAccess = motionAccess();
  const motionPermission = sensorAccess === 'prompt' ? requestedMotion ?? sensorAccess : sensorAccess;
  const motionControl = available && !cameraError && (motionPermission === 'prompt'
    ? <button className="settings-trigger" type="button" onClick={enableMotion}>{t('동작 센서 켜기')}</button>
    : motionPermission === 'denied' && <small role="status">{t('태그 없이 방향을 갱신하려면 브라우저 설정에서 동작 센서를 허용하세요.')}</small>);
  const spacePicker = candidates.length > 0 && available && !cameraError && <label className="tracking-space-picker">
    {t('현재 공간')}
    <select value="" onChange={event => {
      const layout = spaces.find(item => item.id === event.target.value);
      if (!layout) return;
      updateUrl({ preferredSpace: layout.id }); setSpace(undefined); setReferenceTag(undefined); setMinimapPose(undefined); setCandidates([]);
      updateProximity();
      setCamera('태그 탐색 중'); setIndoorHint('');
    }}>
      <option value="" disabled>{t('공간 선택')}</option>
      {spaces.filter(item => candidates.includes(item.id)).map(item =>
        <option key={item.id} value={item.id}>{view === 'field' ? spaceLabel(item.station, language) : indoorSpaceName(item.station, language)}</option>)}
    </select>
  </label>;
  return (
    <main className={fullCamera ? 'camera-screen' : undefined} data-indoor={indoor} data-screen-door={showDoor} aria-label={t('역 길안내')}>
      {navigation.guiding && !trip ? <div className="navigation">
        <header className="journey-header"><span className="journey-brand">{t('역 길안내')}</span><LanguageSelect /><HomeButton onClick={navigation.reset} /></header>
        <section className="journey-panel" aria-live="polite"><h1>{t('2D 길 안내')}</h1>
          <p>{t(navigation.restoreError || '경로 불러오는 중…')}</p>
          {navigation.restoreError && <button type="button" onClick={navigation.retry}>{t('다시 시도')}</button>}
          <button type="button" onClick={navigation.finish}>{t('안내 종료')}</button>
        </section>
      </div> : view !== 'field' && <Navigation key={navigation.resetCount} navigation={navigation} transfers={transfers} pendingTransfer={pendingTransfer} updateGps={updateGps} indoor={indoor} adminUrl={adminUrl}
        startIndoor={() => {
          enableMotion();
          prepareIndoorVoice('역 안 안내를 시작합니다. 태그를 비추세요.', language);
          updateUrl({ ...clearGuidance, view: 'indoor' }, 'push');
        }}
        scanner={{ enabled: scanning, ready: available, error: scanning ? cameraError : '', retry: retryCamera, spacePicker, motionControl,
          toggle: () => {
            if (!scanning) {
              enableMotion();
              prepareIndoorVoice('태그 인식을 시작합니다.', language);
            }
            updateUrl({ scan: scanning ? 'off' : 'on' });
          },
          status: indoorHint || (available ? '' : camera) }} />}
      {cameraActive && <div className={view === 'map' ? 'passage-stage scan-preview' : 'passage-stage'}
        data-ready={available} aria-label={view === 'map' ? t('역 태그 인식 카메라') : t('역사 통로 AR')}>
        <video ref={video} autoPlay playsInline muted disablePictureInPicture aria-label={t('후면 카메라')} />
        <canvas ref={guideCanvas} className="floor-guide" aria-label={t('실내 경로의 바닥 유도선과 화살표')} />
        <canvas ref={overlay} className="tag-overlay" aria-label={t('인식한 태그')} />
        <canvas ref={modelCanvas} className="model-overlay" aria-label={t('태그 위 3D 모델')} />
        {indoor && !showDoor && available && !cameraError && !estimating && camera === '태그 탐색 중' && !nearDestination &&
          <svg className="passage-viewfinder" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path d="M3 24V3h21m52 0h21v21m0 52v21H76m-52 0H3V76"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>}
        {view === 'map' && available && !cameraError && <span className="preview-label">{t('태그 인식 중')}</span>}
      </div>}
      {showDoor && <ScreenDoorCapture key={JSON.stringify([nearDoor, doorTarget])} video={video} target={doorTarget}
        back={() => setDismissedDoor(nearDoor)} finish={returnToMap} reset={navigation.reset} finishLabel={trip ? t('2D 지도로 돌아가기') : t('실내 안내 종료')} />}
      {fullCamera && <div className="camera-controls">
        {indoor && <section className="indoor-guide" aria-label={t('역 안 AR 안내')}>
          <h1 ref={indoorHeading} tabIndex={-1}>{t('역 안 AR 안내')}</h1>
          <div className="indoor-instruction">
            {compass}
            <span role="status">{turn ? <>
              <strong className="turn-action">{turn.action}</strong>
              {turn.passage && <small className="turn-passage">{turn.passage}</small>}
            </> : t(cameraError || guideHint || camera)}</span>
          </div>
          <IndoorVoice key={(cameraLayout?.id ?? '') + '/' + (customTarget ?? 'default')} cue={visibleCue}
            hint={available && !cameraError && !candidates.length && !showDoor && guideHint ? t(guideHint) : undefined} />
          {motionControl}
          {available && !cameraError && !candidates.length && !nearDestination &&
            <LivePassageProgress layout={cameraLayout} points={visibleRoute} pose={minimapPose} />}
          {!trip && cameraLayout && (targetIds.length > 0 || customTarget !== undefined) && !candidates.length && <label className="tracking-space-picker">
            {t('실내 목적지')}
            <select aria-label={t('실내 목적지')} value={customTarget ?? ''} onChange={event => {
              const value = event.target.value;
              const target = value === '' ? undefined : { spaceId: cameraLayout.id, id: Number(value) };
              updateUrl({ targetSpace: target?.spaceId ?? null, target: target?.id ?? null });
              setActiveRoute({ spaceId: cameraLayout.id, points: [] }); setArrivedSpace(undefined);
              setIndoorCue(undefined); updateProximity(); setIndoorHint('목적지까지 안내하려면 태그를 비추세요.');
            }}>
              <option value="">{t('기본 도착점')}{defaultTarget !== undefined && ' · ' + t('태그 {id}', { id: defaultTarget })}</option>
              {customTarget !== undefined && !targetIds.includes(customTarget) &&
                <option value={customTarget} disabled>{t('태그')} {customTarget} {t('· 경로 없음')}</option>}
              {targetIds.filter(id => id !== defaultTarget || id === customTarget).map(id => <option key={id} value={id}>{t('태그 {id}', { id })}</option>)}
            </select>
          </label>}
          {trip && <p className="indoor-context">{progress.step === trip.steps.length ? t('최종 도착지에 도착했습니다') : t('최종 도착지')} · {placeLabel(trip.destination.name, language)}</p>}
          {doorInRange && !showDoor && <button type="button" onClick={() => setDismissedDoor(undefined)}>{t('스크린도어 촬영')}</button>}
          {(nearDestination || atArrival) && <button type="button" className="return-to-map" onClick={returnToMap}>{trip ? t('2D 지도로 돌아가기') : t('실내 안내 종료')}</button>}
          {spacePicker}
          {modelNotice && <small>{modelNotice}</small>}
          {cameraError && <button type="button" onClick={retryCamera}>{t('다시 연결')}</button>}
        </section>}
        {view === 'field' && <section className="capture-bar" aria-label={t('실험 기록')}>
          <div className="capture-readout">
            <strong>{compass}<i data-state={recording ? 'recording' : available && camera === '위치 인식' ? 'located' : 'waiting'} aria-hidden="true" />
              {record.phase === 'done' ? (record.interrupted ? t('중단된 녹화 자료') : t('기록 완료')) : record.phase === 'saving' ? t('자료 저장 중') : recording ? t('녹화 중') + ' · ' + t(trackingStatus) : t(cameraError || trackingStatus)}
              {(camera === '위치 인식' || estimating) && space && ' · ' + spaceLabel(space.station, language)}
            </strong>
            {(record.phase !== 'idle' || message) && <small>{uploadNotice(message || record.notice || detail, t)}</small>}
            {!cameraError && trackingHint && <small role="status">{t(trackingHint)}</small>}
            {motionControl}
            {spacePicker}
            {modelNotice && <small>{modelNotice}</small>}
          </div>
          <button type="button" className="capture-action" data-recording={recording} onClick={() => void toggle()}
            disabled={working || record.phase === 'saving' || (!recording && (!available || !cameraLayout || candidates.length > 0))}>
            <span aria-hidden="true" />{recording ? t('기록 종료') : t('기록 시작')}
          </button>
          {cameraError && <button type="button" onClick={retryCamera}>{t('다시 연결')}</button>}
          {record.phase === 'done' && <div className="files">
            {record.capture && <a href={import.meta.env.BASE_URL + 'api/recordings/' + record.id + '/capture.zip'} download>{t('녹화 자료 받기')}</a>}
            {record.cloud?.state === 'ready' && <a href={import.meta.env.BASE_URL + 'api/recordings/' + record.id + '/scene.ply'} download>{t('3D 받기')}</a>}
            <button type="button" disabled={working} onClick={() => file.current?.click()}>{t('스캔 첨부')}</button>
            <input ref={file} type="file" accept=".ply,.usdz" hidden onChange={e => {
              const selected = e.target.files?.[0]; e.target.value = ''; void attach(selected);
            }} />
          </div>}
        </section>}
        <div className="camera-menu">
          <LanguageSelect />
          <SignReader video={video} />
          {view === 'field' && <ArDebugControls debug={debug} ready={available} />}
          {indoor && <HomeButton onClick={navigation.reset} />}
          {indoor && trip && !nearDestination && !atArrival && <button type="button" className="settings-trigger" onClick={returnToMap}>{t('2D 지도로')}</button>}
          {view === 'field' && <div className="field-menu">
            <HomeButton disabled={working || recording || record.phase === 'saving'} onClick={navigation.reset} />
            <button type="button" disabled={working || recording || record.phase === 'saving'}
              onClick={() => window.location.assign(adminUrl)}>{t('관리자 페이지')}</button>
          </div>}
        </div>
      </div>}
      {cameraActive && <div className="camera-dock" hidden={!fullCamera}>
        <IndoorMinimap route={visibleRoute} customTarget={customTarget} guided={indoor} layout={cameraLayout} referenceTagId={tagLayout && referenceTag?.id} preview={!space && !tagLayout}
          pose={minimapPose} />
      </div>}
    </main>
  );
}
