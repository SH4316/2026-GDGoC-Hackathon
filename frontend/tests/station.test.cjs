const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', 'public');
const corridor = JSON.parse(readFileSync(join(__dirname, '../../backend/src/station.default.json')));
// Images for the original field kit use IDs 0–3 at these same four locations.
const station = { ...corridor, tags: corridor.tags.map((tag, id) => ({ ...tag, id })) };
const workerCode = readFileSync(join(root, 'ar/tracker.js'), 'utf8');
const W = 640, H = 800;

function startWorker(cv, config) {
  let reply;
  const self = { cv, postMessage(data) { reply = data; } };
  runInNewContext(workerCode, { self, importScripts() {}, console });
  self.onmessage({ data: { type: 'init', library: '', ...config } });
  assert.equal(reply.type, 'ready', reply.message);
  return (rgba, selection) => {
    self.onmessage({ data: { type: 'frame', w: W, h: H, rgba: rgba.buffer, ...selection } });
    assert.equal(reply.type, 'frame');
    return reply;
  };
}

function worker(cv, map) {
  const track = startWorker(cv, { station: map });
  return (rgba, verifyDetections) => {
    const reply = track(rgba);
    const c = map.camera.calibration;
    const focal = Math.hypot(W, H) / (2 * Math.tan(35 * Math.PI / 180));
    const expected = c ? [c.fx, c.fy, c.cx, c.cy] : [focal, focal, (W-1)/2, (H-1)/2];
    assert.deepEqual(Array.from(reply.intrinsics), expected, 'saved JPEG intrinsics, also during tag loss');
    verifyDetections?.(reply.detections);
    return reply.fix;
  };
}

function unit(v) { const n = Math.hypot(...v); return v.map(x => x/n); }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }

// Independent pinhole ray/floor intersection, with no use of the tracker's PnP or homography.
function floorAt(eye, look, cal) {
  const forward = unit(look.map((x,i) => x-eye[i]));
  const right = unit(cross(forward, [0,0,1])), down = cross(forward, right);
  const f = Math.hypot(W,H)/(2*Math.tan(35*Math.PI/180));
  const { fx, fy, cx, cy } = cal ?? {fx:f, fy:f, cx:(W-1)/2, cy:(H-1)/2};
  return (u, v) => {
    const a=(u-cx)/fx, b=(v-cy)/fy;
    const dz=forward[2]+right[2]*a+down[2]*b;
    if (dz >= 0) return [Infinity, Infinity];
    const t=-eye[2]/dz;
    return [eye[0]+t*(forward[0]+right[0]*a+down[0]*b), eye[1]+t*(forward[1]+right[1]*a+down[1]*b)];
  };
}

function scene(cv, floor, ids, textured = false, side = .16) {
  const dictionary = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  const markers = ids.map(([locationId, printedId]) => {
    const tag = station.tags.find(t => t.id === locationId);
    const bitmap = new cv.Mat();
    cv.generateImageMarker(dictionary, printedId, 8, bitmap, 1);
    const bits = Uint8Array.from(bitmap.data);
    bitmap.delete();
    const angle=tag.yawDeg*Math.PI/180;
    return { center: tag.center, c: Math.cos(angle), s: Math.sin(angle), bits };
  });
  dictionary.delete();
  const pixels = new Uint8Array(W*H*4);
  for (let y=0; y<H; y++) for (let x=0; x<W; x++) {
    const [wx,wy]=floor(x,y);
    let value=190;
    if (textured && Number.isFinite(wx) && Math.abs(wy) < 12) {
      const cell = Math.imul(Math.floor(wx * 12), 73856093) ^ Math.imul(Math.floor(wy * 12), 19349663);
      value = 130 + ((cell >>> 8) % 95);
    }
    for (const {center,c,s,bits} of markers) {
      const dx=wx-center[0], dy=wy-center[1];
      const u=(c*dx-s*dy)/side+.5, v=.5-(s*dx+c*dy)/side;
      if (u>=0 && u<1 && v>=0 && v<1) { value=bits[Math.floor(v*8)*8+Math.floor(u*8)]; break; }
    }
    const i=(y*W+x)*4;
    pixels[i]=pixels[i+1]=pixels[i+2]=value;
    pixels[i+3]=255;
  }
  return pixels;
}

