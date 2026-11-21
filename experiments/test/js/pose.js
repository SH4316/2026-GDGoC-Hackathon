// QR 마커를 보고 카메라의 위치와 방향을 구한다. 순수 함수.
//
// 로봇이 기준 마커(fiducial)로 자기 위치를 잡는 것과 같은 원리다.
//  - 지도에는 각 QR의 위치·방향·크기가 적혀 있다.
//  - 카메라 영상에서 QR의 네 모서리 픽셀 좌표를 얻는다.
//  - 폰의 기울기(중력 방향)는 관성 센서가 정확히 알려 준다.
// 그러면 모르는 값은 "센서 좌표계가 지도에 대해 얼마나 돌아가 있는지"(delta, 1개)와
// 카메라 위치(3개)뿐이다. delta를 정하면 위치는 선형 최소제곱으로 바로 풀리므로,
// delta 후보를 훑으며 재투영 오차가 가장 작은 값을 찾는다.

import { rad, deg, normDeg, angDiff } from './geo.js';
import { qRotate, qConj } from './orient-math.js';

const SIGMA_PX = 1.0; // 모서리 검출 오차의 최소 가정값 (픽셀)
const GRID = 180; // 방향 후보 격자: 2도 간격
const BEHIND = (Math.PI / 2) ** 2; // 점이 카메라 뒤로 가는 해에 주는 벌점 (rad²)

