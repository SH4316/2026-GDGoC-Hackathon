import { useEffect, useRef, useState } from 'react';
import type { Point, TagSurface } from '../ar/station';
import { TagMarkers } from './TagMarkers';

export type PlottedTag = { index: number; id: string; center: Point; yaw: number; surface?: TagSurface };

export function StationPlan({ outline, route, tags, selected, select }: {
  outline: Point[]; route: Point[]; tags: PlottedTag[]; selected: number | null; select: (index: number) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);
  const [[width, height], setSize] = useState([0, 0]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize([entry.contentRect.width, entry.contentRect.height]));
    observer.observe(frame.current!);
    return () => observer.disconnect();
  }, []);

  const points: Point[] = [[0, 0], ...outline, ...route, ...tags.map(tag => tag.center)];
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const scale = Math.min(Math.max(1, width - 120) / 2 / Math.max(.5, maxX / 2 - minX / 2),
    Math.max(1, height - 72) / 2 / Math.max(.5, maxY / 2 - minY / 2));
  const originX = width / 2 - (minX / 2 + maxX / 2) * scale;
  const originY = height / 2 + (minY / 2 + maxY / 2) * scale;
  const endpoints: Array<[Point, string]> = route.length >= 2 ? [[route[0], '출발'], [route.at(-1)!, '도착']] : [];
  const scaleUnit = unitForScale(scale);

  useEffect(() => {
    if (!width || !height) return;
    const canvas = surface.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    function drawPath(vertices: Point[], closed = false) {
      ctx!.beginPath();
      vertices.forEach(([x, y], index) => {
        const px = originX + scale * x, py = originY - scale * y;
        if (index === 0) ctx!.moveTo(px, py);
        else ctx!.lineTo(px, py);
      });
      if (closed) ctx!.closePath();
    }

    let interval = .25;
    while (interval * scale < 12 && Number.isFinite(scale) && scale > 0) interval *= 4;
    const unit = interval * scale;
    if (!(unit > 0 && Number.isFinite(unit))) return;
    const startX = originX % unit, startY = originY % unit;
    ctx.lineWidth = 1;
    for (let x = startX; x <= width; x += unit) {
      ctx.beginPath();
      ctx.strokeStyle = Math.round((x - originX) / unit) % 4 === 0 ? '#294049' : '#1d343d';
      ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = startY; y <= height; y += unit) {
      ctx.beginPath();
      ctx.strokeStyle = Math.round((y - originY) / unit) % 4 === 0 ? '#294049' : '#1d343d';
      ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    if (outline.length >= 3) {
      drawPath(outline, true);
      ctx.fillStyle = '#26454a';
      ctx.fill();
      ctx.strokeStyle = '#668e90';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = '#315459';
      ctx.lineWidth = 1;
      for (let x = -height; x < width; x += 12) {
        ctx.beginPath(); ctx.moveTo(x, height); ctx.lineTo(x + height, 0); ctx.stroke();
      }
      ctx.restore();
    }
    if (!route.length) return;
    drawPath(route);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#8fe2c3';
    ctx.setLineDash([6, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
    route.forEach(([x, y], index) => {
      const px = originX + scale * x, py = originY - scale * y;
      ctx.beginPath();
      ctx.arc(px, py, index === 0 || index === route.length - 1 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = '#a0ebcd';
      ctx.fill();
      ctx.strokeStyle = '#173339';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }, [width, height, scale, originX, originY, outline, route]);

  return <div className="plan-stage" ref={frame}>
    <canvas ref={surface} role="img" aria-label="지형 경계와 안내 경로가 표시된 평면 배치도" />
    <div className="plan-axes" aria-label="오른쪽이 양의 X, 위쪽이 양의 Y">
      <span>+Y</span><span className="plan-axis-lines" /><span>+X</span>
    </div>
    {width > 0 && <>
      <TagMarkers points={tags.map(tag => ({ index: tag.index, id: tag.id, yaw: tag.yaw,
        x: originX + tag.center[0] * scale, y: originY - tag.center[1] * scale }))}
        width={width} height={height} selected={selected} select={select}
        reserved={endpoints.map(([[x, y]]) => ({ x: originX + x * scale + 11, y: originY - y * scale + 9, w: 24, h: 16 }))} />
      {endpoints.map(([[x, y], label]) => <span className="plan-endpoint" key={label}
        style={{ left: originX + x * scale, top: originY - y * scale }}>{label}</span>)}
      {Number.isFinite(scaleUnit) && <div className="plan-scale" style={{ width: scale * scaleUnit }}>{scaleUnit} m</div>}
    </>}
  </div>;
}

function unitForScale(scale: number) {
  const limit = 110 / scale;
  const base = 10 ** Math.floor(Math.log10(limit));
  return limit >= base * 5 ? base * 5 : limit >= base * 2 ? base * 2 : base;
}
