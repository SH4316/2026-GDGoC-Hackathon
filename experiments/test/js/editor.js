// 지도 편집기 (editor.html): 통로, QR, 목적지, 벽을 화면에서 찍어 지도를 만들고 maps/ 에 저장한다.
//
// 좌표는 미터, x는 오른쪽, y는 위쪽. 방향은 위쪽이 0도이고 시계 방향으로 커진다 (앱과 같은 규칙).

import { POI_TYPES, poiName, poiIcon } from './destinations.js';
import { qrMatrix } from './qr.js';
import { parseScanFile, buildFloorplan, renderFloorplan, WALL_PIXEL_MAX } from './scan-import.js';
import { normalizeGraph, describeFixes } from './graphfix.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv');
const g = cv.getContext('2d');
const rad = (d) => (d * Math.PI) / 180;
const normDeg = (d) => ((d % 360) + 360) % 360;
const r2 = (v) => Math.round(v * 100) / 100;
const bearing = (a, b) => normDeg((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI);

const TOOLS = [
  { id: 'select', label: '선택·이동', key: 'V', hint: '항목을 눌러 고르고 끌어서 옮깁니다. 빈 곳을 끌면 화면이 움직입니다. Delete로 지웁니다.' },
  { id: 'path', label: '통로', key: 'C', hint: '사람이 걷는 길을 따라 차례로 누릅니다. 갈림길은 이미 그린 통로 위를 누르면 이어집니다. Esc로 끝냅니다.' },
  { id: 'wallqr', label: '벽 QR', key: 'Q', hint: '벽에 붙일 QR의 위치를 누릅니다. 파란 화살표는 QR이 바라보는 방향이고, 끝의 동그라미를 끌어 돌립니다.' },
  { id: 'floorqr', label: '바닥 QR', key: 'F', hint: '바닥에 붙일 QR의 위치를 누릅니다. 주황 화살표는 인쇄된 QR의 위쪽 방향입니다.' },
  { id: 'poi', label: '목적지', key: 'P', hint: '통로 위에서 목적지 위치를 누릅니다. 종류는 오른쪽에서 먼저 고릅니다.' },
  { id: 'wall', label: '벽', key: 'W', hint: '벽을 따라 차례로 누릅니다. 미니맵과 가상 역에 그려집니다 (없어도 안내는 됩니다). Esc로 끝냅니다.' },
];
const BG_TOOLS = {
  bgmove: '도면 그림을 끌어서 옮깁니다.',
  bgscale: '도면에서 실제 거리를 아는 두 점을 차례로 누릅니다.',
};

const ed = {
  id: 'mymap',
  name: '',
  markerSize: 0.16,
  extra: {}, // 불러온 지도에서 편집기가 다루지 않는 값 (다른 언어 이름)
  nodes: [], // { id, x, y }
  edges: [], // { a, b }
  markers: [], // { id, mount, x, y, h, facing, size? }
  pois: [], // { id, type, number?, node, name?, detail?, keywords? }
  walls: [], // { x1, y1, x2, y2 }
  view: { cx: 0, cy: 0, scale: 40 }, // scale: 1m가 몇 픽셀인지
  tool: 'select',
  sel: null, // { kind, ref }
  chain: null, // 통로: 직전 점의 id, 벽: 직전 점 { x, y }
  snap: 0.25,
  poiType: 'exit',
  bg: null, // { img, x, y, mpp, opacity, scan }  x, y는 그림 왼쪽 위의 지도 좌표
  scan: null, // 가져온 LiDAR 스캔: { mesh, opts, fp, name }
  wallGrid: null, // 스캔 평면도의 벽 칸들 (벽 QR을 벽에 붙일 때 쓴다)
  scalePick: null,
  mouse: { x: 0, y: 0, sx: 0, sy: 0 },
  drag: null,
  dirty: false,
  loadedId: null,
  serverMaps: [],
  phoneBase: null,
};
const undoStack = [];

// ---------------------------------------------------------------- 좌표

function viewSize() {
  return { w: cv.clientWidth, h: cv.clientHeight };
}
function toScreen(p) {
  const { w, h } = viewSize();
  return { x: w / 2 + (p.x - ed.view.cx) * ed.view.scale, y: h / 2 - (p.y - ed.view.cy) * ed.view.scale };
}
function toWorld(sx, sy) {
  const { w, h } = viewSize();
  return { x: ed.view.cx + (sx - w / 2) / ed.view.scale, y: ed.view.cy - (sy - h / 2) / ed.view.scale };
}
function snapPoint(p, free) {
  if (!ed.snap || free) return { x: r2(p.x), y: r2(p.y) };
  return { x: r2(Math.round(p.x / ed.snap) * ed.snap), y: r2(Math.round(p.y / ed.snap) * ed.snap) };
}
const nodeById = (id) => ed.nodes.find((n) => n.id === id);

/** 선분 ab 위에서 p에 가장 가까운 점 */
function closestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  const q = { x: a.x + dx * t, y: a.y + dy * t };
  return { q, t, dist: Math.hypot(p.x - q.x, p.y - q.y) };
}

function nearestEdge(p) {
  let best = null;
  for (const e of ed.edges) {
    const a = nodeById(e.a);
    const b = nodeById(e.b);
    if (!a || !b) continue;
    const c = closestOnSegment(p, a, b);
    if (!best || c.dist < best.dist) best = { ...c, edge: e, a, b };
  }
  return best;
}

// ---------------------------------------------------------------- 되돌리기

function modelSnapshot() {
  return JSON.stringify({
    nodes: ed.nodes, edges: ed.edges, markers: ed.markers, pois: ed.pois, walls: ed.walls,
  });
}
/** 내용을 바꾸기 직전에 부른다 */
function pushUndo() {
  undoStack.push(modelSnapshot());
  if (undoStack.length > 200) undoStack.shift();
  ed.dirty = true;
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  Object.assign(ed, JSON.parse(s));
  ed.sel = null;
  ed.chain = null;
  refresh();
}

// ---------------------------------------------------------------- 모델 조작

