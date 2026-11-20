import {
  BadRequestException, Body, Controller, Get, Headers, Param, ParseUUIDPipe,
  PayloadTooLargeException, Put, Req, UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { finishSchema, frameSchema, sessionSchema } from './schema.js';
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

  @Put(':id/finish')
  finish(@Param('id', idPipe) id: string, @Body() input: unknown) {
    return this.store.finish(id, parse(finishSchema, input).frameCount);
  }

  @Get(':id/scene.ply')
  cloud(@Param('id', idPipe) id: string) { return this.store.cloud(id); }

  @Get(':id/status')
  status(@Param('id', idPipe) id: string) { return this.store.status(id); }

  @Put(':id/lidar/:format')
  scan(@Param('id', idPipe) id: string, @Param('format') format: string, @Req() req: Request) {
    if (format !== 'ply' && format !== 'usdz') throw new UnsupportedMediaTypeException('Use PLY or USDZ');
    if (!req.is('application/octet-stream')) throw new UnsupportedMediaTypeException('Use application/octet-stream');
    sizeCheck(req, MAX_SCAN);
    return this.store.scan(id, format, req.iterator({ destroyOnReturn: false }));
  }
}
