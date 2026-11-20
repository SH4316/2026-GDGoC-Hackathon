import { openDB, type DBSchema } from 'idb';

import { MovieCapture, type Capture, type Part } from './movie';

export type Fix = { position: [number, number, number]; ids: number[]; rmsPx: number;
  cameraToWorld: number[]; arrow: [number, number][] | null; arrived?: boolean };
export type Intrinsics = [number, number, number, number];
type Metadata = {
  recordingTimeMs?: number; capturedAtMs: number; mediaTimeS: number; width: number; height: number; intrinsics: Intrinsics;
  pose: { cameraToWorld: number[]; tagIds: number[]; reprojectionPx: number } | null;
};
type Cloud = { state: 'ready' | 'insufficient' | 'error'; points: number };
type Session = {
  id: string; startedAtMs: number; station: unknown;
  capture?: Capture; parts?: number; partsSent?: number; accelerationSamples?: number; videoBytes?: number;
  end?: 'stopped' | 'interrupted';
  total: number; sent: number; created: boolean; stopped: boolean; finished: boolean; cloud: Cloud | null;
};
interface Records extends DBSchema {
  sessions: { key: string; value: Session };
  parts: { key: [string, number]; value: Part };
  frames: { key: [string, number]; value: { meta: Metadata; image: Blob } };
}

function openStore() {
  return openDB<Records>('station-field-recordings', 2, { upgrade(db, from) {
    if (from < 1) {
      db.createObjectStore('sessions', { keyPath: 'id' });
      db.createObjectStore('frames');
    }
    db.createObjectStore('parts');
  } });
}

export type RecordingView = { id?: string; phase: 'idle' | 'recording' | 'saving' | 'done';
  sent: number; total: number; cloud: Cloud | null; notice: string; capture?: Capture;
  accelerationSamples?: number; videoBytes?: number; interrupted?: boolean };
export const idleView: RecordingView = { phase: 'idle', sent: 0, total: 0, cloud: null, notice: '' };

