/* Classic worker: the OpenCV distribution initialises WebAssembly via importScripts. */
'use strict';

let lib, detector, station, anchors, segments;
let reportedFrameError = false;

const xy = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function configure(map) {
  if (!Number.isFinite(map.tagSideM) || map.tagSideM <= 0 || !Array.isArray(map.tags) || !map.tags.length)
    throw new Error('station.json: 태그 크기와 배치를 확인하세요.');
  anchors = new Map();
  for (const { id, center, yawDeg } of map.tags) {
    if (!Number.isInteger(id) || id < 0 || id >= 587 || anchors.has(id) || !xy(center) || !Number.isFinite(yawDeg))
      throw new Error('station.json: 태그 ID, 중심, 방향을 확인하세요.');
    const yaw = yawDeg * Math.PI / 180;
    const half = map.tagSideM / 2;
    const corners = [[-half, half], [half, half], [half, -half], [-half, -half]].map(([x, y]) =>
      [center[0] + Math.cos(yaw)*x + Math.sin(yaw)*y, center[1] - Math.sin(yaw)*x + Math.cos(yaw)*y]);
    anchors.set(id, { center, corners });
  }
  if (!Array.isArray(map.route) || map.route.length < 2 || !map.route.every(xy))
    throw new Error('station.json: 바닥 경로 좌표를 확인하세요.');
  segments = [];
  let along = 0;
  for (let i = 1; i < map.route.length; i++) {
    const a = map.route[i-1], b = map.route[i], length = distance(a, b);
    if (length < .05) throw new Error('station.json: 인접 경로점이 너무 가깝습니다.');
    segments.push({ a, length, along, dx: (b[0]-a[0])/length, dy: (b[1]-a[1])/length });
    along += length;
  }
  const cal = map.camera.calibration;
  if (cal) {
    if (![cal.width, cal.height, cal.fx, cal.fy].every(n => Number.isFinite(n) && n > 0)
      || ![cal.cx, cal.cy].every(Number.isFinite) || ![4,5,8].includes(cal.distortion?.length)
      || !cal.distortion.every(Number.isFinite)) throw new Error('station.json: 카메라 보정값을 확인하세요.');
  } else if (!(map.camera.diagonalFovDeg > 15 && map.camera.diagonalFovDeg < 150)) {
    throw new Error('station.json: 후면 카메라의 대각 화각을 확인하세요.');
  }
  station = map;
}

function cameraMatrix(w, h, own) {
  const c = station.camera.calibration;
  let fx, fy, cx, cy;
  if (c) {
    if (Math.abs(w/h / (c.width/c.height) - 1) > .02)
      throw new Error('영상 방향과 종횡비가 카메라 보정 파일과 다릅니다.');
    fx = c.fx*w/c.width; fy = c.fy*h/c.height;
    cx = (c.cx+.5)*w/c.width-.5; cy = (c.cy+.5)*h/c.height-.5;
  } else {
    fx = fy = Math.hypot(w,h) / (2*Math.tan(station.camera.diagonalFovDeg*Math.PI/360));
    cx = (w-1)/2; cy = (h-1)/2;
  }
  return own(lib.matFromArray(3, 3, lib.CV_64F, [fx,0,cx, 0,fy,cy, 0,0,1]));
}

function visibleTags(frame, own) {
  const gray = own(new lib.Mat()), corners = own(new lib.MatVector());
  const ids = own(new lib.Mat()), rejected = own(new lib.MatVector());
  lib.cvtColor(frame, gray, lib.COLOR_RGBA2GRAY);
  detector.detectMarkers(gray, corners, ids, rejected);
  const visible = new Map(), duplicates = new Set();
  for (let i = 0; i < ids.rows; i++) {
    const id = ids.data32S[i];
    if (!anchors.has(id)) continue;
    const values = own(corners.get(i)).data32F;
    const image = [0,2,4,6].map(k => [values[k], values[k+1]]);
    if (image.some((p,j) => distance(p, image[(j+1)%4]) < 22)) continue;
    if (visible.has(id)) duplicates.add(id);
    visible.set(id, { id, image, ...anchors.get(id) });
  }
  for (const id of duplicates) visible.delete(id);
  return [...visible.values()];
}

function correspondences(tags, own) {
  const floor = tags.flatMap(tag => tag.corners);
  return {
    floor,
    object: own(lib.matFromArray(floor.length, 1, lib.CV_64FC3, floor.flatMap(([x,y]) => [x,y,0]))),
    image: own(lib.matFromArray(floor.length, 1, lib.CV_64FC2, tags.flatMap(tag => tag.image.flat()))),
  };
}

function arrowAt(position, tags, project, bounds) {
  let progress = 0, nearest = Infinity;
  for (const seg of segments) {
    const t = Math.min(seg.length, Math.max(0, (position[0]-seg.a[0])*seg.dx + (position[1]-seg.a[1])*seg.dy));
    const d = distance(position, [seg.a[0]+seg.dx*t, seg.a[1]+seg.dy*t]);
    if (d < nearest) { nearest = d; progress = seg.along + t; }
  }
  if (nearest > 1.5 || distance(position, station.route.at(-1)) < .3) return null;
  const shape = [[-.048,-.20],[.048,-.20],[.048,.015],[.12,.015],[0,.20],[-.12,.015],[-.048,.015]];
  for (const seg of segments) {
    for (let t = 0; t < seg.length - .2; t += .65) {
      const ahead = seg.along + t - progress;
      if (ahead < .15 || ahead > 2.5) continue;
      const center = [seg.a[0]+t*seg.dx, seg.a[1]+t*seg.dy];
      if (tags.every(tag => distance(tag.center, center) > 1.1)) continue;
      const outline = shape.map(([x,y]) =>
        [center[0]+seg.dy*x+seg.dx*y, center[1]-seg.dx*x+seg.dy*y]);
      const points = project(outline);
      if (points && points.every(([x,y]) => x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3]))
        return points;
    }
  }
  return null;
}

