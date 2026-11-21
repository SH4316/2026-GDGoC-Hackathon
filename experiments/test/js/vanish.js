// 카메라 영상에서 복도가 뻗은 방향을 찾는다 (소실점). 순수 함수.
//
// 복도를 바라보면 바닥과 벽의 경계, 천장 선, 문틀 윗변 같은 "복도와 나란한 선"들이
// 화면에서 한 점(소실점)으로 모인다. 그 점이 화면 가운데에서 얼마나 옆에 있는지가 곧
// "카메라가 복도 방향에서 몇 도 틀어져 있는지"다.
//
// 폰의 기울기 센서로 지평선(수평 방향들이 놓이는 선)이 화면의 어디인지 알 수 있으므로,
// 영상의 곧은 선들을 지평선까지 연장해 어디서 만나는지 투표하면 된다. 폰을 숙여 들어서
// 복도 끝이 화면에 안 보여도, 바닥과 벽의 경계선만 보이면 같은 방법으로 찾을 수 있다.
//
// 잘못 맞추는 것이 안 맞추는 것보다 나쁘므로 두 가지를 확인한다.
//   - 곧게 이어진 선만 센다 (무늬, 사람, 바닥에 비친 불빛의 번진 가장자리는 뺀다)
//   - 기울기가 서로 다른 선이 둘 이상 같은 곳으로 모일 때만 인정한다
//     (선 하나만으로는 그 선이 복도와 나란한지 알 수 없다)

export const VP_RANGE = 70; // 정면에서 좌우로 이 각도까지 본다 (도)
const BINS = VP_RANGE * 2; // 1도 간격
const ORI = 12; // 선의 기울기를 15도 간격으로 나눈 칸 수

// 매 장면마다 큰 배열을 새로 만들지 않도록, 같은 크기의 영상에는 같은 배열을 다시 쓴다.
// (가장자리 한 줄은 계산하지 않으므로 처음 만들 때의 0이 그대로 남는다)
let pool = null;
function buffers(n) {
  if (!pool || pool.n !== n) {
    pool = {
      n,
      gray: new Float32Array(n),
      gxs: new Float32Array(n),
      gys: new Float32Array(n),
      mags: new Float32Array(n),
    };
  }
  return pool;
}

/**
 * 영상의 선들이 지평선 위 어느 방향으로 모이는지 투표한 결과.
 *  image: { data(RGBA), width, height }
 *  intr: 이 영상 크기에 맞는 { f, cx, cy }
 *  up: 카메라 좌표계에서 본 "위쪽" 방향 [x, y, z] (오른쪽 x, 위 y, 뒤 z)
 * 반환: { weight, count, ori, minSupport }
 *   weight[i], count[i]: 정면에서 (i - 70)도 ~ (i - 69)도 방향(오른쪽 +)으로 모인 선의 세기와 점 개수
 *   ori[i * 12 + k]: 그 가운데 기울기가 k번째 칸인 점의 개수
 *   minSupport: 복도 선으로 인정하려면 필요한 점 개수 (영상 크기에 비례)
 */
