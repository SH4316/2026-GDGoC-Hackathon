import { useEffect, useMemo, useRef, useState } from 'react';
import { PassageBar } from './PassageProgress';
import { measurePassage, passageMeters, pointAlong, type PassageRoute, type Turn } from './passageRoute';
import { loadTrackingSpaces, spaceLabel, stationName, type Point, type SpaceLayout } from './station';
import './passage-preview.css';

const arrows = {
  straight: 'M12 21V3m-7 7 7-7 7 7',
  left: 'M19 21v-8a4 4 0 0 0-4-4H4m6-6L4 9l6 6',
  right: 'M5 21v-8a4 4 0 0 1 4-4h11m-6-6 6 6-6 6',
  uturn: 'M6 21V9a6 6 0 0 1 12 0v8m-5-5 5 5 5-5',
  arrival: 'M5 22V3m0 1c5-4 9 4 15 0v10c-6 4-10-4-15 0',
  route: 'M5 16V8a3 3 0 0 1 3-3h8m-4-3 4 3-4 4M19 9v7a3 3 0 0 1-3 3H8m4-3-4 3 4 3',
  close: 'm6 6 12 12M18 6 6 18',
  previous: 'm14 6-6 6 6 6',
  next: 'm10 6 6 6-6 6',
  play: 'm7 4 12 8-12 8Z',
  pause: 'M8 5v14M16 5v14',
  replay: 'M4 11a8 8 0 1 1 2 7M4 4v7h7',
} as const;

function Icon({ name }: { name: keyof typeof arrows }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={arrows[name]} /></svg>;
}

function routeName(layout: SpaceLayout) {
  const links = layout.station.stationLinks;
  const from = links?.find(stop => stop.routeEndpoint === 'start'), to = links?.find(stop => stop.routeEndpoint === 'end');
  if (from && to && stationName(from.name) === stationName(to.name)) return stationName(from.name) + ' · ' + from.line + ' → ' + to.line;
  return spaceLabel(layout.station);
}

function planGeometry(layout: SpaceLayout, route: PassageRoute) {
  const outline = layout.station.terrain?.outline ?? [];
  const points = layout.station.route;
  const all = [...outline, ...points];
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.max(...ys), bottom = Math.min(...ys);
  const scale = Math.min(344 / (right - left || 1), 210 / (top - bottom || 1));
  const project = ([x, y]: Point): Point => [208 + (x - (left + right) / 2) * scale, 139 - (y - (top + bottom) / 2) * scale];
  const sections: Point[][] = [];
  for (const segment of route.segments) {
    if (segment.offset === route.stages[sections.length]?.offset) sections.push([project(segment.start)]);
    sections[sections.length - 1].push(project(segment.end));
  }
  return { project, outline: outline.map(project).join(' '), path: points.map(project).join(' '),
    sections: sections.map(section => section.join(' ')), corners: sections.slice(1).map(section => section[0]),
    start: project(points[0]), end: project(points[points.length - 1]) };
}

function PassagePlan({ route, layout, distance, stageIndex }: {
  route: PassageRoute; layout: SpaceLayout; distance: number; stageIndex: number;
}) {
  const plan = useMemo(() => planGeometry(layout, route), [layout, route]);
  const { start, end } = plan;
  const position = plan.project(pointAlong(route, distance));
  return <svg className="preview-plan" viewBox="0 0 416 278" role="img" aria-label={routeName(layout) + ' 실내 경로 평면도'}>
    {plan.outline && <polygon points={plan.outline} className="preview-outline" />}
    <polyline points={plan.path} className="preview-path" />
    {plan.sections[stageIndex] && <polyline points={plan.sections[stageIndex]} className="preview-active-path" />}
    {plan.corners.map(([x, y], index) => <circle key={index} cx={x} cy={y} r="3.5" className="preview-waypoint" />)}
    <circle cx={start[0]} cy={start[1]} r="5" className="preview-waypoint" />
    <rect x={end[0] - 5} y={end[1] - 5} width="10" height="10" rx="1" className="preview-waypoint" />
    {([['출발', start], ['도착', end]] as const).map(([label, [x, y]], index) =>
      <text key={label} x={x} y={y + (index ? -16 : 26)} textAnchor="middle">{label}</text>)}
    <circle cx={position[0]} cy={position[1]} r="8" className="preview-cursor" />
    <circle cx={position[0]} cy={position[1]} r="2.5" fill="#173d32" />
  </svg>;
}

const directions: Record<Turn, string> = { straight: '직진', left: '좌회전 후 직진', right: '우회전 후 직진', uturn: '돌아서 직진' };

