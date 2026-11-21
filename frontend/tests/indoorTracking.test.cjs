const { test } = require('node:test');
const assert = require('node:assert/strict');

// The upright rear camera looks along map +Y. Its image right is +X and down is -Z.
function fix(x, y) {
  return { position: [x, y, 1.5], cameraToWorld: [1, 0, 0, x, 0, 0, 1, y, 0, -1, 0, 1.5, 0, 0, 0, 1] };
}
function sample(timeMs, acceleration, rotationRate = null, accelerationIncludingGravity = null) {
  return { timeMs, acceleration, rotationRate, accelerationIncludingGravity };
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);
}
async function tracker() {
  const { IndoorTracking } = await import('../src/ar/indoorTracking.ts');
  return new IndoorTracking();
}

test('predicts from each measured camera position and replays motion newer than a delayed fix', async () => {
  const t = await tracker();
  t.motion(sample(10, [3, 0, 0]));
  assert.equal(t.pose(10, false), undefined);
  t.correct('a', fix(2, 7), 100, 0);
  for (let time = 150; time <= 1000; time += 50) t.motion(sample(time, [1, 0, 0]));
  assert.equal(t.pose(1000, false).source, 'motion');
  assert.equal(t.walkingObservation(1000), undefined, 'acceleration without confirmed steps cannot announce turns');
  near(t.pose(1000, false).point[0], 2.405); // 1/2 * 1 m/s² * .9 s²
  near(t.pose(1000, false).point[1], 7);
  t.correct('a', fix(5, 8), 900, 0);
  assert.deepEqual(t.pose(1000, true).point, [5, 8]);
  near(t.pose(1000, false).point[0], 5.005);
  t.motion(sample(950, [100, 0, 0])); // out of order
  near(t.pose(1000, false).point[0], 5.005);
  t.correct('b', fix(-5, -4), 1200, 0);
  t.motion(sample(1300, [0, 0, 0]));
  assert.deepEqual(t.pose(1300, false).point, [-5, -4]);
  assert.equal(t.pose(1300, false).spaceId, 'b');
});

test('closely spaced tag fixes preserve walking velocity at the exposure time', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 50; time <= 600; time += 50) {
    t.motion(sample(time, [2, 0, 0]));
    if (time === 150) t.correct('a', fix(.01, 0), 100, 0);
    if (time === 250) t.correct('a', fix(.04, 0), 200, 0);
  }
  near(t.pose(600, false).point[0], .36);
  // Incoming images must not keep a paused sensor stream alive.
  let referenceTimeMs = 200;
  for (let time = 700; time <= 1100; time += 100) {
    if (t.correct('a', { ...fix(.36, 0), referenceTimeMs }, time, 0, 'floor')) referenceTimeMs = time;
  }
  assert.equal(referenceTimeMs, 900);
  assert.equal(t.pose(1100, false).source, 'last');
});

test('matched floor images keep their own anchor until motion samples can resume fusion', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 150; time <= 1500; time += 150) {
    const anchor = t.floorAnchor(time);
    assert.deepEqual(anchor, { spaceId: 'a', timeMs: time - 150 });
    assert.equal(t.correct('a', { ...fix(0, time / 1000), referenceTimeMs: anchor.timeMs }, time, 0, 'floor'), false);
    assert.equal(t.pose(time, false).source, 'last');
  }
  t.motion(sample(1600, [0, 0, 0]));
  assert.equal(t.correct('a', { ...fix(0, 2), referenceTimeMs: 0 }, 1650, 0, 'floor'), undefined);
  assert.equal(t.correct('b', { ...fix(0, 2), referenceTimeMs: 1500 }, 1650, 0, 'floor'), undefined);
  assert.equal(t.correct('a', { ...fix(0, 2), referenceTimeMs: 1500 }, 1650, 0, 'floor'), true);
  assert.deepEqual(t.pose(1650, false).point, [0, 2]);
  assert.equal(t.floorAnchor(3000), undefined);
});

