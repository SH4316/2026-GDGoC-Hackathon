import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import type { MotionSample } from './motion';
import type { Fix } from './recording';
import type { Point } from './station';

export type MinimapPose = { spaceId: string; point: Point; headingDeg: number | null; source: 'tag' | 'motion' | 'last' };
export type CameraPose = Pick<Fix, 'position' | 'cameraToWorld'>;
type Step = { periodMs: number; sensorSign: number };
type BufferedMotion = MotionSample & { velocity?: Vector2; step?: Step };
type ForeAftSample = { timeMs: number; acceleration: number };

const radians = Math.PI / 180;
const maxSampleGapMs = 350;
const maxWalkingSpeed = 3.5; // m/s
// A visual observation renews this short bridge. Fresh IMU samples alone cannot.
const maxBlindMs = 1000;
const maxBlindDistanceM = .75;
const maxStepPeriodMs = 1050;
const defaultStepLengthM = .60;

function phaseMean(samples: ForeAftSample[], from: number, to: number) {
  let sum = 0, covered = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i-1], b = samples[i];
    const span = b.timeMs - a.timeMs;
    if (span <= 0 || span > 100) continue;
    const start = Math.max(from, a.timeMs), end = Math.min(to, b.timeMs);
    if (end <= start) continue;
    const fraction = ((start + end) / 2 - a.timeMs) / span;
    sum += (a.acceleration + fraction * (b.acceleration - a.acceleration)) * (end - start);
    covered += end - start;
  }
  return covered >= .7 * (to - from) ? sum / covered : undefined;
}

// Detect repeated vertical trough/crest cycles independently of how the phone is tilted.
class WalkingCadence {
  private lastAt = -Infinity;
  private filtered = 0;
  private trough = false;
  private peakAt = -Infinity;
  private period = Infinity;
  private up = new Vector3();
  private cycle: ForeAftSample[] = [];
  private previousVote = 0;
  private confirmedSign = 0;
  private confirmedAt = -Infinity;

  sample({ timeMs, acceleration, accelerationIncludingGravity: total }: MotionSample) {
    if (!total) return;
    const gravity = new Vector3(...total);
    const linear = acceleration && new Vector3(...acceleration);
    if (linear) gravity.sub(linear);
    const norm = gravity.length();
    if (norm < 6 || norm > 14) return;
    gravity.divideScalar(norm);
    const vertical = linear ? linear.dot(gravity) : norm - 9.81;
    // Project the rear lens axis onto the plane perpendicular to gravity.
    // Its direction is the same for either accelerometer polarity.
    const dt = timeMs - this.lastAt;
    // Average the gravity direction over sensor jitter without filtering away
    // the within-step horizontal acceleration pattern.
    this.up.lerp(gravity, 1 - Math.exp(-dt / (linear ? 120 : 500))).normalize();
    const horizontalLens = Math.hypot(this.up.x, this.up.y);
    const measured = linear ?? new Vector3(...total);
    const foreAft = horizontalLens > .15
      ? { timeMs, acceleration: (-measured.z + this.up.z * measured.dot(this.up)) / horizontalLens } : undefined;
    this.lastAt = timeMs;
    if (dt > maxSampleGapMs) {
      this.filtered = vertical;
      this.trough = false;
      this.peakAt = -Infinity;
      this.period = Infinity;
      this.cycle = [];
      this.previousVote = this.confirmedSign = 0;
      this.confirmedAt = -Infinity;
      return;
    }
    if (foreAft && timeMs - this.peakAt <= maxStepPeriodMs) this.cycle.push(foreAft);
    this.filtered += (vertical - this.filtered) * (1 - Math.exp(-dt / 65));
    if (this.filtered < -.35) this.trough = true;
    const interval = timeMs - this.peakAt;
    if (!this.trough || this.filtered < .55) return;
    this.trough = false;
    const valid = interval >= 320 && interval <= maxStepPeriodMs;
    const consistent = valid && this.period >= 320 && this.period <= maxStepPeriodMs &&
      interval / this.period > .55 && interval / this.period < 1.8;
    const start = this.peakAt;
    this.peakAt = timeMs;
    this.period = interval;
    const samples = this.cycle;
    this.cycle = foreAft ? [foreAft] : [];
    if (!valid) {
      this.previousVote = this.confirmedSign = 0;
      return;
    }
    // Braking early and pushing off late have opposite fore/aft signs when backing up.
    const mid = start + .5 * interval;
    const early = phaseMean(samples, start + .125 * interval, mid);
    const late = phaseMean(samples, mid, start + .875 * interval);
    const contrast = early !== undefined && late !== undefined ? late - early : 0;
    const vote = Math.abs(contrast) >= .22 ? Math.sign(contrast) : 0;
    const reaffirms = vote === this.confirmedSign && timeMs - this.confirmedAt <= 2 * maxStepPeriodMs;
    if (vote && consistent && (vote === this.previousVote || reaffirms)) {
      this.confirmedSign = vote;
      this.confirmedAt = timeMs;
    }
    this.previousVote = vote;
    if (consistent && this.confirmedSign && timeMs - this.confirmedAt <= 2 * maxStepPeriodMs &&
        (!vote || vote === this.confirmedSign)) return { periodMs: interval, sensorSign: this.confirmedSign };
  }
}

