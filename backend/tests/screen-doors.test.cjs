const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');

const target = { station: '초지', line: '서해선', toward: '소사' };
const sign = { screenDoor: true, station: '초지', code: 'S26', line: null, toward: '선부' };

test('checks the boarding station, line and direction using only identifiable platform signs', async () => {
  const { checkDoor } = await import('../dist/screen-doors.controller.js');
  const verdict = (reading, changes) => checkDoor({ ...target, ...changes }, { ...sign, ...reading }).status;
  assert.equal(verdict({}), 'match');
  assert.equal(verdict({ station: null, code: 's26', toward: '일산' }), 'match');
  assert.equal(verdict({ toward: '시우역' }), 'mismatch');
  assert.equal(verdict({ code: '452', line: '4호선', toward: '고잔' }), 'mismatch');
  assert.equal(verdict({}, { station: '김포공항' }), 'mismatch');
  assert.equal(verdict({ screenDoor: false }), 'uncertain');
  assert.equal(verdict({ toward: null }), 'uncertain');
  assert.equal(verdict({ line: '4호선' }), 'uncertain'); // Line and station code contradict each other.
  assert.equal(verdict({ code: null }), 'match'); // This pair of station names identifies the Seohae Line.
  assert.equal(verdict({ code: null, toward: '고잔' }, { line: '4호선', toward: '중앙' }), 'uncertain'); // Shared tracks.
  assert.equal(verdict({ station: '강남', line: '2호선', code: '222', toward: '역삼' },
    { station: '강남', line: '2호선', toward: '시청' }), 'uncertain'); // Both ways around the loop reach City Hall.
  assert.equal(verdict({ station: '광화문', line: '5호선', code: null, toward: '마천' },
    { station: '광화문', line: '5호선', toward: '하남검단산' }), 'uncertain'); // Same initial direction, different branches.
});

test('HTTP upload sends the captured JPEG to the vision model and rejects unusable replies and photos', async t => {
  const { ScreenDoorsController } = await import('../dist/screen-doors.controller.js');
  class TestModule {}
  Module({ controllers: [ScreenDoorsController] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const url = await app.getUrl() + '/api/screen-doors/check';
  const http = globalThis.fetch;
  const jpeg = readFileSync(join(__dirname, 'fixtures/gangnam-sign.jpg'));
  const send = (image, type = 'image/jpeg', route = target) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(route)) form.append(key, value);
    if (image) form.append('image', new Blob([image], { type }), 'photo.jpg');
    return http(url, { method: 'POST', body: form });
  };
  for (const [key, value] of Object.entries({ CLIPROXY_BASE_URL: 'http://vision.test/v1/',
    CLIPROXY_MODEL: 'default-model', CLIPROXY_VISION_MODEL: 'vision-model' })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let content = JSON.stringify(sign), expectedModel = 'vision-model';
  const model = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://vision.test/v1/chat/completions');
    const request = JSON.parse(options.body);
    assert.equal(request.model, expectedModel);
    assert.deepEqual(request.messages[1].content.filter(part => part.type === 'image_url'), [{ type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,' + jpeg.toString('base64'), detail: 'high' } }]);
    assert.doesNotMatch(JSON.stringify(request.messages.filter(m => m.role === 'system').concat(
      request.messages[1].content.filter(part => part.type === 'text'))), /소사/);
    return Response.json({ choices: [{ message: { content } }] });
  });
  assert.equal((await send()).status, 400);
  assert.equal((await send(jpeg, 'image/jpeg', { line: '서해선' })).status, 400);
  assert.equal((await send(Buffer.from('not a photo'))).status, 415);
  assert.equal((await send(jpeg, 'text/plain')).status, 415);
  assert.equal(model.mock.callCount(), 0);
  const response = await send(jpeg);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'match');
  delete process.env.CLIPROXY_VISION_MODEL;
  expectedModel = 'default-model';
  content = '{"status":"match"}';
  assert.equal((await send(jpeg)).status, 502);
});
