/* Classic worker: the OpenCV distribution initialises WebAssembly via importScripts. */
'use strict';

let lib, detector, highlightLut, station, anchors, segments;
let reportedFrameError = false;
let layouts, tagSpaces, trees;
let activePoints = [], activeNodes = [], activeEdges = new Map(), routeRevision = 0;
let incident = [];
let floorReference;
let lastTagPose, unconfirmedTagPose;

function reportFrameError(error) {
  if (!reportedFrameError) console.warn('역사 AR:', String(error));
  reportedFrameError = true;
}

const xy = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function confirmedTagPose(spaceId, fix, timeMs) {
  if (!fix || !Number.isFinite(timeMs)) return fix;
  const current = { spaceId, position: fix.position, timeMs };
  const continuous = (prior, maxGapMs) => prior?.spaceId === spaceId &&
    timeMs >= prior.timeMs && timeMs - prior.timeMs <= maxGapMs;
  const reachable = prior => distance(prior.position, fix.position) <= .25 + 3.5 * (timeMs - prior.timeMs) / 1000;
  // A one-frame planar pose flip can pass reprojection checks. Confirm a sudden
  // relocation against another observation; after an outage accept a fresh anchor.
  if (continuous(lastTagPose, 600) && !reachable(lastTagPose) &&
      !(continuous(unconfirmedTagPose, 300) && reachable(unconfirmedTagPose))) {
    unconfirmedTagPose = current;
    return null;
  }
  lastTagPose = current;
  unconfirmedTagPose = undefined;
  return fix;
}

function configure(map) {
  if (!Number.isFinite(map.tagSideM) || map.tagSideM <= 0 || !Array.isArray(map.tags))
    throw new Error('station.json: 태그 크기와 배치를 확인하세요.');
  anchors = new Map();
  for (const { id, center, yawDeg, surface } of map.tags) {
    if (!Number.isInteger(id) || id < 0 || id >= 587 || anchors.has(id) || !xy(center) || !Number.isFinite(yawDeg))
      throw new Error('station.json: 태그 ID, 중심, 방향을 확인하세요.');
    const yaw = yawDeg * Math.PI / 180;
    const half = map.tagSideM / 2;
    const origin = [center[0], center[1], surface?.heightM ?? 0];
    const right = surface?.right ?? [1, 0, 0], up = surface?.up ?? [0, 1, 0];
    const corners = [[-half, half], [half, half], [half, -half], [-half, -half]].map(([x, y]) => {
      const u = Math.cos(yaw)*x + Math.sin(yaw)*y, v = -Math.sin(yaw)*x + Math.cos(yaw)*y;
      return origin.map((c, i) => c + u*right[i] + v*up[i]);
    });
    anchors.set(id, { center, corners });
  }
  if (!Array.isArray(map.route) || map.route.length === 1 || !map.route.every(xy))
    throw new Error('station.json: 바닥 경로 좌표를 확인하세요.');
  const tree = trees.get(map);
  incident = tree ? tree.points.map(() => []) : [];
  for (const [a, b] of tree?.edges ?? []) { incident[a].push(b); incident[b].push(a); }
  setPath([], tree || map.tagGraph ? [] : map.route);
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

function setPath(nodes, points) {
  activeNodes = nodes;
  activePoints = points;
  activeEdges = new Map(nodes.slice(1).map((node, i) => [nodes[i] + '/' + node, i]));
  routeRevision++;
  segments = [];
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1], b = points[i], length = distance(a, b);
    if (length < .05 - 1e-8) throw new Error('station.json: 인접 경로점이 너무 가깝습니다.');
    const dx = (b[0]-a[0])/length, dy = (b[1]-a[1])/length, previous = segments.at(-1);
    let turn;
    if (previous) {
      const angle = Math.atan2(previous.dx*dy - previous.dy*dx, previous.dx*dx + previous.dy*dy);
      if (Math.abs(angle) >= Math.PI / 5) turn = Math.abs(angle) > Math.PI * .85 ? 'uturn' : angle > 0 ? 'left' : 'right';
    }
    // Collinear route vertices describe a single straight instruction.
    const section = turn ? i - 1 : previous?.section ?? 0;
    segments.push({ a, length, along, dx, dy, turn, section });
    along += length;
  }
}