test('maps landscape and subsequent handset rotation into floor coordinates', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 90);
  for (let time = 50; time <= 600; time += 50) t.motion(sample(time, [0, -2, 0]));
  near(t.pose(600, false).point[0], .36);
  near(t.pose(600, false).point[1], 0);
  t.correct('b', fix(0, 0), 1100, 0);
  for (let time = 1150; time <= 1600; time += 50) t.motion(sample(time, [0, 0, 0], [0, 180, 0]));
  near(t.pose(1600, false).headingDeg, -90);
  for (let time = 1650; time <= 2000; time += 50) t.motion(sample(time, [2, 0, 0]));
  near(t.pose(2000, false).point[0], 0);
  near(t.pose(2000, false).point[1], .16);
});

test('corridor yaw steers navigation while exposure samples keep the raw camera axes', async () => {
  for (const angle of [0, 90, 180, 270]) {
    const t = await tracker();
    const raw = fix(0, 0);
    t.correct('a', raw, 0, angle, 'tag', [], 7);
    near(t.pose(0, true).headingDeg, 7);
    t.motion(sample(20, [0, 0, 0], [0, 0, 0]));
    const shot = t.corridorCamera(25, angle);
    near(shot.headingDeg, 0);
    shot.up.forEach((v,i) => near(v, [0, -1, 0][i]));
    assert.deepEqual(shot.point, [0, 0]);
    t.correctHeading('a', -5, 25);
    t.correctHeading('a', -5, 30);
    t.correctHeading('a', 8, 24);
    t.correctHeading('other', 9, 35);
    near(t.pose(30, false).headingDeg, -5);

    t.motion(sample(50, [0, 0, 0], [0, 160, 0]));
    near(t.corridorCamera(40, angle).headingDeg, 0); // The image preceded the rotation.
    assert.equal(t.corridorCamera(120, angle), undefined);
    t.correct('a', raw, 150, angle);
    near(t.pose(150, true).headingDeg, 0);
    assert.equal(t.corridorCamera(155, angle), undefined);
    assert.deepEqual(raw, fix(0, 0));
  }
});

test('gyro-only turns keep the guide aligned after a long stationary tag outage in every display orientation', async () => {
  const { readMotion } = await import('../src/ar/motion.ts');
  try {
    for (const angle of [0, 90, 180, 270]) {
      const t = await tracker();
      global.screen = { orientation: { angle } };
      t.correct('hall', fix(4, 7), 100, angle, 'tag', undefined, 8);
      const rad = angle * Math.PI / 180;
      for (let at = 120; at <= 31100; at += 20) {
        const rate = at <= 30100 ? 0 : -90;
        // DeviceMotion rotationRate reports physical X, Y, Z rates as alpha, beta, gamma.
        t.motion(readMotion({ timeStamp: at, rotationRate: { alpha: Math.sin(rad) * rate, beta: Math.cos(rad) * rate, gamma: 0 } }));
      }
      const shot = t.guideCamera(31105, angle);
      assert.equal(shot.spaceId, 'hall');
      assert.equal(shot.referenceTimeMs, 100);
      const m = shot.cameraToWorld;
      near(Math.atan2(m[2], m[6]) * 180 / Math.PI, 98); // Corridor calibration is applied once.
      assert.deepEqual([m[3], m[7], m[11]], [4, 7, 1.5]);
      assert.equal(t.pose(31105, false).source, 'last');
      near(t.pose(31105, false).headingDeg, 98);
      assert.equal(t.walkingObservation(31105), undefined);
      assert.equal(t.floorAnchor(31105), undefined);
      assert.equal(t.corridorCamera(31105, angle), undefined);
      t.motion(sample(31110, [0, 0, 0]));
      assert.deepEqual(t.guideCamera(31115, angle), shot);
      const rotatedDisplay = t.guideCamera(31105, angle + 90).cameraToWorld;
      for (const axis of [0,4,8]) {
        near(rotatedDisplay[axis + 2], m[axis + 2]);
        near(rotatedDisplay[axis], m[axis + 1]);
      }
    }
  } finally { delete global.screen; }
});