function heading(forwardX: number, forwardY: number) {
  return Math.hypot(forwardX, forwardY) > 0.1 ? Math.atan2(forwardX, forwardY) / radians : null;
}

function walkingDirection(point: Vector2, forward: Vector3, route: Point[]) {
  const bearing = new Vector2(forward.x, forward.y).normalize();
  let direction = bearing, nearest = 1; // Keep the measured lateral offset within a mapped corridor.
  for (let i = 1; i < route.length; i++) {
    const a = new Vector2(...route[i-1]), tangent = new Vector2(...route[i]).sub(a);
    const length = tangent.length();
    if (!length) continue;
    tangent.divideScalar(length);
    const alignment = bearing.dot(tangent);
    if (Math.abs(alignment) < Math.cos(20 * radians)) continue;
    const along = point.clone().sub(a).dot(tangent);
    if (along < 0 || along > length) continue;
    const distance = a.addScaledVector(tangent, along).distanceTo(point);
    if (distance < nearest) { nearest = distance; direction = tangent.multiplyScalar(Math.sign(alignment)); }
  }
  return direction;
}

// All integration is in the station's horizontal XY plane, in metres.
export class IndoorTracking {
  private tag?: MinimapPose;
  private estimate?: MinimapPose;
  private position = new Vector2();
  private visualPosition = new Vector2();
  private velocity = new Vector2();
  private deviceToWorld = new Quaternion();
  private velocityReference?: { point: Vector2; timeMs: number };
  private correctedVelocity = new Vector2();
  private fixAt = -Infinity;
  private integratedAt = -Infinity;
  private sensorAt = -Infinity;
  private stillSeconds = 0;
  private accelerationSign = 1;
  private rawBias = new Vector2();
  private pending: BufferedMotion[] = [];
  private cadence = new WalkingCadence();
  private stepPosition = new Vector2();
  private stepAt = -Infinity;
  private stridesSinceFix = 0;
  private stepLengthM = defaultStepLengthM;
  private route: Point[] = [];

  get spaceId() { return this.tag?.spaceId; }

  suspend() {
    this.pending = [];
    this.cadence = new WalkingCadence();
    this.fixAt = this.integratedAt = this.sensorAt = this.stepAt = -Infinity;
  }

  private hasRecentMotion(timeMs: number) {
    return !!this.estimate && Math.abs(timeMs - this.integratedAt) <= maxSampleGapMs &&
      Math.abs(timeMs - this.sensorAt) <= maxSampleGapMs;
  }

  floorAnchor(timeMs: number) {
    if (!this.tag || timeMs - this.fixAt > maxBlindMs || !this.hasRecentMotion(timeMs)) return;
    return { spaceId: this.tag.spaceId, timeMs: this.fixAt };
  }

