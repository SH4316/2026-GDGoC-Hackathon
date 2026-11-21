// 카메라 움직임 추적기(SLAM)를 "눈으로 보는 주행 거리계"로 쓴다. 순수 계산이라 브라우저와 테스트에서 같이 쓴다.
//
// 추적기는 카메라 영상 속의 특징점을 따라가며 폰이 실제로 얼마나, 어느 쪽으로 움직였는지를 알려 준다.
// 걸음 수로 어림하는 것보다 훨씬 정확하지만 그대로 쓸 수는 없다.
//   - 추적기가 쓰는 좌표계는 지도와 무관하다 (좌우 방향이 임의이고, 길이 단위도 미터가 아닐 수 있다).
//   - 특징이 없는 벽을 가까이서 보거나 빠르게 돌면 잠깐 놓치고, 다시 잡으면서 좌표계를 새로 잡기도 한다.
// 그래서 추적기에서는 "이동량"만 가져다 쓴다.
//   - 폰의 자세(기울기와 좌우 방향)는 지금까지처럼 기울기 센서 값을 쓴다.
//   - 추적기 좌표계와 센서 좌표계는 둘 다 중력에 맞춰져 있어서 좌우 방향만 다르다. 그 차이를 계속 재서
//     추적기가 알려 준 이동량을 센서 좌표계로 돌린다. 추적기가 좌표계를 새로 잡아도 그 차이를 다시 재므로 괜찮다.
//   - 추적 상태가 정상일 때의 이동만 쓴다. 놓친 동안은 앱이 걸음 수로 이어 간다.
//
// 실제 폰(8th Wall 엔진)의 기록에서 확인한 것 (2026-11-20):
//   - 추적기의 자세는 센서와 1~2도 안에서 맞는다 (같은 좌표 규칙, 중력에 맞춰져 있음).
//   - 추적기가 말하는 높이(y)는 걷는 동안 계속 흘러서(수십 m에 1~2 단위) 길이 단위를 맞추는 데 쓸 수 없다.
//   - 프레임 간격이 들쭉날쭉해서, 프레임 사이의 시간으로 속도를 재면 정상적인 이동도 너무 빠르게 보일 수 있다.

import { angDiff, deg, rad } from './geo.js';
import { qAxis, qConj, qMul, qRotate, yawQuat } from './orient-math.js';

const YAW_JUMP = 12; // 좌우 방향 차이가 한 번에 이만큼 넘게 바뀌면 추적기가 좌표계를 새로 잡은 것으로 본다 (도)
const JUMP_FRAMES = 4; // 그 상태가 이만큼 이어지면 받아들인다
const MAX_MOVE = 0.5; // 한 프레임에 이보다 많이 움직였다면 좌표계를 새로 잡은 것이다 (추적기 단위)
const MAX_SPEED = 6; // 사람이 걷는 속도로는 나올 수 없는 빠르기 (추적기 단위/초). 이런 값은 버린다
const MIN_FRAME_S = 0.033; // 속도를 잴 때 프레임 간격을 이보다 짧게 보지 않는다 (간격이 들쭉날쭉하므로)
const SLOW_TURN = 12; // 폰이 이보다 천천히 돌 때만 두 좌표계의 차이를 다시 잰다 (도/초)

export class VisualOdometer {
  constructor() {
    this.status = 'off'; // 'off' | 'loading' | 'limited' | 'normal' | 'error'
    this.detail = ''; // 화면에 보여 줄 부가 설명 (오류 내용 등)
    this.frames = 0;
    this.resets = 0; // 추적기가 좌표계를 새로 잡았거나 값이 튄 횟수
    this.glitches = 0; // 걷는 속도로는 나올 수 없는 이동이라 버린 횟수
    this.traveled = 0; // 좌표계를 마지막으로 새로 잡은 뒤 이동한 거리 (추적기 단위)
    this.yaw = null; // 추적기 좌표계가 센서 좌표계에 대해 세로축 둘레로 돌아가 있는 각도 (도)
    this.rel = null; // 센서 세계 → 추적기 세계 회전 (부드럽게 따라간 값). 좌우 방향 차이와 작은 기울기 차이를 담는다
    this.y = null; // 추적기 좌표계에서의 카메라 높이 (추적기 단위)
    this.lastT = -Infinity;
    /** (vx, vz, vy, t): 센서 좌표계 기준 이동. 축은 three.js와 같고(x 오른쪽, z 뒤, y 위) 단위는 추적기 단위 */
    this.onMove = null;
    this.reason = ''; // 추적기가 알려 준 상태 설명
    this.tilt = null; // 추적기와 센서가 말하는 기울기의 차이 (도). 정상이면 몇 도 이내다
    this._bad = 0; // 기울기가 서로 맞지 않은 프레임이 이어진 횟수
    this._prev = null;
    this._jump = 0;
  }

