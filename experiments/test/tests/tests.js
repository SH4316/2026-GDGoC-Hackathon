// 계산 로직 테스트. 브라우저에서 tests/index.html을 열면 실행된다.

import { Path, angDiff, normDeg } from '../js/geo.js';
import { qMul, qConj, qAxis, yawQuat, lookQuat, deviceQuat, headingOf, pitchOf, qRotate } from '../js/orient-math.js';
import { corridorHistogram, findPeak } from '../js/vanish.js';
import {
  parseMarkerId,
  parseMarkerPayload,
  markerCorners,
  intrinsicsFor,
  projectPoint,
  buildObservations,
  solveCenter,
  YawWindow,
} from '../js/pose.js';
import { StationMap } from '../js/mapdata.js';
import { normalizeGraph } from '../js/graphfix.js';
import { buildRoute, extractManeuvers } from '../js/route.js';
import { Guide } from '../js/guide.js';
import { matchDestination } from '../js/destinations.js';
import { StepDetector } from '../js/steps.js';
import { Localizer } from '../js/localizer.js';
import { parseScanFile, buildFloorplan } from '../js/scan-import.js';
import { VisualOdometer } from '../js/tracker.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: String(e && e.message ? e.message : e) });
  }
}
function near(actual, expected, tol, label = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${label} expected ${expected} ±${tol}, got ${actual}`);
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || 'assertion failed');
}

// 재현 가능한 난수
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

// ---------- 기하 ----------
test('angDiff wraps around', () => {
  near(angDiff(10, 350), 20, 1e-9);
  near(angDiff(350, 10), -20, 1e-9);
  near(angDiff(180, 0), 180, 1e-9);
});

test('Path: point, projection, turn angle', () => {
  // 북쪽으로 10m 간 뒤 동쪽으로 10m
  const p = new Path([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]);
  near(p.length, 20, 1e-9);
  const a = p.pointAt(5);
  near(a.x, 0, 1e-9);
  near(a.y, 5, 1e-9);
  near(a.bearing, 0, 1e-9);
  near(p.pointAt(15).bearing, 90, 1e-9);
  const pr = p.project({ x: 1, y: 4 });
  near(pr.s, 4, 1e-9);
  near(pr.dist, 1, 1e-9);
  near(p.turnAngleAt(10), 90, 1e-6, 'right turn');
});

// ---------- 자세 ----------
test('deviceQuat: upright phone looks along -Z, flat phone looks down', () => {
  const up = qRotate(deviceQuat(0, 90, 0), [0, 0, -1]);
  near(up[0], 0, 1e-9);
  near(up[1], 0, 1e-9);
  near(up[2], -1, 1e-9);
  const flat = qRotate(deviceQuat(0, 0, 0), [0, 0, -1]);
  near(flat[1], -1, 1e-9);
});

test('lookQuat heading and pitch round trip', () => {
  for (const [h, p] of [[0, 0], [90, -20], [215, 10], [359, -60]]) {
    const q = lookQuat(h, p);
    near(angDiff(headingOf(q), h), 0, 1e-6, 'heading');
    near(pitchOf(q), p, 1e-6, 'pitch');
  }
});

test('yawQuat decreases heading', () => {
  near(angDiff(headingOf(qMul(yawQuat(30), lookQuat(100, 0))), 70), 0, 1e-6);
});

// ---------- QR 위치 추정 ----------
test('parseMarkerId', () => {
  ok(parseMarkerId('https://example.com/?m=A3') === 'A3');
  ok(parseMarkerId('https://example.com/app/?map=x&m=F12') === 'F12');
  ok(parseMarkerId('IRIRO:B7') === 'B7');
  ok(parseMarkerId('hello') === null);
});

test('parseMarkerPayload: height and size carried in the QR', () => {
  const a = parseMarkerPayload('https://192.168.0.5:8443/?map=desk&m=T1&h=92&s=100');
  ok(a.id === 'T1');
  near(a.h, 0.92, 1e-9);
  near(a.size, 0.1, 1e-9);
  const b = parseMarkerPayload('https://example.com/?m=A3');
  ok(b.id === 'A3' && b.h === null && b.size === null, 'no extras');
  ok(parseMarkerPayload('https://example.com/?h=92&s=100').id === null, 'not a marker without m=');
  ok(parseMarkerPayload('https://example.com/?m=A3&s=5').size === null, 'implausible size is ignored');
});

test('wall marker corners: viewer-left is on the correct side', () => {
  // 북쪽을 바라보는 벽 마커를 북쪽에서 남쪽으로 보면 왼쪽은 동쪽(+x)
  const c = markerCorners({ mount: 'wall', x: 5, y: 2, h: 1.5, facing: 0, size: 0.2 });
  near(c[0][0], 5.1, 1e-9, 'TL x');
  near(c[0][1], 1.6, 1e-9, 'TL height');
  near(c[1][0], 4.9, 1e-9, 'TR x');
  near(c[2][1], 1.4, 1e-9, 'BR height');
});

test('floor marker corners follow the printed orientation', () => {
  // 위쪽이 북쪽을 향한 바닥 마커: 왼쪽 위는 (-x, +y)
  const c = markerCorners({ mount: 'floor', x: 0, y: 0, h: 0, facing: 0, size: 0.2 });
  near(c[0][0], -0.1, 1e-9);
  near(c[0][2], -0.1, 1e-9, 'TL is north (-Z)');
  near(c[1][0], 0.1, 1e-9);
  near(c[2][2], 0.1, 1e-9, 'BR is south (+Z)');
});

/** 가상의 카메라로 마커를 찍어 인식 결과를 만든다 */
function synthDetect(marker, cam, intr, noisePx, rand, shuffle = 0) {
  const qTrue = lookQuat(cam.heading, cam.pitch);
  const C = [cam.x, cam.h, -cam.y];
  const corners = markerCorners(marker).map((P) => {
    const p = projectPoint(P, C, qTrue, intr);
    return { x: p.u + noisePx * gauss(rand), y: p.v + noisePx * gauss(rand), front: p.front };
  });
  if (corners.some((c) => !c.front)) return null;
  // 인식기가 모서리를 다른 순서로 줄 수도 있다 (벽 마커는 영향이 없어야 한다)
  const rotated = corners.map((_, i) => corners[(i + shuffle) % 4]);
  return { id: marker.id, corners: rotated };
}

function runCase({ marker, cam, deltaTrue, noisePx, frames, seed, shuffle = 0, prior = null }) {
  const intr = intrinsicsFor(720, 1280, 65);
  const rand = rng(seed);
  const byId = new Map([[marker.id, marker]]);
  // 센서 좌표계는 지도에 대해 deltaTrue만큼 돌아가 있다: qMap = yaw(delta) * qImu
  const qImu = qMul(yawQuat(-deltaTrue), lookQuat(cam.heading, cam.pitch));
  const win = new YawWindow();
  let last = null;
  for (let i = 0; i < frames; i++) {
    const det = synthDetect(marker, cam, intr, noisePx, rand, shuffle);
    if (!det) throw new Error('marker not in view');
    last = buildObservations([det], byId, qImu, intr);
    win.add(last, i * 100);
  }
  const est = win.estimate(prior, intr.f);
  const sol = solveCenter(last, est.delta);
  return {
    yawErr: angDiff(est.delta, deltaTrue),
    posErr: Math.hypot(sol.C[0] - cam.x, -sol.C[2] - cam.y),
    hErr: sol.C[1] - cam.h,
    sigma: est.sigma,
    rmsPx: est.rmsPx,
  };
}

const WALL = { id: 'W', mount: 'wall', x: 10, y: 14, h: 1.5, facing: 180, size: 0.16 };
const FLOOR = { id: 'F', mount: 'floor', x: 10, y: 12, h: 0, facing: 90, size: 0.16 };

test('wall marker, no noise: exact pose', () => {
  // 벽에서 1.5m 떨어져 30도 비스듬히 본다
  const cam = { x: 10.75, y: 12.7, h: 1.35, heading: 330, pitch: 5 };
  const r = runCase({ marker: WALL, cam, deltaTrue: 123, noisePx: 0, frames: 1, seed: 1 });
  near(r.yawErr, 0, 0.3, 'yaw');
  near(r.posErr, 0, 0.01, 'pos');
  near(r.hErr, 0, 0.01, 'height');
});

test('wall marker: corner order from the detector does not matter', () => {
  const cam = { x: 10.75, y: 12.7, h: 1.35, heading: 330, pitch: 5 };
  for (let sh = 0; sh < 4; sh++) {
    const r = runCase({ marker: WALL, cam, deltaTrue: 40, noisePx: 0, frames: 1, seed: 2, shuffle: sh });
    near(r.yawErr, 0, 0.3, `shuffle ${sh} yaw`);
    near(r.posErr, 0, 0.01, `shuffle ${sh} pos`);
  }
});

test('floor marker, no noise: exact pose', () => {
  // 바닥 마커를 1.2m 앞에서 내려다본다
  const cam = { x: 9.1, y: 11.2, h: 1.3, heading: 48, pitch: -47 };
  const r = runCase({ marker: FLOOR, cam, deltaTrue: 287, noisePx: 0, frames: 1, seed: 3 });
  near(r.yawErr, 0, 0.2, 'yaw');
  near(r.posErr, 0, 0.01, 'pos');
  near(r.hErr, 0, 0.01, 'height');
});

test('floor marker with 1px noise: yaw within 2 deg, position within 8cm', () => {
  let worstYaw = 0;
  let worstPos = 0;
  for (let seed = 10; seed < 30; seed++) {
    const cam = { x: 9.1, y: 11.2, h: 1.3, heading: 48, pitch: -47 };
    const r = runCase({ marker: FLOOR, cam, deltaTrue: seed * 17, noisePx: 1, frames: 5, seed });
    worstYaw = Math.max(worstYaw, Math.abs(r.yawErr));
    worstPos = Math.max(worstPos, r.posErr);
  }
  ok(worstYaw < 2, `worst yaw error ${worstYaw.toFixed(2)} deg`);
  ok(worstPos < 0.08, `worst position error ${worstPos.toFixed(3)} m`);
});

test('wall marker with 1px noise, frontal view: yaw within 12 deg, position within 30cm', () => {
  let worstYaw = 0;
  let worstPos = 0;
  for (let seed = 40; seed < 60; seed++) {
    const cam = { x: 10.1, y: 12.5, h: 1.4, heading: 356, pitch: 3 };
    const r = runCase({ marker: WALL, cam, deltaTrue: seed * 11, noisePx: 1, frames: 8, seed });
    worstYaw = Math.max(worstYaw, Math.abs(r.yawErr));
    worstPos = Math.max(worstPos, r.posErr);
  }
  ok(worstYaw < 12, `worst yaw error ${worstYaw.toFixed(2)} deg`);
  ok(worstPos < 0.3, `worst position error ${worstPos.toFixed(3)} m`);
});

test('wall marker with a prior from the previous fix: yaw within 4 deg', () => {
  let worstYaw = 0;
  for (let seed = 70; seed < 90; seed++) {
    const deltaTrue = seed * 7;
    const cam = { x: 10.5, y: 12.4, h: 1.4, heading: 345, pitch: 3 };
    const prior = { delta: normDeg(deltaTrue + 2), sigma: 4 };
    const r = runCase({ marker: WALL, cam, deltaTrue, noisePx: 1, frames: 5, seed, prior });
    worstYaw = Math.max(worstYaw, Math.abs(r.yawErr));
  }
  ok(worstYaw < 4, `worst yaw error ${worstYaw.toFixed(2)} deg`);
});

// ---------- 지도, 경로, 안내 ----------
const station = new StationMap(await (await fetch('../maps/station.json')).json());
const byId = (id) => station.pois.find((p) => p.id === id);

test('route: shortest path along the corridors', () => {
  // 서쪽 끝 근처에서 화장실까지: 동쪽으로 가다 오른쪽(남쪽)으로 꺾는다
  const r = station.routeTo({ x: 6, y: 12.4 }, byId('toilet'));
  near(r.length, 11, 0.01, 'length');
  const route = buildRoute(r.points);
  ok(route.maneuvers.length === 1, `expected 1 turn, got ${route.maneuvers.length}`);
  ok(route.maneuvers[0].kind === 'right', route.maneuvers[0].kind);
  near(route.maneuvers[0].s, 4, 0.01, 'turn position');
});

test('route: straight line has no turns', () => {
  const route = buildRoute(station.routeTo({ x: 3, y: 12 }, byId('exit3')).points);
  ok(route.maneuvers.length === 0, 'no turns expected');
  near(route.path.length, 35, 0.01);
});

test('route: a small sideways jog is not announced as two turns', () => {
  const path = new Path([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 1, y: 10 }, { x: 1, y: 20 }]);
  ok(extractManeuvers(path, path.cum.slice(1, -1)).length === 0, 'jog should cancel out');
});

test('graph: a path line that only passes over a junction is joined to it', () => {
  // 실제 지도에서 나온 경우: n3-n6 선이 n2 위를 지나가지만 이어져 있지 않다
  const map = new StationMap({
    id: 't',
    nodes: { n1: [13, -20.75], n2: [12.75, 11.75], n3: [14.5, 11.75], n6: [-3.61, 11.6] },
    edges: [['n1', 'n2'], ['n2', 'n3'], ['n3', 'n6']],
    pois: [{ id: 'west', type: 'exit', node: 'n6' }],
  });
  ok(map.graphFixes.joined === 1, `joined ${map.graphFixes.joined}`);
  const r = map.routeTo({ x: 13, y: 0 }, map.pois[0]);
  const route = buildRoute(r.points);
  // 모퉁이에서 바로 왼쪽으로 꺾어야 한다 (벽 쪽 n3까지 갔다가 되돌아오면 안 된다)
  ok(route.maneuvers.length === 1, `expected 1 turn, got ${route.maneuvers.map((m) => m.kind).join(',')}`);
  ok(route.maneuvers[0].kind === 'left', route.maneuvers[0].kind);
  ok(!r.points.some((q) => q.x > 13.5), 'route must not visit the dead end at the wall');
  near(route.path.length, 11.75 + 16.36, 0.1, 'length');
});

test('graph: crossing lines get a junction, twin points are merged, clean graphs are untouched', () => {
  const cross = normalizeGraph(
    [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 5, y: -4 }, { id: 'd', x: 5, y: 6 }],
    [{ a: 'a', b: 'b' }, { a: 'c', b: 'd' }]
  );
  ok(cross.fixes.crossed === 1 && cross.nodes.length === 5, 'one new junction');
  ok(cross.edges.length === 4, `4 edges after the split, got ${cross.edges.length}`);
  const x = cross.nodes[4];
  near(x.x, 5, 0.01);
  near(x.y, 0, 0.01);

  // 0.1m 떨어져 두 번 찍힌 점: 하나로 합쳐지고, 없어진 점에 달린 목적지도 그대로 찾아간다
  const map = new StationMap({
    id: 't',
    nodes: { a: [0, 0], b: [10, 0], b2: [10.1, 0], c: [10, 8] },
    edges: [['a', 'b'], ['b2', 'c']],
    pois: [{ id: 'p', type: 'exit', node: 'b2' }, { id: 'q', type: 'exit', node: 'c' }],
  });
  ok(map.graphFixes.merged === 1, 'merged');
  near(map.routeTo({ x: 0, y: 0 }, map.pois[1]).length, 18, 0.01, 'route through the merged point');
  near(map.routeTo({ x: 0, y: 0 }, map.pois[0]).length, 10, 0.01, 'poi on the merged point');

  const f = station.graphFixes;
  ok(f.merged === 0 && f.crossed === 0 && f.joined === 0, 'sample map needs no fixes');
});

test('graph: a T junction drawn slightly short or slightly past the line still connects', () => {
  for (const endY of [0.25, -0.25]) {
    const g = normalizeGraph(
      [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 't', x: 4, y: endY }, { id: 'u', x: 4, y: 7 }],
      [{ a: 'a', b: 'b' }, { a: 't', b: 'u' }]
    );
    const has = (p, q) => g.edges.some((e) => (e.a === p && e.b === q) || (e.a === q && e.b === p));
    ok(has('a', 't') && has('t', 'b') && has('t', 'u'), `connected at end y=${endY}`);
  }
});

test('guide: stages, speech once per stage, arrival', () => {
  const route = buildRoute(station.routeTo({ x: 6, y: 12 }, byId('toilet')).points);
  const guide = new Guide(route);
  let g = guide.update({ x: 6, y: 12 });
  ok(g.ins.kind === 'right' && g.ins.stage === 'soon', `${g.ins.kind}/${g.ins.stage}`);
  ok(g.speak.length === 1, 'speaks when a stage starts');
  ok(guide.update({ x: 6.2, y: 12 }).speak.length === 0, 'does not repeat');
  g = guide.update({ x: 9, y: 12 });
  ok(g.ins.stage === 'now' && g.speak.length === 1, 'now stage');
  g = guide.update({ x: 10, y: 9 });
  ok(g.ins.kind === 'arrive', 'after the turn, next is arrival');
  ok(!g.arrived, 'not there yet');
  g = guide.update({ x: 10, y: 6.5 });
  ok(g.arrived, 'arrived within 2 m');
});

// ---------- 목적지 찾기 ----------
function match(text) {
  return matchDestination(text, station.pois).map((p) => p.id);
}

test('destination matching: Korean', () => {
  ok(match('화장실 어디예요').join() === 'toilet');
  ok(match('3번 출구로 가고 싶어요').join() === 'exit3');
  ok(match('삼번 출구').join() === 'exit3');
  ok(match('2호선 타는 곳').join() === 'line2');
  ok(match('강남 가려면').join() === 'line2');
  ok(match('표 사는 곳').join() === 'ticket', match('표 사는 곳').join());
  ok(match('엘리베이터').join() === 'elevator');
  ok(match('짐 맡기는 곳').join() === 'locker');
});

test('destination matching: English, Japanese, Chinese', () => {
  ok(match('Where is the restroom?').join() === 'toilet');
  ok(match('exit 2 please').join() === 'exit2');
  ok(match('exit two').join() === 'exit2');
  ok(match('I want to go to Gangnam').join() === 'line2');
  ok(match('where can I buy a ticket').join() === 'ticket');
  ok(match('トイレはどこですか').join() === 'toilet');
  ok(match('4番出口').join() === 'exit4');
  ok(match('洗手间在哪里').join() === 'toilet');
  ok(match('1号出口').join() === 'exit1');
  ok(match('电梯').join() === 'elevator');
});

test('destination matching: ambiguous and unknown', () => {
  ok(match('출구').length === 4, 'all exits are offered when no number is given');
  ok(match('pizza').length === 0, 'unknown request gives nothing');
  ok(match('restore my luggage').join() === 'locker', '"store" inside "restore" must not match');
});

// ---------- 걸음 감지 ----------
function feedWalk(det, seconds, hz, amp, t0 = 0) {
  for (let t = 0; t < seconds * 1000; t += 16) {
    det.feed(9.8 + amp * Math.sin((2 * Math.PI * hz * t) / 1000), t0 + t);
  }
}

test('step detector: counts steps of a steady walk', () => {
  let n = 0;
  const det = new StepDetector((k) => (n += k));
  feedWalk(det, 10, 1.8, 2.5); // 10초 동안 초당 1.8걸음
  ok(n >= 16 && n <= 19, `expected about 18 steps, got ${n}`);
});

test('step detector: ignores a single bump and standing still', () => {
  let n = 0;
  const det = new StepDetector((k) => (n += k));
  for (let t = 0; t < 3000; t += 16) det.feed(9.8 + (t > 1000 && t < 1150 ? 4 : 0), t);
  ok(n === 0, `a single bump should not count, got ${n}`);
  feedWalk(det, 5, 1.8, 0.3, 5000);
  ok(n === 0, `tiny vibration should not count, got ${n}`);
});

// ---------- 위치 추정기 ----------
test('localizer: a step right after a QR fix is only partly counted', () => {
  const loc = new Localizer(station, { stride: 0.65 });
  loc.hasFix = true;
  loc.pos = { x: 5, y: 12 };
  loc.lastFixT = 1000;
  // 방향 보정값이 0이면 lookQuat(90)은 동쪽을 본다
  ok(loc.onStep(lookQuat(90, 0), 1100), 'moves a little');
  ok(loc.pos.x > 5 && loc.pos.x < 5.2, `partial step, x=${loc.pos.x}`);
  loc.onStep(lookQuat(90, 0), 1650);
  near(loc.pos.x, 5 + 0.65 * (100 / 700) + 0.65, 0.01, 'next step counts fully');
  near(loc.pos.y, 12, 1e-6, 'walking east does not change y');
});

test('localizer: while walking, the shown position runs ahead between steps and settles when stopped', () => {
  const loc = new Localizer(station, { stride: 0.7 });
  loc.hasFix = true;
  loc.pos = { x: 5, y: 12 };
  loc.lastFixT = 0;
  const east = lookQuat(90, 0);
  // 0.5초 간격으로 네 걸음
  for (const t of [1000, 1500, 2000, 2500]) loc.onStep(east, t);
  const x0 = loc.pos.x;
  near(loc.predicted(east, 2500).x, x0, 1e-6, 'right at a step: no lead');
  near(loc.predicted(east, 2750).x, x0 + 0.35, 0.02, 'half way to the next step');
  ok(loc.predicted(east, 2990).x <= x0 + 0.7 * 0.8 + 1e-6, 'lead is capped below one stride');
  near(loc.predicted(east, 3400).x, x0, 1e-6, 'no step for a while: back to the estimate');
  near(loc.partialStep(2750), 0.35, 0.02, 'partial step distance for stride calibration');
  near(loc.partialStep(3400), 0, 1e-6, 'no partial step when stopped');

  // 걸음 감지기가 보류했던 첫 걸음과 함께 두 걸음을 한 번에 알려 줘도 걷는 박자를 잃지 않는다
  const b = new Localizer(station, { stride: 0.7 });
  b.hasFix = true;
  b.pos = { x: 5, y: 12 };
  b.lastFixT = 0;
  b.onStep(east, 1500);
  b.onStep(east, 1500);
  b.onStep(east, 2000);
  ok(b.predicted(east, 2250).x > b.pos.x + 0.2, 'predicting from the third step');
});

// ---------- 카메라 움직임 추적기 (눈으로 보는 주행 거리계) ----------

/**
 * 추적기를 흉내 낸다: 실제 자세·위치를 "지도에 대해 trkYaw도 돌아간 좌표계, scale m짜리 단위"로 바꿔 넣는다.
 * 센서 좌표계는 지도에 대해 imuYaw도 돌아가 있다. 이동은 지도 좌표(동쪽 x, 북쪽 y)로 준다.
 */
function feedTrack(vo, { trkYaw, imuYaw, scale, heading = 20, pitch = -15, from, to, frames, normal = true, origin = [0, 0], t0 = 0 }) {
  const qTrue = lookQuat(heading, pitch);
  const qImu = qMul(yawQuat(-imuYaw), qTrue);
  const turn = yawQuat(-trkYaw);
  const q = qMul(turn, qTrue);
  for (let i = 0; i <= frames; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / frames;
    const y = from[1] + ((to[1] - from[1]) * i) / frames;
    const d = qRotate(turn, [x - origin[0], 0, -(y - origin[1])]);
    vo.feed({ q, p: [d[0] / scale, 1.4 / scale, d[2] / scale], normal, qImu, t: t0 + i * 33 });
  }
}

test('visual odometer: movement is reported in the sensor frame whatever frame the tracker uses', () => {
  for (const [trkYaw, imuYaw] of [[211, 137], [-40, 80], [5, 300]]) {
    const vo = new VisualOdometer();
    const sum = [0, 0, 0];
    vo.onMove = (vx, vz, vy) => {
      sum[0] += vx;
      sum[1] += vy;
      sum[2] += vz;
    };
    // 지도에서 동쪽으로 3m, 북쪽으로 1m 이동. 추적기 단위는 0.9m
    feedTrack(vo, { trkYaw, imuYaw, scale: 0.9, from: [2, 5], to: [5, 6], frames: 60 });
    // 센서 좌표계의 이동을 지도 좌표계로 돌리면(= 방향 보정값이 imuYaw) 실제 이동이 나와야 한다
    const v = qRotate(yawQuat(imuYaw), sum);
    near(v[0] * 0.9, 3, 0.02, `east (${trkYaw}, ${imuYaw})`);
    near(-v[2] * 0.9, 1, 0.02, `north (${trkYaw}, ${imuYaw})`);
    near(sum[1], 0, 1e-6, 'no height change');
    near(vo.y * 0.9, 1.4, 1e-6, 'camera height in tracker units');
    ok(vo.status === 'normal' && vo.resets === 0, 'tracking normally');
  }
});

test('visual odometer: nothing is reported while tracking is lost, and a re-started tracker frame causes no jump', () => {
  const vo = new VisualOdometer();
  const sum = [0, 0, 0];
  let biggest = 0;
  vo.onMove = (vx, vz) => {
    sum[0] += vx;
    sum[2] += vz;
    biggest = Math.max(biggest, Math.hypot(vx, vz));
  };
  const base = { imuYaw: 137, scale: 1 };
  feedTrack(vo, { ...base, trkYaw: 30, from: [0, 0], to: [2, 0], frames: 40 });
  // 추적을 놓친 동안 1m 이동 (추적기는 위치를 모른다)
  feedTrack(vo, { ...base, trkYaw: 30, from: [2, 0], to: [2, 0], frames: 10, normal: false, t0: 2000 });
  ok(vo.status === 'limited', 'limited');
  // 다시 잡으면서 좌표계를 새로 잡았다: 방향이 100도 다르고 원점도 다르고 단위도 다르다
  feedTrack(vo, { ...base, trkYaw: 130, scale: 1.25, origin: [3, 0], from: [3, 0], to: [6, 0], frames: 60, t0: 3000 });
  ok(vo.resets >= 1, 'the new tracker frame was noticed');
  ok(biggest < 0.2, `no jump was reported (largest single move ${biggest})`);
  const v = qRotate(yawQuat(137), sum);
  // 처음 2m(단위 1m) + 다시 잡은 뒤의 이동(단위 1.25m로 3m = 2.4단위). 다시 잡은 직후 몇 프레임은 버린다
  near(v[0], 2 + 2.4, 0.3, 'east, in tracker units of each segment');
  near(-v[2], 0, 0.1, 'north');
});

test('visual odometer: the tracker attitude can stand in for the sensor attitude of the same instant', () => {
  // 추적 엔진은 영상과 자세를 같은 순간의 것으로 짝지어 준다. 그 자세를 센서 좌표계로 옮기면
  // "그 영상을 찍은 순간의 센서 자세"가 된다 (QR 위치 계산에 쓴다).
  const vo = new VisualOdometer();
  const trkYaw = 211;
  const imuYaw = 137;
  const still = lookQuat(20, -15);
  for (let i = 0; i < 40; i++) {
    vo.feed({ q: qMul(yawQuat(-trkYaw), still), p: [0, 1.4, 0], normal: true, qImu: qMul(yawQuat(-imuYaw), still), t: i * 16 });
  }
  // 폰을 돌렸다: 추적기가 말한 새 자세를 센서 좌표계로 옮기면, 그 순간의 센서 자세와 같아야 한다
  const turned = lookQuat(47, -32);
  const got = vo.syncedImu(qMul(yawQuat(-trkYaw), turned));
  const want = qMul(yawQuat(-imuYaw), turned);
  near(headingOf(got), headingOf(want), 0.2, 'heading');
  near(pitchOf(got), pitchOf(want), 0.2, 'pitch');
});

test('visual odometer: a tracker whose attitude disagrees with the tilt sensor is not used', () => {
  const vo = new VisualOdometer();
  let moves = 0;
  vo.onMove = () => moves++;
  const qImu = lookQuat(20, -15);
  // 추적기가 말하는 자세가 센서와 60도쯤 다른 쪽으로 기울어 있다 (좌표 규칙이 예상과 다를 때 생긴다)
  const q = qMul(qAxis(1, 0, 0, (60 * Math.PI) / 180), qImu);
  for (let i = 0; i < 30; i++) vo.feed({ q, p: [i * 0.03, 1.4, 0], normal: true, qImu, t: i * 33 });
  ok(vo.status === 'normal' && !vo.usable, 'normal status but not usable');
  ok(moves === 0, 'no movement is reported');
  ok(vo.syncedImu(q) === null, 'its attitude is not used either');
  ok(vo.tilt > 40, `tilt disagreement is visible for diagnosis (${vo.tilt})`);
});

// ---------- LiDAR 스캔 → 평면도 ----------

/**
 * 스캔 앱이 만들 법한 메시를 만든다. outline은 지도 좌표의 벽 꼭짓점들(닫힌 다각형),
 * floors는 바닥 사각형들 [x1, y1, x2, y2]. 아이폰(ARKit)처럼 y가 위쪽이고 지도 y는 -z다.
 */
function scanMesh({ outline, floors, height = 2.6, floorH = -1.3, yaw = 0, step = 0.2 }) {
  const pos = [];
  const idx = [];
  const c = Math.cos((yaw * Math.PI) / 180);
  const s = Math.sin((yaw * Math.PI) / 180);
  const add = (X, Y, Hh) => {
    // 지도 좌표를 방위각 yaw만큼 돌려(시계 방향) 스캔 좌표로 옮긴다
    const x = X * c + Y * s;
    const y = -X * s + Y * c;
    pos.push(x, Hh, -y);
    return pos.length / 3 - 1;
  };
  const quad = (p00, p10, p11, p01) => idx.push(p00, p10, p11, p00, p11, p01);
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i];
    const [x2, y2] = outline[(i + 1) % outline.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const nu = Math.max(1, Math.round(len / step));
    const nv = Math.max(1, Math.round(height / step));
    const grid = [];
    for (let u = 0; u <= nu; u++) {
      grid.push([]);
      for (let v = 0; v <= nv; v++) {
        grid[u].push(add(x1 + ((x2 - x1) * u) / nu, y1 + ((y2 - y1) * u) / nu, floorH + (height * v) / nv));
      }
    }
    for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) quad(grid[u][v], grid[u + 1][v], grid[u + 1][v + 1], grid[u][v + 1]);
  }
  for (const level of [floorH, floorH + height]) {
    for (const [x1, y1, x2, y2] of floors) {
      const nu = Math.max(1, Math.round((x2 - x1) / step));
      const nv = Math.max(1, Math.round((y2 - y1) / step));
      const grid = [];
      for (let u = 0; u <= nu; u++) {
        grid.push([]);
        for (let v = 0; v <= nv; v++) grid[u].push(add(x1 + ((x2 - x1) * u) / nu, y1 + ((y2 - y1) * v) / nv, level));
      }
      for (let u = 0; u < nu; u++) for (let v = 0; v < nv; v++) quad(grid[u][v], grid[u + 1][v], grid[u + 1][v + 1], grid[u][v + 1]);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

function objFile(mesh, name = 'scan.obj') {
  const lines = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i].toFixed(4)} ${mesh.positions[i + 1].toFixed(4)} ${mesh.positions[i + 2].toFixed(4)}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    // 스캔 앱처럼 "꼭짓점/텍스처/법선" 형태로 적는다
    const f = [0, 1, 2].map((k) => `${mesh.indices[i + k] + 1}/${mesh.indices[i + k] + 1}/1`);
    lines.push(`f ${f.join(' ')}`);
  }
  return new File([lines.join('\r\n')], name);
}

function glbFile(mesh, translation) {
  const posBytes = new Uint8Array(mesh.positions.buffer.slice(0));
  const idxBytes = new Uint8Array(mesh.indices.buffer.slice(0));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: posBytes.length + idxBytes.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    ],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const binLen = posBytes.length + idxBytes.length;
  const out = new ArrayBuffer(12 + 8 + jsonBytes.length + 8 + binLen);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.byteLength, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.length).set(jsonBytes);
  const b = 20 + jsonBytes.length;
  dv.setUint32(b, binLen, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  new Uint8Array(out, b + 8).set(posBytes);
  new Uint8Array(out, b + 8 + posBytes.length).set(idxBytes);
  return new File([out], 'scan.glb');
}

/** 점 구름 PLY (z가 위쪽인 좌표로 저장: 지도 x, 지도 y, 높이) */
function plyPointFile(mesh) {
  const n = mesh.positions.length / 3;
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nend_header\n`;
  const headBytes = new TextEncoder().encode(head);
  const out = new ArrayBuffer(headBytes.length + n * 13);
  new Uint8Array(out).set(headBytes);
  const dv = new DataView(out);
  for (let i = 0; i < n; i++) {
    const o = headBytes.length + i * 13;
    dv.setFloat32(o, mesh.positions[i * 3], true);
    dv.setFloat32(o + 4, -mesh.positions[i * 3 + 2], true);
    dv.setFloat32(o + 8, mesh.positions[i * 3 + 1], true);
    dv.setUint8(o + 12, 200);
  }
  return new File([out], 'cloud.ply');
}

