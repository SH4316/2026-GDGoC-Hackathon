import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, Group, Line, LineBasicMaterial,
  DoubleSide, Matrix3, Matrix4, Mesh, MeshBasicMaterial, NearestFilter, PerspectiveCamera, PlaneGeometry,
  MOUSE, Raycaster, Scene, TextureLoader, TOUCH, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { disposeAssets, loadModelAsset, parseModelAsset, tagFrame } from '../ar/models';
import atlasUrl from './tag36h11.png';
import type { Axis, Point, TagSurface } from '../ar/station';
import type { PlottedTag } from './StationPlan';
import { TagMarkers, type TagPoint } from './TagMarkers';

export default function TerrainPreview({ file, upload, route, tags, sideM, panOnDrag, armed, selected, onPlace, onSelect }: {
  file?: string; upload?: File; route: Point[]; tags: PlottedTag[]; sideM: number;
  panOnDrag: boolean; armed: boolean; selected: number | null;
  onPlace: (center: Point, surface: TagSurface) => void; onSelect: (index: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLCanvasElement>(null);
  const orbit = useRef<OrbitControls | null>(null);
  const overlays = useRef<{ group: Group; material: MeshBasicMaterial; render: () => void } | null>(null);
  const [notice, setNotice] = useState('3D 모델 불러오는 중…');
  const [projection, setProjection] = useState<{ width: number; height: number; points: TagPoint[] }>({ width: 0, height: 0, points: [] });

  const actions = useRef({ armed, onPlace, onSelect });
  useLayoutEffect(() => { actions.current = { armed, onPlace, onSelect }; }, [armed, onPlace, onSelect]);
  const [missed, setMissed] = useState(false);
  useEffect(() => { setMissed(false); }, [armed, file, upload]);

  useEffect(() => {
    const frame = host.current!;
    const lifetime = new AbortController();
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas: surface.current!, antialias: true });
    } catch {
      setNotice('이 브라우저에서는 3D를 표시할 수 없습니다. 평면 보기를 사용하세요.');
      return;
    }
    setNotice('3D 모델 불러오는 중…');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new Scene();
    scene.background = new Color('#142a32');
    const camera = new PerspectiveCamera(44);
    camera.position.set(2, 3, 4);
    const controls = new OrbitControls(camera, frame);
    orbit.current = controls;
    controls.listenToKeyEvents(renderer.domElement);

    const overlay = new Group();
    const assets = new Group();
    const light = new DirectionalLight('#dff7ff', 2);
    light.position.set(4, 8, 5);
    scene.add(assets, overlay, new AmbientLight('#c1e3e2', 2), light);

    const projected = new Vector3();
    const render = () => {
      renderer.render(scene, camera);
      const width = frame.clientWidth, height = frame.clientHeight;
      const points: TagPoint[] = [];
      for (const marker of overlay.children) {
        if (!(marker instanceof Mesh)) continue;
        projected.copy(marker.position).project(camera);
        if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) continue;
        points.push({ index: marker.userData.index, id: marker.userData.tagId,
          x: (1 + projected.x) * width / 2, y: (1 - projected.y) * height / 2 });
      }
      setProjection({ width, height, points });
    };
    const atlas = new TextureLoader().load(atlasUrl, () => { if (!lifetime.signal.aborted) render(); });
    atlas.minFilter = atlas.magFilter = NearestFilter;
    atlas.generateMipmaps = false;
    const material = new MeshBasicMaterial({ map: atlas, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    overlays.current = { group: overlay, material, render };

    const canvas = renderer.domElement;
    let tap: { id: number; x: number; y: number; marker?: string } | undefined;
    const pointerDown = (e: PointerEvent) => {
      const marker = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-tag-index]') : null;
      tap = e.isPrimary && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, marker: marker?.dataset.tagIndex } : undefined;
    };
    const pointerMove = (e: PointerEvent) => {
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 5) tap = undefined;
    };
    const pointerUp = (e: PointerEvent) => {
      if (!tap || tap.id !== e.pointerId) return;
      const start = tap;
      tap = undefined;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5 || !assets.children.length) return;
      if (!actions.current.armed && start.marker !== undefined) {
        actions.current.onSelect(Number(start.marker));
        return;
      }
      const box = canvas.getBoundingClientRect();
      const pointer = new Vector2(2 * (e.clientX - box.left) / box.width - 1, 1 - 2 * (e.clientY - box.top) / box.height);
      const ray = new Raycaster();
      ray.setFromCamera(pointer, camera);
      const hit = ray.intersectObjects(assets.children, true).find(hit => hit.face);
      if (!actions.current.armed) {
        const marker = ray.intersectObjects(overlay.children).find(h => h.object.userData.index !== undefined);
        if (marker && (!hit || marker.distance <= hit.distance + 1e-5)) actions.current.onSelect(marker.object.userData.index);
        return;
      }
      if (!hit?.face) { setMissed(true); return; }
      const normal = hit.face.normal.clone().applyNormalMatrix(new Matrix3().getNormalMatrix(hit.object.matrixWorld));
      if (normal.dot(ray.ray.direction) > 0) normal.negate();
      // OBJ is Y-up. Store the frame in station coordinates (+Z up).
      normal.set(normal.x, -normal.z, normal.y);
      const reference = Math.abs(normal.z) < .7 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
      const right = reference.cross(normal).normalize();
      const up = new Vector3().crossVectors(normal, right).normalize();
      setMissed(false);
      actions.current.onPlace([hit.point.x, -hit.point.z],
        { heightM: hit.point.y, right: right.toArray() as Axis, up: up.toArray() as Axis });
    };
    frame.addEventListener('pointerdown', pointerDown, { signal: lifetime.signal });
    frame.addEventListener('pointermove', pointerMove, { signal: lifetime.signal });
    frame.addEventListener('pointerup', pointerUp, { signal: lifetime.signal });
    frame.addEventListener('pointercancel', () => { tap = undefined; }, { signal: lifetime.signal });
    controls.addEventListener('change', render);
    const resize = new ResizeObserver(() => {
      if (!frame.clientWidth || !frame.clientHeight) return;
      renderer.setSize(frame.clientWidth, frame.clientHeight);
      camera.aspect = frame.clientWidth / frame.clientHeight;
      camera.updateProjectionMatrix();
      render();
    });
    resize.observe(frame);

    const model = upload ? upload.arrayBuffer().then(data => parseModelAsset(data, upload.name))
      : file ? loadModelAsset(file, lifetime.signal) : Promise.reject(new Error('missing model'));
    void model.then(mesh => {
      if (lifetime.signal.aborted) { disposeAssets([mesh]); return; }
      const bounds = new Box3().setFromObject(mesh);
      if (bounds.isEmpty()) {
        disposeAssets([mesh]);
        throw new Error('empty model');
      }
      mesh.traverse(node => {
        if (node instanceof Mesh) {
          for (const mat of Array.isArray(node.material) ? node.material : [node.material]) {
            // A cutaway ceiling uses its authored front face for the view from inside.
            if (mat.userData.cutawayCeiling !== true) mat.side = DoubleSide;
          }
        }
      });
      assets.add(mesh);
      const center = bounds.getCenter(new Vector3());
      const span = bounds.getSize(new Vector3()).length() || 1;
      camera.position.copy(center).addScaledVector(new Vector3(.5, .83, 1), span);
      camera.near = span / 200;
      camera.far = span * 25;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      // Frame the projected bounds, including tall models and narrow viewports.
      let extent = 0;
      mesh.traverse(part => {
        if (!(part instanceof Mesh)) return;
        const box = 'boundingBox' in part ? part.boundingBox : part.geometry.boundingBox;
        if (!(box instanceof Box3) || box.isEmpty()) return;
        for (const x of [box.min.x, box.max.x]) {
          for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
              projected.set(x, y, z).applyMatrix4(part.matrixWorld).project(camera);
              extent = Math.max(extent, Math.abs(projected.x), Math.abs(projected.y));
            }
          }
        }
      });
      if (extent > 0) camera.zoom = .85 / extent;
      camera.updateProjectionMatrix();
      // OrbitControls measures perspective pans at zoom 1. Match the fitted view to the pointer.
      controls.panSpeed = 1 / camera.zoom;
      controls.keyPanSpeed = 32 / camera.zoom;
      setNotice('');
      render();
    }).catch(() => {
      if (!lifetime.signal.aborted) setNotice('3D 모델을 열 수 없습니다. 파일 형식을 확인하세요.');
    });

    return () => {
      lifetime.abort();
      resize.disconnect();
      controls.dispose();
      orbit.current = null;
      overlays.current = null;
      disposeAssets([assets]);
      atlas.dispose(); material.dispose();
      renderer.dispose();
    };
  }, [file, upload]);

  useEffect(() => {
    const controls = orbit.current;
    if (!controls) return;
    controls.mouseButtons.LEFT = panOnDrag ? MOUSE.PAN : MOUSE.ROTATE;
    controls.touches.ONE = panOnDrag ? TOUCH.PAN : TOUCH.ROTATE;
  }, [panOnDrag, file, upload]);

  useEffect(() => {
    const scene = overlays.current;
    if (!scene) return;
    const line = new Line(new BufferGeometry().setFromPoints(route.map(([x, y]) => new Vector3(x, .026, -y))),
      new LineBasicMaterial({ color: '#176454' }));
    if (route.length > 1) scene.group.add(line);
    const fromStation = new Matrix4().makeRotationX(-Math.PI / 2);
    for (const tag of tags) {
      const id = Number(tag.id);
      if (!tag.id || !Number.isInteger(id) || id < 0 || id > 586) continue;
      // 32 columns × 19 rows, with a one-cell quiet zone around each 8-cell marker.
      const geometry = new PlaneGeometry(sideM * 10 / 8, sideM * 10 / 8);
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, (id % 32 + uv.getX(i)) / 32, (18 - Math.floor(id / 32) + uv.getY(i)) / 19);
      }
      const marker = new Mesh(geometry, scene.material);
      marker.userData.index = tag.index;
      marker.userData.tagId = tag.id;
      marker.position.set(tag.center[0], tag.surface?.heightM ?? 0, -tag.center[1]);
      marker.setRotationFromMatrix(fromStation.clone().multiply(tagFrame(tag.surface, tag.yaw)));
      if (selected === tag.index) {
        const half = sideM * .66;
        const corners = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]];
        const border = new Line(new BufferGeometry().setFromPoints(corners.map(([x,y]) => new Vector3(x,y,.001))),
          new LineBasicMaterial({ color: '#ffa83c' }));
        marker.add(border);
      }
      scene.group.add(marker);
    }
    scene.render();
    return () => {
      scene.group.traverse(node => {
        if (node instanceof Mesh) node.geometry.dispose();
        if (node instanceof Line && node !== line) { node.geometry.dispose(); node.material.dispose(); }
      });
      scene.group.clear();
      line.geometry.dispose();
      line.material.dispose();
    };
  }, [route, tags, file, upload, selected, sideM]);

  return <div className="model-stage" ref={host} data-placing={armed} data-pan={panOnDrag}>
    <canvas ref={surface} tabIndex={0} role="img" aria-label="공간 3D 모델과 AprilTag" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" />
    {!notice && <TagMarkers {...projection} selected={selected} select={onSelect} placing={armed} model />}
    {armed && missed && !notice && <p role="status">모델의 면을 다시 눌러 주세요.</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
