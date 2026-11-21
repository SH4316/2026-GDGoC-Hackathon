// 위치 추정: QR이 보일 때는 QR로 정확히 맞추고, 안 보일 때는 걸음 수로 이어 간다.
// (로봇의 "랜드마크 보정 + 주행 거리계"와 같은 구조)
// 카메라 움직임 추적기(tracker.js)를 쓸 수 있으면 걸음 수 대신 그쪽의 이동량으로 이어 간다.

import { angDiff, normDeg, rad } from './geo.js';
import { qMul, yawQuat, headingOf } from './orient-math.js';
import { YawWindow, buildObservations, solveCenter } from './pose.js';

const SIGHTING_GAP_MS = 1500; // 이만큼 QR이 안 보이다 다시 보이면 새로 보기 시작한 것으로 친다
const MARKER_FRESH_MS = 500; // 이 시간 안에 QR을 봤으면 "QR로 위치 확인 중"으로 표시한다
const MAX_RMS_PX = 5; // 재투영 오차가 이보다 크면 잘못된 인식으로 보고 버린다
const DRIFT_DEG_PER_S = 0.15; // 자이로 방향이 흐르는 속도 가정
const PREDICT_MAX = 0.8; // 걸음 사이에 미리 나아가 보이는 정도 (보폭의 비율)

export class Localizer {
  constructor(map, { stride = 0.65 } = {}) {
    this.map = map;
    this.stride = stride;
    this.pos = null; // { x, y } 지도 좌표
    this.height = 1.4; // 카메라 높이 (m)
    this.delta = 0; // 센서 좌표계 → 지도 좌표계 회전 (도)
    this.deltaShown = 0; // 화면에 쓰는 값. delta를 부드럽게 따라간다
    this.sigma = 180; // delta의 불확실성 (도)
    this.hasFix = false;
    this.lastFixT = -Infinity;
    this.yawT = -Infinity; // 방향을 마지막으로 맞춘 시각 (QR 또는 영상의 복도 선)
    this.lastSeenT = -Infinity;
    this.walked = 0; // 마지막으로 QR을 본 뒤 QR 없이 이동한 거리 (m)
    this.steps = 0;
    this.odo = 'steps'; // QR이 안 보일 때 위치를 이어 가는 방법: 'steps'(걸음 수) | 'visual'(카메라 움직임 추적)
    this.seenIds = [];
    this.lastRms = null;
    // QR은 읽혔는데 위치를 잡지 못한 이유별 횟수와 마지막 이유 (현장에서 원인을 찾는 데 쓴다)
    this.rejects = { moving: 0, rms: 0, height: 0 };
    this.lastReject = '';
    this._lastStepT = -Infinity;
    this._stepPeriod = 0.55; // 최근 걸음 간격 (초)
    this._cadence = 0; // 끊기지 않고 이어 걸은 걸음 수
    this._window = new YawWindow();
    this._prior = null;
  }

  /**
   * QR 인식 결과 한 프레임을 반영한다.
   * dets: [{ id, corners }], qImu: 그 프레임을 찍을 때의 센서 자세, intr: 카메라 파라미터, t: ms
   * steady: 폰을 빠르게 돌리는 중이 아닌지. 빠르게 도는 중에는 영상과 센서의 시각이
   *         조금만 어긋나도 방향이 크게 틀리므로 그 프레임은 위치 계산에 쓰지 않는다.
   * 위치를 새로 잡았으면 결과를, 아니면 null을 돌려준다.
   */
  onFrame(dets, qImu, intr, t, steady = true) {
    const known = dets.filter((d) => this.map.markerById.has(d.id));
    this.seenIds = known.map((d) => d.id);
    if (!known.length) return null;
    if (!steady) {
      this.rejects.moving++;
      this.lastReject = 'moving';
      return null;
    }

    if (t - this.lastSeenT > SIGHTING_GAP_MS) {
      this._window.clear();
      // 직전까지 알던 방향을 사전 정보로 쓴다. 마지막으로 방향을 맞춘 뒤 시간이 지난 만큼 덜 믿는다.
      // (영상의 복도 선으로 맞춘 방향은 정확하므로, 벽 QR의 부정확한 방향 정보에 쉽게 끌려가지 않는다)
      this._prior = this.hasFix
        ? {
            delta: this.delta,
            sigma: Math.hypot(this.sigma, 0.5 + (DRIFT_DEG_PER_S * (t - this.yawT)) / 1000),
          }
        : null;
    }
    this.lastSeenT = t;

    const obs = buildObservations(known, this.map.markerById, qImu, intr);
    if (obs.length < 4) return null;
    this._window.add(obs, t);
    const est = this._window.estimate(this._prior, intr.f);
    if (!est || !(est.rmsPx <= MAX_RMS_PX)) {
      this._window.clear(); // 서로 맞지 않는 프레임이 섞였다. 버리고 다음 프레임부터 다시 모은다.
      this.rejects.rms++;
      this.lastReject = `rms ${est ? est.rmsPx.toFixed(1) : '-'}px`;
      return null;
    }
    const sol = solveCenter(obs, est.delta);
    if (!sol.C) return null;
    // 말이 안 되는 높이는 잘못된 해
    if (sol.C[1] < 0.2 || sol.C[1] > 2.6) {
      this.rejects.height++;
      this.lastReject = `height ${sol.C[1].toFixed(2)}m`;
      return null;
    }

    this.delta = est.delta;
    this.sigma = est.sigma;
    if (!this.hasFix) this.deltaShown = est.delta;
    this.pos = { x: sol.C[0], y: -sol.C[2] };
    this.height += (sol.C[1] - this.height) * (this.hasFix ? 0.3 : 1);
    this.hasFix = true;
    this.lastFixT = t;
    this.yawT = t;
    this.walked = 0;
    this.lastRms = est.rmsPx;
    return {
      pos: this.pos,
      height: sol.C[1],
      delta: this.delta,
      sigma: this.sigma,
      rmsPx: est.rmsPx,
      ids: this.seenIds,
    };
  }

