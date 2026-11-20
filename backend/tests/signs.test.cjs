const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const installed = existsSync(path.join(__dirname, '../signs/.runtime/bin/python')) &&
  existsSync(path.join(__dirname, '../signs/.runtime/models/korean_PP-OCRv5_rec_mobile.onnx'));

test('isolates concurrent OCR requests, rejects a damaged frame, and recovers after a worker exits',
  { skip: !installed && 'install the sign OCR runtime to run this integration test' }, async t => {
    const { SignsController } = await import('../dist/signs.controller.js');
    const reader = new SignsController();
    t.after(() => reader.onApplicationShutdown());
    const file = { mimetype: 'image/jpeg', buffer: readFileSync(path.join(__dirname, 'fixtures/gangnam-sign.jpg')) };
    const bad = { ...file, buffer: Buffer.from('invalid') };

    const first = reader.recognize([file]);
    const second = reader.recognize([bad, file]);
    await assert.rejects(reader.recognize([file]), e => e.getStatus() === 503);
    await assert.rejects(second, e => e.getStatus() === 400);
    assert.equal((await first).toward, '교대');

    const burst = await reader.recognize([file, file, file]);
    assert.equal(burst.toward, '교대');
    assert.equal(reader.workers.size, 2);
    const interrupted = reader.recognize([file]);
    const active = [...reader.workers].find(w => w.busy);
    active.child.kill('SIGKILL');
    await assert.rejects(interrupted, e => e.getStatus() === 503);
    const recovered = await Promise.all([reader.recognize([file]), reader.recognize([file])]);
    assert.deepEqual(recovered.map(r => r.current.name), ['강남', '강남']);
  });
