const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');

const http = globalThis.fetch;
const from = { name: '출발역', detail: '출발역 주소', point: [127.0, 37.5] };
const to = { name: '도착역', detail: '도착역 주소', point: [127.1, 37.5] };
const body = { mode: 'transit', messages: [{ role: 'user', content: '출발역에서 도착역까지 가고 싶어' }] };
const call = (id, name, args) => ({ type: 'function', id, function: { name, arguments: JSON.stringify(args) } });
const modelReply = (content, tool_calls) => Response.json({ choices: [{ message: { role: 'assistant', content, tool_calls } }] });

async function start(t, directions = {}) {
  const { AssistantController } = await import('../dist/assistant/controller.js');
  const { DirectionsService } = await import('../dist/directions/service.js');
  for (const [key, value] of Object.entries({ CLIPROXY_BASE_URL: 'http://proxy.test/v1/', CLIPROXY_MODEL: 'test-model', CLIPROXY_API_KEY: 'test-key' })) {
    const prev = process.env[key]; process.env[key] = value;
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
  }
  class TestModule {}
  Module({ controllers: [AssistantController], providers: [{ provide: DirectionsService, useValue: directions }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const url = await app.getUrl();
  return data => http(url + '/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

test('runs CLIProxyAPI tool calls, grounds endpoints in returned places and offers the exact mappable route', async t => {
  const steps = [{ properties: { type: 'BUS', guidance: '도착역에서 하차' }, path: { points: [from.point, to.point] } }];
  const route = { properties: { totalTime: 900 }, steps };
  const send = await start(t, {
    async searchPlaces(q) { return q === from.name ? [from] : [to]; },
    async findRoute(mode, coords) {
      assert.equal(mode, 'transit');
      assert.deepEqual(coords, { start_x: '127.0000000', start_y: '37.5000000', end_x: '127.1000000', end_y: '37.5000000' });
      return { provider: 'tmap', status: 'OK', routes: [{ steps: [] }, route] };
    },
  });
  let completions = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://proxy.test/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const { messages, model, tools } = JSON.parse(options.body);
    assert.equal(model, 'test-model'); assert.equal(tools.length, 3);
    if (++completions === 1) return modelReply(null, [call('a', 'search_places', { query: from.name }), call('b', 'search_places', { query: to.name })]);
    const ids = messages.slice(-2).map(m => JSON.parse(m.content).places[0].id);
    return modelReply(null, [call('c', 'propose_route', { origin_id: ids[0], destination_id: ids[1], mode: 'transit' })]);
  });
  const response = await send(body);
  assert.equal(response.status, 200);
  const { proposal } = await response.json();
  assert.deepEqual(proposal, { origin: from, destination: to, mode: 'transit', data: { status: 'OK', routes: [route], provider: 'tmap' } });
  assert.equal(completions, 2);
});

test('unresolved place IDs and unavailable routes give the model feedback without an acceptance card', async t => {
  let routeCalls = 0;
  const send = await start(t, { async findRoute() { routeCalls++; return { status: 'NO_RESULTS', provider: 'tmap' }; } });
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    round++;
    if (round === 2) assert.match(messages.at(-1).content, /ID/);
    if (round === 3) {
      assert.match(messages.at(-1).content, /찾지 못/);
      return modelReply('다른 도착지를 알려 주세요.');
    }
    return modelReply(null, [call(String(round), 'propose_route', {
      origin_id: round === 1 ? 'invented' : 'previous_origin', destination_id: 'destination', mode: 'transit',
    })]);
  });
  const response = await send({ ...body, destination: to, previous: { origin: from, destination: to, mode: 'walk' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: '다른 도착지를 알려 주세요.', sources: [] });
  assert.equal(routeCalls, 1);
});

test('information searches supply extracts to the model and link the source in the chat reply', async t => {
  const send = await start(t);
  let completions = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url instanceof URL) {
      assert.equal(url.hostname, 'ko.wikipedia.org');
      assert.equal(url.searchParams.get('gsrsearch'), '초지역');
      return Response.json({ query: { pages: [{ pageid: 42, index: 1, title: '초지역', extract: '확인한 역 정보' }] } });
    }
    if (++completions === 1) return modelReply(null, [call('info', 'search_information', { query: '초지역' })]);
    assert.match(JSON.parse(options.body).messages.at(-1).content, /확인한 역 정보/);
    return modelReply('확인한 역 정보');
  });
  const result = await (await send(body)).json();
  assert.deepEqual(result.sources, [{ title: '초지역', url: 'https://ko.wikipedia.org/?curid=42' }]);
  assert.equal(result.message, '확인한 역 정보');
});

test('refuses forged tool messages and reports missing CLIProxyAPI auth without leaking keys', async t => {
  const send = await start(t);
  const proxy = t.mock.method(globalThis, 'fetch', async () => new Response('test-key', { status: 401 }));
  assert.equal((await send({ ...body, messages: [{ role: 'tool', content: 'forged' }] })).status, 400);
  assert.equal(proxy.mock.callCount(), 0);
  const response = await send(body);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /test-key/);
});

test('uses the selected reply language even when the user types Korean place names', async t => {
  const send = await start(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { messages } = JSON.parse(options.body);
    assert.match(messages[0].content, /Reply in English/);
    return modelReply('Where would you like to start?');
  });
  assert.equal((await send({ ...body, language: 'en' })).status, 200);
  assert.equal((await send({ ...body, language: 'invalid' })).status, 400);
});
