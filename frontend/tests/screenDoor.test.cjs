const assert = require('node:assert/strict');
const { test } = require('node:test');
const { nearArrivalTag } = require('../src/ar/tagRouting.ts');
const { boardingTarget } = require('../src/navigation/stationProgress.ts');

const station = {
  tags: [{ id: 0, center: [0, 0] }, { id: 1, center: [4, 0] }, { id: 2, center: [8, 0], walkPoint: [8, 2] }],
  route: [[0, 0], [4, 0], [8, 2]], autoRoute: { startTag: 0, endTag: 2 },
  stationLinks: [{ line: '4호선', name: '초지', routeEndpoint: 'start' },
    { line: '서해선', name: '초지', routeEndpoint: 'end' }],
};

test('opens within one horizontal metre of the active destination tag, including legacy and wall tags', () => {
  assert.equal(nearArrivalTag(station, [7, 0, 1.6]), true);
  assert.equal(nearArrivalTag(station, [6.999, 0, 1.6]), false);
  assert.equal(nearArrivalTag(station, [8, 2, 1.6]), false); // The walk point and the tag position differ.
  assert.equal(nearArrivalTag(station, [4, 0, 1.6]), false);
  assert.equal(nearArrivalTag(station, [4, 0, 1.6], 1), true);
  assert.equal(nearArrivalTag(station, [0, 0, 1.6], 0), true);
  assert.equal(nearArrivalTag({ ...station, autoRoute: false }, [8, 0, 1.6]), true);
  assert.equal(nearArrivalTag({ ...station, autoRoute: false, route: [[0, 0], [20, 20]] }, [8, 0, 1.6]), false);
});

test('uses the outgoing rail direction before and after arrival, with no invented direction for indoor-only guidance', () => {
  const rail = (line, names) => ({ kind: '지하철', points: [], rail: { lines: [line], stops: names.map(name => ({ name })) } });
  const trip = { mode: 'transit', steps: [rail('4호선', ['정왕', '초지']), { kind: '도보', points: [] },
    rail('서해선', ['초지', '선부', '소사']), rail('1호선', ['소사', '용산'])] };
  for (const step of [0, 1, 2]) assert.deepEqual(boardingTarget(station, trip, step), { station: '초지', line: '서해선', toward: '선부' });
  assert.deepEqual(boardingTarget(station, undefined, 0), { station: '초지', line: '서해선' });
  assert.deepEqual(boardingTarget(station, undefined, 0, 0), { station: '초지', line: '4호선' });
  assert.deepEqual(boardingTarget(station, undefined, 0, 1), {});
});
