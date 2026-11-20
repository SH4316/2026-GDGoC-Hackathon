import { readMotion, requestMotionAccess, type MotionAccess, type MotionSample } from './motion';

// Times are relative to MediaRecorder.start(), on the browser's monotonic clock.
export type Sample = Omit<MotionSample, 'timeMs'> & { tMs: number };
export type Part = { video: Blob; samples: Sample[] };
export type Capture = { mimeType: 'video/mp4' | 'video/webm'; mediaTimeAtStartS: number;
  motionPermission: MotionAccess };

export class MovieCapture {
  static async prepare(video: HTMLVideoElement) {
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream) || typeof MediaRecorder === 'undefined')
      throw new Error('이 브라우저에서는 동영상을 녹화할 수 없습니다');
    const mimeType = (['video/mp4', 'video/webm'] as const).find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('지원되는 동영상 형식이 없습니다');
    // iOS needs this call inside the record button's user activation.
    const permission = await requestMotionAccess();
    if (stream !== video.srcObject || !stream.active || document.hidden) throw new Error('카메라를 다시 연결하세요');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_000_000 });
    return new MovieCapture(recorder, video, mimeType, permission);
  }

  private samples: Sample[] = [];
  private emitPart?: (part: Part) => void;
  private stopped = Promise.resolve();
  origin = 0;

  private constructor(private recorder: MediaRecorder, private video: HTMLVideoElement,
    private mimeType: Capture['mimeType'], private permission: Capture['motionPermission']) {}

  private motion = (event: DeviceMotionEvent) => {
    const { timeMs, ...reading } = readMotion(event);
    const sample = { tMs: timeMs - this.origin, ...reading };
    if (sample.tMs < 0 || !(sample.acceleration || sample.accelerationIncludingGravity || sample.rotationRate)) return;
    this.samples.push(sample);
    if (this.samples.length >= 512) this.flush(new Blob());
  };

  private flush(blob: Blob) {
    const samples = this.samples.splice(0);
    // A suspended browser can emit several seconds of video in a single event.
    const limit = 2 * 1024 * 1024;
    if (samples.length || blob.size) this.emitPart?.({ video: blob.slice(0, limit), samples });
    for (let offset = limit; offset < blob.size; offset += limit)
      this.emitPart?.({ video: blob.slice(offset, offset + limit), samples: [] });
  }

  start(emit: (part: Part) => void, ended: () => void): Capture {
    this.emitPart = emit;
    this.recorder.ondataavailable = e => this.flush(e.data);
    this.stopped = new Promise(resolve => {
      this.recorder.onstop = () => {
        window.removeEventListener('devicemotion', this.motion);
        this.flush(new Blob());
        resolve();
        ended();
      };
    });
    const mediaTimeAtStartS = this.video.currentTime;
    this.origin = performance.now();
    this.recorder.start(1000);
    if (this.permission === 'implicit' || this.permission === 'granted')
      window.addEventListener('devicemotion', this.motion);
    return { mimeType: this.mimeType, mediaTimeAtStartS, motionPermission: this.permission };
  }

  async stop() {
    window.removeEventListener('devicemotion', this.motion);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
  }
}
