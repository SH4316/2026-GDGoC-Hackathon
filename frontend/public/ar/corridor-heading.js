// Classic worker script. A horizontal world line vanishes on the horizon
// defined by gravity. Independent edge orientations must vote for the same ray.
'use strict';

let corridorGradients;
let corridorTagMask;

function observeCorridorHeading(gray, width, height, intrinsics, up, expectedDeg, excludedRects = []) {
  const [fx, fy, cx, cy] = intrinsics;
  const [ux, uy, uz] = up; // World up expressed in OpenCV right/down/forward axes.
  const horizontal = Math.hypot(ux, uy);
  if (!Number.isFinite(expectedDeg) || Math.abs(expectedDeg) > 50 ||
      ![fx, fy, cx, cy, ux, uy, uz].every(Number.isFinite) || fx <= 0 || fy <= 0 ||
      Math.abs(Math.hypot(horizontal, uz) - 1) > .01 || uz < -.85 || uz > .42 ||
      width < 32 || height < 32 || gray.length !== width * height) return null;

  const size = width * height;
  if (corridorGradients?.length !== 2 * size) corridorGradients = new Int16Array(2 * size);
  const gradients = corridorGradients;
  let excluded;
  if (excludedRects.length) {
    if (corridorTagMask?.length !== size) corridorTagMask = new Uint8Array(size);
    excluded = corridorTagMask;
    excluded.fill(0);
    // The printed square can produce a strong vanishing point of its own. Include
    // the 5 px line support and 1 px Sobel radius without painting an artificial edge.
    for (const [x0, y0, x1, y1] of excludedRects) {
      const left = Math.max(0, Math.floor(x0) - 6), right = Math.min(width, Math.ceil(x1) + 7);
      const top = Math.max(0, Math.floor(y0) - 6), bottom = Math.min(height, Math.ceil(y1) + 7);
      if (left >= right) continue;
      for (let y = top; y < bottom; y++) excluded.fill(1, y*width+left, y*width+right);
    }
  }
  let totalGradient = 0, pixelCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1, i = y * width + 1; x < width - 1; x++, i++) {
      const gx = gray[i-width+1] + 2*gray[i+1] + gray[i+width+1]
               - gray[i-width-1] - 2*gray[i-1] - gray[i+width-1];
      const gy = gray[i+width-1] + 2*gray[i+width] + gray[i+width+1]
               - gray[i-width-1] - 2*gray[i-width] - gray[i-width+1];
      gradients[i] = gx;
      gradients[size+i] = gy;
      if (!excluded?.[i]) {
        totalGradient += Math.abs(gx) + Math.abs(gy);
        pixelCount++;
      }
    }
  }
  if (!pixelCount) return null;
  const threshold = Math.max(50, 2.5 * totalGradient / pixelCount);
  const weight = new Float32Array(140); // Bin 70 starts at 0° relative bearing.
  const orientations = new Uint32Array(weight.length * 12);
  const radians = Math.PI / 180;
  const offsets = [-5, -2.5, 2.5, 5];

  for (let y = 6; y < height - 6; y++) {
    const ry = (y - cy) / fy;
    for (let x = 6, i = y * width + 6; x < width - 6; x++, i++) {
      if (excluded?.[i]) continue;
      const gx = gradients[i], gy = gradients[size+i], strength = Math.abs(gx) + Math.abs(gy);
      if (strength < threshold) continue;
      const norm = Math.hypot(gx, gy), lx = -gy / norm, ly = gx / norm;
      let aligned = 0;
      for (const offset of offsets) {
        const j = Math.round(y + ly*offset) * width + Math.round(x + lx*offset);
        const sx = gradients[j], sy = gradients[size+j];
        if (Math.abs(sx) + Math.abs(sy) >= .6 * threshold &&
            gx*sx + gy*sy > .96 * norm * Math.hypot(sx, sy)) aligned++;
      }
      if (aligned < 3) continue;

      const rx = (x - cx) / fx, tx = lx / fx, ty = ly / fy;
      const tangentLength = Math.hypot(tx, ty);
      // Vertical structures converge regardless of corridor bearing.
      const vx = ux - rx*uz, vy = uy - ry*uz;
      if (Math.abs(tx*vy - ty*vx) < .24 * tangentLength * Math.hypot(vx, vy)) continue;
      const denominator = ux*tx + uy*ty;
      const sine = Math.abs(denominator) / (horizontal * tangentLength);
      if (sine < .1) continue;

      // Intersect this edge with the horizon: up · [hx, hy, 1] = 0.
      const t = -(ux*rx + uy*ry + uz) / denominator;
      const hx = rx + t*tx, hy = ry + t*ty;
      // For this horizontal ray, dot(ray, horizontal camera forward) = 1/horizontal.
      // Right = [-uy, ux, 0]/horizontal, so their dot-product ratio simplifies.
      const relative = Math.atan2(-uy*hx + ux*hy, 1) / radians;
      const bin = Math.floor(relative + 70);
      if (bin < 0 || bin >= weight.length) continue;
      weight[bin] += Math.min(strength, threshold*4) * sine;
      let angle = Math.atan2(ly, lx);
      if (angle < 0) angle += Math.PI;
      orientations[bin*12 + Math.min(11, Math.floor(angle / Math.PI * 12))]++;
    }
  }
  return corridorPeak(weight, orientations, expectedDeg, .22 * Math.hypot(width, height));
}

function corridorPeak(weight, orientations, expectedDeg, minSupport) {
  const smooth = new Float32Array(weight.length);
  let total = 0, best = 0;
  for (let i = 2; i < weight.length - 2; i++) {
    total += weight[i];
    smooth[i] = (weight[i-2] + 2*weight[i-1] + 3*weight[i] + 2*weight[i+1] + weight[i+2]) / 9;
    if (smooth[i] > smooth[best]) best = i;
  }
  if (!total || smooth[best] < 2.5 * total / weight.length || Math.abs(best + .5 - 70 - expectedDeg) > 15) return null;
  // A second corridor-like vanishing point makes a correction ambiguous.
  for (let i = 0; i < smooth.length; i++) {
    if (Math.abs(i - best) > 9 && smooth[i] >= .75 * smooth[best]) return null;
  }

  const directions = new Uint32Array(12);
  let count = 0, mass = 0, angleSum = 0;
  for (let i = best-2; i <= best+2; i++) {
    mass += weight[i];
    angleSum += weight[i] * (i + .5 - 70);
    for (let k = 0; k < 12; k++) {
      const n = orientations[12*i+k];
      directions[k] += n;
      count += n;
    }
  }
  if (count < minSupport) return null;
  const primary = directions.indexOf(Math.max(...directions));
  let independent = 0;
  for (let k = 0; k < directions.length; k++) {
    const gap = Math.abs(k - primary);
    if (gap >= 2 && gap <= 10) independent += directions[k];
  }
  if (independent < Math.max(.25 * minSupport, .12 * count)) return null;
  return angleSum / mass;
}
