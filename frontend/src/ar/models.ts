import {
  AmbientLight, Box3, Camera, Color, DirectionalLight, Group, LatheGeometry, LoadingManager,
  Material, Matrix4, Mesh, MeshStandardMaterial, Object3D, Scene, Texture, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { Fix, Intrinsics } from './recording';
import { stationUrl, type Station, type StationTag, type TagSurface } from './station';

// The local XY plane is the print, with +Y pointing to its top edge.
export function tagFrame(surface: TagSurface | undefined, yawDeg: number) {
  const right = new Vector3(...(surface?.right ?? [1, 0, 0] as const));
  const up = new Vector3(...(surface?.up ?? [0, 1, 0] as const));
  return new Matrix4().makeBasis(right, up, new Vector3().crossVectors(right, up))
    .multiply(new Matrix4().makeRotationZ(-yawDeg * Math.PI / 180));
}

function locationPin() {
  const profile = [[0, 0], [.15, .30], [.29, .52], [.33, .67], [.30, .81], [.21, .94], [0, 1]];
  return new Mesh(new LatheGeometry(profile.map(([r, h]) => new Vector2(r, h)), 24),
    new MeshStandardMaterial({ color: new Color('#ffb44d'), roughness: .5 }));
}

export async function parseModelAsset(data: ArrayBuffer, filename: string) {
  const manager = new LoadingManager();
  // Uploaded GLBs are self-contained. The loader creates blob URLs for embedded textures.
  manager.setURLModifier(url => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    throw new Error('모델에 외부 파일이 포함되어 있습니다.');
  });
  return filename.toLowerCase().endsWith('.obj') ? new OBJLoader().parse(new TextDecoder().decode(data))
    : (await new GLTFLoader(manager).parseAsync(data, '')).scene;
}

export async function loadModelAsset(file: string, signal: AbortSignal) {
  const response = await fetch(stationUrl + '/models/' + file, { signal });
  if (!response.ok) throw new Error('모델 다운로드 실패');
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  return parseModelAsset(data, file);
}

async function loadMesh(file: string, signal: AbortSignal) {
  const source = await loadModelAsset(file, signal);
  const box = new Box3().setFromObject(source);
  const size = box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (!(longest > 0 && Number.isFinite(longest))) {
    disposeAssets([source]);
    throw new Error('모델에 표시할 형상이 없습니다.');
  }
  const center = box.getCenter(new Vector3());
  const centered = new Group();
  centered.add(source);
  centered.position.set(-center.x, -box.min.y, -center.z);
  const normalized = new Group();
  normalized.scale.setScalar(1 / longest);
  normalized.add(centered);
  return normalized;
}

export function disposeAssets(roots: Object3D[]) {
  const materials = new Set<Material>(), textures = new Set<Texture>();
  for (const root of roots) root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    node.geometry.dispose();
    for (const material of ([] as Material[]).concat(node.material)) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    texture.dispose();
    const bitmap = texture.source.data;
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close();
  }
}

// Apply the same OpenCV radial/tangential distortion as the camera image, after skinning and projection.
function applyLens(root: Object3D, coefficients?: number[]) {
  if (!coefficients?.some(v => v !== 0)) return;
  const lens = [...coefficients];
  while (lens.length < 8) lens.push(0);
  root.traverse(node => {
    if (!(node instanceof Mesh)) return;
    for (const material of ([] as Material[]).concat(node.material)) {
      material.onBeforeCompile = shader => {
        shader.uniforms.stationLens = { value: lens };
        shader.vertexShader = 'uniform float stationLens[8];\n' + shader.vertexShader.replace(
          '#include <project_vertex>', `#include <project_vertex>
          if (mvPosition.z < -0.001) {
            vec2 p = vec2(mvPosition.x, -mvPosition.y) / -mvPosition.z;
            float r2 = dot(p, p), r4 = r2*r2, r6 = r4*r2;
            float radial = (1.0 + stationLens[0]*r2 + stationLens[1]*r4 + stationLens[4]*r6)
                         / (1.0 + stationLens[5]*r2 + stationLens[6]*r4 + stationLens[7]*r6);
            vec2 shift = p * (radial - 1.0) + vec2(
              2.0*stationLens[2]*p.x*p.y + stationLens[3]*(r2 + 2.0*p.x*p.x),
              stationLens[2]*(r2 + 2.0*p.y*p.y) + 2.0*stationLens[3]*p.x*p.y);
            gl_Position.xy += gl_Position.w * shift * vec2(projectionMatrix[0][0], -projectionMatrix[1][1]);
          }`);
      };
    }
  });
}

