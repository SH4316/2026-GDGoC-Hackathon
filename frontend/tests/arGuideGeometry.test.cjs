const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const workerCode = readFileSync(join(__dirname, '../public/ar/tracker.js'), 'utf8');
function renderPath(points) {
  const { setPath, routePosition, guideAt, arrowAt } = runInNewContext(
    workerCode + '\n;({ setPath, routePosition, guideAt, arrowAt })', { self: {} });
  setPath([], points);
  return (position, segment, bounds = [-50, -50, 50, 50]) => {
    const route = routePosition(position, segment);
    assert.ok(route);
    // Identity projection makes the actual overlay vertices readable in floor metres.
    const faces = guideAt(route, points => points, () => 1);
    const arrow = arrowAt(route, points => points, bounds);
    return { vertices: faces.flat(), arrow, progress: route.progress };
  };
}

test('the arrow fits a visible stretch even beyond the near placements or within a tight camera crop', () => {
  const render = renderPath([[0, 0], [0, 10]]);
  for (const [near, far] of [[3.3, 5], [.7, 1.06]]) {
    const { arrow } = render([0, 0], 0, [-1, near, 1, far]);
    assert.ok(arrow && arrow.every(([, y]) => y >= near && y < far));
    assert.ok(arrow[4][1] > arrow[0][1] + .2, 'the full arrow points toward the destination');
  }
  assert.equal(render([0, 0], 0, [-1, 7, 1, 10]).arrow, null, 'respect the visible guide length');
});

test('nearby stripe and arrow follow either side of a straight run across tag splits', () => {
  const render = renderPath([[0, 0], [0, 3], [0, 8], [0, 14]]);
  for (const side of [-1, 1]) {
    const { vertices, arrow, progress } = render([side * .9, 3.2], 1);
    assert.equal(progress, 3.2);
    // The 9 cm stripe is centred 60 cm toward the walker at the tag vertex.
    for (const edge of [-.045, .045]) {
      assert.ok(vertices.some(([x, y]) => Math.abs(x - (side * .6 + edge)) < 1e-8 && Math.abs(y - 3) < 1e-8));
    }
    assert.ok(arrow && side * arrow[4][0] > .2);
    const distant = vertices.filter(([, y]) => y >= progress + 2);
    assert.ok(distant.length > 0 && distant.every(([x]) => Math.abs(x) <= .045 + 1e-8));
    assert.ok(Math.abs(Math.max(...vertices.map(([, y]) => y)) - progress - 6) < 1e-8);
  }
});

test('a sharp bend stays surveyed and reveals the onward corridor as it is walked', () => {
  const render = renderPath([[0, 0], [0, 6], [8, 6]]);
  const before = render([.9, 5], 0);
  const furthest = result => Math.max(...result.vertices.map(([x]) => x));
  assert.ok(Math.abs(furthest(before) - .8) < 1e-8);
  assert.ok(before.vertices.some(([x, y]) => Math.abs(x) < 1e-8 && Math.abs(y - 6.045) < 1e-8));
  assert.ok(before.arrow && before.arrow.every(([x]) => x >= -1e-8 && x <= .8));
  const halfway = render([.5, 6], 1);
  const past = render([1.2, 6], 1);
  assert.ok(furthest(halfway) > .8 && furthest(halfway) < 4.5);
  assert.ok(Math.abs(furthest(past) - 7.2) < 1e-8);
  const destination = render([7.5, 6.7], 1);
  const lastEdge = destination.vertices.filter(([x]) => Math.abs(x - 8) < 1e-8);
  assert.equal(lastEdge.length, 2);
  assert.ok(lastEdge.every(([, y]) => Math.abs(Math.abs(y - 6) - .045) < 1e-8));
});

