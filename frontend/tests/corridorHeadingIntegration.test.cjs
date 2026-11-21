const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { test } = require('node:test');
const { createContext, runInContext } = require('node:vm');
const { tagNetwork, routeTree } = require('../src/ar/tagRouting.ts');

const width = 640, height = 576, radians = Math.PI / 180;
const focal = Math.hypot(width, height) / (2 * Math.tan(35 * radians));
const cameraHeight = 1.35, trueHeading = 4, pitch = -18 * radians;
const headingX = Math.sin(trueHeading * radians), headingY = Math.cos(trueHeading * radians);
const tagX = .15, tagY = 2.85, tagId = 18;
const ar = join(__dirname, '../public/ar');

function ray(u, v) {
  const right = (u - (width - 1) / 2) / focal, down = (v - (height - 1) / 2) / focal;
  const forward = Math.cos(pitch) + Math.sin(pitch) * down;
  return [headingX * forward + headingY * right, headingY * forward - headingX * right,
    Math.sin(pitch) - Math.cos(pitch) * down];
}

function draw(cv, side, corridor, includeTag = true) {
  const dictionary = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11), tag = new cv.Mat();
  cv.generateImageMarker(dictionary, tagId, 8, tag, 1);
  const bits = Uint8Array.from(tag.data);
  tag.delete(); dictionary.delete();
  const rgba = new Uint8Array(width * height * 4);
  for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
    const [dx, dy, dz] = ray(u, v);
    const floor = dz < 0 ? -cameraHeight / dz : Infinity, ceiling = dz > 0 ? (3 - cameraHeight) / dz : Infinity;
    const wall = 1.5 / Math.abs(dx), depth = Math.min(wall, floor, ceiling, 24 / dy);
    const x = dx * depth, y = dy * depth, z = cameraHeight + dz * depth;
    let value = 180;
    if (depth === floor) {
      if (corridor) {
        const texture = (Math.imul(Math.floor(x * 14), 73856093) ^ Math.imul(Math.floor(y * 14), 19349663)) >>> 0;
        value = 165 + texture % 35;
        if (Math.abs(Math.abs(x) - 1.38) < .032 || Math.abs(Math.abs(x) - 1.04) < .02) value = 65;
      }
      const col = (x - tagX) / side + .5, row = .5 - (y - tagY) / side;
      if (includeTag && col >= 0 && col < 1 && row >= 0 && row < 1) value = bits[8 * Math.floor(row * 8) + Math.floor(col * 8)];
    } else if (corridor && depth === wall) {
      value = z < .12 || Math.abs(z - .55) < .035 || Math.abs(z - 2.72) < .04 ? 48 : 218;
      if (Math.abs(y % 3.5) < .035) value = 100;
    } else if (corridor && depth === ceiling && Math.abs(Math.abs(x) - .64) < .032) value = 65;
    const i = 4 * (v * width + u);
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value; rgba[i + 3] = 255;
  }
  return rgba;
}

function worker(cv, side, enabled = true, route = [[0, -15], [0, 20]]) {
  // A consistent 7° survey error biases the tag pose, while the physical corridor and target stay fixed.
  const error = 7 * radians, c = Math.cos(error), s = Math.sin(error);
  const station = { tagSideM: side, camera: { diagonalFovDeg: 70 }, route,
    tags: [{ id: tagId, center: [c * tagX + s * tagY, -s * tagX + c * tagY], yawDeg: 7 }] };
  const context = createContext({ cv, console });
  let message;
  context.self = context;
  context.postMessage = data => { message = data; };
  context.importScripts = name => {
    if (name) runInContext(readFileSync(join(ar, basename(name).split('?')[0]), 'utf8'), context);
  };
  runInContext(readFileSync(join(ar, 'tracker.js'), 'utf8'), context);
  context.onmessage({ data: { type: 'init', library: '', corridorHeadingEnabled: enabled,
    spaces: [{ id: 'passage', station, tree: routeTree(tagNetwork(station)) }] } });
  assert.equal(message.type, 'ready', message.message);
  return (pixels, at, observations = {}) => {
    context.onmessage({ data: { type: 'frame', rgba: pixels.buffer, w: width, h: height,
      frameTimeMs: at, recordingSpaceId: 'passage', ...observations } });
    return message;
  };
}

function stripeError(guide) {
  // Back-project overlay vertices through the independent renderer into ground metres.
  const offsets = [];
  for (const [u, v] of guide.flat()) {
    const [dx, dy, dz] = ray(u, v), depth = -cameraHeight / dz;
    if (dy * depth > 1 && dy * depth < 3.8) offsets.push(Math.abs(dx * depth));
  }
  assert.ok(offsets.length);
  return offsets.reduce((a, b) => a + b, 0) / offsets.length;
}

test('corridor pixels straighten the displayed tag and floor guidance while retaining the measured pose', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const track = worker(cv, .32), disabled = worker(cv, .32, false);
  const tagged = draw(cv, .32, true), floor = draw(cv, .32, true, false);
  const control = disabled(tagged, 0).fix;
  const early = track(tagged, 0);
  assert.equal(early.corridorHeading, undefined);
  let result;
  for (let i = 1; i <= 10; i++) result = track(tagged, i * 210);
  const raw = Math.atan2(result.fix.cameraToWorld[2], result.fix.cameraToWorld[6]) / radians;
  assert.ok(Math.abs(raw - trueHeading) > 5);
  assert.ok(Math.abs(raw + result.corridorHeading.yawDeg - trueHeading) < 1.5);
  assert.deepEqual(Array.from(result.recording.fix.cameraToWorld), Array.from(control.cameraToWorld));
  assert.ok(stripeError(result.fix.guide) < stripeError(control.guide) / 2);

  const later = track(floor, 2310, { floorAnchor: { spaceId: 'passage', timeMs: 2100 } });
  assert.equal(later.fix, null);
  assert.ok(later.floorMotion && later.corridorHeading);
  assert.ok(stripeError(later.floorMotion.guide) < stripeError(control.guide) / 2);

  const walking = worker(cv, .32);
  const anchor = walking(tagged, 0); // Only one frame: no accepted corridor correction yet.
  const m = anchor.fix.cameraToWorld;
  const inertial = { spaceId: 'passage', point: [0, 0], headingDeg: raw, up: [m[8], m[9], m[10]] };
  let observation;
  for (let i = 1; i <= 10; i++) {
    observation = walking(floor, i * 210, { corridorCamera: inertial, knownRoute: anchor.routeRevision });
    assert.equal(observation.fix, null);
    assert.equal(observation.floorMotion, undefined);
    assert.equal(observation.recording.fix, null);
  }
  assert.ok(Math.abs(raw + observation.corridorHeading.yawDeg - trueHeading) < 1.5);

  const bend = worker(cv, .32, true, [[0, -15], [0, 1.5], [8, 1.5]]);
  for (let i = 0; i < 5; i++) {
    const nearCorner = bend(tagged, i * 210);
    assert.ok(nearCorner.fix);
    assert.equal(nearCorner.corridorHeading, undefined);
  }
});

test('a large AprilTag alone cannot supply corridor evidence', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const track = worker(cv, 1.05), marker = draw(cv, 1.05, false);
  for (let i = 0; i < 10; i++) {
    const frame = track(marker, i * 210);
    assert.ok(frame.fix);
    assert.equal(frame.corridorHeading, undefined);
  }
});
