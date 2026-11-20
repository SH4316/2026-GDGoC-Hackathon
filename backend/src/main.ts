import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RecordingsController } from './recordings.controller.js';
import { RecordingStore } from './store.js';

@Module({ controllers: [RecordingsController], providers: [RecordingStore] })
class AppModule {}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useBodyParser('json', { limit: '512kb' });
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT ?? 8081), process.env.API_HOST ?? '0.0.0.0');
