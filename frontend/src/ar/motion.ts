export type Vector = [number, number, number];
export type MotionSample = { timeMs: number; acceleration: Vector | null; accelerationIncludingGravity: Vector | null;
  rotationRate: Vector | null; screenAngleDeg: number | null };
export type MotionAccess = 'granted' | 'denied' | 'implicit' | 'unavailable';

const motionSensor = () => window.DeviceMotionEvent as
  (typeof DeviceMotionEvent & { requestPermission?: () => Promise<string> }) | undefined;
let granted = false;

export function motionAccess(): MotionAccess | 'prompt' {
  const sensor = motionSensor();
  if (!sensor) return 'unavailable';
  if (!sensor.requestPermission) return 'implicit';
  return granted ? 'granted' : 'prompt';
}

export async function requestMotionAccess(): Promise<MotionAccess> {
  const sensor = motionSensor();
  if (!sensor) return 'unavailable';
  if (!sensor.requestPermission) return 'implicit';
  if (granted) return 'granted';
  try { granted = await sensor.requestPermission() === 'granted'; }
  catch { granted = false; }
  return granted ? 'granted' : 'denied';
}

export const screenAngle = () => screen.orientation?.angle ?? (typeof window.orientation === 'number' ? window.orientation : null);

function vector(x?: number | null, y?: number | null, z?: number | null): Vector | null {
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number'
    && [x,y,z].every(Number.isFinite) ? [x,y,z] : null;
}

export function readMotion(event: DeviceMotionEvent): MotionSample {
  const a = event.acceleration, g = event.accelerationIncludingGravity, r = event.rotationRate;
  return { timeMs: event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp,
    acceleration: vector(a?.x, a?.y, a?.z), accelerationIncludingGravity: vector(g?.x, g?.y, g?.z),
    rotationRate: vector(r?.alpha, r?.beta, r?.gamma), screenAngleDeg: screenAngle() };
}
