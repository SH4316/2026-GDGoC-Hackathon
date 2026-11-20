const { readFileSync, readdirSync, writeFileSync, renameSync, rmSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const jpeg = require('jpeg-js');

const MIN_BASELINE_M = 0.09;
const MAX_BASELINE_M = 2;
const MIN_PARALLAX = Math.cos(1.5 * Math.PI / 180);
const MAX_REPROJECTION_PX = 2.5;
const MIN_SCENE_POINTS = 20;
const VOXEL_M = 0.03;
const MAX_ANCHORS = 8;
const MAX_PAIR_ANCHORS = 3;
const MAX_DEPTH_M = 30;

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a, b) {
  return a.map((v, i) => v - b[i]);
}

function distance(a, b) {
  return Math.hypot(...subtract(a, b));
}

function distort(x, y, [k1, k2, p1, p2, k3 = 0, k4 = 0, k5 = 0, k6 = 0]) {
  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const radial = (1 + k1 * r2 + k2 * r4 + k3 * r6) / (1 + k4 * r2 + k5 * r4 + k6 * r6);
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x),
    y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
}

function camera(frame) {
  const m = frame.pose.cameraToWorld;
  // Camera coordinates are right, down, forward. The matrix columns are the
  // three camera axes expressed in station coordinates (right, forward, up).
  return {
    center: [m[3], m[7], m[11]],
    right: [m[0], m[4], m[8]],
    down: [m[1], m[5], m[9]],
    forward: [m[2], m[6], m[10]],
  };
}

function ray(frame, pixel, distortion) {
  const [fx, fy, cx, cy] = frame.intrinsics;
  const xd = (pixel.x - cx) / fx;
  const yd = (pixel.y - cy) / fy;
  let x = xd;
  let y = yd;
  // Invert the radial and tangential distortion in normalized coordinates.
  // Reprojection later rejects rays where this iteration did not converge.
  for (let i = 0; i < 12; i++) {
    const [u, v] = distort(x, y, distortion);
    x += xd - u;
    y += yd - v;
  }
  const { right, down, forward } = frame.camera;
  const norm = Math.hypot(x, y, 1);
  return right.map((v, i) => (v * x + down[i] * y + forward[i]) / norm);
}

function reprojectionError(frame, point, pixel, distortion) {
  const { center, right, down, forward } = frame.camera;
  const relative = subtract(point, center);
  const z = dot(relative, forward);
  if (z < 0.08 || z > MAX_DEPTH_M) return Infinity;
  const [x, y] = distort(dot(relative, right) / z, dot(relative, down) / z, distortion);
  const [fx, fy, cx, cy] = frame.intrinsics;
  return Math.hypot(fx * x + cx - pixel.x, fy * y + cy - pixel.y);
}

function triangulate(a, pa, b, pb, distortion) {
  const u = ray(a, pa, distortion);
  const v = ray(b, pb, distortion);
  const cosine = dot(u, v);
  if (!Number.isFinite(cosine) || cosine >= MIN_PARALLAX || cosine <= -MIN_PARALLAX) return null;

  // Solve for the two closest positions on the viewing rays and use their midpoint.
  const offset = subtract(b.camera.center, a.camera.center);
  const du = dot(offset, u);
  const dv = dot(offset, v);
  const denominator = 1 - cosine * cosine;
  const t = (du - cosine * dv) / denominator;
  const s = (cosine * du - dv) / denominator;
  if (t <= 0 || s <= 0) return null;
  const point = u.map((component, i) => (a.camera.center[i] + component * t + b.camera.center[i] + v[i] * s) / 2);
  const error = Math.max(reprojectionError(a, point, pa, distortion), reprojectionError(b, point, pb, distortion));
  return error <= MAX_REPROJECTION_PX ? { point, error } : null;
}

function extractFeatures(cv, detector, mask, path, frame) {
  const bytes = readFileSync(path);
  let rgba;
  try { rgba = jpeg.decode(bytes, { maxResolutionInMP: 1, maxMemoryUsageInMB: 32, tolerantDecoding: false }); }
  catch { return null; }
  if (rgba.width !== frame.width || rgba.height !== frame.height) return null;
  const gray = new cv.Mat(frame.height, frame.width, cv.CV_8UC1);
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  try {
    const luminance = gray.data;
    for (let i = 0; i < luminance.length; i++) {
      const offset = 4 * i;
      luminance[i] = (77 * rgba.data[offset] + 150 * rgba.data[offset + 1] + 29 * rgba.data[offset + 2]) >> 8;
    }
    detector.detectAndCompute(gray, mask, keypoints, descriptors);
    const features = [];
    for (let i = 0; i < keypoints.size(); i++) {
      const { x, y } = keypoints.get(i).pt;
      const offset = (Math.round(y) * frame.width + Math.round(x)) * 4;
      features.push({ x, y, color: [...rgba.data.subarray(offset, offset + 3)] });
    }
    return { ...frame, features, descriptors };
  } catch (error) {
    descriptors.delete();
    throw error;
  } finally {
    gray.delete();
    keypoints.delete();
  }
}

function nearestMatches(cv, matcher, from, to) {
  const matches = new cv.DMatchVectorVector();
  try {
    matcher.knnMatch(from.descriptors, to.descriptors, matches, 2);
    const accepted = new Map();
    for (let i = 0; i < matches.size(); i++) {
      const pair = matches.get(i);
      try {
        if (pair.size() < 2) continue;
        const best = pair.get(0);
        if (best.distance <= 64 && best.distance < 0.75 * pair.get(1).distance)
          accepted.set(best.queryIdx, best.trainIdx);
      } finally { pair.delete(); }
    }
    return accepted;
  } finally { matches.delete(); }
}

