// QR 인식. zxing(C++ 바코드 라이브러리의 웹어셈블리판)을 쓴다.
//
// 브라우저 내장 BarcodeDetector는 기기마다 모서리 순서의 기준이 달라질 수 있어서 쓰지 않는다.
// zxing은 항상 "QR 심볼 기준 왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래" 순서로 주는데,
// 바닥에 붙인 QR은 이 순서가 곧 방향 정보라서 일관성이 중요하다.

import { BarcodeDetector, prepareZXingModule } from '../vendor/barcode-detector/ponyfill.js';
import { parseMarkerPayload } from './pose.js';

// 웹어셈블리 파일을 CDN이 아니라 이 앱과 같은 곳에서 받는다 (행사장 네트워크에서 CDN이 막혀도 동작)
prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm')
        ? new URL(`../vendor/barcode-detector/${path}`, import.meta.url).href
        : prefix + path,
  },
});

export function createDetector() {
  return new BarcodeDetector({ formats: ['qr_code'] });
}

/**
 * 영상(또는 캔버스)에서 QR을 찾는다.
 * 반환: [{ id, h, size, raw, corners: [{x, y} x4] }]  id는 이 앱의 마커가 아니면 null,
 *       h와 size는 QR에 설치 정보가 담겨 있을 때만 값이 있다
 */
export async function detectMarkers(detector, source) {
  let found;
  try {
    found = await detector.detect(source);
  } catch (e) {
    return [];
  }
  return found
    .filter((f) => f.cornerPoints && f.cornerPoints.length === 4)
    .map((f) => ({
      ...parseMarkerPayload(f.rawValue),
      raw: f.rawValue,
      corners: f.cornerPoints.map((p) => ({ x: p.x, y: p.y })),
    }));
}
