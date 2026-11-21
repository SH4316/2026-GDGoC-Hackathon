import type { Point, SpaceLayout, Station } from './station';

export type TagNetwork = {
  points: Point[]; edges: [number, number][]; anchors: Record<number, number>;
  start: number; end: number;
};

export type RouteTree = TagNetwork & { goal: number; next: number[]; costs: number[] };

const meters = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Implicit endpoints are the first two placed tags. Appending a waypoint must
// not silently move the destination. Saved layouts can choose any two IDs.
export function automaticEndpoints(station: Station) {
  const settings = station.autoRoute;
  if (station.tagGraph || settings === false || (!settings && station.route.length)) return;
  const startTag = settings?.startTag ?? station.tags.find(t => t.id !== settings?.endTag)?.id;
  const endTag = settings?.endTag ?? station.tags.find(t => t.id !== startTag)?.id;
  return { startTag, endTag };
}

// Older surveyed corridors have a route endpoint but no explicit destination ID.
export function nearArrivalTag(station: Station, position: number[], selected?: number) {
  const id = selected ?? station.tagGraph?.endTag ?? automaticEndpoints(station)?.endTag;
  let tag = station.tags.find(t => t.id === id);
  if (id === undefined) {
    const end = station.route.at(-1);
    if (!end) return false;
    let closest = Infinity;
    for (const candidate of station.tags) {
      const gap = meters(candidate.walkPoint ?? candidate.center, end);
      if (gap <= 1 && gap < closest) { tag = candidate; closest = gap; }
    }
  }
  return !!tag && Math.hypot(position[0] - tag.center[0], position[1] - tag.center[1]) <= 1;
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
const epsilon = 1e-9;

function convexFloor(outline: Point[]) {
  // A convex floor lies on one side of every boundary edge. This also rejects
  // self-crossing outlines that happen to turn the same way at each vertex.
  let side = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[j], [bx, by] = outline[i];
    for (const [x, y] of outline) {
      const area = cross(bx - ax, by - ay, x - ax, y - ay);
      if (Math.abs(area) <= epsilon) continue;
      if (side && area * side < 0) return false;
      side = Math.sign(area);
    }
  }
  return side !== 0;
}

function onFloor(x: number, y: number, outline: Point[]) {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[j], [bx, by] = outline[i];
    if (Math.abs(cross(bx - ax, by - ay, x - ax, y - ay)) <= epsilon &&
        x >= Math.min(ax, bx) - epsilon && x <= Math.max(ax, bx) + epsilon &&
        y >= Math.min(ay, by) - epsilon && y <= Math.max(ay, by) + epsilon) return true;
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

// Endpoints can both be indoors while the segment crosses a narrow notch or
// leaves the floor through a vertex. Test every interval between boundary hits.
function passageInside(a: Point, b: Point, outline: Point[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy;
  const cuts = [0, 1];
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [x, y] = outline[j], [u, v] = outline[i];
    const ex = u - x, ey = v - y, px = x - a[0], py = y - a[1];
    const det = cross(dx, dy, ex, ey);
    if (Math.abs(det) <= epsilon) {
      if (Math.abs(cross(px, py, dx, dy)) > epsilon) continue;
      for (const t of [(px * dx + py * dy) / squared, ((u - a[0]) * dx + (v - a[1]) * dy) / squared])
        if (t > 0 && t < 1) cuts.push(t);
    } else {
      const t = cross(px, py, ex, ey) / det, s = cross(px, py, dx, dy) / det;
      if (t > 0 && t < 1 && s >= -epsilon && s <= 1 + epsilon) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] <= epsilon) continue;
    const t = (cuts[i] + cuts[i - 1]) / 2;
    if (!onFloor(a[0] + dx * t, a[1] + dy * t, outline)) return false;
  }
  return true;
}

