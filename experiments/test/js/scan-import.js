// LiDAR 스캔 파일(OBJ, GLB, PLY)을 읽어 위에서 내려다본 평면도를 만든다.
//
// 아이폰 라이다 스캔 앱이 내보낸 3D 파일은 단위가 미터이므로, 여기서 만든 평면도는
// 따로 축척을 맞출 필요 없이 실제 크기 그대로다.
//
// 만드는 방법
//  1. 어느 축이 위쪽인지 찾는다 (바닥처럼 한 높이에 점이 몰려 있는 축).
//  2. 바닥과 천장 높이를 찾는다.
//  3. 바닥 위 0.35m ~ 2m 높이에 있는 "세워진 면"(벽)을 위에서 본 격자에 선으로 그린다.
//  4. 벽들이 주로 향하는 방향을 찾아 격자와 나란하게 돌린다.

const CELL = 0.05; // 격자 한 칸 (m)

/** 길이가 늘어나는 숫자 배열 */
class Grow {
  constructor(Type, cap = 1 << 16) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  _fit(extra) {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  push3(x, y, z) {
    this._fit(3);
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  done() {
    return this.a.subarray(0, this.n);
  }
}

// ---------------------------------------------------------------- 파일 읽기

/**
 * 스캔 파일을 읽는다.
 * 반환: { positions: Float32Array(x, y, z 반복), indices: Uint32Array(삼각형) | null, format }
 */
export async function parseScanFile(file, onProgress = () => {}) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.obj')) return { ...(await parseObj(file, onProgress)), format: 'obj' };
  if (name.endsWith('.glb')) return { ...parseGlb(await file.arrayBuffer()), format: 'glb' };
  if (name.endsWith('.ply')) return { ...parsePly(await file.arrayBuffer()), format: 'ply' };
  if (name.endsWith('.gltf')) throw new Error('.gltf는 여러 파일로 나뉘어 있어 읽을 수 없습니다. GLB나 OBJ로 내보내 주세요.');
  if (name.endsWith('.zip')) throw new Error('압축을 풀고 그 안의 .obj 파일을 골라 주세요.');
  if (name.endsWith('.usdz')) throw new Error('USDZ는 읽을 수 없습니다. OBJ나 GLB로 내보내 주세요.');
  throw new Error('OBJ, GLB, PLY 파일만 읽을 수 있습니다.');
}

/** OBJ: 글자로 된 파일이라 클 수 있어서 조금씩 읽으며 처리한다 */
async function parseObj(file, onProgress) {
  const pos = new Grow(Float32Array);
  const idx = new Grow(Uint32Array);
  const handle = (line) => {
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    if (c0 === 118 && c1 === 32) {
      // v x y z
      const p = line.split(/\s+/);
      pos.push3(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
    } else if (c0 === 102 && c1 === 32) {
      // f a b c ...  (a/ta/na 형태도 있고, 음수면 뒤에서부터 센다)
      const p = line.split(/\s+/);
      const count = pos.n / 3;
      const v = [];
      for (let i = 1; i < p.length; i++) {
        const k = parseInt(p[i], 10);
        if (!Number.isNaN(k)) v.push(k > 0 ? k - 1 : count + k);
      }
      for (let i = 1; i + 1 < v.length; i++) idx.push3(v[0], v[i], v[i + 1]);
    }
  };
  const decoder = new TextDecoder();
  const reader = file.stream().getReader();
  let rest = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    const text = rest + decoder.decode(value, { stream: true });
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      handle(text.slice(start, nl));
      start = nl + 1;
    }
    rest = text.slice(start);
    onProgress(read / file.size);
  }
  if (rest) handle(rest);
  const positions = pos.done();
  if (!positions.length) throw new Error('파일에서 점을 찾지 못했습니다.');
  const indices = idx.done();
  return { positions, indices: indices.length ? indices : null };
}

const PLY_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

function plyRead(dv, off, type) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, true);
    case 'ushort': case 'uint16': return dv.getUint16(off, true);
    case 'int': case 'int32': return dv.getInt32(off, true);
    case 'uint': case 'uint32': return dv.getUint32(off, true);
    case 'float': case 'float32': return dv.getFloat32(off, true);
    default: return dv.getFloat64(off, true);
  }
}

