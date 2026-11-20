import { useEffect, useRef, useState, type RefObject } from 'react';
import { stationName, stationResponse, stationUrl } from './ar/station';

type Station = { name: string; code: string; nameRead: boolean; codeRead: boolean };
type Result = {
  status: 'recognized'; line: string; left: Station; current: Station; right: Station;
  arrow: 'left' | 'right'; toward: string;
} | { status: 'pending'; reason: string; current?: Station; line?: string };

const positions = ['left', 'current', 'right'] as const;

const reasons: Record<string, string> = {
  station_text: '양옆 역명까지 보이도록 조금 더 가까이 촬영하세요.',
  layout: '현재역과 양옆 역명이 함께 보이도록 안내판 하나를 정면에서 촬영하세요.',
  ambiguous_line: '여러 노선의 역 순서가 같습니다. 노선명이나 역번호가 보이도록 촬영하세요.',
  topology_conflict: '역명과 역번호의 배치가 등록된 노선 순서와 맞지 않습니다.',
  arrow_missing: '화살표가 보이도록 다시 촬영하세요.',
  direction_conflict: '화살표가 어느 역을 가리키는지 확인할 수 없습니다.',
  more_frames: '카메라를 잠시 고정하고 다시 촬영하세요.',
  frame_conflict: '프레임마다 판독이 다릅니다. 안내판 하나만 촬영하세요.',
};

async function preparePhoto(file: File, signal: AbortSignal): Promise<Blob> {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('JPEG 또는 PNG 사진을 선택하세요.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error('사진을 열 수 없습니다. 다른 사진을 선택하세요.'); });
    signal.throwIfAborted();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (file.size <= 6 * 1024 * 1024 && width * height <= 16_000_000) return file;

    const scale = Math.min(1, 1680 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('사진 크기를 조정할 수 없습니다.');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .94));
    if (!jpeg) throw new Error('사진 크기를 조정할 수 없습니다.');
    return jpeg;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function capture(video: HTMLVideoElement, signal: AbortSignal) {
  const scale = Math.min(1, 1680 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d')!;
  const frames: Blob[] = [];
  let previousTime = -1;
  // Sample a short burst only on demand. A stalled stream must not vote multiple times.
  for (let attempt = 0; attempt < 7 && frames.length < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 220));
    signal.throwIfAborted();
    if (!video.videoWidth || video.paused || video.readyState < 2) break;
    if (video.currentTime === previousTime) continue;
    previousTime = video.currentTime;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .94));
    if (frame) frames.push(frame);
  }
  if (frames.length !== 3) throw new Error('카메라 영상을 확인하고 다시 촬영하세요.');
  return frames;
}

function LinkedSpaces({ line, code }: { line: string; code: string }) {
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    void fetch(stationUrl + '/spaces?' + new URLSearchParams({ line, code }), { cache: 'no-store', signal: controller.signal })
      .then(stationResponse).then(r => r.json()).then(rows => { if (!controller.signal.aborted) setSpaces(rows); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [line, code, attempt]);
  if (failed) return <p>연결된 공간을 불러오지 못했습니다.{' '}
    <button type="button" onClick={() => setAttempt(n => n + 1)}>다시 시도</button></p>;
  if (!spaces?.length) return null;
  return <div><p><strong>연결된 공간</strong></p>
    <ul>{spaces.map(space => <li key={space.id}>{space.name}</li>)}</ul></div>;
}

export function SignReader({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result>();
  const file = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  function clear() {
    request.current?.abort();
    request.current = null;
    setResult(undefined); setBusy(false); setError('');
  }

  useEffect(() => {
    const source = video.current!;
    const sync = () => setReady(source.readyState >= 2 && !source.paused);
    const hidden = () => { if (document.hidden) clear(); };
    sync();
    source.addEventListener('playing', sync);
    source.addEventListener('emptied', sync);
    source.addEventListener('pause', sync);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      source.removeEventListener('playing', sync);
      source.removeEventListener('emptied', sync);
      source.removeEventListener('pause', sync);
      document.removeEventListener('visibilitychange', hidden);
      request.current?.abort();
    };
  }, [video]);

  async function read(photo?: File) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setResult(undefined);
    try {
      const images = photo ? [await preparePhoto(photo, controller.signal)] : await capture(video.current!, controller.signal);
      controller.signal.throwIfAborted();
      const body = new FormData();
      for (const image of images) body.append('images', image, image instanceof File ? image.name : 'frame.jpg');
      const response = await fetch(import.meta.env.BASE_URL + 'api/signs/recognize', {
        method: 'POST', body, signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '안내판을 읽지 못했습니다.');
      if (data.status !== 'recognized' && data.status !== 'pending') throw new Error('인식 결과를 읽지 못했습니다.');
      if (!controller.signal.aborted) setResult(data);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error && !(e instanceof TypeError) && !(e instanceof SyntaxError)
        ? e.message : '서버 연결을 확인하고 다시 시도하세요.');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  const name = result?.current?.name;
  const currentLabel = name && stationName(name);
  return <section className="sign-reader" aria-label="역 안내판 인식">
    <button type="button" className="sign-trigger" aria-expanded={open} aria-controls="sign-actions"
      onClick={() => { clear(); setOpen(!open); }}>안내판 읽기</button>
    {open && <div id="sign-actions" className="sign-panel">
      <div className="sign-actions">
        <button type="button" disabled={!ready || busy} onClick={() => void read()}>카메라로 읽기</button>
        <button type="button" disabled={busy} onClick={() => file.current?.click()}>사진 선택</button>
        <input ref={file} hidden type="file" accept="image/jpeg,image/png" aria-label="안내판 사진"
          onChange={e => { const selected = e.target.files?.[0]; e.target.value = ''; if (selected) void read(selected); }} />
      </div>
      <div role="status" aria-live="polite">
        {busy && <p>안내판 읽는 중…</p>}
        {error && <p>{error}</p>}
        {result?.status === 'pending' && <>
          {result.current && <h2>{result.line} · {currentLabel}</h2>}
          <p><strong>판독 보류</strong> · {reasons[result.reason]}</p>
        </>}
        {result?.status === 'recognized' && <>
          <h2>{result.line} · {currentLabel}</h2>
          <p className="sign-direction">안내판 표시 · <span aria-label={result.arrow === 'left' ? '왼쪽 화살표' : '오른쪽 화살표'}>
            {result.arrow === 'left' ? '←' : '→'}</span> {result.toward} 방면</p>
          <dl>{positions.map((side, i) =>
            <div key={side}><dt>{['왼쪽 역', '현재역', '오른쪽 역'][i]}</dt>
              <dd>{result[side].name} <span>{result[side].code}</span></dd></div>)}</dl>
          {positions.some(k => !result[k].nameRead) &&
            <p className="sign-note">역번호로 확인한 역명 · {positions
              .filter(k => !result[k].nameRead).map(k => result[k].name).join(', ')}</p>}
          {positions.some(k => !result[k].codeRead) &&
            <p className="sign-note">노선표로 확인한 번호 · {positions
              .filter(k => !result[k].codeRead).map(k => result[k].code).join(', ')}</p>}
          <LinkedSpaces key={result.line + ':' + result.current.code} line={result.line} code={result.current.code} />
        </>}
      </div>
    </div>}
  </section>;
}
