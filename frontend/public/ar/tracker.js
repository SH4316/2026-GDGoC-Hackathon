/* Classic worker: the OpenCV distribution initialises WebAssembly via importScripts. */
'use strict';

let lib, dictionary, detector, highlightLut, station, anchors, segments;
const markerPrints = new Map();
let reportedFrameError = false;
let layouts, tagSpaces, trees;
let activePoints = [], activeNodes = [], activeEdges = new Map(), routeRevision = 0;
let incident = [];
let floorReference;
let motionReference;
let lastTagPose, unconfirmedTagPose;
let corridorHeadingEnabled = true, corridorFilter;
let corridorEnds = [], corridorEdges = [];
let guideView;
let lensViewport;
const GUIDE_AHEAD_M = 6;

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
  const points = tree?.points ?? map.route;
  const edges = tree?.edges ?? points.slice(1).map((_, i) => [i, i+1]);
  corridorEnds = points.filter((_, i) => tree ? incident[i].length !== 2 : i === 0 || i === points.length - 1);
  corridorEdges = edges.map(([a, b]) => {
    const length = distance(points[a], points[b]);
    return { a: points[a], dx: (points[b][0] - points[a][0])/length, dy: (points[b][1] - points[a][1])/length, length };
  });
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
  corridorFilter = undefined;
  guideView = undefined;
  motionReference = undefined;
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
    const angle = previous ? Math.atan2(previous.dx*dy - previous.dy*dx, previous.dx*dx + previous.dy*dy) : 0;
    let turn;
    if (Math.abs(angle) >= Math.PI / 5) turn = Math.abs(angle) > Math.PI * .85 ? 'uturn' : angle > 0 ? 'left' : 'right';
    // Collinear route vertices describe a single straight instruction.
    const section = turn ? i - 1 : previous?.section ?? 0;
    // Tags can split a surveyed straight run into many collinear graph edges.
    const straightFrom = previous && Math.abs(angle) < 1e-5 ? previous.straightFrom : along;
    segments.push({ a, length, along, dx, dy, turn, section, straightFrom, sharp: Math.abs(angle) >= 50 * Math.PI / 180 });
    along += length;
  }
  let straightTo = along;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    segment.straightTo = straightTo;
    if (segment.straightFrom === segment.along) straightTo = segment.along;
  }
}

