// 쿼터니언 계산과 기기 방향 센서 값 → 카메라 자세 변환. 순수 함수.
//
// 좌표계 (three.js와 같은 오른손 좌표계)
//   세계: X = 지도 x, Y = 위(높이), Z = -지도 y
//   카메라: 화면 오른쪽 = x, 화면 위 = y, 바라보는 방향 = -z
// 쿼터니언은 [x, y, z, w] 배열이고 "카메라 좌표 → 세계 좌표" 회전을 뜻한다.

import { rad, deg, normDeg } from './geo.js';

export function qMul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qConj(q) {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** 축(ax, ay, az) 둘레로 angle(라디안) 회전 */
export function qAxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

/** 벡터 v를 쿼터니언 q로 회전 */
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** 세계 Y축(위) 둘레 회전. 양수면 위에서 볼 때 반시계 = 방위각이 줄어든다. */
export function yawQuat(degrees) {
  return qAxis(0, 1, 0, rad(degrees));
}

/**
 * deviceorientation 이벤트의 alpha/beta/gamma(도)를 카메라 자세로 변환.
 * 실내에서는 나침반을 믿을 수 없으므로 alpha는 임의의 시작 방향 기준(상대값)으로 쓴다.
 * 즉 기울기(중력 방향)는 정확하고, 좌우 방향은 QR을 보고 따로 맞춘다.
 * screenAngle: 화면 회전 각도 (세로 0, 가로 90/270)
 */
export function deviceQuat(alpha, beta, gamma, screenAngle = 0) {
  // 기기 회전: Z(alpha) → X(beta) → Y(gamma). 세계 좌표계로 옮기면 Y, X, -Z 축이 된다.
  let q = qMul(qAxis(0, 1, 0, rad(alpha)), qAxis(1, 0, 0, rad(beta)));
  q = qMul(q, qAxis(0, 0, 1, -rad(gamma)));
  // 후면 카메라는 화면 뒤쪽을 본다 (기기 위쪽이 아니라)
  q = qMul(q, qAxis(1, 0, 0, -Math.PI / 2));
  // 화면 회전 보정
  q = qMul(q, qAxis(0, 0, 1, -rad(screenAngle)));
  return q;
}

/** 카메라가 바라보는 방위각. 바닥이나 천장을 볼 때는 화면 위쪽 방향을 쓴다. */
export function headingOf(q) {
  const f = qRotate(q, [0, 0, -1]);
  if (Math.hypot(f[0], f[2]) > 0.3) {
    return normDeg(deg(Math.atan2(f[0], -f[2])));
  }
  const u = qRotate(q, [0, 1, 0]);
  return f[1] < 0
    ? normDeg(deg(Math.atan2(u[0], -u[2])))
    : normDeg(deg(Math.atan2(-u[0], u[2])));
}

/** 카메라가 수평에서 위로 향한 각도 (아래를 보면 음수) */
export function pitchOf(q) {
  const f = qRotate(q, [0, 0, -1]);
  return deg(Math.asin(Math.max(-1, Math.min(1, f[1]))));
}

/** 방위각과 상하 각도로 만든 카메라 자세 (가상 걷기, 센서 없는 기기용) */
export function lookQuat(heading, pitch = 0) {
  return qMul(yawQuat(-heading), qAxis(1, 0, 0, rad(pitch)));
}