export function corridorHistogram(image, intr, up) {
  const { data, width: w, height: h } = image;
  const weight = new Float32Array(BINS);
  const counts = new Uint32Array(BINS);
  const ori = new Uint32Array(BINS * ORI);
  const hist = { weight, count: counts, ori, minSupport: 0.22 * Math.hypot(w, h) };
  const [ux, uy, uz] = up;

  // 밝기
  const { gray, gxs, gys, mags } = buffers(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = data[p] * 0.3 + data[p + 1] * 0.59 + data[p + 2] * 0.11;
  }

  // 밝기 변화(소벨). 먼저 전체 평균을 구해 뚜렷한 것만 고른다.
  let sum = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy =
        gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      gxs[i] = gx;
      gys[i] = gy;
      const m = Math.abs(gx) + Math.abs(gy);
      mags[i] = m;
      sum += m;
      count++;
    }
  }
  const threshold = Math.max(50, (sum / Math.max(1, count)) * 2.5);
  const weak = threshold * 0.6;

  // 수평면 위에서 "카메라 정면"과 "오른쪽" (카메라 좌표계)
  let fx = uz * ux;
  let fy = uz * uy;
  let fz = -1 + uz * uz;
  const fn = Math.hypot(fx, fy, fz);
  if (fn < 0.2) return hist; // 바닥이나 천장을 똑바로 보고 있다
  fx /= fn;
  fy /= fn;
  fz /= fn;
  const rx = fy * uz - fz * uy;
  const ry = fz * ux - fx * uz;
  const rz = fx * uy - fy * ux;
  const horizonNorm = Math.hypot(ux, uy);
  if (horizonNorm < 0.2) return hist;

  const SIN_VERTICAL = Math.sin((14 * Math.PI) / 180);
  const COS_SAME = Math.cos((16 * Math.PI) / 180);
  const STEPS = [-5, -2.5, 2.5, 5]; // 선을 따라 앞뒤로 이만큼 떨어진 곳도 같은 선이어야 한다 (픽셀)
  for (let y = 6; y < h - 6; y++) {
    const yn = -(y - intr.cy) / intr.f;
    for (let x = 6; x < w - 6; x++) {
      const i = y * w + x;
      const mag = mags[i];
      if (mag < threshold) continue;
      const gx = gxs[i];
      const gy = gys[i];
      const gn = Math.hypot(gx, gy);
      // 곧게 이어진 선인가: 선을 따라 앞뒤의 점들도 같은 방향으로 밝기가 변해야 한다
      const lx = -gy / gn; // 영상 좌표(아래가 +y)에서 선이 뻗은 방향
      const ly = gx / gn;
      let same = 0;
      for (let k = 0; k < 4; k++) {
        const j = Math.round(y + ly * STEPS[k]) * w + Math.round(x + lx * STEPS[k]);
        if (mags[j] < weak) continue;
        const dot = (gxs[j] * gx + gys[j] * gy) / (Math.hypot(gxs[j], gys[j]) * gn);
        if (dot > COS_SAME) same++;
      }
      if (same < 3) continue;

      const xn = (x - intr.cx) / intr.f;
      // 이 점을 지나는 선의 방향 (밝기 변화에 수직). y가 위인 좌표로 바꾼다.
      const tx = -gy;
      const ty = -gx;
      const tn = gn;
      // 세로로 선 것(문틀, 기둥)은 복도 방향과 무관하므로 뺀다
      const vx = ux + xn * uz;
      const vy = uy + yn * uz;
      const vn = Math.hypot(vx, vy);
      if (vn > 1e-6 && Math.abs(tx * vy - ty * vx) < SIN_VERTICAL * tn * vn) continue;
      // 지평선과 거의 나란한 선은 어디서 만나는지 알 수 없다
      const den = tx * ux + ty * uy;
      const sine = Math.abs(den) / (tn * horizonNorm);
      if (sine < 0.1) continue;
      const lam = (uz - xn * ux - yn * uy) / den;
      const hx = xn + lam * tx;
      const hy = yn + lam * ty;
      // 그 만나는 점이 정면에서 몇 도 옆인지
      const along = hx * fx + hy * fy - fz;
      if (along <= 0) continue;
      const side = hx * rx + hy * ry - rz;
      const rel = (Math.atan2(side, along) * 180) / Math.PI;
      const bin = Math.floor(rel + VP_RANGE);
      if (bin < 0 || bin >= BINS) continue;
      weight[bin] += Math.min(mag, threshold * 4) * sine;
      counts[bin]++;
      // 선의 기울기 (0~180도를 12칸으로)
      let ang = Math.atan2(ty, tx);
      if (ang < 0) ang += Math.PI;
      ori[bin * ORI + Math.min(ORI - 1, Math.floor((ang / Math.PI) * ORI))]++;
    }
  }
  return hist;
}

/**
 * 투표 결과에서 expected(도) 근처의 봉우리를 찾는다.
 * 반환: { rel(도), quality(봉우리가 평균의 몇 배인지), support(점 개수), second(두 번째 기울기의 점 개수) }
 *       또는 믿을 만한 봉우리가 없으면 null
 */
export function findPeak(votes, expected, windowDeg = 20) {
  const hist = votes.weight;
  const smooth = new Float32Array(BINS);
  let total = 0;
  for (let i = 0; i < BINS; i++) {
    const a = hist[Math.max(0, i - 2)];
    const b = hist[Math.max(0, i - 1)];
    const c = hist[i];
    const d = hist[Math.min(BINS - 1, i + 1)];
    const e = hist[Math.min(BINS - 1, i + 2)];
    smooth[i] = (a + 2 * b + 3 * c + 2 * d + e) / 9;
    total += hist[i];
  }
  if (total <= 0) return null;
  const mean = total / BINS;
  const lo = Math.max(0, Math.floor(expected - windowDeg + VP_RANGE));
  const hi = Math.min(BINS - 1, Math.ceil(expected + windowDeg + VP_RANGE));
  let best = -1;
  for (let i = lo; i <= hi; i++) {
    if (best < 0 || smooth[i] > smooth[best]) best = i;
  }
  if (best < 0) return null;
  const quality = smooth[best] / mean;
  if (quality < 2.5) return null;
  // 봉우리 주변의 가중 평균으로 1도보다 정밀하게
  let sw = 0;
  let sx = 0;
  let support = 0;
  const oriSum = new Float32Array(ORI);
  for (let i = Math.max(0, best - 2); i <= Math.min(BINS - 1, best + 2); i++) {
    sw += hist[i];
    sx += hist[i] * (i + 0.5 - VP_RANGE);
    support += votes.count[i];
    for (let k = 0; k < ORI; k++) oriSum[k] += votes.ori[i * ORI + k];
  }
  // 선 끝이나 모서리 몇 점이 우연히 모인 것은 복도 선이 아니다
  if (sw <= 0 || support < votes.minSupport) return null;
  // 기울기가 다른 선이 둘 이상 모였는가. 가장 많은 기울기에서 30도 넘게 떨어진 선들을 센다.
  let top = 0;
  for (let k = 1; k < ORI; k++) if (oriSum[k] > oriSum[top]) top = k;
  let second = 0;
  for (let k = 0; k < ORI; k++) {
    const gap = Math.min(Math.abs(k - top), ORI - Math.abs(k - top));
    if (gap >= 2) second += oriSum[k];
  }
  if (second < Math.max(votes.minSupport * 0.25, support * 0.12)) return null;
  return { rel: sx / sw, quality, support, second };
}
