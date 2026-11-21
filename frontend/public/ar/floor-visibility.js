// Image-space evidence for painting a projected floor. The caller supplies only floor-mounted
// markers and landmarks that survived a match to previously observed floor.
function buildFloorVisibility(rgba, w, h, floorTagImages = [], trackedFloorPixels = []) {
  if (!floorTagImages.length && !trackedFloorPixels.length) return;
  if (!(w > 0 && h > 0) || rgba?.length < w * h * 4 || !rgba) return;
  const step = Math.max(4, Math.round(Math.max(w, h) / 128));
  const cols = Math.ceil(w / step), rows = Math.ceil(h / step), count = cols * rows;
  const inside = (x, y) => x >= 0 && x < w && y >= 0 && y < h;
  const cell = (x, y) => Math.floor(y / step) * cols + Math.floor(x / step);
  const validPoint = p => p?.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const tags = floorTagImages.filter(p => p?.length === 4 && p.every(validPoint));
  const tracked = trackedFloorPixels.filter(p => validPoint(p) && inside(...p));
  if (!tags.length && !tracked.length) return;

  // Five samples per tile retain both luminance and opponent colors. The extrema keep a
  // contrasting obstruction at a tile boundary from averaging into the surrounding floor.
  const stride = 9, values = new Int16Array(count * stride);
  const near = Math.floor(step / 5), far = step - 1 - near, mid = Math.floor(step / 2);
  const offsets = [[near, near], [far, near], [mid, mid], [near, far], [far, far]];
  for (let y = 0, index = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step, index += stride) {
      let lum = 0, rg = 0, bg = 0;
      values[index + 3] = values[index + 5] = values[index + 7] = 256;
      values[index + 4] = values[index + 6] = values[index + 8] = -256;
      for (const [dx, dy] of offsets) {
        const i = 4 * (Math.min(h - 1, y + dy) * w + Math.min(w - 1, x + dx));
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const light = (77 * r + 150 * g + 29 * b) >> 8, red = r - g, blue = b - g;
        lum += light; rg += red; bg += blue;
        values[index + 3] = Math.min(values[index + 3], light);
        values[index + 4] = Math.max(values[index + 4], light);
        values[index + 5] = Math.min(values[index + 5], red);
        values[index + 6] = Math.max(values[index + 6], red);
        values[index + 7] = Math.min(values[index + 7], blue);
        values[index + 8] = Math.max(values[index + 8], blue);
      }
      values[index] = lum / 5; values[index + 1] = rg / 5; values[index + 2] = bg / 5;
    }
  }

  function inPolygon(x, y, polygon) {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0]-a[0]) * (y-a[1]) / (b[1]-a[1]) + a[0]) hit = !hit;
    }
    return hit;
  }

  const similar = (a, b) => Math.abs(values[a] - values[b]) <= 62 &&
    Math.abs(values[a + 1] - values[b + 1]) <= 18 && Math.abs(values[a + 2] - values[b + 2]) <= 18;
  const groups = [], tagModels = new Map();
  for (const quad of tags) {
    const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
    const samples = [];
    for (let side = 0; side < 4; side++) {
      const a = quad[side], b = quad[(side + 1) % 4], dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1) continue;
      const normal = ((a[0]-cx)*dy - (a[1]-cy)*dx) >= 0 ? 1 : -1;
      const nx = normal * dy / length, ny = -normal * dx / length;
      const halfWidth = (a[0]-cx)*nx + (a[1]-cy)*ny;
      // Step past the printed quiet zone, including when a tag is heavily foreshortened.
      const gap = Math.max(2 * step, .65 * halfWidth);
      for (const fraction of [.2, .5, .8]) {
        const x = a[0] + fraction * dx + nx * gap, y = a[1] + fraction * dy + ny * gap;
        if (inside(x, y) && !tags.some(tag => inPolygon(x, y, tag))) samples.push({ id: cell(x, y), side });
      }
    }
    let consensus = [];
    for (const seed of samples) {
      const peers = samples.filter(s => similar(seed.id * stride, s.id * stride));
      if (peers.length > consensus.length) consensus = peers;
    }
    // An object abutting one edge of a tag must not teach its color to the floor model.
    if (consensus.length > samples.length / 2 && new Set(consensus.map(s => s.side)).size >= 2) {
      const seeds = [...new Set(consensus.map(s => s.id))];
      groups.push(seeds);
      tagModels.set(seeds, quad);
    }
  }

  // Each material floods only from its own trusted seeds. Two disjoint regions of matching
  // color cannot establish one another, even when both colors occur elsewhere in the scene.
  const flowGroups = [];
  for (const id of new Set(tracked.map(p => cell(...p)))) {
    const group = flowGroups.find(g => similar(g[0] * stride, id * stride));
    if (group) group.push(id);
    else if (flowGroups.length < 12) flowGroups.push([id]);
  }
  groups.push(...flowGroups);
  if (!groups.length) return;

  const visible = new Uint8Array(count), visited = new Uint8Array(count), queue = new Int32Array(count);
  const texturedFloor = new Uint8Array(count);
  const printArea = new Uint8Array(count);
  for (const quad of tags) {
    const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
    const left = Math.max(0,Math.floor(Math.min(...xs)/step)-1), right = Math.min(cols-1,Math.floor(Math.max(...xs)/step)+1);
    const top = Math.max(0,Math.floor(Math.min(...ys)/step)-1), bottom = Math.min(rows-1,Math.floor(Math.max(...ys)/step)+1);
    for (let y = top; y <= bottom; y++) printArea.fill(1, y*cols+left, y*cols+right+1);
  }
  function neighbors(id, visit) {
    const x = id % cols;
    if (x > 0) visit(id - 1);
    if (x + 1 < cols) visit(id + 1);
    if (id >= cols) visit(id - cols);
    if (id + cols < count) visit(id + cols);
  }
  for (const seeds of groups) {
    const low = [], high = [];
    for (let c = 0; c < 3; c++) {
      const averages = seeds.map(id => values[id * stride + c]).sort((a,b) => a-b);
      const center = averages[Math.floor(averages.length / 2)];
      const spread = seeds.map(id => {
        const i = id * stride + 3 + 2 * c;
        return Math.max(center - values[i], values[i + 1] - center);
      }).sort((a,b) => a-b);
      const variation = spread[Math.floor(.85 * spread.length)];
      const radius = c === 0 ? Math.min(76, 20 + 1.25 * variation) : Math.min(29, 13 + variation);
      low.push(center - radius); high.push(center + radius);
    }
    visited.fill(0);
    let head = 0, tail = 0;
    function visit(id) {
      if (visited[id]) return;
      visited[id] = 1;
      const i = id * stride;
      if (values[i+3] < low[0] || values[i+4] > high[0] || values[i+5] < low[1] ||
          values[i+6] > high[1] || values[i+7] < low[2] || values[i+8] > high[2]) return;
      visible[id] = 1;
      visited[id] = 2;
      queue[tail++] = id;
    }
    for (const seed of seeds) visit(seed);
    while (head < tail) {
      neighbors(queue[head++], visit);
    }
    // A reflection or shadow can shift the same material well beyond its seed brightness.
    // Cross those levels only along a smooth ramp, with bounded overall brightness and hue.
    const center = (low[0] + high[0]) / 2;
    let previous = 0;
    function extendGradient(id) {
      if (visited[id] === 2) return;
      const i = id*stride;
      if (Math.abs(values[i]-center) > 72 || values[i+4]-values[i+3] > 8 ||
          Math.abs(values[i]-previous) > 5 || values[i+5] < low[1] || values[i+6] > high[1] ||
          values[i+7] < low[2] || values[i+8] > high[2]) return;
      visible[id] = 1; visited[id] = 2; queue[tail++] = id;
    }
    for (head = 0; head < tail; head++) {
      const id = queue[head], i = id*stride;
      if (values[i+4]-values[i+3] <= 8) { previous = values[i]; neighbors(id, extendGradient); }
    }
    // Examine the actual material near multiple independent seeds, excluding marker ink.
    // A large matte region is suspicious only when local patches normally contain contrast.
    let textured = 0;
    for (const seed of seeds) {
      let light = 255, dark = 0, edges = 0;
      const row = Math.floor(seed/cols), col = seed%cols;
      for (let y = Math.max(0,row-3); y <= Math.min(rows-1,row+3); y++)
        for (let x = Math.max(0,col-3); x <= Math.min(cols-1,col+3); x++) {
          const id = y*cols+x;
          if (visited[id] !== 2 || printArea[id]) continue;
          light = Math.min(light, values[id*stride+3]); dark = Math.max(dark, values[id*stride+4]);
          if (values[id*stride+4]-values[id*stride+3] >= 14 ||
              (x && !printArea[id-1] && visited[id-1] === 2 && Math.abs(values[id*stride]-values[(id-1)*stride]) >= 12) ||
              (y && !printArea[id-cols] && visited[id-cols] === 2 && Math.abs(values[id*stride]-values[(id-cols)*stride]) >= 12)) edges++;
        }
      if (dark-light >= 36 && edges >= 3) textured++;
    }
    if (seeds.length >= 3 && textured >= Math.ceil(.7*seeds.length))
      for (let i = 0; i < tail; i++) texturedFloor[queue[i]] = 1;

    const quad = tagModels.get(seeds);
    if (quad?.bits?.length === 64) markPrintedTag(quad, low, high);
  }

  // Re-use a tile only if each sampled pixel is either the expected printed cell of the
  // detected floor tag or the surrounding floor color. A decoded ID alone never unlocks
  // the entire quadrilateral: decoding tolerates partial damage and occlusion.
  function markPrintedTag(quad, low, high) {
    const [a,b,c,d] = quad;
    const bx = b[0]-c[0], by = b[1]-c[1], dx = d[0]-c[0], dy = d[1]-c[1];
    const tx = a[0]-b[0]+c[0]-d[0], ty = a[1]-b[1]+c[1]-d[1];
    const det = bx*dy-by*dx;
    if (Math.abs(det) < 1e-6) return;
    const g = (tx*dy-ty*dx)/det, k = (bx*ty-by*tx)/det;
    const bx0 = (1+g)*b[0]-a[0], by0 = (1+g)*b[1]-a[1];
    const dx0 = (1+k)*d[0]-a[0], dy0 = (1+k)*d[1]-a[1];
    function pattern(x,y) {
      const m = bx0-g*x, n = dx0-k*x, p = by0-g*y, q = dy0-k*y;
      const denominator = m*q-n*p, xx = x-a[0], yy = y-a[1];
      const u = Math.floor(8*(xx*q-n*yy)/denominator), v = Math.floor(8*(m*yy-xx*p)/denominator);
      return u >= 0 && u < 8 && v >= 0 && v < 8 ? Number(!!quad.bits[8*v+u]) : -1;
    }
    const xs = quad.map(p => p[0]), ys = quad.map(p => p[1]);
    const x0 = Math.max(0,Math.floor((Math.min(...xs)-2)/step)), x1 = Math.min(cols-1,Math.floor((Math.max(...xs)+2)/step));
    const y0 = Math.max(0,Math.floor((Math.min(...ys)-2)/step)), y1 = Math.min(rows-1,Math.floor((Math.max(...ys)+2)/step));
    const ink = [[],[]];
    const sampleStep = Math.max(2, Math.ceil(Math.max(x1-x0,y1-y0)*step/48));
    for (let y = y0*step; y <= Math.min(h-1,(y1+1)*step); y += sampleStep)
      for (let x = x0*step; x <= Math.min(w-1,(x1+1)*step); x += sampleStep) {
        const bit = pattern(x,y);
        if (bit < 0) continue;
        const i = 4*(y*w+x);
        ink[bit].push((77*rgba[i]+150*rgba[i+1]+29*rgba[i+2]) >> 8);
      }
    if (ink.some(samples => samples.length < 3)) return;
    const shades = ink.map(samples => samples.sort((u,v) => u-v)[Math.floor(samples.length/2)]);
    if (shades[1]-shades[0] < 40) return;
    const tolerance = [[0,0],[-1,0],[1,0],[0,-1],[0,1]];
    function supported(x,y) {
      const i = 4*(y*w+x), r = rgba[i], green = rgba[i+1], b = rgba[i+2];
      const lum = (77*r+150*green+29*b) >> 8, rg = r-green, bg = b-green;
      // At a printed edge, a subpixel corner-fit error can move the expected cell boundary.
      // Only the nearest pixel on either side is eligible for the other tone.
      for (const [du,dv] of tolerance) {
        const bit = pattern(x+du,y+dv);
        if (bit < 0) {
          if (lum >= low[0] && lum <= high[0] && rg >= low[1] && rg <= high[1] &&
              bg >= low[2] && bg <= high[2]) return true;
        } else if (Math.abs(rg) <= 22 && Math.abs(bg) <= 22 && Math.abs(lum-shades[bit]) <= 32) return true;
      }
      return false;
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const id = y*cols+x;
      const samples = offsets.map(([u,v]) => [Math.min(w-1,x*step+u),Math.min(h-1,y*step+v)]);
      if (samples.some(([u,v]) => pattern(u,v) >= 0)) visible[id] = Number(samples.every(([u,v]) => supported(u,v)));
    }
  }

  // Find contiguous, near-uniform areas on a material whose trusted samples normally
  // show texture. Starting from their flat interiors lets the rejection extend to the
  // edge of a leg or jacket even if an immediately adjacent tile contains floor detail.
  visited.fill(0);
  const rejected = new Uint8Array(count);
  const minArea = Math.max(16, Math.ceil(count * .013));
  let tail = 0, previousShade = 0;
  function visitMatte(id) {
    if (visited[id] || !texturedFloor[id]) return;
    const i = id*stride;
    if (values[i+4]-values[i+3] > 9 || Math.abs(values[i]-previousShade) > 8) return;
    visited[id] = 1; queue[tail++] = id;
  }
  for (let id = 0; id < count; id++) {
    if (visited[id] || !texturedFloor[id] || values[id*stride+4]-values[id*stride+3] > 9) continue;
    visited[id] = 1; queue[0] = id; tail = 1;
    for (let head = 0; head < tail; head++) {
      const current = queue[head];
      previousShade = values[current*stride];
      neighbors(current, visitMatte);
    }
    if (tail < minArea) continue;
    // A few floor tiles touching the silhouette can legitimately fall just outside the
    // clothing's narrow tone range. Use the component's inner 80% to test uniformity.
    const shades = new Uint32Array(256);
    for (let i = 0; i < tail; i++) shades[values[queue[i]*stride]]++;
    let lo = 0, hi = 255, left = tail*.1, right = tail*.1;
    while (left >= shades[lo]) left -= shades[lo++];
    while (right >= shades[hi]) right -= shades[hi--];
    if (hi-lo <= 16) for (let i = 0; i < tail; i++) {
      const id = queue[i], shade = values[id*stride];
      if (shade >= lo-5 && shade <= hi+5) rejected[id] = 1;
    }
  }
  for (let id = 0; id < count; id++) if (rejected[id]) {
    visible[id] = 0;
    neighbors(id, p => { visible[p] = 0; });
  }
  if (!visible.includes(1)) return;

  function contains(x, y) {
    return inside(x, y) && visible[cell(x, y)] === 1;
  }

  // Test the entire filled face, including its stroke. A blocker can lie wholly inside
  // an arrow, away from each of its vertices, edges and center.
  function covers(polygon, marginPx = 0) {
    if (!polygon || polygon.length < 3 || !polygon.every(validPoint) || !Number.isFinite(marginPx)) return false;
    const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    if (minX < -.001 || minY < -.001 || maxX > w + .001 || maxY > h + .001) return false;
    const pad = Math.max(0, marginPx);
    const firstCol = Math.max(0, Math.floor((minX-pad) / step)), firstRow = Math.max(0, Math.floor((minY-pad) / step));
    const lastCol = Math.min(cols-1, Math.floor((maxX+pad) / step)), lastRow = Math.min(rows-1, Math.floor((maxY+pad) / step));
    for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) {
      if (visible[row * cols + col]) continue;
      const left = col*step-pad, right = (col+1)*step+pad, top = row*step-pad, bottom = (row+1)*step+pad;
      if (inPolygon((left+right)/2, (top+bottom)/2, polygon)) return false;
      for (let i = 0; i < polygon.length; i++) {
        const [x,y] = polygon[i], [u,v] = polygon[(i+1) % polygon.length];
        if (Math.max(x,u) < left || Math.min(x,u) > right || Math.max(y,v) < top || Math.min(y,v) > bottom) continue;
        // Segment and rectangle already overlap on X and Y. The segment's normal is the
        // only remaining separating axis for these two convex shapes.
        const dx = u-x, dy = v-y;
        const distance = Math.abs(dx*(top+bottom-2*y) - dy*(left+right-2*x));
        if (distance <= Math.abs(dx)*(bottom-top) + Math.abs(dy)*(right-left)) return false;
      }
    }
    return true;
  }
  return { contains, covers };
}
