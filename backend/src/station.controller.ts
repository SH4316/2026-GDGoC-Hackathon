import {
  BadRequestException, Body, Controller, Get, Header, Headers, Param, Post, Put, Query, Res,
  StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { MAX_MODEL_BYTES, StationStore } from './station.store.js';
import { railStops } from './rail-stops.js';

@Controller('api/station')
export class StationController {
  constructor(private readonly store: StationStore) {}

  @Get()
  @Header('Cache-Control', 'no-store, no-transform')
  read(@Res({ passthrough: true }) response: Response) {
    const { station, etag } = this.store.read();
    response.set('ETag', etag);
    return station;
  }

  @Get('spaces')
  @Header('Cache-Control', 'no-store')
  spaces(@Query('line') line?: string, @Query('code') code?: string) {
    if ((line !== undefined || code !== undefined) && !(typeof line === 'string' && line && typeof code === 'string' && code))
      throw new BadRequestException('조회할 노선과 역번호를 함께 지정하세요.');
    return this.store.listSpaces(line, code);
  }

  @Get('rail-stops')
  stops() {
    return railStops;
  }

  @Get('layouts')
  @Header('Cache-Control', 'no-store')
  layouts() {
    return this.store.listLayouts();
  }

  @Post('spaces')
  createSpace(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const { id, station, etag } = this.store.createSpace(body);
    response.set('ETag', etag);
    return { id, station };
  }

  @Get('spaces/:id')
  @Header('Cache-Control', 'no-store, no-transform')
  readSpace(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const { station, etag } = this.store.read(id);
    response.set('ETag', etag);
    return station;
  }

  @Put('spaces/:id')
  @Header('Cache-Control', 'no-store, no-transform')
  replaceSpace(@Param('id') id: string, @Body() body: unknown, @Headers('if-match') expected: string | undefined,
               @Res({ passthrough: true }) response: Response) {
    const { station, etag } = this.store.replace(body, expected, id);
    response.set('ETag', etag);
    return station;
  }

  @Get('example-terrain')
  @Header('Cache-Control', 'no-store')
  exampleTerrain() {
    return this.store.exampleTerrain();
  }

  @Put()
  @Header('Cache-Control', 'no-store, no-transform')
  replace(@Body() body: unknown, @Headers('if-match') expected: string | undefined,
          @Res({ passthrough: true }) response: Response) {
    const { station, etag } = this.store.replace(body, expected);
    response.set('ETag', etag);
    return station;
  }

  @Post('models')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_MODEL_BYTES, files: 1, fields: 0 } }))
  addModel(@UploadedFile() model: { buffer: Buffer; originalname: string } | undefined) {
    if (!model) throw new BadRequestException('모델 파일을 선택하세요.');
    return this.store.addModel(model.buffer, model.originalname);
  }

  @Get('models/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  @Header('X-Content-Type-Options', 'nosniff')
  model(@Param('file') file: string) {
    return new StreamableFile(this.store.openModel(file), {
      type: file.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream',
    });
  }
}
