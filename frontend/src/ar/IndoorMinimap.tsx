import { useEffect, useMemo, useRef, useState } from 'react';
import type { MinimapPose } from './indoorTracking';
import { motionAccess, requestMotionAccess, type MotionAccess } from './motion';
import { spaceLabel, type SpaceLayout } from './station';

const padding = 22;

function floorPlan({ station }: SpaceLayout) {
  const outline = station.terrain?.outline ?? [];
  const points = [...outline, ...station.route, ...station.tags.map(tag => tag.center)];
  if (!points.length) return;
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const endpoints = (station.stationLinks ?? []).flatMap(stop => {
    if (!stop.routeEndpoint || station.route.length < 2) return [];
    const start = stop.routeEndpoint === 'start';
    return [{ point: start ? station.route[0] : station.route.at(-1)!, start,
      label: stop.line + (start ? ' 출발' : ' 도착') }];
  });
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    outline: outline.join(' '), route: station.route.join(' '), end: station.route.at(-1), endpoints,
  };
}

export function IndoorMinimap({ layout, preview, referenceTagId, pose, cameraReady }: {
  layout?: SpaceLayout; preview: boolean; referenceTagId?: number; pose?: MinimapPose; cameraReady: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const [requestedAccess, setAccess] = useState<MotionAccess>();
  const plan = useMemo(() => layout && floorPlan(layout), [layout]);
  useEffect(() => {
    if (!surface.current) return;
    const observer = new ResizeObserver(([{ contentRect }]) => setSize({ width: contentRect.width, height: contentRect.height }));
    observer.observe(surface.current);
    return () => observer.disconnect();
  }, [layout]);

  if (!layout) return null;
  const access = requestedAccess ?? motionAccess();
  const name = spaceLabel(layout.station);
  const here = !preview && pose?.spaceId === layout.id ? pose : undefined;
  const tag = !here && referenceTagId !== undefined ? layout.station.tags.find(item => item.id === referenceTagId) : undefined;
  const point = here?.point ?? tag?.center;
  const live = here && here.source !== 'last';
  const label = tag ? `태그 ${tag.id} 위치` : here?.source === 'motion' ? '추정 위치' : live ? '내 위치' : '마지막 위치';
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
      aria-label={['실내 배치', ...plan.endpoints.map(stop => stop.label), point && label].filter(Boolean).join(' · ')}>
      <g transform={`translate(${centerX} ${centerY}) scale(${scale} ${-scale})`}>
        {plan.outline && <polygon points={plan.outline} fill="#324b40" stroke="#82a494" vectorEffect="non-scaling-stroke" />}
        {layout.station.tags.map(({ id, center: [tx, ty] }) =>
          <rect key={id} x={tx - 2 / scale} y={ty - 2 / scale} width={4 / scale} height={4 / scale} fill="#c1cdc6" />)}
        {plan.route && <polyline points={plan.route} fill="none" stroke="#72e5b2" strokeWidth="3"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {plan.end && <circle cx={plan.end[0]} cy={plan.end[1]} r={3 / scale} fill="#213a2e"
          stroke="#72e5b2" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </g>
      {plan.endpoints.map(({ point: [ex, ey], start, label }) => {
        const px = centerX + ex * scale, py = centerY - ey * scale;
        const right = px < width / 2;
        return <g key={label} transform={`translate(${px} ${py})`}>
          <circle r="5" fill={start ? '#15221d' : '#72e5b2'} stroke="#f5f7f6" strokeWidth="2" />
          <text x={right ? 8 : -8} y={start ? -12 : 18} textAnchor={right ? 'start' : 'end'}
            fontSize="13" fontWeight="700" fill="#f5f7f6" stroke="#15221d" strokeWidth="3" paintOrder="stroke">{label}</text>
        </g>;
      })}
      {point && <g transform={`translate(${markerX} ${markerY})`}>
        {live && here.headingDeg !== null && <path d="M0 -20 L7 -5 H-7 Z" transform={`rotate(${here.headingDeg})`} fill="#fff" />}
        <circle r="11" fill={tag ? '#c77813' : live ? '#087acc' : '#506779'} stroke="#fff"
          strokeWidth="2.5" strokeDasharray={here && here.source !== 'tag' ? '4 2' : undefined} />
        <text x={labelOnRight ? 22 : -22} textAnchor={labelOnRight ? 'start' : 'end'} dy=".35em"
          fontSize="14" fontWeight="700" fill="#fff" stroke="#17251e" strokeWidth="3" strokeLinejoin="round" paintOrder="stroke">
          {label}
        </text>
      </g>}
    </svg>;
  }

  return <figure className="indoor-minimap" aria-label="실내 미니맵">
    <div className="minimap-plan" ref={surface}>{plan ? drawing : <p>등록된 평면 정보가 없습니다.</p>}</div>
    <figcaption><span title={name}>{name}</span>{preview && <small>미리보기</small>}
      {cameraReady && access === 'prompt' &&
        <button type="button" onClick={async () => setAccess(await requestMotionAccess())}>동작 센서 켜기</button>}
      {cameraReady && access === 'denied' && <small role="status">동작 센서 권한 꺼짐</small>}
    </figcaption>
  </figure>;
}
