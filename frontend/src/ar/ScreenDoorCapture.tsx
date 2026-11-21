import { useEffect, useRef, useState, type RefObject } from 'react';
import examplePhoto from '../assets/screen-door-example.webp';
import { HomeButton } from '../navigation/HomeButton';
import type { BoardingTarget } from '../navigation/stationProgress';
import { useLanguage } from '../i18n/LanguageSelect';
import { lineLabel } from '../i18n/language';
import { stationLabel } from '../i18n/stationLabel';
import { stationName } from './station';
import './screen-door.css';

type Verdict = {
  status: 'match' | 'mismatch' | 'uncertain'; message: string;
  reading: { screenDoor: boolean; station: string | null; line: string | null; code: string | null; toward: string | null };
};

async function photograph(video: HTMLVideoElement | null) {
  if (!video || video.paused || video.readyState < 2 || !video.videoWidth || !video.videoHeight)
    throw new Error('카메라 영상이 준비되면 다시 찍어 주세요.');
  const scale = Math.min(1, 1680 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('카메라 사진을 만들 수 없습니다. 다시 찍어 주세요.');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
  if (!jpeg) throw new Error('카메라 사진을 만들 수 없습니다. 다시 찍어 주세요.');
  return jpeg;
}

export function ScreenDoorCapture({ video, target, back, finish, finishLabel, reset }: {
  video: RefObject<HTMLVideoElement | null>; target: BoardingTarget; back: () => void; finish: () => void; finishLabel: string; reset: () => void;
}) {
  const { t, language } = useLanguage();
  const heading = useRef<HTMLHeadingElement>(null);
  const example = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [manualLine, setManualLine] = useState('');
  const [manualToward, setManualToward] = useState('');
  const [photo, setPhoto] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>();
  const [error, setError] = useState('');
  const line = target.line ?? manualLine.trim();
  const toward = target.toward ?? manualToward.trim();
  const planned = [target.station && stationLabel(stationName(target.station), language, true), line && lineLabel(line, language),
    toward && t('{station} 방면', { station: stationLabel(toward, language) })].filter(Boolean).join(' · ');

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    return () => { request.current?.abort(); request.current = null; };
  }, []);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo); }, [photo]);

  async function capture() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError('');
    const timeout = window.setTimeout(() => controller.abort('timeout'), 55_000);
    try {
      const jpeg = await photograph(video.current);
      controller.signal.throwIfAborted();
      setPhoto(URL.createObjectURL(jpeg));
      const body = new FormData();
      body.append('image', jpeg, 'screen-door.jpg');
      if (target.station) body.append('station', target.station);
      body.append('line', line);
      body.append('toward', toward);
      const response = await fetch(import.meta.env.BASE_URL + 'api/screen-doors/check', {
        method: 'POST', body, signal: controller.signal, cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.message === 'string' ? data.message : '사진을 판독하지 못했습니다. 다시 찍어 주세요.');
      if (!['match', 'mismatch', 'uncertain'].includes(data?.status) || typeof data.message !== 'string' || !data.reading)
        throw new Error('판독 결과를 읽지 못했습니다. 다시 찍어 주세요.');
      if (!controller.signal.aborted) setVerdict(data);
    } catch (e) {
      if (request.current === controller) setError(controller.signal.aborted ? '판독 시간이 초과됐습니다. 다시 찍어 주세요.'
        : e instanceof Error && !(e instanceof TypeError || e instanceof SyntaxError) ? e.message : '서버 연결을 확인하고 다시 찍어 주세요.');
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  function retake() {
    setPhoto(undefined); setVerdict(undefined); setError('');
  }
  const reading = verdict?.reading;
  const observed = reading?.screenDoor && [reading.station && stationLabel(stationName(reading.station), language, true), reading.code,
    reading.line && lineLabel(reading.line, language), reading.toward && t('{station} 방면', { station: stationLabel(reading.toward, language) })].filter(Boolean).join(' · ');
  return <>
    {photo && <div className="door-still"><img src={photo} alt={t('방금 촬영한 스크린도어')} /></div>}
    <section className="door-panel" aria-label={t('스크린도어 확인')}>
      <div className="door-content">
        <div className="door-intro">
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 tabIndex={-1} ref={heading} data-verdict={verdict?.status}>
              {t(busy ? '스크린도어를 확인하고 있습니다' : verdict?.message || (error ? '사진을 확인하지 못했습니다' : '주변의 스크린도어를 찍으세요'))}
            </h1>
            {error && <p>{t(error)}</p>}
            {!photo && !error && !busy && <p>{t('문 위의 역명과 방면 화살표가 함께 보이게 찍어 주세요.')}</p>}
            {observed && <p>{t('사진에서 읽은 표지')} · {observed}</p>}
          </div>
          {!photo && <button type="button" className="door-example" onClick={() => example.current?.showModal()} aria-label={t('촬영 예시 사진 크게 보기')}>
            <img src={examplePhoto} width="776" height="608" alt={t('초지역 스크린도어 위의 역명과 방면 화살표')} />
            <span>{t('촬영 예시')} <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9 3h4v4m0-4L7 9M6 4H3v9h9v-3" /></svg></span>
          </button>}
        </div>
        {planned && <p className="door-route">{t('탑승 경로')} · {planned}</p>}
        <form className="door-capture-form" onSubmit={event => {
          event.preventDefault();
          if (photo) retake();
          else void capture();
        }}>
          {!photo && (!target.line || !target.toward) && <div className="door-inputs">
            {!target.line && <label>{t('탑승할 노선')}
              <input required pattern={'.*\\S.*'} value={manualLine} maxLength={80} onChange={e => setManualLine(e.target.value)} />
            </label>}
            {!target.toward && <label>{t('이 노선에서 내릴 역')}
              <input required pattern={'.*\\S.*'} value={manualToward} maxLength={100} onChange={e => setManualToward(e.target.value)} />
            </label>}
          </div>}
          <button type="submit" className="door-shutter" disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 8a1 1 0 0 1 1-1h3l1.7-3h6.6L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><circle cx="12" cy="13" r="3.5" />
            </svg>{t(busy ? '판독 중…' : photo ? '다시 찍기' : '촬영하고 확인')}
          </button>
        </form>
        <nav className="door-navigation" aria-label={t('실내 안내 이동')}>
          <HomeButton onClick={reset} />
          <button type="button" onClick={back}>{t('경로 안내 보기')}</button>
          <button type="button" onClick={finish}>{finishLabel}</button>
        </nav>
      </div>
    </section>
    <dialog className="door-example-dialog" ref={example} aria-labelledby="door-example-title">
      <form method="dialog"><h2 id="door-example-title">{t('스크린도어 촬영 예시')}</h2><button type="submit">{t('닫기')}</button></form>
      <img src={examplePhoto} width="776" height="608" alt={t('서해선 초지역 스크린도어 위에서 선부를 가리키는 화살표')} />
    </dialog>
  </>;
}
