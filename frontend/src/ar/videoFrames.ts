export function watchCameraFrames(video: HTMLVideoElement, sample: (at: number, mediaTime: number) => boolean) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    function onFrame(now: number, frame: VideoFrameCallbackMetadata) {
      callback = video.requestVideoFrameCallback(onFrame);
      // Each callback signals a new frame. WebKit camera streams can report mediaTime = 0 throughout.
      const mediaTime = frame.mediaTime > 0 ? frame.mediaTime : video.currentTime;
      sample(frame.presentationTime ?? now, mediaTime);
    }
    let callback = video.requestVideoFrameCallback(onFrame);
    return () => video.cancelVideoFrameCallback(callback);
  }

  // Animation ticks can repeat a frame. Advance only after the tracker accepts it.
  let lastMediaTime = -1;
  function onTick(now: number) {
    callback = requestAnimationFrame(onTick);
    const mediaTime = video.currentTime;
    if (mediaTime !== lastMediaTime && sample(now, mediaTime)) lastMediaTime = mediaTime;
  }
  let callback = requestAnimationFrame(onTick);
  return () => cancelAnimationFrame(callback);
}
