const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../public/ar/floor-visibility.js'), 'utf8');
const build = runInNewContext(source + '\nbuildFloorVisibility');
const w = 200, h = 160;
const rect = (x, y, u, v) => [[x,y], [u,y], [u,v], [x,v]];
const tag = rect(26, 52, 54, 80);
const gray = [162,162,162], foreground = [220,139,131];
const luma = ([r,g,b]) => (77*r + 150*g + 29*b) >> 8;

function pixels(color) {
  const rgba = new Uint8Array(w*h*4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const rgb = x >= 26 && x < 54 && y >= 52 && y < 80
      ? Array(3).fill((Math.floor(x/4) + Math.floor(y/4)) % 2 ? 255 : 0) : color(x,y);
    rgba.set([...rgb,255], (y*w+x)*4);
  }
  return rgba;
}

test('a visible floor tag supports a smooth floor and rejects an equal-luminance obstruction inside a guide', () => {
  assert.equal(luma(gray), luma(foreground));
  const guide = rect(76, 72, 176, 138);
  const clean = build(pixels(() => gray), w, h, [tag], []);
  assert.ok(clean.covers(guide, 3));
  const occluded = pixels((x,y) => x >= 94 && x < 109 && y >= 88 && y < 104 ? foreground : gray);
  for (let frame = 0; frame < 3; frame++) {
    const mask = build(occluded, w, h, [tag], []);
    assert.equal(mask.contains(100,96), false);
    assert.ok(guide.every(p => mask.contains(...p)), 'blocker is strictly inside the guide');
    assert.equal(mask.covers(guide, 3), false);
    assert.ok(mask.covers(rect(128, 80, 172, 108), 3));
    assert.ok(mask.covers(rect(112, 88, 130, 100)));
    assert.equal(mask.covers(rect(112, 88, 130, 100), 5), false, 'the stroke intersects the blocker');
  }
});

test('an obstruction adjacent to one tag edge is not adopted as floor', () => {
  const frame = pixels((x,y) => x > 55 && x < 82 && y > 50 && y < 82 ? foreground : gray);
  const mask = build(frame, w, h, [tag], []);
  assert.equal(mask.contains(70,65), false);
  assert.ok(mask.contains(90,70));
});

test('floor texture survives, and matching colors behind a full barrier need their own trusted observation', () => {
  const frame = pixels((x,y) => {
    if (x >= 84 && x <= 102) return foreground;
    const shade = 134 + ((Math.floor(x/6)*27 + Math.floor(y/7)*13) % 67);
    return [shade,shade,shade];
  });
  const left = build(frame, w, h, [tag], []);
  assert.ok(left.covers(rect(6, 90, 73, 135), 2));
  assert.equal(left.contains(140,100), false);
  const both = build(frame, w, h, [tag], [[140,100],[152,110],[166,115],[124,109]]);
  assert.ok(both.covers(rect(130,84,190,139), 2));
  assert.equal(both.contains(92,100), false);
});

test('visible wall tags or fresh features alone supply no floor observations', () => {
  // The printed pattern exists in this frame, but belongs to a wall-mounted tag.
  const frame = pixels(() => gray);
  assert.equal(build(frame,w,h,[],[]), undefined);
  assert.equal(build(frame,w,h,[],[[NaN,51],[-4,20]]), undefined);
  assert.ok(build(frame,w,h,[],[[120,80]]).contains(120,100), 'previously matched floor landmark');
});

test('a low-contrast gray obstruction interrupts a textured gray floor with the same average brightness', () => {
  function texture(x,y) {
    const value = 132 + ((Math.floor(x/5)*19 + Math.floor(y/6)*23) % 89);
    return [value,value,value];
  }
  const clear = build(pixels(texture), w, h, [tag], []);
  const guide = rect(95,55,118,132);
  assert.ok(clear.covers(guide,2));
  const covering = pixels((x,y) => {
    if (x < 87 || x >= 129 || y < 30 || y >= 148) return texture(x,y);
    const value = Math.floor(y/15)%2 ? 174 : 180;
    return [value,value,value];
  });
  const mask = build(covering, w, h, [tag], []);
  assert.ok(mask.covers(rect(143,65,183,108),2));
  assert.equal(mask.covers(guide,2),false);
  assert.equal(mask.contains(92,124),false);
  assert.equal(mask.contains(118,52),false);
});

test('a smooth lighting gradient is continuous floor evidence but an abrupt gray surface is excluded', () => {
  const frame = pixels((x,y) => {
    const shade = x > 126 && x < 170 && y >= 90 ? 120 : Math.round(212 - .34*x);
    return [shade,shade,shade];
  });
  const mask = build(frame,w,h,[tag],[]);
  assert.ok(mask.covers(rect(110,30,185,65),2));
  assert.equal(mask.contains(150,118),false);
});

test('only pixels consistent with the printed pattern of a decoded floor tag support guide geometry', () => {
  const marker = rect(60,40,124,104), bits = new Uint8Array(64);
  for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) bits[8*y+x] = (x+y)%2 ? 255 : 0;
  marker.bits = bits;
  const frame = new Uint8Array(w*h*4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const shade = x >= 60 && x < 124 && y >= 40 && y < 104 ? bits[Math.floor((y-40)/8)*8+Math.floor((x-60)/8)] : 162;
    frame.set([shade,shade,shade,255],4*(y*w+x));
  }
  const guide = rect(50,55,132,93);
  assert.ok(build(frame,w,h,[marker],[]).covers(guide,2));
  // A piece of white paper blocks both white cells and black cells under it.
  for (let y = 66; y < 86; y++) for (let x = 82; x < 102; x++) frame.set([255,255,255,255],4*(y*w+x));
  assert.equal(build(frame,w,h,[marker],[]).covers(guide,2),false);
});
