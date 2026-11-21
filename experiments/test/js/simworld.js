// 가상 역: 실내에서 폰 없이 시연·검증하기 위한 3D 공간.
//
// 여기서 그린 화면이 "카메라 영상" 역할을 한다. 앱은 실제 카메라일 때와 똑같이
// 이 화면에서 QR을 찾아 위치를 추정하므로, 추정값을 정답(가상 보행자의 실제 위치)과 비교할 수 있다.

import * as THREE from '../vendor/three.module.min.js';
import { rad, deg, normDeg, angDiff, distXY, bearingXY } from './geo.js';
import { lookQuat, qMul, yawQuat } from './orient-math.js';
import { markerBasis } from './pose.js';
import { drawQr, markerPayload } from './qr.js';
import { poiIcon, poiName } from './destinations.js';

const WALL_PIXEL_MAX = 45; // 평면도 그림에서 "정확한 벽 칸"으로 보는 픽셀의 빨강 값 상한 (scan-import.js와 같은 값)

export const EYE_HEIGHT = 1.4;
const WALL_HEIGHT = 2.8;
const SIM_BASE_URL = 'https://iriro.app/';
const WALK_SPEED = 1.2; // m/s

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9ced4';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#d4d8dd';
  g.fillRect(4, 4, 120, 120);
  g.fillRect(132, 132, 120, 120);
  g.strokeStyle = '#aab0b8';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 128, 128);
  g.strokeRect(128, 0, 128, 128);
  g.strokeRect(0, 128, 128, 128);
  g.strokeRect(128, 128, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wallTexture() {
  // 가로 2m, 세로 2.8m 한 장: 타일 벽, 2호선을 닮은 초록 띠, 아래쪽 걸레받이
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#eef0ec';
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = '#d9dcd6';
  g.lineWidth = 2;
  for (let x = 0; x <= 256; x += 64) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 512);
    g.stroke();
  }
  for (let y = 0; y <= 512; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y);
    g.stroke();
  }
  g.fillStyle = '#00a84d';
  g.fillRect(0, 70, 256, 26);
  g.fillStyle = '#6b7178';
  g.fillRect(0, 484, 256, 28);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A4 한 장에 인쇄된 QR 안내판 */
