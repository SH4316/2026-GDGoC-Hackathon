const { readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { createContext, runInContext } = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', 'public');
const corridor = JSON.parse(readFileSync(join(__dirname, '../../backend/src/station.default.json')));
// Images for the original field kit use IDs 0–3 at these same four locations.
const station = { ...corridor, tags: corridor.tags.map((tag, id) => ({ ...tag, id })) };
const workerCode = readFileSync(join(root, 'ar/tracker.js'), 'utf8');
const { tagNetwork, routeTree, defaultWalk } = require('../src/ar/tagRouting.ts');
const W = 640, H = 800;

function startWorker(cv, config) {
  let reply;
  const self = createContext({ cv, console, postMessage(data) { reply = data; } });
  self.self = self;
  self.importScripts = name => {
    if (name) runInContext(readFileSync(join(root, 'ar', basename(name).split('?')[0]), 'utf8'), self);
  };
  runInContext(workerCode, self);
  const withTrees = layouts => layouts.map(space => ({
    ...space, tree: routeTree(tagNetwork(space.station)),
  }));
  const spaces = withTrees(config.spaces ?? [{ id: 'default', station: config.station }]);
  self.onmessage({ data: { type: 'init', library: '', spaces } });
  assert.equal(reply.type, 'ready', reply.message);
  return (rgba, selection) => {
    if (selection?.layouts) self.onmessage({ data: { type: 'layouts', spaces: withTrees(selection.layouts) } });
    if (selection?.destination) self.onmessage({ data: { type: 'destination', ...selection.destination } });
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

function scene(cv, floor, ids, textured = false, side = .16, placements = station.tags) {
  const dictionary = cv.getPredefinedDictionary(cv.DICT_APRILTAG_36h11);
  const markers = ids.map(([locationId, printedId]) => {
    const tag = placements.find(t => t.id === locationId);
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
  const stripe = fix.guide.flat().filter(([u,v]) => u >= 0 && u < W && v >= 0 && v < H).map(p => floor(...p));
  assert.ok(stripe.some(([x,y]) => Math.abs(x - .045) < .025 && y > .1 && y < 1.8));
  assert.ok(stripe.some(([x,y]) => Math.abs(x + .045) < .025 && y > .1 && y < 1.8));
  assert.equal(fix.maneuver.kind, 'right');
  assert.equal(fix.maneuver.stage, 'soon', 'the arrow follows the approach while speech previews the turn');
  const reversed = worker(cv, { ...station, route: [[0, 2], [0, -2]] })(straight);
  assert.equal(reversed.maneuver.kind, 'realign');
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
  const cornerImage = scene(cv,turnFloor,[[2,2],[3,3]]);
  const rightTurn = locate(cornerImage);
  checkFix(rightTurn,turnEye,turnFloor,0);
  const cornerStripe = rightTurn.guide.flat().map(p => turnFloor(...p));
  assert.ok(cornerStripe.some(([x,y]) => Math.abs(x) < .07 && y < 1.8), 'incoming leg on the floor');
  assert.ok(cornerStripe.some(([x,y]) => x > .4 && Math.abs(y - 2) < .07), 'outgoing leg turns with the route');
  assert.equal(rightTurn.maneuver.kind, 'right');
  const leftStation = { ...station, route: [[0,0],[0,2],[-1.75,2]],
    stationLinks: [{ name: '초지', line: '서해선', code: 'S26', routeEndpoint: 'end' }] };
  const leftTurn = worker(cv, leftStation)(cornerImage);
  const { indoorCue } = await import('../src/ar/indoorGuidance.ts');
  const layout = { id: 'transfer', station: leftStation };
  assert.equal(indoorCue(layout, leftTurn.maneuver, false).text, '여기서 좌회전하세요. 서해선 환승 통로입니다.');
  assert.equal(indoorCue(layout, rightTurn.maneuver, false).text, '여기서 우회전하세요. 서해선 환승 통로입니다.');
  const arrival=floorAt([1.7,2,1.1],[1.05,2.2,0]);
  const destination=locate(scene(cv,arrival,[[3,3]]));
  assert.ok(destination?.position);
  assert.equal(destination.arrived, true);
  assert.equal(indoorCue(layout, destination.maneuver, destination.arrived).text, '서해선 환승 위치에 도착했습니다.');
  assert.equal(indoorCue(layout, destination.maneuver, destination.arrived).spokenText, '목적지에 도착하였습니다.');
  assert.equal(destination.guide.length, 0);
  assert.equal(destination.arrow,null);

  const cal={width:W,height:H,fx:650,fy:685,cx:W/2+9,cy:H/2-7,distortion:[0,0,0,0,0]};
  const calibrated=worker(cv,{...station,camera:{calibration:cal}});
  const calibratedFloor=floorAt(eye,[0,.62,0],cal);
  checkFix(calibrated(scene(cv,calibratedFloor,[[0,0],[1,1]])),eye,calibratedFloor,1,[cal.cx,cal.cy]);
});

test('two oblique floor tags support a joint pose only when every corner agrees', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const eye = [0, 1.47, 1.1], floor = floorAt(eye, [0, .87, 0]);
  const pixels = scene(cv, floor, [[0, 4], [1, 5]]);
  const track = startWorker(cv, { station: corridor });
  const frame = track(pixels);
  assert.deepEqual(Array.from(frame.detections, tag => tag.id).sort(), [4, 5]);
  assert.ok(frame.fix, 'both decoded tags agree on a pose');
  assert.deepEqual(Array.from(frame.fix.ids).sort(), [4, 5]);
  assert.ok(frame.fix.rmsPx < 1);
  assert.ok(Math.hypot(...frame.fix.position.map((value, i) => value - eye[i])) < .02);

  // A 5 cm survey error leaves the mean below 2.5 px but one corner over 3 px.
  const shifted = { ...corridor, tags: corridor.tags.map(tag => tag.id === 4
    ? { ...tag, center: [tag.center[0] + .05, tag.center[1]] } : tag) };
  assert.equal(startWorker(cv, { station: shifted })(pixels).fix, null);
});

test('the displayed stripe follows the measured radial distortion of a calibrated lens', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const cal = { width: W, height: H, fx: 650, fy: 685, cx: W/2+9, cy: H/2-7, distortion: [.22,0,0,0] };
  const eye = [0, -.45, 1.15], pinhole = floorAt(eye, [0,.62,0], cal);
  function floor(u, v) {
    const dx = (u-cal.cx)/cal.fx, dy = (v-cal.cy)/cal.fy;
    let x = dx, y = dy;
    for (let i = 0; i < 8; i++) {
      const radial = 1 + cal.distortion[0]*(x*x+y*y);
      x = dx/radial; y = dy/radial;
    }
    return pinhole(cal.cx+x*cal.fx, cal.cy+y*cal.fy);
  }
  const track = startWorker(cv, { station: { ...station, camera: { calibration: cal } } });
  const pixels = scene(cv, floor, [[0,0], [1,1], [2,2]]);
  const { fix } = track(pixels, { frameTimeMs: 0 });
  checkFix(fix, eye, floor, 1, [cal.cx, cal.cy]);
  const tip = fix.guide.flat().filter(([u, v]) => u > 0 && u < W && v > 0 && v < H)
    .map(p => floor(...p)).filter(([x]) => x > .6);
  assert.ok(tip.length > 0 && tip.every(([, y]) => Math.abs(y-2) < .07), 'the outgoing leg stays on the surveyed bend');
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
  assert.equal(fix.guide.length, 0);
  assert.equal(fix.arrived, false);
});

function wallAt(height, wallY, pitch) {
  const focal = Math.hypot(W, H) / (2 * Math.tan(35 * Math.PI / 180));
  return (u, v) => {
    const down = (v - (H - 1)/2) / focal;
    const t = wallY / (Math.cos(pitch) - down * Math.sin(pitch));
    return [t * (u - (W - 1)/2) / focal, height - t * (Math.sin(pitch) + down * Math.cos(pitch))];
  };
}

test('a textured wall locates the camera and its active route without supporting floor pixels', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const height = 1.35, wallY = .9;
  const onWall = wallAt(height, wallY, 20 * Math.PI / 180);
  assert.ok(onWall(0, H-1)[1] > 0, 'even the bottom camera ray hits the vertical wall before the floor');
  const id = 7, side = .24, wallLocation = [.16, 1.05];
  const tag = { id, center: [wallLocation[0], wallY], yawDeg: 0, walkPoint: [0, wallY],
    surface: { right: [1,0,0], up: [0,0,1], heightM: wallLocation[1] } };
  const hall = { tagSideM: side, camera: station.camera, route: [[0, -.2], [0, 6]], tags: [tag] };
  const track = startWorker(cv, { station: hall });
  const wall = tagged => scene(cv, onWall, tagged ? [[id, id]] : [], true, side,
    [{ id, center: wallLocation, yawDeg: 0 }]);
  const sight = track(wall(true), { frameTimeMs: 0 });
  assert.deepEqual(Array.from(sight.fix.ids), [id]);
  assert.ok(Math.hypot(sight.fix.position[0], sight.fix.position[1], sight.fix.position[2] - height) < .08);
  assert.deepEqual(Array.from(sight.route.at(-1)), hall.route.at(-1));
  assert.equal(sight.fix.arrived, false);
  assert.equal(sight.fix.routeBearing.direction, 'forward');
  assert.equal(sight.fix.floorVisible, false);
  assert.equal(sight.fix.arrow, null);
  assert.equal(sight.fix.guide.length, 0);
  const hidden = track(wall(false), { frameTimeMs: 120, knownRoute: sight.routeRevision,
    floorAnchor: { spaceId: 'default', timeMs: 0 },
    guideCamera: { spaceId: 'default', referenceTimeMs: 0, cameraToWorld: sight.fix.cameraToWorld } });
  assert.equal(hidden.fix, null);
  assert.equal(hidden.floorMotion, undefined, 'wall texture cannot establish a floor track');
  assert.equal(hidden.motionGuide.screenDirection, 'forward');
  assert.equal(hidden.motionGuide.arrow, null);
  assert.equal(hidden.motionGuide.guide.length, 0);
});

// Count camera pixels inside the emitted polygons, including a face that crosses the sample
// area with every vertex outside of it.
function inkIn(view, left, top, right, bottom) {
  const faces = view.arrow ? [...view.guide, view.arrow] : view.guide;
  function contains(face, x, y) {
    let inside = false;
    for (let i = 0, j = face.length - 1; i < face.length; j = i++) {
      const [ax, ay] = face[i], [bx, by] = face[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  }
  let covered = 0;
  for (let y = top; y < bottom; y += 3) for (let x = left; x < right; x += 3) {
    if (faces.some(face => contains(face, x, y))) covered++;
  }
  return covered;
}

test('a wall-tag pose retains independently tracked floor when both surfaces occupy the camera', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const height = 1.25, wallY = 2.2, pitch = 35 * Math.PI / 180, side = .24;
  const onFloor = floorAt([0, 0, height], [0, 1, height - Math.tan(pitch)]);
  const onWall = wallAt(height, wallY, pitch);
  let firstFloorRow = 0;
  while (firstFloorRow < H && onWall(0, firstFloorRow)[1] > 0) firstFloorRow++;
  const floorTag = { id: 4, center: [-.26, 1.1], yawDeg: 0 };
  const wallTag = { id: 7, center: [.34, wallY], yawDeg: 0,
    surface: { right: [1,0,0], up: [0,0,1], heightM: .5 } };
  const hall = { tagSideM: side, camera: station.camera, route: [[0, -2], [0, 6]], tags: [floorTag, wallTag] };
  function frame(floorTagVisible, wallTagVisible) {
    const image = scene(cv, onFloor, floorTagVisible ? [[4,4]] : [], true, side, [floorTag]);
    const wall = scene(cv, onWall, wallTagVisible ? [[7,7]] : [], true, side,
      [{ id: 7, center: [wallTag.center[0], wallTag.surface.heightM], yawDeg: 0 }]);
    for (let y = 0; y < firstFloorRow; y++) {
      for (let x = 0; x < W; x++) {
        const i = 4 * (y * W + x), light = wall[i];
        const tile = light !== 0 && light !== 255;
        image[i] = light - (tile ? 32 : 0);
        image[i+1] = light;
        image[i+2] = light + (tile ? 24 : 0);
      }
    }
    return image;
  }
  const track = startWorker(cv, { station: hall });
  const anchor = track(frame(true, false), { frameTimeMs: 100 });
  assert.deepEqual(Array.from(anchor.fix.ids), [4]);
  assert.ok(anchor.fix.arrow && inkIn(anchor.fix, 285, 400, 355, 710) > 0);
  const wallOnly = frame(false, true);
  const sight = track(wallOnly, { frameTimeMs: 220, floorAnchor: { spaceId: 'default', timeMs: 100 } });
  assert.deepEqual(Array.from(sight.fix.ids), [7]);
  assert.equal(sight.fix.arrived, false);
  assert.ok(sight.fix.floorVisible && inkIn(sight.fix, 285, 400, 355, 710) > 0,
    'the previous tagged floor still matches on the lower part of the image');
  assert.equal(inkIn(sight.fix, 0, 0, W, firstFloorRow), 0, 'no stripe or arrow appears on the wall above the floor');
  const noTags = track(frame(false, false), { frameTimeMs: 340, floorAnchor: { spaceId: 'default', timeMs: 220 } });
  assert.equal(noTags.fix, null);
  assert.ok(noTags.floorMotion?.floorVisible, 'the mixed wall-and-floor frame supports the next optical observation');
  const cold = startWorker(cv, { station: hall })(wallOnly, { frameTimeMs: 100 }).fix;
  assert.equal(cold.routeBearing.direction, 'forward');
  assert.equal(cold.floorVisible, false, 'the wall tag on its own cannot establish the floor material');
});

test('a person crossing the route masks its covered pixels through tag fixes and tagless optical tracking', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const track = startWorker(cv, { station });
  const floor = floorAt([0, -.45, 1.15], [0, .62, 0]);
  const clean = scene(cv, floor, [[0,0], [1,1]], true), tagless = scene(cv, floor, [], true);
  function personOver(pixels) {
    const result = pixels.slice();
    for (let y = 323; y < 720; y++) for (let x = 245; x < 395; x++) {
      const head = ((x - 320)/35)**2 + ((y - 370)/46)**2 < 1;
      const jacket = y >= 405 && y < 605;
      const leg = y >= 605 && (Math.abs(x - 285) < 21 || Math.abs(x - 355) < 21);
      if (!head && !jacket && !leg) continue;
      const i = 4 * (y * W + x);
      const weave = ((x >> 3) ^ (y >> 3)) & 1 ? 24 : 0;
      result[i] = head ? 166 : 52 + weave;
      result[i+1] = head ? 110 : 33 + weave;
      result[i+2] = head ? 88 : 77 + weave;
    }
    return result;
  }
  const jacketInk = view => inkIn(view, 247, 407, 393, 603);
  const openFloorInk = view => inkIn(view, 290, 230, 350, 305);
  const clear = track(clean, { frameTimeMs: 0 }).fix;
  assert.ok(clear.arrow && jacketInk(clear) > 0 && openFloorInk(clear) > 0,
    'the unobstructed stripe and arrow cover both sample areas');
  function checkOcclusion(view) {
    assert.ok(openFloorInk(view) > 0, 'the visible route above the person still has a stripe');
    assert.equal(jacketInk(view), 0, 'the guide and arrow leave the opaque jacket clear');
    assert.equal(inkIn(view, 301, 350, 339, 389), 0, 'the stripe does not cross the head above the jacket');
    assert.equal(inkIn(view, 269, 615, 301, 713) + inkIn(view, 339, 615, 371, 713), 0,
      'the arrow does not cross either leg below the jacket');
  }
  const taggedPerson = personOver(clean), taglessPerson = personOver(tagless);
  for (const time of [120, 240, 360, 480]) {
    const frame = track(taggedPerson, { frameTimeMs: time });
    assert.ok(frame.fix.ids.includes(1), 'the floor tag beside the route remains readable');
    checkOcclusion(frame.fix);
  }
  for (const time of [600, 720, 840, 960]) {
    const frame = track(taglessPerson, { frameTimeMs: time, floorAnchor: { spaceId: 'default', timeMs: time - 120 } });
    assert.equal(frame.fix, null);
    assert.ok(frame.floorMotion, 'uncovered floor texture still provides a pose');
    checkOcclusion(frame.floorMotion);
  }
  const clearAgain = track(clean, { frameTimeMs: 1080 }).fix;
  assert.ok(clearAgain.arrow && jacketInk(clearAgain) > 0, 'the arrow returns when the person leaves');
  const entering = track(taglessPerson, { frameTimeMs: 1200, floorAnchor: { spaceId: 'default', timeMs: 1080 } });
  assert.equal(entering.fix, null);
  assert.ok(entering.floorMotion, 'the person can enter on the first frame after the tags disappear');
  checkOcclusion(entering.floorMotion);
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
  const matched = at(texture, 240, 0).floorMotion;
  assert.equal(matched.referenceTimeMs, 0);
  assert.ok(matched.guide.length > 0, 'a validated floor match reprojects the stripe without a tag');
  assert.ok(matched.arrow?.length, 'the floor pose also projects a direction arrow without a tag');
  assert.equal(matched.maneuver.stage, 'soon');
  assert.equal(matched.arrived, undefined);
  assert.equal(at(texture, 360, 0).floorMotion, undefined, 'caller skipped the last observation');
  assert.equal(at(texture, 480, 240).floorMotion.referenceTimeMs, 240);
  for (let time = 600; time <= 2400; time += 120) assert.equal(at(blank, time, 480).floorMotion, undefined);
  for (const time of [2520, 2640, 2760]) assert.equal(at(texture, time, 480).floorMotion, undefined);
  assert.ok(at(tag, 2880).fix);
  assert.equal(at(texture, 3000, 2880).floorMotion.referenceTimeMs, 2880);
  const legacy = worker(texture, { frameTimeMs: 3120, motionCamera: { spaceId: 'default' } });
  assert.equal(legacy.floorMotion.referenceTimeMs, 3000);
  assert.ok(at(texture, 3136, 3120).floorMotion?.floorVisible, 'without a gyro every submitted textured frame can refresh the floor');
  assert.equal(at(blank, 3152, 3136).floorMotion, undefined);
  assert.equal(at(blank, 3168, 3136).pendingFloorSpace, 'default', 'unmatched floor texture still backs off');
});

test('after a floor fix a full wall leaves only the rotating gyro bearing until floor evidence returns', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const hall = { ...station, tagSideM: .3, route: [[0,-2], [0,8]], tags: [{ id: 4, center: [0,1.6], yawDeg: 0 }] };
  const worker = startWorker(cv, { station: hall }), eye = [0, 0, 1.3];
  const floor = floorAt(eye, [0,2,0]);
  const tag = scene(cv, floor, [[4,4]], true, .3, hall.tags);
  const texture = scene(cv, floor, [], true);
  const wall = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 4 * (y * W + x), course = Math.floor(y / 62);
    const shade = y % 62 < 3 || (x + course * 54) % 108 < 3 ? 92 : 157;
    wall[i] = shade; wall[i+1] = shade + 4; wall[i+2] = shade + 13; wall[i+3] = 255;
  }
  const sight = worker(tag, { frameTimeMs: 100 });
  assert.ok(sight.fix?.arrow);
  const knownRoute = sight.routeRevision;

  function camera(yaw, pitch = 33, position = eye) {
    const a = yaw * Math.PI/180, b = pitch * Math.PI/180;
    const right = [Math.cos(a), -Math.sin(a), 0];
    const lens = [Math.sin(a)*Math.cos(b), Math.cos(a)*Math.cos(b), -Math.sin(b)];
    const down = cross(lens, right);
    return { spaceId: 'default', referenceTimeMs: 100,
      cameraToWorld: [...position.flatMap((p,i) => [right[i], down[i], lens[i], p]), 0, 0, 0, 1] };
  }
  function at(frameTimeMs, guideCamera, pixels = wall, options = {}) {
    return worker(pixels, { frameTimeMs, knownRoute, guideCamera, recordingSpaceId: 'default', ...options });
  }
  function checkBearing(frame, degrees) {
    assert.equal(frame.motionGuide.floorVisible, false);
    assert.equal(frame.motionGuide.arrow, null);
    assert.equal(frame.motionGuide.guide.length, 0);
    assert.ok(Math.abs(frame.motionGuide.screenAngleDeg - degrees) < .001);
  }
  const first = at(145, camera(0), wall, { floorAnchor: { spaceId: 'default', timeMs: 100 } });
  assert.equal(first.floorMotion, undefined);
  assert.equal(first.pendingFloorSpace, undefined, 'the worker tried to confirm the floor on this frame');
  checkBearing(first, 0);
  const retry = at(170, camera(5), wall, { floorAnchor: { spaceId: 'default', timeMs: 100 } });
  assert.equal(retry.pendingFloorSpace, 'default');
  checkBearing(retry, -5);
  const measured = at(260, camera(155), texture, { floorAnchor: { spaceId: 'default', timeMs: 100 } });
  assert.ok(measured.floorMotion?.arrow);
  assert.equal(measured.motionGuide, undefined);
  const next = at(275, { ...camera(0), referenceTimeMs: 260 }, texture, { floorAnchor: { spaceId: 'default', timeMs: 260 } });
  assert.ok(next.floorMotion?.floorVisible, 'supported floor remains drawable on the next submitted frame with the gyro enabled');
  assert.equal(at(4000, camera(0)).motionGuide, undefined, 'a superseded visual reference cannot project');
  const anchored = (yaw, pitch, position) => ({ ...camera(yaw, pitch, position), referenceTimeMs: 275 });
  const small = at(4010, anchored(10));
  checkBearing(small, -10);
  const turned = at(12500, anchored(65));
  assert.equal(turned.motionGuide.screenDirection, 'left');
  checkBearing(turned, -65);
  assert.equal(turned.fix, null);
  assert.equal(turned.floorMotion, undefined);
  assert.equal(turned.recording.fix, null);
  const reverse = at(12600, anchored(180));
  assert.equal(reverse.motionGuide.screenDirection, 'behind');
  assert.equal(reverse.motionGuide.arrow, null);
  const back = at(12700, anchored(0));
  checkBearing(back, 0);
  const raised = at(12710, anchored(0, -55));
  assert.equal(raised.motionGuide.floorVisible, false);
  assert.equal(raised.motionGuide.routeBearing.direction, 'forward');
  const pitch = 40*Math.PI/180;
  const gravity = [0, -Math.cos(pitch), Math.sin(pitch)];
  const missedPitch = at(12720, anchored(0,0), wall, { floorUp: gravity });
  assert.equal(missedPitch.motionGuide.floorVisible, false, 'fresh gravity does not turn the wall into floor evidence');
  assert.equal(missedPitch.motionGuide.guide.length, 0);
  assert.equal(missedPitch.motionGuide.arrow, null);
  const distantTag = scene(cv, floorAt([0,0,4], [0,1.6,0]), [[4,4]], false, .3, hall.tags);
  const partial = at(12760, anchored(65), distantTag);
  assert.equal(partial.referenceTag.id, 4);
  assert.equal(partial.fix, null);
  assert.equal(partial.motionGuide.screenDirection, 'left', 'a same-space ID without a pose does not interrupt rotation');
  const down = at(12800, anchored(65, 90), wall, { bounds: [100,100,101,101] });
  assert.equal(down.motionGuide.screenDirection, 'left');
  assert.ok(Math.abs(down.motionGuide.screenAngleDeg + 65) < .001);
  const nearEnd = at(12900, anchored(0, 33, [0,7.9,1.3]));
  assert.equal(nearEnd.fix, null);
  assert.equal(nearEnd.motionGuide.arrow, null);
  assert.equal(nearEnd.motionGuide.maneuver, undefined);
  assert.equal(at(13000, { ...anchored(0), spaceId: 'other' }).motionGuide, undefined);
  assert.equal(at(13100, anchored(0), wall, { knownRoute: knownRoute - 1 }).motionGuide, undefined);
  const reacquired = at(13200, anchored(180), tag);
  assert.ok(reacquired.fix?.arrow);
  assert.equal(reacquired.motionGuide, undefined);
  const tree = routeTree(tagNetwork(hall), 0);
  assert.equal(at(13300, { ...camera(0), referenceTimeMs: 13200 }, wall,
    { destination: { spaceId: 'default', tree } }).motionGuide, undefined);
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

test('the displayed stripe damps small oscillations, follows a pan and restarts on a fresh sighting', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const tag = { id: 104, center: [0, 1], yawDeg: 0 };
  const map = { tags: [tag], tagSideM: .28, camera: { diagonalFovDeg: 70 }, route: [[0,-3], [0,10]] };
  const track = startWorker(cv, { station: map }), single = startWorker(cv, { station: map });
  const eye = [0, -.7, 1.25];
  const image = x => scene(cv, floorAt(eye, [x, 1, 0]), [[tag.id, tag.id]], false, .28, [tag]);
  const frames = [image(-.012), image(.012)];

  function stripeX(fix) {
    const row = H * .58, crossings = [];
    for (const face of fix.guide) {
      for (const [i, a] of face.entries()) {
        const b = face[(i + 1) % face.length];
        if ((a[1] < row) !== (b[1] < row))
          crossings.push(a[0] + (b[0]-a[0]) * (row-a[1]) / (b[1]-a[1]));
      }
    }
    assert.ok(crossings.length >= 2, 'the stripe crosses the camera scanline');
    return (Math.min(...crossings) + Math.max(...crossings)) / 2;
  }
  const raw = frames.map(pixels => single(pixels).fix);
  const rawSwing = Math.abs(stripeX(raw[0]) - stripeX(raw[1]));
  assert.ok(rawSwing > 3);
  const filtered = [];
  for (let i = 0; i < 12; i++) {
    const index = i % frames.length;
    const result = track(frames[index], { frameTimeMs: i * 40, recordingSpaceId: 'default' });
    assert.deepEqual(Array.from(result.recording.fix.cameraToWorld), Array.from(raw[index].cameraToWorld));
    if (i >= 6) filtered.push(stripeX(result.fix));
  }
  assert.ok(Math.max(...filtered) - Math.min(...filtered) < rawSwing / 2);

  const pan = image(.42), panned = stripeX(single(pan).fix);
  assert.ok(Math.abs(panned - stripeX(raw[0])) > 80);
  assert.ok(Math.abs(stripeX(track(pan, { frameTimeMs: 480 }).fix) - panned) < .01);
  track(frames[0], { frameTimeMs: 520 });
  const blank = track(scene(cv, floorAt(eye, [0, 1, 0]), []), { frameTimeMs: 560 });
  assert.equal(blank.fix, null);
  assert.equal(blank.floorMotion, undefined);
  assert.ok(Math.abs(stripeX(track(frames[1], { frameTimeMs: 600 }).fix) - stripeX(raw[1])) < .01);
});