/** QR에 적힌 문자열에서 마커 ID를 꺼낸다. 예: "https://.../?m=A3" → "A3" */
export function parseMarkerId(raw) {
  if (!raw) return null;
  let m = /[?&#]m=([A-Za-z0-9_-]+)/.exec(raw);
  if (m) return m[1];
  m = /^IRIRO:([A-Za-z0-9_-]+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

/**
 * QR 문자열 전체를 해석한다. ID 외에 설치 정보를 함께 담을 수 있다.
 *   &h=92   QR 중심의 높이 (cm)     &s=100   QR 한 변의 길이 (mm)
 * 화면에 띄운 QR처럼 지도 파일을 고치지 않고 바로 시험할 때 쓴다. 값이 있으면 지도의 값보다 우선한다.
 * 반환: { id, h(m) | null, size(m) | null }
 */
export function parseMarkerPayload(raw) {
  const id = parseMarkerId(raw);
  if (!id) return { id: null, h: null, size: null };
  const num = (key) => {
    const m = new RegExp(`[?&#]${key}=(\\d+(?:\\.\\d+)?)(?:&|$)`).exec(raw);
    return m ? parseFloat(m[1]) : null;
  };
  const hCm = num('h');
  const sMm = num('s');
  return {
    id,
    h: hCm != null && hCm <= 250 ? hCm / 100 : null,
    size: sMm != null && sMm >= 30 && sMm <= 1000 ? sMm / 1000 : null,
  };
}

/**
 * 마커의 중심과 축 (세계 좌표).
 *  - 벽 마커: facing은 마커가 바라보는 방위각(벽에서 통로 쪽으로 나오는 방향)
 *  - 바닥 마커: facing은 인쇄된 QR의 "위쪽"이 향하는 방위각
 * r은 마커를 정면에서 볼 때의 오른쪽, u는 위쪽, n은 앞면 법선.
 */
export function markerBasis(m) {
  const phi = rad(m.facing || 0);
  if (m.mount === 'floor') {
    return {
      c: [m.x, m.h || 0, -m.y],
      r: [Math.cos(phi), 0, Math.sin(phi)],
      u: [Math.sin(phi), 0, -Math.cos(phi)],
      n: [0, 1, 0],
    };
  }
  return {
    c: [m.x, m.h == null ? 1.5 : m.h, -m.y],
    r: [-Math.cos(phi), 0, -Math.sin(phi)],
    u: [0, 1, 0],
    n: [Math.sin(phi), 0, -Math.cos(phi)],
  };
}

/** 마커 네 모서리의 세계 좌표: 왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래 */
export function markerCorners(m) {
  const { c, r, u } = markerBasis(m);
  const h = m.size / 2;
  const pt = (sr, su) => [
    c[0] + sr * h * r[0] + su * h * u[0],
    c[1] + sr * h * r[1] + su * h * u[1],
    c[2] + sr * h * r[2] + su * h * u[2],
  ];
  return [pt(-1, 1), pt(1, 1), pt(1, -1), pt(-1, -1)];
}

/**
 * 영상 크기와 긴 변 화각으로 카메라 내부 파라미터를 근사한다.
 * 브라우저는 실제 초점거리를 알려 주지 않아서, 폰 메인 카메라의 전형적인 화각을 가정한다.
 */
export function intrinsicsFor(w, h, longFovDeg) {
  return {
    f: Math.max(w, h) / 2 / Math.tan(rad(longFovDeg) / 2),
    cx: w / 2,
    cy: h / 2,
    w,
    h,
  };
}

/** 픽셀 → 카메라 좌표계의 방향(단위 벡터) */
export function pixelRay(u, v, intr) {
  const x = (u - intr.cx) / intr.f;
  const y = -(v - intr.cy) / intr.f;
  const n = Math.hypot(x, y, 1);
  return [x / n, y / n, -1 / n];
}

/** 세계의 점 P를 카메라(위치 C, 자세 q)의 픽셀로 투영 */
export function projectPoint(P, C, q, intr) {
  const pc = qRotate(qConj(q), [P[0] - C[0], P[1] - C[1], P[2] - C[2]]);
  if (pc[2] >= -1e-6) return { u: NaN, v: NaN, front: false };
  return {
    u: intr.cx + (intr.f * pc[0]) / -pc[2],
    v: intr.cy - (intr.f * pc[1]) / -pc[2],
    front: true,
  };
}

/**
 * 벽 마커의 모서리를 중력 기준으로 "왼쪽 위, 오른쪽 위, 오른쪽 아래, 왼쪽 아래"로 정렬한다.
 * 인식 라이브러리가 모서리를 어떤 순서로 주든 상관없게 하기 위해서다.
 */
export function orderWallCorners(pts, qImu, intr) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const info = pts
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
    .map((p) => {
      const r = qRotate(qImu, pixelRay(p.x, p.y, intr));
      return {
        p,
        elev: Math.atan2(r[1], Math.hypot(r[0], r[2])),
        az: deg(Math.atan2(r[0], -r[2])),
      };
    });
  // 위쪽 변: 이웃한 두 모서리 중 올려다보는 각도의 합이 가장 큰 쌍
  let k = 0;
  let best = -Infinity;
  for (let i = 0; i < 4; i++) {
    const sum = info[i].elev + info[(i + 1) % 4].elev;
    if (sum > best) {
      best = sum;
      k = i;
    }
  }
  const a = info[k];
  const b = info[(k + 1) % 4];
  const order =
    angDiff(a.az, b.az) < 0
      ? [a, b, info[(k + 2) % 4], info[(k + 3) % 4]]
      : [b, a, info[(k + 3) % 4], info[(k + 2) % 4]];
  return order.map((o) => o.p);
}

/**
 * 인식 결과를 "세계의 점 P ↔ 그 점을 향한 광선 r" 관측 목록으로 만든다.
 * r은 관성 센서 좌표계(중력은 맞고 좌우 방향은 임의) 기준이다.
 * dets: [{ id, corners: [{x, y} x4] }]  (모서리는 QR 심볼 기준 왼쪽 위부터 시계 방향)
 */
export function buildObservations(dets, markerById, qImu, intr) {
  const obs = [];
  for (const d of dets) {
    const m = markerById.get(d.id);
    if (!m || !d.corners || d.corners.length !== 4) continue;
    const world = markerCorners(m);
    // 바닥 마커는 인쇄 방향이 곧 방위 정보라서 심볼 기준 순서를 그대로 쓴다
    const px = m.mount === 'floor' ? d.corners : orderWallCorners(d.corners, qImu, intr);
    for (let i = 0; i < 4; i++) {
      obs.push({ P: world[i], r: qRotate(qImu, pixelRay(px[i].x, px[i].y, intr)), id: d.id });
    }
  }
  return obs;
}

/**
 * 센서 좌표계가 지도에 대해 deltaDeg만큼 돌아가 있다고 할 때의 카메라 위치.
 * 각 광선(점 P를 지나고 방향이 d인 직선)에 가장 가까운 점을 선형 최소제곱으로 구한다.
 * cost는 모서리별 각도 오차 제곱의 합 (rad²).
 */
export function solveCenter(obs, deltaDeg) {
  const c = Math.cos(rad(deltaDeg));
  const s = Math.sin(rad(deltaDeg));
  const n = obs.length;
  const dirs = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = obs[i].r;
    dirs[i] = [r[0] * c + r[2] * s, r[1], -r[0] * s + r[2] * c];
  }

  let C = null;
  let w = null;
  // 두 번 푼다: 두 번째는 거리로 가중해 "직선까지 거리"가 아니라 "각도 오차"를 줄이게 한다
  for (let pass = 0; pass < 2; pass++) {
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const d = dirs[i];
      const P = obs[i].P;
      const wi = w ? w[i] : 1;
      const dp = d[0] * P[0] + d[1] * P[1] + d[2] * P[2];
      a00 += wi * (1 - d[0] * d[0]);
      a01 -= wi * d[0] * d[1];
      a02 -= wi * d[0] * d[2];
      a11 += wi * (1 - d[1] * d[1]);
      a12 -= wi * d[1] * d[2];
      a22 += wi * (1 - d[2] * d[2]);
      b0 += wi * (P[0] - d[0] * dp);
      b1 += wi * (P[1] - d[1] * dp);
      b2 += wi * (P[2] - d[2] * dp);
    }
    const c00 = a11 * a22 - a12 * a12;
    const c01 = a02 * a12 - a01 * a22;
    const c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (!(Math.abs(det) > 1e-14)) return { C: null, cost: n * BEHIND };
    const c11 = a00 * a22 - a02 * a02;
    const c12 = a01 * a02 - a00 * a12;
    const c22 = a00 * a11 - a01 * a01;
    C = [
      (c00 * b0 + c01 * b1 + c02 * b2) / det,
      (c01 * b0 + c11 * b1 + c12 * b2) / det,
      (c02 * b0 + c12 * b1 + c22 * b2) / det,
    ];
    if (pass === 0) {
      w = new Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const P = obs[i].P;
        const d2 = (P[0] - C[0]) ** 2 + (P[1] - C[1]) ** 2 + (P[2] - C[2]) ** 2;
        w[i] = 1 / Math.max(1e-6, d2);
        sum += w[i];
      }
      for (let i = 0; i < n; i++) w[i] *= n / sum; // 평균 1로 맞춰 수치 안정성 유지
    }
  }

  let cost = 0;
  for (let i = 0; i < n; i++) {
    const d = dirs[i];
    const P = obs[i].P;
    const vx = P[0] - C[0];
    const vy = P[1] - C[1];
    const vz = P[2] - C[2];
    const dist2 = vx * vx + vy * vy + vz * vz;
    const along = vx * d[0] + vy * d[1] + vz * d[2];
    if (along <= 0 || dist2 < 1e-9) {
      cost += BEHIND;
      continue;
    }
    cost += Math.max(0, dist2 - along * along) / dist2; // sin² ≈ 각도²
  }
  return { C, cost };
}

