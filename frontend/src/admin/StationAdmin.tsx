import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  currentSpace, loadLayouts, loadStation, spaceUrl, stationResponse, stationUrl, stationVersion,
  type Point, type StationLink, type StationDocument, type StationTag, type TagModel, type TagSurface, type Terrain,
} from '../ar/station';
import { StationPlan, type PlottedTag } from './StationPlan';
import { StationLinks } from './StationLinks';
import { TagConnections, draftGraph, graphPayload, removeGraphTag, type GraphDraft } from './TagConnections';
import { defaultWalk } from '../ar/tagRouting';
import { TagPrint } from './TagPrint';
import './admin.css';

const TerrainPreview = lazy(() => import('./TerrainPreview'));
const baseUrl = import.meta.env.BASE_URL;

type PointDraft = [string, string];
type AssetDraft = { model?: TagModel; upload?: File };
type TagDraft = AssetDraft & { id: string; center: PointDraft; walkPoint?: PointDraft; surface?: TagSurface; yaw: string; size: string };
type LayoutDraft = {
  graph?: GraphDraft;
  stationLinks: StationLink[];
  terrain: AssetDraft & { name: string; outline: PointDraft[] };
  route: PointDraft[];
  tags: TagDraft[];
};

const draftPoint = ([x, y]: Point): PointDraft => [String(x), String(y)];
const numeric = (value: string) => value.trim() !== '' && Number.isFinite(Number(value));
const validTagId = (value: string) => numeric(value) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 586;
const validPoint = (point: PointDraft) => point.every(numeric);
const toPoint = ([x, y]: PointDraft): Point => [Number(x), Number(y)];
const formatPosition = (value: string) => numeric(value) ? String(Number(Number(value).toFixed(3))) : '—';

function firstFreeId(taken: Set<number>) {
  for (let id = 0; id <= 586; id++) if (!taken.has(id)) return id;
}

async function spaceCatalog(signal?: AbortSignal) {
  return (await loadLayouts(signal)).map(({ id, station }) => ({
    id, name: station.terrain?.name ?? '기본 공간', tagIds: station.tags.map(tag => tag.id),
  }));
}

function terrainDraft(terrain?: Terrain): LayoutDraft['terrain'] {
  return { name: terrain?.name ?? '', outline: terrain?.outline?.map(draftPoint) ?? [], model: terrain?.model };
}

function layoutDraft({ station }: StationDocument): LayoutDraft {
  return {
    graph: draftGraph(station),
    stationLinks: station.stationLinks ?? [],
    terrain: terrainDraft(station.terrain),
    route: station.route.map(draftPoint),
    tags: station.tags.map(tag => ({
      id: String(tag.id), center: draftPoint(tag.center), walkPoint: tag.walkPoint && draftPoint(tag.walkPoint), surface: tag.surface, yaw: String(tag.yawDeg),
      size: tag.modelSizeM === undefined ? '' : String(tag.modelSizeM), model: tag.model,
    })),
  };
}

const icons = {
  map: ['M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z', 'M9 3v15m6-12v15'],
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5'],
  tag: ['M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6', 'M8 8h3v3H8zm6 0h2v2m-8 4h2v2m4-3v3h3'],
  exit: ['M10 3H4v18h6m-2-9h13m-5-5 5 5-5 5'],
  plus: ['M12 5v14M5 12h14'],
  edit: ['m13 6 5 5M4 20l4-.8L20 7l-4-4L4 15z'],
  cube: ['m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9'],
  chevron: ['m9 6 6 6-6 6'],
  save: ['M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-7h8v7'],
  trash: ['M4 6h16M9 6V3h6v3m3 0-1 15H7L6 6m4 4v7m4-7v7'],
  close: ['M6 6l12 12M18 6 6 18'],
  download: ['M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5'],
};

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icons[name].map(path => <path key={path} d={path} />)}
  </svg>;
}