/** PLY: 점 구름이나 메시. 글자 형식과 리틀엔디언 이진 형식을 읽는다 */
function parsePly(buffer) {
  const bytes = new Uint8Array(buffer);
  const marker = 'end_header';
  let headerEnd = -1;
  const limit = Math.min(bytes.length, 1 << 16);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 101) continue;
    let ok = true;
    for (let k = 0; k < marker.length; k++) {
      if (bytes[i + k] !== marker.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      headerEnd = i + marker.length;
      while (headerEnd < bytes.length && bytes[headerEnd] !== 10) headerEnd++;
      headerEnd++;
      break;
    }
  }
  if (headerEnd < 0) throw new Error('PLY 파일의 머리말을 읽을 수 없습니다.');
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).split(/\r?\n/);
  let format = '';
  const elements = [];
  for (const line of header) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'format') format = p[1];
    else if (p[0] === 'element') elements.push({ name: p[1], count: parseInt(p[2], 10), props: [] });
    else if (p[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (p[1] === 'list') el.props.push({ name: p[4], list: true, countType: p[2], type: p[3] });
      else el.props.push({ name: p[2], type: p[1] });
    }
  }
  const pos = new Grow(Float32Array);
  const idx = new Grow(Uint32Array);

  if (format === 'ascii') {
    const tok = new TextDecoder().decode(bytes.subarray(headerEnd)).split(/\s+/);
    let t = 0;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        let x = 0, y = 0, z = 0;
        for (const pr of el.props) {
          if (pr.list) {
            const n = parseInt(tok[t++], 10);
            const v = [];
            for (let k = 0; k < n; k++) v.push(parseInt(tok[t++], 10));
            if (el.name === 'face') for (let k = 1; k + 1 < v.length; k++) idx.push3(v[0], v[k], v[k + 1]);
          } else {
            const val = parseFloat(tok[t++]);
            if (pr.name === 'x') x = val;
            else if (pr.name === 'y') y = val;
            else if (pr.name === 'z') z = val;
          }
        }
        if (el.name === 'vertex') pos.push3(x, y, z);
      }
    }
  } else if (format === 'binary_little_endian') {
    const dv = new DataView(buffer);
    let off = headerEnd;
    for (const el of elements) {
      for (let i = 0; i < el.count; i++) {
        let x = 0, y = 0, z = 0;
        for (const pr of el.props) {
          if (pr.list) {
            const n = plyRead(dv, off, pr.countType);
            off += PLY_SIZE[pr.countType];
            const size = PLY_SIZE[pr.type];
            if (el.name === 'face') {
              const v0 = plyRead(dv, off, pr.type);
              for (let k = 1; k + 1 < n; k++) {
                idx.push3(v0, plyRead(dv, off + k * size, pr.type), plyRead(dv, off + (k + 1) * size, pr.type));
              }
            }
            off += n * size;
          } else {
            if (pr.name === 'x') x = plyRead(dv, off, pr.type);
            else if (pr.name === 'y') y = plyRead(dv, off, pr.type);
            else if (pr.name === 'z') z = plyRead(dv, off, pr.type);
            off += PLY_SIZE[pr.type];
          }
        }
        if (el.name === 'vertex') pos.push3(x, y, z);
      }
    }
  } else {
    throw new Error(`이 PLY 형식(${format})은 읽을 수 없습니다.`);
  }
  const positions = pos.done();
  if (!positions.length) throw new Error('파일에서 점을 찾지 못했습니다.');
  const indices = idx.done();
  return { positions, indices: indices.length ? indices : null };
}

