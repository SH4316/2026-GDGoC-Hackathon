import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';

import { IndoorTracking, type CameraPose, type MinimapPose } from './indoorTracking';
import { readMotion, screenAngle } from './motion';
import { watchCameraFrames } from './videoFrames';
import type { Fix, Intrinsics } from './recording';
import type { Point, SpaceLayout } from './station';
import type { TagModels } from './models';
import type { DebugSession } from './debugSession';

type SpaceSelection = { preferredSpace: string };
export type TagReference = { spaceId: string; id: number };
type Hooks = {
  ready: () => void;
  located: (space: SpaceLayout) => void;
  destinationNearby: (spaceId: string | undefined) => void;
  minimap: (pose: MinimapPose | undefined) => void;
  tagSeen: (tag: TagReference) => void;
  chooseSpace: (ids: string[]) => void;
  selection: () => SpaceSelection | undefined;
  recordingSpace: () => string | undefined;
  debug: () => DebugSession | null;
  error: (message: string) => void;
  state: (state: string, indoorHint?: string) => void;
  modelNotice: (message: string) => void;
  frame: (canvas: HTMLCanvasElement, at: number, mediaTimeS: number, intrinsics: Intrinsics, fix: Fix | null) => void;
  pause: () => void;
};
type Detection = { id: number; image: Point[]; registered: boolean };
type Frame = { type: 'frame'; spaceId?: string; referenceTag?: TagReference; candidates?: string[]; fix: Fix | null;
  recording?: { spaceId: string; intrinsics: Intrinsics; fix: Fix | null };
  floorMotion?: CameraPose & { spaceId: string; referenceTimeMs: number }; intrinsics?: Intrinsics; detections: Detection[] };
type Reply = { type: 'ready' } | { type: 'error'; message: string } | Frame;

type StationPose = {
  spaceId?: string; positionM: Fix['position']; headingDeg: number | null;
  tagIds: number[]; reprojectionPx: number; frameTimeMs: number;
};
declare global {
  interface WindowEventMap { 'station-pose': CustomEvent<StationPose | null> }
}

const STALE_MS = 350;
const MAP_RETURN_RADIUS_M = 1;

function markTag(ctx: CanvasRenderingContext2D, tag: Detection, [left, top, right, bottom]: number[]) {
  const { width, height } = ctx.canvas;
  const size = Math.max(14, Math.round(Math.max(width, height) / 48));
  const xs = tag.image.map(p => p[0]), ys = tag.image.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 < left || x0 >= right || y1 < top || y0 >= bottom) return;
  ctx.save();
  ctx.strokeStyle = tag.registered ? '#67edb3' : '#fff0bd';
  ctx.lineWidth = Math.max(2, size / 7);
  if (!tag.registered) ctx.setLineDash([size / 3, size / 4]);
  ctx.beginPath();
  ctx.moveTo(...tag.image[0]);
  for (const corner of tag.image.slice(1)) ctx.lineTo(...corner);
  ctx.closePath();
  ctx.stroke();
  const label = 'ID ' + tag.id + (tag.registered ? '' : ' · 미등록');
  ctx.font = '600 ' + size + 'px system-ui, sans-serif';
  const labelWidth = Math.ceil(ctx.measureText(label).width) + 12;
  const labelHeight = size + 7, gap = 5;
  const spaceLeft = x0 - left, spaceRight = right - x1;
  let x = spaceLeft > spaceRight ? x0 - labelWidth - gap : x1 + gap;
  let y = y1 - labelHeight / 2;
  if (Math.max(spaceLeft, spaceRight) < labelWidth + gap) {
    x = (x0 + x1 - labelWidth) / 2;
    y = bottom - y1 >= labelHeight + gap ? y1 + gap : y0 - labelHeight - gap;
  }
  x = Math.max(left, Math.min(right - labelWidth, x));
  y = Math.max(top, Math.min(bottom - labelHeight, y));
  ctx.fillStyle = '#15231f';
  ctx.fillRect(x, y, labelWidth, labelHeight);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 6, y + labelHeight / 2);
  ctx.restore();
}

