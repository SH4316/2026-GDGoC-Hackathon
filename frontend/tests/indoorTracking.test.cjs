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
  near(before.point[0], 0);
  for (let time = 6020; time <= 7000; time += 20) t.motion(walkingSample(time, -90));
  for (let time = 7020; time <= 12000; time += 20) t.motion(walkingSample(time));
  const turned = t.pose(12000, false);
  assert.ok(turned.point[0] > 4 && Math.abs(turned.point[1] - before.point[1]) < 1.3);
  assert.equal(t.floorAnchor(12000), undefined, 'a counted step cannot re-anchor an unrelated camera image');
  for (let time = 12020; time <= 15000; time += 20) t.motion(sample(time, [0, 0, 0], null, [0, 9.81, 0]));
  assert.equal(t.pose(15000, false).source, 'last');
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
