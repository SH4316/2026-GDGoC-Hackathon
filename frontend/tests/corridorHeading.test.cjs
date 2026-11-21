const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../public/ar/corridor-heading.js'), 'utf8');
const observe = runInNewContext(source + '\nobserveCorridorHeading');
const rad = Math.PI / 180;
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);

// Render straight world-space rails into a calibrated, pitched and rolled camera.
// The detector receives only pixels, intrinsics, camera up and a coarse prior.
function hallway(yaw, pitch, roll, width = 240, height = 180) {
  const gray = new Uint8Array(width * height).fill(205);
  const intr = [.84 * width, .9 * width, .47 * width, .52 * height];
  const s = Math.sin(yaw * rad), c = Math.cos(yaw * rad);
  const cp = Math.cos(pitch * rad), sp = Math.sin(pitch * rad);
  const cr = Math.cos(roll * rad), sr = Math.sin(roll * rad);
  const forward = [s*cp, c*cp, sp], right = [c, -s, 0], down = [s*sp, c*sp, -cp];
  const u = right.map((n, i) => n*cr + down[i]*sr);
  const v = down.map((n, i) => n*cr - right[i]*sr);
  const up = [u[2], v[2], forward[2]];
  function line(a, b) {
    a = [dot(u, a), dot(v, a), dot(forward, a)];
    b = [dot(u, b), dot(v, b), dot(forward, b)];
    if (a[2] < .1 && b[2] < .1) return;
    if (b[2] < a[2]) [a, b] = [b, a];
    if (a[2] < .1) {
      const t = (.1-a[2])/(b[2]-a[2]);
      a = a.map((n, i) => n + (b[i]-n)*t);
    }
    const project = ([x, y, z]) => [intr[0]*x/z + intr[2], intr[1]*y/z + intr[3]];
    const [x0, y0] = project(a), [x1, y1] = project(b);
    const dx = x1-x0, dy = y1-y0, length2 = dx*dx+dy*dy;
    const left = Math.max(0, Math.floor(Math.min(x0, x1) - 2));
    const right = Math.min(width-1, Math.ceil(Math.max(x0, x1) + 2));
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - 2));
    const bottom = Math.min(height-1, Math.ceil(Math.max(y0, y1) + 2));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const t = Math.max(0, Math.min(1, ((x-x0)*dx + (y-y0)*dy) / length2));
        const distance = Math.hypot(x-x0-t*dx, y-y0-t*dy);
        const shade = 205 - 170 * Math.min(1, Math.max(0, 1.8-distance));
        gray[y*width+x] = Math.min(gray[y*width+x], shade);
      }
    }
  }
  function rails(bearing, floorOnly = false, single = false) {
    const x = Math.sin(bearing*rad), y = Math.cos(bearing*rad);
    for (const offset of single ? [-1.6] : [-1.6, 1.4]) {
      for (const z of (floorOnly || single) ? [-1.4] : [-1.4, -.65, .9, 1.4]) {
        const point = t => [t*x + offset*y, t*y - offset*x, z];
        line(point(.12), point(28));
      }
    }
  }
  return { gray, rails, line, measure: (expected, excludedRects) =>
    observe(gray, width, height, intr, up, expected, excludedRects) };
}

test('grayscale corridor observations retain the signed relative yaw with tilt, roll and reverse travel', () => {
  for (const [axis, yaw, pitch, roll] of [[0,-9,0,0], [0,14,-18,12], [0,-7,-36,-14], [180,171,-12,0]]) {
    const image = hallway(yaw, pitch, roll);
    image.rails(axis, pitch < -30);
    const expected = axis - yaw;
    const angle = image.measure(expected + 6);
    assert.ok(angle !== null && Math.abs(angle - expected) < 2, JSON.stringify({axis,yaw,pitch,roll,angle}));
  }
});

test('rotated and portrait frames retain their signed bearing, a near-vertical lens has no observation', () => {
  for (const [width, height, roll] of [[180, 240, 14], [240, 180, 90]]) {
    const scene = hallway(-9, -15, roll, width, height);
    scene.rails(0);
    const bearing = scene.measure(14);
    assert.ok(bearing !== null && Math.abs(bearing-9) < 2);
  }
  const steep = hallway(-9, -63, 6);
  steep.rails(0);
  assert.equal(steep.measure(14), null);
});

test('a blank wall, a single rail and front-facing door frames cannot settle a corridor bearing', () => {
  const blank = hallway(0,-7,0);
  assert.equal(blank.measure(0), null);
  const single = hallway(0,-10,0);
  single.rails(0, false, true);
  assert.equal(single.measure(0), null);
  for (const x of [-1.5, -.5, .5, 1.5]) blank.line([x, 4, -1.4], [x, 4, 1.4]);
  for (const z of [-1.4, -.5, .6, 1.4]) blank.line([-1.5, 4, z], [1.5, 4, z]);
  assert.equal(blank.measure(0), null);
});

test('incompatible and competing axes do not steer the camera', () => {
  const image = hallway(0,-7,0);
  image.rails(0);
  assert.equal(image.measure(30), null);
  assert.equal(image.measure(180), null);
  const competing = hallway(0,-7,0);
  competing.rails(-12);
  competing.rails(12);
  assert.equal(competing.measure(0), null);
});

test('printed detail inside a tag cannot supply the observation but outside lines still can', () => {
  const width = 240, height = 180;
  const rect = [25, 20, 210, 150];
  const print = hallway(-6, -12, 0, width, height);
  print.rails(0);
  // A compact printed pattern has the same converging edges as this corridor
  // patch. Keep a few perimeter pixels to exercise the detector's support margin.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x < rect[0]-2 || x > rect[2]+2 || y < rect[1]-2 || y > rect[3]+2) print.gray[y*width+x] = 205;
  }
  assert.notEqual(print.measure(6), null);
  const original = print.gray.slice();
  assert.equal(print.measure(6, [rect]), null);
  assert.deepEqual(print.gray, original);

  const hall = hallway(-6, -12, 0);
  hall.rails(0);
  const smallRect = [100, 70, 138, 110];
  const bearing = hall.measure(6, [smallRect]);
  assert.ok(bearing !== null && Math.abs(bearing-6) < 2);
  assert.equal(hall.measure(6, []), hall.measure(6));
});