function nextId(prefix, taken) {
  for (let i = 1; ; i++) {
    if (!taken.includes(prefix + i)) return prefix + i;
  }
}
function addNode(p) {
  const n = { id: nextId('n', ed.nodes.map((x) => x.id)), x: p.x, y: p.y };
  ed.nodes.push(n);
  return n;
}
function addEdge(a, b) {
  if (a === b) return;
  if (ed.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
  ed.edges.push({ a, b });
}
function splitEdge(edge, q) {
  const n = addNode({ x: r2(q.x), y: r2(q.y) });
  ed.edges = ed.edges.filter((e) => e !== edge);
  ed.edges.push({ a: edge.a, b: n.id }, { a: n.id, b: edge.b });
  return n;
}

/**
 * 통로 그래프에서 "이어져 보이지만 이어지지 않은" 곳을 고친다: 선이 다른 갈림점 위를 지나가기만 하는 곳,
 * 선끼리 교차하는 곳, 같은 자리에 두 번 찍힌 점. 고친 내용을 한 줄로 돌려준다 (없으면 빈 문자열).
 */
function tidyGraph() {
  const fixed = normalizeGraph(ed.nodes, ed.edges);
  const text = describeFixes(fixed.fixes);
  if (!text) return '';
  ed.nodes = fixed.nodes;
  ed.edges = fixed.edges;
  for (const poi of ed.pois) {
    if (fixed.alias.has(poi.node)) poi.node = fixed.alias.get(poi.node);
  }
  if (ed.chain && typeof ed.chain === 'string' && fixed.alias.has(ed.chain)) ed.chain = fixed.alias.get(ed.chain);
  if (ed.sel && (ed.sel.kind === 'node' || ed.sel.kind === 'edge')) ed.sel = null;
  return text;
}

/**
 * 누른 자리에 해당하는 통로 위의 점을 찾는다: 기존 점 → 통로 선 위(쪼개서 새 점) → (허용하면) 새 점.
 */
function resolveNode(world, screen, free, createIfEmpty) {
  const hitN = hitNode(screen);
  if (hitN) return hitN;
  const ne = nearestEdge(world);
  if (ne && ne.dist * ed.view.scale < 9) return splitEdge(ne.edge, ne.q);
  return createIfEmpty ? addNode(snapPoint(world, free)) : null;
}

/** QR을 놓을 때의 기본 방향: 벽 QR은 가까운 통로 쪽, 바닥 QR은 통로가 뻗은 방향 */
function autoFacing(mount, p) {
  const ne = nearestEdge(p);
  if (!ne) return mount === 'floor' ? 0 : 180;
  if (mount === 'floor') return Math.round(bearing(ne.a, ne.b) / 5) * 5 % 360;
  if (ne.dist < 0.05) return 180;
  return Math.round(bearing(p, ne.q) / 5) * 5 % 360;
}

/**
 * 스캔 평면도가 있을 때, p 근처의 벽을 찾아 그 벽 위의 점과 QR이 바라볼 방향을 돌려준다.
 */
function wallFit(p) {
  const gr = ed.wallGrid;
  if (!gr) return null;
  const cellsNear = (cx, cy, radius) => {
    const out = [];
    const c0 = Math.floor((cx - gr.minX) / gr.cell);
    const r0 = Math.floor((gr.maxY - cy) / gr.cell);
    const k = Math.ceil(radius / gr.cell);
    for (let r = Math.max(0, r0 - k); r <= Math.min(gr.rows - 1, r0 + k); r++) {
      for (let c = Math.max(0, c0 - k); c <= Math.min(gr.cols - 1, c0 + k); c++) {
        if (!gr.data[r * gr.cols + c]) continue;
        const x = gr.minX + (c + 0.5) * gr.cell;
        const y = gr.maxY - (r + 0.5) * gr.cell;
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius) out.push({ x, y, d });
      }
    }
    return out;
  };
  const around = cellsNear(p.x, p.y, 0.6);
  if (!around.length) return null;
  const nearest = around.reduce((a, b) => (a.d < b.d ? a : b));
  // 가장 가까운 벽 칸 주변만 보고 벽이 뻗은 방향을 구한다 (모서리에서 두 벽이 섞이지 않게)
  const pts = cellsNear(nearest.x, nearest.y, 0.45);
  if (pts.length < 5) return null;
  let mx = 0;
  let my = 0;
  for (const q of pts) {
    mx += q.x;
    my += q.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const q of pts) {
    cxx += (q.x - mx) ** 2;
    cyy += (q.y - my) ** 2;
    cxy += (q.x - mx) * (q.y - my);
  }
  const t = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const dir = { x: Math.cos(t), y: Math.sin(t) };
  // 한 방향으로 길게 늘어선 모양이 아니면(모서리, 기둥) 붙이지 않는다
  const along = cxx * dir.x * dir.x + 2 * cxy * dir.x * dir.y + cyy * dir.y * dir.y;
  const across = cxx + cyy - along;
  if (across > along * 0.2) return null;
  const s = (p.x - mx) * dir.x + (p.y - my) * dir.y;
  const q = { x: mx + s * dir.x, y: my + s * dir.y };
  let nrm = { x: -dir.y, y: dir.x };
  // QR은 통로 쪽을 바라봐야 한다. 가까운 통로가 있으면 그쪽, 없으면 누른 쪽.
  const ne = nearestEdge(q);
  let side;
  if (ne && ne.dist > 0.15 && ne.dist < 8) side = (ne.q.x - q.x) * nrm.x + (ne.q.y - q.y) * nrm.y;
  else side = (p.x - q.x) * nrm.x + (p.y - q.y) * nrm.y;
  if (side < 0) nrm = { x: -nrm.x, y: -nrm.y };
  return { x: r2(q.x), y: r2(q.y), facing: Math.round(normDeg((Math.atan2(nrm.x, nrm.y) * 180) / Math.PI)) };
}

function addMarker(mount, p) {
  const prefix = mount === 'floor' ? 'F' : 'W';
  const m = {
    id: nextId(prefix, ed.markers.map((x) => x.id)),
    mount,
    x: p.x,
    y: p.y,
    facing: autoFacing(mount, p),
  };
  if (mount === 'wall') {
    m.h = 1.5;
    const fit = wallFit(p);
    if (fit) Object.assign(m, fit);
  }
  ed.markers.push(m);
  return m;
}

function addPoi(node) {
  const type = ed.poiType;
  const poi = { id: '', type, node: node.id };
  if (type === 'exit') {
    const used = ed.pois.filter((p) => p.type === 'exit').map((p) => p.number);
    let n = 1;
    while (used.includes(n)) n++;
    poi.number = n;
  }
  poi.id = poiId(poi);
  ed.pois.push(poi);
  return poi;
}

function poiId(poi) {
  const taken = ed.pois.filter((p) => p !== poi).map((p) => p.id);
  const base = poi.type === 'exit' && poi.number != null ? `exit${poi.number}` : poi.type;
  if (!taken.includes(base)) return base;
  return nextId(base + '-', taken);
}

/**
 * 빠른 시작: 복도 모양과 길이만으로 기본 지도를 만든다.
 * 출발점은 (0, 0)이고 위쪽으로 lenA만큼 간다. ㄱ자는 거기서 오른쪽으로, T자는 양쪽으로 lenB만큼 뻗는다.
 * 만든 뒤에 QR과 목적지를 끌어서 실제 위치에 맞추면 된다.
 */
function quickStart(shape, lenA, lenB, width) {
  const h = width / 2;
  const nodes = [
    { id: 'n1', x: 0, y: 0 },
    { id: 'n2', x: 0, y: lenA },
  ];
  const edges = [{ a: 'n1', b: 'n2' }];
  const pois = [{ id: 'exit1', type: 'exit', number: 1, node: 'n1' }];
  const markers = [];
  const walls = [];
  const floorQr = (x, y, facing) =>
    markers.push({ id: `F${markers.length + 1}`, mount: 'floor', x: r2(x), y: r2(y), facing });
  const wall = (x1, y1, x2, y2) => walls.push({ x1, y1, x2, y2 });

  // 출발 지점 바로 앞에 하나, 그 뒤로 8m마다 바닥 QR
  for (let y = Math.min(1.5, lenA / 3); y < lenA - 2.5; y += 8) floorQr(0, y, 0);

  if (shape === 'I') {
    pois.push({ id: 'toilet', type: 'toilet', node: 'n2' });
    wall(-h, -1, -h, lenA + 1);
    wall(h, -1, h, lenA + 1);
    wall(-h, -1, h, -1);
    wall(-h, lenA + 1, h, lenA + 1);
  } else {
    floorQr(0, lenA, 0); // 갈림길
    nodes.push({ id: 'n3', x: lenB, y: lenA });
    edges.push({ a: 'n2', b: 'n3' });
    for (let x = 8; x < lenB - 2.5; x += 8) floorQr(x, lenA, 90);
    wall(-h, -1, h, -1);
    wall(h, -1, h, lenA - h);
    wall(h, lenA - h, lenB + 1, lenA - h);
    wall(lenB + 1, lenA - h, lenB + 1, lenA + h);
    if (shape === 'L') {
      pois.push({ id: 'toilet', type: 'toilet', node: 'n3' });
      wall(-h, -1, -h, lenA + h);
      wall(-h, lenA + h, lenB + 1, lenA + h);
    } else {
      nodes.push({ id: 'n4', x: -lenB, y: lenA });
      edges.push({ a: 'n2', b: 'n4' });
      for (let x = 8; x < lenB - 2.5; x += 8) floorQr(-x, lenA, 270);
      pois.push({ id: 'toilet', type: 'toilet', node: 'n4' }, { id: 'platform', type: 'platform', node: 'n3' });
      wall(-h, -1, -h, lenA - h);
      wall(-h, lenA - h, -lenB - 1, lenA - h);
      wall(-lenB - 1, lenA - h, -lenB - 1, lenA + h);
      wall(-lenB - 1, lenA + h, lenB + 1, lenA + h);
    }
  }

  pushUndo();
  Object.assign(ed, { nodes, edges, markers, pois, walls, sel: null, chain: null, tool: 'select' });
  fitView();
  refresh();
  setStatus('기본 지도를 만들었습니다. QR과 목적지를 끌어서 실제 위치에 맞추세요.');
}

