const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm, utimes, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');

const coordinates = 'start_x=127.11119217&start_y=37.39477123&end_x=127.12628814&end_y=37.41993056';
const clientFetch = globalThis.fetch;

async function startApi(t, kakaoKey, tmapKey = '', cacheDir = '') {
  for (const [name, key] of Object.entries({
    KAKAO_REST_API_KEY: kakaoKey, TMAP_APP_KEY: tmapKey,
    DIRECTIONS_TEST_CACHE: cacheDir ? '1' : '0', DIRECTIONS_CACHE_DIR: cacheDir,
  })) {
    const previous = process.env[name];
    process.env[name] = key;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const { DirectionsController } = await import('../dist/directions.controller.js');
  const { DirectionsService } = await import('../dist/directions/service.js');
  class TestModule {}
  Module({ controllers: [DirectionsController], providers: [DirectionsService] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  return (mode, query = coordinates) => clientFetch(`${base}/api/directions/${mode}?${query}`);
}

test('relays walking and transit results and preserves route search statuses', async t => {
  const request = await startApi(t, 'test-key');
  const step = { properties: { guidance: '도착지까지 이동' }, path: { points: [[127.12628, 37.41993]] } };
  for (const [mode, upstream, payload] of [
    ['walk', 'walk', { status: 'OK', route: { legs: [{ steps: [step] }] } }],
    ['transit', 'publictraffic', { status: 'OK', routes: [{ properties: { transfers: 1 }, steps: [step] }] }],
    ['transit', 'publictraffic', { status: 'NO_RESULTS' }],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url.origin + url.pathname, 'https://dapi.kakao.com/v2/routing/' + upstream);
      assert.deepEqual([...url.searchParams], [...new URLSearchParams(coordinates)]);
      assert.equal(options.headers.Authorization, 'KakaoAK test-key');
      return Response.json(payload);
    });
    const res = await request(mode);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...payload, provider: 'kakao' });
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test('rejects invalid requests and handles missing server keys before calling a provider', async t => {
  const request = await startApi(t, '');
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected upstream request'); });
  for (const query of ['', coordinates.replace('37.39477123', '91'), coordinates.replace('127.11119217', ''),
    coordinates + '&start_x=128', coordinates + '&input_coord=TM']) {
    assert.equal((await request('walk', query)).status, 400);
  }
  assert.equal((await request('car')).status, 400);
  assert.equal((await request('transit')).status, 503);
  assert.equal((await request('places', 'q=')).status, 400);
  assert.equal((await request('places', 'q=station')).status, 503);
  assert.equal(upstream.mock.callCount(), 0);
});

test('searches Kakao places with the server key and returns coordinates for the selected result', async t => {
  const request = await startApi(t, 'test-key');
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://dapi.kakao.com/v2/local/search/keyword.json');
    assert.equal(url.searchParams.get('query'), '초지역');
    assert.equal(options.headers.Authorization, 'KakaoAK test-key');
    return Response.json({ documents: [{ place_name: '초지역', address_name: '안산시', road_address_name: '',
      x: '126.805913', y: '37.320646' }] });
  });
  const query = new URLSearchParams({ q: '초지역' });
  const result = await request('places', query);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), [{ name: '초지역', detail: '안산시', point: [126.805913, 37.320646] }]);
  upstream.mock.mockImplementation(async () => Response.json({ documents: [] }));
  assert.deepEqual(await (await request('places', query)).json(), []);
  upstream.mock.mockImplementation(async () => Response.json({ invalid: true }));
  assert.equal((await request('places', query)).status, 502);
});

test('translates upstream failures without exposing Kakao error bodies', async t => {
  const request = await startApi(t, 'test-key');
  const upstream = t.mock.method(globalThis, 'fetch');
  for (const [response, expected] of [
    [Response.json({ code: -10 }, { status: 400 }), 429],
    [Response.json({ msg: 'test-key' }, { status: 401 }), 503],
    [new Response('Service unavailable', { status: 503 }), 502],
    [new Response('Invalid JSON'), 502],
  ]) {
    upstream.mock.mockImplementation(async () => response);
    const res = await request('walk');
    assert.equal(res.status, expected);
    assert.doesNotMatch(await res.text(), /test-key/);
  }
  upstream.mock.mockImplementation(async () => { throw new TypeError('Connection failed'); });
  assert.equal((await request('walk')).status, 502);

  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError')));
  upstream.mock.mockImplementation(async (_url, { signal }) => signal.throwIfAborted());
  assert.equal((await request('walk')).status, 504);
});