export function openPassage(video: HTMLVideoElement, overlay: HTMLCanvasElement, modelCanvas: HTMLCanvasElement,
                            spaces: SpaceLayout[], hooks: Hooks) {
  const lifetime = new AbortController();
  const capture = document.createElement('canvas');
  const pixels = capture.getContext('2d', { willReadFrequently: true })!;
  const drawing = overlay.getContext('2d')!;
  const base = import.meta.env.BASE_URL;
  let worker: Worker | undefined;
  let models: TagModels | undefined;
  const layouts = new Map(spaces.map(space => [space.id, space]));
  let modelSpace: SpaceLayout | undefined;
  let modelRevision = 0;
  let stream: MediaStream | undefined;
  let generation = 0;
  let opening = false;
  let ready = false;
  let busy = false;
  let stopFrames: (() => void) | undefined;
  let clearTimer: number | undefined;
  let frameMediaTime = 0;
  let frameAt = 0;
  let frameAngle = 0;
  let frameSelection: SpaceSelection | undefined;
  let frameBounds = [0, 0, 0, 0];
  let fixed = false;
  let tracking = new IndoorTracking();
  let motionTimer: number | undefined;
  let shownPose: MinimapPose | undefined;

  function publishMinimap() {
    const selectedId = hooks.selection()?.preferredSpace;
    if (selectedId && tracking.spaceId && selectedId !== tracking.spaceId) tracking = new IndoorTracking();
    const pose = tracking.pose(performance.now(), fixed);
    if (pose === shownPose || (pose && shownPose && pose.spaceId === shownPose.spaceId && pose.source === shownPose.source &&
        pose.headingDeg === shownPose.headingDeg && pose.point[0] === shownPose.point[0] && pose.point[1] === shownPose.point[1])) return;
    shownPose = pose;
    hooks.minimap(pose);
  }

  function onMotion(event: DeviceMotionEvent) {
    const sample = readMotion(event);
    const estimate = tracking.motion(sample);
    hooks.debug()?.motion(sample, fixed ? undefined : estimate);
  }

  function clear() {
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    models?.clear();
    if (fixed) window.dispatchEvent(new CustomEvent('station-pose', { detail: null }));
    fixed = false;
    publishMinimap();
  }

  function stop() {
    hooks.pause();
    generation++;
    opening = false;
    ready = false;
    busy = false;
    clearTimeout(clearTimer);
    stopFrames?.();
    stopFrames = undefined;
    worker?.terminate();
    worker = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    window.removeEventListener('devicemotion', onMotion);
    clearInterval(motionTimer);
    tracking.suspend();
    clear();
    models?.dispose();
    models = undefined;
    modelSpace = undefined;
    modelRevision++;
  }

  function expire() {
    clear();
    hooks.state('태그 탐색 중');
  }

  function paint({ spaceId, referenceTag, candidates, fix, floorMotion, detections, intrinsics }: Frame) {
    clearTimeout(clearTimer);
    const age = performance.now() - frameAt;
    if (age >= STALE_MS) { expire(); return; }
    if (floorMotion && tracking.correct(floorMotion.spaceId, floorMotion, frameAt, frameAngle, 'floor')) {
      hooks.debug()?.visual(frameAt, 'floor', floorMotion.spaceId, floorMotion.position);
    }
    if (!fix && !detections.length) { expire(); return; }
    if (referenceTag) {
      if (tracking.spaceId && referenceTag.spaceId !== tracking.spaceId) tracking = new IndoorTracking();
      hooks.tagSeen(referenceTag);
    }
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    const poly = fix?.arrow;
    if (poly) {
      drawing.beginPath();
      drawing.moveTo(...poly[0]);
      for (const point of poly.slice(1)) drawing.lineTo(...point);
      drawing.closePath();
      drawing.fillStyle = '#17c879';
      drawing.fill();
      drawing.lineWidth = Math.max(1.5, overlay.width / 310);
      drawing.lineJoin = 'round';
      drawing.strokeStyle = '#ffffff';
      drawing.stroke();
    }
    for (const tag of detections) markTag(drawing, tag, frameBounds);
    const space = spaceId ? layouts.get(spaceId) : undefined;
    const spaceChanged = space !== modelSpace;
    if (fix && space && spaceChanged) {
      models?.clear();
      models?.dispose();
      models = undefined;
      modelSpace = space;
      hooks.modelNotice('');
      const revision = ++modelRevision;
      void import('./models').then(({ TagModels }) => {
        if (revision === modelRevision) models = new TagModels(modelCanvas, space.station, hooks.modelNotice);
      }).catch(() => {
        if (revision === modelRevision) hooks.modelNotice('3D 표시를 시작할 수 없습니다. WebGL 2 지원 브라우저에서 다시 여세요.');
      });
    }
    if (fix && intrinsics && models) {
      try { models.draw(fix, intrinsics, overlay.width, overlay.height); }
      catch (error) {
        console.warn('3D 모델 표시 오류:', error);
        models.clear(); models.dispose(); models = undefined;
        hooks.modelNotice('3D 표시가 중단됐습니다. 카메라를 다시 열어 주세요.');
      }
    } else models?.clear();
    if (fix || fixed) {
      const forwardX = fix?.cameraToWorld[2] ?? 0, forwardY = fix?.cameraToWorld[6] ?? 0;
      // A nearly vertical lens has no reliable heading on the floor plan.
      const headingDeg = Math.hypot(forwardX, forwardY) > 0.1 ? Math.atan2(forwardX, forwardY) * 180 / Math.PI : null;
      window.dispatchEvent(new CustomEvent<StationPose | null>('station-pose', { detail: fix ? {
        spaceId, positionM: fix.position, headingDeg, tagIds: fix.ids, reprojectionPx: fix.rmsPx, frameTimeMs: frameAt,
      } : null }));
    }
    if ((!fixed || spaceChanged) && fix?.ids.length && space) hooks.located(space);
    fixed = !!fix;
    if (fix && space && tracking.correct(space.id, fix, frameAt, frameAngle, 'tag', space.station.route)) {
      hooks.debug()?.visual(frameAt, 'tag', space.id, fix.position);
    }
    publishMinimap();
    if (fix && space) {
      const end = space.station.route.at(-1);
      const nearby = !!end && Math.hypot(fix.position[0] - end[0], fix.position[1] - end[1]) <= MAP_RETURN_RADIUS_M;
      hooks.destinationNearby(nearby ? space.id : undefined);
      let hint = '다음 태그와 진행 방향의 바닥을 함께 비추세요.';
      if (!end) hint = '이 공간에 등록된 실내 경로가 없습니다.';
      else if (fix.arrived) {
        const stop = space.station.stationLinks?.find(stop => stop.routeEndpoint === 'end');
        hint = stop ? stop.line + ' 환승 위치에 도착했습니다.' : '실내 통로 경로가 끝났습니다.';
      }
      else if (nearby) hint = '실내 경로의 도착 지점이 가깝습니다.';
      else if (poly) hint = '바닥 화살표를 따라 이동하세요.';
      hooks.state('위치 인식', hint);
    } else if (referenceTag) {
      hooks.state('태그 감지', '내 위치를 확인하려면 태그 전체가 화면에 크게 보이도록 비추세요.');
    } else if (candidates?.length) {
      hooks.chooseSpace(candidates);
      hooks.state('공간 선택', '같은 태그가 여러 공간에 등록되어 있습니다.');
    } else if (candidates) {
      hooks.state('공간 확인 필요', '한 공간의 태그만 비추세요.');
    } else hooks.state('태그 감지', detections.some(tag => tag.registered)
      ? '위치를 확인하려면 태그를 조금 더 가까이 비추세요.' : '미등록 태그 ID ' + detections[0].id + ' · 이 공간에 등록된 태그를 비추세요.');
    clearTimer = window.setTimeout(expire, Math.max(0, STALE_MS - (performance.now() - frameAt)));
  }

  function sample(now: number, mediaTime: number) {
    if (!worker || !ready || busy || video.readyState < 2) return false;
    const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * ratio);
    const h = Math.round(video.videoHeight * ratio);
    if (!w || !h) return false;
    if (capture.width !== w || capture.height !== h) {
      clear();
      capture.width = overlay.width = w;
      capture.height = overlay.height = h;
    }
    pixels.drawImage(video, 0, 0, w, h);
    const rgba = pixels.getImageData(0, 0, w, h).data.buffer;
    // Both layers use object-fit: cover. Pick an arrow visible in that crop.
    const scale = Math.max(overlay.clientWidth / w, overlay.clientHeight / h);
    if (!scale) return false;
    const marginX = Math.max(0, (w - overlay.clientWidth / scale) / 2);
    const marginY = Math.max(0, (h - overlay.clientHeight / scale) / 2);
    frameBounds = [marginX, marginY, w - marginX, h - marginY];
    frameAt = now;
    frameAngle = screenAngle() ?? 0;
    frameMediaTime = mediaTime;
    busy = true;
    frameSelection = hooks.selection();
    worker.postMessage({ type: 'frame', w, h, rgba, bounds: frameBounds, frameTimeMs: now,
      floorAnchor: tracking.floorAnchor(now), recordingSpaceId: hooks.recordingSpace(), ...frameSelection }, [rgba]);
    return true;
  }

  async function start() {
    if (lifetime.signal.aborted || document.hidden || opening || stream) return;
    const token = ++generation;
    opening = true;
    hooks.state('카메라 연결 중');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('카메라를 사용할 수 없습니다. 지원 브라우저에서 localhost 또는 HTTPS 주소로 접속하세요.');
      }
      const camera = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (token !== generation) { camera.getTracks().forEach((track) => track.stop()); return; }
      stream = camera;
      const track = camera.getVideoTracks()[0];
      if (track.getSettings().facingMode === 'user') throw new Error('후면 카메라가 필요합니다.');
      track.addEventListener('ended', () => {
        if (token === generation) { stop(); hooks.error('카메라 연결이 끊겼습니다. 다시 연결해 주세요.'); }
      }, { once: true });
      video.srcObject = camera;
      await video.play();
      if (token !== generation) return;
      worker = new Worker(base + 'ar/tracker.js?v=4');
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if (token !== generation) return;
        if (data.type === 'ready') {
          ready = true;
          window.addEventListener('devicemotion', onMotion);
          motionTimer = window.setInterval(publishMinimap, 100);
          hooks.ready();
          stopFrames = watchCameraFrames(video, sample);
        }
        else if (data.type === 'frame') {
          busy = false;
          if (frameSelection !== hooks.selection()) { expire(); return; }
          const recording = data.recording;
          if (recording && recording.spaceId === hooks.recordingSpace())
            hooks.frame(capture, frameAt, frameMediaTime, recording.intrinsics, recording.fix);
          paint(data);
        }
        else { console.error('역사 AR:', data.message); stop(); hooks.error('태그 인식기를 다시 연결해 주세요.'); }
      };
      worker.onerror = (error) => {
        if (token === generation) { console.error('역사 AR:', error.message); stop(); hooks.error('태그 인식기를 다시 연결해 주세요.'); }
      };
      worker.postMessage({ type: 'init', library: new URL(opencvUrl, location.href).href, spaces });
    } catch (error) {
      if (token === generation) {
        console.warn('역사 AR:', error); stop();
        hooks.error(!window.isSecureContext ? '카메라를 사용하려면 HTTPS 또는 localhost에서 열어 주세요.' :
          error instanceof DOMException && error.name === 'NotAllowedError' ? '브라우저에서 카메라를 허용한 뒤 다시 연결해 주세요.' : '후면 카메라를 확인한 뒤 다시 연결해 주세요.');
      }
    } finally {
      if (token === generation) opening = false;
    }
  }

  const opts = { signal: lifetime.signal };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else void start(); }, opts);
  window.addEventListener('pagehide', stop, opts);
  window.addEventListener('pageshow', () => void start(), opts);
  // StrictMode can unmount and remount before a camera permission prompt resolves.
  queueMicrotask(() => void start());
  return () => { lifetime.abort(); stop(); };
}
