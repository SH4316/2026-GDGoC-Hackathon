import { useLanguage } from '../i18n/LanguageSelect';
import { useMemo } from 'react';
import type { MinimapPose } from './indoorTracking';
import { distanceAlong, measurePassage, passageMeters, type PassageRoute } from './passageRoute';
import type { Point, SpaceLayout } from './station';
import './passage-progress.css';

export function PassageBar({ route, distance }: { route: PassageRoute; distance: number }) {
  return <div className="passage-bar" aria-hidden="true">
    <i style={{ width: distance / route.length * 100 + '%' }} />
    {route.stages.slice(1).map(stage => <b key={stage.offset} style={{ left: stage.offset / route.length * 100 + '%' }} />)}
  </div>;
}

export function LivePassageProgress({ layout, points, pose }: { layout?: SpaceLayout; points?: Point[]; pose?: MinimapPose }) {
  const { t, locale } = useLanguage();
  const route = useMemo(() => layout && measurePassage(points ?? layout.station.route), [layout, points]);
  if (!route || !pose || pose.spaceId !== layout?.id || pose.source === 'last') return null;
  const along = distanceAlong(route, pose.point);
  if (along === undefined) return null;
  return <div className="live-passage-progress">
    <div className="live-passage-reading">
      <span>{pose.source === 'motion' ? t('추정 위치 기준') : t('태그 위치 기준')}</span>
      <strong>{t('약 {distance} 남음', { distance: passageMeters(route.length - along, locale) })}</strong>
    </div>
    <PassageBar route={route} distance={along} />
  </div>;
}