function Playback({ layout, route }: { layout: SpaceLayout; route: PassageRoute }) {
  const [distance, setDistance] = useState(0);
  const [play, setPlay] = useState(false);
  const arrived = distance >= route.length;
  const playing = play && !arrived;
  const index = arrived ? route.stages.length : route.stages.findLastIndex(stage => stage.offset <= distance);
  const stage = route.stages[index], nextStage = route.stages[index + 1];
  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    // Fit the walkthrough to presentation time, independent of real walking speed.
    const timer = window.setInterval(() => {
      const now = performance.now(), elapsed = now - previous;
      previous = now;
      setDistance(d => Math.min(route.length, d + route.length * elapsed / 20000));
    }, 80);
    const pauseWhenHidden = () => { if (document.hidden) setPlay(false); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', pauseWhenHidden); };
  }, [playing, route]);
  function move(to: number) { setPlay(false); setDistance(to); }
  const nextLabel = !nextStage ? '도착까지' : nextStage.turn === 'left' ? '좌회전까지' : nextStage.turn === 'right' ? '우회전까지' : '반환점까지';
  return <>
    <div className="preview-board">
      <div className="preview-map"><PassagePlan route={route} layout={layout} distance={distance} stageIndex={index} /></div>
      <div className="preview-instruction">
        <div className="preview-direction" aria-hidden="true"><Icon name={stage?.turn ?? 'arrival'} /></div>
        <div aria-live="polite" aria-atomic="true" className="preview-cue">
          <span>{arrived ? '경로 끝' : (index + 1) + ' / ' + route.stages.length + ' 구간'}</span>
          <h3>{stage ? directions[stage.turn] : '도착'}</h3>
        </div>
        <p>{arrived ? '전체 거리' : nextLabel} <strong>{passageMeters(arrived ? route.length : (nextStage?.offset ?? route.length) - distance)}</strong></p>
      </div>
    </div>
    <div className="preview-transport">
      <PassageBar route={route} distance={distance} />
      <div className="preview-actions">
        <button type="button" disabled={index === 0} onClick={() => move(route.stages[index - 1].offset)}><Icon name="previous" />이전 단계</button>
        <button type="button" className="preview-play" onClick={() => {
          if (arrived) setDistance(0);
          setPlay(!playing);
        }}><Icon name={arrived ? 'replay' : playing ? 'pause' : 'play'} />{arrived ? '다시 재생' : playing ? '일시 정지' : '경로 재생'}</button>
        <button type="button" disabled={arrived} onClick={() => move(nextStage?.offset ?? route.length)}>다음 단계<Icon name="next" /></button>
      </div>
    </div>
  </>;
}

type MappedPassage = { layout: SpaceLayout; route: PassageRoute };

function PreviewDialog({ dismiss }: { dismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [passages, setPassages] = useState<MappedPassage[]>();
  const [selected, setSelected] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void loadTrackingSpaces(controller.signal).then(layouts => {
      if (controller.signal.aborted) return;
      const mapped = layouts.flatMap(layout => {
        const route = measurePassage(layout.station.route);
        return route ? [{ layout, route }] : [];
      });
      const transfer = mapped.find(({ layout }) => {
        const links = layout.station.stationLinks ?? [];
        return links.some(link => link.routeEndpoint === 'start') && links.some(link => link.routeEndpoint === 'end');
      });
      setPassages(mapped);
      setSelected((transfer ?? mapped[0])?.layout.id ?? '');
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  const active = passages?.find(p => p.layout.id === selected);
  function close() { dialog.current?.close(); dismiss(); }
  return <dialog className="passage-preview" ref={dialog} aria-labelledby="preview-title"
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="preview-header">
      <h2 id="preview-title"><Icon name="route" />실내 경로 미리보기</h2>
      <button type="button" autoFocus aria-label="미리보기 닫기" onClick={close}><Icon name="close" /></button>
    </header>
    {active ? <>
      <div className="preview-route">
        {passages && passages.length > 1 ? <select aria-label="미리 볼 실내 경로" value={selected} onChange={e => setSelected(e.target.value)}>
          {passages.map(p => <option key={p.layout.id} value={p.layout.id}>{routeName(p.layout)}</option>)}
        </select> : <strong>{routeName(active.layout)}</strong>}
        <span>전체 {passageMeters(active.route.length)}</span>
      </div>
      <Playback key={selected} {...active} />
    </> : <div className="preview-notice" role="status">{failed ? <>
      경로를 불러올 수 없습니다. <button type="button" onClick={() => setAttempt(n => n + 1)}>다시 시도</button>
    </> : passages ? '이 공간에 등록된 실내 경로가 없습니다.' : '등록된 실내 경로를 불러오는 중…'}</div>}
  </dialog>;
}

export function PassagePreview({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="preview-trigger" aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      <Icon name="route" />실내 경로 미리보기<Icon name="next" />
    </button>
    {open && <PreviewDialog dismiss={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }} />}
  </>;
}