  /** 걸음 하나를 반영한다. 폰이 향한 쪽으로 걷는다고 본다. */
  onStep(qImu, t) {
    this.steps++;
    const prevStepT = this._lastStepT;
    this._lastStepT = t;
    const gap = t - prevStepT;
    if (gap < 1) {
      // 걸음 감지기가 보류했던 첫 걸음과 함께 두 걸음을 한꺼번에 알려 준 경우
      this._cadence++;
    } else if (gap > 250 && gap < 1300) {
      this._stepPeriod += (gap / 1000 - this._stepPeriod) * 0.4;
      this._cadence++;
    } else {
      this._cadence = 0;
    }
    if (!this.hasFix || !this.pos) return false;
    if (this.odo === 'visual') return false; // 이동은 카메라 움직임 추적기가 알려 준다
    // 이 걸음 중 QR로 위치를 잡은 뒤에 걸은 부분만 더한다.
    // (QR을 보는 동안의 이동은 이미 QR 위치에 반영돼 있어서, 통째로 더하면 두 번 세게 된다)
    const stepStart = Math.max(prevStepT, t - 700);
    const frac = Math.max(0, Math.min(1, (t - this.lastFixT) / Math.max(1, t - stepStart)));
    const d = this.stride * frac;
    if (d < 0.02) return false;
    const h = rad(headingOf(this.qMap(qImu)));
    this.pos = {
      x: this.pos.x + d * Math.sin(h),
      y: this.pos.y + d * Math.cos(h),
    };
    this.walked += d;
    return true;
  }

  /**
   * 카메라 움직임 추적기가 알려 준 이동(지도 좌표, m)을 반영한다.
   * 이동한 거리(walked)는 여기서 세지 않는다: 프레임마다의 잔떨림까지 더해져 부풀기 때문에,
   * 부르는 쪽에서 실제로 나아간 만큼만 addWalked로 더한다. 카메라 높이는 QR로 잰 값을 그대로 둔다.
   */
  advance(dx, dy) {
    if (!this.hasFix || !this.pos) return false;
    this.pos = { x: this.pos.x + dx, y: this.pos.y + dy };
    return true;
  }

  addWalked(dist) {
    this.walked += dist;
  }

  /**
   * 마지막 걸음이 감지된 뒤 지금까지 걸은 것으로 보이는 거리 (다음 걸음의 몇 분의 몇쯤 왔는지).
   * 걷는 중이 아니면 0. QR 사이의 거리로 보폭을 맞출 때, 덜 센 반 걸음 때문에 보폭이 길게 잡히지 않게 한다.
   */
  partialStep(t) {
    if (this._cadence < 2 || this.odo === 'visual') return 0;
    const since = (t - Math.max(this._lastStepT, this.lastFixT)) / 1000;
    if (since < 0 || t - this._lastStepT > this._stepPeriod * 1250) return 0;
    return this.stride * Math.min(1, since / this._stepPeriod);
  }

  /**
   * 걸음과 걸음 사이의 위치.
   * 위치는 걸음이 감지될 때마다 한 보폭씩 뛰는데 사람은 그 사이에도 계속 움직인다. 그대로 그리면
   * 화살표가 평균 반 보폭쯤 늦게 따라와서 모퉁이가 실제보다 멀리 있는 것처럼 보인다.
   * 그래서 걷는 중에는 다음 걸음 쪽으로 미리 조금 나아간 위치를 돌려준다 (멈추면 원래 위치로 돌아온다).
   */
  predicted(qImu, t) {
    if (!this.pos || this._cadence < 2 || this.odo === 'visual') return this.pos;
    const since = (t - Math.max(this._lastStepT, this.lastFixT)) / 1000;
    if (since < 0 || t - this._lastStepT > this._stepPeriod * 1250) return this.pos;
    const d = this.stride * Math.min(PREDICT_MAX, since / this._stepPeriod);
    const h = rad(headingOf(this.qMap(qImu)));
    return { x: this.pos.x + d * Math.sin(h), y: this.pos.y + d * Math.cos(h) };
  }

  /**
   * 영상에서 본 복도 방향으로 방향 값을 고친다.
   * e: 지금 추정한 방향이 실제보다 e도만큼 시계 방향(오른쪽)으로 틀어져 있다
   */
  adjustYaw(e, t) {
    this.delta = normDeg(this.delta + e);
    this.sigma = Math.min(this.sigma, 1.5);
    this.yawT = t;
  }

  /** 매 프레임 호출: 화면용 방향 값을 부드럽게 따라가게 한다 */
  tick(dt) {
    const k = 1 - Math.exp(-dt / 0.2);
    this.deltaShown = normDeg(this.deltaShown + angDiff(this.delta, this.deltaShown) * k);
  }

  /** 센서 자세를 지도 기준 자세로 */
  qMap(qImu) {
    return qMul(yawQuat(this.deltaShown), qImu);
  }

  /** 'none': 아직 위치 모름, 'marker': QR을 보는 중, 'steps': 걸음으로 추정 중, 'visual': 카메라로 움직임 추적 중 */
  mode(t) {
    if (!this.hasFix) return 'none';
    if (t - this.lastSeenT < MARKER_FRESH_MS) return 'marker';
    return this.odo === 'visual' ? 'visual' : 'steps';
  }
}