  correct(spaceId: string, fix: CameraPose & { referenceTimeMs?: number }, timeMs: number, angleDeg: number,
          source: 'tag' | 'floor' = 'tag', route?: Point[]) {
    if (timeMs <= this.fixAt) return;
    if (source === 'floor' && (fix.referenceTimeMs !== this.fixAt || timeMs - this.fixAt > maxBlindMs ||
        spaceId !== this.spaceId || !this.hasRecentMotion(timeMs))) return;
    const point: Point = [fix.position[0], fix.position[1]];
    const m = fix.cameraToWorld;
    if (source === 'tag') {
      this.route = route ?? [];
      if (spaceId !== this.spaceId) this.stepLengthM = defaultStepLengthM;
      else if (this.stridesSinceFix >= 8 && this.stepAt <= timeMs && timeMs - this.stepAt < maxStepPeriodMs) {
        // Learn only after a mostly straight walk independently confirmed by the next tag.
        const walked = this.stepPosition.clone().sub(this.visualPosition);
        const observed = new Vector2(...point).sub(this.visualPosition);
        const stride = observed.length() / this.stridesSinceFix;
        if (walked.length() > .9 * this.stridesSinceFix * this.stepLengthM && stride >= .4 && stride <= .85 &&
            walked.normalize().dot(observed.normalize()) > .94) this.stepLengthM += .25 * (stride - this.stepLengthM);
      }
    }
    const reference = this.velocityReference;
    if (spaceId !== this.spaceId || this.estimate?.source === 'last' || timeMs - this.fixAt > 750 || !reference) {
      this.velocity.set(0, 0);
      this.velocityReference = { point: new Vector2(...point), timeMs };
      this.rawBias.set(0, 0);
    } else {
      // Restore velocity at exposure before replaying newer samples. Position
      // fixes too close together for a visual velocity still retain IMU motion.
      const prior = this.pending.findLast(sample => sample.timeMs <= timeMs && sample.velocity);
      this.velocity.copy(prior?.velocity ?? this.correctedVelocity);
      if (timeMs - reference.timeMs >= 250) {
        const seconds = (timeMs - reference.timeMs) / 1000;
        const measured = new Vector2(...point).sub(reference.point).divideScalar(seconds);
        this.velocity.lerp(measured.clampLength(0, maxWalkingSpeed), 0.6);
        this.velocityReference = { point: new Vector2(...point), timeMs };
      }
    }
    this.position.set(...point);
    this.visualPosition.copy(this.position);
    this.stepPosition.copy(this.position);
    this.stepAt = -Infinity;
    this.stridesSinceFix = 0;
    this.correctedVelocity.copy(this.velocity);
    // OpenCV image axes are right/down/forward. Motion axes are fixed to the
    // natural display (right/up/out), even when the camera image is in landscape.
    const basis = new Matrix4().fromArray(m).transpose()
      .multiply(new Matrix4().makeRotationX(Math.PI))
      .multiply(new Matrix4().makeRotationZ(angleDeg * radians));
    this.deviceToWorld.setFromRotationMatrix(basis).normalize();
    const headingDeg = heading(m[2], m[6]);
    if (source === 'tag') this.tag = { spaceId, point, headingDeg, source: 'tag' };
    this.estimate = source === 'floor' ? { spaceId, point, headingDeg, source: 'motion' } : undefined;
    this.fixAt = this.integratedAt = timeMs;
    this.stillSeconds = 0;
    // A worker fix belongs to the captured frame. Reapply only later IMU samples.
    this.pending = this.pending.filter(sample => sample.timeMs > timeMs);
    for (const sample of this.pending) this.integrate(sample);
    return true;
  }

  motion(sample: MotionSample) {
    if (!Number.isFinite(sample.timeMs) || sample.timeMs <= this.fixAt ||
        sample.timeMs <= (this.pending.at(-1)?.timeMs ?? -Infinity)) return;
    if (sample.acceleration || sample.accelerationIncludingGravity) this.sensorAt = sample.timeMs;
    // Keep the detected step with the sample: a delayed camera result may replay it.
    const reading = { ...sample, step: this.cadence.sample(sample) };
    this.pending.push(reading);
    while (this.pending[0].timeMs < sample.timeMs - maxSampleGapMs) this.pending.shift();
    return this.integrate(reading);
  }