function ModelField({ asset, label, fallback, change, onError }: {
  asset: AssetDraft; label: string; fallback: string;
  change: (asset: AssetDraft) => void; onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="admin-asset">
    <div className="admin-asset-file">
      <span className="admin-asset-icon"><Icon name="cube" /></span>
      <div><strong>{asset.upload?.name ?? asset.model?.name ?? fallback}</strong>
        <small>GLB · OBJ · 최대 32 MiB</small></div>
      {asset.model && !asset.upload && <a className="admin-icon-button" aria-label={label + ' 다운로드'}
        href={stationUrl + '/models/' + asset.model.file} download={asset.model.name}><Icon name="download" /></a>}
    </div>
    <div className="admin-asset-actions">
      <button type="button" className="admin-button" onClick={() => input.current?.click()}>{label + ' 선택'}</button>
      {(asset.model || asset.upload) && <button type="button" className="admin-text-button" onClick={() => change({})}>연결 해제</button>}
    </div>
    <input type="file" hidden ref={input} aria-label={label + ' 파일'} accept=".glb,.obj" onChange={event => {
      const upload = event.target.files?.[0];
      event.target.value = '';
      if (!upload) return;
      if (!/\.(glb|obj)$/i.test(upload.name) || upload.size > 32 * 1024 * 1024) {
        onError(label + '에 32 MiB 이하의 GLB 또는 OBJ 파일을 선택하세요.');
        return;
      }
      change({ ...asset, upload });
    }} />
  </div>;
}

function PointEditor({ label, points, change, min, max, optional = false }: {
  label: string; points: PointDraft[]; change: (points: PointDraft[]) => void; min: number; max: number; optional?: boolean;
}) {
  return <details className="admin-points">
    <summary><Icon name="chevron" /><span>{label}</span><small>{points.length}개</small></summary>
    <div>
      {points.map(([x, y], index) => <div className="admin-point" key={index}>
        <span className="admin-point-number">{index + 1}</span>
        <input aria-label={label + ' ' + (index + 1) + ' X (m)'} placeholder="X (m)" type="number" step="any" value={x}
          onChange={e => change(points.map((p, i) => i === index ? [e.target.value, y] : p))} />
        <input aria-label={label + ' ' + (index + 1) + ' Y (m)'} placeholder="Y (m)" type="number" step="any" value={y}
          onChange={e => change(points.map((p, i) => i === index ? [x, e.target.value] : p))} />
        <button type="button" className="admin-icon-button" disabled={!optional && points.length <= min}
          aria-label={label + ' ' + (index + 1) + ' 삭제'} onClick={() => change(points.filter((_, i) => i !== index))}>
          <Icon name="trash" />
        </button>
      </div>)}
      <button type="button" className="admin-text-button" disabled={points.length >= max}
        onClick={() => change([...points, ['', '']])}><Icon name="plus" /> 좌표 추가</button>
    </div>
  </details>;
}

async function saveModel(asset: AssetDraft, headers: Headers) {
  if (!asset.upload) return asset.model;
  const data = new FormData();
  data.append('file', asset.upload, 'model.' + asset.upload.name.split('.').pop()!.toLowerCase());
  const response = await stationResponse(await fetch(stationUrl + '/models', { method: 'POST', headers, body: data }));
  const model: TagModel = await response.json();
  return { file: model.file, name: asset.upload.name };
}

function tagPayload(tags: TagDraft[]) {
  const used = new Set<number>();
  return tags.map((tag): StationTag => {
    const id = Number(tag.id);
    if (!validTagId(tag.id) || used.has(id))
      throw new Error('중복되지 않는 0~586 사이의 태그 ID를 입력하세요.');
    if (!validPoint(tag.center) || !numeric(tag.yaw) || (tag.size && !(numeric(tag.size) && Number(tag.size) > 0)))
      throw new Error('태그 ' + id + '의 좌표와 방향을 입력하고, 모델 크기는 양수로 지정하세요.');
    if (tag.walkPoint && !validPoint(tag.walkPoint)) throw new Error('태그 ' + id + '의 보행 지점 좌표를 입력하세요.');
    used.add(id);
    return { id, center: toPoint(tag.center), walkPoint: tag.walkPoint && toPoint(tag.walkPoint), surface: tag.surface, yawDeg: Number(tag.yaw), modelSizeM: tag.size ? Number(tag.size) : undefined };
  });
}

export function StationAdmin() {
  const [print, setPrint] = useState<{ ids: number[]; needsSave: boolean }>();
  const printTrigger = useRef<HTMLElement | null>(null);

  async function showPrint(values: string[]) {
    const ids = values.map(Number);
    if (!values.every(validTagId) || new Set(ids).size !== ids.length) {
      setError('인쇄할 태그 ID는 0~586 사이의 서로 다른 정수여야 합니다.');
      return;
    }
    printTrigger.current = window.document.activeElement as HTMLElement | null;
    setBusy(true); setError('');
    try {
      const list = await spaceCatalog();
      setSpaces(list);
      for (const space of list) {
        if (space.id === spaceId) continue;
        const taken = space.tagIds.find(id => ids.includes(id));
        if (taken !== undefined) throw new Error('‘' + space.name + '’에서 태그 ' + taken + '번을 사용하고 있습니다. 다른 번호를 선택하세요.');
      }
      const savedIds = list.find(space => space.id === spaceId)?.tagIds ?? [];
      setPrint({ ids, needsSave: ids.some(id => !savedIds.includes(id)) });
    } catch (e) {
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : '태그 번호를 확인할 수 없습니다. 연결을 확인하고 다시 시도하세요.');
    } finally { setBusy(false); }
  }

  function closePrint() {
    setPrint(undefined);
    requestAnimationFrame(() => printTrigger.current?.focus());
  }

  const spaceId = currentSpace();
  const isNew = spaceId === 'new';
  const [spaces, setSpaces] = useState<Awaited<ReturnType<typeof spaceCatalog>>>([]);
  const [matchId, setMatchId] = useState('0');
  const [placing, setPlacing] = useState(false);
  const [panOnDrag, setPanOnDrag] = useState(false);
  const [placed, setPlaced] = useState('');
  const [document, setDocument] = useState<StationDocument>();
  const [draft, setDraft] = useState<LayoutDraft>();
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<'plan' | 'model'>('plan');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const empty: StationDocument = { station: { tagSideM: .16, tags: [], route: [], camera: { diagonalFovDeg: 70 } }, etag: '' };
    void Promise.all([spaceCatalog(controller.signal), isNew ? empty : loadStation(controller.signal, spaceId)]).then(([list, next]) => {
      if (controller.signal.aborted) return;
      setSpaces(list);
      setDocument(next);
      setDraft(layoutDraft(next));
      setView(next.station.terrain?.model ? 'model' : 'plan');
      setMatchId(String(next.station.tags[0]?.id ?? firstFreeId(new Set(list.flatMap(space => space.tagIds))) ?? ''));
      setPlacing(false);
      setPlaced('');
      setSelected(null);
      setDirty(false);
      setSaved(false);
      setConflict(false);
    }).catch(() => {
      if (!controller.signal.aborted) setError('서버에서 배치를 불러올 수 없습니다. 연결을 확인하고 다시 시도하세요.');
    }).finally(() => {
      if (!controller.signal.aborted) setBusy(false);
    });
    return () => controller.abort();
  }, [attempt, isNew, spaceId]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function update(patch: Partial<LayoutDraft>) {
    setDraft(old => old && { ...old, ...patch });
    setDirty(true);
    setSaved(false);
    if (!conflict) setError('');
  }

  function placeTag(center: Point, surface: TagSurface) {
    if (!draft || busy || !placing || matchOwner || !validTagId(matchId)) return;
    const id = Number(matchId);
    const index = draft.tags.findIndex(tag => numeric(tag.id) && Number(tag.id) === id);
    const position = { center: draftPoint(center), surface };
    if (index < 0) {
      update({ tags: [...draft.tags, { id: String(id), yaw: '0', size: '', ...position }] });
      setSelected(draft.tags.length);
    } else {
      update({ tags: draft.tags.map((tag, i) => i === index ? { ...tag, ...position } : tag) });
      setSelected(index);
    }
    setPlacing(false);
    setPlaced('태그 ' + id + ' 배치됨 · 높이 ' + surface.heightM.toFixed(3) + ' m');
  }

  function editTag(index: number) {
    setSelected(index);
    requestAnimationFrame(() => {
      editor.current?.scrollIntoView({ block: 'nearest' });
      editor.current?.querySelector('input')?.focus({ preventScroll: true });
    });
  }

  function selectMarker(index: number) {
    if (!draft) return;
    setSelected(index); setMatchId(draft.tags[index].id);
    setPlaced('태그 ' + draft.tags[index].id + ' 선택됨');
  }

  async function useExampleTerrain() {
    setBusy(true);
    setError('');
    try {
      const response = await stationResponse(await fetch(stationUrl + '/example-terrain'));
      const example = terrainDraft(await response.json());
      update({ terrain: { ...example, name: draft?.terrain.name || (isNew ? '' : example.name) } });
      setView('model');
    } catch (e) {
      setError(e instanceof Error ? e.message : '예시 지형을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!document || !draft || busy || conflict || !dirty) return;
    setError('');
    try {
      const name = draft.terrain.name.trim();
      const hasTerrain = Boolean(document.station.terrain || name || draft.terrain.model || draft.terrain.upload || draft.terrain.outline.length);
      if ((isNew || hasTerrain) && !name) throw new Error('공간 이름을 입력하세요.');
      const tags = tagPayload(draft.tags);
      const tagGraph = draft.graph ? graphPayload(draft.graph, tags) : null;
      if (!draft.route.every(validPoint)) throw new Error('안내 경로의 모든 좌표를 입력하세요.');
      if (draft.terrain.outline.length && (draft.terrain.outline.length < 3 || !draft.terrain.outline.every(validPoint)))
        throw new Error('바닥 경계를 그리려면 좌표를 3개 이상 입력하세요.');
      const route = draft.route.map(toPoint);
      if (route.length === 1) throw new Error('안내 경로에는 점이 두 개 이상 필요합니다.');
      if (route.some(([x, y], i) => i > 0 && Math.hypot(x - route[i - 1][0], y - route[i - 1][1]) < .05))
        throw new Error('인접한 경로점은 5 cm 이상 떨어져야 합니다.');
      setBusy(true);
      const headers = new Headers();
      const terrain: Terrain | undefined = hasTerrain ? {
        name, outline: draft.terrain.outline.length ? draft.terrain.outline.map(toPoint) : undefined,
        model: await saveModel(draft.terrain, headers),
      } : undefined;
      for (const [i, tag] of draft.tags.entries()) tags[i].model = await saveModel(tag, headers);
      headers.set('Content-Type', 'application/json');
      if (!isNew) headers.set('If-Match', document.etag);
      const response = await fetch(isNew ? stationUrl + '/spaces' : spaceUrl(spaceId), {
        method: isNew ? 'POST' : 'PUT', headers, body: JSON.stringify({ ...document.station, terrain, route, tags, tagGraph, stationLinks: draft.stationLinks }),
      });
      setConflict(response.status === 412);
      if (response.status === 409) await spaceCatalog().then(setSpaces).catch(() => {});
      await stationResponse(response);
      const body = await response.json();
      const next = { station: isNew ? body.station : body, etag: stationVersion(response) };
      if (isNew) history.replaceState(null, '', '?space=' + encodeURIComponent(body.id));
      else setSpaces(list => list.map(space => space.id === spaceId ? { ...space, name: name || '기본 공간' } : space));
      setDocument(next);
      setDraft(layoutDraft(next));
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : '저장하지 못했습니다. 서버 연결을 확인하세요.');
    } finally {
      setBusy(false);
    }
  }

  const tag = selected === null ? undefined : draft?.tags[selected];
  const owners = new Map<number, string>();
  for (const space of spaces) {
    if (space.id !== spaceId) for (const id of space.tagIds) owners.set(id, space.name);
  }
  const usedIds = new Set(owners.keys());
  for (const row of draft?.tags ?? []) if (validTagId(row.id)) usedIds.add(Number(row.id));
  const freeId = firstFreeId(usedIds);
  const matchOwner = validTagId(matchId) ? owners.get(Number(matchId)) : undefined;
  const tagOwner = tag && validTagId(tag.id) ? owners.get(Number(tag.id)) : undefined;
  const file = draft?.terrain.model?.file;
  const upload = draft?.terrain.upload;
  let route = draft?.route.every(validPoint) ? draft.route.map(toPoint) : [];
  const outline = draft?.terrain.outline.every(validPoint) ? draft.terrain.outline.map(toPoint) : [];
  const tags: PlottedTag[] = draft?.tags.flatMap((t, index) => validPoint(t.center) ?
    [{ index, id: t.id, center: toPoint(t.center), yaw: numeric(t.yaw) ? Number(t.yaw) : 0, surface: t.surface }] : []) ?? [];
  let passages: Point[][] = [];
  if (draft?.graph && document) {
    route = [];
    const nodes = draft.tags.map(t => t.walkPoint ?? t.center);
    passages = draft.graph.edges.flatMap(([a, b]) => nodes[a] && nodes[b] && validPoint(nodes[a]) && validPoint(nodes[b])
      ? [[toPoint(nodes[a]), toPoint(nodes[b])]] : []);
    try {
      const tags = tagPayload(draft.tags);
      const tagGraph = graphPayload(draft.graph, tags);
      route = defaultWalk({ ...document.station, tags, tagGraph });
    } catch { /* Keep drawing completed edges while another field is incomplete. */ }
  }
  const distance = route.reduce((length, [x, y], i) => i ? length + Math.hypot(x - route[i - 1][0], y - route[i - 1][1]) : 0, 0);

  return <>
    {print && document && <TagPrint ids={print.ids} needsSave={print.needsSave} sideM={document.station.tagSideM} close={closePrint} />}
    <div className="station-admin" hidden={!!print}>
    <aside className="admin-sidebar">
      <a className="admin-brand" href="#overview"><span><Icon name="map" /></span>통로 지도</a>
      <nav aria-label="관리 메뉴">
        <a href="#overview"><Icon name="overview" />배치 개요</a>
        <a href="#terrain"><Icon name="layers" />지형 데이터</a>
        <a href="#tags"><Icon name="tag" />AprilTag</a>
      </nav>
      <a className="admin-exit" href={baseUrl + '?view=ar&space=' + encodeURIComponent(isNew ? 'default' : spaceId)}><Icon name="exit" />실험 기록 카메라</a>
    </aside>

    <main className="admin-workspace" id="overview">
      <form onSubmit={save}>
        <div className="admin-top">
          <header className="admin-header">
            <div><h1>공간 관리</h1>
              <div className="admin-space-picker">
                <select aria-label="공간 선택" value={spaceId} disabled={busy}
                  onChange={e => location.assign('?space=' + encodeURIComponent(e.target.value))}>
                  {isNew && <option value="new">새 공간</option>}
                  {spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
                </select>
                {!isNew && <a className="admin-button" href="?space=new"><Icon name="plus" />새 공간</a>}
              </div>
            </div>
            <div className="admin-header-actions">
              {draft && <span className="admin-save-state" data-dirty={dirty} role="status">
                {busy ? '처리 중…' : dirty ? '저장되지 않은 변경' : saved ? '저장 완료' : '서버 배치'}
              </span>}
              <button className="admin-button admin-primary" disabled={!dirty || busy || conflict}><Icon name="save" />배치 저장</button>
            </div>
          </header>
          {(error || conflict) && <div className="admin-error" role="alert">
            <span>{error || '다른 기기에서 배치를 수정했습니다. 최신 배치를 불러와 다시 저장하세요.'}</span>
            {(conflict || !draft) && <button type="button" className="admin-button" disabled={busy}
              onClick={() => setAttempt(n => n + 1)}>{conflict ? '최신 배치 불러오기' : '다시 시도'}</button>}
          </div>}
        </div>
        {!draft && !error && <p className="admin-loading" role="status">서버 배치를 불러오는 중…</p>}
        {draft && document && <fieldset className="admin-fields" disabled={busy}>
          <div className="admin-overview">
            <section className="admin-panel admin-map-panel" ref={preview} tabIndex={-1} aria-labelledby="preview-title">
              <header className="admin-section-head">
                <div><h2 id="preview-title">공간 배치도</h2>
                  <p>{route.length >= 2 && '안내 경로 ' + distance.toFixed(2) + ' m · '}AprilTag {draft.tags.length}개</p>
                </div>
                <div className="admin-view-switch" role="group" aria-label="미리보기 방식">
                  <button type="button" aria-pressed={view === 'plan'} onClick={() => { setPlacing(false); setView('plan'); }}>평면</button>
                  <button type="button" aria-pressed={view === 'model'} disabled={!file && !upload} onClick={() => setView('model')}>3D</button>
                </div>
              </header>
              {view === 'model' && (file || upload) && <div className="admin-match-tools">
                <label>AprilTag ID<input type="number" min={0} max={586} step={1} list="space-tag-ids" value={matchId}
                  onChange={e => { setMatchId(e.target.value); setPlacing(false); setPlaced(''); }} /></label>
                <datalist id="space-tag-ids">{draft.tags.map((t, i) => <option key={i} value={t.id} />)}</datalist>
                <button type="button" className="admin-button" aria-pressed={placing}
                  disabled={!validTagId(matchId) || !!matchOwner}
                  onClick={() => { setPlaced(''); setPlacing(!placing); }}>
                  <Icon name="tag" />{placing ? '배치 취소' : '표면에 배치'}
                </button>
                <small role="status">{matchOwner ? '‘' + matchOwner + '’에서 사용 중인 번호입니다.' : placing ? '모델에서 태그 중심을 누르세요.' : placed || '방향키 이동 · 휠/핀치 확대'}</small>
                <div className="model-drag-mode">
                  <span>드래그</span>
                  <div className="admin-view-switch" role="group" aria-label="드래그 동작">
                    <button type="button" aria-pressed={!panOnDrag} onClick={() => setPanOnDrag(false)}>회전</button>
                    <button type="button" aria-pressed={panOnDrag} onClick={() => setPanOnDrag(true)}>이동</button>
                  </div>
                </div>
              </div>}
              {view === 'model' && (file || upload) ?
                <Suspense fallback={<div className="model-stage"><p role="status">3D 모델 불러오는 중…</p></div>}>
                  <TerrainPreview file={file} upload={upload} route={route} tags={tags} sideM={document.station.tagSideM} panOnDrag={panOnDrag}
                    armed={placing && !busy} selected={selected} onPlace={placeTag} onSelect={selectMarker} />
                </Suspense> :
                <StationPlan passages={passages} outline={outline} route={route} tags={tags} selected={selected} select={selectMarker} />}
              <div className="admin-map-legend">
                {(outline.length >= 3 || view === 'model') && <span><i className="legend-floor" />{view === 'model' ? '지형 모델' : '바닥 경계'}</span>}
                {route.length >= 2 && <span><i className="legend-route" />안내 경로</span>}
                <span><i className="legend-tag" />태그 위치</span>
                {tag && selected !== null && <button type="button" className="admin-text-button" onClick={() => editTag(selected)}>
                  태그 {tag.id} 편집
                </button>}
              </div>
            </section>
            <section className="admin-panel admin-terrain-panel" id="terrain" aria-labelledby="terrain-title">
              <header className="admin-section-head"><h2 id="terrain-title">지형 데이터</h2></header>
              <div className="admin-terrain-content">
                <label>공간 이름<input value={draft.terrain.name} maxLength={100}
                  onChange={e => update({ terrain: { ...draft.terrain, name: e.target.value } })} /></label>
                <StationLinks key={spaceId} links={draft.stationLinks} change={stationLinks => update({ stationLinks })} />
                <ModelField asset={draft.terrain} label="지형 모델" fallback="연결된 모델 없음"
                  onError={setError} change={asset => {
                    setView(asset.upload || asset.model ? 'model' : 'plan');
                    setPlacing(false); setPlaced('');
                    update({ terrain: { name: draft.terrain.name, outline: draft.terrain.outline, ...asset } });
                  }} />
                {!file && !upload && !draft.terrain.outline.length &&
                  <button type="button" className="admin-button" onClick={() => void useExampleTerrain()}>예시 지형 불러오기</button>}
                <div className="admin-geometry">
                  <PointEditor label="바닥 경계" points={draft.terrain.outline} min={3} max={256} optional
                    change={points => update({ terrain: { ...draft.terrain, outline: points } })} />
                  <TagConnections tags={draft.tags} graph={draft.graph} change={graph => update({ graph })} />
                  {!draft.graph && <PointEditor label="안내 경로" points={draft.route} min={2} max={4096} optional
                    change={points => update({ route: points })} />}
                </div>
                <p className="admin-coordinate-note">설치 좌표는 미터 단위입니다. 오른쪽이 +X, 정면이 +Y입니다.</p>
              </div>
            </section>
          </div>

          <section className="admin-panel admin-tags-panel" id="tags" aria-labelledby="tags-title">
            <header className="admin-section-head">
              <div><h2 id="tags-title">AprilTag <span className="admin-count">{draft.tags.length}</span></h2>
                <p>tag36h11 · 한 변 {(document.station.tagSideM * 1000).toLocaleString('ko-KR')} mm</p>
              </div>
              <div className="admin-tag-actions">
                {draft.tags.length > 1 && <button type="button" className="admin-button" onClick={() => showPrint(draft.tags.map(t => t.id))}>전체 인쇄</button>}
                {freeId === undefined && <small>사용할 수 있는 태그 번호가 없습니다.</small>}
                <button type="button" className="admin-button" disabled={freeId === undefined} onClick={() => {
                update({ tags: [...draft.tags, { id: String(freeId), center: ['', ''], yaw: '0', size: '' }] });
                editTag(draft.tags.length);
              }}><Icon name="plus" />태그 생성</button>
              </div>
            </header>
            {tag && selected !== null && <div className="admin-tag-editor" ref={editor}>
              <div className="admin-tag-editor-head">
                <h3>{tag.id ? '태그 ' + tag.id + ' 편집' : '새 태그 편집'}</h3>
                <div className="admin-tag-actions">
                  <button type="button" className="admin-button" disabled={!validTagId(tag.id) || !!tagOwner} onClick={() => void showPrint([tag.id])}>이 태그 인쇄</button>
                  <button type="button" className="admin-icon-button" aria-label="태그 편집 닫기"
                  onClick={() => setSelected(null)}><Icon name="close" /></button>
                </div>
              </div>
              <div className="admin-tag-inputs">
                <label>태그 ID<input type="number" min={0} max={586} step={1} value={tag.id}
                  onChange={e => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, id: e.target.value } : t) })} /></label>
                <label>X (m)<input type="number" step="any" value={tag.center[0]}
                  onChange={e => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, center: [e.target.value, t.center[1]] } : t) })} /></label>
                <label>Y (m)<input type="number" step="any" value={tag.center[1]}
                  onChange={e => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, center: [t.center[0], e.target.value] } : t) })} /></label>
                <label>방향 (°)<input type="number" step="any" value={tag.yaw}
                  onChange={e => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, yaw: e.target.value } : t) })} /></label>
                <label>모델 크기 (m)<input type="number" step="any" value={tag.size} placeholder={String(document.station.tagSideM)}
                  onChange={e => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, size: e.target.value } : t) })} /></label>
              </div>
              {draft.graph && <div className="tag-connections">
                <label><input type="checkbox" checked={!!tag.walkPoint} onChange={e => update({ tags: draft.tags.map((t, i) =>
                  i === selected ? { ...t, walkPoint: e.target.checked ? [...t.center] : undefined } : t) })} /> 별도 보행 지점 지정</label>
                {tag.walkPoint && <div className="tag-edge">{(['X', 'Y'] as const).map((axis, j) => <label key={axis}>보행 {axis} (m)
                  <input type="number" step="any" value={tag.walkPoint![j]} onChange={e => update({ tags: draft.tags.map((t, i) =>
                    i === selected ? { ...t, walkPoint: j === 0 ? [e.target.value, t.walkPoint![1]] : [t.walkPoint![0], e.target.value] } : t) })} /></label>)}</div>}
              </div>}
              {tagOwner && <p role="status">‘{tagOwner}’에서 태그 {tag.id}번을 사용하고 있습니다. 다른 번호를 선택하세요.</p>}
              <p>{tag.surface ? '표면 높이 ' + tag.surface.heightM.toFixed(3) + ' m · 방향은 선택한 면에서 시계 방향으로 잽니다.'
                : '방향은 +Y에서 시계 방향으로 잽니다.'} 모델 크기는 가장 긴 변을 기준으로 맞춥니다.</p>
              {validPoint(tag.center) && <button type="button" className="admin-button" onClick={() => {
                setPlacing(false); setView('plan');
                preview.current?.focus({ preventScroll: true }); preview.current?.scrollIntoView({ block: 'center' });
              }}>평면에서 위치 보기</button>}
              {(file || upload) && <button type="button" className="admin-button" disabled={!validTagId(tag.id) || !!tagOwner}
                onClick={() => {
                  setMatchId(tag.id); setPlaced(''); setPlacing(true); setView('model');
                  window.document.getElementById('preview-title')?.scrollIntoView({ block: 'center' });
                }}>모델에서 위치 지정</button>}
              <ModelField asset={tag} label="태그 모델" fallback="기본 위치 핀" onError={setError}
                change={asset => update({ tags: draft.tags.map((t, i) => i === selected ? { ...t, model: asset.model, upload: asset.upload } : t) })} />
              <button type="button" className="admin-text-button admin-delete" onClick={() => {
                update({ tags: draft.tags.filter((_, i) => i !== selected), graph: removeGraphTag(draft.graph, selected) });
                setSelected(null);
              }}><Icon name="trash" />태그 삭제</button>
            </div>}
            {draft.tags.length ? <div className="admin-table-scroll" tabIndex={0} aria-label="AprilTag 목록">
              <table>
                <thead><tr><th scope="col">태그 ID</th><th scope="col">X (m)</th><th scope="col">Y (m)</th>
                  <th scope="col">방향</th><th scope="col">연결 모델</th><th scope="col">인쇄</th></tr></thead>
                <tbody>{draft.tags.map((row, index) => <tr key={index} data-selected={index === selected}>
                  <th scope="row"><button type="button" className="admin-table-id admin-edit-id" aria-label={'태그 ' + (row.id || '새 태그') + ' 수정'}
                    onClick={() => editTag(index)}>{row.id || '새 태그'}<Icon name="edit" /></button></th>
                  <td>{formatPosition(row.center[0])}</td><td>{formatPosition(row.center[1])}</td><td>{row.yaw ? row.yaw + '°' : '—'}</td>
                  <td>{row.upload?.name ?? row.model?.name ?? '기본 위치 핀'}</td>
                  <td><button type="button" className="admin-button admin-row-print" disabled={!validTagId(row.id)}
                    aria-label={'태그 ' + row.id + ' 인쇄'} onClick={() => showPrint([row.id])}>인쇄</button></td>
                </tr>)}</tbody>
              </table>
            </div> : <p className="admin-empty">등록된 태그가 없습니다.</p>}
          </section>
        </fieldset>}
      </form>
    </main>
  </div></>;
}
