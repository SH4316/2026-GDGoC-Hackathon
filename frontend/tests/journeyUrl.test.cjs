const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clearJourney, encodePlace, decodePlace, journeyView, readProgress } = require('../src/navigation/journeyUrl.ts');
const { withQuery } = require('../src/urlState.ts');
const { readLanguage } = require('../src/i18n/language.ts');
const { indoorCue } = require('../src/ar/indoorGuidance.ts');
const { placeLabel, routeInstruction } = require('../src/navigation/routeInstruction.ts');
const { stationLabel } = require('../src/i18n/stationLabel.ts');

test('shares place data, language and options through a URL without losing the base path or fragment', () => {
  const place = { name: '역 & 출구 #1', detail: 'A+B, 50% / "동쪽"', point: [126.805913, 37.320646] };
  const url = withQuery(new URL('https://example.org/app/?vp=0&space=abc#map'), { from: encodePlace(place), lang: 'en' });
  assert.deepEqual(decodePlace(new URL(url.href).searchParams.get('from')), place);
  assert.equal(readLanguage(url.search), 'en');
  assert.equal(withQuery(url, { from: null }).href, 'https://example.org/app/?vp=0&space=abc&lang=en#map');
  for (const invalid of ['{}', 'null', '[192,37,"A",""]', '[127,"37","A",""]', '[]', '["",""]', '[127,37," ",""]'])
    assert.equal(decodePlace(invalid), undefined);
  assert.equal(readLanguage('?lang=unknown'), 'ko');
});

test('distinguishes the legacy camera, indoor-only guidance and a route-backed transfer', () => {
  assert.equal(journeyView('ar', false), 'field');
  assert.equal(journeyView('indoor', false), 'indoor');
  assert.equal(journeyView('transfer', true), 'transfer');
  assert.equal(journeyView('map', false), 'home');
  assert.equal(journeyView('transfer', false), 'home');
  assert.deepEqual(readProgress(new URLSearchParams('step=3&station=초지&stop=0&tagTime=100'), 5),
    { step: 3, station: '초지', stopIndex: 0, tagTime: 100 });
  assert.equal(readProgress(new URLSearchParams('step=50'), 4).step, 4);
  assert.equal(readProgress(new URLSearchParams('step=3x'), 4).step, 0);
});

test('Home clears setup, progress and camera filters while preserving language and page options', () => {
  const url = new URL('https://example.org/app/?lang=en&vp=0#map');
  for (const key of ['from', 'to', 'mode', 'autoOrigin', 'pick', 'q', 'search', 'view', 'space', 'map', 'step',
    'station', 'stop', 'tagTime', 'scan', 'panel', 'target', 'targetSpace', 'preferredSpace', 'dialog', 'passage', 'stage']) {
    url.searchParams.set(key, 'saved');
  }
  assert.equal(withQuery(url, clearJourney).href, 'https://example.org/app/?lang=en&vp=0#map');
});

test('localizes navigation cues while preserving station data and the identity of a turn', () => {
  const space = { id: 'hall', station: { stationLinks: [{ routeEndpoint: 'end', line: '서해선' }] } };
  const maneuver = { kind: 'left', index: 1, stage: 'now' };
  const korean = indoorCue(space, maneuver, false);
  const english = indoorCue(space, maneuver, false, undefined, 'en');
  assert.equal(english.key, korean.key);
  assert.equal(english.turn.action, 'Turn left here.');
  assert.equal(indoorCue(space, undefined, true, 0, 'en').text, 'You have reached tag 0.');
  assert.equal(routeInstruction({ instruction: '좌회전 후 보행자도로를 따라 30m 이동' }, 'en'), 'Turn left, then walk 30 m along the footpath.');
  assert.equal(routeInstruction({ instruction: '현장 안내문' }, 'en'), '현장 안내문');
});

test('route labels use the sign reader station names, including exits and older rail instructions', () => {
  assert.deepEqual(require('../src/i18n/station-names.json'), require('../../backend/signs/network.json').englishNames);
  const leg = { kind: '지하철', instruction: '정왕에서 수도권4호선 탑승 → 초지에서 하차' };
  assert.equal(routeInstruction(leg, 'en'), 'Take Line 4 from Jeongwang to Choji.');
  assert.equal(routeInstruction(leg, 'ko'), leg.instruction);
  assert.equal(stationLabel('초지역', 'en', true), 'Choji (초지)');
  assert.equal(placeLabel('소사역[서해선]', 'en'), 'Sosa · Seohae Line');
  assert.equal(placeLabel('소사역 3번출구', 'en'), 'Sosa Exit 3');
  assert.equal(stationLabel('미등록역', 'en', true), '미등록역');
  assert.equal(placeLabel('초지역앞상가', 'en'), '초지역앞상가');
});