  private integrate(sample: BufferedMotion) {
    const { timeMs, acceleration, accelerationIncludingGravity: total, rotationRate } = sample;
    const elapsedMs = timeMs - this.integratedAt;
    const reading = acceleration ?? total;
    if (!this.tag || !reading || elapsedMs <= 0 || elapsedMs > maxSampleGapMs) return;
    const bridgeDt = Math.max(0, Math.min(timeMs, this.fixAt + maxBlindMs) - this.integratedAt) / 1000;
    this.integratedAt = timeMs;

    if (rotationRate) {
      // DeviceMotion rotationRate exposes the three body-axis rates in degrees/s.
      const axis = new Vector3(...rotationRate);
      const angle = axis.length() * radians * elapsedMs / 1000;
      if (angle) this.deviceToWorld.multiply(new Quaternion().setFromAxisAngle(axis.normalize(), angle)).normalize();
    }
    const forward = new Vector3(0, 0, -1).applyQuaternion(this.deviceToWorld);
    const headingDeg = heading(forward.x, forward.y);
    if (total) {
      // Resolve sensor polarity from the tag's world vertical, also during long walks.
      const gravity = new Vector3(...total);
      if (acceleration) gravity.sub(new Vector3(...acceleration));
      gravity.applyQuaternion(this.deviceToWorld);
      if (Math.abs(gravity.z) > 6) this.accelerationSign = Math.sign(gravity.z);
    }
    const step = sample.step;
    if (step && Math.hypot(forward.x, forward.y) > .25) {
      const direction = walkingDirection(this.stepPosition, forward, this.route).multiplyScalar(step.sensorSign * this.accelerationSign);
      // Count only the portion of a stride after the last visual anchor.
      const fraction = Math.min(1, (timeMs - this.fixAt) / step.periodMs);
      this.stridesSinceFix += fraction;
      this.stepPosition.addScaledVector(direction, this.stepLengthM * fraction);
      this.position.copy(this.stepPosition);
      this.velocity.copy(direction).multiplyScalar(this.stepLengthM * 1000 / step.periodMs);
      this.stepAt = timeMs;
    }
    if (this.stepAt > this.fixAt) {
      if (timeMs - this.stepAt > maxStepPeriodMs) {
        this.velocity.set(0, 0);
        return;
      }
      sample.velocity = this.velocity.clone();
      this.estimate = { spaceId: this.tag.spaceId, point: [this.position.x, this.position.y], headingDeg, source: 'motion' };
      return this.estimate;
    }
    if (this.estimate?.source === 'last' || bridgeDt <= 0) return;
    const dt = bridgeDt;
    const world = new Vector3(...reading).applyQuaternion(this.deviceToWorld);
    const horizontal = new Vector2(world.x, world.y).multiplyScalar(this.accelerationSign);
    if (!acceleration) {
      // Gravity is vertical in map coordinates. Remove slow horizontal leakage
      // from pose/tilt error on devices that only supply gravity-inclusive samples.
      this.rawBias.lerp(horizontal, 1 - Math.exp(-dt));
      horizontal.sub(this.rawBias);
    }
    if (horizontal.length() < 0.18) {
      horizontal.set(0, 0);
      this.stillSeconds += dt;
      if (this.stillSeconds >= 0.45) this.velocity.set(0, 0);
    } else this.stillSeconds = 0;

    this.position.addScaledVector(this.velocity, dt / 2);
    this.velocity.addScaledVector(horizontal, dt).clampLength(0, maxWalkingSpeed);
    this.position.addScaledVector(this.velocity, dt / 2);
    const offset = this.position.clone().sub(this.visualPosition);
    if (offset.lengthSq() >= maxBlindDistanceM ** 2 || timeMs >= this.fixAt + maxBlindMs) {
      this.position.copy(this.visualPosition).add(offset.clampLength(0, maxBlindDistanceM));
      this.velocity.set(0, 0);
      this.estimate = { spaceId: this.tag.spaceId, point: [this.position.x, this.position.y], headingDeg: null, source: 'last' };
      return;
    }
    sample.velocity = this.velocity.clone();
    this.estimate = { spaceId: this.tag.spaceId, point: [this.position.x, this.position.y],
      headingDeg, source: 'motion' };
    return this.estimate;
  }

  pose(now: number, tagVisible: boolean): MinimapPose | undefined {
    if (!this.tag || tagVisible) return this.tag;
    const supported = now - this.fixAt < maxBlindMs || now - this.stepAt <= maxStepPeriodMs;
    if (this.estimate && supported && this.hasRecentMotion(now)) return this.estimate;
    return { ...(this.estimate ?? this.tag), source: 'last', headingDeg: null };
  }
}
