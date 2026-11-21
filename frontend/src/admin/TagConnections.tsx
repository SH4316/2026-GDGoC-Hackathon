import { useLanguage } from '../i18n/LanguageSelect';
import type { Station } from '../ar/station';
import { automaticEndpoints } from '../ar/tagRouting';

// Draft references are row indices so editing a printed ID keeps its connections.
export type GraphDraft = { automatic: boolean; start: number; end: number; edges: [number, number][] };

export function draftGraph(station: Station): GraphDraft | undefined {
  const graph = station.tagGraph ?? automaticEndpoints(station);
  if (!graph) return;
  const index = (id?: number) => station.tags.findIndex(t => t.id === id);
  return { automatic: !station.tagGraph, start: index(graph.startTag), end: index(graph.endTag),
    edges: station.tagGraph?.edges.map(([a, b]) => [index(a), index(b)]) ?? [] };
}

function resolvedRows(graph: GraphDraft, tags: unknown[]) {
  const start = graph.automatic && graph.start < 0 ? tags.findIndex((_, i) => i !== graph.end) : graph.start;
  const end = graph.automatic && graph.end < 0 ? tags.findIndex((_, i) => i !== start) : graph.end;
  return { start, end };
}

export function routingPayload(graph: GraphDraft | undefined, tags: { id: number }[]): Pick<Station, 'autoRoute' | 'tagGraph'> {
  if (!graph) return { autoRoute: false };
  const { start, end } = resolvedRows(graph, tags);
  if (graph.automatic) return { autoRoute: { startTag: tags[start]?.id, endTag: tags[end]?.id } };
  const tagId = (i: number) => {
    if (!tags[i]) throw new Error('출발·도착 태그와 각 통로의 양쪽 태그를 선택하세요.');
    return tags[i].id;
  };
  return { tagGraph: { startTag: tagId(start), endTag: tagId(end), edges: graph.edges.map(([a, b]) => [tagId(a), tagId(b)]) } };
}

export function removeGraphTag(graph: GraphDraft | undefined, index: number): GraphDraft | undefined {
  if (!graph) return;
  const move = (i: number) => i === index ? -1 : i > index ? i - 1 : i;
  return { ...graph, start: move(graph.start), end: move(graph.end),
    edges: graph.edges.filter(edge => !edge.includes(index)).map(([a, b]) => [move(a), move(b)]) };
}

export function TagConnections({ tags, graph, bounded, change }: {
  tags: { id: string }[]; graph?: GraphDraft; bounded: boolean; change: (graph?: GraphDraft) => void;
}) {
  const { t } = useLanguage();
  function pick(label: string, value: number, update: (index: number) => void) {
    return <label>{t(label)}<select value={value} onChange={e => update(Number(e.target.value))}>
      <option value={-1}>{t('태그 선택')}</option>
      {tags.map(({ id }, i) => <option key={i} value={i}>{t('태그')} {id}</option>)}
    </select></label>;
  }
  const rows = graph && resolvedRows(graph, tags);
  return <div className="tag-connections">
    <label>{t('경로 계산 방식')}<select value={graph ? graph.automatic ? 'auto' : 'manual' : 'surveyed'} onChange={e => {
      const mode = e.target.value;
      change(mode === 'surveyed' ? undefined : { start: rows?.start ?? -1, end: rows?.end ?? -1,
        edges: graph?.edges ?? [], automatic: mode === 'auto' });
    }}>
      <option value="auto">{t('태그 위치로 자동 연결')}</option>
      <option value="manual">{t('태그 간 통로 직접 설정')}</option>
      <option value="surveyed">{t('안내 경로 좌표 입력')}</option>
    </select></label>
    {graph && <>
      <p>{graph.automatic
        ? (bounded ? t('바닥 경계 안에서 보행 지점을 연결하고, 태그가 없는 모퉁이는 경계를 따라 돌아갑니다.')
          : t('모퉁이와 갈림길에 태그를 두세요. 바닥 경계가 없으면 이웃한 보행 지점 사이를 직선 통로로 봅니다.'))
        : t('꺾이는 곳마다 태그를 두고, 직선으로 걸을 수 있는 두 보행 지점을 연결하세요. 각 통로는 양방향입니다.')}</p>
      <div className="tag-edge">
        {pick('기본 출발 태그', rows!.start, start => change({ ...graph, start }))}
        {pick('기본 도착 태그', rows!.end, end => change({ ...graph, end }))}
      </div>
      {!graph.automatic && graph.edges.map(([a, b], i) => {
        const edit = (edge: [number, number]) => change({ ...graph, edges: graph.edges.map((old, j) => i === j ? edge : old) });
        return <div className="tag-edge" key={i}>
          {pick(t('통로 {n} 시작', { n: i + 1 }), a, value => edit([value, b]))}
          {pick(t('통로 {n} 끝', { n: i + 1 }), b, value => edit([a, value]))}
          <button type="button" className="admin-text-button" aria-label={t('통로 {n} 삭제', { n: i + 1 })}
            onClick={() => change({ ...graph, edges: graph.edges.filter((_, j) => j !== i) })}>{t('삭제')}</button>
        </div>;
      })}
      {!graph.automatic && <button type="button" className="admin-button" onClick={() => change({ ...graph, edges: [...graph.edges, [-1, -1]] })}>{t('통로 추가')}</button>}
    </>}
  </div>;
}