/** 평면도에서 지도 좌표 (x, y) 근처(반경 r칸)에 벽이 있는지 */
function wallAt(fp, x, y, r = 2) {
  const c0 = Math.floor((x - fp.minX) / fp.cell);
  const r0 = Math.floor((fp.maxY - y) / fp.cell);
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const c = c0 + dc;
      const rr = r0 + dr;
      if (c >= 0 && c < fp.cols && rr >= 0 && rr < fp.rows && fp.wall[rr * fp.cols + c] > 0) return true;
    }
  }
  return false;
}

// ㄱ자 복도: 위로 10m 간 뒤 오른쪽으로 6m. 폭 2m.
const L_SHAPE = {
  outline: [[-1, 0], [1, 0], [1, 9], [6, 9], [6, 11], [-1, 11]],
  floors: [[-1, 0, 1, 11], [1, 9, 6, 11]],
};

const scanResults = {};
{
  const mesh = scanMesh(L_SHAPE);
  const parsed = await parseScanFile(objFile(mesh));
  scanResults.obj = { parsed, mesh, fp: buildFloorplan(parsed, { rotate: 'none' }) };
  const turned = await parseScanFile(objFile(scanMesh({ ...L_SHAPE, yaw: 23 })));
  scanResults.turned = buildFloorplan(turned);
  const glb = await parseScanFile(glbFile(mesh, [5, 0.7, -3]));
  scanResults.glb = buildFloorplan(glb, { rotate: 'none' });
  const ply = await parseScanFile(plyPointFile(scanMesh({ ...L_SHAPE, step: 0.03 })));
  scanResults.plyMesh = ply;
  scanResults.ply = buildFloorplan(ply, { rotate: 'none' });
}