test('TMAP alone supports place search, walking and mixed transit through the existing API', async t => {
  const request = await startApi(t, '', 'tmap-key');
  const start = [127.11119217, 37.39477123];
  const stop = [127.12, 37.4];
  const transfer = [127.121, 37.41];
  const end = [127.12628814, 37.41993056];
  const stopInfo = ([lon, lat], name) => ({ lon, lat, name });
  const line = (...pairs) => pairs.map(point => point.join(',')).join(' ');
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.origin, 'https://apis.openapi.sk.com');
    assert.equal(options.headers.appKey, 'tmap-key');
    switch (url.pathname) {
      case '/tmap/pois':
        assert.equal(url.searchParams.get('searchKeyword'), '초지역');
        assert.equal(url.searchParams.get('resCoordType'), 'WGS84GEO');
        return Response.json({ searchPoiInfo: { pois: { poi: [{
          name: '초지역', pnsLon: '126.805913', pnsLat: '37.320646', frontLon: '126.8', frontLat: '37.3',
          newAddressList: { newAddress: [{ fullAddressRoad: '안산시 중앙대로' }] },
        }, {
          name: '초지역 버스정류장', pnsLon: '0', pnsLat: '0', frontLon: '126.801', frontLat: '37.31',
          middleAddrName: '안산시', lowerAddrName: '초지동',
        }] } } });
      case '/tmap/routes/pedestrian':
        assert.equal(options.method, 'POST');
        assert.equal(url.searchParams.get('version'), '1');
        assert.deepEqual(JSON.parse(options.body), {
          startX: start[0], startY: start[1], endX: end[0], endY: end[1], reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
          startName: encodeURIComponent('출발지'), endName: encodeURIComponent('도착지'), sort: 'index',
        });
        return Response.json({ type: 'FeatureCollection', features: [
          { geometry: { type: 'Point', coordinates: start }, properties: { description: '직진하세요', totalDistance: 400, totalTime: 300 } },
          { geometry: { type: 'LineString', coordinates: [start, end] }, properties: { description: '도로 이름', distance: 400 } },
          { geometry: { type: 'Point', coordinates: end }, properties: { description: '도착' } },
        ] });
      case '/transit/routes':
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {
          startX: String(start[0]), startY: String(start[1]), endX: String(end[0]), endY: String(end[1]),
          count: 3, lang: 0, format: 'json',
        });
        return Response.json({ metaData: { plan: { itineraries: [{
          totalTime: 859, totalDistance: 3300, transferCount: 1, fare: { regular: { totalFare: 1500 } },
          legs: [
            { mode: 'WALK', start: stopInfo(start, '출발지'), end: stopInfo(stop, '테스트 정류장'),
              steps: [{ linestring: line(start, stop), description: '정류장까지 직진', distance: 250 }] },
            { mode: 'BUS', route: '400번', start: stopInfo(stop, '테스트 정류장'), end: stopInfo(transfer, '환승역'),
              passShape: { linestring: line(stop, transfer) }, distance: 1200 },
            { mode: 'SUBWAY', route: '2호선', start: stopInfo(transfer, '환승역'), end: stopInfo(end, '도착역'),
              passStopList: { stations: [
                { stationName: '환승역', lon: transfer[0], lat: transfer[1] },
                { stationName: '경유역', lon: '127.123', lat: '37.415' },
                { stationName: '도착역', lon: end[0], lat: end[1] },
              ] }, distance: 1850 },
          ],
        }] } } });
      default:
        assert.fail('Unexpected upstream path');
    }
  });

  const places = await request('places', new URLSearchParams({ q: '초지역' }));
  assert.equal(places.status, 200);
  assert.deepEqual(await places.json(), [
    { name: '초지역', detail: '안산시 중앙대로', point: [126.805913, 37.320646] },
    { name: '초지역 버스정류장', detail: '안산시 초지동', point: [126.801, 37.31] },
  ]);
  const reqWalk = await request('walk');
  assert.equal(reqWalk.status, 200);
  const walk = await reqWalk.json();
  assert.equal(walk.provider, 'tmap');
  assert.deepEqual(walk.route.properties, { totalDistance: 400, totalTime: 300 });
  assert.deepEqual(walk.route.legs[0].steps, [{
    properties: { type: 'WALKING', guidance: '직진하세요', distance: 400 }, path: { points: [start, end] },
  }]);
  const reqTransit = await request('transit');
  assert.equal(reqTransit.status, 200);
  const transit = await reqTransit.json();
  assert.equal(transit.provider, 'tmap');
  assert.deepEqual(transit.routes[0].properties, { totalTime: 859, totalDistance: 3300, transfers: 1, fare: { value: 1500 } });
  assert.deepEqual(transit.routes[0].steps.map(step => step.properties.type), ['WALKING', 'BUS', 'SUBWAY']);
  assert.equal(transit.routes[0].steps[1].properties.guidance, '테스트 정류장에서 400번 탑승 → 환승역에서 하차');
  assert.deepEqual(transit.routes[0].steps[2].path.points, [transfer, [127.123, 37.415], end]);
  assert.deepEqual(transit.routes[0].steps[2].properties.stops, [
    { name: '환승역', point: transfer }, { name: '경유역', point: [127.123, 37.415] }, { name: '도착역', point: end },
  ]);
  assert.deepEqual(transit.routes[0].steps[2].properties.vehicles, [{ name: '2호선' }]);
  assert.equal(upstream.mock.callCount(), 3);
});

