// 경로 점 목록에서 "어디서 어느 쪽으로 꺾는지"를 뽑는다. 순수 함수.

import { Path } from './geo.js';

const MERGE_DIST = 1.5; // 이 거리 안에 붙은 꺾임은 한 동작으로 본다 (m)
const MIN_ANGLE = 28; // 이보다 작은 방향 변화는 직진으로 본다 (도)

/** 점 목록 [{x, y}] → { path, maneuvers: [{ s, angle, kind }] } */
export function buildRoute(points) {
  const path = new Path(points);
  return { path, maneuvers: extractManeuvers(path, path.cum.slice(1, -1)) };
}

/**
 * 꺾는 지점 후보(경로상 거리 s 목록)에서 실제로 안내할 회전만 남긴다.
 *  - 가까이 붙은 반대 방향 꺾임 한 쌍(살짝 비켰다 돌아오는 길)은 상쇄해 없애고
 *  - 가까이 붙은 같은 방향 꺾임은 하나로 합친다.
 */
export function extractManeuvers(path, candidateS) {
  let raw = candidateS
    .slice()
    .sort((a, b) => a - b)
    .map((s) => ({ s, angle: path.turnAngleAt(s, 1.2) }))
    .filter((m) => Math.abs(m.angle) >= 15);

  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      if (b && b.s - a.s <= MERGE_DIST) {
        const sum = a.angle + b.angle;
        if (Math.abs(sum) >= MIN_ANGLE) {
          out.push({ s: a.s, angle: Math.max(-180, Math.min(180, sum)) });
        }
        i++; // b는 a와 합쳐졌거나 상쇄됐다
        changed = true;
      } else {
        out.push(a);
      }
    }
    raw = out;
  }

  return raw
    .filter((m) => Math.abs(m.angle) >= MIN_ANGLE)
    .map((m) => ({ s: m.s, angle: m.angle, kind: classifyTurn(m.angle) }));
}

/** 꺾는 각도(오른쪽 +)를 안내 종류로 */
export function classifyTurn(angle) {
  const a = Math.abs(angle);
  const side = angle < 0 ? 'Left' : 'Right';
  if (a >= 160) return 'uturn';
  if (a >= 120) return 'sharp' + side;
  if (a >= 55) return side.toLowerCase();
  return 'slight' + side;
}
