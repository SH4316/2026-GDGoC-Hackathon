// 경로 진행 상황 추적: 지금 경로의 어디쯤인지, 다음에 무엇을 해야 하는지.
// 언어와 무관한 상태만 계산하고, 문장은 i18n.js가 만든다.

const SOON_DIST = 10; // 이 거리부터 "곧 꺾어요" (m)
const NOW_DIST = 3.5; // 이 거리부터 "여기서 꺾어요"
const PASSED_DIST = 1.5; // 꺾는 지점을 이만큼 지나면 다음 안내로 넘어간다
const ARRIVE_DIST = 2; // 경로 끝까지 이만큼 남으면 도착
const FAR_SPEECH_DIST = 14; // 이보다 멀 때만 "몇 미터 직진 후"를 말한다

export class Guide {
  constructor(route) {
    this.path = route.path;
    this.maneuvers = route.maneuvers;
    this.s = 0;
    this.spoken = new Set();
    this.arrived = false;
  }

  /** 새 위치 { x, y }를 반영한다 */
  update(pos) {
    const path = this.path;

    // 직전 위치 근처에서 먼저 찾는다. 경로가 가까이 겹칠 때 엉뚱한 구간으로 튀지 않게.
    let pr = path.project(pos, this.s - 4, this.s + 8);
    if (pr.dist > 3) {
      const all = path.project(pos);
      if (all.dist < pr.dist - 1) pr = all;
    }
    this.s = pr.s;

    const remaining = path.length - pr.s;
    if (remaining <= ARRIVE_DIST) this.arrived = true;

    // 다음 안내 지점
    let idx = this.maneuvers.findIndex((m) => pr.s < m.s + PASSED_DIST);
    let kind;
    let dist;
    if (idx === -1) {
      idx = this.maneuvers.length;
      kind = 'arrive';
      dist = remaining;
    } else {
      kind = this.maneuvers[idx].kind;
      dist = Math.max(0, this.maneuvers[idx].s - pr.s);
    }
    const stage = dist <= NOW_DIST ? 'now' : dist <= SOON_DIST ? 'soon' : 'far';

    // 음성 안내는 지점마다 단계별로 한 번씩만
    const speak = [];
    const key = `${idx}:${stage}`;
    if (!this.spoken.has(key) && !this.arrived) {
      this.spoken.add(key);
      if (stage === 'far') {
        if (dist > FAR_SPEECH_DIST) speak.push({ stage, kind, dist });
      } else if (stage === 'soon' || kind !== 'arrive') {
        speak.push({ stage, kind, dist });
      }
      // 이미 가까운 단계에 들어섰으면 먼 단계 안내는 건너뛴다
      if (stage === 'now') this.spoken.add(`${idx}:soon`);
      if (stage !== 'far') this.spoken.add(`${idx}:far`);
    }

    return {
      s: pr.s,
      snapped: { x: pr.x, y: pr.y },
      lateral: pr.dist,
      remaining,
      ins: { stage, kind, dist, idx },
      speak,
      arrived: this.arrived,
    };
  }
}
