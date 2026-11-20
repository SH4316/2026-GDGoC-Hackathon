const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { test } = require('node:test');
const { crc32 } = require('node:zlib');
const jpeg = require('jpeg-js');

const width = 640;
const height = 480;
const fx = 600;
const fy = 610;
const cx = 319;
const cy = 237;
const calibration = { width, height, fx, fy, cx, cy, distortion: [0.045, -0.012, 0.001, -0.002, 0.003, -0.005, 0.002, 0] };
const station = { tagSideM: 0.16, tags: [{ id: 0, center: [0, 0], yawDeg: 0 }],
  route: [[0, 0], [0, 8]], camera: { calibration } };
const startedAtMs = 1700000000000;
const depths = [2.4, 3.2, 4.15];

function drawScene(centerX) {
  let rng = 23;
  const random = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 2 ** 32;
  };
  const size = 48;
  const patches = depths.flatMap((depth, row) => [205, 282, 359, 436, 513].map(x => {
    const cells = Array.from({ length: 16 * 16 }, () => Math.floor(random() * 224));
    return { x: x - centerX * fx / depth, y: 94 + 125 * row, cells, row };
  }));
  const data = Buffer.alloc(width * height * 4, 240);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const xd = (px - cx) / fx;
      const yd = (py - cy) / fy;
      let u = xd;
      let v = yd;
      // Convert distorted image pixels to their ideal location before sampling a texture plane.
      for (let repeat = 0; repeat < 4; repeat++) {
        const radius = u * u + v * v;
        const radial = (1 + 0.045 * radius - 0.012 * radius ** 2 + 0.003 * radius ** 3) /
          (1 - 0.005 * radius + 0.002 * radius ** 2);
        u = (xd - 0.002 * u * v + 0.002 * (radius + 2 * u * u)) / radial;
        v = (yd - 0.001 * (radius + 2 * v * v) + 0.004 * u * v) / radial;
      }
      const x = u * fx + cx;
      const y = v * fy + cy;
      const patch = patches.find(p => x >= p.x && x < p.x + size && y >= p.y && y < p.y + size);
      if (!patch) continue;
      const { cells, row } = patch;
      const cell = cells[Math.floor((y - patch.y) / 3) * 16 + Math.floor((x - patch.x) / 3)];
      const offset = (py * width + px) * 4;
      data[offset] = cell + 15 * row;
      data[offset + 1] = cell + 10 * (2 - row);
      data[offset + 2] = cell;
    }
  }
  return jpeg.encode({ width, height, data }, 91).data;
}

function metadata(seq, x) {
  return {
    width, height, capturedAtMs: startedAtMs + seq * 1000, mediaTimeS: seq,
    intrinsics: [fx, fy, cx, cy],
    pose: x === null ? null : { cameraToWorld: [1, 0, 0, x, 0, 0, 1, 0, 0, -1, 0, 1.45, 0, 0, 0, 1],
      tagIds: [0], reprojectionPx: 0.2 },
  };
}

