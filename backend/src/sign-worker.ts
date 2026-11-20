import { BadRequestException, GatewayTimeoutException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const recognizer = fileURLToPath(new URL('../signs/recognize.py', import.meta.url));
const python = fileURLToPath(new URL('../signs/.runtime/bin/python', import.meta.url));

export class SignWorker {
  private readonly child = spawn(python, [recognizer, '--worker']);
  private readonly log = new Logger(SignWorker.name);
  private response = '';
  private diagnostics = '';
  private timer?: NodeJS.Timeout;
  private job?: { resolve: (result: unknown) => void; reject: (error: Error) => void };
  private closed = false;

  constructor(private readonly remove: () => void) {
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.diagnostics = (this.diagnostics + chunk).slice(-1500);
    });
    this.child.on('error', error => this.fail(error.message));
    this.child.stdin.on('error', error => this.fail(error.message));
    this.child.on('close', code => this.fail(this.diagnostics || `OCR worker exited (${code})`));
  }

  get busy() { return Boolean(this.job); }

  run(images: Buffer[]): Promise<unknown> {
    clearTimeout(this.timer);
    return new Promise((resolve, reject) => {
      this.job = { resolve, reject };
      this.timer = setTimeout(() => this.close(new GatewayTimeoutException('인식 시간이 초과되었습니다. 다시 촬영하세요.')), 30_000);
      // Each request starts with its frame count; each frame carries its byte length.
      this.child.stdin.cork();
      this.child.stdin.write(Buffer.from([images.length]));
      for (const image of images) {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(image.length);
        this.child.stdin.write(size);
        this.child.stdin.write(image);
      }
      this.child.stdin.uncork();
    });
  }

  private receive(chunk: string) {
    this.response += chunk;
    if (!this.job || this.response.length > 64 * 1024) return this.fail('Unexpected OCR response');
    if (!this.response.endsWith('\n')) return;
    let result;
    try { result = JSON.parse(this.response); } catch { return this.fail('Invalid OCR response'); }
    const invalid = result?.error === 'invalid_image';
    if (!invalid && result?.status !== 'recognized' && result?.status !== 'pending') return this.fail('Invalid OCR result');
    const job = this.job;
    this.job = undefined;
    this.response = '';
    this.diagnostics = '';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), 5 * 60_000);
    if (invalid) job.reject(new BadRequestException('16메가픽셀 이하의 온전한 JPEG 또는 PNG 사진을 선택하세요.'));
    else job.resolve(result);
  }

  private fail(message: string) {
    if (this.closed) return;
    this.log.error(message);
    this.close();
  }

  close(error = new ServiceUnavailableException('안내판 인식기를 사용할 수 없습니다. 서버의 OCR 설치 상태를 확인하세요.')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.remove();
    this.job?.reject(error);
    this.job = undefined;
    this.child.kill('SIGKILL');
  }
}