test('camera fixes follow the shortest registered passages, reroute at a branch and stop at disconnected tags', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const tags = [...station.tags, { id: 7, center: [-3, 0], yawDeg: 0 }, { id: 8, center: [1, 2], yawDeg: 0 }];
  const map = { ...station, tags, tagGraph: { startTag: 0, endTag: 3, edges: [[0, 7], [7, 3], [0, 1], [1, 2], [2, 3]] } };
  assert.deepEqual(defaultWalk(map), [0, 1, 2, 3].map(id => tags[id].center));
  const track = startWorker(cv, { station: map });
  const eye = [0, -.45, 1.15], floor = floorAt(eye, [0, .62, 0]);
  const first = track(scene(cv, floor, [[0, 0]]));
  assert.deepEqual(JSON.parse(JSON.stringify(first.route)), defaultWalk(map));
  const branch = track(scene(cv, floor, [[0, 7]]));
  assert.deepEqual(Array.from(branch.fix.ids), [7]);
  assert.deepEqual(Array.from(branch.route.at(-1)), tags[3].center);
  assert.ok(branch.route.some(p => p[0] === -3));
  const lost = track(scene(cv, floor, []));
  assert.equal(lost.fix, null);
  const blocked = track(scene(cv, floor, [[1, 8]]));
  assert.ok(blocked.fix);
  assert.deepEqual(Array.from(blocked.route), []);
  assert.equal(blocked.fix.arrow, null);
  assert.equal(blocked.fix.arrived, false);
  assert.equal(blocked.fix.guide.length, 0);
  const network = tagNetwork(map);
  const back = track(scene(cv, floor, [[1, 1]]), { destination: { spaceId: 'default', tree: routeTree(network, network.anchors[0]) } });
  assert.deepEqual(Array.from(back.route.at(-1)), tags[0].center);
  assert.equal(back.fix.arrived, false);
});

