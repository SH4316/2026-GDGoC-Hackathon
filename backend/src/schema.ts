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
export const sessionSchema = z.object({
  startedAtMs: positive,
  station: z.object({
    tagSideM: positive,
    tags: z.array(z.object({ id: tagId, center: xy, yawDeg: num })).min(1).max(587),
    route: z.array(xy).min(2).max(4096),
    camera: z.object({ diagonalFovDeg: positive.optional(), calibration: calibration.nullish() }),
  }),
});
export const frameSchema = z.object({
  capturedAtMs: positive, mediaTimeS: num.nonnegative(),
  width: pixels.max(960), height: pixels.max(960),
  intrinsics: z.tuple([positive, positive, num, num]),
  pose: z.object({
    cameraToWorld: z.array(num).length(16).refine(isRigidTransform),
    tagIds: z.array(tagId).nonempty().max(587),
    reprojectionPx: num.nonnegative().max(2.5),
  }).nullable(),
});
export const finishSchema = z.object({ frameCount: z.int().min(0).max(1000000) });
export type Session = z.infer<typeof sessionSchema>;
export type Frame = z.infer<typeof frameSchema>;
