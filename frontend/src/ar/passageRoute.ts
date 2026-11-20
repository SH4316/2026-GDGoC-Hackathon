import type { Point } from './station';

export type Turn = 'straight' | 'left' | 'right' | 'uturn';
type Segment = { start: Point; end: Point; x: number; y: number; length: number; offset: number };
export type PassageRoute = {
  segments: Segment[];
  stages: { turn: Turn; offset: number }[];
  length: number;
};

export function measurePassage(points: Point[]): PassageRoute | undefined {
  const segments: Segment[] = [];
  const stages: PassageRoute['stages'] = [];
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const dx = end[0] - start[0], dy = end[1] - start[1];
    const size = Math.hypot(dx, dy);
    if (!Number.isFinite(size)) return;
    if (!size) continue;
    const x = dx / size, y = dy / size, previous = segments.at(-1);
    if (!previous) stages.push({ turn: 'straight', offset: 0 });
    else {
      // Match the turn angles used by the AR tracker's floor arrows.
      const angle = Math.atan2(previous.x * y - previous.y * x, previous.x * x + previous.y * y);
      if (Math.abs(angle) >= Math.PI / 5) {
        const turn = Math.abs(angle) > Math.PI * .85 ? 'uturn' : angle > 0 ? 'left' : 'right';
        stages.push({ turn, offset: length });
      }
    }
    segments.push({ start, end, x, y, length: size, offset: length });
    length += size;
  }
  if (segments.length) return { segments, stages, length };
}

export function pointAlong(route: PassageRoute, distance: number): Point {
  const segment = route.segments.findLast(s => s.offset <= distance) ?? route.segments[0];
  const along = Math.max(0, Math.min(segment.length, distance - segment.offset));
  return [segment.start[0] + segment.x * along, segment.start[1] + segment.y * along];
}

export function distanceAlong(route: PassageRoute, point: Point): number | undefined {
  let nearest = Infinity, progress = 0;
  const candidates = route.segments.map(s => {
    const dx = point[0] - s.start[0], dy = point[1] - s.start[1];
    const t = Math.max(0, Math.min(s.length, dx * s.x + dy * s.y));
    const gap = Math.hypot(dx - s.x * t, dy - s.y * t);
    const along = s.offset + t;
    if (gap < nearest) { nearest = gap; progress = along; }
    return { gap, along };
  });
  // A crossing or overlapping return path can correspond to two different distances.
  if (nearest <= 1.5 && !candidates.some(c => c.gap <= nearest + .15 && Math.abs(c.along - progress) > 2)) return progress;
}

export const passageMeters = (meters: number) => Number(meters.toFixed(1)).toLocaleString('ko-KR') + ' m';
