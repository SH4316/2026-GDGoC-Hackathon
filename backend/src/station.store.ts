import { BadRequestException, ConflictException, Injectable, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import defaults from './station.default.json' with { type: 'json' };
import { isKnownStop } from './rail-stops.js';
import { modelFile, stationSchema, type Station } from './schema.js';

export const MAX_MODEL_BYTES = 32 * 1024 * 1024;
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function exampleCorridor() {
  const vertices = [0, 0.65].flatMap(height =>
    defaults.terrain.outline.map(([x, y]) => `v ${x} ${height} ${-y}`));
  return Buffer.from([
    '# Example cutaway for the documented AprilTag test course',
    ...vertices,
    'o Floor',
    'f 6 1 2', 'f 6 2 3', 'f 6 3 4', 'f 6 4 5',
    'o Walls',
    ...[[2, 3], [3, 4], [5, 6], [6, 1]].map(([a, b]) => `f ${b} ${a} ${a + 6} ${b + 6}`),
    '',
  ].join('\n'));
}

function writeAtomic(path: string, bytes: Buffer | string) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function checkModel(bytes: Buffer, extension: string) {
  if (extension === '.obj') {
    const text = bytes.toString('utf8');
    if (!text.includes('\0') && /^v\s+[-+.\d]/m.test(text) && /^f\s+[-\d]/m.test(text)) return;
    throw new BadRequestException('꼭짓점과 면이 있는 OBJ 파일을 선택하세요.');
  }
  if (extension !== '.glb') throw new BadRequestException('GLB 또는 OBJ 파일을 선택하세요.');
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 &&
      bytes.readUInt32LE(8) === bytes.length && bytes.toString('ascii', 16, 20) === 'JSON') {
    const end = 20 + bytes.readUInt32LE(12);
    if (end <= bytes.length) {
      let meta;
      try { meta = JSON.parse(bytes.toString('utf8', 20, end)); } catch { /* Invalid GLB JSON chunk. */ }
      if (meta?.asset?.version === '2.0' && Array.isArray(meta.meshes) && meta.meshes.length &&
          Array.isArray(meta.buffers ?? []) && Array.isArray(meta.images ?? []) && Array.isArray(meta.extensionsRequired ?? [])) {
        const resources = [...(meta.buffers ?? []), ...(meta.images ?? [])];
        if (resources.some(resource => !resource || (resource.uri !== undefined && !String(resource.uri).startsWith('data:'))))
          throw new BadRequestException('텍스처와 버퍼를 파일 안에 포함한 GLB를 선택하세요.');
        const compressed = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu'];
        if (compressed.some(name => meta.extensionsRequired?.includes(name)))
          throw new BadRequestException('추가 디코더가 필요 없는 GLB로 내보내세요.');
        return;
      }
    }
  }
  throw new BadRequestException('메시가 포함된 GLB 2.0 파일을 선택하세요.');
}

@Injectable()
export class StationStore {
  private readonly root = resolve(process.env.STATION_DIR || join(import.meta.dirname, '../../data/station'));
  private readonly path = join(this.root, 'station.json');
  private readonly models = join(this.root, 'models');

  private readonly spaces = join(this.root, 'spaces');

  onModuleInit() {
    mkdirSync(this.spaces, { recursive: true, mode: 0o700 });
    mkdirSync(this.models, { recursive: true, mode: 0o700 });
    this.addModel(exampleCorridor(), 'corridor-example.obj');
    const previous = join(import.meta.dirname, '../../frontend/public/station.json');
    const saved = existsSync(this.path) ? this.read().station : undefined;
    const initial = saved ?? (existsSync(previous) ? stationSchema.parse(JSON.parse(readFileSync(previous, 'utf8'))) : undefined);
    const { terrain: _terrain, ...baseline } = stationSchema.parse(defaults);
    // The original field kit used IDs 0–3. Keep installed labels when adding its missing terrain.
    const original = { ...baseline, tags: baseline.tags.map((tag, id) => ({ ...tag, id })) };
    if (!initial || [baseline, original].some(layout => JSON.stringify(initial) === JSON.stringify(layout))) {
      this.write({ ...(initial ?? baseline), terrain: this.exampleTerrain() });
    } else if (!saved) {
      this.write(initial);
    }
  }