function addPair(cv, matcher, a, b, distortion, voxels, counts) {
  const forward = nearestMatches(cv, matcher, a, b);
  const reverse = nearestMatches(cv, matcher, b, a);
  counts.matchedPairs++;
  for (const [indexA, indexB] of forward) {
    if (reverse.get(indexB) !== indexA) continue;
    counts.matchedFeatures++;
    const pa = a.features[indexA];
    const pb = b.features[indexB];
    const hit = triangulate(a, pa, b, pb, distortion);
    if (!hit) continue;
    counts.triangulatedFeatures++;
    const key = hit.point.map(value => Math.floor(value / VOXEL_M)).join(',');
    const previous = voxels.get(key);
    if (!previous || hit.error < previous.error) {
      voxels.set(key, { ...hit, color: pa.color.map((value, i) => Math.round((value + pb.color[i]) / 2)) });
    }
  }
}

function referenceFrames(anchors, frame) {
  return anchors.map(anchor => ({ anchor, baseline: distance(anchor.camera.center, frame.camera.center) }))
    .filter(({ anchor, baseline }) => baseline >= MIN_BASELINE_M && baseline <= MAX_BASELINE_M &&
      frame.capturedAtMs > anchor.capturedAtMs && dot(frame.camera.forward, anchor.camera.forward) > 0.35)
    // Moderate baselines improve depth without treading too far into a new view.
    .sort((a, b) => Math.abs(a.baseline - 0.35) - Math.abs(b.baseline - 0.35))
    .slice(0, MAX_PAIR_ANCHORS).map(({ anchor }) => anchor);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function reconstruct(dir) {
  const session = readJson(join(dir, 'session.json'));
  const distortion = session.station.camera.calibration?.distortion ?? [0, 0, 0, 0];
  const frameDir = join(dir, 'frames');
  const frameFiles = readdirSync(frameDir).filter(name => /^\d{6}$/.test(name)).sort();
  const counts = { frames: frameFiles.length, posedFrames: 0, featureFrames: 0, unreadableFrames: 0,
    matchedPairs: 0, matchedFeatures: 0, triangulatedFeatures: 0, candidatePoints: 0 };
  const centers = [];
  const voxels = new Map();
  let resources;
  const anchors = [];
  try {
    for (const name of frameFiles) {
      const frame = readJson(join(frameDir, name, 'frame.json'));
      if (!frame.pose) continue;
      frame.camera = camera(frame);
      centers.push({ point: frame.camera.center, color: [0, 180, 255] });
      counts.posedFrames++;
      const last = anchors.at(-1);
      if (last && distance(last.camera.center, frame.camera.center) < MIN_BASELINE_M &&
          dot(last.camera.forward, frame.camera.forward) > 0.98) continue;
      if (!resources) {
        // The Emscripten module is a thenable that resolves with itself.
        const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
        resources = { cv, detector: new cv.ORB(1200), matcher: new cv.BFMatcher(cv.NORM_HAMMING, false), mask: new cv.Mat() };
      }
      const { cv, detector, matcher, mask } = resources;
      const features = extractFeatures(cv, detector, mask, join(frameDir, name, 'image.jpg'), frame);
      if (!features) {
        counts.unreadableFrames++;
        continue;
      }
      if (features.features.length < 2) {
        features.descriptors.delete();
        continue;
      }
      counts.featureFrames++;
      anchors.push(features);
      for (const anchor of referenceFrames(anchors, features)) addPair(cv, matcher, anchor, features, distortion, voxels, counts);
      if (anchors.length > MAX_ANCHORS) anchors.shift().descriptors.delete();
    }
  } finally {
    for (const anchor of anchors) anchor.descriptors.delete();
    if (resources) {
      resources.mask.delete();
      resources.matcher.delete();
      resources.detector.delete();
    }
  }
  counts.candidatePoints = voxels.size;
  const ready = voxels.size >= MIN_SCENE_POINTS;
  if (centers.length) writePly(dir, 'cameras.ply', centers, centers.length);
  else rmSync(join(dir, 'cameras.ply'), { force: true });
  if (ready) writePly(dir, 'scene.ply', voxels.values(), voxels.size);
  else rmSync(join(dir, 'scene.ply'), { force: true });
  atomicWrite(dir, 'reconstruction.json', JSON.stringify({ state: ready ? 'ready' : 'insufficient',
    points: ready ? voxels.size : 0, ...counts }, null, 2) + '\n');
}

function atomicWrite(dir, name, data) {
  const temporary = join(dir, '.reconstruction-' + randomUUID());
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, join(dir, name));
  } finally { rmSync(temporary, { force: true }); }
}

function writePly(dir, name, entries, length) {
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${length}`,
    'property float x', 'property float y', 'property float z', 'property uchar red',
    'property uchar green', 'property uchar blue', 'end_header', ''].join('\n');
  const buffer = Buffer.alloc(Buffer.byteLength(header) + length * 15);
  let offset = buffer.write(header);
  for (const { point, color } of entries) {
    for (const value of point) offset = buffer.writeFloatLE(value, offset);
    for (const value of color) offset = buffer.writeUInt8(value, offset);
  }
  atomicWrite(dir, name, buffer);
}

reconstruct(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
