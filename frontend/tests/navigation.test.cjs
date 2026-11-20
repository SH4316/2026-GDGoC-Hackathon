const { test } = require('node:test');
const assert = require('node:assert/strict');

const start = { name: '출발', detail: '', point: [127.01, 37.5] };
const end = { name: '도착', detail: '', point: [127.02, 37.51] };
const change = [127.014, 37.503];
const walk = { properties: { guidance: '역 입구까지 이동', distance: 195, type: 'WALKING' }, path: { points: [start.point, change] } };
const ride = { properties: { guidance: '지하철 탑승', type: 'SUBWAY' }, path: { points: [change, end.point] } };

test('keeps WGS84 path and guidance together for multi-leg walking and a usable transit alternative', async () => {
  const { readRoute } = await import('../src/navigation/routes.ts');
  const transit = readRoute({ status: 'OK', provider: 'tmap', routes: [{ steps: [] }, {
    properties: { totalTime: 700 }, steps: [walk, ride],
  }] }, start, end, 'transit');
  assert.deepEqual(transit.steps.map(s => s.kind), ['도보', '지하철']);
  assert.deepEqual(transit.steps[1].points, [change, end.point]);
  assert.equal(transit.seconds, 700);
  assert.equal(transit.provider, 'tmap');

  const walking = readRoute({ status: 'OK', route: { legs: [{ steps: [walk] }, { steps: [ride] }] } }, start, end, 'walk');
  assert.equal(walking.steps.length, 2);
  assert.equal(walking.steps[0].instruction, walk.properties.guidance);
  assert.throws(() => readRoute({ status: 'NO_RESULTS' }, start, end, 'transit'), /찾을 수 없/);
  assert.throws(() => readRoute({ status: 'OK', routes: [{ steps: [{ path: { points: [[185, 45]] } }] }] }, start, end, 'transit'), /경로 좌표/);
});

test('advances on a precise location at the end of the active leg and stops at arrival', async () => {
  const { readRoute, nextStepAt } = await import('../src/navigation/routes.ts');
  const { steps } = readRoute({ status: 'OK', routes: [{ steps: [walk, ride] }] }, start, end, 'transit');
  assert.equal(nextStepAt(steps, 0, start.point, 5), 0);
  assert.equal(nextStepAt(steps, 0, change, 90), 0);
  assert.equal(nextStepAt(steps, 0, change, 5), 1);
  assert.equal(nextStepAt(steps, 1, end.point, 5), 2);
  assert.equal(nextStepAt(steps, 2, end.point, 5), 2);
});

test('uses the next mapped boundary for instructions without geometry', async () => {
  const { nextStepAt } = await import('../src/navigation/routes.ts');
  const unmapped = { kind: '도보', instruction: '역 입구까지 이동', points: [] };
  const steps = [unmapped, unmapped, { ...unmapped, points: [change, end.point] }, unmapped];
  assert.equal(nextStepAt(steps, 0, start.point, 5, end.point), 0);
  assert.equal(nextStepAt(steps, 0, change, 5, end.point), 2);
  assert.equal(nextStepAt(steps, 3, end.point, 5, end.point), 4);
});

test('scanned stops advance through rail stations and a confirmed corridor arrival resumes boarding without GPS', async () => {
  const { readRoute, progressAtGps } = await import('../src/navigation/routes.ts');
  const { progressAtTag, progressAtIndoorArrival, routeTransfers } = await import('../src/navigation/stationProgress.ts');
  const rail = (line, names) => ({
    properties: { type: 'SUBWAY', vehicles: [{ name: line }], stops: names.map(name => ({ name })) },
    path: { points: [change, end.point] },
  });
  const trip = readRoute({ status: 'OK', routes: [{ steps: [walk,
    rail('수도권4호선', ['정왕', '안산', '초지']), walk, rail('서해선', ['초지', '소사']), walk] }] },
    start, { ...end, name: '소사역 3번출구' }, 'transit');
  const transfer = { route: [[0, 0], [20, 0]], tags: [0, 10, 20].map(id => ({ id, center: [id, 0] })),
    stationLinks: [{ name: '초지', line: '4호선', routeEndpoint: 'start' }, { name: '초지', line: '서해선', routeEndpoint: 'end' }] };
  const space = (name, line) => ({ ...transfer, stationLinks: [{ name, line }] });
  const scan = (progress, layout, tag = 0) => progressAtTag(trip, progress, layout, tag, 100);
  const initial = { step: 0 };
  assert.equal(scan(initial, space('초지', '수인분당선')), initial);
  assert.equal(scan(initial, space('안산', '4호선'), 99), initial);
  assert.equal(scan(initial, { ...transfer, stationLinks: [] }), initial);
  const boarded = scan(initial, space('정왕', '4호선'));
  assert.equal(boarded.step, 1);
  const midway = scan(boarded, space('안산', '4호선'));
  assert.equal(midway.step, 1);
  assert.equal(midway.station, '안산');
  assert.equal(midway.position, undefined); // Kakao supplies no coordinates for an intermediate stop.
  assert.equal(scan(midway, space('정왕', '4호선')), midway);
  const arrived = scan(initial, transfer);
  assert.deepEqual(arrived, { step: 2, station: '초지', stopIndex: -1, tagTime: 100, position: end.point });
  assert.equal(scan(arrived, transfer), arrived);
  assert.equal(scan(arrived, transfer, 10), arrived);
  assert.equal(progressAtGps(trip, arrived, start.point, 10, 101), arrived);
  const layout = { id: 'corridor', station: transfer };
  assert.deepEqual(routeTransfers(trip, [layout, { ...layout, id: 'other-corridor' }]), [{
    spaceId: 'corridor', station: '초지역', fromLine: '4호선', toLine: '서해선',
    transferStep: 2, boardingStep: 3, point: change,
  }]);
  assert.equal(scan(arrived, transfer, 20), arrived);
  const transferred = progressAtIndoorArrival(trip, arrived, layout, 101);
  assert.deepEqual(transferred, { step: 3, stopIndex: 0, station: '초지', position: change, tagTime: 101 });
  assert.equal(progressAtIndoorArrival(trip, transferred, layout, 102), transferred);
  assert.equal(progressAtGps(trip, transferred, start.point, 5, 110), transferred);
  assert.equal(progressAtIndoorArrival(trip, transferred, layout, 98), transferred);
  assert.equal(scan(transferred, transfer, 0), transferred);
  const lastWalk = scan(transferred, space('소사', '서해선'));
  assert.equal(lastWalk.step, 4);
  assert.equal(progressAtGps(trip, lastWalk, change, 5, 99), lastWalk);
  assert.equal(progressAtGps(trip, lastWalk, change, 5, 101).step, 5);
});

