import { useEffect, useRef, useState } from 'react';
import { openPassage } from './ar/camera';
import { FieldRecorder, idleView } from './ar/recording';

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const client = useRef<FieldRecorder | null>(null);
  const map = useRef<unknown>(null);
  const [camera, setCamera] = useState('카메라 연결 중');
  const [record, setRecord] = useState(idleView);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const recorder = new FieldRecorder(setRecord);
    client.current = recorder;
    void recorder.restore();
    const onPose = (e: Event) => setCamera((e as CustomEvent).detail ? '위치 인식' : '태그 탐색 중');
    window.addEventListener('station-pose', onPose);
    const close = openPassage(video.current!, overlay.current!, {
      ready(station) { map.current = station; setAvailable(true); setCamera('태그 탐색 중'); },
      state: setCamera,
      frame: (canvas, at, time, intrinsics, fix) => recorder.capture(canvas, at, time, intrinsics, fix),
      pause() { setAvailable(false); setCamera('카메라 대기'); void recorder.stop(); },
    });
    return () => {
      window.removeEventListener('station-pose', onPose); recorder.dispose(); close(); client.current = null;
    };
  }, []);

  async function toggle() {
    setWorking(true); setMessage('');
    try {
      if (record.phase === 'recording') await client.current?.stop();
      else if (available && map.current) await client.current?.start(map.current);
    } catch { setMessage('기기 저장 공간과 브라우저 권한을 확인하세요'); }
    finally { setWorking(false); }
  }

  async function attach(scan: File | undefined) {
    if (!scan) return;
    setWorking(true); setMessage('스캔을 전송하는 중');
    try { await client.current?.attach(scan); setMessage('스캔 첨부 완료'); }
    catch (e) { setMessage(e instanceof Error ? e.message : '연결을 확인하고 다시 첨부하세요'); }
    finally { setWorking(false); }
  }

  let detail = camera;
  if (record.phase !== 'idle') {
    detail = record.sent + '장 저장';
    if (record.total > record.sent) detail += ' · ' + (record.total - record.sent) + '장 전송 대기';
    if (record.phase === 'done' && !record.cloud) detail += ' · 3D 계산 중';
    if (record.cloud?.state === 'ready') detail += ' · 3D 점 ' + record.cloud.points.toLocaleString() + '개';
    if (record.cloud?.state === 'insufficient') detail += ' · 3D 대응점 부족';
    if (record.cloud?.state === 'error') detail += ' · 3D 계산 실패';
  }
  const recording = record.phase === 'recording';
  return (
    <main aria-label="역사 통로 AR">
      <video ref={video} autoPlay playsInline muted disablePictureInPicture aria-label="후면 카메라" />
      <canvas ref={overlay} aria-label="바닥 안내 화살표" />
      <section className="capture-bar" aria-label="실험 기록">
        <div className="capture-readout">
          <strong><i data-state={recording ? 'recording' : available && camera === '위치 인식' ? 'located' : 'waiting'} aria-hidden="true" />
            {record.phase === 'done' ? '기록 완료' : record.phase === 'saving' ? '사진 전송 중' : camera}
          </strong>
          {(record.phase !== 'idle' || message) && <small>{message || record.notice || detail}</small>}
        </div>
        {record.phase === 'done' && <div className="files">
          {record.cloud?.state === 'ready' && <a href={import.meta.env.BASE_URL + 'api/recordings/' + record.id + '/scene.ply'} download>3D 받기</a>}
          <button type="button" disabled={working} onClick={() => file.current?.click()}>스캔 첨부</button>
          <input ref={file} type="file" accept=".ply,.usdz" hidden onChange={e => {
            const selected = e.target.files?.[0]; e.target.value = ''; void attach(selected);
          }} />
        </div>}
        <button type="button" className="capture-action" data-recording={recording} onClick={() => void toggle()}
          disabled={working || record.phase === 'saving' || (!recording && !available)}>
          <span aria-hidden="true" />{recording ? '기록 종료' : '기록 시작'}
        </button>
      </section>
    </main>
  );
}
