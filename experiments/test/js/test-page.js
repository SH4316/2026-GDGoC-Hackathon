// 화면에 QR을 실제 크기로 띄우는 페이지 (test.html).
//
//   test.html                 책상 테스트용 지도(desk)의 QR 한 장
//   test.html?map=<지도 이름>  그 지도의 QR을 골라 띄운다 (프린터 없이 실제 자리에 세워 볼 때)
//
// QR 안에 크기와 높이를 함께 담아서, 폰 쪽에서는 지도 파일을 고칠 필요가 없다.

import { qrMatrix } from './qr.js';

const CARD_W_MM = 85.6; // 신용카드 규격
const CARD_H_MM = 54;
const CSS_PX_PER_MM = 96 / 25.4; // 화면이 규격대로라면 1mm가 이만큼의 픽셀
const P = new URLSearchParams(location.search);
const MAP_ID = P.get('map') || 'desk';

const $ = (id) => document.getElementById(id);

function load(key, fallback) {
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (e) {
    /* 저장하지 못해도 동작에는 지장 없다 */
  }
}

/** QR을 SVG로 그린다. px는 심볼 한 변의 화면 픽셀, 둘레에 흰 여백(4칸)을 둔다 */
function qrSvgPx(text, px) {
  const { n, dark } = qrMatrix(text);
  const quiet = 4;
  const total = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const size = (px * total) / n;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}

/**
 * 폰이 접속할 주소. serve.py로 띄웠으면 노트북의 IP를 알려 준다.
 * 반환: { base, known } known이 false면 폰에서 열 주소를 알 수 없다 (localhost로 열었는데 IP를 모를 때)
 */
async function phoneBase() {
  try {
    const res = await fetch('serverinfo.json', { cache: 'no-store' });
    if (res.ok) {
      const info = await res.json();
      if (info.ip && info.httpsPort) return { base: `https://${info.ip}:${info.httpsPort}/`, known: true };
    }
  } catch (e) {
    /* serve.py가 아닌 곳에서 열었을 때 */
  }
  const u = new URL('./', location.href);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return { base: u.origin + u.pathname, known: !local };
}

async function main() {
  const { base, known } = await phoneBase();
  const res = await fetch(`maps/${MAP_ID}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`"${MAP_ID}" 지도를 찾지 못했습니다`);
  const map = await res.json();
  const markers = map.markers || [];
  if (!markers.length) throw new Error('이 지도에는 QR이 없습니다');

  const isDesk = MAP_ID === 'desk';
  if (!isDesk) {
    $('pageTitle').textContent = `화면으로 QR 띄우기 · ${(map.name && map.name.ko) || MAP_ID}`;
    $('pageLead').textContent =
      '프린터 없이, 이 화면을 지도 속 QR 자리에 세워 두고 실제 폰으로 시험합니다. ' +
      '화면 하나로는 QR 한 장만 띄울 수 있으니, 시험할 구간의 출발 QR 자리에 두세요.';
    $('stepsMap').hidden = false;
    $('stepsDesk').hidden = true;
  }

  const sel = $('markerSel');
  for (const m of markers) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.id} (${m.mount === 'floor' ? '바닥' : '벽'})`;
    sel.append(opt);
  }
  if (markers.some((m) => m.id === P.get('m'))) sel.value = P.get('m');
  $('pick').hidden = markers.length < 2;

  const scale = $('scale');
  const sizeInput = $('size');
  const heightInput = $('height');
  scale.value = load('iriro.test.scale', 1);
  sizeInput.value = load('iriro.test.size', 100);
  heightInput.value = load('iriro.test.height', 90);

  function render() {
    const marker = markers.find((m) => m.id === sel.value) || markers[0];
    const floor = marker.mount === 'floor';
    const pxPerMm = CSS_PX_PER_MM * parseFloat(scale.value);
    const sizeMm = Math.max(60, Math.min(200, parseFloat(sizeInput.value) || 100));
    const heightCm = Math.max(0, Math.min(250, parseFloat(heightInput.value) || 90));
    save('iriro.test.scale', scale.value);
    save('iriro.test.size', sizeMm);
    save('iriro.test.height', heightCm);

    $('cardBox').style.width = `${CARD_W_MM * pxPerMm}px`;
    $('cardBox').style.height = `${CARD_H_MM * pxPerMm}px`;

    // 바닥 QR은 높이가 0이므로 크기만 담는다
    const payload =
      `${base}?map=${MAP_ID}&m=${marker.id}&s=${Math.round(sizeMm)}` + (floor ? '' : `&h=${Math.round(heightCm)}`);
    $('marker').innerHTML = qrSvgPx(payload, sizeMm * pxPerMm);
    $('upMark').hidden = !floor;
    $('markerInfo').textContent =
      `마커 ${marker.id} · 한 변 ${Math.round(sizeMm)}mm` + (floor ? ' · 바닥용' : ` · 중심 높이 ${Math.round(heightCm)}cm`);

    // 화면에 다 들어가지 않으면 알려 준다
    const n = qrMatrix(payload).n;
    const needed = ((sizeMm * pxPerMm) / n) * (n + 8);
    $('fit').textContent = needed > window.innerHeight - 40 ? ' 화면보다 큽니다. 줄여 주세요.' : '';

    if (!isDesk) {
      $('placeHint').textContent = floor
        ? `이 화면(태블릿이나 다른 폰)을 지도에서 ${marker.id}가 있는 자리 (x ${marker.x}, y ${marker.y}) 바닥에 눕혀 놓습니다. ` +
          '"▲ 이쪽이 위" 표시가 지도의 주황 화살표 방향을 향하게 합니다.'
        : `이 화면을 지도에서 ${marker.id}가 있는 자리 (x ${marker.x}, y ${marker.y})의 벽에 바짝 붙여 세웁니다. ` +
          '화면이 지도의 파란 화살표 방향(통로 쪽)을 보게 하고, 화면은 수직으로 세웁니다.';
    }

    if (known) {
      const openUrl = `${base}?map=${MAP_ID}&debug=1`;
      $('phoneUrl').textContent = openUrl;
      $('openQr').innerHTML = qrSvgPx(openUrl, 34 * pxPerMm);
    } else {
      // 폰 주소를 모를 때: 폰에서 이미 열어 둔 주소 뒤에 붙일 부분만 알려 준다
      $('phoneUrl').textContent = `(폰에서 연 주소)/?map=${MAP_ID}&debug=1`;
      $('openQr').innerHTML =
        '<p style="line-height:1.5">serve.py를 껐다 다시 켜고 이 화면을 새로 고치면, 폰으로 찍어서 바로 열 수 있는 QR이 여기에 나옵니다.</p>';
    }
  }

  for (const el of [scale, sizeInput, heightInput, sel]) el.addEventListener('input', render);
  window.addEventListener('resize', render);
  $('onlyBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.add('only');
  });
  // QR만 보는 화면에서는 아무 곳이나 누르면 돌아온다 (QR 고르기 상자는 제외)
  $('qrSide').addEventListener('click', (e) => {
    if (!e.target.closest('#pick')) document.body.classList.remove('only');
  });
  render();
}

main().catch((e) => {
  $('marker').textContent = e.message;
});
