import { lineLabel } from '../i18n/language';
import { useLanguage } from '../i18n/LanguageSelect';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MinimapPose } from './indoorTracking';
import { indoorSpaceName, spaceLabel, type Point, type SpaceLayout } from './station';

const padding = 22;

function floorPlan({ station }: SpaceLayout, path = station.route, customTarget?: number) {
  const outline = station.terrain?.outline ?? [];
  const points = [...outline, ...station.route, ...path, ...station.tags.map(tag => tag.center)];
  if (!points.length) return;
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const endpoints = (customTarget === undefined ? station.stationLinks ?? [] : []).flatMap(stop => {
    if (!stop.routeEndpoint || station.route.length < 2) return [];
    const start = stop.routeEndpoint === 'start';
    return [{ point: start ? station.route[0] : station.route.at(-1)!, start,
      line: stop.line }];
  });
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    outline: outline.join(' '), route: path.join(' '), end: path.at(-1), endpoints,
  };
}

export function IndoorMinimap({ layout, route, customTarget, preview, referenceTagId, pose, guided = false }: {
  layout?: SpaceLayout; route?: Point[]; customTarget?: number; preview: boolean; referenceTagId?: number; pose?: MinimapPose; guided?: boolean;
}) {
  const { t, language } = useLanguage();
  const surface = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const plan = useMemo(() => layout && floorPlan(layout, route, customTarget), [layout, route, customTarget]);
  useEffect(() => {
    if (!surface.current) return;
    const observer = new ResizeObserver(([{ contentRect }]) => setSize({ width: contentRect.width, height: contentRect.height }));
    observer.observe(surface.current);
    return () => observer.disconnect();
  }, [layout]);

  if (!layout) return null;
  const name = customTarget !== undefined ? (layout.station.terrain?.name ?? t('실내')) + ' · ' + t('태그 {id}', { id: customTarget })
    : t(guided ? indoorSpaceName(layout.station, language) : spaceLabel(layout.station, language));
  const here = !preview && pose?.spaceId === layout.id ? pose : undefined;
  const tag = !here && referenceTagId !== undefined ? layout.station.tags.find(item => item.id === referenceTagId) : undefined;
  const point = here?.point ?? tag?.center;
  const live = here && here.source !== 'last';
  const label = tag ? t('태그 {id} 위치', { id: tag.id }) : t(here?.source === 'motion' ? '추정 위치' : live ? '내 위치' : '마지막 위치');
  const endpointLabel = (line: string, start: boolean) => lineLabel(line, language) + ' · ' + t(start ? '출발' : '도착');
  let drawing;
  if (plan && width > 2 * padding && height > 2 * padding) {
    const x = point?.[0], y = point?.[1];
    const left = Math.min(plan.minX, x ?? plan.minX), right = Math.max(plan.maxX, x ?? plan.maxX);
    const bottom = Math.min(plan.minY, y ?? plan.minY), top = Math.max(plan.maxY, y ?? plan.maxY);
    const scale = Math.min((width - 2 * padding) / Math.max(0.1, right - left),
      (height - 2 * padding) / Math.max(0.1, top - bottom));
    const centerX = width / 2 - (left + right) / 2 * scale;
    const centerY = height / 2 + (bottom + top) / 2 * scale;
    const markerX = centerX + (x ?? 0) * scale;
    const markerY = centerY - (y ?? 0) * scale;
    const labelOnRight = markerX < width / 2;
    drawing = <svg viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={[t('실내 배치'), ...plan.endpoints.map(stop => endpointLabel(stop.line, stop.start)), point && label].filter(Boolean).join(' · ')}>
      <g transform={`translate(${centerX} ${centerY}) scale(${scale} ${-scale})`}>
        {plan.outline && <polygon points={plan.outline} fill="#324b40" stroke="#82a494" vectorEffect="non-scaling-stroke" />}
        {layout.station.tags.map(({ id, center: [tx, ty] }) =>
          <rect key={id} x={tx - 2 / scale} y={ty - 2 / scale} width={4 / scale} height={4 / scale} fill="#c1cdc6" />)}
        {plan.route && <polyline points={plan.route} fill="none" stroke="#72e5b2" strokeWidth="3"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {plan.end && <circle cx={plan.end[0]} cy={plan.end[1]} r={3 / scale} fill="#213a2e"
          stroke="#72e5b2" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </g>
      {plan.endpoints.map(({ point: [ex, ey], start, line }) => {
        const label = endpointLabel(line, start);
        const px = centerX + ex * scale, py = centerY - ey * scale;
        const right = px < width / 2;
        return <g key={label} transform={`translate(${px} ${py})`}>
          <circle r="5" fill={start ? '#15221d' : '#72e5b2'} stroke="#f5f7f6" strokeWidth="2" />
          <text x={right ? 8 : -8} y={start ? -12 : 18} textAnchor={right ? 'start' : 'end'}
            fontSize="13" fontWeight="700" fill="#f5f7f6" stroke="#15221d" strokeWidth="3" paintOrder="stroke">{label}</text>
        </g>;
      })}
      {point && <g transform={`translate(${markerX} ${markerY})`}>
        {here && here.headingDeg !== null && <path d="M0 -20 L7 -5 H-7 Z" transform={`rotate(${here.headingDeg})`} fill="#fff" />}
        <circle r="11" fill={tag ? '#c77813' : live ? '#087acc' : '#506779'} stroke="#fff"
          strokeWidth="2.5" strokeDasharray={here && here.source !== 'tag' ? '4 2' : undefined} />
        {!guided && <text x={labelOnRight ? 22 : -22} textAnchor={labelOnRight ? 'start' : 'end'} dy=".35em"
          fontSize="14" fontWeight="700" fill="#fff" stroke="#17251e" strokeWidth="3" strokeLinejoin="round" paintOrder="stroke">
          {label}
        </text>}
      </g>}
    </svg>;
  }

  return <figure className="indoor-minimap" aria-label={t('실내 미니맵')}>
    <div className="minimap-plan" ref={surface}>{plan ? drawing : <p>{t('등록된 평면 정보가 없습니다.')}</p>}</div>
    <figcaption><span title={name}>{name}</span>{guided && point && <span className="map-position-key" data-live={!!live} data-tag={!!tag}>{label}</span>}
      {preview && <small>{t('미리보기')}</small>}
    </figcaption>
  </figure>;
}