function sheetTexture(marker, maxAniso) {
  const PX = 4; // 1mm = 4픽셀
  const c = document.createElement('canvas');
  c.width = 210 * PX;
  c.height = 297 * PX;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  const size = marker.size * 1000 * PX;
  drawQr(g, markerPayload(SIM_BASE_URL, marker.id), (c.width - size) / 2, (c.height - size) / 2, size);
  g.fillStyle = '#1e6bff';
  g.font = `bold ${22 * PX}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText('QR 길안내', c.width / 2, 40 * PX);
  g.fillStyle = '#333';
  g.font = `${13 * PX}px system-ui, sans-serif`;
  g.fillText(marker.id, c.width / 2, 280 * PX);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

function poiSignTexture(poi, lang) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  const isExit = poi.type === 'exit';
  g.fillStyle = isExit ? '#ffcc00' : '#12305f';
  g.beginPath();
  g.roundRect(4, 4, 504, 120, 18);
  g.fill();
  g.fillStyle = isExit ? '#111' : '#fff';
  g.textBaseline = 'middle';
  g.font = '64px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = 'left';
  g.fillText(poiIcon(poi), 22, 68);
  g.font = 'bold 46px system-ui, sans-serif';
  let name = poiName(poi, lang);
  while (g.measureText(name).width > 380 && name.length > 4) name = name.slice(0, -1);
  g.fillText(name, 112, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class SimWorld {
  constructor(canvas, map, lang) {
    this.canvas = canvas;
    this.map = map;
    // preserveDrawingBuffer: 그린 화면을 QR 인식기가 나중에 읽을 수 있게 남겨 둔다
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe4e8ec);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.05, 150);

    const s = map.start || { x: 0, y: 0, heading: 0, pitch: 0 };
    /** 가상 보행자의 실제 위치와 시선 (정답) */
    this.pose = { x: s.x, y: s.y, heading: s.heading || 0, pitch: s.pitch || 0 };
    this.height = EYE_HEIGHT;
    this.input = { walk: 0, turn: 0 };
    this.onStep = null;
    this.stride = 0.7; // 실제 보폭. 앱이 가정하는 값(0.65)과 일부러 다르게 둔다
    this._walkAcc = 0;

    // 가상 관성 센서: 지도와 임의의 각도만큼 어긋나 있고 천천히 흐른다. 앱은 이 값을 모른다.
    this.imuOffset = 137;
    this.driftRate = 0.02; // 도/초
    this.clock = 0;
    this.turnRate = 0;
    this._prevRender = null;
    this.renderedImu = this.qImu();

    this._build(lang);
  }

  _build(lang) {
    const { minX, maxX, minY, maxY } = this.map.bounds;
    const w = maxX - minX + 8;
    const d = maxY - minY + 8;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const floorTex = floorTexture();
    floorTex.repeat.set(w / 1.2, d / 1.2);
    floorTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ map: floorTex })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, -cy);
    this.scene.add(floor);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: 0xf4f5f6 })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(cx, WALL_HEIGHT, -cy);
    this.scene.add(ceiling);

    // 스캔 평면도가 있으면 그 벽을 그대로 세우므로, 손으로 그린 벽 선은 세우지 않는다
    // (둘이 몇 cm 어긋나면 손으로 그린 벽이 QR을 가린다).
    const scanned = !!(this.map.floorplan && this.map.floorplan.scan);
    const wallMat = new THREE.MeshBasicMaterial({ map: wallTexture(), side: THREE.DoubleSide });
    for (const [x1, y1, x2, y2] of scanned ? [] : this.map.walls) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const geo = new THREE.PlaneGeometry(len, WALL_HEIGHT);
      // 벽 길이에 맞춰 무늬를 2m마다 반복
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * len) / 2);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set((x1 + x2) / 2, WALL_HEIGHT / 2, -(y1 + y2) / 2);
      mesh.rotation.y = Math.atan2(y2 - y1, x2 - x1);
      this.scene.add(mesh);
    }

    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    this._sheets = []; // 스캔한 벽을 세운 뒤 벽 QR을 벽 앞면으로 다시 옮길 때 쓴다
    for (const m of this.map.markers) {
      const { c, r, u, n } = markerBasis(m);
      const sheet = new THREE.Mesh(
        new THREE.PlaneGeometry(0.21, 0.297),
        new THREE.MeshBasicMaterial({ map: sheetTexture(m, aniso) })
      );
      sheet.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(...r),
          new THREE.Vector3(...u),
          new THREE.Vector3(...n)
        )
      );
      // 스캔으로 세운 벽은 두께가 있는 기둥이라, 벽 QR이 그 속에 묻히지 않게 조금 앞으로 뺀다
      const out = this.map.floorplan && this.map.floorplan.scan && m.mount === 'wall' ? 0.062 : 0.006;
      sheet.position.set(c[0] + n[0] * out, c[1] + n[1] * out, c[2] + n[2] * out);
      this.scene.add(sheet);
      this._sheets.push({ marker: m, sheet, c, n });
    }

    if (this.map.floorplan && this.map.floorplan.scan) this._buildScannedWalls();

    for (const poi of this.map.pois) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: poiSignTexture(poi, lang), transparent: true })
      );
      sprite.scale.set(1.5, 0.375, 1);
      sprite.position.set(poi.x, 2.35, -poi.y);
      this.scene.add(sprite);
    }
  }

  /**
   * LiDAR 스캔 평면도의 벽 자리에 기둥을 촘촘히 세워 실제 공간처럼 벽을 만든다.
   * 그림이 다 받아진 뒤에 추가되므로 처음 잠깐은 벽 없이 보인다.
   */
  _buildScannedWalls() {
    const f = this.map.floorplan;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      // 평면도의 벽 칸(보통 5cm)마다 기둥 하나. 더 촘촘한 그림이면 5cm로 모은다.
      const step = Math.max(1, Math.round(0.05 / f.mpp));
      const size = step * f.mpp;
      const spots = [];
      for (let r = 0; r < c.height; r += step) {
        for (let col = 0; col < c.width; col += step) {
          let wall = false;
          for (let dr = 0; dr < step && !wall; dr++) {
            for (let dc = 0; dc < step && !wall; dc++) {
              const o = ((r + dr) * c.width + col + dc) * 4;
              if (r + dr < c.height && col + dc < c.width && px[o + 3] > 200 && px[o] < WALL_PIXEL_MAX) wall = true;
            }
          }
          if (wall) spots.push([f.x + (col + step / 2) * f.mpp, f.y - (r + step / 2) * f.mpp]);
        }
      }
      // 벽 QR을 그 자리의 벽 앞면 바로 앞에 놓는다. 평면도마다 벽 선의 굵기가 달라서
      // QR 위치에서 바라보는 방향으로 조금씩 나아가며 벽이 끝나는 곳을 찾는다.
      const isWall = (x, y) => {
        const col = Math.floor((x - f.x) / f.mpp);
        const r = Math.floor((f.y - y) / f.mpp);
        if (col < 0 || col >= c.width || r < 0 || r >= c.height) return false;
        const o = (r * c.width + col) * 4;
        return px[o + 3] > 200 && px[o] < WALL_PIXEL_MAX;
      };
      for (const { marker, sheet, c: center, n } of this._sheets) {
        if (marker.mount === 'floor') continue;
        const a = rad(marker.facing);
        const fx = Math.sin(a);
        const fy = Math.cos(a);
        // 안내판 폭 전체(좌우 가장자리 포함)에서 가장 앞으로 나온 벽을 기준으로 한다.
        // 벽 끝이나 모서리에 붙인 QR은 가운데만 보면 옆의 벽에 가려진다.
        let front = 0;
        for (let side = -0.12; side <= 0.121; side += 0.04) {
          const ox = marker.x + fy * side;
          const oy = marker.y - fx * side;
          let last = -1;
          for (let d = -0.15; d <= 0.6; d += 0.01) {
            if (isWall(ox + fx * d, oy + fy * d)) last = d;
            else if (last > -1 && d - last > 0.08) break;
          }
          if (last > front) front = last;
        }
        front += size / 2 + 0.012;
        sheet.position.set(center[0] + n[0] * front, center[1] + n[1] * front, center[2] + n[2] * front);
      }

      if (!spots.length || spots.length > 400000) return;
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(size, WALL_HEIGHT, size),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        spots.length
      );
      const m = new THREE.Matrix4();
      const color = new THREE.Color();
      spots.forEach(([x, y], i) => {
        m.makeTranslation(x, WALL_HEIGHT / 2, -y);
        mesh.setMatrixAt(i, m);
        // 기둥마다 밝기를 조금씩 달리해 평평한 색 덩어리로 보이지 않게 한다
        const v = 0.86 + ((i * 37) % 9) * 0.01;
        mesh.setColorAt(i, color.setRGB(v, v, v * 0.97));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
    };
    img.src = new URL(`../maps/${f.image}`, import.meta.url).href;
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 62 : 46; // 세로 화면이면 폰 카메라와 비슷한 화각
    this.camera.updateProjectionMatrix();
  }

  /** 이 가상 카메라의 내부 파라미터 (그리기 버퍼 픽셀 기준, 정확한 값) */
  intrinsics() {
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    return { f: h / 2 / Math.tan(rad(this.camera.fov) / 2), cx: w / 2, cy: h / 2, w, h };
  }

  qTrue() {
    return lookQuat(this.pose.heading, this.pose.pitch);
  }

  /** 가상 센서가 알려 주는 자세: 기울기는 정확하지만 좌우 방향은 지도와 어긋나 있다 */
  qImu() {
    return qMul(yawQuat(-(this.imuOffset + this.driftRate * this.clock)), this.qTrue());
  }

  update(dt) {
    this.clock += dt;
    this.pose.heading = normDeg(this.pose.heading + this.input.turn * 90 * dt);
    const v = Math.max(0, this.input.walk) * WALK_SPEED;
    if (v > 0) {
      // hold: 폰을 걷는 방향에서 오른쪽으로 이만큼 틀어 들고 있다 (사람마다 있는 버릇을 흉내 낸다)
      const h = rad(this.pose.heading - (this.hold || 0));
      this.pose.x += Math.sin(h) * v * dt;
      this.pose.y += Math.cos(h) * v * dt;
      this._walkAcc += v * dt;
      while (this._walkAcc >= this.stride) {
        this._walkAcc -= this.stride;
        if (this.onStep) this.onStep();
      }
    }
  }

  render() {
    const q = this.qTrue();
    this.camera.position.set(this.pose.x, this.height, -this.pose.y);
    this.camera.quaternion.set(q[0], q[1], q[2], q[3]);
    this.renderer.render(this.scene, this.camera);
    this.renderedImu = this.qImu();
    // 시선이 도는 속도(도/초). 빠르게 도는 중의 화면은 위치 계산에서 빼기 위해 기록한다.
    const now = performance.now();
    if (this._prevRender) {
      const dt = Math.max(1, now - this._prevRender.t) / 1000;
      const turn = Math.hypot(
        angDiff(this.pose.heading, this._prevRender.heading),
        this.pose.pitch - this._prevRender.pitch
      );
      this.turnRate = turn / dt;
    }
    this._prevRender = { t: now, heading: this.pose.heading, pitch: this.pose.pitch };
  }
}

/**
 * 가상 보행자를 자동으로 움직인다. 실제 사용자처럼 행동하도록:
 *  - 위치를 모르면 가까운 QR을 찾아 비춘다
 *  - 앱이 가리키는 방향(앱이 추정한 값 기준)을 따라 걷는다
 *  - 지나가는 길에 QR이 가까이 있으면 잠깐 멈춰 비춘다
 */
export class AutoWalker {
  constructor(sim, map) {
    this.sim = sim;
    this.map = map;
    this.state = 'seek';
    this.target = null;
    this.hold = 0;
    this.glancedAt = new Map();
  }

  /** nav: { hasFix, rel(앱이 가리키는 방향, 정면 기준 도), arrived, walked(QR 본 뒤 걸은 거리) } */
  update(dt, nav) {
    const sim = this.sim;
    sim.input.walk = 0;
    sim.input.turn = 0;
    if (nav.arrived) {
      this.state = 'done';
      return;
    }

    if (this.state === 'glance') {
      const aimed = this._aim(this.target, dt);
      if (aimed) this.hold += dt;
      if (this.hold > 1.0 || (this.hold === 0 && (this._aimTime += dt) > 4)) {
        this.glancedAt.set(this.target.id, sim.clock);
        this.state = 'follow';
      }
      return;
    }

    if (!nav.hasFix) {
      // 가장 가까운 QR을 찾아간다. 벽 QR은 사람처럼 그 정면에 가서 선 다음 비춘다
      // (옆에서 비스듬히 보면 인식되지 않는다).
      const m = this._nearest(() => true);
      if (!m) return;
      if (m.mount !== 'floor' && (this._offNormal(m) > 30 || distXY(sim.pose, m) > 2.2)) {
        const a = rad(m.facing);
        const spot = { x: m.x + Math.sin(a) * 1.3, y: m.y + Math.cos(a) * 1.3 };
        if (distXY(sim.pose, spot) > 0.25) {
          const eh = angDiff(bearingXY(sim.pose, spot), sim.pose.heading);
          sim.pose.heading = normDeg(sim.pose.heading + Math.max(-150 * dt, Math.min(150 * dt, eh)));
          sim.pose.pitch += (-10 - sim.pose.pitch) * Math.min(1, dt * 4);
          if (Math.abs(eh) < 15) sim.input.walk = 1;
          return;
        }
      }
      const aimed = this._aim(m, dt);
      if (aimed && distXY(sim.pose, m) > 1.8) sim.input.walk = 1;
      return;
    }

    this.state = 'follow';
    if (nav.walked > 3) {
      const m = this._nearest((mk) => {
        const d = distXY(sim.pose, mk);
        if (d > 2.8 || d < 0.5) return false;
        if (Math.abs(angDiff(bearingXY(sim.pose, mk), sim.pose.heading)) > 110) return false;
        if (this._offNormal(mk) > 40) return false; // 벽 QR은 그 앞을 지날 때 비춘다
        const last = this.glancedAt.get(mk.id);
        return last === undefined || sim.clock - last > 20;
      });
      if (m) {
        this.state = 'glance';
        this.target = m;
        this.hold = 0;
        this._aimTime = 0;
        return;
      }
    }

    if (nav.rel != null) {
      const rate = Math.max(-120, Math.min(120, nav.rel * 2.5));
      sim.pose.heading = normDeg(sim.pose.heading + rate * dt);
      sim.pose.pitch += (-14 - sim.pose.pitch) * Math.min(1, dt * 4);
      if (Math.abs(nav.rel) < 30) sim.input.walk = 1;
    }
  }

  /** 벽 QR의 정면에서 몇 도 비껴 서 있는지 (바닥 QR은 어느 쪽에서 봐도 되므로 0) */
  _offNormal(m) {
    if (m.mount === 'floor') return 0;
    return Math.abs(angDiff(bearingXY(m, this.sim.pose), m.facing));
  }

  _nearest(filter) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.map.markers) {
      if (!filter(m)) continue;
      const d = distXY(this.sim.pose, m);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** 마커를 화면 가운데로 오게 시선을 돌린다. 다 돌렸으면 true */
  _aim(m, dt) {
    const pose = this.sim.pose;
    const d = Math.max(0.05, distXY(pose, m));
    const wantH = bearingXY(pose, m);
    const wantP = deg(Math.atan2(m.h - this.sim.height, d));
    const eh = angDiff(wantH, pose.heading);
    const ep = wantP - pose.pitch;
    pose.heading = normDeg(pose.heading + Math.max(-150 * dt, Math.min(150 * dt, eh)));
    pose.pitch += Math.max(-110 * dt, Math.min(110 * dt, ep));
    return Math.abs(eh) < 2 && Math.abs(ep) < 2;
  }
}
