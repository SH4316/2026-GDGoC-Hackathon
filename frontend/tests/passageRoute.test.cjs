const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the preview and remaining distance follow the bends of the registered passage', async () => {
  const { measurePassage, pointAlong, distanceAlong } = await import('../src/ar/passageRoute.ts');
  const route = measurePassage([[0, 0], [0, 2], [0, 5], [-4, 5], [-4, 7]]);
  assert.deepEqual(route.stages, [{ turn: 'straight', offset: 0 }, { turn: 'left', offset: 5 }, { turn: 'right', offset: 9 }]);
  assert.equal(route.length, 11);
  assert.deepEqual(pointAlong(route, 6), [-1, 5]);
  assert.deepEqual(pointAlong(route, 40), [-4, 7]);
  assert.equal(distanceAlong(route, [-1, 5.25]), 6);
  assert.equal(distanceAlong(route, [0, 5]), 5);
  assert.equal(distanceAlong(route, [8, 0]), undefined);
});

test('empty routes and positions on overlapping branches do not create false progress', async () => {
  const { measurePassage, distanceAlong } = await import('../src/ar/passageRoute.ts');
  assert.equal(measurePassage([]), undefined);
  assert.equal(measurePassage([[1, 1], [1, 1]]), undefined);
  const overlap = measurePassage([[0, 0], [0, 5], [0, 5], [0, 0]]);
  assert.deepEqual(overlap.stages[1], { turn: 'uturn', offset: 5 });
  assert.equal(distanceAlong(overlap, [0, 1]), undefined);
});
