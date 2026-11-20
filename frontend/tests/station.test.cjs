const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', 'public');
const station = JSON.parse(readFileSync(join(root, 'station.json')));
const workerCode = readFileSync(join(root, 'ar/tracker.js'), 'utf8');
const W = 640, H = 800;

function worker(cv, map) {
  let reply;
  const self = { cv, postMessage(data) { reply = data; } };
  runInNewContext(workerCode, { self, importScripts() {}, console });
  self.onmessage({ data: { type: 'init', library: '', station: map } });
  assert.equal(reply.type, 'ready', reply.message);
  return rgba => {
    self.onmessage({ data: { type: 'frame', w: W, h: H, rgba: rgba.buffer } });
    assert.equal(reply.type, 'frame');
    const c = map.camera.calibration;
    const focal = Math.hypot(W, H) / (2 * Math.tan(35 * Math.PI / 180));
    const expected = c ? [c.fx, c.fy, c.cx, c.cy] : [focal, focal, (W-1)/2, (H-1)/2];
    assert.deepEqual(Array.from(reply.intrinsics), expected, 'saved JPEG intrinsics, also during tag loss');
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

function scene(cv, floor, ids) {
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
    for (const {center,c,s,bits} of markers) {
      const dx=wx-center[0], dy=wy-center[1];
      const u=(c*dx-s*dy)/.16+.5, v=.5-(s*dx+c*dy)/.16;
      if (u>=0 && u<1 && v>=0 && v<1) { value=bits[Math.floor(v*8)*8+Math.floor(u*8)]; break; }
    }
    const i=(y*W+x)*4;
    pixels[i]=pixels[i+1]=pixels[i+2]=value;
    pixels[i+3]=255;
  }
  return pixels;
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
  assert.equal(locate(scene(cv,floor,[])), null);
  assert.equal(locate(scene(cv,floor,[[1,42]])), null);
  checkFix(locate(scene(cv,floor,[[1,1]])),eye,floor,1);

  const turnEye=[.03,1.47,1.10], turnFloor=floorAt(turnEye,[.46,2.15,0]);
  checkFix(locate(scene(cv,turnFloor,[[2,2],[3,3]])),turnEye,turnFloor,0);
  const arrival=floorAt([1.7,2,1.1],[1.05,2.2,0]);
  const destination=locate(scene(cv,arrival,[[3,3]]));
  assert.ok(destination?.position);
  assert.equal(destination.arrow,null);

  const cal={width:W,height:H,fx:650,fy:685,cx:W/2+9,cy:H/2-7,distortion:[0,0,0,0,0]};
  const calibrated=worker(cv,{...station,camera:{calibration:cal}});
  const calibratedFloor=floorAt(eye,[0,.62,0],cal);
  checkFix(calibrated(scene(cv,calibratedFloor,[[0,0],[1,1]])),eye,calibratedFloor,1,[cal.cx,cal.cy]);
});