// Project the camera only onto passages incident to the observed tag. At a fork,
// walking partway along either direction of that edge has a different remaining cost.
function selectPath(tree, tags, position) {
  const tag = tags.reduce((best, t) => distance(t.center, position) < distance(best.center, position) ? t : best);
  const node = tree.anchors[tag.id];
  if (!Number.isFinite(tree.costs[node])) {
    if (activeNodes.length) setPath([], []);
    return;
  }
  let from = node, toward = -1, nearest = Infinity;
  for (const other of incident[node]) {
    const a = tree.points[node], b = tree.points[other];
    const length = distance(a, b), dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
    const along = Math.min(length, Math.max(0, (position[0] - a[0]) * dx + (position[1] - a[1]) * dy));
    const gap = distance(position, [a[0] + along * dx, a[1] + along * dy]);
    if (gap >= nearest) continue;
    nearest = gap;
    // On a shortest-tree edge always follow its downhill direction, including at an endpoint tie.
    if (along < .05 || length - along < .05) {
      from = along < .05 ? node : other;
      toward = tree.next[from];
      continue;
    }
    const goToNode = tree.next[other] === node || (tree.next[node] !== other &&
      along + tree.costs[node] < length - along + tree.costs[other]);
    from = goToNode ? other : node;
    toward = goToNode ? node : other;
  }
  if (toward < 0 && activeNodes.at(-1) === from) return activeNodes.length - 2;
  const existing = activeEdges.get(from + '/' + toward);
  if (existing !== undefined) return existing;
  const nodes = [from];
  for (let i = toward; i >= 0; i = tree.next[i]) nodes.push(i);
  setPath(nodes, nodes.map(i => tree.points[i]));
  return 0;
}

function cameraIntrinsics(w, h, layout = station) {
  const c = layout.camera.calibration;
  let fx, fy, cx, cy;
  if (c) {
    if (Math.abs(w/h / (c.width/c.height) - 1) > .02)
      throw new Error('영상 방향과 종횡비가 카메라 보정 파일과 다릅니다.');
    fx = c.fx*w/c.width; fy = c.fy*h/c.height;
    cx = (c.cx+.5)*w/c.width-.5; cy = (c.cy+.5)*h/c.height-.5;
  } else {
    fx = fy = Math.hypot(w,h) / (2*Math.tan(layout.camera.diagonalFovDeg*Math.PI/360));
    cx = (w-1)/2; cy = (h-1)/2;
  }
  return [fx, fy, cx, cy];
}

function detectTags(gray, rejected, own, pinned) {
  const corners = own(new lib.MatVector()), ids = own(new lib.Mat());
  detector.detectMarkers(gray, corners, ids, rejected);
  const detections = [];
  for (let i = 0; i < ids.rows; i++) {
    const id = ids.data32S[i];
    const values = own(corners.get(i)).data32F;
    const image = [0,2,4,6].map(k => [values[k], values[k+1]]);
    const owners = tagSpaces.get(id);
    detections.push({ id, image, registered: pinned ? !!owners?.has(pinned) : !!owners });
  }
  return detections;
}

function recoverContrast(gray, rejected, own) {
  // Use the size of nearby undecoded quads to keep the local mean wider than a tag cell.
  let windowWidth = 17;
  for (let i = 0; i < Math.min(16, rejected.size()); i++) {
    const quad = own(rejected.get(i)).data32F;
    const sides = [0,2,4,6].map(k => Math.hypot(quad[k]-quad[(k+2)%8], quad[k+1]-quad[(k+3)%8]));
    const span = Math.max(...sides);
    if (span < 3 * Math.min(...sides)) windowWidth = Math.max(windowWidth, 2*Math.round(span/5) + 1);
  }
  windowWidth = Math.min(121, windowWidth);
  const detail = own(new lib.Mat()), localMean = own(new lib.Mat());
  lib.LUT(gray, highlightLut, detail);
  lib.blur(detail, localMean, new lib.Size(windowWidth, windowWidth));
  lib.addWeighted(detail, 4, localMean, -4, 128, detail);
  return detail;
}