// Project the camera only onto passages incident to the observed tag. At a fork,
// walking partway along either direction of that edge has a different remaining cost.
function selectPath(tree, tags, position) {
  // Tags off the surveyed path can localize the camera but cannot identify an aisle.
  let node, nearestTag = Infinity;
  for (const tag of tags) {
    const anchor = tree.anchors[tag.id];
    const gap = distance(tag.center, position);
    if (anchor !== undefined && gap < nearestTag) {
      node = anchor;
      nearestTag = gap;
    }
  }
  if (node === undefined && station.route.length && !station.tagGraph && !station.autoRoute && activeNodes.length) {
    // Localization-only markers along a surveyed corridor still measure the
    // walker. Continue the existing path if the fix identifies its interior.
    const route = routePosition(position);
    if (route) {
      const foot = isolatedProjection(position, route.segment);
      const along = foot && route.segment.along + foot.along;
      if (along > route.segment.straightFrom && along < route.segment.straightTo) return route.segmentIndex;
    }
  }
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

function projectToPassage(position, edge) {
  const x = position[0] - edge.a[0], y = position[1] - edge.a[1];
  const along = x*edge.dx + y*edge.dy;
  const t = Math.max(0, Math.min(edge.length, along));
  const dx = t*edge.dx - x, dy = t*edge.dy - y;
  return { along, t, dx, dy, gap: Math.hypot(dx, dy) };
}

function isolatedProjection(position, segment) {
  const foot = projectToPassage(position, segment);
  const ambiguous = corridorEdges.some(edge => {
    // Collinear tag splits along this same surveyed aisle are compatible.
    const parallel = Math.abs(edge.dx*segment.dy - edge.dy*segment.dx) < 1e-5;
    const separation = Math.abs((edge.a[0]-segment.a[0])*segment.dy - (edge.a[1]-segment.a[1])*segment.dx);
    if (parallel && separation < .05) return false;
    return projectToPassage(position, edge).gap <= foot.gap + .15;
  });
  return ambiguous ? undefined : foot;
}

function routePosition(position, observedSegment) {
  let progress = 0, nearest = Infinity, index = 0, lateral = 0;
  const candidates = [];
  for (const [i, seg] of segments.entries()) {
    if (observedSegment !== undefined && i !== observedSegment) continue;
    const { t, gap: d } = projectToPassage(position, seg);
    const along = seg.along + t;
    candidates.push({ d, along });
    if (d < nearest) {
      nearest = d; progress = along; index = i;
      lateral = seg.dx*(position[1]-seg.a[1]) - seg.dy*(position[0]-seg.a[0]);
    }
  }
  if (nearest > 1.5 || candidates.some(c => c.d <= nearest + .15 && Math.abs(c.along - progress) > 2)) return null;
  let maneuver = { kind: 'straight', index: segments[index].section };
  // Announce an upcoming turn separately from the instruction to turn at its vertex.
  for (const [corner, next] of segments.entries()) {
    if (!next.turn) continue;
    const ahead = next.along - progress;
    if (ahead < -.6) continue;
    if (ahead <= 10) maneuver = { kind: next.turn, index: corner, stage: ahead > 1.2 ? 'soon' : 'now' };
    break;
  }
  return { progress, segment: segments[index], segmentIndex: index, lateral, gap: nearest, maneuver };
}

// The visual axis is unoriented: looking back down a corridor gives the same
// vanishing point as a forward-facing camera looking along the reverse edge.
function corridorCorrection(gray, intrinsics, route, position, headingDeg, up, timeMs, spaceId, detections, own) {
  if (!corridorHeadingEnabled || typeof observeCorridorHeading !== 'function' || !Number.isFinite(timeMs)) return;
  if (!route || route.gap > 1 || !Number.isFinite(headingDeg) || !up.every(Number.isFinite) ||
      up[2] < -.85 || up[2] > .42) {
    corridorFilter = undefined;
    return;
  }
  const { dx, dy } = route.segment;
  const axis = Math.atan2(dx, dy) * 180 / Math.PI;
  const expected = ((axis - headingDeg + 450) % 180) - 90;
  // A branch, crossing, or end platform can have strong lines from a different aisle.
  const besideOtherAisle = corridorEdges.some(edge => {
    if (Math.abs(dx*edge.dy - dy*edge.dx) < .26) return false;
    const x = position[0] - edge.a[0], y = position[1] - edge.a[1];
    const t = Math.max(0, Math.min(edge.length, x*edge.dx + y*edge.dy));
    return Math.hypot(x - t*edge.dx, y - t*edge.dy) < 2;
  });
  if (Math.abs(expected) > 40 || besideOtherAisle || corridorEnds.some(p => distance(p, position) < 2)) {
    corridorFilter = undefined;
    return;
  }
  if (!corridorFilter || corridorFilter.spaceId !== spaceId || timeMs - corridorFilter.at > 600 ||
      timeMs < corridorFilter.at || Math.abs(Math.sin((axis - corridorFilter.axis) * Math.PI / 180)) > .1)
    corridorFilter = { spaceId, axis, at: -Infinity, samples: [], yawDeg: 0 };
  const state = corridorFilter;
  if (timeMs - state.at >= 180) {
    state.at = timeMs;
    const scale = Math.min(1, 320 / Math.max(gray.cols, gray.rows));
    const w = Math.max(1, Math.round(gray.cols*scale)), h = Math.max(1, Math.round(gray.rows*scale));
    const sx = w/gray.cols, sy = h/gray.rows, [fx, fy, cx, cy] = intrinsics;
    const smallK = [fx*sx, fy*sy, (cx+.5)*sx-.5, (cy+.5)*sy-.5];
    let small = own(new lib.Mat());
    lib.resize(gray, small, new lib.Size(w, h), 0, 0, lib.INTER_AREA);
    let excludedRects = detections.map(tag => {
      const x = tag.image.map(p => (p[0]+.5)*sx-.5), y = tag.image.map(p => (p[1]+.5)*sy-.5);
      return [Math.floor(Math.min(...x)), Math.floor(Math.min(...y)), Math.ceil(Math.max(...x)), Math.ceil(Math.max(...y))];
    });
    const distortion = station.camera.calibration?.distortion;
    if (distortion?.some(k => k !== 0)) {
      const flat = own(new lib.Mat()), coefficients = own(lib.matFromArray(distortion.length, 1, lib.CV_64F, distortion));
      const K = cameraMatrix(smallK, own);
      lib.undistort(small, flat, K, coefficients);
      small = flat;
      // Map the printed edges into the same undistorted pixels used for voting.
      // A marker's own perspective must never be evidence for a corridor.
      excludedRects = excludedRects.map(([x0,y0,x1,y1]) => {
        const mask = own(lib.Mat.zeros(h, w, lib.CV_8U)), flatMask = own(new lib.Mat());
        lib.rectangle(mask, new lib.Point(x0,y0), new lib.Point(x1,y1), new lib.Scalar(255), -1);
        lib.undistort(mask, flatMask, K, coefficients);
        const box = lib.boundingRect(flatMask);
        return [box.x, box.y, box.x+box.width, box.y+box.height];
      });
    }
    const observed = observeCorridorHeading(small.data, w, h, smallK, up, expected, excludedRects);
    const error = expected - observed;
    if (!Number.isFinite(observed) || Math.abs(error) > 12) {
      state.samples = [];
      state.yawDeg = 0;
      return;
    }
    // Samples all refer to raw poses, never to the previously corrected heading.
    const samples = state.samples;
    samples.push(error);
    if (samples.length > 5) samples.shift();
    if (samples.length < 3) return;
    const sorted = [...samples].sort((a,b) => a-b), median = sorted[Math.floor(sorted.length/2)];
    if (Math.abs(error - median) > 2.5 || sorted.at(-1) - sorted[0] > 4) {
      state.samples = [error];
      state.yawDeg = 0;
      return;
    }
    state.yawDeg += Math.max(-1.5, Math.min(1.5, (median - state.yawDeg)*.6));
  }
  // An agreed zero explicitly clears an older bias on IMU-only frames.
  if (state.samples.length >= 3) return { spaceId, yawDeg: Math.abs(state.yawDeg) < .25 ? 0 : state.yawDeg };
}

function relativeAngle(x, y, dx, dy) {
  return Math.atan2(x*dy - y*dx, x*dx + y*dy) * 180 / Math.PI;
}

function directionTo(angle) {
  return Math.abs(angle) >= 125 ? 'behind' : Math.abs(angle) < 35 ? 'forward' : angle > 0 ? 'left' : 'right';
}

function topDownAngle(m, dx, dy) {
  if (!(m[10] < -.9)) return;
  // A downward lens measures floor directions on its image-right and image-down axes.
  const right = m[0]*dx + m[4]*dy, down = m[1]*dx + m[5]*dy;
  if (Math.hypot(right, down) > .001) return Math.atan2(-right, -down) * 180 / Math.PI;
}

function setScreenBearing(view, angle, show = true) {
  if (!Number.isFinite(angle)) return;
  view.routeBearing = { direction: directionTo(angle), angleDeg: -angle };
  if (show) {
    view.screenDirection = view.routeBearing.direction;
    view.screenAngleDeg = -angle; // CSS rotates clockwise from screen-up.
  }
}

function cameraBearing(m, dx, dy) {
  return Math.hypot(m[2], m[6]) >= .3 ? relativeAngle(m[2], m[6], dx, dy) : topDownAngle(m, dx, dy);
}

function guideBackToPassage(view, m, position, segmentIndex) {
  const segment = segments[segmentIndex];
  const foot = segment && isolatedProjection(position, segment);
  if (!foot || foot.gap <= 1.5) return;
  setScreenBearing(view, cameraBearing(m, foot.dx, foot.dy));
  return foot;
}

function guidanceSegment(route) {
  return route.maneuver.stage === 'now' ? segments[route.maneuver.index] : route.segment;
}

function visualGuidance(route, camera, project, depth, bounds, correction, clipPlanes = [], acceptsArrow) {
  if (!route) return { guide: [], arrow: null, floorVisible: false };
  const guide = guideAt(route, project, depth, clipPlanes).map(face => clipToViewport(face, bounds)).filter(face => face.length >= 3);
  return routeDirection(route, camera, guide, arrowAt(route, project, bounds, acceptsArrow), correction);
}

function routeDirection(route, camera, guide, arrow, correction) {
  const m = camera.cameraToWorld;
  let x = m[2], y = m[6];
  if (correction) {
    const rad = correction.yawDeg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    x = c*m[2] + s*m[6];
    y = -s*m[2] + c*m[6];
  }
  const { maneuver } = route;
  const view = { guide, arrow, maneuver, floorVisible: !!(guide.length || arrow) };
  const target = guidanceSegment(route);
  if (!(Math.hypot(x, y) >= .3)) {
    setScreenBearing(view, topDownAngle(m, target.dx, target.dy), !arrow);
    return view;
  }

  const angleTo = s => relativeAngle(x, y, s.dx, s.dy);
  let angle = angleTo(target);
  setScreenBearing(view, angle, !arrow);
  if (maneuver.stage === 'now') {
    // Either the incoming or outgoing bearing is legitimate while the walker turns.
    const entry = angleTo(segments[maneuver.index - 1]);
    if (Math.min(Math.abs(entry), Math.abs(angle)) <= 50) return view;
    if (Math.abs(entry) >= 125) angle = entry;
  }
  const direction = directionTo(angle);
  if (direction === 'behind' || (!arrow && direction !== 'forward')) {
    view.maneuver = { kind: 'realign', index: maneuver.index, direction };
    setScreenBearing(view, angle);
  }
  return view;
}

function visualCorridorCorrection(gray, intrinsics, route, camera, timeMs, spaceId, detections, own) {
  const m = camera.cameraToWorld;
  return corridorCorrection(gray, intrinsics, route, camera.position, Math.atan2(m[2], m[6])*180/Math.PI,
    [m[8],m[9],m[10]], timeMs, spaceId, detections, own);
}

function walkingPreview(walking, knownRoute) {
  if (!walking || knownRoute !== routeRevision || layouts.get(walking.spaceId) !== station) return;
  const route = routePosition(walking.point);
  if (!route?.maneuver.stage || route.gap > 1) return;
  const { dx, dy } = route.segment;
  const rad = walking.headingDeg * Math.PI / 180;
  if (dx*Math.sin(rad) + dy*Math.cos(rad) < Math.cos(Math.PI / 6)) return;
  // Steps alone can give advance notice, but cannot confirm a corner or an arrival.
  if (route.segmentIndex >= route.maneuver.index) return;
  return { spaceId: walking.spaceId, maneuver: { ...route.maneuver, stage: 'soon' } };
}

function smoothFraction(value) {
  const t = Math.min(1, Math.max(0, value));
  return t*t*(3 - 2*t);
}

function guidePoint(route, segment, t, across = 0) {
  const along = segment.along + t, active = route.segment;
  // Keep bends and endpoints surveyed. Only the near part of this straight
  // run moves toward the observed foot position, by at most 60 cm.
  const weight = smoothFraction(Math.min(1 - (along - route.progress) / 2,
    (Math.min(along, route.progress) - active.straightFrom) / .8,
    (active.straightTo - Math.max(along, route.progress)) / .8));
  const lateral = Math.max(-.6, Math.min(.6, route.lateral)) * weight;
  return [segment.a[0] + segment.dx*t - segment.dy*across - active.dy*lateral,
    segment.a[1] + segment.dy*t + segment.dx*across + active.dx*lateral];
}

function visibleGuideEnd(progress) {
  let end = progress + GUIDE_AHEAD_M;
  for (const segment of segments) {
    if (segment.along >= end) break;
    if (!segment.sharp) continue;
    // Show a short exit from the bend. Reveal the rest over the first metre
    // after turning, since we have no wall depth for physical occlusion.
    const passed = Math.max(0, progress - segment.along);
    const beyond = .8 + (GUIDE_AHEAD_M - .8)*smoothFraction(passed);
    end = Math.min(end, segment.along + passed + beyond);
  }
  return end;
}

function arrowAt(route, project, bounds, accepts) {
  if (!route) return null;
  const end = visibleGuideEnd(route.progress);
  const shape = [[-.048,-.20],[.048,-.20],[.048,.015],[.12,.015],[0,.20],[-.12,.015],[-.048,.015]];
  // Prefer a full-size arrow along the visible stripe. A narrow crop or
  // short approach may fit a compact arrow between the regular placements.
  for (const [halfLength, spacing] of [[.2, .65], [.12, .18]]) {
    for (const [i, seg] of segments.entries()) {
      if (seg.along >= end) break;
      if (route.maneuver.stage === 'now' && i < route.maneuver.index) continue;
      // Keep placements continuous across collinear tag vertices and on one side of a bend.
      const half = Math.min(halfLength, (seg.straightTo - seg.straightFrom) / 2);
      const firstCenter = seg.straightFrom + half;
      const first = Math.ceil((Math.max(seg.along, route.progress + Math.min(.15, half)) - firstCenter) / spacing);
      const lastCenter = Math.min(end, seg.straightTo) - half;
      for (let s = firstCenter + first*spacing; s < seg.along + seg.length && s <= lastCenter + 1e-8; s += spacing) {
        const t = s - seg.along, scale = half / .2;
        const outline = shape.map(([x,y]) => guidePoint(route, seg, t + y*scale, -x*scale));
        const points = project(outline);
        if (points && points.every(p => xy(p) && p[0] >= bounds[0] && p[0] < bounds[2] && p[1] >= bounds[1] && p[1] < bounds[3]) &&
            (!accepts || accepts(points)))
          return points;
      }
    }
  }
  return null;
}

// A 9 cm stripe in the station's floor coordinates. Only project the nearby
// part of the route, and clip faces before perspective division at the camera.
function clipFace(face, inside) {
  if (!face.length) return face;
  const clipped = [];
  let a = face.at(-1), da = inside(a);
  for (const b of face) {
    const db = inside(b);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      clipped.push([a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1])]);
    }
    if (db >= 0) clipped.push(b);
    a = b; da = db;
  }
  return clipped;
}

