import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
  PayloadTooLargeException, StreamableFile,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import jpeg from 'jpeg-js';
import type { Frame, Session } from './schema.js';

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
    if (!readFileSync(join(dest, key)).equals(Buffer.from(data)))
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
      if (existsSync(join(dir, 'sealed', 'finish.json')) && !existsSync(join(dir, 'reconstruction.json')))
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

  create(id: string, session: Session) {
    publish(this.root, id, { 'session.json': json({ version: 1, id, ...session }) }, 'frames');
    // Also allow a session created by an earlier version to resume after a restart.
    mkdirSync(join(this.root, id, 'frames'), { recursive: true });
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

  finish(id: string, frameCount: number) {
    const dir = this.directory(id);
    const frames = this.frames(dir);
    if (frames.length !== frameCount || frames.some((f, index) => f !== frameName(index)))
      throw new ConflictException('Some frames have not arrived');
    publish(dir, 'sealed', { 'finish.json': json({ frameCount }) });
    if (!this.reconstruction(dir)) { this.jobs.add(dir); this.runNext(); }
    return this.status(id);
  }

  private frames(dir: string) {
    return readdirSync(join(dir, 'frames')).filter(name => /^\d{6}$/.test(name)).sort();
  }

  status(id: string) {
    const dir = this.directory(id);
    return { id, frameCount: this.frames(dir).length, finished: existsSync(join(dir, 'sealed')),
      reconstruction: this.reconstruction(dir) };
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
    const dir = this.directory(id);
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