  get normal() {
    return this.status === 'normal';
  }

  /**
   * 이동량을 믿고 쓸 수 있는가. 추적 상태가 정상이어도, 추적기의 자세가 센서와 맞지 않으면(좌표 규칙이
   * 예상과 다르거나 추적기가 틀어졌을 때) 이동 방향을 지도로 옮길 수 없으므로 쓰지 않는다.
   */
  get usable() {
    return this.status === 'normal' && this.yaw != null && this._bad < 8;
  }

  /**
   * 추적기가 말한 자세 q(카메라 → 추적기 세계)를 센서 좌표계 기준의 자세로 바꾼다. 아직 맞추지 못했으면 null.
   * 추적 엔진은 영상과 자세를 같은 순간의 것으로 짝지어 주므로, 엔진이 그린 화면으로 QR의 위치를 계산할 때는
   * "지금의 센서 값"보다 이 값이 그 화면과 더 정확히 맞는다 (센서 값은 화면보다 0.1초쯤 앞서 있다).
   * 기울기는 센서가 더 정확한데, 두 좌표계의 차이(rel)를 천천히 따라가며 재므로 그 정확도도 유지된다.
   */
  syncedImu(q) {
    if (!this.rel || this._bad >= 8) return null;
    return qMul(qConj(this.rel), q);
  }

  /**
   * 추적기의 한 프레임을 넣는다.
   *  q: 카메라 → 추적기 세계 회전 [x, y, z, w], p: 카메라 위치 [x, y, z] (y가 위)
   *  normal: 추적 상태가 정상인지, qImu: 같은 순간의 센서 자세, turnRate: 폰이 도는 속도(도/초), t: 시각(ms)
   */
  feed({ q, p, normal, qImu, turnRate = 0, t }) {
    this.frames++;
    this.lastT = t;
    this.y = p[1];

    // 두 좌표계의 차이. 둘 다 중력에 맞춰져 있으므로 거의 세로축 둘레의 회전만 남는다.
    let rel = qMul(q, qConj(qImu)); // 센서 세계 → 추적기 세계
    const upright = Math.min(1, Math.hypot(rel[1], rel[3]));
    this.tilt = deg(2 * Math.acos(upright));
    const aligned = this.tilt < 25; // 두 좌표계가 정말로 세로축 둘레로만 다른가
    this._bad = aligned ? 0 : this._bad + 1;
    if (aligned) {
      const a = angDiff(deg(2 * Math.atan2(rel[1], rel[3])), 0);
      if (this.yaw == null) {
        this.yaw = a;
        this.rel = rel;
      } else {
        const d = angDiff(a, this.yaw);
        if (Math.abs(d) > YAW_JUMP) {
          if (++this._jump >= JUMP_FRAMES) {
            this.yaw = a;
            this.rel = rel;
            this._jump = 0;
            this._prev = null;
            this.resets++;
            this.traveled = 0;
          }
        } else {
          this._jump = 0;
          // 도는 중에는 영상과 센서의 시각 차이만큼 값이 틀어지므로, 천천히 움직일 때만 조금씩 따라간다
          if (turnRate < SLOW_TURN) {
            const r0 = this.rel;
            if (r0[0] * rel[0] + r0[1] * rel[1] + r0[2] * rel[2] + r0[3] * rel[3] < 0) rel = rel.map((v) => -v);
            const m = r0.map((v, i) => v + (rel[i] - v) * 0.1);
            const n = Math.hypot(m[0], m[1], m[2], m[3]);
            this.rel = m.map((v) => v / n);
            this.yaw = angDiff(deg(2 * Math.atan2(this.rel[1], this.rel[3])), 0);
          }
        }
      }
    }

    const prev = this._prev;
    this._prev = { p: [p[0], p[1], p[2]], normal, t };
    this.status = normal ? 'normal' : 'limited';
    if (!normal || !prev || !prev.normal || this.yaw == null || this._jump > 0 || !aligned) return;

    const dx = p[0] - prev.p[0];
    const dy = p[1] - prev.p[1];
    const dz = p[2] - prev.p[2];
    const dist = Math.hypot(dx, dz);
    if (dist > MAX_MOVE) {
      // 추적기가 좌표계를 새로 잡았다 (높이는 평소에도 흐르므로 기준으로 삼지 않는다)
      this.resets++;
      this.traveled = 0;
      return;
    }
    if (dist < 1e-7) return;
    if (dist / Math.max(MIN_FRAME_S, (t - prev.t) / 1000) > MAX_SPEED) {
      this.glitches++;
      return;
    }
    this.traveled += dist;
    // 추적기 세계 → 센서 세계
    const v = qRotate(qAxis(0, 1, 0, -rad(this.yaw)), [dx, 0, dz]);
    if (this.onMove) this.onMove(v[0], v[2], dy, t);
  }
}

