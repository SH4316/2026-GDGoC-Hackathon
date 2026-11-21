import { copy, type Language } from '../i18n/language';
import { stationLabel } from '../i18n/stationLabel';
import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';

import { IndoorTracking, type CameraPose, type MinimapPose } from './indoorTracking';
import { indoorCue, type IndoorCue, type Maneuver } from './indoorGuidance';
import { nearArrivalTag, routeTree, tagNetwork } from './tagRouting';
import { readMotion, screenAngle } from './motion';
import { watchCameraFrames } from './videoFrames';
import { compareCameraViews, createCameraViewSampler, type CameraView } from './cameraView';
import type { Fix, Intrinsics } from './recording';
import { stationName, type Point, type SpaceLayout } from './station';
import type { TagModels } from './models';
import type { DebugSession } from './debugSession';

type SpaceSelection = { preferredSpace: string };
export type TagReference = { spaceId: string; id: number };
export type GuideDirection = NonNullable<Maneuver['direction']> | 'forward';
type Bearing = { direction: GuideDirection; angleDeg?: number };
type FloorTiltLimit = { up: [number, number, number]; minDot: number };
type Hooks = {
  language: () => Language;
  ready: () => void;
  allowGuidance: (space: SpaceLayout) => boolean;
  located: (space: SpaceLayout) => void;
  arrived: (space: SpaceLayout) => void;
  cue: (cue: IndoorCue | undefined) => void;
  direction: (direction: GuideDirection | undefined, angleDeg?: number) => void;
  destinationNearby: (spaceId?: string, screenDoorSpaceId?: string, selectedTag?: number) => void;
  minimap: (pose: MinimapPose | undefined) => void;
  tagSeen: (tag: TagReference) => void;
  chooseSpace: (ids: string[]) => void;
  destination: () => TagReference | undefined;
  route: (spaceId: string, points: Point[]) => void;
  selection: () => SpaceSelection | undefined;
  recordingSpace: () => string | undefined;
  debug: () => DebugSession | null;
  error: (message: string) => void;
  state: (state: string, indoorHint?: string) => void;
  modelNotice: (message: string, tagId?: number) => void;
  frame: (canvas: HTMLCanvasElement, at: number, mediaTimeS: number, intrinsics: Intrinsics, fix: Fix | null) => void;
  pause: () => void;
};
type Detection = { id: number; image: Point[]; registered: boolean };
type VisualGuidance = { maneuver?: Maneuver; guide?: Point[][]; arrow?: Point[] | null; screenDirection?: GuideDirection;
  screenAngleDeg?: number; routeBearing?: Bearing; floorVisible?: boolean; floorTiltLimit?: FloorTiltLimit };
type Frame = { type: 'frame'; routeRevision?: number; route?: Point[]; spaceId?: string; referenceTag?: TagReference; candidates?: string[]; fix: (Fix & VisualGuidance & { destinationDistance: number }) | null;
  recording?: { spaceId: string; intrinsics: Intrinsics; fix: Fix | null };
  floorMotion?: CameraPose & VisualGuidance & { spaceId: string; referenceTimeMs: number }; pendingFloorSpace?: string;
  motionGuide?: VisualGuidance & { spaceId: string };
  walking?: { spaceId: string; maneuver: Maneuver };
  corridorHeading?: { spaceId: string; yawDeg: number };
  intrinsics?: Intrinsics; detections: Detection[] };
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

function markTag(ctx: CanvasRenderingContext2D, tag: Detection, [left, top, right, bottom]: number[], language: Language) {
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
  const label = 'ID ' + tag.id + (tag.registered ? '' : ' · ' + copy[language]('미등록'));
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

function drawGuide(ctx: CanvasRenderingContext2D, polygons: Point[][]) {
  ctx.beginPath();
  for (const [first, ...rest] of polygons) {
    ctx.moveTo(...first);
    for (const point of rest) ctx.lineTo(...point);
    ctx.closePath();
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, ctx.canvas.width / 180);
  ctx.strokeStyle = '#154d43';
  ctx.stroke();
  ctx.fillStyle = '#62e9cb';
  ctx.fill();
}

function drawArrow(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points.slice(1)) ctx.lineTo(...point);
  ctx.closePath();
  ctx.fillStyle = '#17c879';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, ctx.canvas.width / 310);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