/** 4x4 행렬 곱 (열 우선) */
function matMul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function nodeMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  return Float64Array.from([
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** GLB: 이진 glTF. 압축되지 않은 삼각형 메시를 읽는다 */
function parseGlb(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB 파일이 아닙니다.');
  let json = null;
  let binStart = 0;
  let off = 12;
  while (off + 8 <= buffer.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off + 8, len)));
    else if (type === 0x004e4942) binStart = off + 8;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !binStart) throw new Error('GLB 파일의 내용을 읽을 수 없습니다.');
  const used = [...(json.extensionsRequired || []), ...(json.extensionsUsed || [])];
  if (used.some((e) => /draco|meshopt/i.test(e))) {
    throw new Error('압축된 GLB는 읽을 수 없습니다. 스캔 앱에서 OBJ로 내보내 주세요.');
  }

  const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = (i) => {
    const acc = json.accessors[i];
    const bv = json.bufferViews[acc.bufferView];
    const comps = NUM[acc.type];
    const size = COMP[acc.componentType];
    return {
      acc,
      base: binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0),
      stride: bv.byteStride || size * comps,
    };
  };

  const pos = new Grow(Float32Array);
  const idx = new Grow(Uint32Array);
  const addMesh = (mesh, m) => {
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      if (prim.attributes.POSITION === undefined) continue;
      const first = pos.n / 3;
      const p = accessor(prim.attributes.POSITION);
      if (p.acc.componentType !== 5126) throw new Error('이 GLB의 좌표 형식은 읽을 수 없습니다. OBJ로 내보내 주세요.');
      for (let i = 0; i < p.acc.count; i++) {
        const o = p.base + i * p.stride;
        const x = dv.getFloat32(o, true);
        const y = dv.getFloat32(o + 4, true);
        const z = dv.getFloat32(o + 8, true);
        pos.push3(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]
        );
      }
      if (prim.indices !== undefined) {
        const q = accessor(prim.indices);
        const get =
          q.acc.componentType === 5125 ? (o) => dv.getUint32(o, true)
          : q.acc.componentType === 5123 ? (o) => dv.getUint16(o, true)
          : (o) => dv.getUint8(o);
        for (let i = 0; i + 2 < q.acc.count; i += 3) {
          idx.push3(first + get(q.base + i * q.stride), first + get(q.base + (i + 1) * q.stride), first + get(q.base + (i + 2) * q.stride));
        }
      } else {
        for (let i = 0; i + 2 < p.acc.count; i += 3) idx.push3(first + i, first + i + 1, first + i + 2);
      }
    }
  };

  const nodes = json.nodes || [];
  const visit = (ni, parent) => {
    const node = nodes[ni];
    const m = matMul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) addMesh(json.meshes[node.mesh], m);
    for (const c of node.children || []) visit(c, m);
  };
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let roots = json.scenes && json.scenes.length ? json.scenes[json.scene || 0].nodes : null;
  if (!roots) {
    const child = new Set(nodes.flatMap((n) => n.children || []));
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  for (const r of roots) visit(r, identity);

  const positions = pos.done();
  if (!positions.length) throw new Error('파일에서 점을 찾지 못했습니다.');
  const indices = idx.done();
  return { positions, indices: indices.length ? indices : null };
}

// ---------------------------------------------------------------- 평면도 만들기

/** 어느 축이 위쪽인지: 바닥처럼 한 높이에 점이 가장 많이 몰린 축 (y 또는 z) */
export function detectUp(positions) {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / 200000));
  const score = (axis) => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i += step) {
      const v = positions[i * 3 + axis];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const bins = Math.max(1, Math.ceil((max - min) / 0.05) + 1);
    const h = new Uint32Array(bins);
    let total = 0;
    for (let i = 0; i < n; i += step) {
      h[Math.floor((positions[i * 3 + axis] - min) / 0.05)]++;
      total++;
    }
    let best = 0;
    for (let b = 0; b < bins; b++) {
      const s = h[b] + (b > 0 ? h[b - 1] : 0) + (b + 1 < bins ? h[b + 1] : 0);
      if (s > best) best = s;
    }
    return best / total;
  };
  return score(1) >= score(2) ? 'y' : 'z';
}

