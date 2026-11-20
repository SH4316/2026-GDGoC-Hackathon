import type { Station } from '../ar/station';

type Graph = NonNullable<Station['tagGraph']>;

// Draft references are row indices so editing a printed ID keeps its connections.
export type GraphDraft = { start: number; end: number; edges: [number, number][] };

export function draftGraph(station: Station): GraphDraft | undefined {
  if (!station.tagGraph) return;
  const index = (id: number) => station.tags.findIndex(t => t.id === id);
  return { start: index(station.tagGraph.startTag), end: index(station.tagGraph.endTag),
    edges: station.tagGraph.edges.map(([a, b]) => [index(a), index(b)]) };
}

export function graphPayload(graph: GraphDraft, tags: { id: number }[]): Graph {
  const tagId = (i: number) => {
    if (!tags[i]) throw new Error('출발·도착 태그와 각 통로의 양쪽 태그를 선택하세요.');
    return tags[i].id;
  };
  return { startTag: tagId(graph.start), endTag: tagId(graph.end), edges: graph.edges.map(([a, b]) => [tagId(a), tagId(b)]) };
}

export function removeGraphTag(graph: GraphDraft | undefined, index: number): GraphDraft | undefined {
  if (!graph) return;
  const move = (i: number) => i === index ? -1 : i > index ? i - 1 : i;
  return { start: move(graph.start), end: move(graph.end),
    edges: graph.edges.filter(edge => !edge.includes(index)).map(([a, b]) => [move(a), move(b)]) };
}

export function TagConnections({ tags, graph, change }: {
  tags: { id: string }[]; graph?: GraphDraft; change: (graph?: GraphDraft) => void;
}) {
  function pick(label: string, value: number, update: (index: number) => void) {
    return <label>{label}<select value={value} onChange={e => update(Number(e.target.value))}>
      <option value={-1}>태그 선택</option>
      {tags.map(({ id }, i) => <option key={i} value={i}>태그 {id}</option>)}
    </select></label>;
  }
  return <div className="tag-connections">
    <label><input type="checkbox" checked={!!graph} onChange={e => change(e.target.checked
      ? { start: -1, end: -1, edges: [] } : undefined)} /> 태그 간 통로 직접 설정</label>
    {graph && <>
      <p>꺾이는 곳마다 태그를 두고, 직선으로 걸을 수 있는 두 보행 지점을 연결하세요. 각 통로는 양방향입니다.</p>
      <div className="tag-edge">
        {pick('기본 출발 태그', graph.start, start => change({ ...graph, start }))}
        {pick('기본 도착 태그', graph.end, end => change({ ...graph, end }))}
      </div>
      {graph.edges.map(([a, b], i) => {
        const edit = (edge: [number, number]) => change({ ...graph, edges: graph.edges.map((old, j) => i === j ? edge : old) });
        return <div className="tag-edge" key={i}>
          {pick('통로 ' + (i + 1) + ' 시작', a, value => edit([value, b]))}
          {pick('통로 ' + (i + 1) + ' 끝', b, value => edit([a, value]))}
          <button type="button" className="admin-text-button" aria-label={'통로 ' + (i + 1) + ' 삭제'}
            onClick={() => change({ ...graph, edges: graph.edges.filter((_, j) => j !== i) })}>삭제</button>
        </div>;
      })}
      <button type="button" className="admin-button" onClick={() => change({ ...graph, edges: [...graph.edges, [-1, -1]] })}>통로 추가</button>
    </>}
  </div>;
}