export function openPassage(video: HTMLVideoElement, guideCanvas: HTMLCanvasElement, overlay: HTMLCanvasElement, modelCanvas: HTMLCanvasElement,
                            spaces: SpaceLayout[], hooks: Hooks) {
  const lifetime = new AbortController();
  const capture = document.createElement('canvas');
  const pixels = capture.getContext('2d', { willReadFrequently: true })!;
  const readView = createCameraViewSampler(video);
  const drawing = overlay.getContext('2d')!;
  const guideDrawing = guideCanvas.getContext('2d')!;
  const base = import.meta.env.BASE_URL;
  const corridorHeadingEnabled = new URLSearchParams(location.search).get('vp') !== '0';
  let worker: Worker | undefined;
  let models: TagModels | undefined;
  const layouts = new Map(spaces.map(space => [space.id, space]));
  let frameLayouts = spaces;
  let frameDestination: TagReference | undefined;
  let routeRevision: number | undefined;
  let activeRoute: Point[] = [];
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
  let frameView: CameraView;
  let presentedAt = 0;
  let frameAngle = 0;
  let frameSelection: SpaceSelection | undefined;
  let frameBounds = [0, 0, 0, 0];
  let fixed = false;
  let tracking = new IndoorTracking();
  let motionTimer: number | undefined;
  let shownPose: MinimapPose | undefined;
  let shownCue: IndoorCue | undefined;
  let arrivedSpace: string | undefined;
  let lastGuide: { spaceId: string; at: number; bearing?: Bearing; onFloor: boolean; displayAngle: number; tilt?: FloorTiltLimit;
    view: CameraView; verifiedAt: number } | undefined;
  let shownBearing: Bearing | undefined;
  let preferredSpace = hooks.selection()?.preferredSpace;

  function workerLayouts() {
    return spaces.map(({ id, station, network }) => ({ id, station, tree: routeTree(network ?? tagNetwork(station)) }));
  }

  function updateLayouts(next: SpaceLayout[]) {
    spaces = next;
    layouts.clear();
    for (const space of next) layouts.set(space.id, space);
    clearTimeout(clearTimer);
    tracking = new IndoorTracking();
    clear();
    models?.dispose();
    models = undefined;
    modelSpace = undefined;
    modelRevision++;
    arrivedSpace = undefined;
    frameDestination = undefined;
    routeRevision = undefined;
    activeRoute = [];
    worker?.postMessage({ type: 'layouts', spaces: workerLayouts() });
  }

  function publishCue(cue?: IndoorCue) {
    if (cue?.key === shownCue?.key && cue?.language === shownCue?.language) return;
    shownCue = cue;
    hooks.cue(cue);
  }

  function publishMinimap() {
    const selectedId = hooks.selection()?.preferredSpace;
    if (selectedId !== preferredSpace) {
      preferredSpace = selectedId;
      if (selectedId && lastGuide && selectedId !== lastGuide.spaceId) clearGuide();
      if (selectedId && tracking.spaceId && selectedId !== tracking.spaceId) tracking = new IndoorTracking();
    }
    if (lastGuide && frameDestination !== hooks.destination()) clearGuide();
    const pose = tracking.pose(performance.now(), fixed);
    if (pose === shownPose || (pose && shownPose && pose.spaceId === shownPose.spaceId && pose.source === shownPose.source &&
        pose.headingDeg === shownPose.headingDeg && pose.point[0] === shownPose.point[0] && pose.point[1] === shownPose.point[1])) return;
    shownPose = pose;
    hooks.minimap(pose);
  }

  function onMotion(event: DeviceMotionEvent) {
    const sample = readMotion(event);
    const estimate = tracking.motion(sample);
    if (lastGuide?.onFloor && tiltAllowsFloor(lastGuide.tilt, sample.timeMs, lastGuide.displayAngle) === false) showLastDirection();
    hooks.debug()?.motion(sample, fixed ? undefined : estimate);
  }

  function clearTags() {
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    publishCue();
    models?.clear();
    if (fixed) window.dispatchEvent(new CustomEvent('station-pose', { detail: null }));
    fixed = false;
    publishMinimap();
  }

  function showBearing(bearing?: Bearing) {
    const angleDeg = bearing?.angleDeg === undefined ? undefined : Math.round(bearing.angleDeg);
    if (shownBearing?.direction === bearing?.direction && shownBearing?.angleDeg === angleDeg) return;
    shownBearing = bearing && { direction: bearing.direction, angleDeg };
    hooks.direction(bearing?.direction, angleDeg);
  }

  function clearFloor() {
    if (lastGuide?.onFloor) {
      guideDrawing.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
      lastGuide.onFloor = false;
    }
  }

  function clearGuide() {
    clearFloor();
    showBearing();
    lastGuide = undefined;
  }

  function showLastDirection() {
    clearFloor();
    showBearing(lastGuide?.bearing);
  }

  function tiltAllowsFloor(limit: FloorTiltLimit | undefined, now: number, displayAngle: number) {
    const currentAngle = screenAngle() ?? 0;
    if (displayAngle !== currentAngle) return false;
    if (!limit) return;
    const up = tracking.viewUp(now, currentAngle);
    if (up) return up[0]*limit.up[0] + up[1]*limit.up[1] + up[2]*limit.up[2] >= limit.minDot;
  }

  function canPlaceOnVideo(appearance: ReturnType<typeof compareCameraViews>, tilt: boolean | undefined) {
    return appearance !== 'changed' && tilt !== false && (appearance === 'matching' || tilt === true);
  }

  function paintGuide(spaceId: string, visual: VisualGuidance, fresh: boolean, appearance: ReturnType<typeof compareCameraViews>) {
    // Screen coordinates belong to one camera view. Only the direction can outlive it.
    const direction = visual.maneuver?.kind === 'realign' ? visual.maneuver.direction : visual.screenDirection;
    const bearing = direction ? { direction, angleDeg: visual.screenAngleDeg } : visual.routeBearing ?? lastGuide?.bearing;
    const floorVisible = fresh && visual.floorVisible !== false &&
      canPlaceOnVideo(appearance, tiltAllowsFloor(visual.floorTiltLimit, performance.now(), frameAngle));
    const guide = floorVisible && visual.guide?.length ? visual.guide : undefined;
    const arrow = floorVisible && !direction && visual.arrow?.length ? visual.arrow : undefined;
    clearFloor();
    if (guide) drawGuide(guideDrawing, guide);
    if (arrow) drawArrow(guideDrawing, arrow);
    showBearing(arrow ? undefined : bearing);
    lastGuide = { spaceId, at: frameAt, bearing, onFloor: !!(guide || arrow), displayAngle: frameAngle, tilt: visual.floorTiltLimit,
      view: frameView, verifiedAt: presentedAt };
  }

  function clear() {
    clearTags();
    clearGuide();
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
    arrivedSpace = undefined;
    frameDestination = undefined;
    routeRevision = undefined;
    activeRoute = [];
    modelRevision++;
  }

  function searching() {
    const hint = lastGuide?.bearing ? '마지막으로 확인한 방향입니다. 태그를 다시 비추면 갱신됩니다.' : undefined;
    hooks.state('태그 탐색 중', hint);
  }

  function expire() {
    clearTags();
    showLastDirection();
    searching();
  }

  function expireLiveObservations() {
    const remaining = lastGuide?.onFloor ? lastGuide.verifiedAt + STALE_MS - performance.now() : 0;
    if (remaining <= 0) { expire(); return; }
    // New matching video presentations can keep a projection in place while the next tag result is pending.
    clearTags();
    searching();
    clearTimer = window.setTimeout(expireLiveObservations, remaining);
  }

  function paint({ spaceId, route, routeRevision: revision, referenceTag, candidates, fix, floorMotion, motionGuide, pendingFloorSpace, walking, corridorHeading, detections, intrinsics }: Frame) {
    clearTimeout(clearTimer);
    const gyroGuide = motionGuide && motionGuide.spaceId === tracking.spaceId && !candidates &&
      (!referenceTag || referenceTag.spaceId === motionGuide.spaceId) ? motionGuide : undefined;
    const observedSpaceId = referenceTag?.spaceId ?? (fix && spaceId) ?? floorMotion?.spaceId ?? gyroGuide?.spaceId ?? walking?.spaceId ?? corridorHeading?.spaceId ?? pendingFloorSpace;
    if (lastGuide && (candidates || (observedSpaceId && observedSpaceId !== lastGuide.spaceId) ||
        fix?.arrived || (route && revision !== routeRevision))) clearGuide();
    const age = performance.now() - frameAt;
    // The live video can advance just before this reply, even before its next presentation callback.
    const appearance = age < STALE_MS && video.readyState >= 2 && video.videoWidth && video.videoHeight
      ? compareCameraViews(frameView, readView()) : 'changed';
    const stale = appearance === 'changed';
    if (stale && !fix && !floorMotion && !gyroGuide) { expire(); return; }
    if (referenceTag) {
      if (tracking.spaceId && referenceTag.spaceId !== tracking.spaceId) tracking = new IndoorTracking();
      if (!stale) hooks.tagSeen(referenceTag);
    }
    const observedSpace = observedSpaceId && layouts.get(observedSpaceId);
    if (observedSpace && !hooks.allowGuidance(observedSpace)) {
      if (tracking.spaceId) tracking = new IndoorTracking();
      routeRevision = undefined;
      activeRoute = [];
      arrivedSpace = undefined;
      clear();
      hooks.destinationNearby(undefined);
      if (stale) { expire(); return; }
      for (const tag of detections) markTag(drawing, tag, frameBounds, hooks.language());
      const links = observedSpace.station.stationLinks;
      const name = links?.[0]?.name;
      const place = name && links?.every(link => link.name === name) ? stationLabel(stationName(name), hooks.language()) + ' ' : '';
      hooks.state('태그 인식', copy[hooks.language()]('{place}태그를 확인했습니다. 2D 경로를 따라가세요.', { place }));
      clearTimer = window.setTimeout(expire, STALE_MS - age);
      return;
    }
    if (spaceId && fix && route) {
      activeRoute = route;
      routeRevision = revision;
      hooks.route(spaceId, route);
    }
    const floorCorrection = floorMotion && tracking.correct(floorMotion.spaceId, floorMotion, frameAt, frameAngle, 'floor', undefined,
      corridorHeading?.spaceId === floorMotion.spaceId ? corridorHeading.yawDeg : 0);
    if (floorCorrection) {
      hooks.debug()?.visual(frameAt, 'floor', floorMotion.spaceId, floorMotion.position);
    }
    // Both fused and camera-only matches supply a measured projection for the overlay.
    const matchedFloor = floorCorrection !== undefined ? floorMotion : undefined;
    const visual = fix ?? matchedFloor;
    const projection = visual ?? gyroGuide;
    const guideSpace = fix ? spaceId : matchedFloor?.spaceId ?? gyroGuide?.spaceId;
    const awaitingFloor = !projection && lastGuide && pendingFloorSpace === lastGuide.spaceId && frameAt - lastGuide.at <= 130;
    const space = spaceId ? layouts.get(spaceId) : undefined;
    if (fix && space && tracking.correct(space.id, fix, frameAt, frameAngle, 'tag', activeRoute,
      corridorHeading?.spaceId === space.id ? corridorHeading.yawDeg : 0)) {
      hooks.debug()?.visual(frameAt, 'tag', space.id, fix.position);
    }
    if (projection) {
      if (guideSpace && activeRoute.length >= 2 && !fix?.arrived && guideSpace !== arrivedSpace && projection.maneuver?.kind !== 'confirm')
        paintGuide(guideSpace, projection, !!visual && !stale, appearance);
      else clearGuide();
    } else showLastDirection();
    // A slow device can still show its most recent measured direction. Live cues require a fresh image.
    if (stale) { expire(); return; }
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    for (const tag of detections) markTag(drawing, tag, frameBounds, hooks.language());
    const spaceChanged = space !== modelSpace;
    if (fix && space && spaceChanged) {
      arrivedSpace = undefined;
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
    if (corridorHeading && !fix && !floorMotion) tracking.correctHeading(corridorHeading.spaceId, corridorHeading.yawDeg, frameAt);
    publishMinimap();
    if (fix && space) {
      const nearby = fix.destinationDistance <= MAP_RETURN_RADIUS_M;
      const target = frameDestination?.spaceId === space.id ? frameDestination.id : undefined;
      const atTag = activeRoute.length > 0 && nearArrivalTag(space.station, fix.position, target);
      hooks.destinationNearby(nearby ? space.id : undefined, atTag ? space.id : undefined, target);
      if (fix.arrived && arrivedSpace !== space.id) {
        arrivedSpace = space.id;
        hooks.arrived(space);
      }
    }
    if (!awaitingFloor) {
      const guidanceSpaceId = guideSpace ?? walking?.spaceId;
      const layout = guidanceSpaceId ? layouts.get(guidanceSpaceId) : undefined;
      const targetTag = frameDestination?.spaceId === layout?.id ? frameDestination?.id : undefined;
      let cue = layout && indoorCue(layout, visual?.maneuver ?? walking?.maneuver, !!fix?.arrived, targetTag, hooks.language());
      if (fix && layout && !activeRoute.length) {
        const mapped = layout.station.tagGraph || layout.network?.edges.length || layout.station.route.length ||
          (layout.station.autoRoute && layout.station.tags.length >= 2);
        const text = mapped ? '현재 태그에서 목적지까지 연결된 통로가 없습니다.' : '이 공간에 등록된 실내 경로가 없습니다.';
        cue = { language: hooks.language(), key: layout.id + '/unreachable', text: copy[hooks.language()](text) };
      }
      if (cue && !fix?.arrived) cue.key += '/' + routeRevision;
      publishCue(cue);
    }
    if (fix && space) {
      const t = copy[hooks.language()];
      const side = fix.screenDirection && { forward: '앞쪽', left: '왼쪽', right: '오른쪽', behind: '뒤쪽' }[fix.screenDirection];
      const hint = side && !fix.maneuver ? t('등록된 통로가 {side}에 있습니다.', { side: t(side) }) : '다음 태그와 진행 방향의 바닥을 함께 비추세요.';
      hooks.state('위치 인식', shownCue?.text ?? hint);
    } else if (gyroGuide && !matchedFloor) {
      hooks.state('방향 추정 중', shownCue?.text ?? '회전 센서로 방향을 추정하고 있습니다. 태그를 다시 비추면 보정됩니다.');
    } else if (matchedFloor || awaitingFloor || walking) {
      hooks.state('위치 추정 중', shownCue?.text ?? '다음 태그를 비추면 위치가 보정됩니다.');
    } else if (referenceTag) {
      hooks.state('태그 감지', '내 위치를 확인하려면 태그 전체가 화면에 크게 보이도록 비추세요.');
    } else if (candidates?.length) {
      hooks.chooseSpace(candidates);
      hooks.state('공간 선택', '같은 태그가 여러 공간에 등록되어 있습니다.');
    } else if (candidates) {
      hooks.state('공간 확인 필요', '한 공간의 태그만 비추세요.');
    } else if (!detections.length) searching();
    else hooks.state('태그 감지', detections.some(tag => tag.registered)
      ? '위치를 확인하려면 태그를 조금 더 가까이 비추세요.' : copy[hooks.language()]('미등록 태그 ID {id} · 이 공간에 등록된 태그를 비추세요.', { id: detections[0].id }));
    const lastFrame = awaitingFloor && lastGuide ? lastGuide.at : frameAt;
    clearTimer = window.setTimeout(expireLiveObservations, Math.max(0, STALE_MS - (performance.now() - lastFrame)));
  }

  function sample(now: number, mediaTime: number, newPresentation: boolean) {
    if (!worker || !ready || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
    if (newPresentation) presentedAt = now;
    if (busy && !(newPresentation && lastGuide?.onFloor)) return false;
    const view = readView();
    if (lastGuide?.onFloor && newPresentation) {
      const appearance = compareCameraViews(lastGuide.view, view);
      if (canPlaceOnVideo(appearance, tiltAllowsFloor(lastGuide.tilt, now, lastGuide.displayAngle))) lastGuide.verifiedAt = now;
      else if (appearance === 'changed') expire();
      else showLastDirection();
    }
    if (busy) return false;
    const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * ratio);
    const h = Math.round(video.videoHeight * ratio);
    if (!w || !h) return false;
    if (capture.width !== w || capture.height !== h) {
      clear();
      capture.width = overlay.width = guideCanvas.width = w;
      capture.height = overlay.height = guideCanvas.height = h;
    }
    pixels.drawImage(video, 0, 0, w, h);
    const rgba = pixels.getImageData(0, 0, w, h).data.buffer;
    // Guided mode fits the whole sensor frame; the map preview and recording camera fill their viewport.
    const scale = Math.max(overlay.clientWidth / w, overlay.clientHeight / h);
    if (!overlay.clientWidth || !overlay.clientHeight) return false;
    const cropped = getComputedStyle(overlay).objectFit === 'cover';
    const marginX = cropped ? Math.max(0, (w - overlay.clientWidth / scale) / 2) : 0;
    const marginY = cropped ? Math.max(0, (h - overlay.clientHeight / scale) / 2) : 0;
    frameBounds = [marginX, marginY, w - marginX, h - marginY];
    frameAt = now;
    frameView = view;
    frameAngle = screenAngle() ?? 0;
    frameMediaTime = mediaTime;
    busy = true;
    frameLayouts = spaces;
    frameSelection = hooks.selection();
    const destination = hooks.destination();
    if (destination !== frameDestination) {
      // Restore the old space's default if the user picked a target in another space.
      const changed = new Set([frameDestination?.spaceId, destination?.spaceId]);
      for (const spaceId of changed) {
        if (!spaceId) continue;
        const space = layouts.get(spaceId);
        if (!space) continue;
        const network = space.network ?? tagNetwork(space.station);
        const goal = destination?.spaceId === spaceId ? network.anchors[destination.id] ?? -1 : network.end;
        worker.postMessage({ type: 'destination', spaceId, tree: routeTree(network, goal) });
      }
      frameDestination = destination;
      hooks.destinationNearby();
      arrivedSpace = undefined;
      routeRevision = undefined;
      activeRoute = [];
      clear();
    }
    worker.postMessage({ type: 'frame', w, h, rgba, bounds: frameBounds, frameTimeMs: now,
      knownRoute: routeRevision, floorAnchor: tracking.floorAnchor(now), walking: tracking.walkingObservation(now),
      floorUp: tracking.floorUp(now, frameAngle),
      guideCamera: activeRoute.length >= 2 && tracking.spaceId !== arrivedSpace ? tracking.guideCamera(now, frameAngle) : undefined,
      corridorCamera: corridorHeadingEnabled ? tracking.corridorCamera(now, frameAngle) : undefined,
      recordingSpaceId: hooks.recordingSpace(), ...frameSelection }, [rgba]);
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
      worker = new Worker(base + 'ar/tracker.js?v=15');
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
          if (frameLayouts !== spaces) return;
          if (frameSelection?.preferredSpace !== hooks.selection()?.preferredSpace || frameDestination !== hooks.destination()) { expire(); return; }
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
      worker.postMessage({ type: 'init', library: new URL(opencvUrl, location.href).href, corridorHeadingEnabled,
        spaces: workerLayouts() });
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
  return { updateLayouts, close() { lifetime.abort(); stop(); } };
}