function reflectedTag(pixels, strength, spread) {
  const reflected = pixels.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // A bright spot over tag 1 lifts the dark cells and reduces local contrast.
    const glare = Math.min(1, strength * Math.exp(-((x - 425)**2 + (y - 284)**2) / (2 * spread**2)));
    const i = (y * W + x) * 4;
    reflected[i] = reflected[i+1] = reflected[i+2] = Math.round(pixels[i] * (1 - glare) + 250 * glare);
  }
  return reflected;
}

function checkFix(fix, eye, floor, direction, principal = [(W-1)/2, (H-1)/2]) {
  assert.ok(fix?.arrow, 'visible route arrow');
  assert.ok(Math.hypot(...fix.position.map((x,i) => x-eye[i])) < .12, 'camera centre in measured metres');
  const m = fix.cameraToWorld;
  assert.deepEqual([m[3], m[7], m[11]], Array.from(fix.position));
  const distanceToFloor = -m[11]/m[10];
  const opticalAxisHit = [m[3] + distanceToFloor*m[2], m[7] + distanceToFloor*m[6]];
  const expectedHit = floor(...principal);
  assert.ok(Math.hypot(...opticalAxisHit.map((v,i) => v-expectedHit[i])) < .06, 'saved positive camera Z points into the scene');
  const tip = floor(...fix.arrow[4]), tail = floor(...fix.arrow[0]);
  assert.ok(tip[direction]-tail[direction] > .32, 'arrow points along the expected floor axis');
}

test('floor localization, route turn, tag loss and reacquisition', async () => {
  // The distribution exposes a thenable that resolves to itself.
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const locate = worker(cv, station), eye=[0,-.45,1.15], floor=floorAt(eye,[0,.62,0]);
  const straight=scene(cv,floor,[[0,0],[1,1],[2,2]]);
  const fix=locate(straight);
  checkFix(fix,eye,floor,1);
  assert.ok(fix.ids.length >= 2, 'multi-tag consensus');
  assert.equal(locate(scene(cv,floor,[]), seen => assert.equal(seen.length, 0)), null);
  const unknown = scene(cv,floor,[[1,42]]);
  const checkUnknown = seen => {
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 42);
    assert.equal(seen[0].registered, false);
    assert.equal(seen[0].image.length, 4, 'outline remains visible without a world pose');
  };
  assert.equal(locate(unknown, checkUnknown), null);
  assert.equal(worker(cv, { ...station, tags: [] })(unknown, checkUnknown), null);
  checkFix(locate(scene(cv,floor,[[1,1]])),eye,floor,1);

  const turnEye=[.03,1.47,1.10], turnFloor=floorAt(turnEye,[.46,2.15,0]);
  checkFix(locate(scene(cv,turnFloor,[[2,2],[3,3]])),turnEye,turnFloor,0);
  const arrival=floorAt([1.7,2,1.1],[1.05,2.2,0]);
  const destination=locate(scene(cv,arrival,[[3,3]]));
  assert.ok(destination?.position);
  assert.equal(destination.arrived, true);
  assert.equal(destination.arrow,null);

  const cal={width:W,height:H,fx:650,fy:685,cx:W/2+9,cy:H/2-7,distortion:[0,0,0,0,0]};
  const calibrated=worker(cv,{...station,camera:{calibration:cal}});
  const calibratedFloor=floorAt(eye,[0,.62,0],cal);
  checkFix(calibrated(scene(cv,calibratedFloor,[[0,0],[1,1]])),eye,calibratedFloor,1,[cal.cx,cal.cy]);
});