function clipToViewport(face, [left, top, right, bottom]) {
  face = clipFace(face, p => p[0]-left);
  face = clipFace(face, p => right-p[0]);
  face = clipFace(face, p => p[1]-top);
  return clipFace(face, p => bottom-p[1]);
}

function guideAt(route, project, depth, clipPlanes = []) {
  if (!route) return [];
  const halfWidth = .045, near = .1;
  const from = route.progress - .45, to = visibleGuideEnd(route.progress);
  const faces = [];
  function addFace(face) {
    face = clipFace(face, p => depth(p) - near);
    for (const plane of clipPlanes) face = clipFace(face, plane);
    if (face.length >= 3) faces.push(face);
  }
  for (const seg of segments) {
    if (seg.along >= to) break;
    const start = Math.max(0, from - seg.along), end = Math.min(seg.length, to - seg.along);
    if (start >= end) continue;
    const edge = (t, side) => guidePoint(route, seg, t, side*halfWidth);
    // Short faces follow curved lens distortion when the camera is calibrated.
    for (let t = start; t < end; t += .5) {
      const next = Math.min(t + .5, end);
      addFace([edge(t, 1), edge(t, -1), edge(next, -1), edge(next, 1)]);
    }
    if (start === 0 && seg.along > from && seg.along > 0) {
      const center = guidePoint(route, seg, 0);
      addFace(Array.from({ length: 12 }, (_, i) => {
        const angle = i * Math.PI / 6;
        return [center[0] + halfWidth*Math.cos(angle), center[1] + halfWidth*Math.sin(angle)];
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

// Maps a floor point (x, y, 1) into metric camera coordinates before lens distortion.
function floorMatrix(R, T) {
  return [R[0], R[1], T[0], R[3], R[4], T[1], R[6], R[7], T[2]];
}

function transformFloorPoint(matrix, [x, y]) {
  return [matrix[0]*x + matrix[1]*y + matrix[2], matrix[3]*x + matrix[4]*y + matrix[5],
    matrix[6]*x + matrix[7]*y + matrix[8]];
}

function rigidFloor(m) {
  const plane = [];
  for (let i = 0; i < 3; i++)
    plane.push(m[i], m[i+4], -(m[i]*m[3] + m[i+4]*m[7] + m[i+8]*m[11]));
  return plane;
}

function steadyGuideView(route, matrix, cameraToWorld, intrinsics, bounds, timeMs) {
  const previous = guideView, dt = timeMs - previous?.at;
  let { progress, lateral } = route;
  if (dt > 0 && dt < 350 && intrinsics.every((value, i) => value === previous.intrinsics[i])) {
    // Compare the same floor landmarks in both views, even when clipping or a
    // newly visible tag changes the stripe's vertices. Offsets are in focal lengths.
    const [left, top, right, bottom] = bounds;
    let motion = 0, compared = false;
    for (const [u, v] of [[.25, .85], [.75, .85], [.5, .55]]) {
      const point = floorPoint(left + u*(right-left), top + v*(bottom-top), cameraToWorld, intrinsics, 2*GUIDE_AHEAD_M);
      if (!point) continue;
      const [x, y, z] = transformFloorPoint(matrix, point);
      const [px, py, pz] = transformFloorPoint(previous.matrix, point);
      if (z < .1 || pz < .1) continue;
      motion = Math.max(motion, Math.hypot(x/z - px/pz, y/z - py/pz));
      compared = true;
    }
    if (compared) {
      // Quiet views average over 130 ms. A deliberate pan or step catches up
      // immediately once the projected displacement reaches .08 focal lengths.
      const history = Math.exp(-dt / 130) * (1 - smoothFraction((motion - .012) / .068));
      matrix = matrix.map((value, i) => value + history*(previous.matrix[i] - value));
      if (previous.straightFrom === route.segment.straightFrom) {
        progress += history*(previous.progress - progress);
        lateral += history*(previous.lateral - lateral);
      }
    }
  }
  guideView = { at: timeMs, matrix, progress, lateral, straightFrom: route.segment.straightFrom, intrinsics };
  return guideView;
}

// Invert the calibrated Brown-Conrady lens on the branch containing the optical axis.
function lensRay(a, b, [k1,k2,p1,p2,k3=0,k4=0,k5=0,k6=0]) {
  let x = 0, y = 0;
  for (let i = 0; i < 14; i++) {
    const s = x*x+y*y, den = 1+s*(k4+s*(k5+s*k6));
    const radial = (1+s*(k1+s*(k2+s*k3)))/den;
    const slope = (k1+s*(2*k2+3*s*k3) - radial*(k4+s*(2*k5+3*s*k6)))/den;
    const xx = radial+2*x*x*slope+2*p1*y+6*p2*x, xy = 2*x*y*slope+2*p1*x+2*p2*y;
    const yy = radial+2*y*y*slope+6*p1*y+2*p2*x, det = xx*yy-xy*xy;
    if (!(den > 0 && xx > 0 && det > 0)) return;
    const ex = x*radial + 2*p1*x*y + p2*(s+2*x*x) - a;
    const ey = y*radial + p1*(s+2*y*y) + 2*p2*x*y - b;
    if (Math.abs(ex)+Math.abs(ey) < 1e-7) return [x,y];
    x -= (yy*ex-xy*ey)/det;
    y -= (xx*ey-xy*ex)/det;
  }
}

// Invert distortion on the sensor boundary, where the calibration is valid.
// This bounds the rays sent to projectPoints. Far outside the sensor, even ordinary barrel
// distortion polynomials can reverse sign and map the floor back into the sky.
function calibratedRays(lens, intrinsics, bounds) {
  const key = [...intrinsics, ...bounds].join(',');
  if (lensViewport?.lens === lens && lensViewport.key === key) return lensViewport.rays;
  const [fx,fy,cx,cy] = intrinsics, [left,top,right,bottom] = bounds;
  const rays = [Infinity, Infinity, -Infinity, -Infinity];
  function include(u, v) {
    const a = (u-cx)/fx, b = (v-cy)/fy;
    const [x,y] = lensRay(a,b,lens) ?? [a,b];
    rays[0] = Math.min(rays[0],x); rays[1] = Math.min(rays[1],y);
    rays[2] = Math.max(rays[2],x); rays[3] = Math.max(rays[3],y);
  }
  for (let i = 0; i <= 8; i++) {
    const u = left+(right-left)*i/8, v = top+(bottom-top)*i/8;
    include(u,top); include(u,bottom); include(left,v); include(right,v);
  }
  lensViewport = { lens, key, rays };
  return rays;
}

function floorGuidance(route, camera, matrix, intrinsics, bounds, correction, timeMs, own, smooth = true, floorUp, acceptsArrow) {
  if (!route) return { guide: [], arrow: null, floorVisible: false };
  const m = camera.cameraToWorld;
  const up = [m[8], m[9], m[10]];
  // A visual/gyro tilt contradicted by measured gravity cannot support a world-locked overlay.
  if (!(m[11] >= .12 && m[11] <= 3.2) ||
      (floorUp && up.reduce((dot, value, i) => dot + value*floorUp[i], 0) < Math.cos(12*Math.PI/180))) {
    guideView = undefined;
    return routeDirection(route, camera, [], null, correction);
  }
  // Four noisy corners can fit a local homography whose extrapolation reaches camera
  // height within the displayed route. Use the rigid pose for that whole projection.
  const zColumn = i => up[0]*matrix[i]+up[1]*matrix[i+3]+up[2]*matrix[i+6];
  const zx = zColumn(0), zy = zColumn(1);
  const footError = zx*m[3] + zy*m[7] + zColumn(2) + m[11];
  const footprint = GUIDE_AHEAD_M + route.gap + .8;
  if (Math.abs(footError) + footprint*Math.hypot(zx,zy) >= m[11]) matrix = rigidFloor(m);
  if (correction?.yawDeg) {
    // Rotate the floor about the lens centre before smoothing the display.
    const rad = correction.yawDeg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const tx = (1-c)*m[3] + s*m[7], ty = (1-c)*m[7] - s*m[3];
    for (let row = 0; row < 9; row += 3) {
      const a = matrix[row], b = matrix[row+1];
      matrix[row] = a*c + b*s;
      matrix[row+1] = b*c - a*s;
      matrix[row+2] += a*tx + b*ty;
    }
  }
  const view = smooth ? steadyGuideView(route, matrix, m, intrinsics, bounds, timeMs)
    : { matrix, progress: route.progress, lateral: route.lateral };
  const plane = view.matrix.slice(), [fx, fy, cx, cy] = intrinsics;
  // A free tag homography or a blend of successive camera matrices may tilt away
  // from the ground outside the markers. Enforce world Z=0 in the current camera.
  for (let col = 0; col < 3; col++) {
    const elevation = up[0]*plane[col] + up[1]*plane[col+3] + up[2]*plane[col+6] + (col === 2 ? m[11] : 0);
    for (let row = 0; row < 3; row++) plane[3*row+col] -= up[row]*elevation;
  }
  const depth = ([x,y]) => plane[6]*x + plane[7]*y + plane[8];
  const lens = station.camera.calibration?.distortion;
  const dist = lens?.some(k => k !== 0) && own(lib.matFromArray(lens.length, 1, lib.CV_64F, lens));
  const K = dist && cameraMatrix(intrinsics, own), zero = dist && own(lib.Mat.zeros(3, 1, lib.CV_64F));
  // Each camera-space frustum or horizon plane gives a linear inequality on ground XY.
  const clipPlanes = [];
  function addPlane(nx, ny, nz, margin = 0) {
    const a = nx*plane[0] + ny*plane[3] + nz*plane[6], b = nx*plane[1] + ny*plane[4] + nz*plane[7];
    const c = nx*plane[2] + ny*plane[5] + nz*plane[8] - margin;
    clipPlanes.push(([x,y]) => a*x+b*y+c);
  }
  if (dist) {
    const [left,top,right,bottom] = calibratedRays(lens, intrinsics, bounds);
    addPlane(1,0,-left); addPlane(-1,0,right); addPlane(0,1,-top); addPlane(0,-1,bottom);
  }
  if (floorUp) addPlane(-floorUp[0], -floorUp[1], -floorUp[2], .05);
  function project(points) {
    const xyz = points.map(p => transformFloorPoint(plane, p));
    if (xyz.some(p => p[2] < .08) || clipPlanes.some(boundary => points.some(p => boundary(p) < -1e-7))) return null;
    if (!dist) return xyz.map(([x,y,z]) => [cx + fx*x/z, cy + fy*y/z]);
    const object = own(lib.matFromArray(xyz.length, 1, lib.CV_64FC3, xyz.flat()));
    const uv = own(new lib.Mat());
    lib.projectPoints(object, zero, zero, K, dist, uv);
    const pixels = uv.data64F;
    return xyz.map(([x,y,z], i) => {
      const u = pixels[2*i], v = pixels[2*i+1];
      const ray = lensRay((u-cx)/fx, (v-cy)/fy, lens);
      // A folded/singular calibration can map several optical rays to one pixel.
      return ray && Math.hypot(ray[0]-x/z, ray[1]-y/z) < 1e-4 ? [u,v] : null;
    });
  }
  const guidance = visualGuidance({ ...route, progress: view.progress, lateral: view.lateral }, camera,
    project, depth, bounds, correction, clipPlanes, acceptsArrow);
  if (guidance.floorVisible) {
    const normal = floorUp ?? up;
    let minDown = 1;
    // These are the vertices that will be painted, after distortion and viewport clipping.
    function checkRay(u,v) {
      const x = (u-cx)/fx, y = (v-cy)/fy, ray = dist ? lensRay(x,y,lens) : [x,y];
      if (!ray) { minDown = 0; return; }
      const down = -(normal[0]*ray[0]+normal[1]*ray[1]+normal[2])/Math.hypot(...ray,1);
      minDown = Math.min(minDown, down);
    }
    for (const face of [...guidance.guide, guidance.arrow ?? []]) {
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i+1)%face.length];
        checkRay(...a);
        if (dist) checkRay((a[0]+b[0])/2, (a[1]+b[1])/2);
      }
    }
    // A 960px camera overlay strokes up to 2.7px beyond a vertex, plus antialiasing.
    const clearance = Math.asin(Math.max(-1, Math.min(1,minDown))) - Math.atan(4/Math.min(fx,fy));
    if (clearance > 0) guidance.floorTiltLimit = { up: normal, minDot: Math.cos(clearance) };
    else {
      guidance.floorVisible = false;
      guidance.guide = []; guidance.arrow = null;
      if (guidance.routeBearing) {
        guidance.screenDirection = guidance.routeBearing.direction;
        guidance.screenAngleDeg = guidance.routeBearing.angleDeg;
      }
    }
  }
  return guidance;
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

function motionGuidance(camera, knownRoute, timeMs) {
  const m = camera?.cameraToWorld, ref = motionReference;
  if (!ref || ref.spaceId !== camera?.spaceId || ref.timeMs !== camera.referenceTimeMs || !(timeMs >= ref.timeMs) ||
      knownRoute !== routeRevision || layouts.get(ref.spaceId) !== station || !segments.length ||
      !Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite) || !(m[11] > 0)) return;
  const position = [m[3], m[7], m[11]];
  const route = routePosition(position);
  const view = { spaceId: ref.spaceId, guide: [], arrow: null, floorVisible: false };
  if (!route) {
    if (!guideBackToPassage(view, m, position, ref.segmentIndex) && ref.bearing) {
      // Ambiguous translation can still display the last established map bearing in the current view.
      setScreenBearing(view, cameraBearing(m, ref.bearing.dx, ref.bearing.dy));
    }
    return view;
  }
  const last = segments.at(-1);
  if (last.along + last.length - route.progress < .3 && distance(position, activePoints.at(-1)) < .3) return view;
  // Orientation can update a bearing even when the current camera image contains no visible floor.
  return Object.assign(view, routeDirection(route, camera, [], null));
}

// Intersect a pixel ray from the previous camera pose with the station floor (Z=0).
function floorPoint(u, v, m, [fx, fy, cx, cy], maxDepth = 4.5) {
  const x = (u - cx) / fx, y = (v - cy) / fy;
  const depth = -m[11] / (m[8]*x + m[9]*y + m[10]);
  if (!(depth > 0 && depth < maxDepth)) return;
  return [m[3] + depth*(m[0]*x + m[1]*y + m[2]), m[7] + depth*(m[4]*x + m[5]*y + m[6]), 0];
}

// Lucas–Kanade uses the resized, undistorted image. Visibility and colour are sampled in the delivered image.
function deliveredPixel([u,v], [fx,fy,cx,cy], [smallFx,smallFy,smallCx,smallCy], distortion) {
  const x = (u-smallCx)/smallFx, y = (v-smallCy)/smallFy;
  if (!distortion) return [fx*x+cx, fy*y+cy];
  const [k1,k2,p1,p2,k3=0,k4=0,k5=0,k6=0] = distortion;
  const r = x*x+y*y, radial = (1+r*(k1+r*(k2+r*k3))) / (1+r*(k4+r*(k5+r*k6)));
  return [fx*(x*radial+2*p1*x*y+p2*(r+2*x*x))+cx, fy*(y*radial+p1*(r+2*y*y)+2*p2*x*y)+cy];
}

function patchChroma(rgba, w, h, [u,v]) {
  const x = Math.round(u), y = Math.round(v);
  if (!(x >= 2 && x < w-2 && y >= 2 && y < h-2)) return;
  let rg = 0, bg = 0;
  for (let j = -2; j <= 2; j += 2) for (let i = -2; i <= 2; i += 2) {
    const p = 4*((y+j)*w+x+i);
    rg += rgba[p]-rgba[p+1]; bg += rgba[p+2]-rgba[p+1];
  }
  return [rg/9, bg/9];
}

function spansFloor(landmarks, width, height) {
  if (landmarks.length < 10) return false;
  const xs = landmarks.map(p => p.pixel[0]), ys = landmarks.map(p => p.pixel[1]);
  return Math.max(...xs)-Math.min(...xs) >= width*.25 && Math.max(...ys)-Math.min(...ys) >= height*.12;
}

function measureFloor(ref, gray, intrinsics, K, dt, own, rawPixel, rgba) {
  // A surviving feature keeps the station coordinates it was first assigned.
  // Reproject only new corners, so a noisy pose cannot move every landmark.
  const landmarks = ref.landmarks.slice();
  if (landmarks.length < 80) {
    // Rank corners on observed floor. A printed tag, jacket or tiled wall elsewhere
    // in the frame could otherwise use up the entire feature budget.
    const corners = own(new lib.Mat()), mask = own(new lib.Mat(gray.rows, gray.cols, lib.CV_8U));
    const maskBytes = mask.data;
    function observedMaterial([u,v]) {
      return ref.visibility.contains(u,v) && !ref.tagBoxes.some(([left,top,right,bottom]) =>
        u >= left && u <= right && v >= top && v <= bottom);
    }
    for (let y = 0; y < gray.rows; y += 4) {
      const start = y*gray.cols;
      for (let x = 0; x < gray.cols; x += 4) {
        const u = x+1.5, v = y+1.5;
        const valid = floorPoint(u, v, ref.cameraToWorld, intrinsics) && observedMaterial(rawPixel([u,v]));
        maskBytes.fill(valid ? 255 : 0, start+x, start+Math.min(gray.cols,x+4));
      }
      for (let j = 1; j < 4 && y+j < gray.rows; j++)
        maskBytes.copyWithin(start+j*gray.cols, start, start+gray.cols);
    }
    lib.goodFeaturesToTrack(ref.gray, corners, 160, .015, 8, mask);
    for (let i = 0; i < corners.rows; i++) {
      const u = corners.data32F[2*i], v = corners.data32F[2*i+1];
      const point = floorPoint(u, v, ref.cameraToWorld, intrinsics);
      if (!point || ref.landmarks.some(({ pixel }) => (u-pixel[0])**2 + (v-pixel[1])**2 < 64)) continue;
      const raw = rawPixel([u,v]);
      if (observedMaterial(raw)) {
        const chroma = patchChroma(ref.rgba, ref.w, ref.h, raw);
        if (chroma) landmarks.push({ point, pixel: [u,v], chroma });
      }
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
    const { point, pixel, chroma } = landmarks[i];
    if (!status.data[i] || !backStatus.data[i] || error.data32F[i] > 14 ||
        Math.hypot(back.data32F[2*i]-pixel[0], back.data32F[2*i+1]-pixel[1]) > 1 ||
        u < 0 || v < 0 || u >= gray.cols || v >= gray.rows) continue;
    const raw = rawPixel([u,v]), colour = patchChroma(rgba, ref.w, ref.h, raw);
    if (!colour || Math.max(Math.abs(chroma[0]-colour[0]), Math.abs(chroma[1]-colour[1])) > 24) continue;
    matches.push({ point, pixel: [u,v], chroma, raw });
  }
  const count = matches.length;
  if (count < 12) return;
  const floorXY = own(lib.matFromArray(count, 1, lib.CV_32FC2, matches.flatMap(p => p.point.slice(0,2))));
  const uv = own(lib.matFromArray(count, 1, lib.CV_32FC2, matches.flatMap(p => p.pixel)));
  // Every landmark is on Z=0. Fit the plane first so a coplanar minimal PnP
  // sample cannot discard a coherent track, then refine a metric pose on its inliers.
  const inliers = own(new lib.Mat());
  const homography = own(lib.findHomography(floorXY, uv, lib.RANSAC, 1.4, inliers, 150, .99));
  if (homography.empty()) return;
  const tracked = matches.filter((_,i) => inliers.data[i]);
  if (tracked.length < count * .7) return;
  // A small moving patch cannot establish the floor's motion.
  if (!spansFloor(tracked, gray.cols, gray.rows)) return;
  const xyz = own(lib.matFromArray(tracked.length, 1, lib.CV_32FC3, tracked.flatMap(p => p.point)));
  const observed = own(lib.matFromArray(tracked.length, 1, lib.CV_32FC2, tracked.flatMap(p => p.pixel)));
  const r = own(new lib.Mat()), t = own(new lib.Mat()), rot = own(new lib.Mat());
  if (!lib.solvePnP(xyz, observed, K, own(new lib.Mat()), r, t, false, lib.SOLVEPNP_ITERATIVE)) return;
  lib.Rodrigues(r, rot);
  const pose = cameraPose(rot.data64F, t.data64F), [x,y,z] = pose.position;
  const m = ref.cameraToWorld;
  if (!pose.position.every(Number.isFinite) || z < .12 || z > 3.2 || Math.abs(z-m[11]) > .08 + dt ||
      Math.hypot(x-m[3], y-m[7]) > .05 + dt * 3.5) return;
  return { pose, landmarks: tracked, plane: floorMatrix(rot.data64F, t.data64F) };
}

function updateFloor(gray, result, timeMs, floorAnchor, selection, bounds, own, floorUp, rgba, tagVisibility) {
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
  const compatible = ref && ref.spaceId === spaceId && ref.w === gray.cols && ref.h === gray.rows;
  const dt = compatible ? (timeMs - ref.timeMs) / 1000 : Infinity;
  if (!tagVisibility) {
    // A wall tag may update the pose while previously confirmed floor remains in view.
    if (!compatible || !ref.visibility || dt < 0 || dt > 1) {
      ref?.gray.delete(); floorReference = undefined; return;
    }
    if (!result.fix && (floorAnchor?.spaceId !== spaceId || floorAnchor.timeMs !== ref.timeMs)) return;
    const retrying = ref.lastAttemptMs > ref.timeMs;
    if (retrying && timeMs - ref.lastAttemptMs < 100) {
      if (!result.fix) result.pendingFloorSpace = spaceId;
      return;
    }
    ref.lastAttemptMs = timeMs;
  }
  const full = cameraIntrinsics(gray.cols, gray.rows, layout);
  const [fx, fy, cx, cy] = full;
  const sx = w / gray.cols, sy = h / gray.rows;
  const intrinsics = [fx*sx, fy*sy, (cx+.5)*sx-.5, (cy+.5)*sy-.5];
  const K = cameraMatrix(intrinsics, own);
  let small = own(new lib.Mat());
  lib.resize(gray, small, new lib.Size(w, h), 0, 0, lib.INTER_AREA);
  const lens = layout.camera.calibration?.distortion;
  const coefficients = lens?.some(v => v !== 0) ? lens : undefined;
  if (coefficients) {
    const flat = own(new lib.Mat()), dist = own(lib.matFromArray(coefficients.length, 1, lib.CV_64F, coefficients));
    lib.undistort(small, flat, K, dist); small = flat;
  }
  let camera = result.fix;
  let landmarks = [];
  let visibility = tagVisibility;
  let match;
  if (!visibility) {
    const rawPixel = pixel => deliveredPixel(pixel, full, intrinsics, coefficients);
    match = measureFloor(ref, small, intrinsics, K, dt, own, rawPixel, rgba);
    if (!match) return;
    if (camera) {
      // Both measurements refer to the same exposure; disagreeing poses cannot confirm the same floor.
      const a = camera.cameraToWorld, b = match.pose.cameraToWorld;
      if (Math.hypot(...camera.position.map((p,i) => p-match.pose.position[i])) > .20 ||
          a[2]*b[2]+a[6]*b[6]+a[10]*b[10] < Math.cos(8*Math.PI/180)) return;
    }
    visibility = buildFloorVisibility(rgba, gray.cols, gray.rows, [], match.landmarks.map(p => p.raw));
    if (!visibility) return;
    landmarks = match.landmarks.filter(p => visibility.contains(...p.raw));
    if (!spansFloor(landmarks, w, h)) return;
  }
  if (!camera) {
    camera = match.pose;
    result.floorMotion = { spaceId, referenceTimeMs: ref.timeMs, ...camera };
    if (layout === station && segments.length) {
      const route = routePosition(camera.position);
      result.corridorHeading = visualCorridorCorrection(gray, [fx,fy,cx,cy], route, camera, timeMs, spaceId, result.detections, own);
      const last = segments.at(-1);
      if (route && last.along + last.length - route.progress < .3 && distance(camera.position, activePoints.at(-1)) < .3) {
        result.floorMotion.maneuver = { kind: 'confirm', index: route.segmentIndex };
        motionReference = undefined;
      } else {
        Object.assign(result.floorMotion, floorGuidance(route, camera, match.plane, [fx,fy,cx,cy],
          bounds, result.corridorHeading, timeMs, own, true, floorUp, visibleArrow(visibility, gray.cols)));
        if (motionReference?.timeMs === ref.timeMs) {
          const segmentIndex = route?.segmentIndex ?? motionReference.segmentIndex;
          const bearing = route ? guidanceSegment(route) : guideBackToPassage(result.floorMotion, camera.cameraToWorld,
            camera.position, segmentIndex) ?? motionReference.bearing;
          motionReference = { spaceId, timeMs, segmentIndex, bearing };
        }
      }
    }
  }
  const retained = ref?.gray ?? new lib.Mat();
  small.copyTo(retained);
  // Printed edges disappear when a marker is covered and do not describe the floor material.
  const pad = 3 / Math.min(sx,sy);
  const tagBoxes = result.detections.map(({image}) => {
    const xs = image.map(p => p[0]), ys = image.map(p => p[1]);
    return [Math.min(...xs)-pad, Math.min(...ys)-pad, Math.max(...xs)+pad, Math.max(...ys)+pad];
  });
  floorReference = { spaceId, gray: retained, cameraToWorld: camera.cameraToWorld, timeMs, lastAttemptMs: timeMs,
    landmarks, visibility, tagBoxes, rgba, w: gray.cols, h: gray.rows };
  return visibility;
}

function visibleArrow(visibility, width) {
  const margin = Math.max(1.5, width/310)/2 + 1;
  return points => visibility?.covers(points, margin);
}

function taggedFloorVisibility(accepted, pixels, w, h, own) {
  if (typeof buildFloorVisibility !== 'function') return;
  const markers = [];
  for (const tag of accepted) {
    if (!tag.corners.every(p => Math.abs(p[2]) < 1e-6)) continue;
    if (!markerPrints.has(tag.id)) {
      const print = own(new lib.Mat());
      lib.generateImageMarker(dictionary, tag.id, 8, print, 1);
      markerPrints.set(tag.id, Uint8Array.from(print.data));
    }
    markers.push(Object.assign(tag.image.slice(), { bits: markerPrints.get(tag.id) }));
  }
  return buildFloorVisibility(pixels, w, h, markers, []);
}

function keepVisibleFloor(view, visibility, width) {
  if (!view) return;
  const stripeMargin = Math.max(3, width/180)/2 + 1;
  view.guide = visibility ? (view.guide ?? []).filter(face => visibility.covers(face, stripeMargin)) : [];
  if (!visibility) view.arrow = null;
  view.floorVisible = !!(view.guide.length || view.arrow);
  if (!view.floorVisible) delete view.floorTiltLimit;
  if (!view.arrow && !view.screenDirection && view.routeBearing) {
    view.screenDirection = view.routeBearing.direction;
    view.screenAngleDeg = view.routeBearing.angleDeg;
  }
}

function track({ rgba, w, h, bounds = [0, 0, w, h], pinnedSpace, preferredSpace, frameTimeMs, floorAnchor, motionCamera, knownRoute, walking, corridorCamera, guideCamera, floorUp }) {
  const owned = [];
  const own = (m) => { owned.push(m); return m; };
  const result = { type: 'frame', detections: [], fix: null };
  const gravityLength = Array.isArray(floorUp) && floorUp.length === 3 ? Math.hypot(...floorUp) : 0;
  floorUp = Math.abs(gravityLength-1) < .01 ? floorUp.map(v => v/gravityLength) : undefined;
  const pinned = pinnedSpace ?? (layouts.size === 1 ? layouts.keys().next().value : undefined);
  let visibility;
  try {
    const pixels = new Uint8Array(rgba);
    const image = own(new lib.Mat(h, w, lib.CV_8UC4));
    image.data.set(pixels);
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
    let located;
    if (candidates.length === 1) {
      result.spaceId = candidates[0];
      const layout = layouts.get(result.spaceId);
      if (layout !== station) configure(layout);
      result.intrinsics = cameraIntrinsics(w, h);
      if (tags.length) {
        located = locate(tags.map(tag => ({ ...tag, ...anchors.get(tag.id) })), gray, result, frameTimeMs, own);
        if (located) {
          result.fix = located.fix;
          visibility = taggedFloorVisibility(located.tags, pixels, w, h, own);
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
    const measured = updateFloor(gray, result, frameTimeMs, anchor, pinned ?? preferredSpace, bounds, own, floorUp, pixels, visibility);
    visibility ??= measured;
    if (located?.route && !result.fix.arrived && visibility) {
      const view = floorGuidance(located.route, result.fix, located.plane, result.intrinsics, bounds, result.corridorHeading,
        frameTimeMs, own, true, floorUp, visibleArrow(visibility, w));
      // A measured floor arrow can replace the cue initially computed for the panel.
      delete result.fix.screenDirection;
      delete result.fix.screenAngleDeg;
      Object.assign(result.fix, view);
    }
    const selected = pinned ?? preferredSpace;
    if (!result.fix && !result.floorMotion) {
      if (result.candidates || (selected && selected !== motionReference?.spaceId) ||
          (result.referenceTag && result.referenceTag.spaceId !== motionReference?.spaceId)) motionReference = undefined;
      if (guideCamera) result.motionGuide = motionGuidance(guideCamera, knownRoute, frameTimeMs);
    }
    if (!result.fix && !result.floorMotion && !result.pendingFloorSpace && !result.candidates && !result.referenceTag &&
        corridorCamera && xy(corridorCamera.point) && corridorCamera.up?.length === 3 && knownRoute === routeRevision &&
        layouts.get(corridorCamera.spaceId) === station && (!selected || selected === corridorCamera.spaceId)) {
      result.corridorHeading = corridorCorrection(gray, cameraIntrinsics(w,h), routePosition(corridorCamera.point),
        corridorCamera.point, corridorCamera.headingDeg, corridorCamera.up, frameTimeMs, corridorCamera.spaceId, result.detections, own);
    }
    if (result.candidates || (result.referenceTag && !result.fix && !result.floorMotion)) corridorFilter = undefined;
    if (!result.fix && !result.floorMotion && !result.candidates && !result.referenceTag &&
        (!(pinned ?? preferredSpace) || (pinned ?? preferredSpace) === walking?.spaceId))
      result.walking = walkingPreview(walking, knownRoute);
  } catch (error) {
    // A failed pose or incompatible calibration still leaves decoded image-space tag outlines.
    if (!result.fix) Object.assign(result, findReferenceTag(result.detections, pinned, preferredSpace));
    reportFrameError(error);
  } finally {
    for (let i = owned.length-1; i >= 0; i--) owned[i].delete();
  }
  keepVisibleFloor(result.fix ?? result.floorMotion, visibility, w);
  if (!result.fix?.guide?.length && !result.floorMotion?.guide?.length && !result.pendingFloorSpace) guideView = undefined;
  return result;
}

function locate(tags, gray, result, frameTimeMs, own) {
  const { intrinsics, spaceId } = result;
  const K = cameraMatrix(intrinsics, own);
  const coefficients = station.camera.calibration?.distortion ?? [0,0,0,0,0];
  const dist = own(lib.matFromArray(coefficients.length, 1, lib.CV_64F, coefficients));
  const r = own(new lib.Mat()), t = own(new lib.Mat());
  let pairs = correspondences(tags, own);
  const inlierPx = 3;
  let checkEveryCorner = false;
  if (tags.length > 1) {
    const inliers = own(new lib.Mat());
    const found = lib.solvePnPRansac(pairs.object, pairs.image, K, dist, r, t, false, 120, inlierPx, .995, inliers, lib.SOLVEPNP_ITERATIVE);
    const indices = new Set(found ? inliers.data32S : []);
    const consistent = tags.filter((_, i) => [0,1,2,3].every(k => indices.has(4*i+k)));
    // Coplanar samples can miss a valid consensus. Fit all tags in that case
    // and require every original corner to meet the same inlier tolerance.
    if (consistent.length < 2) checkEveryCorner = true;
    else if (consistent.length < tags.length) { tags = consistent; pairs = correspondences(tags, own); }
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
  for (let k = 0; k < observed.length; k += 2) {
    const errorSquared = (reproj[k] - observed[k])**2 + (reproj[k+1] - observed[k+1])**2;
    if (checkEveryCorner && errorSquared > inlierPx**2) return null;
    squared += errorSquared;
  }
  const rmsPx = Math.sqrt(squared / pairs.corners.length);
  if (!(rmsPx <= 2.5)) return null;

  // On the common floor plane the pixel homography needs no focal-length estimate.
  // With a calibrated lens, project through its measured distortion instead.
  let plane = floorMatrix(R, T);
  if (onFloor && !station.camera.calibration) {
    const floor = own(lib.matFromArray(pairs.corners.length, 1, lib.CV_64FC2, pairs.corners.flatMap(([x,y]) => [x,y])));
    const H = own(lib.findHomography(floor, pairs.image, 0)).data64F;
    // Express the measured pixel homography in the same metric camera frame
    // as optical flow. Its arbitrary scale is fixed by depth at a visible tag.
    if (H.length === 9) {
      const [fx, fy, cx, cy] = intrinsics, [x, y] = tags[0].center;
      const scale = depth([x,y]) / (H[6]*x + H[7]*y + H[8]);
      const measured = [(H[0]-cx*H[6])/fx, (H[1]-cx*H[7])/fx, (H[2]-cx*H[8])/fx,
        (H[3]-cy*H[6])/fy, (H[4]-cy*H[7])/fy, (H[5]-cy*H[8])/fy,
        H[6], H[7], H[8]].map(value => value*scale);
      if (measured.every(Number.isFinite)) plane = measured;
    }
  }
  if (!confirmedTagPose(spaceId, { position }, frameTimeMs)) return null;
  const tree = trees.get(station);
  const observedSegment = tree && selectPath(tree, tags, position);
  const route = routePosition(position, observedSegment);
  const last = segments.at(-1);
  const remaining = route ? last.along + last.length - route.progress : activePoints.length === 1 ? 0 : Infinity;
  const endDistance = activePoints.length ? distance(position, activePoints.at(-1)) : Infinity;
  const arrived = Math.max(remaining, endDistance) < .3;
  result.corridorHeading = visualCorridorCorrection(gray, intrinsics, route, { position, cameraToWorld }, frameTimeMs, spaceId, result.detections, own);
  const guidance = arrived || !route ? { guide: [], arrow: null, floorVisible: false }
    : routeDirection(route, { cameraToWorld }, [], null, result.corridorHeading);
  const segmentIndex = route?.segmentIndex ?? observedSegment;
  const bearing = route ? guidanceSegment(route) : guideBackToPassage(guidance, cameraToWorld, position, segmentIndex);
  motionReference = !arrived && segments[segmentIndex] && Number.isFinite(frameTimeMs)
    ? { spaceId, timeMs: frameTimeMs, segmentIndex, bearing: bearing ?? motionReference?.bearing } : undefined;
  const fix = { position, cameraToWorld, ids: tags.map(tag => tag.id), rmsPx, arrived, destinationDistance: Math.max(remaining, endDistance), ...guidance };
  return { fix, tags, route, plane };
}

function setLayouts(spaces) {
  floorReference?.gray.delete();
  floorReference = undefined;
  lastTagPose = unconfirmedTagPose = undefined;
  corridorFilter = undefined;
  station = undefined;
  layouts = new Map(spaces.map(space => [space.id, space.station]));
  trees = new Map(spaces.filter(space => space.tree).map(space => [space.station, space.tree]));
  tagSpaces = new Map();
  for (const [id, layout] of layouts) {
    for (const tag of layout.tags) {
      if (!tagSpaces.has(tag.id)) tagSpaces.set(tag.id, new Set());
      tagSpaces.get(tag.id).add(id);
    }
  }
  setPath([], []);
  if (layouts.size === 1) configure(layouts.values().next().value);
}

self.onmessage = ({ data }) => {
  if (data.type === 'layouts') {
    setLayouts(data.spaces);
    return;
  }
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
        dictionary = lib.getPredefinedDictionary(lib.DICT_APRILTAG_36h11);
        const params = new lib.aruco_DetectorParameters(), refine = new lib.aruco_RefineParameters(10, 3, true);
        params.cornerRefinementMethod = lib.CORNER_REFINE_SUBPIX;
        detector = new lib.aruco_ArucoDetector(dictionary, params, refine);
        params.delete(); refine.delete();
        // Expand the remaining grayscale steps close to white before removing the illumination gradient.
        highlightLut = lib.matFromArray(1, 256, lib.CV_8U, Array.from({ length: 256 }, (_, i) =>
          Math.round(255 * (1 - Math.log(256 - i) / Math.log(256)))));
        self.postMessage({ type: 'ready' });
      } catch (error) { self.postMessage({ type: 'error', message: String(error) }); }
    }
    try {
      corridorHeadingEnabled = data.corridorHeadingEnabled !== false;
      setLayouts(data.spaces ?? [{ id: 'default', station: data.station }]);
      if (typeof buildFloorVisibility !== 'function') {
        try { importScripts('floor-visibility.js?v=1'); }
        catch (error) { console.warn('바닥 영상 확인:', error); }
      }
      if (corridorHeadingEnabled && typeof observeCorridorHeading !== 'function') {
        try { importScripts('corridor-heading.js?v=1'); }
        catch (error) { corridorHeadingEnabled = false; console.warn('복도 방향 보정:', error); }
      }
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
