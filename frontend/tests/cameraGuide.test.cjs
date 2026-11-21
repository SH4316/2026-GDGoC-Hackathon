const assert = require('node:assert/strict');
const { test } = require('node:test');
const { join } = require('node:path');

const testImages = new Map();
function imageData(scene, width, height) {
  const key = [scene, width, height].join('/');
  let data = testImages.get(key);
  if (!data) {
    data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const tile = (Math.floor(8 * x / width) + Math.floor(6 * y / height)) % 2;
      const light = (scene === 'other floor' ? 1 - tile : tile) * 160 + (scene === 'brighter floor' ? 44 : 40);
      data.set(scene === 'sky' ? [115, 160, 210, 255] : [light, light, light, 255], (y * width + x) * 4);
    }
    testImages.set(key, data);
  }
  return { width, height, data: data.slice() };
}

function canvas() {
  const surface = { width: 640, height: 480, clientWidth: 640, clientHeight: 480, fills: [] };
  let first;
  const ctx = {
    canvas: surface,
    clearRect() { surface.fills = []; },
    beginPath() {}, moveTo(x, y) { first = [x, y]; }, lineTo() {}, closePath() {}, stroke() {},
    fill() { surface.fills.push(first); },
    drawImage(source) { surface.scene = source.scene; },
    getImageData(_x, _y, width, height) { return imageData(surface.scene, width, height); },
  };
  return Object.assign(surface, { getContext: () => ctx });
}