export class TagModels {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private readonly cameraAxes = new Matrix4().makeScale(1, -1, -1);
  private readonly tags: Map<number, StationTag>;
  private readonly anchors = new Map<number, Group>();
  private readonly templates = new Map<string, Promise<Object3D>>();
  private readonly pin = locationPin();
  private readonly resources: Object3D[] = [this.pin];
  private readonly lifetime = new AbortController();

  constructor(canvas: HTMLCanvasElement, private station: Station, private notice: (message: string, tagId?: number) => void) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0, 0);
    this.camera.matrixAutoUpdate = false;
    this.tags = new Map(station.tags.map(tag => [tag.id, tag]));
    applyLens(this.pin, station.camera.calibration?.distortion);
    const light = new DirectionalLight(0xfff5dd, 2.4);
    light.position.set(-2, -3, 5);
    this.scene.add(new AmbientLight(0xffffff, 1.65), light);
  }

  private anchor(tag: StationTag) {
    const group = new Group();
    group.position.set(...tag.center, tag.surface?.heightM ?? 0);
    group.setRotationFromMatrix(tagFrame(tag.surface, tag.yawDeg));
    group.rotateX(Math.PI / 2);
    group.scale.setScalar(tag.modelSizeM ?? this.station.tagSideM);
    group.add(this.pin.clone());
    this.scene.add(group);
    this.anchors.set(tag.id, group);
    if (tag.model) {
      const file = tag.model.file;
      let template = this.templates.get(file);
      if (!template) {
        template = loadMesh(file, this.lifetime.signal).then(mesh => {
          if (this.lifetime.signal.aborted) { disposeAssets([mesh]); throw new Error('closed'); }
          applyLens(mesh, this.station.camera.calibration?.distortion);
          this.resources.push(mesh);
          return mesh;
        });
        this.templates.set(file, template);
      }
      void template.then(mesh => {
        if (!this.lifetime.signal.aborted) { group.clear(); group.add(clone(mesh)); }
      }).catch(() => {
        if (!this.lifetime.signal.aborted) this.notice('태그 {id} 모델을 열 수 없어 기본 위치 핀을 표시합니다.', tag.id);
      });
    }
    return group;
  }

  draw(fix: Fix, [fx, fy, cx, cy]: Intrinsics, w: number, h: number) {
    if (this.renderer.domElement.width !== w || this.renderer.domElement.height !== h)
      this.renderer.setSize(w, h, false);
    // Pixel centers, off-axis principal point, and the tracker's +Z-forward camera convention.
    const near = .02, far = 200;
    this.camera.projectionMatrix.set(
      2*fx/w, 0, 1-2*(cx+.5)/w, 0,
      0, 2*fy/h, 2*(cy+.5)/h-1, 0,
      0, 0, -(far+near)/(far-near), -2*far*near/(far-near),
      0, 0, -1, 0);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrix.fromArray(fix.cameraToWorld).transpose().multiply(this.cameraAxes);
    this.camera.matrixWorldNeedsUpdate = true;
    for (const group of this.anchors.values()) group.visible = false;
    for (const id of fix.ids) {
      const tag = this.tags.get(id);
      if (tag) (this.anchors.get(id) ?? this.anchor(tag)).visible = true;
    }
    this.renderer.render(this.scene, this.camera);
  }

  clear() { this.renderer.clear(); }

  dispose() {
    this.lifetime.abort();
    disposeAssets(this.resources);
    this.renderer.dispose();
  }
}