  exampleTerrain() {
    return { ...stationSchema.parse(defaults).terrain!,
      model: { file: digest(exampleCorridor()) + '.obj', name: 'corridor-example.obj' } };
  }

  private spacePath(id: string) {
    if (id === 'default') return this.path;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new NotFoundException('공간을 찾을 수 없습니다.');
    return join(this.spaces, id + '.json');
  }

  listLayouts() {
    const ids = ['default', ...readdirSync(this.spaces).filter(name => name.endsWith('.json')).sort().map(name => name.slice(0, -5))];
    return ids.map(id => ({ id, station: this.read(id).station }));
  }

  listSpaces(line?: string, code?: string) {
    return this.listLayouts()
      .filter(({ station }) => line === undefined || station.stationLinks?.some(stop => stop.line === line && stop.code === code))
      .map(({ id, station }) => ({ id, name: station.terrain?.name ?? '기본 공간', stationLinks: station.stationLinks }));
  }

  private checkSpace(station: Station, spaceId?: string) {
    if (!station.route.length && station.stationLinks?.some(stop => stop.routeEndpoint))
      throw new BadRequestException('연결 역에 출발점이나 도착점을 지정하려면 안내 경로를 입력하세요.');
    const tagIds = new Set(station.tags.map(tag => tag.id));
    for (const { id, station: other } of this.listLayouts()) {
      if (id === spaceId) continue;
      const name = other.terrain?.name ?? '기본 공간';
      if (station.terrain?.name.normalize() === name.normalize())
        throw new BadRequestException('같은 이름의 공간이 있습니다. 다른 이름을 입력하세요.');
      const taken = other.tags.find(tag => tagIds.has(tag.id));
      if (taken) throw new ConflictException('‘' + name + '’에서 태그 ' + taken.id + '번을 사용하고 있습니다. 다른 번호를 선택하세요.');
    }
  }

  createSpace(input: unknown) {
    const station = this.validate(input);
    if (!station.terrain?.name) throw new BadRequestException('공간 이름을 입력하세요.');
    this.checkSpace(station);
    const id = randomUUID();
    return { id, ...this.write(station, id) };
  }

  read(id = 'default') {
    const path = this.spacePath(id);
    if (!existsSync(path)) throw new NotFoundException('공간을 찾을 수 없습니다.');
    const bytes = readFileSync(path);
    return { station: stationSchema.parse(JSON.parse(bytes.toString('utf8'))), etag: '"' + digest(bytes) + '"' };
  }

  private write(station: Station, id = 'default') {
    const bytes = JSON.stringify(station, null, 2) + '\n';
    writeAtomic(this.spacePath(id), bytes);
    return { station, etag: '"' + digest(bytes) + '"' };
  }

  private validate(input: unknown) {
    const parsed = stationSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    if (parsed.data.stationLinks?.some(stop => !isKnownStop(stop)))
      throw new BadRequestException('역 목록에서 노선과 역번호를 확인해 다시 선택하세요.');
    for (const entry of [...parsed.data.tags, parsed.data.terrain]) {
      if (entry?.model && !existsSync(join(this.models, entry.model.file)))
        throw new BadRequestException('업로드된 모델을 선택하세요.');
    }
    return parsed.data;
  }

  replace(input: unknown, expected?: string, id = 'default') {
    const current = this.read(id);
    if (expected && expected !== '*' && current.etag !== expected)
      throw new PreconditionFailedException('다른 기기에서 배치를 수정했습니다. 최신 배치를 불러와 다시 저장하세요.');
    const station = this.validate(input);
    const next = { ...station, terrain: station.terrain ?? current.station.terrain,
      stationLinks: station.stationLinks ?? current.station.stationLinks };
    this.checkSpace(next, id);
    return this.write(next, id);
  }

  addModel(bytes: Buffer, filename: string) {
    const name = basename(filename.replaceAll('\\', '/')).trim().slice(0, 255);
    const extension = extname(name).toLowerCase();
    checkModel(bytes, extension);
    const file = digest(bytes) + extension;
    const path = join(this.models, file);
    if (!existsSync(path)) writeAtomic(path, bytes);
    return { file, name };
  }

  openModel(file: string) {
    if (!modelFile.safeParse(file).success || !existsSync(join(this.models, file)))
      throw new NotFoundException('모델을 찾을 수 없습니다.');
    return createReadStream(join(this.models, file));
  }
}