/**
 * 평면도를 만든다.
 *  mesh: parseScanFile의 결과
 *  opts.up: 'auto' | 'y' | 'z'      위쪽 축
 *  opts.mirror: 좌우를 뒤집을지 (결과가 실제와 거울상이면 켠다)
 *  opts.rotate: 'auto' | 'none' | 각도(도)   벽 방향을 격자에 맞추는 회전
 *  opts.turn: 거기에 더할 회전 (90도 단위로 돌려 볼 때)
 * 반환: { up, floor, ceiling, rotation, cell, minX, maxY, cols, rows, wall, floorMask, stats }
 *  격자의 (0, 0)번 칸은 지도 좌표 (minX, maxY) 즉 왼쪽 위다.
 */
export function buildFloorplan(mesh, opts = {}) {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const up = opts.up && opts.up !== 'auto' ? opts.up : detectUp(positions);
  const sx = opts.mirror ? -1 : 1;
  // 지도 좌표로: 위에서 내려다봤을 때 좌우가 뒤집히지 않도록 축을 고른다
  const rawX = (i) => sx * positions[i * 3];
  const rawY = up === 'y' ? (i) => -positions[i * 3 + 2] : (i) => positions[i * 3 + 1];
  const H = up === 'y' ? (i) => positions[i * 3 + 1] : (i) => positions[i * 3 + 2];

  // 바닥과 천장: 높이별 점 개수에서 아래쪽·위쪽의 뚜렷한 봉우리
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = H(i);
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const bins = Math.max(3, Math.ceil((hMax - hMin) / 0.05) + 1);
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) hist[Math.floor((H(i) - hMin) / 0.05)]++;
  const smooth = new Float64Array(bins);
  let peak = 0;
  for (let b = 0; b < bins; b++) {
    smooth[b] = hist[b] + (b > 0 ? hist[b - 1] : 0) + (b + 1 < bins ? hist[b + 1] : 0);
    if (smooth[b] > peak) peak = smooth[b];
  }
  // 끝에서부터 훑어 처음 만나는 뚜렷한 층의 가장 높은 칸을 찾는다
  const peakBin = (from, dir) => {
    for (let b = from; b >= 0 && b < bins; b += dir) {
      if (smooth[b] < peak * 0.2) continue;
      let top = b;
      for (let k = -1; k <= 6; k++) {
        const c = b + k * dir;
        if (c >= 0 && c < bins && hist[c] > hist[top]) top = c;
      }
      return top;
    }
    return -1;
  };
  // 그 칸과 양옆 칸에 든 점들의 평균 높이 (칸 크기보다 정밀하게)
  const levelAt = (bin) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const h = H(i);
      const b = Math.floor((h - hMin) / 0.05);
      if (b >= bin - 1 && b <= bin + 1) {
        sum += h;
        count++;
      }
    }
    return count ? sum / count : hMin + (bin + 0.5) * 0.05;
  };
  const floor = levelAt(peakBin(0, 1));
  let ceiling = levelAt(peakBin(bins - 1, -1));
  if (!(ceiling > floor + 1.8)) ceiling = floor + 2.6;
  const lo = floor + 0.35;
  const hi = Math.max(lo + 0.5, Math.min(ceiling - 0.25, floor + 2.0));

  // 삼각형마다: 세워진 면(벽)인지, 누운 면(바닥)인지
  const tri = indices ? indices.length / 3 : 0;
  const kind = new Uint8Array(tri); // 1 벽, 2 바닥
  const upAxis = up === 'y' ? 1 : 2;
  const dirHist = new Float64Array(90); // 벽 방향(0~90도)별 면적
  const dirSum = new Float64Array(90); // 같은 칸에 든 각도의 면적 가중 합 (정밀한 평균용)
  for (let t = 0; t < tri; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-10) continue;
    const nUp = Math.abs(upAxis === 1 ? ny : nz) / len;
    const ha = H(a);
    const hb = H(b);
    const hc = H(c);
    if (nUp < 0.35) {
      if (Math.max(ha, hb, hc) < lo || Math.min(ha, hb, hc) > hi) continue;
      kind[t] = 1;
      // 벽이 뻗은 방향 (법선에 수직인 수평 방향). 90도마다 같은 방향으로 본다.
      const hx = sx * nx;
      const hy = upAxis === 1 ? -nz : ny;
      let ang = (Math.atan2(hx, hy) * 180) / Math.PI;
      ang = ((ang % 90) + 90) % 90;
      const bin = Math.min(89, Math.floor(ang));
      dirHist[bin] += len;
      dirSum[bin] += len * ang;
    } else if (nUp > 0.8 && Math.abs(ha - floor) < 0.2 && Math.abs(hb - floor) < 0.2 && Math.abs(hc - floor) < 0.2) {
      kind[t] = 2;
    }
  }

  // 벽이 주로 향하는 방향에 맞춰 돌린다
  let rotation = 0;
  if (typeof opts.rotate === 'number') {
    rotation = opts.rotate;
  } else if (opts.rotate !== 'none' && tri) {
    let best = 0;
    let mean = 0;
    for (let d = 0; d < 90; d++) {
      const s = dirHist[d] + dirHist[(d + 1) % 90] + dirHist[(d + 89) % 90];
      mean += dirHist[d] / 90;
      if (s > dirHist[best] + dirHist[(best + 1) % 90] + dirHist[(best + 89) % 90]) best = d;
    }
    const top = dirHist[best] + dirHist[(best + 1) % 90] + dirHist[(best + 89) % 90];
    if (top > mean * 3 * 2) {
      // 봉우리 주변 각도들의 가중 평균. 0도와 90도는 같은 방향이라 이어 붙여 계산한다.
      let sw = 0;
      let sa = 0;
      for (let k = -3; k <= 3; k++) {
        const b = (best + k + 90) % 90;
        if (!dirHist[b]) continue;
        let a = dirSum[b] / dirHist[b];
        if (a - best > 45) a -= 90;
        else if (best - a > 45) a += 90;
        sw += dirHist[b];
        sa += dirHist[b] * a;
      }
      rotation = sa / sw;
      if (rotation > 45) rotation -= 90;
    }
  }
  rotation += opts.turn || 0; // 사용자가 고른 90도 단위 회전
  const cr = Math.cos((rotation * Math.PI) / 180);
  const sr = Math.sin((rotation * Math.PI) / 180);
  // 방위각 rotation만큼 기울어진 벽을 축에 나란하게: 지도 좌표를 반시계로 rotation만큼 돌린다
  const X = (i) => rawX(i) * cr - rawY(i) * sr;
  const Y = (i) => rawX(i) * sr + rawY(i) * cr;

  // 범위 (바닥~천장 사이의 점만)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const h = H(i);
    if (h < floor - 0.3 || h > ceiling + 0.3) continue;
    const x = X(i);
    const y = Y(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!(maxX > minX)) throw new Error('스캔에서 바닥 높이의 점을 찾지 못했습니다. 위쪽 축 설정을 바꿔 보세요.');
  const pad = 0.5;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  let cell = CELL;
  while (((maxX - minX) / cell) * ((maxY - minY) / cell) > 3.0e7) cell *= 2; // 너무 넓으면 칸을 키운다
  const cols = Math.ceil((maxX - minX) / cell);
  const rows = Math.ceil((maxY - minY) / cell);
  const wall = new Uint16Array(cols * rows);
  const floorMask = new Uint8Array(cols * rows);
  const col = (x) => Math.floor((x - minX) / cell);
  const row = (y) => Math.floor((maxY - y) / cell);

  const line = (x1, y1, x2, y2) => {
    const c1 = (x1 - minX) / cell;
    const r1 = (maxY - y1) / cell;
    const c2 = (x2 - minX) / cell;
    const r2 = (maxY - y2) / cell;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(c2 - c1), Math.abs(r2 - r1)) * 1.5));
    for (let s = 0; s <= steps; s++) {
      const c = Math.floor(c1 + ((c2 - c1) * s) / steps);
      const r = Math.floor(r1 + ((r2 - r1) * s) / steps);
      if (c >= 0 && c < cols && r >= 0 && r < rows) {
        const k = r * cols + c;
        if (wall[k] < 65535) wall[k]++;
      }
    }
  };

  if (tri) {
    for (let t = 0; t < tri; t++) {
      if (!kind[t]) continue;
      const a = indices[t * 3];
      const b = indices[t * 3 + 1];
      const c = indices[t * 3 + 2];
      const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), cx = X(c), cy = Y(c);
      if (kind[t] === 1) {
        line(ax, ay, bx, by);
        line(bx, by, cx, cy);
        line(cx, cy, ax, ay);
      } else {
        // 바닥 삼각형을 칠한다
        const c0 = Math.max(0, col(Math.min(ax, bx, cx)));
        const c1 = Math.min(cols - 1, col(Math.max(ax, bx, cx)));
        const r0 = Math.max(0, row(Math.max(ay, by, cy)));
        const r1 = Math.min(rows - 1, row(Math.min(ay, by, cy)));
        const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(d) < 1e-12) continue;
        for (let r = r0; r <= r1; r++) {
          const py = maxY - (r + 0.5) * cell;
          for (let cc = c0; cc <= c1; cc++) {
            const px = minX + (cc + 0.5) * cell;
            const w1 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / d;
            const w0 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / d;
            if (w0 >= -0.05 && w1 >= -0.05 && w0 + w1 <= 1.05) floorMask[r * cols + cc] = 1;
          }
        }
      }
    }
  } else {
    // 점 구름: 면이 없으므로 높이만 보고 나눈다
    for (let i = 0; i < n; i++) {
      const h = H(i);
      const c = col(X(i));
      const r = row(Y(i));
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const k = r * cols + c;
      if (h >= lo && h <= hi) {
        if (wall[k] < 65535) wall[k]++;
      } else if (Math.abs(h - floor) < 0.12) {
        floorMask[k] = 1;
      }
    }
  }

  // 점 구름은 잡음이 많아 두 번 이상 찍힌 칸만 벽으로 본다
  const threshold = tri ? 1 : 2;
  let wallCells = 0;
  for (let k = 0; k < wall.length; k++) {
    if (wall[k] >= threshold) wallCells++;
    else wall[k] = 0;
  }

  return {
    up,
    floor,
    ceiling,
    rotation,
    cell,
    minX,
    maxY,
    cols,
    rows,
    wall,
    floorMask,
    stats: {
      vertices: n,
      triangles: tri,
      width: cols * cell,
      height: rows * cell,
      wallCells,
      roomHeight: ceiling - floor,
    },
  };
}