test('prefers TMAP with both keys and reports provider failures without another request', async t => {
  const request = await startApi(t, 'kakao-key', 'tmap-key');
  const upstream = t.mock.method(globalThis, 'fetch');
  for (const [payload, status] of [
    [{ result: { status: 14 } }, 200],
    [{ result: { status: 31 } }, 504],
    [{ error: 'tmap-key' }, 503],
    [{ error: 'too many requests' }, 429],
    [{ metaData: {} }, 502],
  ]) {
    upstream.mock.mockImplementation(async url => {
      assert.equal(url.href, 'https://apis.openapi.sk.com/transit/routes');
      return Response.json(payload, { status: status === 503 ? 403 : status === 429 ? 429 : 200 });
    });
    const result = await request('transit');
    assert.equal(result.status, status);
    if (status === 200) assert.deepEqual(await result.json(), { status: 'NO_RESULTS', provider: 'tmap' });
    else assert.doesNotMatch(await result.text(), /tmap-key/);
  }
  assert.equal(upstream.mock.callCount(), 5);
  upstream.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  assert.deepEqual(await (await request('places', 'q=missing')).json(), []);
  assert.deepEqual(await (await request('walk')).json(), { status: 'NO_RESULTS', provider: 'tmap' });
});

test('permanently reuses response files by provider, search text, mode and coordinates', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'directions-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const placeQuery = new URLSearchParams({ q: '초지역' });
  const route = { status: 'OK', route: { legs: [] } };
  const places = [{ name: '초지역', detail: '안산시', point: [126.805913, 37.320646] }];

  await t.test('writes one private response file for concurrent requests', async t => {
    const request = await startApi(t, 'test-kakao-key', '', directory);
    const upstream = t.mock.method(globalThis, 'fetch', async url => {
      await delay(25);
      if (url.pathname.endsWith('/keyword.json')) return Response.json({
        documents: [{ place_name: '초지역', address_name: '안산시', x: '126.805913', y: '37.320646' }],
      });
      return Response.json(route);
    });

    const search = await request('places', placeQuery);
    assert.deepEqual(await search.json(), places);
    const equivalent = 'end_y=37.419930560&end_x=127.12628814&start_y=37.39477123&start_x=127.111192170';
    const responses = await Promise.all([request('walk'), request('walk', equivalent), request('walk')]);
    for (const response of responses) assert.deepEqual(await response.json(), { ...route, provider: 'kakao' });
    assert.equal(upstream.mock.callCount(), 2);

    const files = (await readdir(directory)).sort();
    assert.match(files[0], /^kakao-places-[a-f0-9]{64}\.json$/);
    assert.match(files[1], /^kakao-walk-[a-f0-9]{64}\.json$/);
    assert.equal(files.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(directory, files[0]), 'utf8')), places);
    assert.deepEqual(JSON.parse(await readFile(join(directory, files[1]), 'utf8')), route);
    for (const file of files) await utimes(join(directory, file), new Date(0), new Date(0));
  });

  await t.test('restarts with the saved files and keeps misses and errors independent', async t => {
    const request = await startApi(t, 'test-kakao-key', '', directory);
    const upstream = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 429 }));
    assert.deepEqual(await (await request('places', placeQuery)).json(), places);
    assert.deepEqual(await (await request('places', new URLSearchParams({ q: ' 초지역 ' }))).json(), places);
    assert.deepEqual(await (await request('walk')).json(), { ...route, provider: 'kakao' });
    assert.equal(upstream.mock.callCount(), 0);

    const differentCoordinates = coordinates.replace('127.12628814', '127.12628815');
    assert.equal((await request('walk', differentCoordinates)).status, 429);
    assert.equal((await request('transit')).status, 429);
    assert.equal((await request('places', 'q=different')).status, 429);
    assert.equal((await readdir(directory)).length, 2);
    upstream.mock.mockImplementation(async url => Response.json(
      url.pathname.endsWith('/keyword.json') ? { documents: [] } : { status: 'NO_RESULTS' },
    ));
    assert.deepEqual(await (await request('transit')).json(), { status: 'NO_RESULTS', provider: 'kakao' });
    assert.deepEqual(await (await request('places', 'q=different')).json(), []);
    assert.deepEqual(await (await request('places', 'q=different')).json(), []);
    assert.equal(upstream.mock.callCount(), 5);

    const walkFile = (await readdir(directory)).find(file => file.startsWith('kakao-walk-'));
    await writeFile(join(directory, walkFile), '{');
    upstream.mock.mockImplementation(async () => Response.json(route));
    assert.deepEqual(await (await request('walk')).json(), { ...route, provider: 'kakao' });
    assert.deepEqual(JSON.parse(await readFile(join(directory, walkFile), 'utf8')), route);
    assert.equal(upstream.mock.callCount(), 6);
  });

  await t.test('does not reuse the Kakao files for TMAP', async t => {
    const request = await startApi(t, '', 'test-tmap-key', directory);
    const upstream = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
    assert.deepEqual(await (await request('places', placeQuery)).json(), []);
    assert.deepEqual(await (await request('walk')).json(), { status: 'NO_RESULTS', provider: 'tmap' });
    assert.deepEqual(await (await request('walk')).json(), { status: 'NO_RESULTS', provider: 'tmap' });
    assert.equal(upstream.mock.callCount(), 2);
  });
});