test('monitor reflection preserves a decodable tag and drops a fully obscured tag', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const locate = worker(cv, station);
  const eye = [0, -.45, 1.15], floor = floorAt(eye, [0, .62, 0]);
  const clean = scene(cv, floor, [[1, 1]]);
  const reflected = reflectedTag(clean, .93, 38);
  const obscured = reflectedTag(clean, 3, 38);

  checkFix(locate(clean), eye, floor, 1);
  const checkRegistered = seen => assert.deepEqual(Array.from(seen, tag => tag.id), [1]);
  checkFix(locate(reflected, checkRegistered), eye, floor, 1);
  assert.equal(locate(obscured, seen => assert.equal(seen.length, 0)), null);
  checkFix(locate(reflectedTag(clean, .97, 80), checkRegistered), eye, floor, 1);

  const unknown = reflectedTag(scene(cv, floor, [[1, 42]]), .93, 38);
  assert.equal(locate(unknown, seen => {
    assert.deepEqual(Array.from(seen, tag => tag.id), [42]);
    assert.equal(seen[0].registered, false);
  }), null);

  const mixed = reflectedTag(scene(cv, floor, [[0, 42], [1, 1]]), .93, 38);
  checkFix(locate(mixed, seen => {
    assert.deepEqual(Array.from(seen, tag => tag.id).sort((a, b) => a - b), [1, 42]);
  }), eye, floor, 1);
});

test('a wall-mounted tag localizes in the saved surface frame without a walking route', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const eye = [0, -.45, 1.15], floor = floorAt(eye, [0, .62, 0]);
  const image = scene(cv, floor, [[1, 1]]);
  // Rotate the whole test scene 90° around X, then translate by (0, 2, 1).
  const surface = { right: [1, 0, 0], up: [0, 0, 1], heightM: 2 };
  const wall = { ...station, route: [], tags: [{ id: 1, center: [.25, 2], yawDeg: 0, surface }] };
  const fix = worker(cv, wall)(image);
  assert.ok(fix);
  const expected = [eye[0], 2 - eye[2], 1 + eye[1]];
  assert.ok(Math.hypot(...fix.position.map((x, i) => x - expected[i])) < .12);
  assert.equal(fix.arrow, null);
  assert.equal(fix.arrived, false);
});

test('tag IDs resolve the space and its local coordinates, including shared IDs and a pinned space', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const east = { ...station, route: [], tags: station.tags.slice(0, 2).map(({ id, center, yawDeg }) => ({
    id: id === 1 ? 41 : id, center: [center[0] + 10, center[1]], yawDeg,
  })) };
  const track = startWorker(cv, { spaces: [{ id: 'default', station }, { id: 'east', station: east }] });
  const eye = [0, -.45, 1.15], floor = floorAt(eye, [0, .62, 0]);
  const frame = (tags, selection) => track(scene(cv, floor, tags), selection);
  const shared = frame([[0, 0]]);
  assert.deepEqual(Array.from(shared.candidates).sort(), ['default', 'east']);
  assert.equal(shared.fix, null);
  for (const tags of [[[1, 41]], [[0, 0], [1, 41]]]) {
    const located = frame(tags);
    assert.equal(located.spaceId, 'east');
    assert.ok(Math.abs(located.fix.position[0] - 10) < .12);
    assert.equal(located.fix.arrow, null);
  }
  const conflicting = frame([[0, 1], [1, 41]]);
  assert.equal(conflicting.fix, null);
  assert.deepEqual(Array.from(conflicting.candidates), []);
  assert.equal(frame([[0, 0]]).fix, null);
  assert.equal(frame([[1, 42]]).fix, null);
  assert.equal(frame([]).fix, null);
  const reacquired = frame([[1, 1]]);
  assert.equal(reacquired.spaceId, 'default');
  checkFix(reacquired.fix, eye, floor, 1);
  assert.ok(Math.abs(frame([[0, 0]], { preferredSpace: 'east' }).fix.position[0] - 10) < .12);
  assert.equal(frame([[1, 1]], { preferredSpace: 'east' }).spaceId, 'default');
  assert.equal(frame([[1, 1]], { pinnedSpace: 'east' }).fix, null);
});

