// 평면(미터 단위) 기하 유틸. DOM을 쓰지 않는 순수 함수라 브라우저와 테스트에서 같이 쓴다.
//
// 지도 좌표계: 도면 위에서 x는 오른쪽, y는 위쪽 (단위 m).
// 방위각: 도면의 위쪽(+y)이 0도, 시계 방향으로 증가 (오른쪽 +x가 90도).

export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

/** 각도를 [0, 360) 범위로 */
export const normDeg = (d) => ((d % 360) + 360) % 360;

/** a - b 를 (-180, 180] 범위로. 양수면 a가 b보다 시계 방향(오른쪽) */
export function angDiff(a, b) {
  let d = normDeg(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** a에서 b를 바라보는 방위각 */
export function bearingXY(a, b) {
  return normDeg(deg(Math.atan2(b.x - a.x, b.y - a.y)));
}

export function distXY(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 경로 폴리라인. 시작점부터 잰 거리 s(m)로 경로 위의 점을 다룬다.
 */
export class Path {
  constructor(points) {
    if (!points || points.length === 0) throw new Error('empty path');
    this.xy = [];
    this.cum = [];
    for (const p of points) {
      const last = this.xy[this.xy.length - 1];
      if (last) {
        const d = Math.hypot(p.x - last.x, p.y - last.y);
        if (d < 0.02) continue; // 겹친 점 제거
        this.cum.push(this.cum[this.cum.length - 1] + d);
      } else {
        this.cum.push(0);
      }
      this.xy.push({ x: p.x, y: p.y });
    }
    this.length = this.cum[this.cum.length - 1];
  }

  /** s가 속한 선분의 시작 인덱스 */
  _seg(s) {
    const n = this.xy.length;
    if (n < 2) return 0;
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** 시작점에서 s(m) 떨어진 경로 위의 점과 그 지점의 진행 방위각 */
  pointAt(s) {
    const n = this.xy.length;
    if (n < 2) return { x: this.xy[0].x, y: this.xy[0].y, bearing: 0, seg: 0 };
    s = Math.max(0, Math.min(this.length, s));
    const i = this._seg(s);
    const a = this.xy[i];
    const b = this.xy[i + 1];
    const len = this.cum[i + 1] - this.cum[i];
    const t = len > 0 ? (s - this.cum[i]) / len : 0;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      bearing: bearingXY(a, b),
      seg: i,
    };
  }

  /**
   * 점 p에서 가장 가까운 경로 위의 점. [sMin, sMax] 구간만 본다.
   * 반환: s(경로상 거리), dist(경로까지 수직 거리)
   */
  project(p, sMin = 0, sMax = this.length) {
    const n = this.xy.length;
    if (n < 2) {
      const a = this.xy[0];
      return { s: 0, dist: Math.hypot(p.x - a.x, p.y - a.y), x: a.x, y: a.y, seg: 0 };
    }
    sMin = Math.max(0, Math.min(this.length, sMin));
    sMax = Math.max(sMin, Math.min(this.length, sMax));
    const iStart = this._seg(sMin);
    const iEnd = this._seg(sMax);
    let best = null;
    for (let i = iStart; i <= iEnd; i++) {
      const a = this.xy[i];
      const b = this.xy[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const len = this.cum[i + 1] - this.cum[i];
      let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
      // 구간 경계를 넘지 않도록 t를 제한
      const tMin = Math.max(0, len > 0 ? (sMin - this.cum[i]) / len : 0);
      const tMax = Math.min(1, len > 0 ? (sMax - this.cum[i]) / len : 1);
      t = Math.max(tMin, Math.min(tMax, t));
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const dist = Math.hypot(p.x - x, p.y - y);
      if (!best || dist < best.dist) {
        best = { s: this.cum[i] + len * t, dist, x, y, seg: i };
      }
    }
    return best;
  }

  /**
   * s 지점에서 꺾이는 각도. 앞뒤로 span(m)만큼 떨어진 점을 이어 잰다.
   * 양수면 오른쪽, 음수면 왼쪽.
   */
  turnAngleAt(s, span = 1.5) {
    const before = this.pointAt(Math.max(0, s - span));
    const at = this.pointAt(s);
    const after = this.pointAt(Math.min(this.length, s + span));
    const dIn = Math.hypot(at.x - before.x, at.y - before.y);
    const dOut = Math.hypot(after.x - at.x, after.y - at.y);
    const bIn = dIn > 0.1 ? bearingXY(before, at) : this.pointAt(Math.max(0, s - 0.01)).bearing;
    const bOut = dOut > 0.1 ? bearingXY(at, after) : this.pointAt(Math.min(this.length, s + 0.01)).bearing;
    return angDiff(bOut, bIn);
  }
}

/** 실내 거리 표기용 반올림: 20m까지는 1m, 그 이상은 5m 단위 */
export function roundMeters(m) {
  if (m < 20) return Math.max(1, Math.round(m));
  return Math.round(m / 5) * 5;
}