/** 평면도 그림에서 "정확한 벽 칸"으로 보는 픽셀의 빨강 값 상한 */
export const WALL_PIXEL_MAX = 45;

/** 평면도를 그림(캔버스)으로. 한 칸이 1픽셀이고, 벽은 진하게, 스캔된 바닥은 옅게 칠한다 */
export function renderFloorplan(fp) {
  const canvas = document.createElement('canvas');
  canvas.width = fp.cols;
  canvas.height = fp.rows;
  const g = canvas.getContext('2d');
  const img = g.createImageData(fp.cols, fp.rows);
  const d = img.data;
  const { cols, rows, wall, floorMask } = fp;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      // 벽 칸은 아주 진하게, 그 이웃 칸은 조금 덜 진하게 칠해 선이 굵어 보이게 한다.
      // (그림에서 정확한 벽 위치를 다시 읽을 때는 아주 진한 칸만 쓴다: WALL_PIXEL_MAX)
      const exact = wall[k] > 0;
      const near =
        !exact &&
        ((c > 0 && wall[k - 1] > 0) ||
          (c + 1 < cols && wall[k + 1] > 0) ||
          (r > 0 && wall[k - cols] > 0) ||
          (r + 1 < rows && wall[k + cols] > 0));
      const o = k * 4;
      if (exact) {
        d[o] = 20;
        d[o + 1] = 28;
        d[o + 2] = 42;
        d[o + 3] = 255;
      } else if (near) {
        d[o] = 74;
        d[o + 1] = 84;
        d[o + 2] = 102;
        d[o + 3] = 255;
      } else if (floorMask[k]) {
        d[o] = 214;
        d[o + 1] = 228;
        d[o + 2] = 250;
        d[o + 3] = 255;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
