const assert = require('node:assert/strict');
const { test } = require('node:test');

function frameCallbacks() {
  let pending, id = 0;
  return {
    request(callback) { pending = callback; return ++id; },
    cancel(handle) { assert.equal(handle, id); pending = undefined; },
    fire(...args) {
      const callback = pending;
      pending = undefined;
      callback?.(...args);
    },
  };
}

test('new camera frames are sampled even when WebKit keeps mediaTime at zero', async () => {
  const { watchCameraFrames } = await import('../src/ar/videoFrames.ts');
  const frames = frameCallbacks();
  const video = { currentTime: 3, requestVideoFrameCallback: frames.request, cancelVideoFrameCallback: frames.cancel };
  const samples = [];
  const stop = watchCameraFrames(video, (at, time) => { samples.push([at, time]); return true; });
  frames.fire(100, { presentationTime: 98, mediaTime: 0 });
  frames.fire(133, { presentationTime: 131, mediaTime: 0 });
  video.currentTime = 3.1;
  frames.fire(166, { presentationTime: 164, mediaTime: 0 });
  frames.fire(200, { presentationTime: 198, mediaTime: 3.09 });
  stop();
  frames.fire(233, { presentationTime: 231, mediaTime: 3.12 });
  assert.deepEqual(samples, [[98, 3], [131, 3], [164, 3.1], [198, 3.09]]);
});

test('animation ticks retry a busy tracker and skip a frame already submitted', async t => {
  const { watchCameraFrames } = await import('../src/ar/videoFrames.ts');
  const ticks = frameCallbacks();
  const video = { currentTime: 1 };
  global.requestAnimationFrame = ticks.request;
  global.cancelAnimationFrame = ticks.cancel;
  t.after(() => { delete global.requestAnimationFrame; delete global.cancelAnimationFrame; });
  const samples = [];
  const stop = watchCameraFrames(video, (at, time) => { samples.push([at, time]); return at >= 16; });
  ticks.fire(0);
  ticks.fire(16);
  ticks.fire(32);
  video.currentTime = 1.04;
  ticks.fire(48);
  stop();
  video.currentTime = 1.08;
  ticks.fire(64);
  assert.deepEqual(samples, [[0, 1], [16, 1], [48, 1.04]]);
});