/**
 * 가상 역에서 추적기를 흉내 낸다 (검증용).
 * 실제 위치를 추적기처럼 "임의의 방향, 임의의 원점, 미터가 아닌 단위"로 바꿔 알려 주고,
 * 정해 둔 시간 동안은 추적을 놓친 척하다가 좌표계를 새로 잡는다.
 */
export class SimTracker {
  /**
   * sim: SimWorld. yaw: 지도에 대해 돌아가 있는 각도, scale: 추적기 단위 하나가 몇 m인지,
   * drops: 추적을 놓치는 구간들 [[시작, 끝], ...] (가상 역 시계, 초), noise: 위치 잡음 (추적기 단위),
   * heightFactor: 추적기가 말하는 높이가 실제의 몇 배인지 (실제 엔진은 높이를 제멋대로 잡기도 한다),
   * heightDrift: 1 단위 이동할 때마다 높이 값이 얼마나 흘러가는지 (실제 엔진에서 본 현상)
   */
  constructor(sim, { yaw = 211, scale = 0.7, drops = [], noise = 0.003, heightFactor = 1, heightDrift = -0.04 } = {}) {
    this.sim = sim;
    this.yaw = yaw;
    this.scale = scale;
    this.drops = drops;
    this.noise = noise;
    this.heightFactor = heightFactor;
    this.heightDrift = heightDrift;
    this._origin = null;
    this._frozen = null;
    this._wasDropped = false;
    this._seed = 12345;
  }

  _rand() {
    this._seed = (this._seed * 1664525 + 1013904223) >>> 0;
    return this._seed / 4294967296 - 0.5;
  }

  /** 지금 순간의 추적기 출력 { q, p, normal } */
  read() {
    const sim = this.sim;
    const dropped = this.drops.some(([a, b]) => sim.clock >= a && sim.clock < b);
    if (this._wasDropped && !dropped) {
      // 놓쳤다 다시 잡으면서 좌표계를 새로 잡는다: 방향, 원점, 단위가 모두 달라진다
      this.yaw = (this.yaw + 97) % 360;
      this.scale *= 1.06;
      this._origin = null;
    }
    this._wasDropped = dropped;
    const truth = [sim.pose.x, 0, -sim.pose.y];
    if (!this._origin) this._origin = truth;
    const turn = yawQuat(-this.yaw); // 지도 세계 → 추적기 세계
    const q = qMul(turn, sim.qTrue());
    let p = this._frozen;
    if (!dropped || !p) {
      const d = qRotate(turn, [truth[0] - this._origin[0], 0, truth[2] - this._origin[2]]);
      const far = Math.hypot(d[0], d[2]) / this.scale;
      p = [
        d[0] / this.scale + this._rand() * this.noise,
        Math.max(0.2, (sim.height / this.scale) * this.heightFactor + far * this.heightDrift),
        d[2] / this.scale + this._rand() * this.noise,
      ];
      this._frozen = p;
    }
    return { q, p, normal: !dropped };
  }
}