test('visual-only floor poses replay delayed gyro samples and rotation resumes after a gap', async () => {
  const t = await tracker();
  const downward = { position: [2, 3, 1.2], cameraToWorld: [1,0,0,2, 0,-1,0,3, 0,0,-1,1.2, 0,0,0,1] };
  t.correct('hall', fix(0, 0), 0, 0);
  for (let at = 20; at <= 1000; at += 20) t.motion(sample(at, null, [0, 0, -90]));
  assert.equal(t.correct('hall', { ...downward, referenceTimeMs: 0 }, 200, 0, 'floor'), false);
  const shot = t.guideCamera(1000, 0);
  assert.equal(shot.referenceTimeMs, 200);
  const m = shot.cameraToWorld;
  near(Math.atan2(m[4], m[0]) * 180 / Math.PI, -72);
  near(m[10], -1);
  assert.deepEqual([m[3], m[7], m[11]], [2, 3, 1.2]);
  assert.equal(t.guideCamera(1400, 0), undefined);
  t.motion(sample(1500, null, [0, 0, 90]));
  assert.equal(t.guideCamera(1500, 0), undefined);
  t.motion(sample(1520, null, [0, 0, 90]));
  const resumed = t.guideCamera(1520, 0).cameraToWorld;
  near(Math.atan2(resumed[4], resumed[0]) * 180 / Math.PI, -72 + 1.8);
  assert.deepEqual([resumed[3], resumed[7], resumed[11]], [2, 3, 1.2]);
  t.correct('other', fix(9, 8), 1550, 0);
  t.motion(sample(1570, null, [0, 0, 0]));
  assert.equal(t.guideCamera(1570, 0).spaceId, 'other');
  t.suspend();
  t.motion(sample(1580, null, [0, 90, 0]));
  t.motion(sample(1600, null, [0, 90, 0]));
  assert.equal(t.guideCamera(1600, 0), undefined);
});

test('gravity restores guide pitch and roll after a missed tilt while keeping the anchored bearing and position', async () => {
  const rad = Math.PI / 180;
  const pitch = 40 * rad, roll = 24 * rad;
  const actualUp = [Math.sin(roll)*Math.cos(pitch), -Math.cos(roll)*Math.cos(pitch), Math.sin(pitch)];
  for (const angle of [0, 90, 180, 270]) for (const polarity of [-1, 1]) {
    const t = await tracker();
    const c = Math.cos(angle*rad), s = Math.sin(angle*rad);
    function send(time, cameraUp, acceleration, rotation = [0, 0, 0]) {
      const [x,y,z] = cameraUp;
      const deviceUp = [c*x - s*y, -s*x - c*y, -z];
      const total = deviceUp.map((g, i) => polarity*9.81*g + acceleration[i]);
      t.motion(sample(time, acceleration, rotation, total));
    }
    send(10, [0,-1,0], [0,0,0]);
    assert.equal(t.floorUp(10, angle), undefined); // Polarity has no visual reference yet.
    t.correct('hall', fix(2,3), 20, angle, 'tag', undefined, 18);
    assert.ok(t.floorUp(20, angle)); // The acceleration sample preceded the tag exposure.
    send(40, [0,-1,0], [0,0,0]);
    // The handset tilted during a gyro outage and is now braking horizontally.
    send(1420, actualUp, [3,-1,2]);
    send(1440, actualUp, [3,-1,2]);
    const m = t.guideCamera(1440, angle).cameraToWorld;
    const up = t.floorUp(1440, angle);
    for (let i = 0; i < 3; i++) { near(up[i], actualUp[i]); near(m[8+i], actualUp[i]); }
    near(Math.atan2(m[2], m[6])/rad, 18);
    assert.deepEqual([m[3], m[7], m[11]], [2,3,1.5]);
    assert.equal(t.floorUp(1600, angle), undefined);
    t.motion(sample(1650, null, [0,0,0], [3,8,-2])); // Cannot separate gravity from translation.
    assert.equal(t.floorUp(1650, angle), undefined);
    const held = t.guideCamera(1650, angle).cameraToWorld;
    for (let i = 0; i < 3; i++) near(held[8+i], actualUp[i]);
    t.suspend();
    assert.equal(t.floorUp(1440, angle), undefined);
  }
});