test('field recording keeps its own calibration while live fixes follow the same tags as guidance', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const other = { ...station, tags: [{ ...station.tags[1], id: 42 }] };
  const calibration = { width: W, height: H, fx: 650, fy: 685, cx: W/2, cy: H/2, distortion: [0,0,0,0,0] };
  const home = { ...station, camera: { calibration } };
  const config = { spaces: [{ id: 'home', station: home }, { id: 'other', station: other }] };
  const field = startWorker(cv, config), guide = startWorker(cv, config);
  const eye = [0, -.45, 1.15], look = [0, .62, 0];
  for (const id of [1, 42, null, 1]) {
    const floor = floorAt(eye, look, id === 1 ? calibration : undefined);
    const pixels = scene(cv, floor, id === null ? [] : [[1, id]]);
    const live = guide(pixels), recorded = field(pixels, { recordingSpaceId: 'home' });
    assert.equal(recorded.spaceId, live.spaceId);
    assert.deepEqual(recorded.fix?.position && Array.from(recorded.fix.position), live.fix?.position && Array.from(live.fix.position));
    assert.equal(recorded.recording.spaceId, 'home');
    assert.deepEqual(Array.from(recorded.recording.intrinsics), [650, 685, W/2, H/2]);
    if (id === 1) assert.deepEqual(Array.from(recorded.recording.fix.ids), [1]);
    else assert.equal(recorded.recording.fix, null);
    if (id === 42) assert.deepEqual(Array.from(recorded.fix.ids), [42]);
  }
});

test('one printed ID selects the correct layout after reassigning the corridor tags', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const track = startWorker(cv, { spaces: [
    { id: 'default', station: corridor }, { id: 'abc', station: { ...station, tags: station.tags.slice(0, 3) } },
  ] });
  const floor = floorAt([0, -.45, 1.15], [0, .62, 0]);
  for (const [id, space] of [[0, 'abc'], [1, 'abc'], [2, 'abc'], [3, 'default'], [4, 'default'], [5, 'default'], [6, 'default']]) {
    const reply = track(scene(cv, floor, [[1, id]]));
    assert.equal(reply.spaceId, space);
    assert.deepEqual(Array.from(reply.fix.ids), [id]);
  }
  // The ID remains legible at this distance, but its corners are too close for a pose.
  const distant = floorAt([.25, -.45, 5], [.25, 1, 0]);
  const partial = track(scene(cv, distant, [[1, 0]]));
  assert.equal(partial.fix, null);
  assert.deepEqual({ ...partial.referenceTag }, { spaceId: 'abc', id: 0 });
  assert.equal(track(scene(cv, distant, [[1, 42]])).referenceTag, undefined);
  assert.equal(track(scene(cv, distant, [[1, 0]]), { pinnedSpace: 'default' }).referenceTag, undefined);
});