function locate({ rgba, w, h, bounds = [0, 0, w, h] }) {
  const owned = [];
  const own = (m) => { owned.push(m); return m; };
  try {
    const image = own(new lib.Mat(h, w, lib.CV_8UC4));
    image.data.set(new Uint8Array(rgba));
    let tags = visibleTags(image, own);
    if (!tags.length) return null;
    const K = cameraMatrix(w, h, own);
    const coefficients = station.camera.calibration?.distortion ?? [0,0,0,0,0];
    const dist = own(lib.matFromArray(coefficients.length, 1, lib.CV_64F, coefficients));
    const r = own(new lib.Mat()), t = own(new lib.Mat());
    let pairs = correspondences(tags, own);
    if (tags.length > 1) {
      const inliers = own(new lib.Mat());
      if (!lib.solvePnPRansac(pairs.object, pairs.image, K, dist, r, t, false, 120, 3, .995, inliers, lib.SOLVEPNP_ITERATIVE))
        return null;
      const indices = new Set(inliers.data32S);
      const consistent = tags.filter((_, i) => [0,1,2,3].every(k => indices.has(4*i+k)));
      if (consistent.length < 2) return null;
      if (consistent.length < tags.length) { tags = consistent; pairs = correspondences(tags, own); }
    }
    if (!lib.solvePnP(pairs.object, pairs.image, K, dist, r, t, false, lib.SOLVEPNP_ITERATIVE)) return null;
    const rot = own(new lib.Mat());
    lib.Rodrigues(r, rot);
    const R = rot.data64F, T = t.data64F;
    const position = [0,1,2].map(j => -(R[j]*T[0]+R[j+3]*T[1]+R[j+6]*T[2]));
    const depth = ([x,y]) => R[6]*x + R[7]*y + T[2];
    if (!position.every(Number.isFinite) || position[2] < .12 || position[2] > 3.2 || pairs.floor.some(p => depth(p) <= .05))
      return null;
    const projected = own(new lib.Mat());
    lib.projectPoints(pairs.object, r, t, K, dist, projected);
    const observed = pairs.image.data64F, reproj = projected.data64F;
    let squared = 0;
    for (let k = 0; k < observed.length; k++) squared += (reproj[k]-observed[k])**2;
    const rmsPx = Math.sqrt(squared / pairs.floor.length);
    if (!(rmsPx <= 2.5)) return null;

    // On the common floor plane the pixel homography needs no focal-length estimate.
    // With a calibrated lens, project through its measured distortion instead.
    let H;
    if (!station.camera.calibration) {
      const floor = own(lib.matFromArray(pairs.floor.length, 1, lib.CV_64FC2, pairs.floor.flat()));
      H = own(lib.findHomography(floor, pairs.image, 0)).data64F;
      if (H.length !== 9) return null;
    }
    function project(outline) {
      if (outline.some(p => depth(p) < .08)) return null;
      if (H) return outline.map(([x,y]) => {
        const z = H[6]*x + H[7]*y + H[8];
        return [(H[0]*x+H[1]*y+H[2])/z, (H[3]*x+H[4]*y+H[5])/z];
      });
      const obj = own(lib.matFromArray(outline.length, 1, lib.CV_64FC3, outline.flatMap(([x,y]) => [x,y,0])));
      const uv = own(new lib.Mat());
      lib.projectPoints(obj, r, t, K, dist, uv);
      return outline.map((_,i) => [uv.data64F[i*2], uv.data64F[i*2+1]]);
    }
    return { position, ids: tags.map(tag => tag.id), rmsPx, arrow: arrowAt(position, tags, project, bounds) };
  } finally {
    for (let i = owned.length-1; i >= 0; i--) owned[i].delete();
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    function ready(cv) {
      try {
        lib = cv;
        const dictionary = lib.getPredefinedDictionary(lib.DICT_APRILTAG_36h11);
        const params = new lib.aruco_DetectorParameters(), refine = new lib.aruco_RefineParameters(10, 3, true);
        params.cornerRefinementMethod = lib.CORNER_REFINE_SUBPIX;
        detector = new lib.aruco_ArucoDetector(dictionary, params, refine);
        dictionary.delete(); params.delete(); refine.delete();
        self.postMessage({ type: 'ready' });
      } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    }
    try {
      configure(data.station);
      importScripts(data.library);
      if (self.cv.Mat) ready(self.cv);
      else self.cv.then(ready);
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    return;
  }
  try {
    self.postMessage({ type: 'frame', fix: locate(data) });
  } catch (error) {
    if (!reportedFrameError) { console.warn('역사 AR:', String(error)); reportedFrameError = true; }
    self.postMessage({ type: 'frame', fix: null });
  }
};