/** 지금 무엇을 하면 되는지 한 줄로 */
function nextStepText() {
  if (!ed.edges.length && ed.bg) return '① 왼쪽 "통로"를 누르고, 평면도 위에서 걷는 길을 따라 클릭하세요.';
  if (!ed.edges.length) return '① "LiDAR 스캔 가져오기"로 평면도를 깔거나, 오른쪽 "빠른 시작"으로 만들거나, 왼쪽 "통로"로 직접 그리세요.';
  if (!ed.pois.length) return '② 왼쪽 "목적지"를 누르고, 통로 위에 출구·화장실 등을 놓으세요.';
  if (!ed.markers.length) return '③ 왼쪽 "바닥 QR"이나 "벽 QR"을 누르고, QR을 붙일 자리를 클릭하세요.';
  if (ed.dirty || !ed.saved) return '④ 실제 위치에 맞게 끌어서 고친 뒤, 위의 "저장"을 누르세요.';
  return '⑤ "가상 역에서 미리보기"로 확인하고, "QR 인쇄"로 인쇄해 붙이세요.';
}

function deleteSelected() {
  const s = ed.sel;
  if (!s) return;
  pushUndo();
  if (s.kind === 'node') {
    ed.nodes = ed.nodes.filter((n) => n !== s.ref);
    ed.edges = ed.edges.filter((e) => e.a !== s.ref.id && e.b !== s.ref.id);
    ed.pois = ed.pois.filter((p) => p.node !== s.ref.id);
  } else if (s.kind === 'edge') {
    ed.edges = ed.edges.filter((e) => e !== s.ref);
  } else if (s.kind === 'marker') {
    ed.markers = ed.markers.filter((m) => m !== s.ref);
  } else if (s.kind === 'poi') {
    ed.pois = ed.pois.filter((p) => p !== s.ref);
  } else if (s.kind === 'wall') {
    ed.walls = ed.walls.filter((w) => w !== s.ref);
  }
  ed.sel = null;
  refresh();
}

// ---------------------------------------------------------------- 누른 자리에 무엇이 있는지

function hitNode(s) {
  let best = null;
  for (const n of ed.nodes) {
    const p = toScreen(n);
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d < 11 && (!best || d < best.d)) best = { n, d };
  }
  return best ? best.n : null;
}

function handlePos(m) {
  const p = toScreen(m);
  const a = rad(m.facing);
  return { x: p.x + Math.sin(a) * 46, y: p.y - Math.cos(a) * 46 };
}

function hitTest(s) {
  for (const m of ed.markers) {
    const p = toScreen(m);
    if (Math.abs(p.x - s.x) < 12 && Math.abs(p.y - s.y) < 12) return { kind: 'marker', ref: m };
  }
  const n = hitNode(s);
  if (n) {
    const poi = ed.pois.find((p) => p.node === n.id);
    return poi ? { kind: 'poi', ref: poi } : { kind: 'node', ref: n };
  }
  const w = toWorld(s.x, s.y);
  const ne = nearestEdge(w);
  if (ne && ne.dist * ed.view.scale < 7) return { kind: 'edge', ref: ne.edge };
  for (const wall of ed.walls) {
    const c = closestOnSegment(w, { x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 });
    if (c.dist * ed.view.scale < 6) return { kind: 'wall', ref: wall };
  }
  return null;
}

// ---------------------------------------------------------------- 그리기

