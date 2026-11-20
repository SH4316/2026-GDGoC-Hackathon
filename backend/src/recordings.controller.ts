import {
  BadRequestException, Body, Controller, Get, Header, Headers, Param, ParseUUIDPipe,
  PayloadTooLargeException, Put, Req, UploadedFile, UseInterceptors, UnsupportedMediaTypeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { debugBatchSchema, finishSchema, frameSchema, samplesSchema, sessionSchema } from './schema.js';
import { MAX_SCAN, RecordingStore } from './store.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid recording metadata');
  return result.data;
}

const idPipe = new ParseUUIDPipe({ version: '4' });
const MAX_IMAGE = 2 * 1024 * 1024;

function sizeCheck(req: Request, limit: number) {
  if (Number(req.headers['content-length']) > limit) throw new PayloadTooLargeException();
}

@Controller('api/recordings')
export class RecordingsController {
  constructor(private readonly store: RecordingStore) {}

  @Get('health')
  health() { return { ok: true }; }

  @Put(':id')
  create(@Param('id', idPipe) id: string, @Body() input: unknown) {
    return this.store.create(id, parse(sessionSchema, input));
  }

  @Put(':id/frames/:seq')
  async frame(@Param('id', idPipe) id: string, @Param('seq') seq: string,
              @Headers('x-frame-meta') header: string, @Req() req: Request) {
    if (!/^(0|[1-9]\d{0,5})$/.test(seq)) throw new BadRequestException('Invalid frame number');
    if (!req.is('image/jpeg')) throw new UnsupportedMediaTypeException('Expected image/jpeg');
    sizeCheck(req, MAX_IMAGE);
    let input: unknown;
    try { input = JSON.parse(header); } catch { throw new BadRequestException('Invalid X-Frame-Meta'); }
    const metadata = parse(frameSchema, input);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      size += part.length;
      if (size > MAX_IMAGE) throw new PayloadTooLargeException();
      chunks.push(part);
    }
    return this.store.frame(id, Number(seq), metadata, Buffer.concat(chunks));
  }

  @Put(':id/parts/:seq')
  @UseInterceptors(FileInterceptor('video', { limits: { fileSize: 4 * 1024 * 1024,
    files: 1, fields: 1, parts: 3, fieldSize: 512 * 1024 } }))
  part(@Param('id', idPipe) id: string, @Param('seq') seq: string,
       @Body('samples') input: string, @UploadedFile() file?: { buffer: Buffer }) {
    if (!/^(0|[1-9]\d{0,5})$/.test(seq) || !file) throw new BadRequestException('Invalid recording part');
    let samples: unknown;
    try { samples = JSON.parse(input); } catch { throw new BadRequestException('Invalid motion samples'); }
    return this.store.part(id, Number(seq), file.buffer, parse(samplesSchema, samples));
  }

  @Get(':id/capture.zip')
  bundle(@Param('id', idPipe) id: string) { return this.store.bundle(id); }

  @Put(':id/debug/:offset')
  debugBatch(@Param('id', idPipe) id: string, @Param('offset') offset: string, @Body() input: unknown) {
    if (!/^(0|[1-9]\d{0,9})$/.test(offset)) throw new BadRequestException('Invalid debug row offset');
    return this.store.debugBatch(id, Number(offset), parse(debugBatchSchema, input));
  }

  @Get(':id/debug.csv')
  @Header('Cache-Control', 'no-store')
  debugCsv(@Param('id', idPipe) id: string) { return this.store.debugCsv(id); }

  @Put(':id/finish')
  finish(@Param('id', idPipe) id: string, @Body() input: unknown) {
    return this.store.finish(id, parse(finishSchema, input));
  }

  @Get(':id/scene.ply')
  cloud(@Param('id', idPipe) id: string) { return this.store.cloud(id); }

  @Get(':id/status')
  @Header('Cache-Control', 'no-store')
  status(@Param('id', idPipe) id: string) { return this.store.status(id); }

  @Put(':id/lidar-session')
  lidarSession(@Param('id', idPipe) id: string) { return this.store.createLidarSession(id); }

  @Get(':id/lidar/:format')
  scanFile(@Param('id', idPipe) id: string, @Param('format') format: string) {
    if (format !== 'ply' && format !== 'usdz') throw new UnsupportedMediaTypeException('Use PLY or USDZ');
    return this.store.scanFile(id, format);
  }

  @Put(':id/lidar/:format')
  scan(@Param('id', idPipe) id: string, @Param('format') format: string, @Req() req: Request) {
    if (format !== 'ply' && format !== 'usdz') throw new UnsupportedMediaTypeException('Use PLY or USDZ');
    if (!req.is('application/octet-stream')) throw new UnsupportedMediaTypeException('Use application/octet-stream');
    sizeCheck(req, MAX_SCAN);
    return this.store.scan(id, format, req.iterator({ destroyOnReturn: false }));
  }
}
