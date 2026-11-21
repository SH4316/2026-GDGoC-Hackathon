import { Matrix4, Quaternion, Vector2, Vector3 } from 'three';
import type { MotionSample } from './motion';
import type { Fix } from './recording';
import type { Point } from './station';

export type MinimapPose = { spaceId: string; point: Point; headingDeg: number | null; source: 'tag' | 'motion' | 'last' };
export type CameraPose = Pick<Fix, 'position' | 'cameraToWorld'>;
type Step = { periodMs: number; sensorSign: number };
type BufferedMotion = MotionSample & { velocity?: Vector2; step?: Step; gravity?: Vector3;
  camera?: { attitude: Quaternion; point: Point; positionTracked: boolean; vertical?: Vector3 } };
type ForeAftSample = { timeMs: number; acceleration: number };

const radians = Math.PI / 180;
const worldUp = new Vector3(0, 0, 1);
const maxSampleGapMs = 350;
const maxGravityAgeMs = 100;
const motionHistoryMs = 2000; // Replay sensor events received while a camera result was being computed.
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

function levelGuideCamera(camera: Matrix4, up: [number, number, number]) {
  // Preserve the surveyed azimuth while setting the camera's pitch and roll from gravity.
  const vertical = new Vector3(...up);
  const reference = new Vector3(0, 0, 1);
  const lens = new Vector3().setFromMatrixColumn(camera, 2);
  if (Math.abs(vertical.z) > .95 || Math.abs(lens.z) > .95) {
    // A near-vertical lens has no stable azimuth. Use a horizontal image axis instead.
    const rightTilt = Math.max(Math.abs(vertical.x), Math.abs(camera.elements[2]));
    const downTilt = Math.max(Math.abs(vertical.y), Math.abs(camera.elements[6]));
    reference.set(rightTilt <= downTilt ? 1 : 0, rightTilt <= downTilt ? 0 : 1, 0);
  }
  const worldReference = reference.clone().transformDirection(camera).setZ(0);
  const imageReference = reference.clone().addScaledVector(vertical, -reference.dot(vertical));
  if (worldReference.lengthSq() < .01 || imageReference.lengthSq() < .01) return;
  worldReference.normalize(); imageReference.normalize();
  const worldBasis = new Matrix4().makeBasis(worldReference, worldUp.clone().cross(worldReference), worldUp);
  const imageBasis = new Matrix4().makeBasis(imageReference, vertical.clone().cross(imageReference), vertical);
  camera.multiplyMatrices(worldBasis, imageBasis.transpose());
}

