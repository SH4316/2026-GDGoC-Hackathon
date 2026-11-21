// 걸음 감지. 걸을 때 폰이 위아래로 흔들리며 생기는 가속도 변화를 센다.

const DOWN = 0.2; // 이 아래로 내려와야 다음 걸음을 셀 수 있다
const MIN_INTERVAL = 300; // 걸음 사이 최소 간격 (ms)
const MAX_INTERVAL = 1300; // 이보다 벌어지면 걷기를 멈춘 것으로 본다

export class StepDetector {
  /**
   * onStep(count): 걸음이 확정될 때마다 호출. count는 한 번에 확정된 걸음 수
   * threshold: 이 값을 넘는 흔들림을 걸음의 정점으로 본다 (m/s²). 걸음이 안 세어지면 낮춘다.
   */
  constructor(onStep, threshold = 0.9) {
    this.onStep = onStep;
    this.threshold = threshold;
    this.baseline = 9.8; // 중력을 포함한 평소 가속도 크기
    this.smooth = 0;
    this.high = false;
    this.lastT = 0;
    this.lastStepT = -Infinity;
    this.pending = false; // 첫 걸음은 다음 걸음이 이어질 때까지 보류한다
    this.total = 0;
  }

  /** 가속도 센서 값을 받기 시작한다 (권한은 requestMotionPermission으로 먼저 받는다) */
  start() {
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (a && a.x != null) this.feed(Math.hypot(a.x, a.y, a.z), performance.now());
    });
  }

  /** 가속도 크기(m/s²)와 시각(ms)을 넣는다 */
  feed(magnitude, t) {
    const dt = this.lastT ? Math.min(0.2, (t - this.lastT) / 1000) : 0.016;
    this.lastT = t;
    // 느린 평균을 빼서 중력을 없애고, 빠른 평균으로 잔떨림을 줄인다
    this.baseline += (magnitude - this.baseline) * (1 - Math.exp(-dt / 1.0));
    this.smooth += (magnitude - this.baseline - this.smooth) * (1 - Math.exp(-dt / 0.08));

    if (!this.high && this.smooth > this.threshold) {
      this.high = true;
      const gap = t - this.lastStepT;
      if (gap < MIN_INTERVAL) return;
      this.lastStepT = t;
      if (gap > MAX_INTERVAL) {
        // 한참 만의 첫 흔들림: 폰을 들어 올린 것일 수도 있으니 일단 보류
        this.pending = true;
      } else if (this.pending) {
        this.pending = false;
        this._emit(2); // 보류했던 첫 걸음까지 함께 확정
      } else {
        this._emit(1);
      }
    } else if (this.high && this.smooth < DOWN) {
      this.high = false;
    }
  }

  _emit(n) {
    this.total += n;
    this.onStep(n);
  }
}
