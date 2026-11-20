import { useMemo } from 'react';
import type { MinimapPose } from './indoorTracking';
import { distanceAlong, measurePassage, passageMeters, type PassageRoute } from './passageRoute';
import type { SpaceLayout } from './station';
import './passage-progress.css';

export function PassageBar({ route, distance }: { route: PassageRoute; distance: number }) {
  return <div className="passage-bar" aria-hidden="true">
    <i style={{ width: distance / route.length * 100 + '%' }} />
    {route.stages.slice(1).map(stage => <b key={stage.offset} style={{ left: stage.offset / route.length * 100 + '%' }} />)}
  </div>;
}

export function LivePassageProgress({ layout, pose }: { layout?: SpaceLayout; pose?: MinimapPose }) {
  const route = useMemo(() => layout && measurePassage(layout.station.route), [layout]);
  if (!route || !pose || pose.spaceId !== layout?.id || pose.source === 'last') return null;
  const along = distanceAlong(route, pose.point);
  if (along === undefined) return null;
  return <div className="live-passage-progress">
    <div className="live-passage-reading">
      <span>{pose.source === 'motion' ? '추정 위치 기준' : '태그 위치 기준'}</span>
      <strong>약 {passageMeters(route.length - along)} 남음</strong>
    </div>
    <PassageBar route={route} distance={along} />
  </div>;
}