function niceStep() {
  // 격자 간격: 화면에서 너무 촘촘하지 않게
  for (const s of [0.5, 1, 2, 5, 10, 20, 50]) if (s * ed.view.scale >= 28) return s;
  return 100;
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = viewSize();
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const k = ed.view.scale;

  // 배경 도면
  if (ed.bg && ed.bg.img) {
    const p = toScreen({ x: ed.bg.x, y: ed.bg.y });
    g.globalAlpha = ed.bg.opacity;
    g.drawImage(ed.bg.img, p.x, p.y, ed.bg.img.width * ed.bg.mpp * k, ed.bg.img.height * ed.bg.mpp * k);
    g.globalAlpha = 1;
  }

  // 격자
  const step = niceStep();
  const tl = toWorld(0, 0);
  const br = toWorld(w, h);
  g.lineWidth = 1;
  for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
    const sx = Math.round(toScreen({ x, y: 0 }).x) + 0.5;
    g.strokeStyle = Math.abs(x) < 1e-9 ? '#9aa6b5' : Math.round(x / step) % 5 === 0 ? '#d3dae3' : '#e8ecf1';
    g.beginPath();
    g.moveTo(sx, 0);
    g.lineTo(sx, h);
    g.stroke();
  }
  for (let y = Math.floor(br.y / step) * step; y <= tl.y; y += step) {
    const sy = Math.round(toScreen({ x: 0, y }).y) + 0.5;
    g.strokeStyle = Math.abs(y) < 1e-9 ? '#9aa6b5' : Math.round(y / step) % 5 === 0 ? '#d3dae3' : '#e8ecf1';
    g.beginPath();
    g.moveTo(0, sy);
    g.lineTo(w, sy);
    g.stroke();
  }

  const isSel = (kind, ref) => ed.sel && ed.sel.kind === kind && ed.sel.ref === ref;

  // 벽
  g.lineCap = 'round';
  for (const wl of ed.walls) {
    const a = toScreen({ x: wl.x1, y: wl.y1 });
    const b = toScreen({ x: wl.x2, y: wl.y2 });
    g.strokeStyle = isSel('wall', wl) ? '#e8590c' : '#4b5565';
    g.lineWidth = isSel('wall', wl) ? 4 : 2.5;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
  }

  // 통로
  for (const e of ed.edges) {
    const a = nodeById(e.a);
    const b = nodeById(e.b);
    if (!a || !b) continue;
    const pa = toScreen(a);
    const pb = toScreen(b);
    g.strokeStyle = isSel('edge', e) ? '#e8590c' : 'rgba(30,107,255,0.55)';
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(pa.x, pa.y);
    g.lineTo(pb.x, pb.y);
    g.stroke();
  }
  for (const n of ed.nodes) {
    const p = toScreen(n);
    const sel = isSel('node', n);
    g.fillStyle = '#fff';
    g.strokeStyle = sel ? '#e8590c' : '#1e6bff';
    g.lineWidth = sel ? 3.5 : 2;
    g.beginPath();
    g.arc(p.x, p.y, ed.chain === n.id ? 7 : 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  // 목적지
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const poi of ed.pois) {
    const n = nodeById(poi.node);
    if (!n) continue;
    const p = toScreen(n);
    const sel = isSel('poi', poi);
    g.fillStyle = poi.type === 'exit' ? '#ffcc00' : '#fff';
    g.strokeStyle = sel ? '#e8590c' : '#12305f';
    g.lineWidth = sel ? 3.5 : 2;
    g.beginPath();
    g.arc(p.x, p.y, 14, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = '#111';
    g.font = '15px system-ui, "Apple Color Emoji", sans-serif';
    g.fillText(poi.type === 'exit' && poi.number != null ? String(poi.number) : poiIcon(poi), p.x, p.y + 1);
    label(poiName(poi, 'ko'), p.x, p.y + 26, '#12305f');
  }

  // QR
  for (const m of ed.markers) {
    const p = toScreen(m);
    const sel = isSel('marker', m);
    const color = m.mount === 'floor' ? '#e8590c' : '#1e6bff';
    const hp = handlePos(m);
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(hp.x, hp.y);
    g.stroke();
    arrowHead(p, hp, color);
    g.fillStyle = '#111';
    g.fillRect(p.x - 8, p.y - 8, 16, 16);
    g.fillStyle = '#fff';
    g.fillRect(p.x - 5, p.y - 5, 4, 4);
    g.fillRect(p.x + 1, p.y - 5, 4, 4);
    g.fillRect(p.x - 5, p.y + 1, 4, 4);
    if (sel) {
      g.strokeStyle = '#e8590c';
      g.lineWidth = 3;
      g.strokeRect(p.x - 11, p.y - 11, 22, 22);
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(hp.x, hp.y, 7, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    label(`${m.id} ${m.mount === 'floor' ? '바닥' : '벽'}`, p.x, p.y - 20, color);
  }

  // 그리는 중인 선 미리보기
  if (ed.chain && (ed.tool === 'path' || ed.tool === 'wall')) {
    const from = ed.tool === 'path' ? nodeById(ed.chain) : ed.chain;
    if (from) {
      const a = toScreen(from);
      g.setLineDash([6, 5]);
      g.strokeStyle = ed.tool === 'path' ? '#1e6bff' : '#4b5565';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(ed.mouse.sx, ed.mouse.sy);
      g.stroke();
      g.setLineDash([]);
      const d = Math.hypot(ed.mouse.x - from.x, ed.mouse.y - from.y);
      label(`${d.toFixed(2)} m`, (a.x + ed.mouse.sx) / 2, (a.y + ed.mouse.sy) / 2 - 12, '#111');
    }
  }
  if (ed.scalePick) {
    const a = toScreen(ed.scalePick);
    g.strokeStyle = '#c2255c';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(ed.mouse.sx, ed.mouse.sy);
    g.stroke();
  }

  // 축척 막대
  const barM = niceStep();
  g.strokeStyle = '#111';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(14, h - 16);
  g.lineTo(14 + barM * k, h - 16);
  g.stroke();
  g.textAlign = 'left';
  label(`${barM} m`, 14 + barM * k + 22, h - 16, '#111');
}

function label(text, x, y, color) {
  g.font = '600 12px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 3.5;
  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

function arrowHead(from, to, color) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(to.x + Math.cos(a) * 7, to.y + Math.sin(a) * 7);
  g.lineTo(to.x + Math.cos(a + 2.5) * 9, to.y + Math.sin(a + 2.5) * 9);
  g.lineTo(to.x + Math.cos(a - 2.5) * 9, to.y + Math.sin(a - 2.5) * 9);
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------- 오른쪽 패널

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e[k] = v;
  }
  for (const c of children) e.append(c);
  return e;
}

/** 이름표가 붙은 입력 한 줄. 값을 바꾸면 set(value)를 부르고 다시 그린다. */
function row(name, input) {
  return el('div', { class: 'row' }, el('span', {}, name), input);
}
function numInput(value, step, set) {
  return el('input', {
    type: 'number',
    step,
    value,
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      pushUndo();
      set(v);
      refresh();
    },
  });
}
function textInput(value, set, placeholder = '') {
  return el('input', {
    type: 'text',
    value: value || '',
    placeholder,
    onchange: (e) => {
      pushUndo();
      set(e.target.value.trim());
      refresh();
    },
  });
}
function selectInput(value, options, set) {
  const s = el('select', {
    onchange: (e) => {
      pushUndo();
      set(e.target.value);
      refresh();
    },
  });
  for (const [v, text] of options) s.append(el('option', { value: v, textContent: text, selected: v === value }));
  return s;
}

function typeOptions() {
  return Object.entries(POI_TYPES).map(([key, t]) => [key, `${t.icon} ${typeof t.name.ko === 'function' ? '출구' : t.name.ko}`]);
}

function renderPanel() {
  const panel = $('panel');
  panel.innerHTML = '';
  const s = ed.sel;
  const del = el('button', { class: 'danger', textContent: '지우기 (Delete)', onclick: deleteSelected });

  if (s && s.kind === 'marker') {
    const m = s.ref;
    panel.append(
      el('h3', {}, `QR ${m.id}`),
      row('이름(ID)', textInput(m.id, (v) => {
        if (v && !ed.markers.some((x) => x !== m && x.id === v) && /^[A-Za-z0-9_-]+$/.test(v)) m.id = v;
      })),
      row('종류', selectInput(m.mount, [['wall', '벽에 붙임'], ['floor', '바닥에 붙임']], (v) => {
        m.mount = v;
        if (v === 'wall' && m.h == null) m.h = 1.5;
        if (v === 'floor') delete m.h;
      })),
      row('x (m)', numInput(m.x, 0.05, (v) => (m.x = v))),
      row('y (m)', numInput(m.y, 0.05, (v) => (m.y = v)))
    );
    if (m.mount === 'wall') panel.append(row('높이 (m)', numInput(m.h, 0.05, (v) => (m.h = Math.max(0, v)))));
    panel.append(row('방향 (도)', numInput(m.facing, 5, (v) => (m.facing = normDeg(v)))));
    const turn = (d) => () => {
      pushUndo();
      m.facing = normDeg(m.facing + d);
      refresh();
    };
    const snapBtn = [];
    if (m.mount === 'wall' && ed.wallGrid) {
      snapBtn.push(el('button', {
        textContent: '스캔한 벽에 붙이기',
        onclick: () => {
          const fit = wallFit(m);
          if (!fit) {
            setStatus('근처(60cm 안)에 스캔된 벽이 없습니다.', true);
            return;
          }
          pushUndo();
          Object.assign(m, fit);
          refresh();
        },
      }));
    }
    panel.append(
      el('div', { class: 'btns' },
        el('button', { textContent: '↺ 15°', onclick: turn(-15) }),
        el('button', { textContent: '↻ 15°', onclick: turn(15) }),
        el('button', { textContent: '반대로', onclick: turn(180) }),
        ...snapBtn),
      el('p', {}, m.mount === 'wall'
        ? '파란 화살표가 벽에서 통로 쪽을 향해야 합니다. 높이는 바닥에서 QR 중심까지입니다.'
        : '주황 화살표 방향으로 인쇄된 QR의 위쪽(▲ 표시)이 오게 바닥에 놓습니다.'),
      row('크기 (cm)', numInput(Math.round((m.size || ed.markerSize) * 1000) / 10, 0.5, (v) => {
        if (Math.abs(v / 100 - ed.markerSize) < 1e-6) delete m.size;
        else m.size = v / 100;
      })),
      del
    );
    return;
  }

  if (s && s.kind === 'poi') {
    const p = s.ref;
    panel.append(
      el('h3', {}, `목적지 · ${poiName(p, 'ko')}`),
      row('종류', selectInput(p.type, typeOptions(), (v) => {
        p.type = v;
        if (v !== 'exit') delete p.number;
        else if (p.number == null) p.number = 1;
        p.id = poiId(p);
      }))
    );
    if (p.type === 'exit') {
      panel.append(row('출구 번호', numInput(p.number, 1, (v) => {
        p.number = Math.max(1, Math.round(v));
        p.id = poiId(p);
      })));
    }
    const name = p.name || {};
    const setName = (lang) => (v) => {
      const n = { ...(p.name || {}) };
      if (v) n[lang] = v;
      else delete n[lang];
      if (Object.keys(n).length) p.name = n;
      else delete p.name;
    };
    panel.append(
      el('h4', {}, '이름을 따로 붙이려면 (비워 두면 종류 이름)'),
      row('한국어', textInput(name.ko, setName('ko'), '예: 2호선 승강장')),
      row('영어', textInput(name.en, setName('en'), 'e.g. Line 2 platform')),
      el('h4', {}, '찾을 때 쓰는 말 (쉼표로 구분)'),
      row('검색어', textInput((p.keywords || []).join(', '), (v) => {
        const list = v.split(',').map((x) => x.trim()).filter(Boolean);
        if (list.length) p.keywords = list;
        else delete p.keywords;
      }, '2호선, 강남, line 2')),
      del
    );
    return;
  }

  if (s && s.kind === 'node') {
    const n = s.ref;
    panel.append(
      el('h3', {}, '통로 위의 점'),
      row('x (m)', numInput(n.x, 0.05, (v) => (n.x = v))),
      row('y (m)', numInput(n.y, 0.05, (v) => (n.y = v))),
      el('p', {}, '이 점을 지우면 이어진 통로와 여기 있는 목적지도 함께 지워집니다.'),
      del
    );
    return;
  }

  if (s && (s.kind === 'edge' || s.kind === 'wall')) {
    let len;
    if (s.kind === 'edge') {
      const a = nodeById(s.ref.a);
      const b = nodeById(s.ref.b);
      len = Math.hypot(b.x - a.x, b.y - a.y);
    } else {
      len = Math.hypot(s.ref.x2 - s.ref.x1, s.ref.y2 - s.ref.y1);
    }
    panel.append(el('h3', {}, s.kind === 'edge' ? '통로' : '벽'), el('p', {}, `길이 ${len.toFixed(2)} m`), del);
    return;
  }

  // 아무것도 고르지 않았을 때: 빠른 시작, 도구 설정, 지도 설정, 점검
  panel.append(quickStartCard());
  if (ed.tool === 'poi') {
    panel.append(
      el('h3', {}, '놓을 목적지'),
      row('종류', el('select', {
        id: 'poiTypeSel',
        onchange: (e) => (ed.poiType = e.target.value),
      }, ...typeOptions().map(([v, t]) => el('option', { value: v, textContent: t, selected: v === ed.poiType }))))
    );
  }

  panel.append(
    el('h3', {}, '지도 설정'),
    row('QR 한 변 (cm)', el('input', {
      type: 'number', step: 0.5, value: Math.round(ed.markerSize * 1000) / 10,
      onchange: (e) => {
        const v = parseFloat(e.target.value);
        if (v >= 3 && v <= 100) {
          ed.markerSize = v / 100;
          ed.dirty = true;
        }
      },
    })),
    row('격자 맞춤', el('select', { onchange: (e) => (ed.snap = parseFloat(e.target.value)) },
      ...[[0.1, '10 cm'], [0.25, '25 cm'], [0.5, '50 cm'], [1, '1 m'], [0, '끔']].map(([v, t]) =>
        el('option', { value: v, textContent: t, selected: v === ed.snap }))))
  );

  panel.append(el('h4', {}, '점검'));
  const issues = validate();
  if (!issues.length) panel.append(el('p', { class: 'ok', textContent: '문제 없음. 저장하고 가상 역에서 미리 걸어 보세요.' }));
  else panel.append(el('ul', { class: 'warn' }, ...issues.map((t) => el('li', {}, t))));
  panel.append(el('p', {}, `통로 점 ${ed.nodes.length} · QR ${ed.markers.length} · 목적지 ${ed.pois.length} · 벽 ${ed.walls.length}`));

  if (ed.scan) panel.append(scanCard());

  panel.append(
    el('h4', {}, '배경 도면 (선택)'),
    el('p', {}, '안내도나 평면도 사진을 깔고 그 위에 따라 그릴 수 있습니다. 저장하면 지도와 함께 보관됩니다.'),
    el('input', { type: 'file', accept: 'image/*', onchange: (e) => loadBackground(e.target.files[0]) })
  );
  if (ed.bg) {
    panel.append(
      row('투명도', el('input', {
        type: 'range', min: 0.1, max: 1, step: 0.05, value: ed.bg.opacity,
        oninput: (e) => {
          ed.bg.opacity = parseFloat(e.target.value);
          draw();
        },
      })),
      el('div', { class: 'btns' },
        el('button', { textContent: '축척 맞추기', onclick: () => setTool('bgscale') }),
        el('button', { textContent: '도면 옮기기', onclick: () => setTool('bgmove') }),
        el('button', { textContent: '도면 지우기', onclick: () => {
          ed.bg = null;
          refresh();
        } }))
    );
  }

  if (ed.saved) {
    const s2 = ed.saved;
    panel.append(el('h4', {}, '저장한 지도 쓰기'));
    if (ed.phoneBase) {
      const url = `${ed.phoneBase}?map=${s2}&debug=1`;
      panel.append(el('p', {}, '폰에서 열 주소 (기본 카메라로 찍어도 됩니다):'), el('p', {}, el('code', {}, url)),
        el('div', { class: 'qr', html: qrSvg(url, 150) }));
    } else {
      panel.append(el('p', {}, el('code', {}, `(폰에서 연 주소)/?map=${s2}&debug=1`)));
    }
  }

  panel.append(
    el('h4', {}, '순서'),
    el('ul', {},
      el('li', {}, '통로를 그립니다 (걷는 길의 가운데 선).'),
      el('li', {}, '목적지를 통로 위에 놓습니다.'),
      el('li', {}, 'QR 위치를 놓고 방향을 맞춥니다. 갈림길에는 바닥 QR이 좋습니다.'),
      el('li', {}, '저장 → 가상 역에서 미리보기 → QR 인쇄.'))
  );
}

/** 가져온 LiDAR 스캔의 정보와 설정 */
function scanCard() {
  const { fp, opts } = ed.scan;
  const st = fp.stats;
  const again = (change) => () => {
    change();
    applyScan();
  };
  const box = el('div', { style: 'margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #e3e7ec' },
    el('h3', {}, 'LiDAR 스캔 평면도'),
    el('p', {}, `가로 ${(st.width - 1).toFixed(1)}m × 세로 ${(st.height - 1).toFixed(1)}m · 천장 높이 ${st.roomHeight.toFixed(2)}m`),
    el('p', {}, st.triangles
      ? `삼각형 ${st.triangles.toLocaleString()}개 · 실제 크기 그대로입니다.`
      : `점 ${st.vertices.toLocaleString()}개 · 실제 크기 그대로입니다.`),
    row('위쪽 축', el('select', {
      onchange: (e) => again(() => (opts.up = e.target.value))(),
    }, ...[['auto', `자동 (${fp.up.toUpperCase()})`], ['y', 'Y'], ['z', 'Z']].map(([v, t]) =>
      el('option', { value: v, textContent: t, selected: v === opts.up })))),
    el('div', { class: 'btns' },
      el('button', { textContent: opts.mirror ? '좌우 뒤집힘: 켬' : '좌우 뒤집기', onclick: again(() => (opts.mirror = !opts.mirror)) }),
      el('button', { textContent: '90° 돌리기', onclick: again(() => (opts.turn = ((opts.turn || 0) + 90) % 360)) }),
      el('button', { textContent: opts.rotate === 'none' ? '벽에 맞춰 펴기: 끔' : '벽에 맞춰 펴기: 켬', onclick: again(() => (opts.rotate = opts.rotate === 'none' ? 'auto' : 'none')) })),
    el('p', {}, '실제 공간과 좌우가 반대로 보이면 "좌우 뒤집기"를 누르세요. 이 설정은 통로를 그리기 전에 먼저 맞추세요 (나중에 바꾸면 배경만 움직입니다).'));
  return box;
}

/** 스캔에서 평면도를 만들어 배경으로 깐다 */
function applyScan() {
  const sc = ed.scan;
  sc.fp = buildFloorplan(sc.mesh, sc.opts);
  const fp = sc.fp;
  ed.bg = { img: renderFloorplan(fp), x: fp.minX, y: fp.maxY, mpp: fp.cell, opacity: 0.9, scan: true };
  ed.wallGrid = { cols: fp.cols, rows: fp.rows, cell: fp.cell, minX: fp.minX, maxY: fp.maxY, data: fp.wall };
  ed.dirty = true;
  if (!ed.nodes.length) fitView();
  refresh();
}

async function importScan(file) {
  if (!file) return;
  setStatus(`${file.name} 읽는 중…`);
  try {
    const mesh = await parseScanFile(file, (f) => setStatus(`${file.name} 읽는 중… ${Math.round(f * 100)}%`));
    ed.scan = { mesh, opts: { up: 'auto', mirror: false, rotate: 'auto', turn: 0 }, fp: null, name: file.name };
    applyScan();
    const st = ed.scan.fp.stats;
    setStatus(`스캔을 평면도로 만들었습니다 (${(st.width - 1).toFixed(1)}m × ${(st.height - 1).toFixed(1)}m). 그 위에 통로를 그리세요.`);
  } catch (e) {
    console.error(e);
    setStatus(e.message || '스캔 파일을 읽지 못했습니다.', true);
  }
}

/** 배경 그림에서 벽 칸을 다시 뽑는다 (저장했던 스캔 평면도를 불러왔을 때) */
function wallGridFromImage(bg) {
  const c = document.createElement('canvas');
  c.width = bg.img.width;
  c.height = bg.img.height;
  const g2 = c.getContext('2d', { willReadFrequently: true });
  g2.drawImage(bg.img, 0, 0);
  const px = g2.getImageData(0, 0, c.width, c.height).data;
  const data = new Uint8Array(c.width * c.height);
  for (let i = 0; i < data.length; i++) {
    if (px[i * 4 + 3] > 200 && px[i * 4] < WALL_PIXEL_MAX) data[i] = 1;
  }
  return { cols: c.width, rows: c.height, cell: bg.mpp, minX: bg.x, maxY: bg.y, data };
}

/** 복도 모양과 길이를 적는 칸. 지도가 비어 있으면 펼쳐 두고, 아니면 접어 둔다. */
function quickStartCard() {
  const q = ed.quick || (ed.quick = { shape: 'I', a: 10, b: 6, w: 2 });
  const box = el('details', { open: !ed.nodes.length });
  const num = (key, min) => el('input', {
    type: 'number', step: 0.5, min, value: q[key],
    onchange: (e) => {
      const v = parseFloat(e.target.value);
      if (v >= min) q[key] = v;
    },
  });
  const second = row('꺾인 뒤 길이 (m)', num('b', 2));
  second.style.display = q.shape === 'I' ? 'none' : '';
  box.append(
    el('summary', { textContent: '빠른 시작: 복도 모양으로 만들기', style: 'font-weight:700;font-size:15px;cursor:pointer;margin-bottom:8px' }),
    el('p', {}, '모양과 길이를 적으면 통로, 목적지, 바닥 QR이 들어간 기본 지도를 만듭니다. 그다음 끌어서 실제 위치에 맞추면 됩니다.'),
    row('모양', el('select', {
      onchange: (e) => {
        q.shape = e.target.value;
        second.style.display = q.shape === 'I' ? 'none' : '';
      },
    }, ...[['I', '직선 복도'], ['L', 'ㄱ자 복도 (끝에서 오른쪽)'], ['T', 'T자 복도 (끝에서 양쪽)']].map(([v, t]) =>
      el('option', { value: v, textContent: t, selected: v === q.shape })))),
    row('첫 구간 길이 (m)', num('a', 3)),
    second,
    row('복도 폭 (m)', num('w', 1)),
    el('button', {
      class: 'primary',
      textContent: '기본 지도 만들기',
      onclick: () => {
        if (ed.nodes.length && !confirm('지금 그린 내용을 지우고 새로 만들까요? (되돌리기로 복구할 수 있습니다)')) return;
        quickStart(q.shape, q.a, q.b, q.w);
      },
    })
  );
  return el('div', { style: 'margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #e3e7ec' }, box);
}

function qrSvg(text, px) {
  const { n, dark } = qrMatrix(text);
  const q = 3;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  const t = n + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${t} ${t}" shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#fff"/><path d="${d}"/></svg>`;
}

/** 저장 전에 알려 줄 문제들 */
function validate() {
  const out = [];
  if (!ed.edges.length) out.push('통로가 없습니다. "통로" 도구로 걷는 길을 그려 주세요.');
  if (!ed.markers.length) out.push('QR이 없습니다. QR이 있어야 위치를 잡을 수 있습니다.');
  if (!ed.pois.length) out.push('목적지가 없습니다.');
  // 통로가 끊어져 있는지
  if (ed.nodes.length) {
    const seen = new Set();
    const stack = [ed.nodes[0].id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of ed.edges) {
        if (e.a === id) stack.push(e.b);
        else if (e.b === id) stack.push(e.a);
      }
    }
    if (seen.size < ed.nodes.length) {
      out.push(`통로가 끊어진 곳이 있습니다 (이어지지 않은 점 ${ed.nodes.length - seen.size}개). 끊어진 곳으로는 안내할 수 없습니다.`);
    }
  }
  const far = ed.markers.filter((m) => {
    const ne = nearestEdge(m);
    return ne && ne.dist > 4;
  });
  if (far.length) out.push(`통로에서 4m 넘게 떨어진 QR: ${far.map((m) => m.id).join(', ')}`);
  // QR이 드문 구간: 그 사이는 걸음 수로 추정하므로 멀수록 화살표가 실제와 어긋난다
  if (ed.markers.length) {
    let worst = null;
    for (const e of ed.edges) {
      const a = nodeById(e.a);
      const b = nodeById(e.b);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 0; d <= len; d += 1) {
        const x = a.x + ((b.x - a.x) * d) / Math.max(len, 1e-6);
        const y = a.y + ((b.y - a.y) * d) / Math.max(len, 1e-6);
        const near = Math.min(...ed.markers.map((m) => Math.hypot(m.x - x, m.y - y)));
        if (!worst || near > worst.d) worst = { d: near, x, y };
      }
    }
    if (worst && worst.d > 12) {
      out.push(
        `QR에서 가장 먼 통로 지점이 ${Math.round(worst.d)}m 떨어져 있습니다 (x ${Math.round(worst.x)}, y ${Math.round(worst.y)} 부근). ` +
          '걸음 추정은 10m에 1m쯤 틀릴 수 있으니 그 근처에 QR을 하나 더 두면 화살표가 더 정확해집니다.'
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- 도구와 입력

function setTool(id) {
  ed.tool = id;
  ed.chain = null;
  ed.scalePick = null;
  if (id !== 'select') ed.sel = null;
  refresh();
}

function renderTools() {
  const box = $('tools');
  box.innerHTML = '';
  for (const t of TOOLS) {
    box.append(el('button', {
      type: 'button',
      class: ed.tool === t.id ? 'on' : '',
      html: `${t.label}<small>${t.key}</small>`,
      onclick: () => setTool(t.id),
    }));
  }
  box.append(el('hr'), el('button', { type: 'button', textContent: '되돌리기', onclick: undo }),
    el('button', { type: 'button', textContent: '전체 보기', onclick: () => {
      fitView();
      draw();
    } }));
  const t = TOOLS.find((x) => x.id === ed.tool);
  $('hint').textContent = t ? t.hint : BG_TOOLS[ed.tool] || '';
  $('next').textContent = nextStepText();
  cv.style.cursor = ed.tool === 'select' ? 'default' : ed.tool === 'bgmove' ? 'move' : 'crosshair';
}

function refresh() {
  renderTools();
  renderPanel();
  draw();
}

function eventPos(e) {
  const r = cv.getBoundingClientRect();
  const s = { x: e.clientX - r.left, y: e.clientY - r.top };
  return { s, w: toWorld(s.x, s.y) };
}

cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  cv.setPointerCapture(e.pointerId);
  const { s, w } = eventPos(e);
  const free = e.altKey;

  if (ed.tool === 'select') {
    // 고른 QR의 방향 손잡이
    if (ed.sel && ed.sel.kind === 'marker') {
      const hp = handlePos(ed.sel.ref);
      if (Math.hypot(hp.x - s.x, hp.y - s.y) < 11) {
        ed.drag = { type: 'rotate', marker: ed.sel.ref, moved: false };
        return;
      }
    }
    const hit = hitTest(s);
    ed.sel = hit;
    if (hit && hit.kind !== 'edge') {
      ed.drag = { type: 'move', hit, last: snapPoint(w, free), moved: false };
    } else if (!hit) {
      ed.drag = { type: 'pan', sx: s.x, sy: s.y, cx: ed.view.cx, cy: ed.view.cy };
    }
    refresh();
    return;
  }

  if (ed.tool === 'path') {
    pushUndo();
    const n = resolveNode(w, s, free, true);
    if (ed.chain && nodeById(ed.chain)) addEdge(ed.chain, n.id);
    ed.chain = n.id;
    const tidied = tidyGraph();
    if (tidied) setStatus(`자동으로 이었습니다: ${tidied}.`);
  } else if (ed.tool === 'wall') {
    const p = snapPoint(w, free);
    if (ed.chain) {
      if (Math.hypot(p.x - ed.chain.x, p.y - ed.chain.y) > 0.01) {
        pushUndo();
        ed.walls.push({ x1: ed.chain.x, y1: ed.chain.y, x2: p.x, y2: p.y });
      }
    }
    ed.chain = p;
  } else if (ed.tool === 'wallqr' || ed.tool === 'floorqr') {
    pushUndo();
    const m = addMarker(ed.tool === 'floorqr' ? 'floor' : 'wall', snapPoint(w, free));
    ed.sel = { kind: 'marker', ref: m };
    ed.tool = 'select'; // 놓은 뒤 바로 방향을 돌리거나 값을 고칠 수 있게
  } else if (ed.tool === 'poi') {
    const before = modelSnapshot();
    const n = resolveNode(w, s, free, false);
    if (!n) {
      setStatus('목적지는 통로 위에 놓아야 합니다. 먼저 통로를 그려 주세요.', true);
      return;
    }
    if (ed.pois.some((p) => p.node === n.id)) {
      setStatus('이 점에는 이미 목적지가 있습니다.', true);
      return;
    }
    undoStack.push(before);
    ed.dirty = true;
    ed.sel = { kind: 'poi', ref: addPoi(n) };
    ed.tool = 'select';
  } else if (ed.tool === 'bgmove' && ed.bg) {
    ed.drag = { type: 'bg', wx: w.x, wy: w.y, x: ed.bg.x, y: ed.bg.y };
  } else if (ed.tool === 'bgscale' && ed.bg) {
    if (!ed.scalePick) {
      ed.scalePick = w;
    } else {
      const a = ed.scalePick;
      ed.scalePick = null;
      const cur = Math.hypot(w.x - a.x, w.y - a.y);
      const real = parseFloat(prompt('두 점 사이의 실제 거리는 몇 m인가요?', cur.toFixed(2)));
      if (real > 0 && cur > 0) {
        // 첫 번째 점이 제자리에 있도록 그림을 그 점 기준으로 늘리거나 줄인다
        const f = real / cur;
        ed.bg.x = a.x + (ed.bg.x - a.x) * f;
        ed.bg.y = a.y + (ed.bg.y - a.y) * f;
        ed.bg.mpp *= f;
        ed.dirty = true;
      }
      ed.tool = 'select';
    }
  }
  refresh();
});

cv.addEventListener('pointermove', (e) => {
  const { s, w } = eventPos(e);
  ed.mouse = { x: w.x, y: w.y, sx: s.x, sy: s.y };
  $('coords').textContent = `x ${w.x.toFixed(2)}  y ${w.y.toFixed(2)} m`;
  const d = ed.drag;
  if (d) {
    if (d.type === 'pan') {
      ed.view.cx = d.cx - (s.x - d.sx) / ed.view.scale;
      ed.view.cy = d.cy + (s.y - d.sy) / ed.view.scale;
    } else if (d.type === 'bg') {
      ed.bg.x = d.x + (w.x - d.wx);
      ed.bg.y = d.y + (w.y - d.wy);
    } else if (d.type === 'rotate') {
      if (!d.moved) pushUndo();
      d.moved = true;
      const b = bearing(d.marker, w);
      d.marker.facing = e.shiftKey ? Math.round(b) : (Math.round(b / 15) * 15) % 360;
    } else if (d.type === 'move') {
      const p = snapPoint(w, e.altKey);
      const dx = p.x - d.last.x;
      const dy = p.y - d.last.y;
      if (dx || dy) {
        if (!d.moved) pushUndo();
        d.moved = true;
        const { kind, ref } = d.hit;
        if (kind === 'marker') {
          ref.x = p.x;
          ref.y = p.y;
        } else if (kind === 'node' || kind === 'poi') {
          const n = kind === 'node' ? ref : nodeById(ref.node);
          n.x = p.x;
          n.y = p.y;
        } else if (kind === 'wall') {
          ref.x1 = r2(ref.x1 + dx);
          ref.y1 = r2(ref.y1 + dy);
          ref.x2 = r2(ref.x2 + dx);
          ref.y2 = r2(ref.y2 + dy);
        }
        d.last = p;
      }
    }
  }
  draw();
});

cv.addEventListener('pointerup', () => {
  const d = ed.drag;
  ed.drag = null;
  if (d && d.moved) renderPanel();
});

function endChain() {
  ed.chain = null;
  ed.scalePick = null;
  draw();
}
cv.addEventListener('dblclick', endChain);
cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  endChain();
});

cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { s, w } = eventPos(e);
  // 두 손가락 벌리기(ctrl+휠)와 마우스 휠은 확대, 트랙패드 두 손가락 밀기는 이동
  const zoom = e.ctrlKey || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50);
  if (zoom) {
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    ed.view.scale = Math.max(3, Math.min(400, ed.view.scale * f));
    // 마우스가 가리키는 지점이 그대로 있도록
    const after = toWorld(s.x, s.y);
    ed.view.cx += w.x - after.x;
    ed.view.cy += w.y - after.y;
  } else {
    ed.view.cx += e.deltaX / ed.view.scale;
    ed.view.cy -= e.deltaY / ed.view.scale;
  }
  draw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (e.metaKey || e.ctrlKey) return;
  if (e.key === 'Escape') {
    if (ed.chain || ed.scalePick) endChain();
    else setTool('select');
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else {
    const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.id);
  }
});

window.addEventListener('resize', draw);
window.addEventListener('beforeunload', (e) => {
  if (ed.dirty) e.preventDefault();
});

// ---------------------------------------------------------------- 불러오기와 저장

function fitView() {
  const xs = [];
  const ys = [];
  for (const n of ed.nodes) {
    xs.push(n.x);
    ys.push(n.y);
  }
  for (const m of ed.markers) {
    xs.push(m.x);
    ys.push(m.y);
  }
  for (const w of ed.walls) {
    xs.push(w.x1, w.x2);
    ys.push(w.y1, w.y2);
  }
  if (ed.bg && ed.bg.img) {
    xs.push(ed.bg.x, ed.bg.x + ed.bg.img.width * ed.bg.mpp);
    ys.push(ed.bg.y, ed.bg.y - ed.bg.img.height * ed.bg.mpp);
  }
  if (!xs.length) {
    ed.view = { cx: 0, cy: 0, scale: 40 };
    return;
  }
  const { w, h } = viewSize();
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  ed.view.cx = (minX + maxX) / 2;
  ed.view.cy = (minY + maxY) / 2;
  ed.view.scale = Math.max(3, Math.min(120, Math.min((w - 120) / Math.max(1, maxX - minX), (h - 120) / Math.max(1, maxY - minY))));
}

function loadMapJson(data) {
  ed.id = data.id || 'mymap';
  ed.name = (data.name && data.name.ko) || '';
  ed.markerSize = data.markerSize || 0.16;
  ed.extra = { name: data.name || {} };
  ed.nodes = Object.entries(data.nodes || {}).map(([id, v]) => ({ id, x: v[0], y: v[1] }));
  ed.edges = (data.edges || []).map(([a, b]) => ({ a, b }));
  ed.markers = (data.markers || []).map((m) => {
    const out = { ...m, mount: m.mount === 'floor' ? 'floor' : 'wall', facing: m.facing || 0 };
    if (out.mount === 'wall' && out.h == null) out.h = 1.5;
    return out;
  });
  ed.pois = (data.pois || []).map((p) => ({ ...p }));
  ed.walls = (data.walls || []).map((w) => ({ x1: w[0], y1: w[1], x2: w[2], y2: w[3] }));
  ed.bg = null;
  ed.scan = null;
  ed.wallGrid = null;
  if (data.floorplan && data.floorplan.image) {
    const f = data.floorplan;
    const img = new Image();
    img.onload = () => {
      ed.bg = { img, x: f.x, y: f.y, mpp: f.mpp, opacity: f.scan ? 0.9 : 0.55, scan: !!f.scan };
      if (f.scan) ed.wallGrid = wallGridFromImage(ed.bg);
      refresh();
    };
    img.src = `maps/${f.image}?t=${Date.now()}`;
  }
  ed.sel = null;
  ed.chain = null;
  ed.dirty = false;
  ed.loadedId = data.id || null;
  ed.saved = null;
  undoStack.length = 0;
  $('mapId').value = ed.id;
  $('mapName').value = ed.name;
  const tidied = tidyGraph();
  if (tidied) ed.dirty = true;
  fitView();
  refresh();
  return tidied;
}

/** 가상 역에서 미리 볼 때의 출발 위치: 첫 QR 앞에 서서 그 QR을 바라본다 */
function autoStart() {
  const m = ed.markers.find((x) => x.mount === 'wall') || ed.markers[0];
  if (!m) {
    const n = ed.nodes[0];
    return n ? { x: n.x, y: n.y, heading: 0, pitch: -10 } : { x: 0, y: 0, heading: 0, pitch: -10 };
  }
  const a = rad(m.facing);
  if (m.mount === 'floor') {
    return { x: r2(m.x - Math.sin(a) * 1.2), y: r2(m.y - Math.cos(a) * 1.2), heading: m.facing, pitch: -45 };
  }
  return { x: r2(m.x + Math.sin(a) * 1.4), y: r2(m.y + Math.cos(a) * 1.4), heading: normDeg(m.facing + 180), pitch: 0 };
}

function toMapJson() {
  const nodes = {};
  for (const n of ed.nodes) nodes[n.id] = [r2(n.x), r2(n.y)];
  const data = {
    id: ed.id,
    name: { ...(ed.extra.name || {}), ko: ed.name || ed.id },
    markerSize: ed.markerSize,
    nodes,
    edges: ed.edges.map((e) => [e.a, e.b]),
    markers: ed.markers.map((m) => {
      const out = { ...m, x: r2(m.x), y: r2(m.y), facing: Math.round(m.facing * 10) / 10 };
      if (out.mount === 'floor') delete out.h;
      return out;
    }),
    pois: ed.pois.map((p) => ({ ...p })),
    walls: ed.walls.map((w) => [r2(w.x1), r2(w.y1), r2(w.x2), r2(w.y2)]),
    start: autoStart(),
  };
  return data;
}

/** 배경 그림을 PNG로 만든다. 너무 크면 줄인다. 반환: { blob, info } (info는 지도에 적을 위치·축척) */
async function floorplanPng() {
  const bg = ed.bg;
  const scale = Math.min(1, 3000 / Math.max(bg.img.width, bg.img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bg.img.width * scale));
  c.height = Math.max(1, Math.round(bg.img.height * scale));
  const g2 = c.getContext('2d');
  g2.imageSmoothingEnabled = scale < 1;
  g2.drawImage(bg.img, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  const info = { image: `${ed.id}.png`, x: r2(bg.x), y: r2(bg.y), mpp: (bg.mpp * bg.img.width) / c.width };
  if (bg.scan) info.scan = true;
  return { blob, info };
}

function setStatus(text, isError = false) {
  const s = $('status');
  s.textContent = text;
  s.className = isError ? 'err' : '';
}

function readHeaderFields() {
  ed.id = $('mapId').value.trim();
  ed.name = $('mapName').value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,40}$/.test(ed.id);
}

function downloadBlob(blob, filename) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function download(data) {
  downloadBlob(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }), `${ed.id}.json`);
}

async function save() {
  if (!readHeaderFields()) {
    setStatus('파일 이름은 영어 소문자, 숫자, -, _ 만 쓸 수 있습니다 (예: myhall).', true);
    return false;
  }
  if (!ed.nodes.length) {
    setStatus('저장할 내용이 없습니다. 통로부터 그려 주세요.', true);
    return false;
  }
  if (ed.id !== ed.loadedId && ed.serverMaps.some((m) => m.id === ed.id)) {
    if (!confirm(`"${ed.id}" 지도가 이미 있습니다. 덮어쓸까요? (이전 것은 maps/.backup 에 남습니다)`)) return false;
  }
  tidyGraph();
  const data = toMapJson();
  let plan = null;
  if (ed.bg && ed.bg.img) {
    plan = await floorplanPng();
    data.floorplan = plan.info;
  }
  try {
    if (plan) {
      const up = await fetch(`save-floorplan?id=${encodeURIComponent(ed.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: plan.blob,
      });
      if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || `HTTP ${up.status}`);
    }
    const res = await fetch(`save-map?id=${encodeURIComponent(ed.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    ed.dirty = false;
    ed.loadedId = ed.id;
    ed.saved = ed.id;
    setStatus(`저장했습니다: ${out.file}`);
    await refreshMapList();
    renderPanel();
    return true;
  } catch (e) {
    // 저장 기능이 없는 서버(정적 호스팅, 예전 serve.py)에서는 파일로 내려받는다
    download(data);
    if (plan) downloadBlob(plan.blob, plan.info.image);
    setStatus(`서버에 저장하지 못해 파일로 내려받았습니다. maps 폴더에 넣어 주세요. serve.py를 껐다 켜면 바로 저장됩니다. (${e.message})`, true);
    return false;
  }
}

async function refreshMapList() {
  const sel = $('loadSel');
  try {
    const res = await fetch('maps/index.json', { cache: 'no-store' });
    ed.serverMaps = res.ok ? await res.json() : [];
  } catch (e) {
    ed.serverMaps = [];
  }
  sel.innerHTML = '';
  sel.append(el('option', { value: '', textContent: '지도 불러오기…' }), el('option', { value: '__new', textContent: '＋ 새 지도' }));
  for (const m of ed.serverMaps) {
    sel.append(el('option', { value: m.id, textContent: m.name ? `${m.id} · ${m.name}` : m.id }));
  }
}

async function loadFromServer(id) {
  const res = await fetch(`maps/${id}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`"${id}" 지도를 찾지 못했습니다`);
  const tidied = loadMapJson(await res.json());
  setStatus(
    tidied
      ? `불러왔습니다: ${id}. 통로 연결을 자동으로 고쳤습니다 (${tidied}). "저장"을 누르면 파일에도 반영됩니다.`
      : `불러왔습니다: ${id}`
  );
}