test('late gyro permission starts tracking from the last known orientation in an anchored session', async () => {
  const t = await tracker();
  t.correct('a', fix(1, 2), 0, 0);
  for (let time = 10000; time <= 11000; time += 50) t.motion(sample(time, null, [0, -90, 0]));
  const camera = t.guideCamera(11000, 0);
  near(Math.atan2(camera.cameraToWorld[2], camera.cameraToWorld[6]) * 180 / Math.PI, 90);
  assert.equal(camera.referenceTimeMs, 0);
  const pose = t.pose(11000, false);
  assert.equal(pose.source, 'last');
  assert.deepEqual(pose.point, [1, 2]);
  near(pose.headingDeg, 90);
  assert.equal(t.pose(11400, false).headingDeg, null);
});

test('indoor guidance and a simultaneous motion permission request share the tap prompt', async () => {
  const { motionAccess, requestMotionAccess } = await import('../src/ar/motion.ts');
  let prompts = 0;
  const permission = Promise.withResolvers();
  global.window = { DeviceMotionEvent: { requestPermission() { prompts++; return permission.promise; } } };
  try {
    const first = requestMotionAccess(), second = requestMotionAccess();
    assert.equal(prompts, 1);
    permission.resolve('granted');
    assert.deepEqual(await Promise.all([first, second]), ['granted', 'granted']);
    assert.equal(motionAccess(), 'granted');
  } finally { delete global.window; }
});

test('step displacement uses corridor yaw once and a heading observation cannot confirm position', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 4000; time += 20) t.motion(walkingSample(time));
  const before = t.pose(4000, false).point;
  for (let time = 4020; time <= 8000; time += 20) {
    t.correctHeading('a', 8, time - 1);
    t.motion(walkingSample(time));
  }
  const pose = t.pose(8000, false);
  near(pose.headingDeg, 8);
  near(Math.atan2(pose.point[0] - before[0], pose.point[1] - before[1]) * 180 / Math.PI, 8);
  near(t.corridorCamera(8000, 0).headingDeg, 0);
  assert.equal(t.floorAnchor(8000), undefined);
  t.suspend();
  assert.equal(t.corridorCamera(8010, 0), undefined);
  assert.equal(t.pose(8010, false).source, 'last');
});

test('handles gravity polarity, rest, unusable samples and an interrupted stream', async () => {
  for (const sign of [1, -1]) {
    const t = await tracker();
    t.correct('a', fix(1, 2), 0, 0);
    for (let time = 50; time <= 100; time += 50)
      t.motion(sample(time, null, null, [0, sign * 9.81, 0]));
    assert.deepEqual(t.pose(100, false).point, [1, 2]);
    for (let time = 150; time <= 400; time += 50)
      t.motion(sample(time, [sign * 2, 0, 0], null, [sign * 2, sign * 9.81, 0]));
    near(t.pose(400, false).point[0], 1.09);
    for (let time = 450; time <= 900; time += 50) t.motion(sample(time, [0, 0, 0]));
    const rest = t.pose(900, false).point;
    t.motion(sample(950, [.04, 0, 0]));
    assert.deepEqual(t.pose(950, false).point, rest);
    t.motion(sample(1250, null, [5, 0, 0]));
    t.motion(sample(1450, [2, 0, 0]));
    assert.equal(t.pose(1450, false).source, 'last');
    assert.deepEqual(t.pose(1450, false).point, rest);
    t.correct('a', fix(3, 4), 3200, 0);
    assert.equal(t.pose(3200, true).source, 'tag');
    t.motion(sample(3250, [2, 0, 0]));
    assert.equal(t.pose(3250, false).source, 'motion');
    t.suspend();
    t.motion(sample(3300, [2, 0, 0]));
    assert.equal(t.pose(3300, false).source, 'last');
  }
});

