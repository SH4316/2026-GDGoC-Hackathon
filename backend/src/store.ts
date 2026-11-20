import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
  PayloadTooLargeException, StreamableFile,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import yazl from 'yazl';
import jpeg from 'jpeg-js';
import type { DebugBatch, Finish, Frame, Session } from './schema.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const frameName = (seq: number) => String(seq).padStart(6, '0');
export const MAX_SCAN = 256 * 1024 * 1024;

function publish(dir: string, name: string, files: Record<string, string | Buffer>, subdirectory?: string) {
  const dest = join(dir, name);
  if (!existsSync(dest)) {
    const tmp = mkdtempSync(join(dir, '.write-'));
    try {
      for (const [key, data] of Object.entries(files)) writeFileSync(join(tmp, key), data);
      if (subdirectory) mkdirSync(join(tmp, subdirectory));
      try { renameSync(tmp, dest); return; }
      catch (e) { if (!existsSync(dest)) throw e; }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  for (const [key, data] of Object.entries(files)) {
    if (!existsSync(join(dest, key)) || !readFileSync(join(dest, key)).equals(Buffer.from(data)))
      throw new ConflictException('This identifier already contains different data');
  }
}

function jpegMatches(image: Buffer, w: number, h: number) {
  if (image.length < 12 || image.readUInt16BE(image.length - 2) !== 0xffd9) return false;
  try {
    const { width, height } = jpeg.decode(image, { maxResolutionInMP: 1, maxMemoryUsageInMB: 32, tolerantDecoding: false });
    return width === w && height === h;
  } catch { return false; }
}

@Injectable()
export class RecordingStore {
  private readonly root = resolve(process.env.RECORDINGS_DIR || join(import.meta.dirname, '../../data/recordings'));
  private readonly jobs = new Set<string>();
  private current?: ReturnType<typeof execFile>;
  private closing = false;
  private readonly log = new Logger('Recordings');

  onModuleInit() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(this.root)) {
      const dir = join(this.root, id);
      if (existsSync(join(dir, 'sealed', 'finish.json')) && !existsSync(join(dir, 'reconstruction.json')) && !this.session(dir).capture)
        this.jobs.add(dir);
    }
    this.runNext();
  }

  onModuleDestroy() { this.closing = true; this.current?.kill(); }

  private directory(id: string) {
    const dir = join(this.root, id);
    if (!existsSync(join(dir, 'session.json'))) throw new NotFoundException('Unknown recording');
    return dir;
  }

  private session(dir: string): Session {
    return JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
  }

  createLidarSession(id: string) {
    publish(this.root, id, { 'lidar-session.json': json({ id, version: 1 }) });
    return { id };
  }

  debugBatch(id: string, offset: number, { startedAtMs, rows }: DebugBatch) {
    publish(this.root, id, { 'debug-session.json': json({ version: 1, id, startedAtMs }) });
    const db = new DatabaseSync(join(this.root, id, 'debug.sqlite'), { timeout: 5000 });
    try {
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY, elapsed REAL NOT NULL, line TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS samples_time ON samples(elapsed, seq);
        BEGIN IMMEDIATE;`);
      const insert = db.prepare('INSERT INTO samples VALUES (?, ?, ?) ON CONFLICT(seq) DO NOTHING');
      const existing = db.prepare('SELECT line FROM samples WHERE seq = ?');
      rows.forEach((row, i) => {
        const seq = offset + i, line = row.join(',');
        if (!insert.run(seq, Number(row[0]), line).changes && existing.get(seq)?.line !== line)
          throw new ConflictException('Different data at this debug row offset');
      });
      db.exec('COMMIT');
      return { id, offset, rows: rows.length };
    } finally { db.close(); } // Closing rolls back an uncommitted batch.
  }

  debugCsv(id: string) {
    const path = join(this.root, id, 'debug.sqlite');
    if (!existsSync(path)) throw new NotFoundException('No debug samples');
    function* csv() {
      const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
      try {
        yield 'elapsed_ms,ax_m_s2,ay_m_s2,az_m_s2,ax_with_gravity_m_s2,ay_with_gravity_m_s2,az_with_gravity_m_s2,space_id,position_source,x_m,y_m,z_m\r\n';
        for (const { line } of db.prepare('SELECT line FROM samples ORDER BY elapsed, seq').iterate()) yield line + '\r\n';
      } finally { db.close(); }
    }
    return new StreamableFile(Readable.from(csv()), { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="ar-debug-${id}.csv"` });
  }

  private scanDirectory(id: string) {
    const dir = join(this.root, id);
    return existsSync(join(dir, 'lidar-session.json')) ? dir : this.directory(id);
  }

  scanFile(id: string, format: 'ply' | 'usdz') {
    const name = 'lidar.' + format;
    const path = join(this.scanDirectory(id), name);
    if (!existsSync(path)) throw new NotFoundException('No scan for this format');
    return new StreamableFile(createReadStream(path), {
      type: 'application/octet-stream', disposition: `attachment; filename="lidar-${id}.${format}"`,
    });
  }

  create(id: string, session: Session) {
    publish(this.root, id, { 'session.json': json({ version: session.capture ? 2 : 1, id, ...session }) }, 'frames');
    // Also allow a session created by an earlier version to resume after a restart.
    mkdirSync(join(this.root, id, 'frames'), { recursive: true });
    if (session.capture) mkdirSync(join(this.root, id, 'parts'), { recursive: true });
    return { id };
  }

  frame(id: string, seq: number, meta: Frame, image: Buffer) {
    const dir = this.directory(id);
    const name = frameName(seq);
    if (existsSync(join(dir, 'sealed')) && !existsSync(join(dir, 'frames', name)))
      throw new ConflictException('Recording finished');
    if (!jpegMatches(image, meta.width, meta.height)) throw new BadRequestException('Invalid JPEG or frame dimensions');
    publish(join(dir, 'frames'), name, { 'frame.json': json({ seq, ...meta }), 'image.jpg': image });
    return { seq };
  }

  part(id: string, seq: number, video: Buffer, samples: unknown[]) {
    const dir = this.directory(id);
    const parts = join(dir, 'parts');
    const name = frameName(seq);
    if (!existsSync(parts) || (existsSync(join(dir, 'sealed')) && !existsSync(join(parts, name))))
      throw new ConflictException('Recording cannot accept new parts');
    const motion = samples.map(s => JSON.stringify(s) + '\n').join('');
    publish(parts, name, { 'video.bin': video, 'motion.ndjson': motion });
    return { seq };
  }

  finish(id: string, finish: Finish) {
    const { frameCount, partCount, end } = finish;
    const dir = this.directory(id);
    const frames = this.frames(dir);
    if (frames.length !== frameCount || frames.some((f, index) => f !== frameName(index)))
      throw new ConflictException('Some frames have not arrived');
    const capture = this.session(dir).capture;
    if (capture) {
      if (partCount === undefined || !end) throw new BadRequestException('Missing capture counts');
      const parts = this.parts(dir);
      if (parts.length !== partCount || parts.some((name, i) => name !== frameName(i)))
        throw new ConflictException('Some video or motion parts have not arrived');
    } else if (partCount !== undefined || end) throw new BadRequestException('Unexpected capture metadata');
    publish(dir, 'sealed', { 'finish.json': json(finish) });
    if (!capture && !this.reconstruction(dir)) { this.jobs.add(dir); this.runNext(); }
    return this.status(id);
  }

  private parts(dir: string) {
    return readdirSync(join(dir, 'parts')).filter(name => /^\d{6}$/.test(name)).sort();
  }

  bundle(id: string) {
    const dir = this.directory(id);
    const capture = this.session(dir).capture;
    if (!capture || !existsSync(join(dir, 'sealed'))) throw new NotFoundException('No completed capture');
    const parts = this.parts(dir);
    async function* concatenate(name: string) {
      for (const part of parts) yield* createReadStream(join(dir, 'parts', part, name));
    }
    const archive = new yazl.ZipFile();
    const output = new PassThrough();
    archive.on('error', error => output.destroy(error));
    archive.outputStream.pipe(output);
    archive.addFile(join(dir, 'session.json'), 'session.json');
    archive.addFile(join(dir, 'sealed', 'finish.json'), 'finish.json');
    const ext = capture.mimeType === 'video/mp4' ? 'mp4' : 'webm';
    archive.addBuffer(Buffer.from(json({
      version: 1, video: 'video.' + ext, motion: 'motion.ndjson', keyframes: 'frames/<sequence>/',
      time: {
        origin: 'MediaRecorder.start() call, session.startedAtMs in Unix milliseconds',
        motion: 'tMs and frame.recordingTimeMs are elapsed browser-clock milliseconds',
        video: 'Approximate playback seconds = frame.mediaTimeS - session.capture.mediaTimeAtStartS. Refine with matching keyframe JPEGs.',
      },
      motionAxes: 'Device coordinates (+X right, +Y top, +Z out of the screen in standard orientation)',
      acceleration: 'XYZ in m/s^2, excluding gravity. accelerationIncludingGravity includes gravity',
      rotationRate: '[alpha, beta, gamma] in degrees/s about Z, X, Y respectively',
      intrinsics: '[fx, fy, cx, cy] in keyframe JPEG pixels. See session.station.camera for calibration',
      pose: 'Row-major cameraToWorld in metres, camera (+X right, +Y down, +Z forward), station +X right, +Y forward, +Z up',
      lidar: 'Optional external scan in its own coordinate system and time base. Align using common landmarks',
    })), 'manifest.json');
    const video = Readable.from(concatenate('video.bin'));
    const motion = Readable.from(concatenate('motion.ndjson'));
    for (const stream of [video, motion]) {
      stream.on('error', error => output.destroy(error));
      output.once('close', () => stream.destroy());
    }
    archive.addReadStream(video, 'video.' + ext, { compress: false });
    archive.addReadStream(motion, 'motion.ndjson');
    for (const name of this.frames(dir)) {
      for (const file of ['image.jpg', 'frame.json']) {
        const path = 'frames/' + name + '/' + file;
        archive.addFile(join(dir, path), path, { compress: file !== 'image.jpg' });
      }
    }
    for (const file of ['lidar.ply', 'lidar.usdz']) {
      if (existsSync(join(dir, file))) archive.addFile(join(dir, file), file);
    }
    archive.end();
    return new StreamableFile(output, { type: 'application/zip', disposition: 'attachment; filename="capture-' + id + '.zip"' });
  }

  private frames(dir: string) {
    return readdirSync(join(dir, 'frames')).filter(name => /^\d{6}$/.test(name)).sort();
  }

  status(id: string) {
    const dir = this.scanDirectory(id);
    const scans = ['ply', 'usdz'].flatMap(format => {
      const file = statSync(join(dir, 'lidar.' + format), { throwIfNoEntry: false });
      return file ? [{ format, bytes: file.size }] : [];
    });
    if (existsSync(join(dir, 'lidar-session.json')))
      return { id, frameCount: 0, finished: scans.length > 0, reconstruction: null, scans };
    return { id, frameCount: this.frames(dir).length, finished: existsSync(join(dir, 'sealed')),
      reconstruction: this.reconstruction(dir), scans };
  }

  private reconstruction(dir: string): { state: string; points: number } | null {
    const path = join(dir, 'reconstruction.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  cloud(id: string) {
    const dir = this.directory(id);
    const path = join(dir, 'scene.ply');
    if (this.reconstruction(dir)?.state !== 'ready' || !existsSync(path)) throw new NotFoundException('No reconstructed scene points');
    return new StreamableFile(createReadStream(path), { type: 'application/octet-stream', disposition: 'attachment; filename="scene.ply"' });
  }

  private runNext() {
    if (this.current || this.closing) return;
    const dir = this.jobs.values().next().value;
    if (!dir) return;
    this.jobs.delete(dir);
    this.current = execFile(process.execPath, [join(import.meta.dirname, '../reconstruct.cjs'), dir], error => {
      this.current = undefined;
      this.jobs.delete(dir);
      if (!existsSync(join(dir, 'reconstruction.json')) && !this.closing) {
        this.log.error(error?.message ?? 'Reconstruction exited without a result');
        const temp = join(dir, '.error-' + randomUUID());
        try {
          writeFileSync(temp, json({ state: 'error', points: 0 }));
          renameSync(temp, join(dir, 'reconstruction.json'));
        } catch (publishError) {
          this.log.error('Could not publish the reconstruction result', publishError);
        } finally { rmSync(temp, { force: true }); }
      }
      this.runNext();
    });
  }

  async scan(id: string, format: 'ply' | 'usdz', body: AsyncIterable<Buffer>) {
    const dir = this.scanDirectory(id);
    const dest = join(dir, 'lidar.' + format);
    const tmp = join(dir, '.scan-' + randomUUID());
    const file = await open(tmp, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0, head = Buffer.alloc(0);
    try {
      for await (const part of body) {
        size += part.length;
        if (size > MAX_SCAN) throw new PayloadTooLargeException();
        if (head.length < 5) head = Buffer.concat([head, part.subarray(0, 5 - head.length)]);
        hash.update(part);
        await file.writeFile(part);
      }
      const valid = format === 'ply' ? /^ply\r?\n/.test(head.toString('ascii')) : head.subarray(0, 4).equals(Buffer.from([80,75,3,4]));
      if (!valid) throw new BadRequestException('Unexpected scan file header');
      await file.sync();
      const digest = hash.digest('hex');
      try { linkSync(tmp, dest); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const previous = createHash('sha256');
        for await (const bytes of createReadStream(dest)) previous.update(bytes);
        if (previous.digest('hex') !== digest) throw new ConflictException('A different scan already exists');
      }
      return { bytes: size, sha256: digest, format };
    } finally {
      try { await file.close(); }
      finally { await rm(tmp, { force: true }); }
    }
  }
}