function nearbyPassages(points: Point[], concave?: Point[]): [number, number][] {
  const edges: [number, number][] = [];
  const distances = points.map(a => Float64Array.from(points, b => meters(a, b)));
  const visibility = points.map(() => new Int8Array(points.length));
  function visible(a: number, b: number) {
    if (!concave) return true;
    if (!visibility[a][b]) visibility[a][b] = visibility[b][a] = passageInside(points[a], points[b], concave) ? 1 : -1;
    return visibility[a][b] === 1;
  }
  // Relative neighborhood graph: omit a long edge when a third point is
  // reachable from both ends by shorter floor segments. This retains forks
  // and loops without drawing diagonals across a tagged corner.
  for (let a = 0; a < points.length; a++) {
    const neighbors = points.map((_, i) => i).filter(i => i !== a).sort((i, j) => distances[a][i] - distances[a][j]);
    for (const b of neighbors) {
      if (b <= a) continue;
      const length = distances[a][b] - epsilon;
      let redundant = false;
      for (const k of neighbors) {
        if (distances[a][k] >= length) break;
        if (distances[k][b] < length && visible(a, k) && visible(k, b)) { redundant = true; break; }
      }
      if (!redundant && visible(a, b)) edges.push([a, b]);
    }
  }
  return edges;
}

// A concave floor can connect tags around an unmarked bend. Reflex vertices
// supply the missing turns. Move them into the aisle when all incident paths still fit.
function connectAroundBends(network: TagNetwork, outline: Point[]) {
  const { points } = network;
  const winding = Math.sign(outline.reduce((area, a, i) => {
    const b = outline[(i + 1) % outline.length];
    return area + cross(a[0], a[1], b[0], b[1]);
  }, 0));
  const offsets = new Map<number, Point>();
  for (const [i, v] of outline.entries()) {
    const a = outline[(i + outline.length - 1) % outline.length], b = outline[(i + 1) % outline.length];
    const ax = v[0] - a[0], ay = v[1] - a[1], bx = b[0] - v[0], by = b[1] - v[1];
    if (winding * cross(ax, ay, bx, by) >= -epsilon || points.some(p => meters(p, v) < .05)) continue;
    const incoming = Math.hypot(ax, ay), outgoing = Math.hypot(bx, by);
    const x = ax / incoming - bx / outgoing, y = ay / incoming - by / outgoing;
    const inset = Math.min(.25, incoming / 2, outgoing / 2) / Math.hypot(x, y);
    offsets.set(points.length, [v[0] + x * inset, v[1] + y * inset]);
    points.push(v);
  }
  if (!offsets.size) return;
  network.edges = nearbyPassages(points, outline);
  const adjacent: number[][] = points.map(() => []);
  for (const [a, b] of network.edges) { adjacent[a].push(b); adjacent[b].push(a); }
  for (const [i, p] of offsets) {
    if (onFloor(...p, outline) && adjacent[i].every(j => meters(p, points[j]) >= .05 && passageInside(p, points[j], outline)))
      points[i] = p;
  }
}

function automaticNetwork(station: Station, endpoints: { startTag?: number; endTag?: number }): TagNetwork {
  const points: Point[] = [], anchors: Record<number, number> = {};
  const outline = station.terrain?.outline;
  const concave = outline && !convexFloor(outline) ? outline : undefined;
  for (const tag of [...station.tags].sort((a, b) => a.id - b.id)) {
    const p = tag.walkPoint ?? tag.center;
    if (outline && !onFloor(...p, outline)) continue;
    // The tracker requires a 5 cm minimum segment. Nearby markers on the
    // same walking spot share a node and remain individually addressable.
    const nearby = points.findIndex(q => meters(p, q) < .05 &&
      (!concave || (p[0] === q[0] && p[1] === q[1]) || passageInside(p, q, concave)));
    anchors[tag.id] = nearby >= 0 ? nearby : points.push(p) - 1;
  }
  const network = { points, anchors, edges: nearbyPassages(points, concave),
    start: anchors[endpoints.startTag ?? -1] ?? -1, end: anchors[endpoints.endTag ?? -1] ?? -1 };
  if (concave && points.length > 1 && routeTree(network, 0).costs.includes(Infinity)) connectAroundBends(network, concave);
  return network;
}

