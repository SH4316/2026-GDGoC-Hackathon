// QR 코드 만들기 (가상 역의 안내판과 인쇄용 페이지에서 쓴다).

import qrcode from '../vendor/qrcode.mjs';

/** 마커 QR에 담을 문자열. 폰 기본 카메라로 찍으면 이 주소로 앱이 열린다. */
export function markerPayload(baseUrl, id) {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}m=${id}`;
}

/**
 * 문자열을 QR 행렬로 만든다. 칸 수가 가장 적은 버전을 고르고(칸이 클수록 멀리서 인식된다),
 * 그 버전 안에서 가장 강한 오류 정정 수준을 쓴다.
 */
export function qrMatrix(text) {
  let best = null;
  for (const level of ['L', 'M', 'Q', 'H']) {
    const qr = qrcode(0, level);
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    if (!best || n <= best.n) best = { n, qr };
  }
  return { n: best.n, dark: (r, c) => best.qr.isDark(r, c) };
}

/** 캔버스의 (x, y) 위치에 한 변 size 픽셀로 QR 심볼을 그린다 (여백 제외) */
export function drawQr(ctx, text, x, y, size) {
  const { n, dark } = qrMatrix(text);
  const cell = size / n;
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (dark(r, c)) {
        // 칸 사이에 틈이 보이지 않게 살짝 겹쳐 그린다
        ctx.fillRect(x + c * cell - 0.2, y + r * cell - 0.2, cell + 0.4, cell + 0.4);
      }
    }
  }
  return n;
}

/** 인쇄용 SVG 문자열. sizeMm는 QR 심볼 한 변의 실제 길이 */
export function qrSvg(text, sizeMm) {
  const { n, dark } = qrMatrix(text);
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (dark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizeMm}mm" height="${sizeMm}mm" ` +
    `viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`
  );
}