test('a destination visible across a parallel aisle cannot complete a long connected walk', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const tags = station.tags.map((tag, i) => ({ ...tag, walkPoint: [[0, 0], [0, 6], [.2, 6], [.2, 0]][i] }));
  const map = { ...station, tags, tagGraph: { startTag: 0, endTag: 3, edges: [[0,1], [1,2], [2,3]] } };
  const track = startWorker(cv, { station: map });
  const atStart = floorAt([0, 0, 1.15], [0, .55, 0]);
  const { fix } = track(scene(cv, atStart, [[0,0], [1,1]]));
  assert.ok(fix);
  assert.equal(fix.arrived, false);
  assert.ok(fix.destinationDistance > 12);
});

test('a nearby localization-only tag keeps the route identified by a second visible tag', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const map = { ...station, route: [[-.25, -.45], [-.25, -3]] };
  const network = tagNetwork(map);
  assert.equal(network.anchors[0], 0);
  assert.equal(network.anchors[1], undefined);
  const track = startWorker(cv, { station: map });
  const floor = floorAt([0, .7, 1.65], [0, .51, 0]);
  const first = track(scene(cv, floor, [[0, 0]]));
  const both = track(scene(cv, floor, [[0, 0], [1, 1]]));
  assert.deepEqual(Array.from(both.fix.ids).sort(), [0, 1]);
  assert.equal(both.routeRevision, first.routeRevision);
  assert.deepEqual(Array.from(both.route.at(-1)), map.route.at(-1));
  assert.ok(both.fix.maneuver);
  const offPath = track(scene(cv, floor, [[1, 1]]));
  assert.ok(offPath.fix);
  assert.equal(offPath.route.length, 0);
});