test('an exact legacy TMAP transit route bridges transient failures until a current response is available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-transit-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const request = await startApi(t, '', 'tmap-key', directory);
  const input = [...new URLSearchParams(coordinates).values()];
  const hash = createHash('sha256').update(JSON.stringify([1, 'tmap', 'transit', input])).digest('hex');
  const file = 'tmap-transit-' + hash + '.json';
  const step = { properties: { type: 'SUBWAY', guidance: '정왕에서 수도권4호선 탑승 → 초지에서 하차' },
    path: { points: [[126.742931, 37.3518], [126.805994, 37.320667]] } };
  const saved = { status: 'OK', routes: [{ steps: [step] }] };
  await writeFile(join(directory, file), JSON.stringify(saved));
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Offline'); });
  for (const failure of [
    async () => { throw new TypeError('Offline'); },
    async () => new Response(null, { status: 503 }),
    async () => new Response(null, { status: 429 }),
  ]) {
    mock.mock.mockImplementation(failure);
    assert.deepEqual(await (await request('transit')).json(), { ...saved, provider: 'tmap' });
  }
  assert.deepEqual(await readdir(directory), [file]);
  assert.equal((await request('transit', coordinates.replace('127.12628814', '127.12628815'))).status, 429);
  mock.mock.mockImplementation(async () => Response.json({ metaData: {} }));
  assert.equal((await request('transit')).status, 502);
  mock.mock.mockImplementation(async () => new Response('Invalid JSON'));
  assert.equal((await request('transit')).status, 502);
  mock.mock.mockImplementation(async () => new Response(null, { status: 403 }));
  assert.equal((await request('transit')).status, 503);
  mock.mock.mockImplementation(async () => new Response(null, { status: 204 }));
  const noRoute = { status: 'NO_RESULTS', provider: 'tmap' };
  assert.deepEqual(await (await request('transit')).json(), noRoute);
  const calls = mock.mock.callCount();
  mock.mock.mockImplementation(async () => new Response(null, { status: 429 }));
  assert.deepEqual(await (await request('transit')).json(), noRoute);
  assert.equal(mock.mock.callCount(), calls);
});
