const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');

test('station edits and models survive a restart; concurrent edits and invalid references are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'station-settings-'));
  const prevDir = process.env.STATION_DIR;
  process.env.STATION_DIR = dir;
  const { StationController } = await import('../dist/station.controller.js');
  const { StationStore } = await import('../dist/station.store.js');
  class TestModule {}
  Module({ controllers: [StationController], providers: [StationStore] })(TestModule);
  let app, base;
  async function start() {
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl() + '/api/station';
  }
  t.after(async () => {
    await app?.close();
    if (prevDir === undefined) delete process.env.STATION_DIR; else process.env.STATION_DIR = prevDir;
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  const initial = await fetch(base);
  const station = await initial.json(), version = initial.headers.get('etag');
  assert.deepEqual(station.tags.map(tag => tag.id), [4,5,6,3]);
  assert.deepEqual(station.route, [[0, 0], [0, 2], [1.75, 2]]);
  assert.equal(station.terrain.outline.length, 6);
  assert.deepEqual(await (await fetch(base + '/example-terrain')).json(), station.terrain);
  const example = await fetch(base + '/models/' + station.terrain.model.file);
  assert.equal(example.status, 200);
  assert.match(await example.text(), /^o Floor$/m);
  const put = (data, headers) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data) });
  const upload = (name, bytes) => {
    const form = new FormData(); form.append('file', new Blob([bytes]), name);
    return fetch(base + '/models', { method: 'POST', body: form });
  };
  const triangle = 'v 0 0 0\nv 0 1 0\nv 1 0 0\nf 1 2 3\n';
  assert.equal((await upload('broken.glb', triangle)).status, 400);
  const posted = await upload('pin.obj', triangle);
  assert.equal(posted.status, 201);
  const model = await posted.json();
  assert.deepEqual(await (await upload('pin.obj', triangle)).json(), model);
  assert.equal((await put({ ...station, tags: [station.tags[0], station.tags[0]] })).status, 400);
  const tags = [{ id: 42, center: [-1.2, 4.5], yawDeg: 90, model, modelSizeM: .32 }];
  const missing = { file: '0'.repeat(64) + '.glb', name: 'missing' };
  assert.equal((await put({ ...station, tags: [{ ...tags[0], model: missing }] })).status, 400);
  assert.equal((await put({ ...station, terrain: { ...station.terrain, model: missing } })).status, 400);
  const terrain = { ...station.terrain, name: '새 지형', model };
  const saved = await put({ ...station, tags, terrain }, { 'If-Match': version });
  assert.equal(saved.status, 200);
  assert.equal((await put(station, { 'If-Match': version })).status, 412);
  await app.close();
  await start();
  const persisted = await fetch(base);
  assert.equal(persisted.headers.get('etag'), saved.headers.get('etag'));
  const persistedStation = await persisted.json();
  assert.deepEqual(persistedStation.tags, tags);
  assert.deepEqual(persistedStation.terrain, terrain);
  assert.equal(await (await fetch(base + '/models/' + model.file)).text(), triangle);
  const createSpace = body => fetch(base + '/spaces', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  const space = { ...station, terrain: { name: '계단실', model }, route: [],
    tags: [{ id: 43, center: [3, 2], yawDeg: 25, surface: { heightM: 1.65, right: [1,0,0], up: [0,0,1] } }] };
  const collision = await createSpace({ ...space, tags });
  assert.equal(collision.status, 409);
  assert.match((await collision.json()).message, /새 지형.*42번/);
  const created = await createSpace(space);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await createSpace(space)).status, 400);
  const path = '/spaces/' + id;
  const headers = { 'Content-Type': 'application/json', 'If-Match': created.headers.get('etag') };
  assert.equal((await fetch(base + path, { method: 'PUT', headers, body: JSON.stringify({ ...space, tags }) })).status, 409);
  assert.equal((await put({ ...persistedStation, tags: space.tags })).status, 409);
  const changed = { ...space, terrain: { ...space.terrain, name: '동쪽 계단실' } };
  assert.equal((await fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(changed) })).status, 200);
  assert.equal((await fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(space) })).status, 412);
  await app.close();
  await start();
  assert.deepEqual(await (await fetch(base + path)).json(), changed);
  assert.deepEqual(await (await fetch(base + '/spaces')).json(), [{ id: 'default', name: terrain.name }, { id, name: '동쪽 계단실' }]);
  assert.deepEqual(await (await fetch(base + '/layouts')).json(), [{ id: 'default', station: persistedStation }, { id, station: changed }]);
  assert.deepEqual(await (await fetch(base)).json(), persistedStation);
  assert.equal((await fetch(base + '/spaces/unknown')).status, 404);
  const { terrain: omitted, ...legacy } = station;
  const legacyEdit = await put({ ...legacy, tags: [] });
  assert.equal(legacyEdit.status, 200);
  assert.deepEqual((await legacyEdit.json()).terrain, terrain);

  await app.close();
  await writeFile(join(dir, 'station.json'), JSON.stringify(legacy));
  await start();
  assert.deepEqual((await (await fetch(base)).json()).terrain, station.terrain);

  await app.close();
  const customized = { ...legacy, tags };
  await writeFile(join(dir, 'station.json'), JSON.stringify(customized));
  await start();
  assert.deepEqual(await (await fetch(base)).json(), customized);

  // Two editors can pick the same unused ID before either saves.
  const competing = suffix => createSpace({ ...space, terrain: { name: '통로 ' + suffix }, tags: [{ ...tags[0], id: 7 }] });
  const results = await Promise.all([competing('A'), competing('B')]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const layouts = await (await fetch(base + '/layouts')).json();
  assert.equal(layouts.filter(({ station }) => station.tags.some(t => t.id === 7)).length, 1);

  const catalog = await (await fetch(base + '/rail-stops')).json();
  assert.equal(new Set(catalog.map(s => s.line + ':' + s.code)).size, catalog.length);
  const seohae = { line: '서해선', code: 'S26', name: '초지' };
  const line4 = { line: '4호선', code: '452', name: '초지' };
  for (const stop of [seohae, line4]) assert.ok(catalog.some(s => s.line === stop.line && s.code === stop.code && s.name === stop.name));
  const linked = await createSpace({ ...space, tags: [], terrain: { name: '환승 통로' }, stationLinks: [seohae, line4] });
  assert.equal(linked.status, 201);
  const passage = await linked.json();
  const edit = (links, etag) => fetch(base + '/spaces/' + passage.id, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify({ ...passage.station, stationLinks: links }) });
  const version1 = linked.headers.get('etag');
  assert.equal((await edit([seohae, seohae], version1)).status, 400);
  assert.equal((await edit([{ ...seohae, line: '4호선' }], version1)).status, 400);
  assert.equal((await edit([{ ...seohae, name: '정왕' }], version1)).status, 400);
  const legacySave = await edit(undefined, version1);
  assert.equal(legacySave.status, 200);
  assert.deepEqual((await legacySave.json()).stationLinks, [seohae, line4]);
  const latest = legacySave.headers.get('etag');
  const other = await createSpace({ ...space, tags: [], terrain: { name: '승강장' }, stationLinks: [line4] });
  assert.equal(other.status, 201);
  const platform = await other.json();
  await app.close();
  await start();
  const spacesAt = async stop => (await (await fetch(base + '/spaces?' + new URLSearchParams({ line: stop.line, code: stop.code }))).json())
    .map(s => s.id).sort();
  assert.deepEqual(await spacesAt(seohae), [passage.id]);
  assert.deepEqual(await spacesAt(line4), [passage.id, platform.id].sort());
  assert.equal((await fetch(base + '/spaces?code=452')).status, 400);
  const changedLinks = await edit([line4], latest);
  assert.equal(changedLinks.status, 200);
  assert.equal((await edit([], latest)).status, 412);
  assert.deepEqual(await spacesAt(seohae), []);
  assert.equal((await edit([], changedLinks.headers.get('etag'))).status, 200);
  assert.deepEqual(await spacesAt(line4), [platform.id]);

  const route = [[12.75, -21.01], [12.96, 11.53], [-4.37, 11.50]];
  const endpoints = [{ ...line4, routeEndpoint: 'start' }, { ...seohae, routeEndpoint: 'end' }];
  const transfer = { ...passage.station, route, stationLinks: endpoints };
  const saveTransfer = body => fetch(base + '/spaces/' + passage.id, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await saveTransfer({ ...transfer, stationLinks: endpoints.map(stop => ({ ...stop, routeEndpoint: 'end' })) })).status, 400);
  assert.equal((await saveTransfer(transfer)).status, 200);
  assert.equal((await saveTransfer({ ...transfer, route: [], stationLinks: undefined })).status, 400);
  await app.close();
  await start();
  assert.deepEqual(await (await fetch(base + '/spaces/' + passage.id)).json(), transfer);
});
