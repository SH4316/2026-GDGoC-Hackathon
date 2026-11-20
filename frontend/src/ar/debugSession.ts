import type { MinimapPose } from './indoorTracking';
import type { MotionAccess, MotionSample, Vector } from './motion';
import type { Point } from './station';

type Position = { timeMs: number; source: 'tag' | 'motion' | 'floor'; spaceId: string; point: Point | Vector };
type Row = { timeMs: number; motion?: MotionSample; position?: Position };
type Columns = (number | string | null)[];
export type DebugBatch = { id: string; seq: number; startedAtMs: number; rows: Columns[] };
const csvHeader = 'elapsed_ms,ax_m_s2,ay_m_s2,az_m_s2,ax_with_gravity_m_s2,ay_with_gravity_m_s2,az_with_gravity_m_s2,space_id,position_source,x_m,y_m,z_m';

export class DebugSession {
  readonly id = crypto.randomUUID();
  readonly startMs = performance.now();
  readonly startedAt = new Date(performance.timeOrigin + this.startMs);
  access: MotionAccess | 'prompt' = 'prompt';
  lastMotion?: MotionSample;
  lastPosition?: Position;
  motionCount = 0;
  positionCount = 0;
  private rows: Row[] = [];
  private queued = 0;

  get rowCount() { return this.rows.length; }

  private position(timeMs: number, source: Position['source'], spaceId: string, point: Position['point']) {
    const position = { timeMs, source, spaceId, point };
    // A tag fix can arrive after an IMU sample from a later instant.
    if (!this.lastPosition || timeMs >= this.lastPosition.timeMs) this.lastPosition = position;
    this.positionCount++;
    return position;
  }

  motion(sample: MotionSample, estimate?: MinimapPose) {
    if (sample.timeMs < this.startMs || !(sample.acceleration || sample.accelerationIncludingGravity)) return;
    this.lastMotion = sample;
    this.motionCount++;
    const position = estimate?.source === 'motion'
      ? this.position(sample.timeMs, 'motion', estimate.spaceId, estimate.point) : undefined;
    this.rows.push({ timeMs: sample.timeMs, motion: sample, position });
  }

  visual(timeMs: number, source: 'tag' | 'floor', spaceId: string, point: Vector) {
    if (timeMs < this.startMs) return;
    this.rows.push({ timeMs, position: this.position(timeMs, source, spaceId, point) });
  }

  private columns({ timeMs, motion, position }: Row): Columns {
    return [
      (timeMs - this.startMs).toFixed(3),
      ...(motion?.acceleration ?? [null, null, null]), ...(motion?.accelerationIncludingGravity ?? [null, null, null]),
      position?.spaceId ?? null, position?.source ?? null, position?.point[0] ?? null, position?.point[1] ?? null, position?.point[2] ?? null,
    ];
  }

  queueNewRows(enqueue: (batch: DebugBatch) => void) {
    while (this.queued < this.rows.length) {
      const rows = this.rows.slice(this.queued, this.queued + 256).map(row => this.columns(row));
      enqueue({ id: this.id, seq: this.queued, startedAtMs: this.startedAt.getTime(), rows });
      this.queued += rows.length;
    }
  }

  csv() {
    const lines = this.rows.slice().sort((a, b) => a.timeMs - b.timeMs).map(row => this.columns(row).join(','));
    return new Blob([[csvHeader, ...lines].join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
  }
}