test('the camera updates the active route guide through tracking loss and recovery', async t => {
  const { createServer } = await import('vite');
  const server = await createServer({ root: join(__dirname, '..'), configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close());
  const { openPassage } = await server.ssrLoadModule('/src/ar/camera.ts');
  let now = 0, nextFrame, worker, request, poll, destination, status, cue, direction, angle, locations = 0, arrivals = 0;
  t.mock.method(performance, 'now', () => now);
  const timers = new Map(), clearNativeTimer = globalThis.clearTimeout;
  let timerId = 0;
  t.mock.method(globalThis, 'clearTimeout', handle => {
    if (!timers.delete(handle)) clearNativeTimer(handle);
  });
  function advance(to) {
    for (;;) {
      const next = [...timers.values()].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > to) break;
      timers.delete(next.id);
      now = next.at;
      next.fn();
    }
    now = to;
  }
  const track = { getSettings: () => ({}), addEventListener() {}, stop() {} };
  navigator.mediaDevices = { getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }) };
  Object.assign(globalThis, {
    document: Object.assign(new EventTarget(), { createElement: canvas }),
    window: Object.assign(new EventTarget(), {
      setTimeout(fn, delay) {
        const id = --timerId;
        timers.set(id, { id, fn, at: now + delay });
        return id;
      },
      clearTimeout: handle => timers.delete(handle), setInterval(fn) { poll = fn; },
    }),
    screen: { orientation: { angle: 0 } }, location: new URL('http://localhost/'),
    getComputedStyle: () => ({ objectFit: 'contain' }),
    Worker: class {
      constructor() { worker = this; }
      postMessage(data) {
        request = data;
        if (data.type === 'init') this.onmessage({ data: { type: 'ready' } });
      }
      terminate() {}
    },
  });
  t.after(() => {
    for (const key of ['document', 'window', 'screen', 'location', 'getComputedStyle', 'Worker']) delete globalThis[key];
    delete navigator.mediaDevices;
  });
  const video = { videoWidth: 640, videoHeight: 480, readyState: 4, scene: 'floor', play: async () => {},
    requestVideoFrameCallback(fn) { nextFrame = fn; }, cancelVideoFrameCallback() {} };
  const guide = canvas(), ready = Promise.withResolvers();
  const route = [[0, 0], [0, 6]];
  const space = { id: 'hall', station: { tags: [{ id: 1, center: [0, 0] }], route } };
  const passage = openPassage(video, guide, canvas(), canvas(), [space], {
    ready: ready.resolve, allowGuidance: () => true, language: () => 'ko', located() { locations++; }, route() {},
    arrived() { arrivals++; }, cue(value) { cue = value; }, direction(value, degrees) { direction = value; angle = degrees; }, state(...args) { status = args; },
    tagSeen() {}, chooseSpace() {}, destination: () => destination, selection() {}, destinationNearby() {},
    minimap() {}, recordingSpace() {}, debug() {}, modelNotice() {}, pause() {}, error: assert.fail,
  });
  try {
    await ready.promise;
    function frame(at, data = {}, delay = 0, duringProcessing) {
      advance(at);
      nextFrame(at, { presentationTime: at, mediaTime: at / 1000 });
      assert.equal(request.type, 'frame');
      duringProcessing?.();
      advance(at + delay);
      worker.onmessage({ data: { type: 'frame', fix: null, detections: [], ...data } });
      return request;
    }
    const pose = { position: [0, 0, 1], cameraToWorld: [1,0,0,0, 0,0,1,0, 0,-1,0,1, 0,0,0,1] };
    const projection = x => ({ guide: [[[x, 0], [x, 2], [x + 1, 2]]], arrow: [[x, 3], [x + 1, 4], [x, 4]],
      routeBearing: { direction: 'forward', angleDeg: 3 } });
    const tagged = x => ({ spaceId: 'hall', route, routeRevision: 1,
      fix: { ...pose, ...projection(x), ids: [1], rmsPx: 0, destinationDistance: 6, maneuver: { kind: 'straight', index: 0 } } });

    frame(20);
    assert.deepEqual(guide.fills, []);
    frame(100, tagged(10));
    assert.deepEqual(guide.fills, [[10, 0], [10, 3]]);
    frame(120);
    assert.deepEqual(guide.fills, [], 'moving the camera onto an untracked surface clears all floor pixels');
    assert.equal(direction, 'forward');
    assert.equal(angle, 3, 'the last measured route bearing stays available in the guidance panel');
    const partialTag = tagged(15);
    partialTag.fix.arrow = null;
    frame(160, partialTag);
    assert.deepEqual(guide.fills[0], [15, 0]);
    assert.equal(guide.fills.length, 1, 'a new stripe cannot revive an old floor arrow');
    assert.equal(direction, 'forward');
    const floor = frame(280, { floorMotion: { ...pose, ...projection(20), arrow: null,
      maneuver: { kind: 'straight', index: 0 }, spaceId: 'hall', referenceTimeMs: 160 } });
    assert.deepEqual(floor.floorAnchor, { spaceId: 'hall', timeMs: 160 }, 'floor tracking can continue without motion permission');
    assert.deepEqual(guide.fills[0], [20, 0]);
    assert.equal(guide.fills.length, 1);
    assert.equal(direction, 'forward', 'a tagless floor match with only a stripe keeps the panel bearing');
    frame(400, { floorMotion: { ...pose, guide: [], arrow: null, maneuver: { kind: 'straight', index: 0 },
      spaceId: 'hall', referenceTimeMs: 280 } });
    assert.deepEqual(guide.fills, []);
    assert.equal(direction, 'forward');
    frame(450, { pendingFloorSpace: 'hall' });
    frame(500, { referenceTag: { spaceId: 'hall', id: 1 } });
    assert.deepEqual(guide.fills, [], 'decoding a tag ID alone cannot put a floor arrow back onto the camera');
    frame(550, { floorMotion: { ...pose, ...projection(20), floorVisible: false,
      maneuver: { kind: 'straight', index: 0 }, spaceId: 'hall', referenceTimeMs: 400 } });
    assert.deepEqual(guide.fills, [], 'a view marked as having no plausible floor cannot paint geometry');
    frame(600);
    advance(950); // The camera stopped delivering frames.
    frame(2000, {}, 500); // A late worker result also expires.
    frame(2800, { floorMotion: { ...pose, ...projection(90), spaceId: 'hall', referenceTimeMs: 100 } });
    frame(3000);
    assert.deepEqual(guide.fills, [], 'late results and a rejected match cannot paint on the live video');
    assert.equal(direction, 'forward');
    assert.match(status[1], /마지막으로 확인한 방향/);
    assert.equal(cue, undefined);
    assert.equal(arrivals, 0);
    frame(3100, tagged(30));
    assert.deepEqual(guide.fills, [[30, 0], [30, 3]]);
    assert.equal(direction, undefined);
    const reroute = tagged(35);
    reroute.route = [[0, 0], [4, 0]];
    reroute.routeRevision = 2;
    reroute.fix.arrow = null;
    frame(3120, reroute);
    assert.deepEqual(guide.fills[0], [35, 0]);
    assert.ok(!guide.fills.some(([x,y]) => x === 30 && y === 3), 'a new route cannot inherit the old direction arrow');
    const turn = tagged(35);
    turn.fix.arrow = null;
    turn.fix.screenDirection = 'right';
    frame(3130, turn);
    assert.equal(direction, 'right', 'a measured turn outside the image gets a directional indicator');
    frame(3150, { referenceTag: { spaceId: 'other', id: 2 } });
    assert.deepEqual(guide.fills, []);
    assert.ok(!direction);
    frame(3200, tagged(30));
    frame(3250, { candidates: ['hall', 'other'] });
    assert.deepEqual(guide.fills, []);
    const facingBack = tagged(40);
    Object.assign(facingBack.fix, { guide: [], arrow: null, maneuver: { kind: 'realign', index: 0, direction: 'behind' } });
    frame(3300, facingBack);
    assert.equal(direction, 'behind');
    frame(3400);
    advance(3800);
    assert.equal(direction, 'behind', 'the turn-back indicator survives complete tracking loss');
    frame(3900, tagged(45));
    assert.ok(!direction, 'a fresh on-floor arrow replaces the turn-back indicator');
    frame(4000, facingBack);
    destination = { spaceId: 'hall', id: 1 };
    poll(); // The destination can change while the video is stalled.
    assert.deepEqual(guide.fills, []);
    assert.ok(!direction);
    frame(4100, tagged(50));
    const arrived = tagged(60);
    arrived.fix.arrived = true;
    frame(4200, arrived);
    frame(4300);
    assert.deepEqual(guide.fills, []);
    assert.equal(arrivals, 1);

    passage.updateLayouts([space]);
    frame(4400, tagged(65));
    advance(4750);
    assert.deepEqual(guide.fills, [], 'the video watchdog switches a live floor arrow to the panel bearing');
    assert.equal(direction, 'forward');
    passage.updateLayouts([space]);
    const previousLocations = locations;
    frame(4800, tagged(70), 500);
    assert.deepEqual(guide.fills, [], 'a slow first fix seeds the compass without painting stale image coordinates');
    assert.equal(direction, 'forward');
    assert.notEqual(status[0], '위치 인식');
    assert.equal(locations, previousLocations);
    assert.equal(cue, undefined);
    frame(5400);
    assert.deepEqual(guide.fills, []);
    assert.equal(direction, 'forward');
    frame(5500, arrived, 500);
    assert.equal(arrivals, 1, 'a delayed sighting cannot confirm arrival');

    await t.test('gyro-only turns update the displayed direction after five seconds of textureless video', () => {
      function rotate(at, beta) {
        const event = new Event('devicemotion');
        Object.defineProperty(event, 'timeStamp', { value: at });
        Object.assign(event, { rotationRate: { alpha: 0, beta, gamma: 0 }, acceleration: null,
          accelerationIncludingGravity: null, interval: 20 });
        window.dispatchEvent(event);
      }
      destination = undefined;
      passage.updateLayouts([space]);
      let at = 6000;
      frame(at, tagged(10));
      const fixedLocations = locations, fixedArrivals = arrivals;
      for (let i = 0; i < 250; i++) rotate(at += 20, 0);
      let previousYaw = 0;
      for (const [expectedYaw, indicator] of [[45, 'left'], [90, 'left'], [180, 'behind'], [270, 'right'], [360, 'forward']]) {
        // Upright portrait handset rotating clockwise about its Y axis (rotationRate.beta).
        const samples = (expectedYaw - previousYaw) / 90 * 50;
        for (let i = 0; i < samples; i++) rotate(at += 20, -90);
        previousYaw = expectedYaw;
        const screenAngle = (540 - expectedYaw) % 360 - 180;
        // A cached worker can still send floor polygons on a motion-only result.
        const projection = expectedYaw < 360 ? { screenDirection: indicator, screenAngleDeg: screenAngle, guide: [], arrow: null } :
          { guide: [[[20, 0], [20, 2], [21, 2]]], arrow: [[20, 3], [21, 4], [20, 4]],
            routeBearing: { direction: 'forward', angleDeg: screenAngle } };
        const req = frame(at, { motionGuide: { spaceId: 'hall', ...projection } });
        assert.equal(req.guideCamera?.referenceTimeMs, 6000);
        assert.equal(req.guideCamera.spaceId, 'hall');
        assert.equal(req.knownRoute, 1);
        const m = req.guideCamera.cameraToWorld;
        const yaw = Math.atan2(m[2], m[6]) * 180 / Math.PI;
        assert.ok(Math.abs((yaw - expectedYaw + 540) % 360 - 180) < .1, 'gyro yaw at camera exposure');
        assert.deepEqual([m[3], m[7], m[11]], [0, 0, 1]);
        assert.equal(direction, indicator);
        assert.equal(angle, screenAngle, 'the arrow rotates within the same direction sector');
        assert.deepEqual(guide.fills, []);
        assert.equal(locations, fixedLocations);
        assert.equal(arrivals, fixedArrivals);
      }
      assert.equal(frame(at + 1000).guideCamera, undefined, 'an interrupted sensor stream stops reprojection');
      assert.deepEqual(guide.fills, []);
      assert.equal(direction, 'forward');
      passage.updateLayouts([space]);
      assert.equal(frame(at + 1100).guideCamera, undefined);
      assert.deepEqual(guide.fills, []);
    });

    await t.test('a pitch during worker processing clears the live overlay and rejects a newly delivered old projection', () => {
      passage.updateLayouts([space]);
      const level = tagged(80);
      level.fix.floorTiltLimit = { up: [0, -1, 0], minDot: Math.cos(12 * Math.PI / 180) };
      frame(30000, level);
      assert.equal(guide.fills.length, 2);
      frame(30020, level, 200, () => {
        for (let time = 30040; time <= 30220; time += 20) {
          const event = new Event('devicemotion');
          Object.defineProperty(event, 'timeStamp', { value: time });
          Object.assign(event, { rotationRate: { alpha: 180, beta: 0, gamma: 0 } });
          window.dispatchEvent(event);
        }
        assert.deepEqual(guide.fills, [], 'the old floor can cross the horizon before the worker replies');
        assert.equal(direction, 'forward');
      });
      assert.deepEqual(guide.fills, [], 'a result below the frame timeout still belongs to the old tilt');
      assert.equal(direction, 'forward');
    });

    await t.test('sensorless floor projections follow the displayed video while the worker processes an earlier frame', () => {
      passage.updateLayouts([space]);
      video.scene = 'floor';
      frame(40000, tagged(80));
      assert.equal(guide.fills.length, 2);
      function present(at, scene) {
        const pending = request;
        video.scene = scene;
        advance(at);
        nextFrame(at, { presentationTime: at, mediaTime: at / 1000 });
        assert.equal(request, pending, 'the detector is still processing the previously captured floor frame');
      }
      frame(40020, tagged(81), 220, () => {
        present(40087, 'brighter floor');
        assert.equal(guide.fills.length, 2, 'normal exposure variation keeps a stationary floor visible');
        present(40154, 'sky');
        assert.deepEqual(guide.fills, [], 'a newer sky frame clears the previous arrow immediately without sensors');
        assert.equal(direction, 'forward');
      });
      assert.deepEqual(guide.fills, [], 'the old floor reply arriving 220ms later cannot paint on the sky');
      assert.equal(angle, 3);

      video.scene = 'floor';
      frame(40300, tagged(90), 220, () => {
        present(40367, 'floor');
        present(40434, 'brighter floor');
      });
      assert.deepEqual(guide.fills, [[90, 0], [90, 3]], 'a stationary camera can reacquire the floor on a slow device');
      assert.equal(direction, undefined);

      frame(40550, tagged(95), 220, () => {
        present(40617, 'floor');
        advance(40660); // 360ms after the previous capture, 140ms after its verified presentation.
        assert.equal(guide.fills.length, 2, 'while fresh identical video frames arrive the floor stays visible between slow results');
        present(40720, 'floor');
      });

      frame(40800, tagged(100), 220, () => {
        // The browser can already draw the new image before the next video callback executes.
        // Both floors have the same mean luminance but their tile patterns differ.
        video.scene = 'other floor';
      });
      assert.deepEqual(guide.fills, [], 'an image change just before reply delivery also invalidates the projection');
      assert.equal(direction, 'forward');
      frame(41100, tagged(110));
      assert.deepEqual(guide.fills, [[110, 0], [110, 3]]);
      assert.equal(direction, undefined);
      frame(41120, tagged(112), 700, () => {
        present(41187, 'other floor');
        advance(41700);
        assert.deepEqual(guide.fills, [], 'a stall after the last matching presentation still expires the floor');
        assert.equal(direction, 'forward');
      });
      assert.deepEqual(guide.fills, [], 'an expired worker reply cannot restart the stalled video overlay');
    });
  } finally {
    passage.close();
  }
});
