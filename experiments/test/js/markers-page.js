// QR 안내판 인쇄 페이지 (markers.html?map=<지도 이름>)

import { loadMap } from './mapdata.js';
import { MiniMap } from './minimap.js';
import { markerPayload, qrSvg } from './qr.js';

const P = new URLSearchParams(location.search);
const mapId = P.get('map') || 'station';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** QR에 담을 기본 주소. serve.py로 띄웠으면 폰이 접속할 수 있는 https 주소를 쓴다. */
async function defaultBase() {
  const suffix = mapId === 'station' ? '' : `?map=${mapId}`;
  try {
    const res = await fetch('serverinfo.json', { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      if (info.ip && info.httpsPort) return `https://${info.ip}:${info.httpsPort}/${suffix}`;
    }
  } catch (e) {
    /* 정적 호스팅에서는 지금 주소를 그대로 쓴다 */
  }
  const u = new URL('./', location.href);
  return u.origin + u.pathname + suffix;
}

function render(map, base) {
  const sheets = document.getElementById('sheets');
  sheets.innerHTML = '';
  for (const m of map.markers) {
    const payload = markerPayload(base, m.id);
    const mm = Math.round(m.size * 1000);
    const floor = m.mount === 'floor';
    const how = floor
      ? `바닥에 붙입니다. 위의 주황색 화살표가 배치도의 주황 선 방향(지도 위쪽 기준 시계 방향 ${m.facing}°)을 향하게 놓으세요.`
      : `벽에 반듯하게 붙입니다. QR의 중심이 바닥에서 ${m.h}m 높이에 오게 하세요.`;
    const div = document.createElement('div');
    div.className = 'sheet';
    div.innerHTML =
      `<div class="head"><b>QR 길안내</b><span>카메라로 비추면 길을 알려 드려요 · Scan for directions</span></div>` +
      (floor ? `<div class="up">▲ 이쪽이 위</div>` : '') +
      `<div class="qr">${qrSvg(payload, mm)}</div>` +
      `<div class="foot"><div class="txt">` +
      `<div class="id">${esc(m.id)} <span style="font-size:11pt;font-weight:400">· ${floor ? '바닥용' : '벽용'} · 지도 좌표 (${m.x}, ${m.y})</span></div>` +
      `<div>${how}</div>` +
      `<div>QR 한 변 ${mm}mm · 아래 선이 정확히 10cm인지 자로 확인하세요:</div>` +
      `<div><span class="ruler"></span></div>` +
      `<div class="url">${esc(payload)}</div>` +
      `</div><canvas class="where"></canvas></div>`;
    sheets.appendChild(div);
    // 이 QR을 붙일 자리를 작은 지도에 빨간 동그라미로 표시한다
    const where = new MiniMap(div.querySelector('.where'), map);
    const drawWhere = () => where.draw({ dest: { x: m.x, y: m.y }, seenIds: [m.id] });
    drawWhere();
    window.addEventListener('beforeprint', drawWhere);
  }
}

async function main() {
  const map = await loadMap(mapId);
  document.getElementById('mapTitle').textContent = `배치도 · ${map.name.ko || map.id}`;

  const mini = new MiniMap(document.getElementById('layout'), map);
  const draw = () => mini.draw({ labels: true });
  draw();
  window.addEventListener('resize', draw);
  window.addEventListener('beforeprint', draw);

  const rows = map.markers
    .map(
      (m) =>
        `<tr><td><b>${esc(m.id)}</b></td><td>${m.mount === 'floor' ? '바닥' : '벽'}</td>` +
        `<td>${m.x}</td><td>${m.y}</td><td>${m.mount === 'floor' ? '-' : m.h}</td><td>${m.facing}°</td></tr>`
    )
    .join('');
  document.getElementById('table').innerHTML =
    `<tr><th>ID</th><th>종류</th><th>x (m)</th><th>y (m)</th><th>높이 (m)</th><th>방향</th></tr>${rows}`;

  const input = document.getElementById('base');
  input.value = P.get('base') || (await defaultBase());
  input.addEventListener('input', () => render(map, input.value.trim()));
  document.getElementById('print').addEventListener('click', () => window.print());
  render(map, input.value.trim());
}

main().catch((e) => {
  document.getElementById('sheets').textContent = `지도를 불러오지 못했어요: ${e.message}`;
});
