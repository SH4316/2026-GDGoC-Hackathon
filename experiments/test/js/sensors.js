// 카메라와 기기 방향 센서.

import { deviceQuat, lookQuat } from './orient-math.js';

/** 후면 카메라 영상을 video 요소에 연결. 성공 여부를 반환 */
export async function startCamera(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    return true;
  } catch (e) {
    console.warn('camera unavailable', e);
    return false;
  }
}

export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/**
 * 방향 센서와 가속도 센서 사용 권한을 요청한다 (아이폰의 "동작 및 방향 접근").
 * 반드시 사용자의 터치 처리 안에서, 다른 비동기 작업보다 먼저 호출해야 권한 창이 뜬다.
 * 그래서 두 요청을 기다리지 않고 한꺼번에 시작한다.
 * 반환: { orientation, motion } 각각 'granted' | 'denied' | 'unsupported'
 */
export function requestMotionPermission() {
  const ask = (E) => {
    if (!E) return Promise.resolve('unsupported');
    if (typeof E.requestPermission !== 'function') return Promise.resolve('granted');
    try {
      return E.requestPermission().then(
        (r) => (r === 'granted' ? 'granted' : 'denied'),
        () => 'denied'
      );
    } catch (e) {
      return Promise.resolve('denied');
    }
  };
  return Promise.all([ask(window.DeviceOrientationEvent), ask(window.DeviceMotionEvent)]).then(
    ([orientation, motion]) => ({ orientation, motion })
  );
}

/**
 * 기기 방향 추적.
 *
 * 실내(특히 지하철역)는 철 구조물과 전류 때문에 나침반이 크게 틀린다. 그래서 나침반이
 * 섞이지 않은 상대 방향(deviceorientation)만 쓴다. 이 값은 기울기(중력 방향)는 정확하고
 * 좌우 방향은 "앱을 켠 순간" 기준이라, 지도상의 실제 방향은 QR을 보고 맞춘다.
 */
export class OrientationTracker {
  constructor() {
    this.q = lookQuat(0, 0); // 센서가 없으면 수평으로 정면을 보는 자세로 둔다
    this.hasData = false;
    this.lastT = 0;
    this._history = []; // 최근 자세 기록: 카메라 영상이 센서보다 조금 늦게 도착하는 것을 맞추는 데 쓴다
    this._listening = false;
  }

  /** 센서 값을 받기 시작한다 (권한은 requestMotionPermission으로 먼저 받는다) */
  start() {
    if (this._listening) return;
    this._listening = true;
    window.addEventListener('deviceorientation', (e) => this._handle(e));
  }

  /** 최근에 센서 값이 들어왔는지 */
  get available() {
    return this.hasData && performance.now() - this.lastT < 1500;
  }

  /** 시각 t(ms, performance.now 기준) 무렵의 자세 */
  at(t) {
    const h = this._history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= t) return h[i].q;
    }
    return h.length ? h[0].q : this.q;
  }

  /** 시각 t 직전 spanMs 동안 폰이 돈 속도 (도/초) */
  turnRate(t, spanMs = 80) {
    const a = this.at(t - spanMs);
    const b = this.at(t);
    const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
    return ((2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI / spanMs) * 1000;
  }

  _handle(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const screenAngle =
      (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    this.q = deviceQuat(e.alpha, e.beta, e.gamma, screenAngle);
    this.hasData = true;
    this.lastT = performance.now();
    this._history.push({ t: this.lastT, q: this.q });
    if (this._history.length > 90) this._history.shift();
  }
}
