import { useCallback, useEffect, useRef, useState } from 'react';
import { DebugSession } from './debugSession';
import { DebugUploads, debugCsvUrl, type UploadView } from './debugUploads';
import { motionAccess, requestMotionAccess } from './motion';

type DebugFile = { id: string; url: string; name: string; startedAtMs: number; rows: number };
const sourceLabel = { tag: '태그 측정', motion: '관성 추정', floor: '바닥 영상 보정' };

export function useArDebug() {
  const current = useRef<DebugSession | null>(null);
  const [session, setSession] = useState<DebugSession | null>(null);
  const [files, setFiles] = useState<DebugFile[]>([]);
  const [empty, setEmpty] = useState(false);
  const urls = useRef<string[]>([]);
  const [uploads] = useState(() => new DebugUploads());
  const [upload, setUpload] = useState<UploadView>({ logs: [], notice: '' });
  useEffect(() => uploads.listen(setUpload), [uploads]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => session.queueNewRows(uploads.enqueue), 1000);
    return () => window.clearInterval(timer);
  }, [session, uploads]);

  function start() {
    if (current.current) return;
    const next = new DebugSession();
    current.current = next;
    setEmpty(false);
    setSession(next);
    next.access = motionAccess();
    if (next.access === 'prompt') {
      // iOS requires the permission request inside the activation gesture.
      void requestMotionAccess().then(access => { next.access = access; });
    }
  }

  const stop = useCallback(() => {
    const ended = current.current;
    if (!ended) return;
    current.current = null;
    setSession(null);
    if (!ended.rowCount) { setEmpty(true); return; }
    ended.queueNewRows(uploads.enqueue);
    const url = URL.createObjectURL(ended.csv());
    urls.current.push(url);
    const name = 'ar-debug-' + ended.startedAt.toISOString().replaceAll(':', '-') + '.csv';
    const file = { id: ended.id, url, name, startedAtMs: ended.startedAt.getTime(), rows: ended.rowCount };
    setFiles(previous => [file, ...previous]);
  }, [uploads]);

  useEffect(() => () => {
    current.current?.queueNewRows(uploads.enqueue);
    current.current = null;
    urls.current.forEach(url => URL.revokeObjectURL(url));
    urls.current = [];
  }, [uploads]);

  return { current, session, start, stop, files, empty, upload };
}

function axes(values: readonly number[]) {
  return values.map((value, axis) => 'XYZ'[axis] + ' ' + value.toFixed(2)).join('  ');
}

function LiveReadings({ session }: { session: DebugSession }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => refresh(n => n + 1), 250);
    return () => window.clearInterval(timer);
  }, []);
  const { lastMotion, lastPosition } = session;
  const acceleration = lastMotion?.acceleration ?? lastMotion?.accelerationIncludingGravity;
  const sensorStatus = session.access === 'denied' ? '동작 센서 권한이 꺼져 있습니다.'
    : session.access === 'unavailable' ? '이 기기에서 가속도를 지원하지 않습니다.'
    : session.access === 'prompt' ? '동작 센서 권한 확인 중' : '센서 수신 대기';
  return <dl className="debug-readings">
    <dt>가속도 · {session.motionCount.toLocaleString()}건</dt>
    <dd>{acceleration ? axes(acceleration) + ' m/s²' + (lastMotion?.acceleration ? '' : ' (중력 포함)') : sensorStatus}</dd>
    <dt>최근 실내 위치 · {session.positionCount.toLocaleString()}건</dt>
    <dd>{lastPosition ? sourceLabel[lastPosition.source] + ' · ' + axes(lastPosition.point) + ' m'
      : '등록된 태그를 비추면 위치가 기록됩니다.'}</dd>
  </dl>;
}

export function ArDebugControls({ debug, ready }: { debug: ReturnType<typeof useArDebug>; ready: boolean }) {
  const { session, files, empty, upload } = debug;
  const logs = new Map(upload.logs.map(log => [log.id, log]));
  const local = new Map(files.map(file => [file.id, file]));
  const history = [...new Set([...local.keys(), ...logs.keys()])].filter(id => id !== session?.id)
    .map(id => {
      const file = local.get(id), log = logs.get(id);
      return { id, file, total: file?.rows ?? log!.total, sent: log?.sent ?? 0, startedAtMs: file?.startedAtMs ?? log!.startedAtMs };
    }).sort((a, b) => b.startedAtMs - a.startedAtMs);
  return <>
    <button type="button" className="settings-trigger debug-trigger" aria-pressed={!!session}
      disabled={!session && !ready} onClick={session ? debug.stop : debug.start}>
      {session ? '디버그 수집 종료' : '디버그 활성화'}
    </button>
    {(session || history.length > 0 || empty) && <section className="debug-panel" aria-label="AR 디버그 데이터">
      {session && <>
        <LiveReadings session={session} />
        <p>서버 저장 {(logs.get(session.id)?.sent ?? 0).toLocaleString()}건</p>
      </>}
      {upload.notice && <p role="status">{upload.notice}</p>}
      {empty && <p role="status">수집된 값이 없습니다. 동작 센서 권한과 태그 인식을 확인하세요.</p>}
      {history.length > 0 && <details open={!session && files.length > 0} key={session ? 'active' : 'stopped'}>
        <summary>수집 파일 {history.length}개</summary>
        {history.map(({ id, file, sent, total, startedAtMs }) => <div key={id}>
          <p>{new Date(startedAtMs).toLocaleString('ko-KR')} · {sent === total
            ? '서버 저장 완료 ' + total.toLocaleString() + '건' : '서버 저장 ' + sent.toLocaleString() + ' / ' + total.toLocaleString() + '건'}</p>
          {sent === total && <a href={debugCsvUrl(id)} download>서버 CSV 받기</a>}
          {file && <a href={file.url} download={file.name}>기기 CSV 받기</a>}
        </div>)}
      </details>}
    </section>}
  </>;
}