test('a surveyed aisle keeps its arrow across distant markers and shows a bearing back from the side', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const marks = [{ id: 2, center: [0, 5], yawDeg: 0 }, { id: 7, center: [2.2, 1.6], yawDeg: 0 }];
  const hall = { tags: marks, tagSideM: .75, route: [[0, -2], [0, 10]], camera: { diagonalFovDeg: 70 } };
  const track = startWorker(cv, { station: hall });
  function sight(worker, x, tag, time) {
    const floor = floorAt([x, 0, 1.3], [...tag.center, 0]);
    const frame = worker(scene(cv, floor, [[tag.id, tag.id]], false, hall.tagSideM, marks), { frameTimeMs: time });
    assert.deepEqual(Array.from(frame.fix.ids), [tag.id]);
    return { frame, floor };
  }
  const { frame, floor } = sight(track, 0, marks[0], 100);
  const tip = floor(...frame.fix.arrow[4]), tail = floor(...frame.fix.arrow[0]);
  assert.ok(tip[1] > tail[1] && tip[1] < marks[0].center[1] - 1.1);
  const along = sight(track, 0, marks[1], 400).frame;
  assert.equal(tagNetwork(hall).anchors[7], undefined);
  assert.equal(along.routeRevision, frame.routeRevision);
  assert.ok(along.fix.arrow || along.fix.screenDirection);

  const beside = sight(track, 2.2, marks[0], 2000).frame.fix;
  assert.equal(beside.screenDirection, 'left');
  assert.equal(beside.arrived, false);
  assert.equal(beside.arrow, null);
  assert.equal(beside.guide.length, 0);

  const parallel = startWorker(cv, { station: { ...hall, route: [[0,-2], [0,8], [4,8], [4,-2]] } });
  const onAisle = sight(parallel, 0, marks[0], 100).frame;
  const unknownAisle = parallel(scene(cv, floor, []), { frameTimeMs: 1500, knownRoute: onAisle.routeRevision,
    guideCamera: { spaceId: 'default', referenceTimeMs: 100, cameraToWorld: [0,0,1,2, -1,0,0,0, 0,-1,0,1.3, 0,0,0,1] } });
  assert.equal(unknownAisle.motionGuide.screenDirection, 'left', 'turn the last confirmed bearing without choosing a parallel aisle');
  assert.equal(unknownAisle.motionGuide.guide.length, 0);
  assert.equal(unknownAisle.motionGuide.maneuver, undefined);
  const between = sight(parallel, 2.2, marks[0], 2000).frame.fix;
  assert.equal(between.screenDirection, undefined);
});

