// 미니맵: 역 도면, 경로, 현재 위치를 위에서 내려다본 그림.

import { rad } from './geo.js';
import { poiIcon } from './destinations.js';

export class MiniMap {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    this.ctx = canvas.getContext('2d');
    this.plan = null; // 배경 평면도 그림 (다 받아지면 채워진다)
    if (map.floorplan) {
      const img = new Image();
      img.onload = () => {
        this.plan = img;
        if (this._last) this.draw(this._last);
      };
      img.src = new URL(`../maps/${map.floorplan.image}`, import.meta.url).href;
    }
  }

  /** 캔버스 크기를 화면 표시 크기에 맞춘다 */
  _fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const b = this.map.bounds;
    const pad = 10 * dpr;
    const sx = (w - pad * 2) / Math.max(1, b.maxX - b.minX);
    const sy = (h - pad * 2) / Math.max(1, b.maxY - b.minY);
    const k = Math.min(sx, sy);
    const ox = (w - (b.maxX - b.minX) * k) / 2;
    const oy = (h - (b.maxY - b.minY) * k) / 2;
    // 지도 좌표 → 캔버스 좌표 (지도의 +y가 화면 위쪽)
    this._tx = (x) => ox + (x - b.minX) * k;
    this._ty = (y) => h - oy - (y - b.minY) * k;
    this._k = k;
    this._dpr = dpr;
  }

  /**
   * pos: { x, y } | null, heading: 도, route: { path } | null, s: 지나온 거리,
   * dest: { x, y } | null, seenIds: 인식 중인 마커, uncertainty: 위치 불확실 반경(m),
   * labels: true면 마커 ID와 방향을 함께 그린다 (배치도용)
   */
  draw(state = {}) {
    const { pos, heading, route, s = 0, dest, seenIds = [], uncertainty = 0, labels = false } = state;
    this._last = state;
    this._fit();
    // 미니맵이 아직 화면에 자리를 잡지 못했으면(크기 0) 그릴 수 없다. 축척이 음수가 되어 오류가 난다.
    if (!(this._k > 0)) return;
    const g = this.ctx;
    const { _tx: tx, _ty: ty, _k: k, _dpr: dpr } = this;
    const map = this.map;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 배경 평면도
    if (this.plan) {
      const f = map.floorplan;
      g.imageSmoothingEnabled = true;
      g.drawImage(this.plan, tx(f.x), ty(f.y), this.plan.width * f.mpp * k, this.plan.height * f.mpp * k);
    }

    // 다닐 수 있는 통로 (평면도가 있으면 벽이 가려지지 않게 가늘게)
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = this.plan ? 'rgba(30,107,255,0.22)' : '#e3e8f0';
    g.lineWidth = this.plan ? Math.max(3 * dpr, 0.9 * k) : Math.max(4 * dpr, 2.6 * k);
    g.beginPath();
    for (const e of map.edges) {
      const a = map.nodes.get(e.a);
      const b = map.nodes.get(e.b);
      g.moveTo(tx(a.x), ty(a.y));
      g.lineTo(tx(b.x), ty(b.y));
    }
    g.stroke();

    // 벽
    g.strokeStyle = '#5b6678';
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    for (const [x1, y1, x2, y2] of map.walls) {
      g.moveTo(tx(x1), ty(y1));
      g.lineTo(tx(x2), ty(y2));
    }
    g.stroke();

    // 경로: 지나온 부분은 흐리게
    if (route) {
      const xy = route.path.xy;
      const cur = route.path.pointAt(s);
      g.lineWidth = 3.5 * dpr;
      g.strokeStyle = '#b9c6dc';
      g.beginPath();
      g.moveTo(tx(xy[0].x), ty(xy[0].y));
      for (let i = 1; i <= cur.seg; i++) g.lineTo(tx(xy[i].x), ty(xy[i].y));
      g.lineTo(tx(cur.x), ty(cur.y));
      g.stroke();
      g.strokeStyle = '#1e6bff';
      g.beginPath();
      g.moveTo(tx(cur.x), ty(cur.y));
      for (let i = cur.seg + 1; i < xy.length; i++) g.lineTo(tx(xy[i].x), ty(xy[i].y));
      g.stroke();
    }

    // QR 마커
    for (const m of map.markers) {
      const seen = seenIds.includes(m.id);
      const r = (seen ? 4 : 2.6) * dpr;
      g.fillStyle = seen ? '#19c37d' : '#1b2433';
      g.fillRect(tx(m.x) - r, ty(m.y) - r, r * 2, r * 2);
      if (labels) {
        // 방향 표시: 벽 마커는 바라보는 쪽, 바닥 마커는 QR의 위쪽
        const a = rad(m.facing);
        const len = 14 * dpr;
        g.strokeStyle = m.mount === 'floor' ? '#d9480f' : '#1e6bff';
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.moveTo(tx(m.x), ty(m.y));
        g.lineTo(tx(m.x) + Math.sin(a) * len, ty(m.y) - Math.cos(a) * len);
        g.stroke();
        g.fillStyle = '#111';
        g.font = `bold ${10 * dpr}px system-ui, sans-serif`;
        g.textAlign = 'left';
        g.textBaseline = 'bottom';
        g.fillText(m.id, tx(m.x) + 4 * dpr, ty(m.y) - 4 * dpr);
      }
    }

    // 목적지 종류 아이콘
    g.font = `${11 * dpr}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of map.pois) {
      g.globalAlpha = dest && (p.x !== dest.x || p.y !== dest.y) ? 0.55 : 1;
      g.fillText(poiIcon(p), tx(p.x), ty(p.y));
    }
    g.globalAlpha = 1;

    if (dest) {
      g.strokeStyle = '#ff3b30';
      g.lineWidth = 2.5 * dpr;
      g.beginPath();
      g.arc(tx(dest.x), ty(dest.y), 9 * dpr, 0, Math.PI * 2);
      g.stroke();
    }

    // 현재 위치와 바라보는 방향
    if (pos) {
      const x = tx(pos.x);
      const y = ty(pos.y);
      if (uncertainty > 0.3) {
        g.fillStyle = 'rgba(30,107,255,0.14)';
        g.beginPath();
        g.arc(x, y, uncertainty * k, 0, Math.PI * 2);
        g.fill();
      }
      const h = rad(heading);
      g.fillStyle = 'rgba(30,107,255,0.35)';
      g.beginPath();
      g.moveTo(x, y);
      g.arc(x, y, 20 * dpr, h - Math.PI / 2 - 0.5, h - Math.PI / 2 + 0.5);
      g.closePath();
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x, y, 6.5 * dpr, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1e6bff';
      g.beginPath();
      g.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
      g.fill();
    }
  }
}