test('a distorted lens and a locally accurate tag homography keep the stripe below a rolled horizon', async () => {
  const { cv } = await new Promise(resolve => require('@techstark/opencv-js').then(cv => resolve({ cv })));
  const width = 640, height = 480, f = 470, h = 1.25;
  const roll = .46, c = Math.cos(roll), s = Math.sin(roll);
  const m = [c,s,0,0, 0,0,1,0, s,-c,0,h, 0,0,0,1];
  const plane = [c,0,-s*h, s,0,c*h, 0,1,0];
  const tagY = 2, gain = -.42;
  const warped = plane.slice();
  // A projective perturbation along the tag-centre ray is quadratic in its
  // tiny printed neighbourhood, but extrapolates above the horizon along the aisle.
  for (const i of [0,3,6]) {
    const alongRay = gain*(plane[i+1]*tagY+plane[i+2]);
    warped[i+1] += alongRay; warped[i+2] -= alongRay*tagY;
  }
  function pixel(matrix, [x,y]) {
    const [a,b,z] = [0,3,6].map(i => matrix[i]*x + matrix[i+1]*y + matrix[i+2]);
    return [width/2 + f*a/z, height/2 + f*b/z];
  }
  for (const x of [-.08,.08]) for (const y of [tagY-.08,tagY+.08]) {
    const p = pixel(plane,[x,y]), q = pixel(warped,[x,y]);
    assert.ok(Math.hypot(p[0]-q[0],p[1]-q[1]) < 1, 'less than one pixel of error on all four tag corners');
  }
  const elevation = ([u,v]) => s*(u-width/2)/f-c*(v-height/2)/f;
  assert.ok(elevation(pixel(warped,[0,6])) > 0, 'unconstrained extrapolation crosses the real horizon');
  const near = pixel(plane,[0,.55]), radius = h/.55;
  const folded = [width/2+(near[0]-width/2)*(1-.2*radius**2), height/2+(near[1]-height/2)*(1-.2*radius**2)];
  assert.ok(folded[0] > 0 && folded[0] < width && folded[1] > 0 && folded[1] < height && elevation(folded) > 0,
    'extrapolating barrel distortion beyond the sensor folds a near-floor ray into visible sky pixels');
  const draw = runInNewContext(workerCode + `
    lib = cv;
    setPath([], [[0,0], [0,10]]);
    (function draw(matrix, distortion, gravity) {
      station = {camera: {calibration: {distortion}}};
      const owned = [], own = mat => { owned.push(mat); return mat; };
      try {
        return floorGuidance(routePosition([0,0]), {cameraToWorld:m}, matrix, [f,f,width/2,height/2],
          [0,0,width,height], undefined, 0, own, false, gravity);
      } finally { for (const mat of owned.reverse()) mat.delete(); }
    })`, { self: {}, cv, width, height, f, m });
  for (const [matrix, lens] of [[warped, []], [plane, [-.2,0,0,0]]]) {
    const view = draw(matrix, lens, [s,-c,0]);
    assert.ok(view.floorVisible && view.arrow);
    assert.deepEqual(Array.from(view.floorTiltLimit.up), [s,-c,0]);
    assert.equal(view.routeBearing.direction, 'forward');
    let closest = Math.PI/2;
    for (const pt of [...view.guide.flat(), ...view.arrow]) {
      assert.ok(elevation(pt) < 0, 'every displayed vertex is below the physical, rolled horizon');
      assert.ok(pt[0] >= -1e-7 && pt[0] <= width+1e-7 && pt[1] >= -1e-7 && pt[1] <= height+1e-7);
      const rd = Math.hypot(pt[0]-width/2,pt[1]-height/2)/f;
      let radius = rd;
      if (lens.length) {
        // Independent radial inverse on the monotone part of r -> r*(1+k*r²).
        let lo = 0, hi = 1/Math.sqrt(-3*lens[0]);
        for (let i = 0; i < 40; i++) {
          const mid = (lo+hi)/2;
          if (mid*(1+lens[0]*mid*mid) < rd) lo = mid; else hi = mid;
        }
        radius = (lo+hi)/2;
      }
      const sine = -elevation(pt)*(radius/rd)/Math.hypot(radius,1);
      closest = Math.min(closest,Math.asin(sine));
    }
    const allowedTilt = Math.acos(view.floorTiltLimit.minDot);
    assert.ok(allowedTilt > 0 && allowedTilt < closest && closest-allowedTilt < Math.PI/180,
      'the overlay expires before the closest visible ray can cross the horizon, including a stroke margin');
  }
  const pitch = 40*Math.PI/180;
  const contradicted = draw(plane, [], [s*Math.cos(pitch), -c*Math.cos(pitch), Math.sin(pitch)]);
  assert.equal(contradicted.floorVisible, false);
  assert.equal(contradicted.arrow, null);
  assert.equal(contradicted.guide.length, 0);
  assert.equal(contradicted.routeBearing.direction, 'forward');
});
