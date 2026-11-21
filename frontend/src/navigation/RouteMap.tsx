import { lineLabel } from '../i18n/language';
import { stationLabel } from '../i18n/stationLabel';
import { updateUrl, useQuery } from '../urlState';
import { useLanguage } from '../i18n/LanguageSelect';
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { GeoPoint, Journey, Place } from './routes';
import type { RouteTransfer } from './stationProgress';

const latLng = ([lon, lat]: GeoPoint): L.LatLngTuple => [lat, lon];
// The initial map covers the project's Choji transfer station. GPS is requested on demand.
const choji: L.LatLngTuple = [37.320646, 126.805913];
const fit = (map: L.Map, points: GeoPoint[]) => {
  if (points.length) map.fitBounds(L.latLngBounds(points.map(latLng)), { padding: [36, 35], maxZoom: 17, animate: false });
};

export function RouteMap({ origin, destination, trip, transfers, step, position, onPick }: {
  origin?: Place; destination?: Place; trip?: Journey; transfers: RouteTransfer[]; step?: number; position?: GeoPoint;
  onPick?: (point: GeoPoint) => void;
}) {
  const { language, t } = useLanguage();
  const viewport = useQuery().get('map');
  const positioning = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const atlas = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const [tileError, setTileError] = useState(false);
  const routePoints = useMemo(() => trip ? [trip.origin.point, ...trip.steps.flatMap(s => s.points), trip.destination.point] : [], [trip]);

  useEffect(() => {
    const map = L.map(host.current!, { zoomControl: false, maxZoom: 19, zoomAnimation: false, fadeAnimation: false }).setView(choji, 15);
    atlas.current = map;
    map.on('moveend', () => {
      if (positioning.current || !host.current?.clientHeight) return;
      const { lat, lng } = map.getCenter().wrap();
      updateUrl({ map: [lat.toFixed(6), lng.toFixed(6), map.getZoom()].join(',') });
    });
    map.attributionControl.setPrefix(false);
    const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map);
    tiles.current = layer;
    layer.on('tileload', () => setTileError(false));
    layer.on('tileerror', () => {
      if (!host.current?.querySelector('img.leaflet-tile-loaded')) setTileError(true);
    });
    return () => { layer.off(); map.remove(); atlas.current = null; tiles.current = null; };
  }, []);

  useEffect(() => {
    const map = atlas.current!;
    const resize = new ResizeObserver(() => {
      if (host.current?.clientHeight) {
        positioning.current = true;
        map.invalidateSize();
        positioning.current = false;
      }
    });
    resize.observe(host.current!);
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    const map = atlas.current!;
    const control = L.control.zoom({ position: 'topleft', zoomInTitle: t('지도 확대'), zoomOutTitle: t('지도 축소') }).addTo(map);
    return () => { control.remove(); };
  }, [t]);

  useEffect(() => {
    const map = atlas.current!;
    const parts = viewport?.split(',');
    const [lat, lng, zoom] = parts?.map(Number) ?? [];
    positioning.current = true;
    if (parts?.length === 3 && parts.every(p => p.trim()) && Math.abs(lat) <= 85.05113 && Math.abs(lng) <= 180 &&
        Number.isInteger(zoom) && zoom >= 0 && zoom <= 19) {
      map.setView([lat, lng], zoom, { animate: false });
    } else if (routePoints.length) fit(map, routePoints);
    else if (origin && destination) fit(map, [origin.point, destination.point]);
    else if (destination || origin) map.setView(latLng((destination ?? origin)!.point), 16, { animate: false });
    else map.setView(choji, 15, { animate: false });
    positioning.current = false;
  }, [viewport, routePoints, origin, destination]);

  useEffect(() => {
    const map = atlas.current;
    if (!map || !onPick) return;
    const click = ({ latlng }: L.LeafletMouseEvent) => onPick([latlng.wrap().lng, latlng.lat]);
    map.on('click', click);
    return () => { map.off('click', click); };
  }, [onPick]);

  useEffect(() => {
    const map = atlas.current!;
    const group = L.layerGroup().addTo(map);
    for (const [place, label, color] of [[origin, '출발', '#305070'], [destination, '도착', '#0d654d']] as const) {
      if (place) L.circleMarker(latLng(place.point), { pane: 'markerPane', radius: 7, weight: 3, color: '#fff', fillColor: color, fillOpacity: 1 })
        .bindTooltip(t(label), { permanent: true, direction: 'top', offset: [0, -7], className: 'endpoint-label' }).addTo(group);
    }
    return () => { group.remove(); };
  }, [origin, destination, t]);

  useEffect(() => {
    if (!transfers.length) return;
    const map = atlas.current!;
    const group = L.layerGroup().addTo(map);
    const markers: L.CircleMarker[] = [];
    for (const transfer of transfers) {
      if (!transfer.point) continue;
      const label = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = t('{station} 환승', { station: stationLabel(transfer.station, language, true) });
      const lines = document.createElement('span');
      lines.textContent = lineLabel(transfer.fromLine, language) + ' → ' + lineLabel(transfer.toLine, language);
      label.append(title, lines);
      const marker = L.circleMarker(latLng(transfer.point), { pane: 'markerPane', radius: 7, weight: 3,
        color: '#fff', fillColor: '#1c574a', fillOpacity: 1, interactive: false })
        .bindTooltip(label, { permanent: true, direction: 'right', offset: [6, 0], className: 'transfer-label', opacity: 1 }).addTo(group);
      markers.push(marker);
    }
    function positionLabels() {
      for (const marker of markers) {
        const tooltip = marker.getTooltip()!;
        const width = tooltip.getElement()?.offsetWidth;
        if (!width) continue;
        // Keep the label clear of the controls at the lower left when space permits.
        const x = map.latLngToContainerPoint(marker.getLatLng()).x;
        tooltip.options.direction = x + 12 + width <= map.getSize().x ? 'right' : 'left';
        tooltip.update();
      }
    }
    positionLabels();
    map.on('moveend resize', positionLabels);
    return () => { map.off('moveend resize', positionLabels); group.remove(); };
  }, [transfers, language, t]);

  useEffect(() => {
    if (!trip) return;
    const group = L.layerGroup().addTo(atlas.current!);
    for (const [i, leg] of trip.steps.entries()) {
      const points = leg.points.map(latLng);
      if (points.length < 2) continue;
      L.polyline(points, { color: '#fff', weight: 8, opacity: .95, interactive: false }).addTo(group);
      L.polyline(points, { color: i === step ? '#006745' : '#517b8c', weight: i === step ? 6 : 4, opacity: .95,
        dashArray: leg.kind === '도보' && trip.mode === 'transit' ? '5 7' : undefined, interactive: false }).addTo(group);
    }
    return () => { group.remove(); };
  }, [trip, step]);

  useEffect(() => {
    if (!position) return;
    const dot = L.circleMarker(latLng(position), { pane: 'markerPane', radius: 6, color: 'white', weight: 3, fillColor: '#1264ad', fillOpacity: 1 })
      .bindTooltip(t('현재 위치')).addTo(atlas.current!);
    return () => { dot.remove(); };
  }, [position, t]);

  return <div className="route-map" data-picking={!!onPick}>
    <div className="map-surface" ref={host} role="region" aria-label={t('2D 경로 지도')} />
    {tileError && <div className="map-error">{t('배경 지도를 불러오지 못했습니다.')}
      <button type="button" onClick={() => tiles.current?.redraw()}>{t('다시 시도')}</button></div>}
    {trip && <div className="map-tools">
      <button type="button" onClick={() => fit(atlas.current!, routePoints)}>{t('전체 경로')}</button>
      {position && <button type="button" onClick={() => atlas.current?.setView(latLng(position), 17)}>{t('내 위치')}</button>}
    </div>}
  </div>;
}
