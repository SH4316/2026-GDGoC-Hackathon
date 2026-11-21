// 카메라 영상 위에 겹쳐 그리는 AR 안내: 바닥 화살표, 꺾는 곳 표지판, 목적지 핀, QR 위치 표시.
//
// 세계 좌표: X = 지도 x, Y = 높이, Z = -지도 y (three.js 기본 좌표계 그대로)

import * as THREE from '../vendor/three.module.min.js';
import { rad } from './geo.js';
import { drawTurnGlyph } from './glyphs.js';
import { markerBasis } from './pose.js';

const CHEVRONS = 14;
const SPACING = 1.0; // 바닥 화살표 간격 (m)
const NEAR = 1.2; // 발 앞 이 거리부터 그린다
const FAR = 15; // 이 거리에서 완전히 사라진다
const FLOW_SPEED = 0.9; // 화살표가 앞으로 흘러가는 속도 (m/s)
const BLUE = '#1e6bff';

function chevronTexture(maxAniso) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.beginPath();
  g.moveTo(0, -96);
  g.lineTo(104, 8);
  g.lineTo(104, 84);
  g.lineTo(0, -20);
  g.lineTo(-104, 84);
  g.lineTo(-104, 8);
  g.closePath();
  g.fillStyle = '#2f8bff';
  g.fill();
  g.lineWidth = 14;
  g.lineJoin = 'round';
  g.strokeStyle = '#ffffff';
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

function signTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(128, 128, 118, 0, Math.PI * 2);
  g.fillStyle = BLUE;
  g.fill();
  g.lineWidth = 12;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.translate(38, 38);
  drawTurnGlyph(g, kind, 180, '#ffffff', BLUE);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function pinTexture(icon) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 320;
  const g = c.getContext('2d');
  // 물방울 모양 핀
  g.beginPath();
  g.arc(128, 120, 104, Math.PI * 0.82, Math.PI * 0.18, false);
  g.lineTo(128, 312);
  g.closePath();
  g.fillStyle = '#ff3b30';
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.beginPath();
  g.arc(128, 120, 74, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.font = '92px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#111';
  g.fillText(icon, 128, 126);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ARView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    this._targetQ = new THREE.Quaternion();
    this._hasPose = false;
    this._signTextures = new Map();
    this._signs = [];
    this._beacons = new Map();
    this._pin = null;
    this.route = null;
    // 경로에 딸린 것들(바닥 화살표, 표지판, 핀)은 한 묶음으로 두고 옆으로 옮겨 그릴 수 있게 한다
    this.routeGroup = new THREE.Group();
    this.scene.add(this.routeGroup);

    // 바닥 화살표: 평면을 눕혀 두고, 그림의 뾰족한 쪽이 지도 위쪽(-Z)을 향하게 한다
    const tex = chevronTexture(this.renderer.capabilities.getMaxAnisotropy());
    const geo = new THREE.PlaneGeometry(0.62, 0.62);
    geo.rotateX(-Math.PI / 2);
    this._chevrons = [];
    for (let i = 0; i < CHEVRONS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.routeGroup.add(mesh);
      this._chevrons.push(mesh);
    }
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 화면에 보이는 세로 화각(도). 카메라 영상과 겹침이 맞으려면 영상의 화각과 같아야 한다. */
  setFov(vfovDeg) {
    if (Math.abs(this.camera.fov - vfovDeg) > 0.01) {
      this.camera.fov = vfovDeg;
      this.camera.updateProjectionMatrix();
    }
  }

  /** 지도의 QR 마커마다 위치 표시 테두리를 만든다 */
  setMap(map) {
    for (const b of this._beacons.values()) this.scene.remove(b);
    this._beacons.clear();
    for (const m of map.markers) {
      const outer = m.size * 0.78;
      const inner = m.size * 0.66;
      const shape = new THREE.Shape();
      shape.moveTo(-outer, -outer);
      shape.lineTo(outer, -outer);
      shape.lineTo(outer, outer);
      shape.lineTo(-outer, outer);
      shape.closePath();
      const hole = new THREE.Path();
      hole.moveTo(-inner, -inner);
      hole.lineTo(-inner, inner);
      hole.lineTo(inner, inner);
      hole.lineTo(inner, -inner);
      hole.closePath();
      shape.holes.push(hole);
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({
          color: 0x2bc4ff,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
      );
      const { c, r, u, n } = markerBasis(m);
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(...r),
          new THREE.Vector3(...u),
          new THREE.Vector3(...n)
        )
      );
      mesh.position.set(c[0] + n[0] * 0.01, c[1] + n[1] * 0.01, c[2] + n[2] * 0.01);
      mesh.visible = false;
      this.scene.add(mesh);
      this._beacons.set(m.id, mesh);
    }
  }

  /** 안내할 경로를 정한다. route: { path, maneuvers }, dest: { x, y }, icon: 목적지 아이콘 문자 */
  setRoute(route, dest, icon) {
    this.clearRoute();
    this.route = route;
    for (const m of route.maneuvers) {
      if (!this._signTextures.has(m.kind)) this._signTextures.set(m.kind, signTexture(m.kind));
      const p = route.path.pointAt(m.s);
      const group = new THREE.Group();
      group.position.set(p.x, 0, -p.y);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this._signTextures.get(m.kind),
          transparent: true,
          depthTest: false,
        })
      );
      sprite.center.set(0.5, 0);
      sprite.position.y = 1.55;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 1.55, 6),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
      );
      pole.position.y = 0.775;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.22, 0.32, 32),
        new THREE.MeshBasicMaterial({ color: 0x1e6bff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.015;
      group.add(pole, ring, sprite);
      group.userData.sprite = sprite;
      group.visible = false;
      this.routeGroup.add(group);
      this._signs.push(group);
    }
    const pin = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pinTexture(icon), transparent: true, depthTest: false })
    );
    pin.center.set(0.5, 0);
    pin.position.set(dest.x, 1.3, -dest.y);
    pin.visible = false;
    this.routeGroup.add(pin);
    this._pin = pin;
  }

  clearRoute() {
    for (const s of this._signs) this.routeGroup.remove(s);
    this._signs = [];
    if (this._pin) this.routeGroup.remove(this._pin);
    this._pin = null;
    this.route = null;
    for (const c of this._chevrons) c.visible = false;
  }

  /**
   * 한 프레임 그리기.
   *  pos: { x, y } 지도상 위치 (없으면 아무것도 그리지 않는다), height: 카메라 높이,
   *  q: 카메라 자세, s: 경로상 현재 거리, nextIdx: 다음 안내 지점 번호,
   *  seenIds: 지금 인식 중인 마커, t: 초, dt: 초,
   *  routeOffset: 경로를 옆으로 옮겨 그릴 거리 { x, y } (지도 좌표, m). 화살표가 발밑에서 시작하게 할 때 쓴다
   *  sEnd: 경로상 이 거리까지만 화살표를 그린다 (다음 모퉁이를 조금 지난 곳). 모퉁이 뒤쪽은 실제로는
   *        벽에 가려 보이지 않는데, 그리면 화살표가 벽을 뚫고 이어지는 것처럼 보이기 때문이다.
   */
  frame({ pos, height, q, s, nextIdx, seenIds, t, dt, routeOffset, sEnd = Infinity }) {
    const ox = routeOffset ? routeOffset.x : 0;
    const oy = routeOffset ? routeOffset.y : 0;
    this.routeGroup.position.set(ox, 0, -oy);
    if (!pos) {
      this._hasPose = false;
      this.renderer.clear();
      return;
    }
    this.camera.position.set(pos.x, height, -pos.y);
    this._targetQ.set(q[0], q[1], q[2], q[3]);
    if (!this._hasPose) {
      this.camera.quaternion.copy(this._targetQ);
      this._hasPose = true;
    } else {
      this.camera.quaternion.slerp(this._targetQ, 1 - Math.exp(-dt / 0.05));
    }

    // 바닥 화살표: 발 앞에서 시작해 경로를 따라 흘러간다
    const route = this.route;
    const phase = (t * FLOW_SPEED) % SPACING;
    for (let i = 0; i < CHEVRONS; i++) {
      const mesh = this._chevrons[i];
      if (!route) {
        mesh.visible = false;
        continue;
      }
      const ahead = NEAR + phase + i * SPACING;
      const sI = s + ahead;
      if (sI > route.path.length - 0.15 || ahead > FAR || sI > sEnd) {
        mesh.visible = false;
        continue;
      }
      const p = route.path.pointAt(sI);
      mesh.visible = true;
      mesh.position.set(p.x, 0.02 + i * 0.0005, -p.y);
      mesh.rotation.y = -rad(p.bearing);
      mesh.scale.setScalar(1 + ahead * 0.035);
      const fadeIn = Math.min(1, (ahead - NEAR + 0.25) / 0.8);
      const fadeOut = Math.min(1, Math.max(0, (FAR - ahead) / 5));
      const fadeEnd = Math.min(1, Math.max(0.15, (sEnd - sI) / 1.2));
      mesh.material.opacity = 0.95 * fadeIn * fadeOut * fadeEnd;
    }

    // 꺾는 곳 표지판: 다음 한 곳만 (그다음 것은 모퉁이 뒤라 벽 너머로 보이게 된다).
    // 멀수록 크게 그려 화면에서 비슷한 크기로 보이게 한다
    for (let i = 0; i < this._signs.length; i++) {
      const g = this._signs[i];
      const d = Math.hypot(g.position.x + ox - pos.x, g.position.z - oy + pos.y);
      g.visible = i === nextIdx && d < 30;
      if (g.visible) {
        const size = Math.min(2.2, Math.max(0.42, d * 0.13));
        g.userData.sprite.scale.set(size, size, 1);
      }
    }

    if (this._pin) {
      const d = Math.hypot(this._pin.position.x + ox - pos.x, this._pin.position.z - oy + pos.y);
      // 목적지 핀은 마지막 직선 구간에 들어섰거나 아주 가까울 때만 (모퉁이 뒤의 핀이 벽 너머로 보이지 않게)
      this._pin.visible = d < 45 && (sEnd === Infinity || d < 6);
      const size = Math.min(2.6, Math.max(0.5, d * 0.15));
      this._pin.scale.set(size * 0.8, size, 1);
    }

    // QR 위치 표시: 가까운 것만. 인식 중이면 초록색으로 또렷하게.
    const pulse = 0.55 + 0.35 * Math.sin(t * 4);
    for (const [id, mesh] of this._beacons) {
      const d = Math.hypot(mesh.position.x - pos.x, mesh.position.z + pos.y);
      mesh.visible = d < 9;
      if (!mesh.visible) continue;
      const seen = seenIds && seenIds.includes(id);
      mesh.material.color.set(seen ? 0x19e07d : 0x2bc4ff);
      mesh.material.opacity = seen ? 1 : pulse;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