function cameraUp(deviceUp: Vector3, screenAngleDeg: number): [number, number, number] {
  const v = deviceUp.applyAxisAngle(worldUp, screenAngleDeg * radians);
  return [v.x, -v.y, -v.z];
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
  private attitudeAt = -Infinity;
  private gravitySign?: number;
  private gyroVertical?: Vector3;
  private gravityReadings: { timeMs: number; direction: Vector3 }[] = [];
  private guidePosition = new Vector3();
  private corridorYawDeg = 0;
  private headingAt = -Infinity;
  private velocityReference?: { point: Vector2; timeMs: number };
  private correctedVelocity = new Vector2();
  private visualAt = -Infinity;
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
    this.attitudeAt = this.visualAt = this.fixAt = this.integratedAt = this.sensorAt = this.stepAt = -Infinity;
    this.corridorYawDeg = 0;
    this.gravitySign = undefined;
    this.gyroVertical = undefined;
    this.gravityReadings = [];
    this.headingAt = -Infinity;
  }

  private hasRecentMotion(timeMs: number) {
    return !!this.estimate && Math.abs(timeMs - this.integratedAt) <= maxSampleGapMs &&
      Math.abs(timeMs - this.sensorAt) <= maxSampleGapMs;
  }

  floorAnchor(timeMs: number) {
    if (!this.tag || timeMs < this.visualAt || timeMs - this.visualAt > maxBlindMs) return;
    return { spaceId: this.tag.spaceId, timeMs: this.visualAt };
  }

  walkingObservation(timeMs: number) {
    if (!this.tag || !this.hasRecentMotion(timeMs) || this.stepAt <= this.fixAt ||
        timeMs - this.stepAt > maxStepPeriodMs || this.stridesSinceFix * this.stepLengthM > 10) return;
    const headingDeg = heading(this.velocity.x, this.velocity.y);
    if (headingDeg !== null) return { spaceId: this.tag.spaceId, point: this.position.toArray(), headingDeg };
  }

  corridorCamera(timeMs: number, screenAngleDeg: number) {
    // Pair the image with a raw gyro attitude at exposure, before the next motion update.
    const reading = this.pending.findLast(sample => sample.timeMs <= timeMs);
    if (!this.tag || !reading?.camera?.positionTracked || timeMs - reading.timeMs > 60) return;
    const { attitude, point } = reading.camera;
    const forward = new Vector3(0, 0, -1).applyQuaternion(attitude);
    const headingDeg = heading(forward.x, forward.y);
    if (headingDeg === null) return;
    // Undo the display rotation and device-to-OpenCV axis change used by correct().
    const up = worldUp.clone().applyQuaternion(attitude.clone().conjugate())
      .applyAxisAngle(worldUp, screenAngleDeg * radians);
    return { spaceId: this.tag.spaceId, point, headingDeg, up: [up.x, -up.y, -up.z] };
  }

  private gyroCameraAt(timeMs: number) {
    const reading = this.pending.findLast(sample => sample.timeMs <= timeMs && sample.camera);
    if (reading && timeMs - reading.timeMs <= maxSampleGapMs) return reading.camera;
  }

  private gravityAt(timeMs: number) {
    const reading = this.gravityReadings.findLast(sample => sample.timeMs <= timeMs);
    if (reading && timeMs - reading.timeMs <= maxGravityAgeMs) return reading.direction;
  }

  private calibrateGravitySign(timeMs: number) {
    if (this.gravitySign || timeMs - this.visualAt > maxSampleGapMs) return;
    const agreement = this.gravityAt(timeMs)?.clone().applyQuaternion(this.deviceToWorld).z;
    if (agreement !== undefined && Math.abs(agreement) >= .85) this.gravitySign = Math.sign(agreement);
  }

  floorUp(timeMs: number, screenAngleDeg: number): [number, number, number] | undefined {
    const gravity = this.gravityAt(timeMs);
    if (!gravity || !this.gravitySign) return;
    return cameraUp(gravity.clone().multiplyScalar(this.gravitySign), screenAngleDeg);
  }

  viewUp(timeMs: number, screenAngleDeg: number) {
    const measured = this.floorUp(timeMs, screenAngleDeg);
    if (measured) return measured;
    const sample = this.gyroCameraAt(timeMs);
    if (sample) return cameraUp((sample.vertical ?? worldUp).clone().applyQuaternion(sample.attitude.clone().conjugate()), screenAngleDeg);
  }

  guideCamera(timeMs: number, screenAngleDeg: number) {
    const sample = this.gyroCameraAt(timeMs);
    if (!this.tag || !sample) return;
    const { attitude, point } = sample;
    // Undo the display and lens-axis conversions used when the visual pose anchored the gyro.
    const camera = new Matrix4().makeRotationZ(-this.corridorYawDeg * radians)
      .multiply(new Matrix4().makeRotationFromQuaternion(attitude))
      .multiply(new Matrix4().makeRotationZ(-screenAngleDeg * radians))
      .multiply(new Matrix4().makeRotationX(Math.PI));
    const up = this.floorUp(timeMs, screenAngleDeg) ?? (sample.vertical &&
      cameraUp(sample.vertical.clone().applyQuaternion(attitude.clone().conjugate()), screenAngleDeg));
    if (up) levelGuideCamera(camera, up);
    camera.setPosition(point[0], point[1], this.guidePosition.z);
    return { spaceId: this.tag.spaceId, referenceTimeMs: this.visualAt, cameraToWorld: camera.transpose().toArray() };
  }

  correctHeading(spaceId: string, yawDeg: number, frameAt: number) {
    if (spaceId !== this.spaceId || frameAt <= this.headingAt || !Number.isFinite(yawDeg) ||
        this.estimate?.source !== 'motion' || !this.hasRecentMotion(frameAt)) return;
    const previous = this.corridorYawDeg;
    this.corridorYawDeg = yawDeg;
    this.headingAt = frameAt;
    if (this.estimate.headingDeg !== null) {
      const corrected = this.estimate.headingDeg + yawDeg - previous;
      this.estimate = { ...this.estimate, headingDeg: (corrected + 540) % 360 - 180 };
    }
  }

  correct(spaceId: string, fix: CameraPose & { referenceTimeMs?: number }, timeMs: number, angleDeg: number,
          source: 'tag' | 'floor' = 'tag', route?: Point[], corridorYawDeg = 0) {
    if (timeMs <= this.visualAt) return;
    if (source === 'floor' && (fix.referenceTimeMs !== this.visualAt || timeMs - this.visualAt > maxBlindMs ||
        spaceId !== this.spaceId)) return;
    // Each measured floor pose can anchor the next image, including while motion sensors are silent.
    this.visualAt = this.attitudeAt = timeMs;
    const point: Point = [fix.position[0], fix.position[1]];
    const m = fix.cameraToWorld;
    // OpenCV image axes are right/down/forward. Motion axes are fixed to the
    // natural display (right/up/out), even when the camera image is in landscape.
    const basis = new Matrix4().fromArray(m).transpose()
      .multiply(new Matrix4().makeRotationX(Math.PI))
      .multiply(new Matrix4().makeRotationZ(angleDeg * radians));
    this.deviceToWorld.setFromRotationMatrix(basis).normalize();
    this.calibrateGravitySign(timeMs);
    const gravity = this.gravityAt(timeMs);
    this.gyroVertical = gravity && this.gravitySign
      ? gravity.clone().multiplyScalar(this.gravitySign).applyQuaternion(this.deviceToWorld) : undefined;
    this.guidePosition.set(...fix.position);
    this.corridorYawDeg = corridorYawDeg;
    this.headingAt = timeMs;
    if (source === 'floor' && Math.abs(timeMs - this.sensorAt) > maxSampleGapMs) {
      this.replayAfter(timeMs);
      return false;
    }
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
    const rawHeading = heading(m[2], m[6]);
    const headingDeg = rawHeading === null ? null : (rawHeading + corridorYawDeg + 540) % 360 - 180;
    if (source === 'tag') this.tag = { spaceId, point, headingDeg, source: 'tag' };
    this.estimate = source === 'floor' ? { spaceId, point, headingDeg, source: 'motion' } : undefined;
    this.fixAt = this.integratedAt = timeMs;
    this.stillSeconds = 0;
    this.replayAfter(timeMs);
    return true;
  }

  private replayAfter(timeMs: number) {
    this.pending = this.pending.filter(sample => sample.timeMs > timeMs);
    for (const sample of this.pending) this.trackMotion(sample);
  }

  motion(sample: MotionSample) {
    if (!Number.isFinite(sample.timeMs) || sample.timeMs <= this.visualAt ||
        sample.timeMs <= (this.pending.at(-1)?.timeMs ?? -Infinity)) return;
    if (sample.acceleration || sample.accelerationIncludingGravity) this.sensorAt = sample.timeMs;
    // Keep the detected step with the sample: a delayed camera result may replay it.
    const reading: BufferedMotion = { ...sample, step: this.cadence.sample(sample) };
    this.pending.push(reading);
    while (this.pending[0].timeMs < sample.timeMs - motionHistoryMs) this.pending.shift();
    // Record physical gravity independently of camera replay. Subtract linear acceleration
    // so stepping or braking cannot tilt the guide. Polarity is learned against a visual fix.
    if (sample.accelerationIncludingGravity && sample.acceleration) {
      const gravity = new Vector3(...sample.accelerationIncludingGravity).sub(new Vector3(...sample.acceleration));
      const norm = gravity.length();
      if (norm >= 8 && norm <= 12) {
        reading.gravity = gravity.divideScalar(norm);
        this.gravityReadings.push({ timeMs: sample.timeMs, direction: reading.gravity });
      }
    }
    while (this.gravityReadings.length && this.gravityReadings[0].timeMs < sample.timeMs - motionHistoryMs) this.gravityReadings.shift();
    return this.trackMotion(reading);
  }

  private trackMotion(sample: BufferedMotion) {
    const elapsed = sample.timeMs - this.attitudeAt;
    const rate = sample.rotationRate;
    const hasRotation = !!rate && elapsed > 0 && elapsed <= maxSampleGapMs;
    if (hasRotation) {
      const axis = new Vector3(...rate);
      const angle = axis.length() * radians * elapsed / 1000;
      if (angle) this.deviceToWorld.multiply(new Quaternion().setFromAxisAngle(axis.normalize(), angle)).normalize();
    }
    // After a sensor gap, use the first new rate as the time origin for the next interval.
    if (rate && Number.isFinite(this.visualAt)) this.attitudeAt = sample.timeMs;
    this.calibrateGravitySign(sample.timeMs);
    if (sample.gravity && this.gravitySign && Number.isFinite(this.visualAt)) {
      // Keep the last measured vertical in the gyro's frame so an interruption in
      // gravity samples cannot snap the guide back to a drifted pitch.
      this.gyroVertical = sample.gravity.clone().multiplyScalar(this.gravitySign).applyQuaternion(this.deviceToWorld);
    }
    const estimate = this.integrate(sample);
    const positionTracked = !!estimate && this.stridesSinceFix * this.stepLengthM <= 10;
    if (positionTracked) this.guidePosition.set(estimate.point[0], estimate.point[1], this.guidePosition.z);
    sample.camera = hasRotation ? { attitude: this.deviceToWorld.clone(), point: [this.guidePosition.x, this.guidePosition.y],
      positionTracked, vertical: this.gyroVertical } : undefined;
    return estimate;
  }

  private integrate(sample: BufferedMotion) {
    const { timeMs, acceleration, accelerationIncludingGravity: total } = sample;
    const elapsedMs = timeMs - this.integratedAt;
    const reading = acceleration ?? total;
    if (!this.tag || this.visualAt !== this.fixAt || !reading || elapsedMs <= 0 || elapsedMs > maxSampleGapMs) return;
    const bridgeDt = Math.max(0, Math.min(timeMs, this.fixAt + maxBlindMs) - this.integratedAt) / 1000;
    this.integratedAt = timeMs;

    const forward = new Vector3(0, 0, -1).applyQuaternion(this.deviceToWorld);
    if (this.corridorYawDeg) forward.applyAxisAngle(worldUp, -this.corridorYawDeg * radians);
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
    if (this.corridorYawDeg) world.applyAxisAngle(worldUp, -this.corridorYawDeg * radians);
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
    if (this.estimate?.source === 'motion' && supported && this.hasRecentMotion(now)) return this.estimate;
    const camera = this.gyroCameraAt(now);
    const forward = camera && new Vector3(0, 0, -1).applyQuaternion(camera.attitude);
    const rawHeading = forward ? heading(forward.x, forward.y) : null;
    const headingDeg = rawHeading === null ? null : (rawHeading + this.corridorYawDeg + 540) % 360 - 180;
    return { ...(this.estimate ?? this.tag), source: 'last', headingDeg };
  }
}