test('continuous IMU cannot accumulate drift indefinitely or renew a lost visual anchor', async () => {
  for (const [accel, bound] of [[.4, .2], [8, .75]]) {
    const t = await tracker();
    t.correct('a', fix(3, 0), 0, 0);
    for (let time = 20; time <= 8000; time += 20) t.motion(sample(time, [accel, 0, 0]));
    const held = t.pose(8000, false);
    assert.equal(held.source, 'last');
    near(held.point[0], 3 + bound);
    assert.equal(t.correct('a', { ...fix(15, 0), referenceTimeMs: 4000 }, 8000, 0, 'floor'), undefined);
    assert.deepEqual(t.pose(8000, false), held);
    t.correct('a', fix(7, 2), 8100, 0);
    t.motion(sample(8150, [0, 0, 0]));
    assert.deepEqual(t.pose(8150, false).point, [7, 2]);
    assert.equal(t.pose(8150, false).source, 'motion');
  }
});

function walkingSample(timeMs, rate = 0, travel = 1, polarity = 1) {
  // In an upright handset +Y is vertical and -Z points through the rear lens.
  const phase = 2 * Math.PI * timeMs / 600;
  const vertical = polarity * 1.8 * Math.sin(phase);
  const z = -polarity * travel * Math.cos(phase);
  return sample(timeMs, [0, vertical, z], [0, rate, 0], [0, polarity * 9.81 + vertical, z]);
}

test('cadenced steps bridge long visual outages, turn with the handset, and stop at rest', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 6000; time += 20) t.motion(walkingSample(time));
  const before = t.pose(6000, false);
  assert.equal(before.source, 'motion');
  assert.ok(before.point[1] > 4 && before.point[1] < 6);
  assert.equal(t.walkingObservation(6000).headingDeg, 0);
  near(before.point[0], 0);
  for (let time = 6020; time <= 7000; time += 20) t.motion(walkingSample(time, -90));
  for (let time = 7020; time <= 12000; time += 20) t.motion(walkingSample(time));
  const turned = t.pose(12000, false);
  assert.ok(turned.point[0] > 4 && Math.abs(turned.point[1] - before.point[1]) < 1.3);
  assert.equal(t.floorAnchor(12000), undefined, 'a counted step cannot re-anchor an unrelated camera image');
  for (let time = 12020; time <= 15000; time += 20) t.motion(sample(time, [0, 0, 0], null, [0, 9.81, 0]));
  assert.equal(t.pose(15000, false).source, 'last');
  assert.equal(t.walkingObservation(15000), undefined);
  assert.deepEqual(t.pose(15000, false).point, turned.point);
  t.correct('a', fix(20, 30), 15020, 0);
  assert.deepEqual(t.pose(15020, true).point, [20, 30]);
});

test('replaying steps after a delayed tag correction gives the same displacement as an on-time fix', async () => {
  const timely = await tracker(), delayed = await tracker();
  for (const t of [timely, delayed]) t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 6000; time += 20) {
    for (const t of [timely, delayed]) t.motion(walkingSample(time));
    if (time === 3600) timely.correct('a', fix(1, 3), 3600, 0);
    if (time === 3840) delayed.correct('a', fix(1, 3), 3600, 0);
  }
  assert.deepEqual(timely.pose(6000, false), delayed.pose(6000, false));
});

