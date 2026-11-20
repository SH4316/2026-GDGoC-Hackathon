import { z } from 'zod';

const num = z.number().finite();
const positive = num.positive();
const xy = z.tuple([num, num]);
const tagId = z.int().min(0).max(586);
const pixels = z.int().min(1).max(16384);

function isRigidTransform(m: number[]) {
  if (m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1) return false;
  const right = [m[0], m[4], m[8]];
  const down = [m[1], m[5], m[9]];
  const forward = [m[2], m[6], m[10]];
  const cross = [right[1] * down[2] - right[2] * down[1],
    right[2] * down[0] - right[0] * down[2], right[0] * down[1] - right[1] * down[0]];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.001;
  return near(Math.hypot(...right), 1) && near(Math.hypot(...down), 1) && near(Math.hypot(...forward), 1) &&
    cross.every((value, index) => near(value, forward[index]));
}

const calibration = z.object({
  width: pixels, height: pixels, fx: positive, fy: positive, cx: num, cy: num,
  distortion: z.array(num).refine(a => [4, 5, 8].includes(a.length)),
});
export const modelFile = z.string().regex(/^[a-f0-9]{64}\.(glb|obj)$/);
const modelReference = z.object({ file: modelFile, name: z.string().trim().min(1).max(255) });
const axis = z.tuple([num, num, num]).refine(v => Math.abs(Math.hypot(...v) - 1) < .0001);
const tagSurface = z.object({ heightM: num, right: axis, up: axis })
  .refine(s => Math.abs(s.right.reduce((sum, v, i) => sum + v * s.up[i], 0)) < .0001,
    '태그의 가로축과 세로축은 직각이어야 합니다.');
const tag = z.object({
  surface: tagSurface.optional(),
  id: tagId, center: xy, yawDeg: num,
  modelSizeM: positive.optional(),
  model: modelReference.optional(),
});
const railStop = z.object({
  line: z.string().min(1).max(80), code: z.string().min(1).max(20), name: z.string().min(1).max(100),
});
export type RailStop = z.infer<typeof railStop>;
const stationLink = railStop.extend({ routeEndpoint: z.enum(['start', 'end']).optional() });
const stationSnapshot = z.object({
  stationLinks: z.array(stationLink)
    .refine(stops => new Set(stops.map(s => JSON.stringify([s.line, s.code]))).size === stops.length,
      '같은 역과 노선을 두 번 연결할 수 없습니다.')
    .refine(stops => ['start', 'end'].every(role => stops.filter(s => s.routeEndpoint === role).length <= 1),
      '출발점과 도착점에는 각각 한 노선만 지정할 수 있습니다.').optional(),
  tagSideM: positive, tags: z.array(tag).max(587), route: z.array(xy).max(4096).refine(points => points.length !== 1, '안내 경로에는 점이 두 개 이상 필요합니다.'),
  camera: z.object({ diagonalFovDeg: positive.optional(), calibration: calibration.nullish() }),
  terrain: z.object({
    name: z.string().trim().min(1).max(100),
    outline: z.array(xy).min(3).max(256).optional(),
    model: modelReference.optional(),
  }).optional(),
});
export const stationSchema = stationSnapshot
  .refine(s => new Set(s.tags.map(t => t.id)).size === s.tags.length, '태그 ID가 중복되었습니다.')
  .refine(s => s.route.slice(1).every(([x,y], i) => Math.hypot(x-s.route[i][0], y-s.route[i][1]) >= 0.05),
    '인접한 경로점은 5 cm 이상 떨어져야 합니다.')
  .refine(s => s.camera.calibration || (s.camera.diagonalFovDeg! > 15 && s.camera.diagonalFovDeg! < 150),
    '보정값 또는 15°와 150° 사이의 대각 화각이 필요합니다.');
export type Station = z.infer<typeof stationSchema>;
export const sessionSchema = z.object({
  startedAtMs: positive,
  capture: z.object({
    mimeType: z.enum(['video/mp4', 'video/webm']),
    mediaTimeAtStartS: num.nonnegative(),
    motionPermission: z.enum(['granted', 'denied', 'unavailable', 'implicit']),
  }).optional(),
  station: stationSnapshot,
});
export const frameSchema = z.object({
  recordingTimeMs: num.nonnegative().optional(),
  capturedAtMs: positive, mediaTimeS: num.nonnegative(),
  width: pixels.max(960), height: pixels.max(960),
  intrinsics: z.tuple([positive, positive, num, num]),
  pose: z.object({
    cameraToWorld: z.array(num).length(16).refine(isRigidTransform),
    tagIds: z.array(tagId).nonempty().max(587),
    reprojectionPx: num.nonnegative().max(2.5),
  }).nullable(),
});
const vector = z.tuple([num, num, num]).nullable();
export const samplesSchema = z.array(z.object({
  tMs: num.nonnegative(), acceleration: vector, accelerationIncludingGravity: vector,
  rotationRate: vector, screenAngleDeg: num.nullable(),
})).max(1024);
const optionalNumber = num.nullable();
const debugRow = z.tuple([
  z.string().regex(/^\d{1,15}\.\d{3}$/),
  optionalNumber, optionalNumber, optionalNumber, optionalNumber, optionalNumber, optionalNumber,
  z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).nullable(), z.enum(['tag', 'floor', 'motion']).nullable(),
  optionalNumber, optionalNumber, optionalNumber,
]).refine(([, ax, ay, az, gx, gy, gz, space, source, x, y, z]) =>
  (ax === null) === (ay === null) && (ay === null) === (az === null) &&
  (gx === null) === (gy === null) && (gy === null) === (gz === null) &&
  (ax !== null || gx !== null || source !== null) &&
  (source === null ? space === null && x === null && y === null && z === null :
    space !== null && x !== null && y !== null && (source === 'motion' ? z === null : z !== null)));
export const debugBatchSchema = z.object({
  startedAtMs: z.int().positive().max(8640000000000000), rows: z.array(debugRow).min(1).max(256),
});
export type DebugBatch = z.infer<typeof debugBatchSchema>;
const count = z.int().min(0).max(1000000);
export const finishSchema = z.object({
  frameCount: count, partCount: count.optional(), end: z.enum(['stopped', 'interrupted']).optional(),
});
export type Finish = z.infer<typeof finishSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Frame = z.infer<typeof frameSchema>;
