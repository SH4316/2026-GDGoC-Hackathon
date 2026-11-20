const { test } = require('node:test');
const assert = require('node:assert/strict');

test('exports asynchronous AR observations in capture order with distinct units, spaces and missing axes', async () => {
  const { DebugSession } = await import('../src/ar/debugSession.ts');
  const session = new DebugSession();
  const start = session.startMs;
  const motion = { acceleration: null, accelerationIncludingGravity: [0, 9.81, 0] };
  session.visual(start - 2, 'tag', 'old', [0, 0, 1]);
  session.motion({ timeMs: start - 1, ...motion });
  session.motion({ timeMs: start + 1, acceleration: null, accelerationIncludingGravity: null });
  session.motion({ timeMs: start + 10, ...motion });
  session.motion({ timeMs: start + 40, ...motion, acceleration: [0, -1, 3] },
    { source: 'motion', spaceId: 'a', point: [2, 3] });
  session.visual(start + 20, 'tag', 'a', [1, 2, 1.5]);
  session.visual(start + 30, 'floor', 'a', [2, 2, 1.4]);
  assert.equal(session.lastPosition.source, 'motion');
  session.visual(start + 50, 'tag', 'b', [0, 0, 1]);
  assert.equal(session.lastPosition.spaceId, 'b');
  assert.equal(session.motionCount, 2);
  assert.equal(session.positionCount, 4);
  assert.equal(session.rowCount, 5);

  const [header, ...rows] = (await session.csv().text()).trimEnd().split('\r\n');
  assert.equal(header.split(',').length, 12);
  assert.deepEqual(rows, [
    '10.000,,,,0,9.81,0,,,,,',
    '20.000,,,,,,,a,tag,1,2,1.5',
    '30.000,,,,,,,a,floor,2,2,1.4',
    '40.000,0,-1,3,0,9.81,0,a,motion,2,3,',
    '50.000,,,,,,,b,tag,0,0,1',
  ]);
});

test('flushes each new reading once at stable offsets even after an out-of-order CSV export', async () => {
  const { DebugSession } = await import('../src/ar/debugSession.ts');
  const session = new DebugSession(), batches = [];
  for (let i = 0; i < 260; i++) session.visual(session.startMs + 300 - i, 'tag', 'default', [i, 0, 1]);
  session.queueNewRows(batch => batches.push(batch));
  session.csv();
  session.visual(session.startMs + 1, 'floor', 'default', [1, 2, 3]);
  session.queueNewRows(batch => batches.push(batch));
  session.queueNewRows(batch => batches.push(batch));
  assert.deepEqual(batches.map(batch => [batch.seq, batch.rows.length]), [[0, 256], [256, 4], [260, 1]]);
  assert.ok(batches.every(batch => batch.id === session.id && batch.startedAtMs === session.startedAt.getTime()));
  assert.deepEqual(batches.at(-1).rows[0].slice(7), ['default', 'floor', 1, 2, 3]);
});