test('scan import: OBJ is parsed (faces in v/vt/vn form, CRLF line ends)', () => {
  const { parsed, mesh } = scanResults.obj;
  ok(parsed.positions.length === mesh.positions.length, 'vertex count');
  ok(parsed.indices.length === mesh.indices.length, 'triangle count');
  ok(parsed.indices[5] === mesh.indices[5], 'indices are zero-based');
});

test('scan import: finds up axis, floor and ceiling', () => {
  const { fp } = scanResults.obj;
  ok(fp.up === 'y', `up axis ${fp.up}`);
  near(fp.floor, -1.3, 0.06, 'floor height');
  near(fp.stats.roomHeight, 2.6, 0.12, 'room height');
});

test('scan import: floor plan has the right size and is not mirrored', () => {
  const { fp } = scanResults.obj;
  near(fp.stats.width, 7 + 1, 0.11, 'width (7m + margins)');
  near(fp.stats.height, 11 + 1, 0.11, 'height (11m + margins)');
  ok(wallAt(fp, 6, 10), 'end wall of the right-hand leg at x=6');
  ok(wallAt(fp, 1, 4.5), 'right wall of the first leg');
  ok(wallAt(fp, -1, 4.5), 'left wall of the first leg');
  ok(!wallAt(fp, 0, 4.5, 4), 'middle of the corridor is free');
  ok(!wallAt(fp, 3.5, 6, 6), 'outside the corridor is empty');
  ok(!wallAt(fp, -4, 10, 6), 'nothing on the left side (would mean a mirrored map)');
});