function loadBackground(file) {
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    // 처음에는 그림 폭이 30m가 되게 놓는다. 이후 "축척 맞추기"로 실제 크기에 맞춘다.
    const mpp = 30 / img.width;
    ed.bg = {
      img,
      mpp,
      x: ed.view.cx - (img.width * mpp) / 2,
      y: ed.view.cy + (img.height * mpp) / 2,
      opacity: 0.55,
    };
    ed.scan = null;
    ed.wallGrid = null;
    ed.dirty = true;
    refresh();
    setStatus('도면을 불러왔습니다. "축척 맞추기"로 실제 크기에 맞춰 주세요.');
  };
  img.src = URL.createObjectURL(file);
}

async function init() {
  $('mapId').value = ed.id;
  $('mapId').addEventListener('input', () => (ed.dirty = true));
  $('mapName').addEventListener('input', () => (ed.dirty = true));
  $('saveBtn').addEventListener('click', save);
  $('scanBtn').addEventListener('click', () => $('scanFile').click());
  $('scanFile').addEventListener('change', (e) => {
    importScan(e.target.files[0]);
    e.target.value = '';
  });
  $('downloadBtn').addEventListener('click', () => {
    if (readHeaderFields()) download(toMapJson());
    else setStatus('파일 이름을 확인해 주세요.', true);
  });
  const openAfterSave = (makeUrl) => async () => {
    // 새 창은 버튼을 누른 그 순간에 열어야 브라우저가 막지 않는다. 저장이 끝나면 주소를 넣는다.
    const win = window.open('about:blank', '_blank');
    if ((ed.dirty || ed.loadedId !== $('mapId').value.trim()) && !(await save())) {
      if (win) win.close();
      return;
    }
    if (win) win.location = makeUrl(ed.id);
  };
  $('simBtn').addEventListener('click', openAfterSave((id) => `index.html?sim=1&map=${id}&debug=1`));
  $('printBtn').addEventListener('click', openAfterSave((id) => `markers.html?map=${id}`));
  $('loadSel').addEventListener('change', async (e) => {
    const id = e.target.value;
    e.target.value = '';
    if (!id) return;
    if (ed.dirty && !confirm('저장하지 않은 내용이 있습니다. 버리고 진행할까요?')) return;
    if (id === '__new') {
      loadMapJson({ id: 'mymap', nodes: {} });
      ed.loadedId = null;
      return;
    }
    try {
      await loadFromServer(id);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  await refreshMapList();
  try {
    const res = await fetch('serverinfo.json', { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      ed.phoneBase = `https://${info.ip}:${info.httpsPort}/`;
    }
  } catch (e) {
    /* 폰 주소를 모르면 안내 문구만 보여 준다 */
  }

  const want = new URLSearchParams(location.search).get('map');
  if (want) {
    try {
      await loadFromServer(want);
    } catch (err) {
      setStatus(err.message, true);
    }
  }
  refresh();
}

window.__editor = { ed, toMapJson, loadMapJson, save, validate, quickStart, importScan, wallFit };
init();