async function request(url: string, init: RequestInit = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('서버 응답 ' + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}

const api = (id: string) => import.meta.env.BASE_URL + 'api/recordings/' + id;
const jsonPut = (body: unknown): RequestInit => ({
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export class FieldRecorder {
  private database?: ReturnType<typeof openStore>;
  private get db() { return this.database ??= openStore(); }
  private id = '';
  private active = false;
  private movie?: MovieCapture;
  private writes = Promise.resolve();
  private failed = false;
  private saving?: Promise<void>;
  private pumping = false;
  private disposed = false;
  private timer?: number;
  private sampleAt = -Infinity;
  private notice = '';
  private last?: Session;

  constructor(private readonly update: (view: RecordingView) => void) {}

  private show(session = this.last) {
    if (!session || this.disposed || session.id !== this.id) return;
    this.last = session;
    this.update({ id: session.id, phase: this.active ? 'recording' : session.finished ? 'done' : 'saving',
      capture: session.capture, accelerationSamples: session.accelerationSamples, videoBytes: session.videoBytes,
      interrupted: session.end === 'interrupted', sent: session.sent, total: session.total, cloud: session.cloud, notice: this.notice });
  }

  async restore() {
    window.addEventListener('online', this.wake);
    try {
      // Recover the pieces committed before the previous page closed.
      const id = sessionStorage.getItem('station-recording');
      if (id) {
        const row = await (await this.db).get('sessions', id);
        if (row && !this.disposed && !this.active) {
          this.id = id;
          await this.change(id, s => { if (s.capture && !s.stopped) s.end = 'interrupted'; s.stopped = true; });
        }
      }
      if (!this.disposed && window.indexedDB) this.wake();
    } catch { /* AR remains available when browser storage is unavailable. */ }
  }

  async start(station: unknown, video: HTMLVideoElement) {
    if (this.active || this.movie || this.saving) return;
    const movie = await MovieCapture.prepare(video);
    const db = await this.db;
    if (this.disposed || document.hidden || !(video.srcObject instanceof MediaStream) || !video.srcObject.active)
      throw new Error('카메라를 다시 연결하세요');
    const id = crypto.randomUUID();
    this.failed = false;
    // The session write is queued before the first dataavailable task.
    const capture = movie.start(part => this.queuePart(id, part), () => void this.stop('interrupted'));
    const row: Session = { id, station, startedAtMs: performance.timeOrigin + movie.origin, capture,
      parts: 0, partsSent: 0, videoBytes: 0, accelerationSamples: 0, total: 0, sent: 0,
      created: false, stopped: false, finished: false, cloud: null };
    this.movie = movie;
    this.id = id; this.active = true; this.sampleAt = movie.origin - 500; this.notice = '';
    try {
      await db.put('sessions', row);
      sessionStorage.setItem('station-recording', id);
    } catch (error) {
      this.active = false; this.failed = true;
      await movie.stop(); this.movie = undefined; throw error;
    }
    this.show(row);
    this.wake();
  }

  private queuePart(id: string, part: Part) {
    this.writes = this.writes.then(async () => {
      if (this.failed) return;
      const tx = (await this.db).transaction(['sessions', 'parts'], 'readwrite');
      const row = (await tx.objectStore('sessions').get(id))!;
      if (row.stopped || row.finished) {
        await tx.done; void this.stop('interrupted'); return;
      }
      const seq = row.parts!;
      await tx.objectStore('parts').add(part, [id, seq]);
      row.parts = seq + 1;
      row.videoBytes! += part.video.size;
      row.accelerationSamples! += part.samples.filter(s => s.acceleration || s.accelerationIncludingGravity).length;
      await tx.objectStore('sessions').put(row);
      await tx.done;
      this.show(row); this.wake();
    }).catch(() => {
      this.failed = true;
      this.notice = '녹화가 중단됐습니다. 기기 저장 공간을 확인하세요';
      this.show(); void this.stop('interrupted');
    });
  }

  capture(canvas: HTMLCanvasElement, at: number, mediaTimeS: number, intrinsics: Intrinsics, fix: Fix | null) {
    if (!this.active || this.saving || at - this.sampleAt < 500) return;
    this.sampleAt = at;
    const meta: Metadata = { recordingTimeMs: at - this.movie!.origin, capturedAtMs: performance.timeOrigin + at, mediaTimeS,
      width: canvas.width, height: canvas.height, intrinsics,
      pose: fix ? { cameraToWorld: fix.cameraToWorld, tagIds: fix.ids, reprojectionPx: fix.rmsPx } : null };
    const id = this.id;
    // toBlob snapshots the exact canvas that produced the worker's pose, before the next drawImage.
    const jpeg = new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('JPEG 인코딩 실패')), 'image/jpeg', .87));
    this.saving = (async () => {
      const image = await jpeg;
      const tx = (await this.db).transaction(['sessions', 'frames'], 'readwrite');
      const row = (await tx.objectStore('sessions').get(id))!;
      if (row.stopped || row.finished) { await tx.done; void this.stop('interrupted'); return; }
      await tx.objectStore('frames').add({ meta, image }, [id, row.total++]);
      await tx.objectStore('sessions').put(row);
      await tx.done;
      this.show(row);
      this.wake();
    })().catch(() => {
      this.notice = '기기 저장 공간을 확인하세요'; this.show();
      void this.stop('interrupted');
    }).finally(() => { this.saving = undefined; });
  }

  async stop(end: 'stopped' | 'interrupted' = 'stopped') {
    if (!this.active) return;
    this.active = false;
    this.show();
    const id = this.id;
    await this.movie?.stop();
    await this.writes;
    await this.saving;
    await this.change(id, s => {
      if (s.stopped) return;
      s.stopped = true;
      s.end = this.failed || !s.videoBytes ? 'interrupted' : end;
    });
    this.movie = undefined;
    this.wake();
  }

  private async change(id: string, edit: (s: Session) => void) {
    const tx = (await this.db).transaction('sessions', 'readwrite');
    const row = (await tx.store.get(id))!;
    edit(row); await tx.store.put(row); await tx.done; this.show(row);
  }

  private readonly wake = () => {
    if (this.disposed || this.pumping) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.pump(), 0);
  };

  private async send(row: Session) {
    const url = api(row.id);
    if (!row.created) {
      await request(url, jsonPut({ startedAtMs: row.startedAtMs, station: row.station, capture: row.capture }));
      await this.change(row.id, s => { s.created = true; });
    } else if ((row.partsSent ?? 0) < (row.parts ?? 0)) {
      const db = await this.db;
      const key: [string, number] = [row.id, row.partsSent!];
      const part = await db.get('parts', key);
      if (!part) return;
      const body = new FormData();
      body.append('video', part.video, 'video.bin');
      body.append('samples', JSON.stringify(part.samples));
      await request(url + '/parts/' + key[1], { method: 'PUT', body }, 60000);
      const tx = db.transaction(['sessions', 'parts'], 'readwrite');
      const current = (await tx.objectStore('sessions').get(row.id))!;
      if (current.partsSent === key[1]) {
        current.partsSent++; await tx.objectStore('sessions').put(current); await tx.objectStore('parts').delete(key);
      }
      await tx.done; this.show(current);
    } else if (row.sent < row.total) {
      const key: [string, number] = [row.id, row.sent];
      const db = await this.db;
      const frame = await db.get('frames', key);
      if (!frame) return; // Another tab can acknowledge the same frame.
      await request(url + '/frames/' + row.sent, { method: 'PUT', body: frame.image,
        headers: { 'Content-Type': 'image/jpeg', 'X-Frame-Meta': JSON.stringify(frame.meta) } });
      const tx = db.transaction(['frames', 'sessions'], 'readwrite');
      const current = (await tx.objectStore('sessions').get(row.id))!;
      if (current.sent === row.sent) {
        current.sent++; await tx.objectStore('sessions').put(current); await tx.objectStore('frames').delete(key);
      }
      await tx.done;
      this.show(current);
    } else {
      const result = await request(url + '/finish', jsonPut({ frameCount: row.total, partCount: row.parts, end: row.end }));
      await this.change(row.id, s => { s.finished = true; s.cloud = result.reconstruction; });
    }
  }

  private async pump() {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    let retry = false;
    try {
      const db = await this.db;
      const rows = await db.getAll('sessions');
      for (const row of rows) {
        if (row.finished) continue;
        if (row.created && row.sent >= row.total && row.partsSent === row.parts && !row.stopped) continue;
        try {
          await this.send(row);
          if (row.id === this.id && this.notice.startsWith('전송 대기')) { this.notice = ''; this.show(); }
          retry = true;
        } catch (e) {
          if (row.id === this.id) { this.notice = '전송 대기 · ' + (e instanceof Error ? e.message : '연결 확인'); this.show(); }
          retry = true;
        }
      }
      if (this.last?.finished && !this.last.capture && !this.last.cloud) {
        const id = this.last.id;
        const result = await request(api(id) + '/status');
        if (result.reconstruction) await this.change(id, s => { s.cloud = result.reconstruction; });
        else retry = true;
      }
    } catch { retry = Boolean(this.id); }
    finally {
      this.pumping = false;
      if (!this.disposed && (retry || (this.last && !this.last.finished && (!this.last.created || this.last.sent < this.last.total || this.last.partsSent !== this.last.parts || !this.active))))
        this.timer = window.setTimeout(() => void this.pump(), this.notice.startsWith('전송 대기') ? 2500 : 220);
    }
  }

  async attach(file: File) {
    if (!this.id || !this.last?.finished) return;
    const format = file.name.split('.').at(-1)?.toLowerCase();
    if (!['ply','usdz'].includes(format ?? '') || file.size > 256 * 1024 * 1024)
      throw new Error('256 MiB 이하의 PLY 또는 USDZ 파일을 선택하세요');
    await request(api(this.id) + '/lidar/' + format, { method: 'PUT', body: file,
      headers: { 'Content-Type': 'application/octet-stream' } }, 300000);
  }

  dispose() {
    this.disposed = true; clearTimeout(this.timer); window.removeEventListener('online', this.wake);
    void this.stop('interrupted');
  }
}