/**
 * 최근 몇 프레임의 관측을 모아 delta를 추정한다.
 *
 * delta는 프레임마다 달라지는 값이 아니라 (센서가 천천히 흐르는 것 말고는) 일정한 값이다.
 * 그래서 프레임마다 따로 풀어 평균하지 않고, 프레임별 오차 곡선을 더한 뒤 한 번에 고른다.
 * 이렇게 하면 벽에 붙은 작은 QR을 정면에서 볼 때처럼 한 장으로는 좌우 방향이
 * 애매한 경우에도 여러 장의 정보가 합쳐져 안정된다.
 */
export class YawWindow {
  constructor(maxFrames = 20, maxAgeMs = 2500) {
    this.maxFrames = maxFrames;
    this.maxAgeMs = maxAgeMs;
    this.frames = [];
  }

  clear() {
    this.frames.length = 0;
  }

  add(obs, t) {
    const curve = new Float64Array(GRID);
    for (let k = 0; k < GRID; k++) curve[k] = solveCenter(obs, (k * 360) / GRID).cost;
    this.frames.push({ obs, t, curve });
    while (
      this.frames.length > this.maxFrames ||
      (this.frames.length > 1 && t - this.frames[0].t > this.maxAgeMs)
    ) {
      this.frames.shift();
    }
  }

