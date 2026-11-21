// 실내 지도: 통로 그래프, QR 마커, 목적지. maps/<id>.json 형식은 README 참고.

import { distXY, bearingXY } from './geo.js';
import { normalizeGraph } from './graphfix.js';

export async function loadMap(id) {
  const res = await fetch(new URL(`../maps/${id}.json`, import.meta.url));
  if (!res.ok) throw new Error(`map "${id}" not found (${res.status})`);
  return new StationMap(await res.json());
}

export class StationMap {
  constructor(data) {
    this.id = data.id;
    this.name = data.name || {};
    this.markerSize = data.markerSize || 0.16;

    const rawNodes = Object.entries(data.nodes || {}).map(([id, v]) => ({ id, x: v[0], y: v[1] }));
    const rawIds = new Set(rawNodes.map((n) => n.id));
    for (const [a, b] of data.edges || []) {
      if (!rawIds.has(a) || !rawIds.has(b)) throw new Error(`edge refers to unknown node: ${a} - ${b}`);
    }
    // 손으로 그린 통로에서 "이어져 보이지만 이어지지 않은" 곳을 고친다 (graphfix.js 참고)
    const fixed = normalizeGraph(
      rawNodes,
      (data.edges || []).map(([a, b]) => ({ a, b }))
    );
    this.graphFixes = fixed.fixes;
    const alias = fixed.alias;

    this.nodes = new Map(fixed.nodes.map((n) => [n.id, n]));
    this.edges = [];
    this.adj = new Map([...this.nodes.keys()].map((id) => [id, []]));
    for (const { a, b } of fixed.edges) {
      const len = distXY(this.nodes.get(a), this.nodes.get(b));
      this.edges.push({ a, b, len });
      this.adj.get(a).push({ to: b, len });
      this.adj.get(b).push({ to: a, len });
    }

    this.markers = (data.markers || []).map((m) => {
      const mount = m.mount === 'floor' ? 'floor' : 'wall';
      return {
        ...m,
        mount,
        size: m.size || this.markerSize,
        h: m.h != null ? m.h : mount === 'floor' ? 0 : 1.5,
        facing: m.facing || 0,
      };
    });
    this.markerById = new Map(this.markers.map((m) => [m.id, m]));

    this.pois = (data.pois || []).map((p) => {
      const node = alias.has(p.node) ? alias.get(p.node) : p.node;
      const n = this.nodes.get(node);
      if (!n) throw new Error(`poi "${p.id}" refers to unknown node: ${p.node}`);
      return { ...p, node, x: n.x, y: n.y };
    });

    this.walls = data.walls || [];
    this.start = data.start || null;
    // 배경 평면도 그림 (LiDAR 스캔이나 안내도 사진): { image, x, y, mpp, scan }
    // x, y는 그림 왼쪽 위의 지도 좌표, mpp는 한 픽셀이 몇 m인지
    this.floorplan = data.floorplan && data.floorplan.image ? data.floorplan : null;

    // 지도 전체 범위 (미니맵용)
    const xs = [];
    const ys = [];
    for (const n of this.nodes.values()) {
      xs.push(n.x);
      ys.push(n.y);
    }
    for (const w of this.walls) {
      xs.push(w[0], w[2]);
      ys.push(w[1], w[3]);
    }
    for (const m of this.markers) {
      xs.push(m.x);
      ys.push(m.y);
    }
    this.bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }

  /** pos에서 가장 가까운 통로 위의 점 */
  nearestOnGraph(pos) {
    let best = null;
    for (const e of this.edges) {
      const a = this.nodes.get(e.a);
      const b = this.nodes.get(e.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2)) : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = distXY(pos, q);
      if (!best || d < best.dist) best = { edge: e, t, q, dist: d };
    }
    return best;
  }

  /** pos에서 maxDist(m) 안에 있는 통로들이 뻗은 방향 (양쪽 방향 모두, 방위각) */
  corridorBearingsNear(pos, maxDist) {
    const out = [];
    for (const e of this.edges) {
      const a = this.nodes.get(e.a);
      const b = this.nodes.get(e.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2));
      if (Math.hypot(pos.x - (a.x + dx * t), pos.y - (a.y + dy * t)) > maxDist) continue;
      const brg = bearingXY(a, b);
      out.push(brg, (brg + 180) % 360);
    }
    return out;
  }

  /**
   * pos에서 목적지(poi)까지의 최단 경로. 반환: { points: [{x, y}], length } 또는 null
   * 사용자가 통로 그래프에서 조금 떨어져 있어도 가장 가까운 통로 위에서 출발한 것으로 본다.
   */
  routeTo(pos, poi) {
    const near = this.nearestOnGraph(pos);
    if (!near) return null;
    const target = poi.node;

    // 다익스트라. 출발점은 가까운 통로 위의 점이고, 그 통로의 양 끝으로 갈 수 있다.
    const dist = new Map();
    const prev = new Map();
    const done = new Set();
    dist.set(near.edge.a, near.edge.len * near.t);
    dist.set(near.edge.b, near.edge.len * (1 - near.t));
    while (true) {
      let u = null;
      for (const [id, d] of dist) {
        if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
      }
      if (u === null) return null;
      if (u === target) break;
      done.add(u);
      for (const { to, len } of this.adj.get(u)) {
        const nd = dist.get(u) + len;
        if (!dist.has(to) || nd < dist.get(to)) {
          dist.set(to, nd);
          prev.set(to, u);
        }
      }
    }

    const chain = [];
    for (let u = target; u !== undefined; u = prev.get(u)) chain.unshift(this.nodes.get(u));
    const points = [];
    // 통로에서 멀리 떨어져 있을 때만 현재 위치부터 그린다
    if (near.dist > 2.5) points.push({ x: pos.x, y: pos.y });
    points.push(near.q);
    for (const n of chain) points.push({ x: n.x, y: n.y });
    return { points, length: dist.get(target) + (near.dist > 2.5 ? near.dist : 0) };
  }
}
