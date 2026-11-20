import {
  BadRequestException, Controller, Header, HttpCode, OnApplicationShutdown,
  Post, ServiceUnavailableException, UnsupportedMediaTypeException, UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { SignWorker } from './sign-worker.js';

type Upload = { mimetype: string; buffer: Buffer };

@Controller('api/signs')
export class SignsController implements OnApplicationShutdown {
  private readonly workers = new Set<SignWorker>();

  onApplicationShutdown() {
    for (const worker of this.workers) worker.close();
  }

  @Post('recognize')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(FilesInterceptor('images', 3, { limits: { files: 3, fields: 0, fileSize: 6 * 1024 * 1024 } }))
  async recognize(@UploadedFiles() files?: Upload[]) {
    if (!files?.length) throw new BadRequestException('안내판 사진을 선택하세요.');
    if (files.some(file => !['image/jpeg', 'image/png'].includes(file.mimetype))) {
      throw new UnsupportedMediaTypeException('JPEG 또는 PNG 사진을 선택하세요.');
    }
    let worker = [...this.workers].find(candidate => !candidate.busy);
    if (!worker) {
      if (this.workers.size >= 2) throw new ServiceUnavailableException('다른 안내판을 읽고 있습니다. 잠시 후 다시 시도하세요.');
      const fresh = new SignWorker(() => this.workers.delete(fresh));
      this.workers.add(fresh);
      worker = fresh;
    }
    return worker.run(files.map(file => file.buffer));
  }
}
