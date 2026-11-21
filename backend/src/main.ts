import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { AssistantController } from './assistant/controller.js';
import { DirectionsService } from './directions/service.js';
import { DirectionsController } from './directions.controller.js';
import { RecordingsController } from './recordings.controller.js';
import { RecordingStore } from './store.js';
import { ScreenDoorsController } from './screen-doors.controller.js';
import { SignsController } from './signs.controller.js';
import { StationController } from './station.controller.js';
import { StationStore } from './station.store.js';

@Module({ controllers: [AssistantController, DirectionsController, RecordingsController, ScreenDoorsController, SignsController, StationController], providers: [DirectionsService, RecordingStore, StationStore] })
class AppModule {}

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useBodyParser('json', { limit: '512kb' });
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT ?? 8081), process.env.API_HOST ?? '0.0.0.0');
