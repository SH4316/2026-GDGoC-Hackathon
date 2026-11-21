import { useLanguage } from '../i18n/LanguageSelect';
import type { CSSProperties } from 'react';

export type TagPoint = { index: number; id: string; x: number; y: number; yaw?: number };
type Side = 'right' | 'left' | 'above' | 'below';
type Rect = { x: number; y: number; w: number; h: number };

// Reserve the actual anchors before fitting labels, so a number never covers a nearby tag.
function placeLabels(points: TagPoint[], selected: number | null, width: number, height: number, reserved: Rect[]) {
  const occupied = reserved.concat(points.map(({ x, y }) => ({ x: x - 5, y: y - 5, w: 10, h: 10 })));
  const placements = new Map<number, { side: Side; visible: boolean }>();
  const active = points.find(p => p.index === selected);
  for (const p of active ? [active, ...points.filter(p => p !== active)] : points) {
    const w = Math.max(19, (p.id || '새 태그').length * 7 + 10), h = 18;
    const sides: [Side, number, number][] = [
      ['right', p.x + 15, p.y - h / 2], ['left', p.x - 15 - w, p.y - h / 2],
      ['above', p.x - w / 2, p.y - 10 - h], ['below', p.x - w / 2, p.y + 10],
    ];
    const inside = sides.filter(([, x, y]) => x >= 2 && y >= 2 && x + w <= width - 2 && y + h <= height - 2);
    const free = inside.find(([, x, y]) => !occupied.some(b =>
      x < b.x + b.w + 2 && x + w + 2 > b.x && y < b.y + b.h + 2 && y + h + 2 > b.y));
    const [side, x, y] = free ?? inside[0] ?? sides[0];
    const visible = !!free || p === active;
    if (visible) occupied.push({ x, y, w, h });
    placements.set(p.index, { side, visible });
  }
  return placements;
}

export function TagMarkers({ points, width, height, selected, select, placing = false, model = false, reserved = [] }: {
  points: TagPoint[]; width: number; height: number; selected: number | null; select: (index: number) => void;
  placing?: boolean; model?: boolean; reserved?: Rect[];
}) {
  const { t } = useLanguage();
  const labels = placeLabels(points, selected, width, height, reserved);
  return <div className="tag-markers" data-placing={placing}>
    {points.map(point => {
      const label = labels.get(point.index)!;
      return <button type="button" key={point.index} className="tag-point" data-tag-index={point.index}
        data-side={label.side} data-label={label.visible} aria-label={t('태그 {id} 위치', { id: point.id || t('새 태그') })}
        aria-pressed={selected === point.index} disabled={placing}
        style={{ left: point.x, top: point.y, '--yaw': (point.yaw ?? 0) + 'deg' } as CSSProperties}
        onClick={event => {
          // In 3D, pointer taps share the stage's drag threshold with OrbitControls.
          if (!model || event.detail === 0) select(point.index);
        }}>
        <span className="tag-anchor" data-oriented={point.yaw !== undefined} aria-hidden="true" />
        <span className="tag-number">{point.id || t('새 태그')}</span>
      </button>;
    })}
  </div>;
}