test('scan import: scanned floor area is marked', () => {
  const { fp } = scanResults.obj;
  const at = (x, y) => fp.floorMask[Math.floor((fp.maxY - y) / fp.cell) * fp.cols + Math.floor((x - fp.minX) / fp.cell)];
  ok(at(0, 5) === 1, 'floor inside the corridor');
  ok(at(4, 10) === 1, 'floor in the second leg');
  ok(at(4, 5) === 0, 'no floor outside');
});

test('scan import: a scan turned by 23 degrees is straightened', () => {
  const fp = scanResults.turned;
  near(Math.abs(fp.rotation), 23, 1.0, 'detected wall direction');
  // 똑바로 펴졌다면 7m x 11m (또는 90도 돌아간 11m x 7m) 크기가 된다
  const dims = [fp.stats.width - 1, fp.stats.height - 1].sort((a, b) => a - b);
  near(dims[0], 7, 0.25, 'short side');
  near(dims[1], 11, 0.25, 'long side');
});

test('scan import: GLB with a node transform', () => {
  const fp = scanResults.glb;
  ok(fp.up === 'y');
  // 노드가 x로 5m, z로 -3m(지도 y로 +3m) 옮겨져 있다
  ok(wallAt(fp, 6 + 5, 10 + 3), 'end wall moved by the node translation');
  near(fp.floor, -1.3 + 0.7, 0.06, 'floor moved up by 0.7m');
});

