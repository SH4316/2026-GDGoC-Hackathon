const width = 64, height = 48, tile = 8;

export type CameraView = { width: number; height: number; pixels: Uint8ClampedArray };

export function createCameraViewSampler(video: HTMLVideoElement) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'medium';
  return (): CameraView => {
    ctx.drawImage(video, 0, 0, width, height);
    return { width: video.videoWidth, height: video.videoHeight, pixels: ctx.getImageData(0, 0, width, height).data };
  };
}

// A local change can remove the only visible tag even when most of the image stays the same.
// Compare tiles at the same screen coordinates, allowing modest noise and exposure changes.
export function compareCameraViews(a: CameraView, b: CameraView): 'changed' | 'flat' | 'matching' {
  if (a.width !== b.width || a.height !== b.height) return 'changed';
  let minA = 255, maxA = 0, minB = 255, maxB = 0;
  for (let top = 0; top < height; top += tile) {
    for (let left = 0; left < width; left += tile) {
      let squaredError = 0;
      for (let y = top; y < top + tile; y++) {
        for (let x = left; x < left + tile; x++) {
          const i = 4 * (y * width + x);
          const delta = Math.max(Math.abs(a.pixels[i] - b.pixels[i]), Math.abs(a.pixels[i+1] - b.pixels[i+1]),
            Math.abs(a.pixels[i+2] - b.pixels[i+2]));
          squaredError += delta * delta;
          const lumaA = (a.pixels[i] + 2*a.pixels[i+1] + a.pixels[i+2]) / 4;
          const lumaB = (b.pixels[i] + 2*b.pixels[i+1] + b.pixels[i+2]) / 4;
          minA = Math.min(minA, lumaA); maxA = Math.max(maxA, lumaA);
          minB = Math.min(minB, lumaB); maxB = Math.max(maxB, lumaB);
        }
      }
      if (squaredError > tile * tile * 24 ** 2) return 'changed';
    }
  }
  return Math.min(maxA - minA, maxB - minB) >= 24 ? 'matching' : 'flat';
}
