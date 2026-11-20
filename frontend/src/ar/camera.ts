import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';

import type { Fix, Intrinsics } from './recording';

type Hooks = {
  ready: (station: unknown) => void;
  state: (state: string) => void;
  frame: (canvas: HTMLCanvasElement, at: number, mediaTimeS: number, intrinsics: Intrinsics, fix: Fix | null) => void;
  pause: () => void;
};
type Reply = { type: 'ready' } | { type: 'error'; message: string } | { type: 'frame'; fix: Fix | null; intrinsics?: Intrinsics };

const STALE_MS = 350;

export function openPassage(video: HTMLVideoElement, overlay: HTMLCanvasElement, hooks: Hooks) {
  const lifetime = new AbortController();
  const capture = document.createElement('canvas');
  const pixels = capture.getContext('2d', { willReadFrequently: true })!;
  const drawing = overlay.getContext('2d')!;
  const base = import.meta.env.BASE_URL;
  let worker: Worker | undefined;
  let stream: MediaStream | undefined;
  let generation = 0;
  let opening = false;
  let ready = false;
  let busy = false;
  let callback: number | undefined;
  let clearTimer: number | undefined;
  let lastVideoTime = -1;
  let frameAt = 0;
  let fixed = false;
  const frameCallback = typeof video.requestVideoFrameCallback === 'function';

  function clear() {
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    if (fixed) window.dispatchEvent(new CustomEvent('station-pose', { detail: null }));
    fixed = false;
  }

  function stop() {
    hooks.pause();
    generation++;
    opening = false;
    ready = false;
    busy = false;
    clearTimeout(clearTimer);
    if (callback !== undefined) {
      if (frameCallback) video.cancelVideoFrameCallback(callback);
      else cancelAnimationFrame(callback);
    }
    callback = undefined;
    worker?.terminate();
    worker = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.srcObject = null;
    lastVideoTime = -1;
    clear();
  }

  function paint(fix: Fix | null) {
    clearTimeout(clearTimer);
    const age = performance.now() - frameAt;
    if (!fix || age >= STALE_MS) { clear(); return; }
    drawing.clearRect(0, 0, overlay.width, overlay.height);
    const poly = fix.arrow;
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
    fixed = true;
    window.dispatchEvent(new CustomEvent('station-pose', { detail: {
      positionM: fix.position, tagIds: fix.ids, reprojectionPx: fix.rmsPx, frameTimeMs: frameAt,
    } }));
    clearTimer = window.setTimeout(clear, STALE_MS - age);
  }

  function sample(now: number, mediaTime: number) {
    if (!worker || !ready || busy || video.readyState < 2 || mediaTime === lastVideoTime) return;
    const ratio = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * ratio);
    const h = Math.round(video.videoHeight * ratio);
    if (!w || !h) return;
    if (capture.width !== w || capture.height !== h) {
      clear();
      capture.width = overlay.width = w;
      capture.height = overlay.height = h;
    }
    pixels.drawImage(video, 0, 0, w, h);
    const rgba = pixels.getImageData(0, 0, w, h).data.buffer;
    // Both layers use object-fit: cover. Pick an arrow visible in that crop.
    const scale = Math.max(overlay.clientWidth / w, overlay.clientHeight / h);
    if (!scale) return;
    const marginX = Math.max(0, (w - overlay.clientWidth / scale) / 2);
    const marginY = Math.max(0, (h - overlay.clientHeight / scale) / 2);
    const bounds = [marginX, marginY, w - marginX, h - marginY];
    frameAt = now;
    lastVideoTime = mediaTime;
    busy = true;
    worker.postMessage({ type: 'frame', w, h, rgba, bounds }, [rgba]);
  }

  function schedule() {
    if (!stream || !ready) return;
    if (frameCallback) {
      callback = video.requestVideoFrameCallback((now, meta) => {
        sample(meta.presentationTime ?? now, meta.mediaTime);
        schedule();
      });
    } else {
      callback = requestAnimationFrame((now) => { sample(now, video.currentTime); schedule(); });
    }
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
      track.addEventListener('ended', () => { if (token === generation) stop(); }, { once: true });
      video.srcObject = camera;
      await video.play();
      if (token !== generation) return;
      const response = await fetch(base + 'station.json', { cache: 'no-store', signal: lifetime.signal });
      if (!response.ok) throw new Error('station.json ' + response.status);
      const station = await response.json();
      if (token !== generation) return;
      worker = new Worker(base + 'ar/tracker.js');
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if (token !== generation) return;
        if (data.type === 'ready') { ready = true; hooks.ready(station); schedule(); }
        else if (data.type === 'frame') {
          busy = false;
          if (data.intrinsics) hooks.frame(capture, frameAt, lastVideoTime, data.intrinsics, data.fix);
          paint(data.fix);
        }
        else { console.error('역사 AR:', data.message); stop(); hooks.state('새로고침해 다시 연결하세요'); }
      };
      worker.onerror = (error) => {
        if (token === generation) { console.error('역사 AR:', error.message); stop(); hooks.state('새로고침해 다시 연결하세요'); }
      };
      worker.postMessage({ type: 'init', library: new URL(opencvUrl, location.href).href, station });
    } catch (error) {
      if (token === generation) {
        console.warn('역사 AR:', error); stop();
        hooks.state(!window.isSecureContext ? '카메라는 HTTPS 또는 localhost에서 열어 주세요' :
          error instanceof DOMException && error.name === 'NotAllowedError' ? '카메라를 허용하고 화면을 누르세요' : '후면 카메라를 확인하고 화면을 누르세요');
      }
    } finally {
      if (token === generation) opening = false;
    }
  }

  const opts = { signal: lifetime.signal };
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else void start(); }, opts);
  window.addEventListener('pagehide', stop, opts);
  window.addEventListener('pageshow', () => void start(), opts);
  window.addEventListener('pointerdown', () => void start(), opts);
  // StrictMode can unmount and remount before a camera permission prompt resolves.
  queueMicrotask(() => void start());
  return () => { lifetime.abort(); stop(); };
}