function sameOutline(a, b) {
  const tolerance = .15 * Math.min(...a.map((p, i) => distance(p, a[(i+1)%4])));
  return a.every(p => b.some(q => distance(p, q) <= tolerance));
}

function usableTags(detections) {
  const visible = new Map(), duplicates = new Set();
  for (const { id, image, registered } of detections) {
    if (!registered) continue;
    if (image.some((p,j) => distance(p, image[(j+1)%4]) < 22)) continue;
    if (visible.has(id)) duplicates.add(id);
    visible.set(id, { id, image });
  }
  for (const id of duplicates) visible.delete(id);
  return [...visible.values()];
}

function matchingSpaces(tags, pinned, preferred) {
  if (pinned) return [pinned];
  if (!tags.length) return [];
  const matches = [...tagSpaces.get(tags[0].id)].filter(space => tags.every(tag => tagSpaces.get(tag.id).has(space)));
  return matches.includes(preferred) ? [preferred] : matches;
}

// Decoding an ID can succeed even when its corners cannot support a camera pose.
function findReferenceTag(detections, pinned, preferred) {
  const registered = detections.filter(tag => tag.registered);
  if (!registered.length || new Set(registered.map(tag => tag.id)).size !== registered.length) return {};
  const candidates = matchingSpaces(registered, pinned, preferred);
  if (candidates.length !== 1) return { candidates };
  // Favor the most prominent decoded marker when several share the same floor plan.
  const span = tag => distance(tag.image[0], tag.image[2]) + distance(tag.image[1], tag.image[3]);
  const tag = registered.reduce((best, next) => span(next) > span(best) ? next : best);
  return { referenceTag: { spaceId: candidates[0], id: tag.id } };
}

function correspondences(tags, own) {
  const corners = tags.flatMap(tag => tag.corners);
  return {
    corners,
    object: own(lib.matFromArray(corners.length, 1, lib.CV_64FC3, corners.flat())),
    image: own(lib.matFromArray(corners.length, 1, lib.CV_64FC2, tags.flatMap(tag => tag.image.flat()))),
  };
}

function routePosition(position, observedSegment) {
  let progress = 0, nearest = Infinity, index = 0;
  for (const [i, seg] of segments.entries()) {
    if (observedSegment !== undefined && i !== observedSegment) continue;
    const t = Math.min(seg.length, Math.max(0, (position[0]-seg.a[0])*seg.dx + (position[1]-seg.a[1])*seg.dy));
    const d = distance(position, [seg.a[0]+seg.dx*t, seg.a[1]+seg.dy*t]);
    if (d < nearest) { nearest = d; progress = seg.along + t; index = i; }
  }
  if (nearest > 1.5) return null;
  // Allow a small overshoot past the vertex: the next segment may already be the nearest.
  let maneuver = { kind: 'straight', index: segments[index].section };
  let closestTurn = Infinity;
  for (const [corner, next] of segments.entries()) {
    if (!next.turn) continue;
    const ahead = next.along - progress;
    if (ahead < -.6 || ahead > 1.2 || Math.abs(ahead) >= closestTurn) continue;
    closestTurn = Math.abs(ahead);
    maneuver = { kind: next.turn, index: corner };
  }
  return { progress, segment: segments[index], maneuver };
}