test('legacy corridors keep their corners, endpoints and printed IDs without shortcutting a crossing', () => {
  const network = tagNetwork(corridor);
  assert.deepEqual(network.points[network.start], corridor.route[0]);
  assert.deepEqual(network.points[network.end], corridor.route.at(-1));
  assert.deepEqual(network.points[network.anchors[5]], [0, 1]);
  assert.equal(routeTree(network).costs[network.start], 3.75);
  const crossing = tagNetwork({ route: [[0, 0], [2, 2], [0, 2], [2, 0]], tags: [{ id: 9, center: [1, 1] }] });
  assert.equal(crossing.anchors[9], undefined);
  assert.ok(routeTree(crossing).costs[crossing.start] > 7);
});

test('live tag edits rebuild the guide and a newly observed tag can guide back to the original start', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const tag = (id, x, y) => ({ id, center: [x, y], yawDeg: 0 });
  const start = tag(40, 0, 0), goal = tag(7, 0, 3);
  const initial = { ...station, terrain: undefined, route: [], tags: [start, goal], autoRoute: { startTag: 40, endTag: 7 } };
  const track = startWorker(cv, { station: initial });
  function sight(layout, id, eye, look, options) {
    const floor = floorAt(eye, look);
    const frame = track(scene(cv, floor, [[id, id]], false, .16, layout.tags), options);
    assert.deepEqual(Array.from(frame.fix.ids), [id]);
    assert.ok(frame.fix.guide.length && frame.fix.arrow);
    const tip = floor(...frame.fix.arrow[4]), tail = floor(...frame.fix.arrow[0]);
    return { frame, dx: tip[0] - tail[0], dy: tip[1] - tail[1] };
  }
  const before = sight(initial, 40, [0, -.45, 1.15], [0, .62, 0]);
  assert.ok(before.dy > .3);
  const moved = tag(7, 3, 0), added = tag(103, 1.5, 0);
  const revised = { ...initial, tags: [moved, added, start] };
  const after = sight(revised, 40, [-.45, 0, 1.15], [.62, 0, 0],
    { layouts: [{ id: 'default', station: revised }], knownRoute: before.frame.routeRevision });
  assert.deepEqual(JSON.parse(JSON.stringify(after.frame.route)), [start.center, added.center, moved.center]);
  assert.ok(after.dx > .3 && Math.abs(after.dy) < .2);
  const network = tagNetwork(revised);
  const back = sight(revised, 103, [1.95, 0, 1.15], [.88, 0, 0],
    { destination: { spaceId: 'default', tree: routeTree(network, network.anchors[40]) } });
  assert.deepEqual(Array.from(back.frame.route.at(-1)), start.center);
  assert.ok(back.dx < -.3);
});

