import { useCallback, useEffect, useRef, useState } from 'react';
import { SignReader } from './SignReader';
import { openPassage, type TagReference } from './ar/camera';
import { IndoorMinimap } from './ar/IndoorMinimap';
import { LivePassageProgress } from './ar/PassageProgress';
import { ArDebugControls, useArDebug } from './ar/ArDebugControls';
import type { MinimapPose } from './ar/indoorTracking';
import { FieldRecorder, idleView } from './ar/recording';
import { currentSpace, loadTrackingSpaces, spaceLabel, stationName, type SpaceLayout } from './ar/station';
import { Navigation } from './navigation/Navigation';
import { progressAtGps, type GeoPoint, type Journey, type JourneyProgress } from './navigation/routes';
import { progressAtTag } from './navigation/stationProgress';

type Screen = { view: 'home' | 'field' } | { view: 'map'; trip: Journey; scanning: boolean } | { view: 'ar'; trip?: Journey };

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const modelCanvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const indoorHeading = useRef<HTMLHeadingElement>(null);
  const client = useRef<FieldRecorder | null>(null);
  const [screen, setScreen] = useState<Screen>(() => ({
    view: new URLSearchParams(location.search).get('view') === 'ar' ? 'field' : 'home',
  }));
  const { view } = screen;
  const trip = 'trip' in screen ? screen.trip : undefined;
  const [progress, setProgress] = useState<JourneyProgress>({ step: 0 });
  const updateGps = useCallback((position: GeoPoint, accuracy: number, timestamp: number) => {
    if (!trip) return;
    setProgress(current => progressAtGps(trip, current, position, accuracy, timestamp));
  }, [trip]);
  const scanning = screen.view === 'map' && screen.scanning;
  const fullCamera = view === 'field' || view === 'ar';
  const cameraActive = fullCamera || scanning;
  const [spaces, setSpaces] = useState<SpaceLayout[]>([]);
  const [space, setSpace] = useState<SpaceLayout>();
  const [nearDestinationSpace, setNearDestinationSpace] = useState<string>();
  const [referenceTag, setReferenceTag] = useState<TagReference>();
  const [minimapPose, setMinimapPose] = useState<MinimapPose>();
  const [candidates, setCandidates] = useState<string[]>([]);
  const choice = useRef<{ preferredSpace: string }>(undefined);
  const recordingSpace = useRef<string>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [indoorHint, setIndoorHint] = useState('');
  const [modelNotice, setModelNotice] = useState('');
  const [camera, setCamera] = useState('태그 배치 불러오는 중');
  const [record, setRecord] = useState(idleView);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [available, setAvailable] = useState(false);
  const debug = useArDebug();
  const { current: debugSession, stop: stopDebug } = debug;

  useEffect(() => {
    if (view === 'ar') indoorHeading.current?.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    const recorder = new FieldRecorder(setRecord);
    client.current = recorder;
    void recorder.restore();
    return () => { recorder.dispose(); client.current = null; };
  }, []);

  useEffect(() => {
    if (!cameraActive) return;
    const controller = new AbortController();
    let close: (() => void) | undefined;
    choice.current = undefined;
    setSpace(undefined); setReferenceTag(undefined); setMinimapPose(undefined); setCandidates([]); setSpaces([]);
    setCameraError(''); setModelNotice(''); setIndoorHint(''); setCamera('태그 배치 불러오는 중');
    void loadTrackingSpaces(controller.signal).then(layouts => {
      if (controller.signal.aborted) return;
      setSpaces(layouts);
      let previousTag: TagReference | undefined;
      close = openPassage(video.current!, overlay.current!, modelCanvas.current!, layouts, {
        ready() { setCameraError(''); setAvailable(true); setCamera('태그 탐색 중'); },
        selection: () => choice.current,
        recordingSpace: () => recordingSpace.current,
        debug: () => debugSession.current,
        minimap: setMinimapPose,
        destinationNearby: setNearDestinationSpace,
        chooseSpace(ids) {
          setCandidates(previous => previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids);
        },
        tagSeen(tag) {
          setReferenceTag(previous => previous?.spaceId === tag.spaceId && previous.id === tag.id ? previous : tag);
          setCandidates(previous => previous.length ? [] : previous);
          if (trip && (tag.spaceId !== previousTag?.spaceId || tag.id !== previousTag.id)) {
            const layout = layouts.find(layout => layout.id === tag.spaceId);
            const time = Date.now();
            if (layout) setProgress(current => progressAtTag(trip, current, layout.station, tag.id, time));
          }
          previousTag = tag;
        },
        located(layout) {
          if (choice.current?.preferredSpace !== layout.id) choice.current = undefined;
          setSpace(layout); setReferenceTag(tag => tag?.spaceId === layout.id ? tag : undefined); setCandidates([]);
          setScreen(s => s.view === 'map' && s.scanning ? { view: 'ar', trip: s.trip } : s);
        },
        error: setCameraError, modelNotice: setModelNotice,
        state(status, hint = '') { setCamera(status); setIndoorHint(hint); },
        frame: (canvas, at, time, intrinsics, fix) => client.current?.capture(canvas, at, time, intrinsics, fix),
        pause() {
          stopDebug();
          setNearDestinationSpace(undefined); setAvailable(false); setIndoorHint(''); setCamera('카메라 대기');
          void client.current?.stop('interrupted');
        },
      });
    }).catch(() => {
      if (!controller.signal.aborted) setCameraError('역의 태그 배치를 불러올 수 없습니다. 다시 연결해 주세요.');
    });
    return () => { controller.abort(); close?.(); };
  }, [cameraActive, attempt, debugSession, stopDebug, trip]);

  function returnToMap() {
    setScreen(s => s.view === 'ar' && s.trip ? { view: 'map', trip: s.trip, scanning: false } : { view: 'home' });
    if (view === 'field') {
      const url = new URL(location.href);
      url.searchParams.delete('view');
      history.replaceState(history.state, '', url);
    }
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
    detail = record.sent + '장 저장';
    if (record.total > record.sent) detail += ' · ' + (record.total - record.sent) + '장 전송 대기';
    if (record.capture) {
      const samples = record.accelerationSamples ?? 0;
      detail += samples ? ' · 가속도 ' + samples.toLocaleString() + '건'
        : record.capture.motionPermission === 'denied' ? ' · 모션 권한 거부됨'
        : record.capture.motionPermission === 'unavailable' ? ' · 가속도 센서 미지원' : ' · 가속도 수신 없음';
      if (record.phase === 'done' && !record.videoBytes) detail += ' · 영상 없음';
    }
    if (record.phase === 'done' && !record.capture && !record.cloud) detail += ' · 3D 계산 중';
    if (record.cloud?.state === 'ready') detail += ' · 3D 점 ' + record.cloud.points.toLocaleString() + '개';
    if (record.cloud?.state === 'insufficient') detail += ' · 3D 대응점 부족';
    if (record.cloud?.state === 'error') detail += ' · 3D 계산 실패';
  }
  const recording = record.phase === 'recording';
  const tagLayout = referenceTag && spaces.find(layout => layout.id === referenceTag.spaceId);
  const cameraLayout = tagLayout ?? spaces.find(layout => layout.id === choice.current?.preferredSpace) ?? space ??
    (spaces.length === 1 ? spaces[0] : spaces.find(layout => layout.id === 'default'));
  const nearDestination = nearDestinationSpace !== undefined && nearDestinationSpace === cameraLayout?.id && !candidates.length;
  const adminSpace = view === 'field' && space ? space.id : currentSpace();
  const adminUrl = import.meta.env.BASE_URL + 'admin/' + (adminSpace === 'default' ? '' : '?space=' + encodeURIComponent(adminSpace));
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
  const guideHint = nearDestination && camera !== '위치 인식' ? '마지막으로 확인한 위치가 도착 지점 근처입니다.' : trackingHint;
  const spacePicker = candidates.length > 0 && available && !cameraError && <label className="tracking-space-picker">
    현재 공간
    <select value="" onChange={event => {
      const layout = spaces.find(item => item.id === event.target.value);
      if (!layout) return;
      choice.current = { preferredSpace: layout.id }; setSpace(undefined); setReferenceTag(undefined); setMinimapPose(undefined); setCandidates([]);
      setCamera('태그 탐색 중'); setIndoorHint('');
    }}>
      <option value="" disabled>공간 선택</option>
      {spaces.filter(item => candidates.includes(item.id)).map(item =>
        <option key={item.id} value={item.id}>{spaceLabel(item.station)}</option>)}
    </select>
  </label>;
  return (
    <main className={fullCamera ? 'camera-screen' : undefined} aria-label="역 길안내">
      {view !== 'field' && <Navigation trip={trip} progress={progress} updateGps={updateGps} indoor={view === 'ar'} adminUrl={adminUrl}
        startIndoor={() => setScreen({ view: 'ar' })}
        openField={() => setScreen({ view: 'field' })} start={(trip, position) => {
          setProgress({ step: 0, position }); setScreen({ view: 'map', trip, scanning: true });
        }}
        finish={() => setScreen({ view: 'home' })}
        scanner={{ enabled: scanning, error: scanning ? cameraError : '', retry: retryCamera, spacePicker,
          toggle: () => setScreen(s => s.view === 'map' ? { ...s, scanning: !s.scanning } : s),
          status: indoorHint || (available ? '역에 들어가면 후면 카메라로 AprilTag를 비추세요.' : camera) }} />}
      {cameraActive && <div className={view === 'map' ? 'passage-stage scan-preview' : 'passage-stage'}
        data-ready={available} aria-label={view === 'map' ? '역 태그 인식 카메라' : '역사 통로 AR'}>
        <video ref={video} autoPlay playsInline muted disablePictureInPicture aria-label="후면 카메라" />
        <canvas ref={overlay} className="tag-overlay" aria-label="인식한 태그와 바닥 안내 화살표" />
        <canvas ref={modelCanvas} className="model-overlay" aria-label="태그 위 3D 모델" />
        {view === 'ar' && available && !cameraError && !estimating && camera === '태그 탐색 중' && !nearDestination &&
          <svg className="passage-viewfinder" viewBox="0 0 100 100" fill="none" aria-hidden="true">
            <path d="M3 24V3h21m52 0h21v21m0 52v21H76m-52 0H3V76"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>}
        {view === 'map' && <span className="preview-label">태그 인식 중</span>}
      </div>}
      {fullCamera && <div className="camera-controls">
        {view === 'ar' && <section className="indoor-guide" aria-label="역 안 AR 안내">
          <h1 ref={indoorHeading} tabIndex={-1}>역 안 AR 안내</h1>
          {space && <p>{camera === '위치 인식' || estimating ? '현재 공간' : '마지막 확인 공간'} · {spaceLabel(space.station)}</p>}
          {trip && <p>최종 도착지 · {trip.destination.name}</p>}
          {trip && progress.station && <p role="status">{progress.step === trip.steps.length
            ? '도착지에 도착했습니다.' : '태그로 확인한 역 · ' + stationName(progress.station)}</p>}
          <span role="status">{cameraError || guideHint || camera}</span>
          {available && !cameraError && !candidates.length && !nearDestination &&
            <LivePassageProgress layout={cameraLayout} pose={minimapPose} />}
          {nearDestination && <button type="button" className="return-to-map" onClick={returnToMap}>2D 지도로 돌아가기</button>}
          {spacePicker}
          {modelNotice && <small>{modelNotice}</small>}
          {cameraError && <button type="button" onClick={retryCamera}>다시 연결</button>}
        </section>}
        {view === 'field' && <section className="capture-bar" aria-label="실험 기록">
          <div className="capture-readout">
            <strong><i data-state={recording ? 'recording' : available && camera === '위치 인식' ? 'located' : 'waiting'} aria-hidden="true" />
              {record.phase === 'done' ? (record.interrupted ? '중단된 녹화 자료' : '기록 완료') : record.phase === 'saving' ? '자료 저장 중' : recording ? '녹화 중 · ' + trackingStatus : cameraError || trackingStatus}
              {(camera === '위치 인식' || estimating) && space && ' · ' + spaceLabel(space.station)}
            </strong>
            {(record.phase !== 'idle' || message) && <small>{message || record.notice || detail}</small>}
            {!cameraError && trackingHint && <small role="status">{trackingHint}</small>}
            {spacePicker}
            {modelNotice && <small>{modelNotice}</small>}
          </div>
          <button type="button" className="capture-action" data-recording={recording} onClick={() => void toggle()}
            disabled={working || record.phase === 'saving' || (!recording && (!available || !cameraLayout || candidates.length > 0))}>
            <span aria-hidden="true" />{recording ? '기록 종료' : '기록 시작'}
          </button>
          {cameraError && <button type="button" onClick={retryCamera}>다시 연결</button>}
          {record.phase === 'done' && <div className="files">
            {record.capture && <a href={import.meta.env.BASE_URL + 'api/recordings/' + record.id + '/capture.zip'} download>녹화 자료 받기</a>}
            {record.cloud?.state === 'ready' && <a href={import.meta.env.BASE_URL + 'api/recordings/' + record.id + '/scene.ply'} download>3D 받기</a>}
            <button type="button" disabled={working} onClick={() => file.current?.click()}>스캔 첨부</button>
            <input ref={file} type="file" accept=".ply,.usdz" hidden onChange={e => {
              const selected = e.target.files?.[0]; e.target.value = ''; void attach(selected);
            }} />
          </div>}
        </section>}
        <div className="camera-menu">
          <SignReader video={video} />
          <ArDebugControls debug={debug} ready={available} />
          {view === 'ar' && !nearDestination && <button type="button" className="settings-trigger" onClick={returnToMap}>{trip ? '2D 지도로' : '첫 화면'}</button>}
          {view === 'field' && <div className="field-menu">
            <button type="button" disabled={working || recording || record.phase === 'saving'} onClick={returnToMap}>첫 화면</button>
            <button type="button" disabled={working || recording || record.phase === 'saving'}
              onClick={() => window.location.assign(adminUrl)}>관리자 페이지</button>
          </div>}
        </div>
      </div>}
      {cameraActive && <div className="camera-dock" hidden={!fullCamera}>
        <IndoorMinimap layout={cameraLayout} referenceTagId={tagLayout && referenceTag?.id} preview={!space && !tagLayout}
          pose={minimapPose} cameraReady={available} />
      </div>}
    </main>
  );
}