  /**
   * prior: 이전에 알고 있던 값 { delta, sigma(도) } 또는 null
   * f: 초점거리(px)
   * 반환: { delta, sigma(도), rmsPx, frames }
   */
  estimate(prior, f) {
    let est = this._estimate(prior, f);
    if (!est || this.frames.length < 3) return est;
    // 다른 프레임들과 어긋나는 프레임(흔들려 찍힌 장면 등)을 빼고 한 번 더 추정한다
    const res = this.frames.map((fr) => f * Math.sqrt(solveCenter(fr.obs, est.delta).cost / fr.obs.length));
    const sorted = res.slice().sort((a, b) => a - b);
    const limit = Math.max(2.5, 3 * sorted[sorted.length >> 1]);
    const kept = this.frames.filter((_, i) => res[i] <= limit);
    if (kept.length < this.frames.length && kept.length >= 1) {
      this.frames = kept;
      est = this._estimate(prior, f);
    }
    return est;
  }

  _estimate(prior, f) {
    const frames = this.frames;
    if (!frames.length) return null;
    let nObs = 0;
    for (const fr of frames) nObs += fr.obs.length;

    const measure = (d) => {
      let sum = 0;
      for (const fr of frames) sum += solveCenter(fr.obs, d).cost;
      return sum;
    };
    const priorChi = (d) => (prior ? (angDiff(d, prior.delta) / prior.sigma) ** 2 : 0);

    // 1) 2도 격자에서 측정 오차가 가장 작은 곳으로 잡음 크기를 가늠한다
    let jMin = Infinity;
    for (let k = 0; k < GRID; k++) {
      let sum = 0;
      for (const fr of frames) sum += fr.curve[k];
      if (sum < jMin) jMin = sum;
    }
    const dof = Math.max(1, 2 * nObs - 3 * frames.length - 1);
    const sigmaPx = Math.min(6, Math.max(SIGMA_PX, f * Math.sqrt(jMin / dof)));
    const inv = (f / sigmaPx) ** 2;

    // 2) 이전 값까지 반영해 가장 그럴듯한 격자점을 고른다
    let kBest = 0;
    let vBest = Infinity;
    for (let k = 0; k < GRID; k++) {
      let sum = 0;
      for (const fr of frames) sum += fr.curve[k];
      const v = sum * inv + priorChi((k * 360) / GRID);
      if (v < vBest) {
        vBest = v;
        kBest = k;
      }
    }
    const center = (kBest * 360) / GRID;

    // 3) 그 주변 ±45도를 0.5도 간격으로 정밀하게 본다
    const STEP = 0.5;
    const HALF = 90;
    const vals = new Float64Array(2 * HALF + 1);
    let iMin = 0;
    for (let i = 0; i <= 2 * HALF; i++) {
      const d = center + (i - HALF) * STEP;
      vals[i] = measure(d) * inv + priorChi(d);
      if (vals[i] < vals[iMin]) iMin = i;
    }

    // 4) 확률 가중 평균. 좌우가 애매하면 자연스럽게 가운데 값이 되고 sigma가 커진다.
    let sw = 0;
    let sx = 0;
    let sxx = 0;
    for (let i = 0; i <= 2 * HALF; i++) {
      const wgt = Math.exp(-(vals[i] - vals[iMin]) / 2);
      const x = (i - HALF) * STEP;
      sw += wgt;
      sx += wgt * x;
      sxx += wgt * x * x;
    }
    let mean = sx / sw;
    let std = Math.sqrt(Math.max(0, sxx / sw - mean * mean));

    // 5) 봉우리가 격자 간격보다 좁으면(바닥 마커 등) 포물선 보간으로 더 정밀하게
    if (std < 1 && iMin > 0 && iMin < 2 * HALF) {
      const a = vals[iMin - 1];
      const b = vals[iMin];
      const c = vals[iMin + 1];
      const den = a - 2 * b + c;
      if (den > 1e-9) {
        const off = Math.max(-1, Math.min(1, (0.5 * (a - c)) / den));
        mean = (iMin - HALF + off) * STEP;
        std = Math.sqrt(2 / den) * STEP;
      }
    }

    const delta = normDeg(center + mean);
    return {
      delta,
      sigma: Math.max(0.3, std),
      rmsPx: f * Math.sqrt(measure(delta) / nObs),
      frames: frames.length,
    };
  }
}