test('automatic passages stay inside concave floor boundaries and honor walking points', () => {
  // Both endpoints and the midpoint of the direct segment are indoors. A
  // narrow cut near its far end requires taking the corner tags below it.
  const outline = [[0, 0], [10, 0], [10, 4], [8.1, 4], [8.1, 1], [8, 1], [8, 4], [0, 4]];
  const tags = [[10, [1, 3]], [14, [7.9, .8]], [25, [8.2, .8]], [37, [9, 3]]]
    .map(([id, center]) => ({ id, center, yawDeg: 0 }));
  tags.push({ id: 70, center: [11, 3], walkPoint: [9, 3], yawDeg: 0 }, { id: 71, center: [8.05, 2], yawDeg: 0 });
  const layout = { route: [], terrain: { outline }, tags, autoRoute: { startTag: 10, endTag: 70 } };
  const n = tagNetwork(layout);
  assert.equal(n.anchors[70], n.anchors[37]);
  assert.equal(n.anchors[71], undefined);
  assert.deepEqual(defaultWalk(layout), [tags[0].center, tags[1].center, tags[2].center, tags[3].center]);
  for (const boundary of [outline, [...outline].reverse()]) {
    const detour = defaultWalk({ ...layout, terrain: { outline: boundary }, tags: [tags[0], tags[4]] });
    assert.deepEqual(detour[0], tags[0].center);
    assert.deepEqual(detour.at(-1), tags[4].walkPoint);
    assert.ok(detour.length > 2, 'the floor plan supplies an unmarked turn');
    for (let i = 1; i < detour.length; i++) {
      const [x, y] = detour[i - 1], [u, v] = detour[i];
      if (x < 8.05 && u > 8.05) assert.ok(y + (v - y) * (8.05 - x) / (u - x) <= 1, 'the detour stays below the cut');
    }
  }
  assert.deepEqual(defaultWalk({ ...layout, autoRoute: { startTag: 10, endTag: 71 } }), []);
  assert.deepEqual(defaultWalk({ ...layout, autoRoute: { startTag: 70, endTag: 10 } }), defaultWalk(layout).reverse());
});

test('moving a tag in a loop switches the shortest branch without changing the destination ID', () => {
  const tag = (id, x, y) => ({ id, center: [x, y], yawDeg: 0 });
  const a = tag(12, 0, 0), b = tag(48, 1, 5), c = tag(3, 4, 5), d = tag(5, 4, 0);
  const layout = { tags: [a, b, c, d], route: [], autoRoute: { startTag: a.id, endTag: c.id } };
  assert.deepEqual(defaultWalk(layout), [a.center, b.center, c.center]);
  const moved = { ...layout, tags: [c, { ...b, center: [-1, 5] }, d, a] };
  assert.deepEqual(defaultWalk(moved), [a.center, d.center, c.center]);
  const added = tag(101, 4, 2);
  assert.deepEqual(defaultWalk({ ...moved, tags: [...moved.tags, added] }), [a.center, d.center, added.center, c.center]);
});
