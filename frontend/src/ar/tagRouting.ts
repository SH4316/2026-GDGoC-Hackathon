import type { Point, Station } from './station';

export type TagNetwork = {
  points: Point[]; edges: [number, number][]; anchors: Record<number, number>;
  start: number; end: number;
};

export type RouteTree = TagNetwork & { goal: number; next: number[]; costs: number[] };

const meters = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

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
  if (!graph) return corridorNetwork(station);
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

export function defaultWalk(station: Station): Point[] {
  if (!station.tagGraph) return station.route;
  const tree = routeTree(tagNetwork(station));
  const path: Point[] = [];
  if (Number.isFinite(tree.costs[tree.start]))
    for (let i = tree.start; i !== -1; i = tree.next[i]) path.push(tree.points[i]);
  return path;
}