function arrowAt(route, tags, project, bounds) {
  if (!route) return null;
  const shape = [[-.048,-.20],[.048,-.20],[.048,.015],[.12,.015],[0,.20],[-.12,.015],[-.048,.015]];
  for (const [i, seg] of segments.entries()) {
    if (route.maneuver.kind !== 'straight' && i < route.maneuver.index) continue;
    for (let t = 0; t < seg.length - .2; t += .65) {
      const ahead = seg.along + t - route.progress;
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

// A 9 cm stripe in the station's floor coordinates. Only project the nearby
// part of the route, and clip faces before perspective division at the camera.
function guideAt(route, project, depth) {
  if (!route) return [];
  const halfWidth = .045, near = .1;
  const from = route.progress - .45, to = route.progress + 4;
  const faces = [];
  function addFace(face) {
    const clipped = [];
    let a = face.at(-1), za = depth(a);
    for (const b of face) {
      const zb = depth(b);
      if ((za >= near) !== (zb >= near)) {
        const t = (near - za) / (zb - za);
        clipped.push([a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])]);
      }
      if (zb >= near) clipped.push(b);
      a = b; za = zb;
    }
    if (clipped.length >= 3) faces.push(clipped);
  }
  for (const seg of segments) {
    if (seg.along >= to) break;
    const start = Math.max(0, from - seg.along), end = Math.min(seg.length, to - seg.along);
    if (start >= end) continue;
    const edge = (t, side) => [seg.a[0] + seg.dx*t - side*seg.dy*halfWidth,
      seg.a[1] + seg.dy*t + side*seg.dx*halfWidth];
    // Short faces follow curved lens distortion when the camera is calibrated.
    for (let t = start; t < end; t += .5) {
      const next = Math.min(t + .5, end);
      addFace([edge(t, 1), edge(t, -1), edge(next, -1), edge(next, 1)]);
    }
    if (start === 0 && seg.along > from && seg.along > 0) {
      addFace(Array.from({ length: 12 }, (_, i) => {
        const angle = i * Math.PI / 6;
        return [seg.a[0] + halfWidth*Math.cos(angle), seg.a[1] + halfWidth*Math.sin(angle)];
      }));
    }
  }
  if (!faces.length) return [];
  const pixels = project(faces.flat());
  if (!pixels) return [];
  let index = 0;
  return faces.map(face => {
    const polygon = pixels.slice(index, index + face.length);
    index += face.length;
    return polygon;
  }).filter(polygon => polygon.every(xy));
}

function projectFloor(points, K, dist, r, t, own) {
  const xyz = own(lib.matFromArray(points.length, 1, lib.CV_64FC3, points.flatMap(([x,y]) => [x,y,0])));
  const uv = own(new lib.Mat());
  lib.projectPoints(xyz, r, t, K, dist, uv);
  const pixels = uv.data64F;
  return points.map((_, i) => [pixels[i*2], pixels[i*2+1]]);
}

function cameraMatrix([fx, fy, cx, cy], own) {
  return own(lib.matFromArray(3, 3, lib.CV_64F, [fx,0,cx, 0,fy,cy, 0,0,1]));
}

function cameraPose(R, T) {
  const position = [0,1,2].map(j => -(R[j]*T[0]+R[j+3]*T[1]+R[j+6]*T[2]));
  return { position, cameraToWorld: [
    R[0], R[3], R[6], position[0],
    R[1], R[4], R[7], position[1],
    R[2], R[5], R[8], position[2],
    0, 0, 0, 1,
  ] };
}

// Intersect a pixel ray from the previous camera pose with the station floor (Z=0).
function floorPoint(u, v, m, [fx, fy, cx, cy]) {
  const x = (u - cx) / fx, y = (v - cy) / fy;
  const depth = -m[11] / (m[8]*x + m[9]*y + m[10]);
  if (!(depth > 0 && depth < 4.5)) return;
  return [m[3] + depth*(m[0]*x + m[1]*y + m[2]), m[7] + depth*(m[4]*x + m[5]*y + m[6]), 0];
}

function measureFloor(ref, gray, intrinsics, K, dt, own) {
  // A surviving feature keeps the station coordinates it was first assigned.
  // Reproject only new corners, so a noisy pose cannot move every landmark.
  const landmarks = ref.landmarks.slice();
  if (landmarks.length < 80) {
    const corners = own(new lib.Mat());
    lib.goodFeaturesToTrack(ref.gray, corners, 160, .015, 8);
    for (let i = 0; i < corners.rows; i++) {
      const u = corners.data32F[2*i], v = corners.data32F[2*i+1];
      const point = floorPoint(u, v, ref.cameraToWorld, intrinsics);
      if (point && !ref.landmarks.some(({ pixel }) => (u-pixel[0])**2 + (v-pixel[1])**2 < 64))
        landmarks.push({ point, pixel: [u, v] });
    }
  }
  if (landmarks.length < 12) return;
  const prev = own(lib.matFromArray(landmarks.length, 1, lib.CV_32FC2, landmarks.flatMap(p => p.pixel)));
  const next = own(new lib.Mat()), status = own(new lib.Mat()), error = own(new lib.Mat());
  lib.calcOpticalFlowPyrLK(ref.gray, gray, prev, next, status, error);
  const back = own(new lib.Mat()), backStatus = own(new lib.Mat());
  lib.calcOpticalFlowPyrLK(gray, ref.gray, next, back, backStatus, own(new lib.Mat()));
  const matches = [];
  for (let i = 0; i < landmarks.length; i++) {
    const u = next.data32F[2*i], v = next.data32F[2*i+1];
    const { point, pixel } = landmarks[i];
    if (!status.data[i] || !backStatus.data[i] || error.data32F[i] > 14 ||
        Math.hypot(back.data32F[2*i]-pixel[0], back.data32F[2*i+1]-pixel[1]) > 1 ||
        u < 0 || v < 0 || u >= gray.cols || v >= gray.rows) continue;
    matches.push({ point, pixel: [u, v] });
  }
  const count = matches.length;
  if (count < 12) return;
  const xyz = own(lib.matFromArray(count, 1, lib.CV_32FC3, matches.flatMap(p => p.point)));
  const uv = own(lib.matFromArray(count, 1, lib.CV_32FC2, matches.flatMap(p => p.pixel)));
  const r = own(new lib.Mat()), t = own(new lib.Mat()), inliers = own(new lib.Mat());
  if (!lib.solvePnPRansac(xyz, uv, K, own(new lib.Mat()), r, t, false, 80, 1.4, .99, inliers, lib.SOLVEPNP_ITERATIVE) ||
      inliers.rows < Math.max(10, count * .7)) return;
  // A small moving patch cannot establish the floor's motion.
  const tracked = Array.from(inliers.data32S, i => matches[i]);
  const xs = tracked.map(p => p.pixel[0]), ys = tracked.map(p => p.pixel[1]);
  if (Math.max(...xs) - Math.min(...xs) < gray.cols * .25 || Math.max(...ys) - Math.min(...ys) < gray.rows * .12) return;
  const rot = own(new lib.Mat());
  lib.Rodrigues(r, rot);
  const pose = cameraPose(rot.data64F, t.data64F), [x,y,z] = pose.position;
  const m = ref.cameraToWorld;
  if (!pose.position.every(Number.isFinite) || z < .12 || z > 3.2 || Math.abs(z-m[11]) > .08 + dt ||
      Math.hypot(x-m[3], y-m[7]) > .05 + dt * 3.5) return;
  return { pose, landmarks: tracked, r, t };
}

function updateFloor(gray, result, timeMs, floorAnchor, selection, own) {
  const ref = floorReference;
  const spaceId = result.fix ? result.spaceId : ref?.spaceId;
  const layout = layouts.get(spaceId);
  if (!layout || !Number.isFinite(timeMs) || (!result.fix && (result.candidates ||
      (result.referenceTag && result.referenceTag.spaceId !== spaceId) || (selection && selection !== spaceId)))) {
    floorReference?.gray.delete(); floorReference = undefined;
    return;
  }
  const scale = Math.min(1, 480 / Math.max(gray.cols, gray.rows));
  const w = Math.round(gray.cols * scale), h = Math.round(gray.rows * scale);
  const compatible = ref && ref.spaceId === spaceId && ref.gray.cols === w && ref.gray.rows === h;
  const dt = compatible ? (timeMs - ref.timeMs) / 1000 : Infinity;
  if (!result.fix) {
    // Only a tag or a match back to an accepted visual frame can anchor floor points.
    if (!compatible || dt < 0 || dt > 1) {
      ref?.gray.delete(); floorReference = undefined; return;
    }
    if (floorAnchor?.spaceId !== spaceId || floorAnchor.timeMs !== ref.timeMs) return;
    if (timeMs - ref.lastAttemptMs < 100) { result.pendingFloorSpace = spaceId; return; }
    ref.lastAttemptMs = timeMs;
  }
  const [fx, fy, cx, cy] = cameraIntrinsics(gray.cols, gray.rows, layout);
  const sx = w / gray.cols, sy = h / gray.rows;
  const intrinsics = [fx*sx, fy*sy, (cx+.5)*sx-.5, (cy+.5)*sy-.5];
  const K = cameraMatrix(intrinsics, own);
  let small = own(new lib.Mat());
  lib.resize(gray, small, new lib.Size(w, h), 0, 0, lib.INTER_AREA);
  const coefficients = layout.camera.calibration?.distortion;
  if (coefficients?.some(v => v !== 0)) {
    const flat = own(new lib.Mat()), dist = own(lib.matFromArray(coefficients.length, 1, lib.CV_64F, coefficients));
    lib.undistort(small, flat, K, dist); small = flat;
  }
  let camera = result.fix;
  let landmarks = [];
  if (!camera) {
    const match = measureFloor(ref, small, intrinsics, K, dt, own);
    if (!match) return;
    camera = match.pose;
    landmarks = match.landmarks;
    result.floorMotion = { spaceId, referenceTimeMs: ref.timeMs, ...camera };
    if (layout === station && segments.length && distance(camera.position, activePoints.at(-1)) >= .3) {
      const m = camera.cameraToWorld;
      const depth = ([x,y]) => (x-m[3])*m[2] + (y-m[7])*m[6] - m[11]*m[10];
      const fullK = cameraMatrix([fx, fy, cx, cy], own);
      const lens = coefficients ?? [0,0,0,0,0];
      const dist = own(lib.matFromArray(lens.length, 1, lib.CV_64F, lens));
      result.floorMotion.guide = guideAt(routePosition(camera.position),
        points => projectFloor(points, fullK, dist, match.r, match.t, own), depth);
    }
  }
  const retained = ref?.gray ?? new lib.Mat();
  small.copyTo(retained);
  floorReference = { spaceId, gray: retained, cameraToWorld: camera.cameraToWorld, timeMs, lastAttemptMs: timeMs, landmarks };
}

function track({ rgba, w, h, bounds = [0, 0, w, h], pinnedSpace, preferredSpace, frameTimeMs, floorAnchor, motionCamera, knownRoute }) {
  const owned = [];
  const own = (m) => { owned.push(m); return m; };
  const result = { type: 'frame', detections: [], fix: null };
  const pinned = pinnedSpace ?? (layouts.size === 1 ? layouts.keys().next().value : undefined);
  try {
    const image = own(new lib.Mat(h, w, lib.CV_8UC4));
    image.data.set(new Uint8Array(rgba));
    const gray = own(new lib.Mat()), rejected = own(new lib.MatVector());
    lib.cvtColor(image, gray, lib.COLOR_RGBA2GRAY);
    result.detections = detectTags(gray, rejected, own, pinned);
    let tags = usableTags(result.detections);
    if (!result.detections.length || (tagSpaces.size && !tags.length)) {
      const enhanced = recoverContrast(gray, rejected, own);
      const recovered = detectTags(enhanced, rejected, own, pinned);
      // Keep the raw corners for an outline decoded twice. Separate copies of one ID
      // must still reach usableTags so its duplicate-ID check can reject the pose.
      const additional = recovered.filter(tag => !result.detections.some(raw => sameOutline(raw.image, tag.image)));
      result.detections.push(...additional);
      if (additional.length) tags = usableTags(result.detections);
    }
    const candidates = matchingSpaces(tags, pinned, preferredSpace);
    if (candidates.length === 1) {
      result.spaceId = candidates[0];
      const layout = layouts.get(result.spaceId);
      if (layout !== station) configure(layout);
      result.intrinsics = cameraIntrinsics(w, h);
      if (tags.length) {
        const fix = locate(tags.map(tag => ({ ...tag, ...anchors.get(tag.id) })), bounds, result.intrinsics, own, result.spaceId, frameTimeMs);
        result.fix = fix;
        if (fix) {
          result.routeRevision = routeRevision;
          if (knownRoute !== routeRevision) result.route = activePoints;
        }
      }
    } else if (tags.length) {
      result.candidates = candidates;
    }
    if (result.fix) {
      const locatedTags = result.detections.filter(tag => result.fix.ids.includes(tag.id));
      Object.assign(result, findReferenceTag(locatedTags, result.spaceId, preferredSpace));
    } else Object.assign(result, findReferenceTag(result.detections, pinned, preferredSpace));
    // Older camera bundles share this public worker. Their active space can
    // request a match, but only our retained visual frame supplies coordinates.
    const anchor = floorAnchor ?? (motionCamera && { spaceId: motionCamera.spaceId, timeMs: floorReference?.timeMs });
    updateFloor(gray, result, frameTimeMs, anchor, pinned ?? preferredSpace, own);
  } catch (error) {
    // A failed pose or incompatible calibration still leaves decoded image-space tag outlines.
    if (!result.fix) Object.assign(result, findReferenceTag(result.detections, pinned, preferredSpace));
    reportFrameError(error);
  } finally {
    for (let i = owned.length-1; i >= 0; i--) owned[i].delete();
  }
  return result;
}

function locate(tags, bounds, intrinsics, own, spaceId, frameTimeMs) {
  const K = cameraMatrix(intrinsics, own);
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
  const { position, cameraToWorld } = cameraPose(R, T);
  const depth = ([x,y,z = 0]) => R[6]*x + R[7]*y + R[8]*z + T[2];
  const onFloor = pairs.corners.every(p => Math.abs(p[2]) < 1e-6);
  if (!position.every(Number.isFinite) || (onFloor && (position[2] < .12 || position[2] > 3.2)) || pairs.corners.some(p => depth(p) <= .05))
    return null;
  const projected = own(new lib.Mat());
  lib.projectPoints(pairs.object, r, t, K, dist, projected);
  const observed = pairs.image.data64F, reproj = projected.data64F;
  let squared = 0;
  for (let k = 0; k < observed.length; k++) squared += (reproj[k]-observed[k])**2;
  const rmsPx = Math.sqrt(squared / pairs.corners.length);
  if (!(rmsPx <= 2.5)) return null;

  // On the common floor plane the pixel homography needs no focal-length estimate.
  // With a calibrated lens, project through its measured distortion instead.
  let H;
  if (onFloor && !station.camera.calibration) {
    const floor = own(lib.matFromArray(pairs.corners.length, 1, lib.CV_64FC2, pairs.corners.flatMap(([x,y]) => [x,y])));
    H = own(lib.findHomography(floor, pairs.image, 0)).data64F;
    if (H.length !== 9) return null;
  }
  function project(outline) {
    if (outline.some(p => depth(p) < .08)) return null;
    if (H) return outline.map(([x,y]) => {
      const z = H[6]*x + H[7]*y + H[8];
      return [(H[0]*x+H[1]*y+H[2])/z, (H[3]*x+H[4]*y+H[5])/z];
    });
    return projectFloor(outline, K, dist, r, t, own);
  }
  if (!confirmedTagPose(spaceId, { position }, frameTimeMs)) return null;
  const tree = trees.get(station);
  const observedSegment = tree && selectPath(tree, tags, position);
  const route = routePosition(position, observedSegment);
  const last = segments.at(-1);
  const remaining = route ? last.along + last.length - route.progress : activePoints.length === 1 ? 0 : Infinity;
  const endDistance = activePoints.length ? distance(position, activePoints.at(-1)) : Infinity;
  const arrived = Math.max(remaining, endDistance) < .3;
  // The rear lens can face back down the corridor while the position is on the route.
  // A nearly vertical lens gives no usable horizontal bearing.
  if (route?.maneuver.kind === 'straight') {
    const x = cameraToWorld[2], y = cameraToWorld[6], horizontal = Math.hypot(x, y);
    if (horizontal >= .3 && x * route.segment.dx + y * route.segment.dy < -.5 * horizontal)
      route.maneuver = { kind: 'realign', index: route.segment.section };
  }
  return { position, cameraToWorld, ids: tags.map(tag => tag.id), rmsPx, arrived, destinationDistance: Math.max(remaining, endDistance), maneuver: route?.maneuver,
    guide: arrived ? [] : guideAt(route, project, depth),
    arrow: arrived ? null : arrowAt(route, tags, project, bounds) };
}

self.onmessage = ({ data }) => {
  if (data.type === 'destination') {
    const layout = layouts.get(data.spaceId);
    if (layout) {
      trees.set(layout, data.tree);
      if (station === layout) configure(layout);
    }
    return;
  }
  if (data.type === 'init') {
    function ready(cv) {
      try {
        lib = cv;
        const dictionary = lib.getPredefinedDictionary(lib.DICT_APRILTAG_36h11);
        const params = new lib.aruco_DetectorParameters(), refine = new lib.aruco_RefineParameters(10, 3, true);
        params.cornerRefinementMethod = lib.CORNER_REFINE_SUBPIX;
        detector = new lib.aruco_ArucoDetector(dictionary, params, refine);
        dictionary.delete(); params.delete(); refine.delete();
        // Expand the remaining grayscale steps close to white before removing the illumination gradient.
        highlightLut = lib.matFromArray(1, 256, lib.CV_8U, Array.from({ length: 256 }, (_, i) =>
          Math.round(255 * (1 - Math.log(256 - i) / Math.log(256)))));
        self.postMessage({ type: 'ready' });
      } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    }
    try {
      lastTagPose = unconfirmedTagPose = undefined;
      const spaces = data.spaces ?? [{ id: 'default', station: data.station }];
      layouts = new Map(spaces.map(space => [space.id, space.station]));
      trees = new Map(spaces.filter(space => space.tree).map(space => [space.station, space.tree]));
      tagSpaces = new Map();
      for (const [id, layout] of layouts) {
        for (const tag of layout.tags) {
          if (!tagSpaces.has(tag.id)) tagSpaces.set(tag.id, new Set());
          tagSpaces.get(tag.id).add(id);
        }
      }
      if (layouts.size === 1) configure(layouts.values().next().value);
      importScripts(data.library);
      if (self.cv.Mat) ready(self.cv);
      else self.cv.then(ready);
    } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    return;
  }
  const frame = track(data);
  const recordedLayout = layouts.get(data.recordingSpaceId);
  if (recordedLayout) {
    // Each recording has one station snapshot, even if live tracking moves on to another space.
    try {
      frame.recording = { spaceId: data.recordingSpaceId, intrinsics: cameraIntrinsics(data.w, data.h, recordedLayout),
        fix: data.recordingSpaceId === frame.spaceId ? frame.fix : null };
    } catch (error) { reportFrameError(error); }
  }
  self.postMessage(frame);
};