test('walking uses a nearby aligned corridor in either direction and retains its lateral offset', async () => {
  for (const sign of [1, -1]) {
    const t = await tracker();
    const angle = 10 * Math.PI / 180, c = sign * Math.cos(angle), s = sign * Math.sin(angle);
    const pose = { position: [.2, 0, 1.5], cameraToWorld: [c,0,s,.2, -s,0,c,0, 0,-1,0,1.5, 0,0,0,1] };
    t.correct('a', pose, 0, 0, 'tag', [[0, -10], [0, 10]]);
    for (let time = 20; time <= 4800; time += 20) t.motion(walkingSample(time));
    const point = t.pose(4800, false).point;
    near(point[0], .2);
    near(sign * point[1], 3); // Five confirmed strides after cadence acquisition.
  }
});

test('rapid shaking does not alias into a slower walking cadence', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 6000; time += 20) {
    const a = 3 * Math.sin(time * 2 * Math.PI / 200);
    const z = -Math.cos(time * 2 * Math.PI / 200);
    t.motion(sample(time, [0, a, z], null, [0, 9.81 + a, z]));
  }
  const held = t.pose(6000, false);
  assert.ok(Math.hypot(...held.point) <= .75);
  assert.equal(held.source, 'last');
});

test('backward steps reverse translation with the camera still pointing forward', async () => {
  for (const polarity of [1, -1]) {
    const t = await tracker();
    t.correct('a', fix(0, 0), 0, 0, 'tag', [[0, -20], [0, 20]]);
    for (let time = 20; time <= 6000; time += 20) t.motion(walkingSample(time, 0, 1, polarity));
    const outbound = t.pose(6000, false);
    for (let time = 6020; time <= 14400; time += 20) t.motion(walkingSample(time, 0, -1, polarity));
    const inbound = t.pose(14400, false);
    assert.equal(inbound.source, 'motion');
    near(inbound.headingDeg, outbound.headingDeg);
    assert.ok(inbound.point[1] < outbound.point[1] - 6);
  }
});

test('vertical oscillations alone cannot establish forward or backward travel', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 6000; time += 20) t.motion(walkingSample(time, 0, 0));
  assert.deepEqual(t.pose(6000, false).point, [0, 0]);
  assert.equal(t.pose(6000, false).source, 'last');
});

test('a walk that begins backward also works with gravity-inclusive readings alone', async () => {
  const t = await tracker();
  t.correct('a', fix(0, 0), 0, 0);
  for (let time = 20; time <= 6000; time += 20) {
    const s = walkingSample(time, 0, -1);
    t.motion({ ...s, acceleration: null });
  }
  assert.equal(t.pose(6000, false).source, 'motion');
  assert.ok(t.pose(6000, false).point[1] < -4);
});

async function replayGait({ periodMs, anchorAtMs, verticalAcceleration, forwardAcceleration }) {
  // 50 ms bins of the measured gravity-axis and horizontal fore/aft components.
  // Use a fixed lens heading to isolate travel direction from camera yaw.
  const t = await tracker();
  let farthest = 0;
  for (const [i, a] of verticalAcceleration.entries()) {
    const time = i * periodMs;
    if (time === anchorAtMs) t.correct('test', fix(0, 0), time, 0);
    const z = -(forwardAcceleration[i] ?? 0);
    if (a !== null) t.motion(sample(time, [0, a, z], null, [0, a + 9.81, z]));
    farthest = Math.max(farthest, t.pose(time, false)?.point[1] ?? 0);
  }
  return { end: t.pose((verticalAcceleration.length - 1) * periodMs, false), farthest };
}

test('replays the recorded corridor cadence across the 18.8-second visual gap', async () => {
  const fixture = require('./fixtures/corridor-gait.json');
  const { end } = await replayGait(fixture);
  assert.equal(end.source, 'motion');
  assert.ok(Math.abs(end.point[1] - fixture.tagSeparationM) < 2);
});

test('the S25 return walk reverses before the next tag is observed', async () => {
  const { end, farthest } = await replayGait(require('./fixtures/corridor-reverse-gait.json'));
  assert.equal(end.source, 'motion');
  assert.ok(farthest > 7);
  assert.ok(end.point[1] < farthest - 6 && Math.abs(end.point[1]) < 4);
});
