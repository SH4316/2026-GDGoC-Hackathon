import { useEffect, useRef, useState } from 'react';
import { stationName, stationResponse, stationUrl, type RailStop, type StationLink } from '../ar/station';

const key = (stop: RailStop) => stop.line + ':' + stop.code;
const label = (stop: RailStop) => stationName(stop.name) + ' · ' + stop.line + ' ' + stop.code;

export function StationLinks({ links, change }: { links: StationLink[]; change: (links: StationLink[]) => void }) {
  const [catalog, setCatalog] = useState<RailStop[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void fetch(stationUrl + '/rail-stops', { signal: controller.signal }).then(stationResponse)
      .then(r => r.json()).then(stops => { if (!controller.signal.aborted) setCatalog(stops); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);

  const terms = query.trim().toLowerCase().split(/\s+/);
  const matches = terms[0] ? catalog?.filter(stop => {
    const text = label(stop).toLowerCase();
    return terms.every(term => text.includes(term));
  }) ?? [] : [];
  const linked = new Set(links.map(key));

  return <div className="admin-station-links">
    <label>연결 역<input ref={input} type="search" placeholder="역 이름, 노선 또는 역번호 검색"
      disabled={!catalog} value={query} onChange={e => setQuery(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault(); }} /></label>
    {failed ? <div role="alert">역 목록을 불러오지 못했습니다.{' '}
      <button type="button" className="admin-text-button" onClick={() => setAttempt(n => n + 1)}>다시 시도</button>
    </div> : !catalog && <small role="status">역 목록을 불러오는 중…</small>}
    {terms[0] && catalog && <>
      <small role="status">{matches.length === 0 ? '검색한 역이 없습니다.' : matches.length > 8
        ? '검색 결과 ' + matches.length + '개 중 8개 표시 · 역 이름이나 노선을 더 입력하세요.' : '검색 결과 ' + matches.length + '개'}</small>
      {matches.length > 0 && <ul aria-label="역 검색 결과">{matches.slice(0, 8).map(stop => <li key={key(stop)}>
        <button type="button" className="admin-stop-result" disabled={linked.has(key(stop))}
          onClick={() => { change([...links, stop]); setQuery(''); input.current?.focus(); }}>
          <span>{label(stop)}</span><small>{linked.has(key(stop)) ? '연결됨' : '연결'}</small>
        </button>
      </li>)}</ul>}
    </>}
    {links.length > 0 && <ul aria-label="연결된 역">{links.map(stop => <li key={key(stop)} className="admin-linked-stop">
      <span>{label(stop)}</span>
      <select aria-label={label(stop) + ' 경로 위치'} value={stop.routeEndpoint ?? ''}
        onChange={event => {
          const role = event.target.value;
          const routeEndpoint = role === 'start' || role === 'end' ? role : undefined;
          change(links.map(item => item === stop ? { ...item, routeEndpoint } : item));
        }}>
        <option value="">위치 미지정</option>
        <option value="start" disabled={links.some(item => item !== stop && item.routeEndpoint === 'start')}>경로 출발점</option>
        <option value="end" disabled={links.some(item => item !== stop && item.routeEndpoint === 'end')}>경로 도착점</option>
      </select>
      <button type="button" className="admin-text-button" aria-label={label(stop) + ' 연결 해제'}
        onClick={() => { change(links.filter(item => key(item) !== key(stop))); input.current?.focus(); }}>해제</button>
    </li>)}</ul>}
  </div>;
}
