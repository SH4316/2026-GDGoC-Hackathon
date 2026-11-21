// 손으로 그린 통로 그래프 정리. 순수 함수.
//
// 편집기에서 통로 선을 그릴 때 화면에서는 이어져 보여도 실제로는 이어지지 않은 경우가 생긴다.
// 가장 흔한 것이 "이미 있는 갈림점 위를 선이 그냥 지나가는" 경우다. 그러면 경로를 찾을 때
// 그 갈림점에서 꺾지 못하고, 선의 끝까지 갔다가 되돌아오는 엉뚱한 길이 나온다
// (화살표가 모퉁이를 지나쳐 벽 쪽으로 이어지는 원인).
// 그래서 지도를 읽을 때와 저장할 때 다음을 자동으로 고친다.
//   1. 거의 같은 자리에 찍힌 두 점은 하나로 합친다.
//   2. 통로 선끼리 교차하면 교차점에 갈림점을 만든다.
//   3. 통로 선이 다른 점 바로 옆을 지나가면 그 점에서 선을 나눠 갈림길로 잇는다.

export const MERGE_DIST = 0.3; // 이보다 가까운 두 점은 같은 점으로 본다 (m)
export const SNAP_DIST = 0.35; // 통로 선이 다른 점을 이 거리 안으로 지나가면 이어진 것으로 본다 (m)
const END_MARGIN = 0.05; // 선의 양 끝에서 이만큼 안쪽이어야 "선 위"로 친다 (m)

function projectOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return null;
  const len = Math.sqrt(len2);
  const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  const perp = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  return { along, perp, len };
}

/** 두 선분이 안쪽에서 교차하면 교차점, 아니면 null */
function crossing(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null; // 나란하다
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: a.x + rx * t, y: a.y + ry * t };
}

/**
 * nodes: [{ id, x, y }], edges: [{ a, b }] (입력은 바꾸지 않는다)
 * 반환: {
 *   nodes, edges,
 *   alias: Map(합쳐져 없어진 점 id → 남은 점 id),
 *   fixes: { merged, crossed, joined }  각각 합친 점, 새로 만든 교차 갈림점, 선 중간에 이어 준 점의 개수
 * }
 */
export function normalizeGraph(nodesIn, edgesIn) {
  const fixes = { merged: 0, crossed: 0, joined: 0 };
  const alias = new Map();

  // 1. 겹친 점 합치기
  const nodes = [];
  for (const n of nodesIn) {
    const twin = nodes.find((k) => Math.hypot(k.x - n.x, k.y - n.y) < MERGE_DIST);
    if (twin) {
      alias.set(n.id, twin.id);
      fixes.merged++;
    } else {
      nodes.push({ id: n.id, x: n.x, y: n.y });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const resolve = (id) => (alias.has(id) ? alias.get(id) : id);

  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  let edges = [];
  const addEdge = (list, seen, a, b) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const k = edgeKey(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    list.push({ a, b });
  };
  {
    const seen = new Set();
    for (const e of edgesIn) addEdge(edges, seen, resolve(e.a), resolve(e.b));
  }

  // 2. 교차점에 갈림점 만들기 (근처에 이미 점이 있으면 그 점을 쓴다. 선 나누기는 3에서 한다)
  let serial = 1;
  const freshId = () => {
    while (byId.has(`x${serial}`)) serial++;
    return `x${serial}`;
  };
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const e = edges[i];
      const f = edges[j];
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      const p = crossing(byId.get(e.a), byId.get(e.b), byId.get(f.a), byId.get(f.b));
      if (!p) continue;
      if (nodes.some((k) => Math.hypot(k.x - p.x, k.y - p.y) < MERGE_DIST)) continue;
      const n = { id: freshId(), x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
      nodes.push(n);
      byId.set(n.id, n);
      fixes.crossed++;
    }
  }

  // 3. 선 바로 옆(또는 위)에 있는 점에서 선을 나눈다. 나눈 선이 또 다른 점 옆을 지날 수 있어 몇 번 반복한다.
  const joinedNodes = new Set();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const next = [];
    const seen = new Set();
    for (const e of edges) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      const on = [];
      for (const n of nodes) {
        if (n.id === e.a || n.id === e.b) continue;
        const pr = projectOnSegment(n, a, b);
        if (!pr || pr.perp >= SNAP_DIST) continue;
        if (pr.along <= END_MARGIN || pr.along >= pr.len - END_MARGIN) continue;
        on.push({ id: n.id, along: pr.along });
      }
      if (!on.length) {
        addEdge(next, seen, e.a, e.b);
        continue;
      }
      changed = true;
      on.sort((p, q) => p.along - q.along);
      let from = e.a;
      for (const o of on) {
        addEdge(next, seen, from, o.id);
        joinedNodes.add(o.id);
        from = o.id;
      }
      addEdge(next, seen, from, e.b);
    }
    edges = next;
    if (!changed) break;
  }
  // 교차점으로 새로 만든 점은 이미 따로 셌다
  fixes.joined = [...joinedNodes].filter((id) => !/^x\d+$/.test(id) || nodesIn.some((n) => n.id === id)).length;

  return { nodes, edges, alias, fixes };
}

/** 고친 내용을 한 줄로 (고친 게 없으면 빈 문자열) */
export function describeFixes(fixes) {
  const parts = [];
  if (fixes.joined) parts.push(`통로 선이 지나가기만 하던 갈림점 ${fixes.joined}곳을 이었습니다`);
  if (fixes.crossed) parts.push(`통로가 교차하는 ${fixes.crossed}곳에 갈림점을 만들었습니다`);
  if (fixes.merged) parts.push(`겹친 점 ${fixes.merged}개를 합쳤습니다`);
  return parts.join(', ');
}
