const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { indoorCue } = require('../src/ar/indoorGuidance.ts');

const worker = readFileSync(join(__dirname, '../public/ar/tracker.js'), 'utf8');
const space = { id: 'hall', station: {} };

function guidance(points) {
  return runInNewContext(worker + `
    station = {};
    layouts = new Map([['hall', station]]);
    setPath([], points);
    ({
      visual(point, bearing, visible = true) {
        const rad = typeof bearing === 'number' ? bearing * Math.PI / 180 : 0;
        const cameraToWorld = Array.isArray(bearing) ? bearing : [0, 0, Math.sin(rad), 0, 0, 0, Math.cos(rad)];
        const project = outline => visible ? outline : null;
        return visualGuidance(routePosition(point), { cameraToWorld }, project, () => 1, [-100,-100,100,100]);
      },
      walk(point, headingDeg) { return walkingPreview({ spaceId: 'hall', point, headingDeg }, routeRevision); }
    });
  `, { self: {}, points });
}

test('a visual position announces the approaching turn once, then gives the turn at the corner', () => {
  const hall = guidance([[0, 0], [0, 15], [-8, 15]]);
  const cueAt = y => indoorCue(space, hall.visual([0, y], 0).maneuver, false);
  assert.match(cueAt(2).text, /직진/);
  const soon = cueAt(7);
  assert.match(soon.text, /잠시 후 좌회전/);
  assert.equal(cueAt(12).key, soon.key);
  assert.match(cueAt(14).text, /여기서 좌회전/);
  assert.notEqual(cueAt(14).key, soon.key);
});

test('the lost arrow gives the signed camera direction, including when facing back at a corner', () => {
  const hall = guidance([[0, 0], [0, 15], [-8, 15]]);
  for (const [heading, side] of [[90, 'left'], [-90, 'right'], [180, 'behind']]) {
    const view = hall.visual([0, 3], heading, false);
    assert.equal(view.arrow, null);
    assert.equal(view.maneuver.kind, 'realign');
    assert.equal(view.maneuver.direction, side);
    assert.equal(view.screenDirection, side);
  }
  assert.equal(hall.visual([0, 14.5], 180, false).maneuver.direction, 'behind');
  assert.equal(hall.visual([0, 14.5], -90).maneuver.kind, 'left');
  assert.equal(hall.visual([0, 3], 0, false).screenDirection, 'forward');
  assert.equal(hall.visual([0, 14.5], 0, false).screenDirection, 'left');
  assert.equal(hall.visual([0, 14.5], -90, false).screenDirection, 'forward');
  assert.equal(hall.visual([0, 3], 0).screenDirection, undefined);
});

test('a straight-down lens shows the surveyed travel direction in the rotated camera image', () => {
  const hall = guidance([[0, 0], [0, 15], [-8, 15]]);
  const down = [1,0,0,0, 0,-1,0,0, 0,0,-1,1, 0,0,0,1];
  const rolled = [0,1,0,0, 1,0,0,0, 0,0,-1,1, 0,0,0,1];
  const up = [1,0,0,0, 0,1,0,0, 0,0,1,1, 0,0,0,1];
  assert.equal(hall.visual([0, 3], down, false).screenDirection, 'forward');
  assert.equal(hall.visual([0, 3], rolled, false).screenDirection, 'right');
  assert.equal(hall.visual([0, 14.5], rolled, false).screenDirection, 'forward');
  assert.equal(hall.visual([0, 3], up, false).screenDirection, undefined);
});

test('a walking position can only preview a turn on an unambiguous forward approach', () => {
  const hall = guidance([[0, 0], [0, 15], [-8, 15]]);
  const cue = hall.walk([0, 14.5], 0);
  assert.equal(cue.maneuver.stage, 'soon');
  assert.equal(cue.maneuver.kind, 'left');
  assert.equal(cue.arrow, undefined);
  assert.equal(cue.arrived, undefined);
  assert.equal(hall.walk([0, 14.5], 180), undefined);
  assert.equal(hall.walk([1.2, 12], 0), undefined);
  assert.equal(hall.walk([-8, 15], -90), undefined);
  const crossing = guidance([[0, 0], [0, 8], [4, 8], [4, 4], [-4, 4]]);
  assert.equal(crossing.walk([0, 4], 0), undefined);
});