// Keep the surveyed walking line, including corners and the original endpoints.
// Tags split its edges at their floor projections. A crossing cannot identify a branch.
function corridorNetwork(station: Station): TagNetwork {
  const { route } = station;
  const points: Point[] = [], anchors: Record<number, number> = {}, edges: [number, number][] = [];
  const sections = route.slice(1).map((b, i) => {
    const a = route[i], length = meters(a, b);
    return { a, b, length, tags: [] as { id: number; along: number }[] };
  });
  for (const tag of station.tags) {
    let offset = 0;
    const candidates = sections.map(section => {
      const { a, b, length } = section;
      const dx = (b[0] - a[0]) / length, dy = (b[1] - a[1]) / length;
      const along = Math.max(0, Math.min(length, (tag.center[0] - a[0]) * dx + (tag.center[1] - a[1]) * dy));
      const gap = meters(tag.center, [a[0] + dx * along, a[1] + dy * along]);
      const distance = offset + along;
      offset += length;
      return { section, along, gap, distance };
    });
    const best = candidates.reduce<typeof candidates[number] | undefined>((a, b) => !a || b.gap < a.gap ? b : a, undefined);
    if (best && best.gap <= 1.5 && !candidates.some(c => c.gap <= best.gap + .15 && Math.abs(c.distance - best.distance) > 2))
      best.section.tags.push({ id: tag.id, along: best.along });
  }
  if (sections.length) points.push(route[0]);
  for (const { a, b, length, tags } of sections) {
    let previous = 0;
    for (const { id, along } of tags.sort((x, y) => x.along - y.along || x.id - y.id)) {
      if (length - along < .05) { anchors[id] = points.length; continue; }
      if (along - previous >= .05) {
        points.push([a[0] + (b[0] - a[0]) * along / length, a[1] + (b[1] - a[1]) * along / length]);
        previous = along;
      }
      anchors[id] = points.length - 1;
    }
    points.push(b);
  }
  for (let i = 1; i < points.length; i++) edges.push([i - 1, i]);
  return { points, edges, anchors, start: 0, end: points.length - 1 };
}

export function tagNetwork(station: Station): TagNetwork {
  const graph = station.tagGraph;
  if (!graph) {
    const endpoints = automaticEndpoints(station);
    return endpoints ? automaticNetwork(station, endpoints) : corridorNetwork(station);
  }
  const points = station.tags.map(tag => tag.walkPoint ?? tag.center);
  const anchors = Object.fromEntries(station.tags.map((tag, i) => [tag.id, i]));
  return { points, anchors, edges: graph.edges.map(([a, b]) => [anchors[a], anchors[b]]),
    start: anchors[graph.startTag], end: anchors[graph.endTag] };
}

// One Dijkstra search from the destination supplies the next hop for every observed tag.
export function routeTree(network: TagNetwork, goal = network.end): RouteTree {
  const { points, edges } = network;
  const adjacent: number[][] = points.map(() => []);
  for (const [a, b] of edges) { adjacent[a].push(b); adjacent[b].push(a); }
  const costs = points.map(() => Infinity), next = points.map(() => -1);
  if (points[goal]) costs[goal] = 0;
  const pending = new Set(points[goal] ? [goal] : []);
  while (pending.size) {
    let node = -1;
    for (const candidate of pending) if (node < 0 || costs[candidate] < costs[node]) node = candidate;
    pending.delete(node);
    for (const neighbor of adjacent[node]) {
      const cost = costs[node] + meters(points[node], points[neighbor]);
      if (cost >= costs[neighbor]) continue;
      costs[neighbor] = cost;
      next[neighbor] = node;
      pending.add(neighbor);
    }
  }
  return { ...network, goal, next, costs };
}

export function defaultWalk(station: Station, network = tagNetwork(station)): Point[] {
  if (!station.tagGraph && !automaticEndpoints(station)) return station.route;
  const tree = routeTree(network);
  const path: Point[] = [];
  if (Number.isFinite(tree.costs[tree.start]))
    for (let i = tree.start; i !== -1; i = tree.next[i]) path.push(tree.points[i]);
  return path.length >= 2 ? path : [];
}

export function trackingLayout({ id, station }: SpaceLayout): SpaceLayout {
  const autoRoute = automaticEndpoints(station);
  const network = tagNetwork(station);
  return { id, network, station: { ...station, ...(autoRoute && { autoRoute }), route: defaultWalk(station, network) } };
}
