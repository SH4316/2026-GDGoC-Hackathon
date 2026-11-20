import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  if (existsSync('.env')) {
    loadEnvFile('.env');
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    validationError: { target: false, value: false },
  }));

  await app.listen(Number(process.env.PORT ?? 3000), process.env.BIND_HOST ?? '127.0.0.1');
}

void bootstrap();