async function eventually(check) {
  const deadline = Date.now() + 15000;
  do {
    const result = await check();
    if (result) return result;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the recording API');
}

async function startServer(root) {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const proc = spawn(process.execPath, ['dist/main.js'], { cwd: join(__dirname, '..'),
    env: { ...process.env, API_PORT: String(port), API_HOST: '127.0.0.1', RECORDINGS_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', bytes => { output += bytes; });
  proc.stderr.on('data', bytes => { output += bytes; });
  const exited = once(proc, 'exit');
  const base = `http://127.0.0.1:${port}/api/recordings/`;
  try {
    await eventually(async () => {
      if (proc.exitCode !== null) throw new Error(output);
      return fetch(base + 'health').then(r => r.ok, () => false);
    });
  } catch (error) {
    proc.kill();
    await exited;
    throw error;
  }
  return { get: suffix => fetch(base + suffix),
    put: (suffix, body, type = 'application/json', headers) => fetch(base + suffix, {
      method: 'PUT', headers: { 'Content-Type': type, ...headers }, body: type === 'application/json' ? JSON.stringify(body) : body,
    }),
    log: () => output,
    stop: async () => { proc.kill(); await exited; } };
}

function upload(server, id, seq, bytes, meta) {
  return server.put(`${id}/frames/${seq}`, bytes, 'image/jpeg', { 'X-Frame-Meta': JSON.stringify(meta) });
}

function decodePly(buffer) {
  const suffix = 'end_header\n';
  const end = buffer.indexOf(suffix) + suffix.length;
  const header = buffer.toString('ascii', 0, end);
  assert.match(header, /format binary_little_endian 1.0/);
  const count = Number(header.match(/element vertex (\d+)/)[1]);
  assert.equal(buffer.length, end + count * 15);
  return Array.from({ length: count }, (_, index) => {
    const at = end + index * 15;
    return [buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8), buffer.readUInt8(at + 12)];
  });
}

function usdzScan() {
  // USDZ stores its first USD layer uncompressed at a 64-byte boundary.
  const name = Buffer.from('scan.usda');
  const layer = Buffer.from('#usda 1.0\n\ndef Xform "Scan" {}\n');
  const local = Buffer.alloc(30);
  const padding = Buffer.alloc(64 - local.length - name.length);
  padding.writeUInt16LE(0x1986);
  padding.writeUInt16LE(padding.length - 4, 2);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(layer), 14);
  local.writeUInt32LE(layer.length, 18);
  local.writeUInt32LE(layer.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(padding.length, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(64 + layer.length, 16);
  return Buffer.concat([local, name, padding, layer, central, name, end]);
}

test('recordings persist aligned frame pairs, reconstruct scene geometry and accept independent scans', { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-recordings-'));
  let server = await startServer(root);
  t.after(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });
  const id = randomUUID();
  const stationary = randomUUID();
  assert.equal((await server.get(`${id}/status`)).status, 404);
  assert.equal((await server.put(id, { startedAtMs, station })).status, 200);
  assert.equal((await server.put(id, { startedAtMs, station })).status, 200);
  assert.equal((await server.put(id, { startedAtMs: startedAtMs + 1, station })).status, 409);

  const positions = [0, null, 0.03, 0.16, 0.32, 0.48, 0.64];
  const frames = positions.map(x => drawScene(x ?? 0));
  const first = metadata(0, 0);
  const wrongSize = { ...first, width: width - 1 };
  assert.equal((await upload(server, id, 0, frames[0], wrongSize)).status, 400);
  assert.equal((await upload(server, id, 0, frames[0].subarray(0, -2), first)).status, 400);
  assert.equal((await upload(server, id, 0, Buffer.alloc(2 * 1024 * 1024 + 1), first)).status, 413);
  assert.equal((await server.put(`${id}/frames/0`, frames[0], 'application/octet-stream')).status, 415);
  const invalidPose = { ...first, pose: { ...first.pose, cameraToWorld: Array(16).fill(0) } };
  assert.equal((await upload(server, id, 0, frames[0], invalidPose)).status, 400);
  assert.equal((await upload(server, id, 1, frames[1], metadata(1, null))).status, 200);
  assert.equal((await server.put(`${id}/finish`, { frameCount: positions.length })).status, 409);
  const retries = await Promise.all([upload(server, id, 0, frames[0], first), upload(server, id, 0, frames[0], first)]);
  assert.deepEqual(retries.map(r => r.status), [200, 200]);
  assert.equal((await upload(server, id, 0, frames[3], first)).status, 409);
  for (let seq = 2; seq < positions.length; seq++) {
    assert.equal((await upload(server, id, seq, frames[seq], metadata(seq, positions[seq]))).status, 200);
  }
  assert.equal((await server.put(`${id}/finish`, { frameCount: positions.length })).status, 200);
  assert.equal((await upload(server, id, 0, frames[0], first)).status, 200);
  assert.equal((await upload(server, id, positions.length, frames[0], first)).status, 409);
  assert.deepEqual(JSON.parse(await readFile(join(root, id, 'frames/000000/frame.json'), 'utf8')), { seq: 0, ...first });
  assert.deepEqual(await readFile(join(root, id, 'frames/000000/image.jpg')), frames[0]);

  const result = await eventually(async () => (await (await server.get(`${id}/status`)).json()).reconstruction);
  assert.equal(result.state, 'ready', `${JSON.stringify(result)}\n${server.log()}`);
  assert.equal(result.posedFrames, positions.length - 1);
  assert.ok(result.matchedPairs >= 2);
  const scene = await server.get(`${id}/scene.ply`);
  assert.equal(scene.status, 200);
  const points = decodePly(Buffer.from(await scene.arrayBuffer()));
  assert.equal(points.length, result.points);
  assert.ok(points.every(p => p.every(Number.isFinite)));
  const expected = depths.map(depth => points.filter(p => Math.abs(p[1] - depth) < 0.14));
  assert.ok(expected.every(plane => plane.length >= 10), JSON.stringify(expected.map(plane => plane.length)));
  assert.ok(expected.flat().length > points.length * 0.75);
  assert.ok(points.some(p => p[2] > 1.8) && points.some(p => p[2] < 0.8));
  const centers = decodePly(await readFile(join(root, id, 'cameras.ply')));
  assert.ok(Math.abs(centers.at(-1)[0] - 0.64) < 1e-5);
  assert.ok(Math.abs(centers.at(-1)[2] - 1.45) < 1e-5);

  const scan = Buffer.from('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n');
  assert.equal((await server.put(`${stationary}/lidar/ply`, scan, 'application/octet-stream')).status, 404);
  assert.equal((await server.put(`${id}/lidar/ply`, Buffer.from('bad'), 'application/octet-stream')).status, 400);
  const attached = await server.put(`${id}/lidar/ply`, scan, 'application/octet-stream');
  assert.equal(attached.status, 200);
  assert.equal((await attached.json()).bytes, scan.length);
  assert.equal((await server.put(`${id}/lidar/ply`, scan, 'application/octet-stream')).status, 200);
  assert.equal((await server.put(`${id}/lidar/ply`, Buffer.concat([scan, Buffer.from('\n')]), 'application/octet-stream')).status, 409);
  assert.deepEqual(await readFile(join(root, id, 'lidar.ply')), scan);
  const usdz = usdzScan();
  const attachedUsdz = await server.put(`${id}/lidar/usdz`, usdz, 'application/octet-stream');
  assert.equal(attachedUsdz.status, 200);
  assert.equal((await attachedUsdz.json()).bytes, usdz.length);
  assert.deepEqual(await readFile(join(root, id, 'lidar.usdz')), usdz);
  assert.equal((await readdir(join(root, id))).some(name => name.startsWith('.')), false);

  assert.equal((await server.put(stationary, { startedAtMs, station })).status, 200);
  assert.equal((await upload(server, stationary, 0, frames[0], first)).status, 200);
  assert.equal((await upload(server, stationary, 1, frames[0], metadata(1, 0))).status, 200);
  assert.equal((await server.put(`${stationary}/finish`, { frameCount: 2 })).status, 200);
  assert.equal((await eventually(async () => (await (await server.get(`${stationary}/status`)).json()).reconstruction)).state, 'insufficient');
  assert.equal((await server.get(`${stationary}/scene.ply`)).status, 404);

  await server.stop();
  // Recreate the crash window between sealing and projecting completed output.
  await rm(join(root, stationary, 'reconstruction.json'));
  server = await startServer(root);
  const recovered = await eventually(async () => (await (await server.get(`${stationary}/status`)).json()).reconstruction);
  assert.deepEqual([recovered.state, recovered.points, recovered.matchedPairs], ['insufficient', 0, 0]);
  const restored = await (await server.get(`${id}/status`)).json();
  assert.deepEqual([restored.frameCount, restored.finished, restored.reconstruction.state], [positions.length, true, 'ready']);
  assert.deepEqual(await readFile(join(root, id, 'lidar.ply')), scan);
});