test('older TMAP responses can identify a registered directed transfer from connected rail endpoints', async () => {
  const { readRoute } = await import('../src/navigation/routes.ts');
  const { routeTransfers, progressAtIndoorArrival, progressAtTag } = await import('../src/navigation/stationProgress.ts');
  const alight = [126.805994, 37.320667], board = [126.808422, 37.320639];
  const inbound = { properties: { type: 'SUBWAY', guidance: '정왕에서 수도권4호선 탑승 → 초지에서 하차' }, path: { points: [start.point, alight] } };
  const outbound = { properties: { type: 'SUBWAY', guidance: '초지에서 서해선 탑승 → 소사에서 하차' }, path: { points: [board, end.point] } };
  const journey = (steps, provider = 'tmap') => readRoute({ status: 'OK', provider, routes: [{ steps }] }, start, end, 'transit');
  const corridor = { id: 'space', station: { tags: [{ id: 0, center: [0, 0] }], route: [[0, 0], [5, 0]],
    stationLinks: [{ name: '초지', line: '4호선', routeEndpoint: 'start' }, { name: '초지', line: '서해선', routeEndpoint: 'end' }] } };
  const route = journey([walk, inbound, walk, walk, outbound, walk]);
  const [transfer] = routeTransfers(route, [corridor]);
  assert.equal(transfer.transferStep, 2);
  assert.equal(transfer.boardingStep, 4);
  assert.deepEqual(transfer.point, board);
  assert.equal(routeTransfers(journey([inbound, outbound]), [corridor])[0].transferStep, 1);
  const initial = { step: 0 };
  const reverse = { ...corridor, station: { ...corridor.station, stationLinks: corridor.station.stationLinks.map(link => ({
    ...link, routeEndpoint: link.routeEndpoint === 'start' ? 'end' : 'start',
  })) } };
  assert.equal(progressAtIndoorArrival(route, initial, reverse, 100), initial);
  assert.equal(progressAtTag(route, initial, reverse.station, 0, 100), initial);
  assert.deepEqual(routeTransfers(route, [reverse]), []);
  assert.deepEqual(routeTransfers(journey([inbound, outbound], 'kakao'), [corridor]), []);
  assert.deepEqual(routeTransfers(journey([inbound, { ...outbound, path: { points: [end.point, start.point] } }]), [corridor]), []);
  assert.deepEqual(routeTransfers(journey([inbound, { ...outbound, properties: { ...outbound.properties, type: 'BUS' } }, outbound]), [corridor]), []);
  assert.deepEqual(routeTransfers(journey([inbound, { ...outbound, properties: { ...outbound.properties,
    stops: [{ name: '선부' }, { name: '소사' }], vehicles: [{ name: '서해선' }],
  } }]), [corridor]), []);
});

test('a station destination can be reached on foot and ambiguous spaces need an identified endpoint', async () => {
  const { readRoute } = await import('../src/navigation/routes.ts');
  const { progressAtTag } = await import('../src/navigation/stationProgress.ts');
  const trip = readRoute({ status: 'OK', route: { legs: [{ steps: [walk] }] } },
    start, { ...end, name: '초지역[수도권4호선]' }, 'walk');
  const layout = { route: [[0, 0], [20, 0]], tags: [0, 10, 20].map(id => ({ id, center: [id, 0] })),
    stationLinks: [{ name: '정왕', line: '4호선', routeEndpoint: 'start' }, { name: '초지', line: '4호선', routeEndpoint: 'end' }] };
  const initial = { step: 0 };
  assert.equal(progressAtTag(trip, initial, layout, 10, 100), initial);
  assert.equal(progressAtTag(trip, initial, layout, 0, 100), initial);
  const arrived = progressAtTag(trip, initial, layout, 20, 100);
  assert.equal(arrived.step, trip.steps.length);
  assert.deepEqual(arrived.position, trip.destination.point);
  assert.equal(progressAtTag(trip, arrived, layout, 20, 110), arrived);
});