test('portrait rear camera tilted down tracks forward, lateral and backward walking between AprilTags', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const { IndoorTracking } = await import('../src/ar/indoorTracking.ts');
  const side = .28;
  const pixels = (x, y, yaw, tagged) => scene(cv, floorAt([x, y, 1.35],
    [x + Math.sin(yaw), y + Math.cos(yaw), 1.35 - Math.tan(23 * Math.PI / 180)]),
    tagged ? [[1, 1], [2, 2]] : [], true, side);
  for (const [dx, dy] of [[0, .07], [.07, 0], [0, -.07], [0, 0]]) {
    const worker = startWorker(cv, { station: { ...station, tagSideM: side } });
    const tracking = new IndoorTracking();
    const start = worker(pixels(0, -.85, 0, true), { frameTimeMs: 0 }).fix;
    assert.ok(start, 'camera localized from the printed tag');
    tracking.correct('default', start, 0, 0);
    const frames = dy > 0 ? 50 : 5;
    for (let frame = 1; frame <= frames; frame++) {
      const time = frame * 120;
      for (let t = time - 100; t <= time; t += 20) {
        // A constant walking velocity is unobservable from acceleration alone.
        tracking.motion({ timeMs: t, acceleration: [-.45, 0, .65], rotationRate: null });
      }
      const reply = worker(pixels(frame * dx, -.85 + frame * dy, frame * .008, false),
        { frameTimeMs: time, floorAnchor: tracking.floorAnchor(time) });
      assert.equal(reply.fix, null);
      assert.ok(reply.floorMotion, 'matched floor points in the tagless frame');
      assert.equal(tracking.correct('default', reply.floorMotion, time, 0, 'floor'), true);
    }
    const endMs = frames * 120;
    const pose = tracking.pose(endMs, false);
    assert.equal(pose.source, 'motion');
    assert.ok(Math.hypot(pose.point[0] - start.position[0] - frames * dx,
      pose.point[1] - start.position[1] - frames * dy) < .08, 'floor displacement must follow the actual walk');
    const blank = scene(cv, floorAt([0, -.85, 1.35], [0, 1, 0]), []);
    assert.equal(worker(blank, { frameTimeMs: endMs + 120, floorAnchor: tracking.floorAnchor(endMs + 120) }).floorMotion, undefined);
    assert.equal(worker(pixels(0, -.85, 0, false), { frameTimeMs: endMs + 240 }).floorMotion, undefined);
  }
});

test('floor matching bridges a brief occlusion, and a broken visual track needs a new tag', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const worker = startWorker(cv, { station: { ...station, tagSideM: .28 } });
  const floor = floorAt([0, -.85, 1.35], [0, .15, 1.35 - Math.tan(23 * Math.PI / 180)]);
  const tag = scene(cv, floor, [[1,1], [2,2]], true, .28);
  const texture = scene(cv, floor, [], true), blank = scene(cv, floor, []);
  const at = (pixels, time, reference) => worker(pixels, { frameTimeMs: time,
    floorAnchor: { spaceId: 'default', timeMs: reference } });
  assert.ok(at(tag, 0).fix);
  assert.equal(at(blank, 120, 0).floorMotion, undefined);
  assert.equal(at(texture, 240, 0).floorMotion.referenceTimeMs, 0);
  assert.equal(at(texture, 360, 0).floorMotion, undefined, 'caller skipped the last observation');
  assert.equal(at(texture, 480, 240).floorMotion.referenceTimeMs, 240);
  for (let time = 600; time <= 2400; time += 120) assert.equal(at(blank, time, 480).floorMotion, undefined);
  for (const time of [2520, 2640, 2760]) assert.equal(at(texture, time, 480).floorMotion, undefined);
  assert.ok(at(tag, 2880).fix);
  assert.equal(at(texture, 3000, 2880).floorMotion.referenceTimeMs, 2880);
  const legacy = worker(texture, { frameTimeMs: 3120, motionCamera: { spaceId: 'default' } });
  assert.equal(legacy.floorMotion.referenceTimeMs, 3000);
});

test('a single implausible tag jump is held, a repeated relocation or a new sighting after a gap is accepted', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const worker = startWorker(cv, { station });
  const frame = x => scene(cv, floorAt([x, -.45, 1.15], [.25, .85, 0]), [[1, 1]]);
  const center = frame(0), away = frame(1.15);
  const at = (pixels, frameTimeMs) => worker(pixels, { frameTimeMs });
  assert.ok(at(center, 0).fix);
  const glitch = at(away, 100);
  assert.equal(glitch.fix, null);
  assert.equal(glitch.referenceTag.id, 1);
  assert.ok(at(center, 200).fix);
  assert.equal(at(away, 300).fix, null);
  assert.ok(at(away, 400).fix);
  assert.ok(at(center, 2000).fix);
});