test('scan import: point cloud PLY with z up', () => {
  const fp = scanResults.ply;
  ok(scanResults.plyMesh.indices === null, 'no faces in a point cloud');
  ok(fp.up === 'z', `up axis ${fp.up}`);
  ok(wallAt(fp, 6, 10) && wallAt(fp, -1, 4.5), 'walls from points');
  ok(!wallAt(fp, -4, 10, 6), 'not mirrored');
  near(fp.stats.width, 8, 0.11);
});

// ---------- 영상에서 복도 방향 찾기 ----------

/**
 * 복도를 바라본 화면을 그린다. 복도는 카메라 정면에서 relDeg만큼 오른쪽으로 뻗어 있고,
 * 카메라는 pitchDeg만큼 위(+)나 아래(-)를 본다. 복도와 나란한 선들은 한 점으로 모이고,
 * 문틀 같은 세로선과 바닥 타일 같은 가로선도 섞여 있다.
 */
function corridorImage({ relDeg, pitchDeg, corridorLines = true, floorOnly = false, single = false }) {
  const w = 160;
  const h = 284;
  const f = h / 2 / Math.tan((32.5 * Math.PI) / 180);
  const q = lookQuat(0, pitchDeg);
  const toCam = (v) => qRotate(qConj(q), v);
  const pixel = (d) => [w / 2 + (f * d[0]) / -d[2], h / 2 - (f * d[1]) / -d[2]];
  const up = toCam([0, 1, 0]);
  const a = (relDeg * Math.PI) / 180;
  const vp = pixel(toCam([Math.sin(a), 0, -Math.cos(a)]));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#222';
  g.lineWidth = 2;
  const line = (x1, y1, x2, y2) => {
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  if (floorOnly) {
    // 폰을 숙였을 때: 복도 끝은 화면 위쪽 밖에 있고 바닥만 보인다.
    // 폭 2.2m 복도의 양쪽 바닥 경계선과 바닥 줄눈 하나를 실제 위치대로 그린다 (카메라 높이 1.4m).
    const dir = [Math.sin(a), 0, -Math.cos(a)];
    const lat = [Math.cos(a), 0, Math.sin(a)];
    for (const off of [-1.1, 1.1, 0.45]) {
      let prev = null;
      for (let z = 0.6; z <= 14; z += 0.2) {
        const d = toCam([lat[0] * off + dir[0] * z, -1.4, lat[2] * off + dir[2] * z]);
        const cur = -d[2] > 0.05 ? pixel(d) : null;
        if (prev && cur) line(prev[0], prev[1], cur[0], cur[1]);
        prev = cur;
      }
    }
  } else if (single) {
    line(vp[0], vp[1], w * 0.9, h);
  } else if (corridorLines) {
    // 바닥·천장과 벽의 경계, 벽의 띠
    for (const [x, y] of [[0, h], [w, h], [0, 0], [w, 0], [0, h * 0.75], [w, h * 0.72], [0, h * 0.2], [w, h * 0.25]]) {
      line(vp[0] + (x - vp[0]) * 0.12, vp[1] + (y - vp[1]) * 0.12, x, y);
    }
  }
  // 세로선: 실제 수직선은 화면에서 "위쪽 방향의 소실점"으로 모인다
  for (const x of [18, 47, 96, 131, 150]) {
    const y0 = h / 2 - 90;
    if (Math.abs(up[2]) < 1e-6) {
      line(x, y0, x, y0 + 150);
    } else {
      const z = pixel(up);
      const len = Math.hypot(z[0] - x, z[1] - y0);
      const s = (z[1] > y0 ? 150 : -150) / len;
      line(x, y0, x + (z[0] - x) * Math.abs(s) * Math.sign(z[1] - y0) * Math.sign(s), y0 + (z[1] - y0) * Math.abs(s) * Math.sign(z[1] - y0) * Math.sign(s));
    }
  }
  // 가로선 (지평선과 나란한 바닥 타일 줄)
  for (const y of [h * 0.62, h * 0.8, h * 0.93]) line(0, y, w, y);
  return { image: g.getImageData(0, 0, w, h), intr: { f, cx: w / 2, cy: h / 2 }, up };
}

test('corridor direction: found within 1.5 degrees, level and tilted camera', () => {
  for (const [rel, pitch] of [[10, 0], [-18, -15], [0, 8], [25, -25], [-6, -10]]) {
    const { image, intr, up } = corridorImage({ relDeg: rel, pitchDeg: pitch });
    const peak = findPeak(corridorHistogram(image, intr, up), rel + 7, 20);
    ok(peak, `no corridor found for rel ${rel}, pitch ${pitch}`);
    near(peak.rel, rel, 1.5, `rel ${rel}, pitch ${pitch}`);
  }
});

test('corridor direction: nothing is reported when facing a wall', () => {
  const { image, intr, up } = corridorImage({ relDeg: 0, pitchDeg: -5, corridorLines: false });
  ok(findPeak(corridorHistogram(image, intr, up), 0, 20) === null, 'vertical and horizontal lines only');
});

test('corridor direction: phone tilted far down, only the floor edges are visible', () => {
  // 복도 끝(소실점)은 화면 위쪽 밖에 있고, 바닥과 벽의 경계선 두 개만 보이는 경우
  for (const [rel, pitch] of [[6, -42], [-7, -36], [0, -38]]) {
    const { image, intr, up } = corridorImage({ relDeg: rel, pitchDeg: pitch, floorOnly: true });
    const peak = findPeak(corridorHistogram(image, intr, up), rel - 6, 20);
    ok(peak, `no corridor found for rel ${rel}, pitch ${pitch}`);
    near(peak.rel, rel, 1.5, `rel ${rel}, pitch ${pitch}`);
  }
});

test('corridor direction: one straight line alone is not taken as the corridor', () => {
  // 선 하나만으로는 그 선이 복도와 나란한지 알 수 없다 (그림자, 바닥 무늬, 비스듬한 난간 등)
  const { image, intr, up } = corridorImage({ relDeg: 5, pitchDeg: -20, corridorLines: false, single: true });
  ok(findPeak(corridorHistogram(image, intr, up), 5, 20) === null, 'single line must be rejected');
});

export const done = Promise.resolve(results);
window.__testResults = results;

// 화면에 결과 표시
const el = document.getElementById('out');
if (el) {
  const failed = results.filter((r) => !r.ok);
  el.innerHTML =
    `<h2>${results.length - failed.length} / ${results.length} passed</h2>` +
    results
      .map(
        (r) =>
          `<div class="${r.ok ? 'ok' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}` +
          (r.ok ? '' : `<pre>${r.error}</pre>`) +
          '</div>'
      )
      .join('');
}
