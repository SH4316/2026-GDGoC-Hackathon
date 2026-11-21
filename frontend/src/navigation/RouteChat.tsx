import { placeLabel } from './routeInstruction';
import { chatCache } from './journeyUrl';
import { closeOverlay, updateUrl, useQuery } from '../urlState';
import type { Translate } from '../i18n/language';
import { useLanguage } from '../i18n/LanguageSelect';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { currentOrigin, formatMeters, readRoute, type Journey, type Place, type RouteMode } from './routes';
import './route-chat.css';

type Source = { title: string; url: string };
type Turn = { role: 'assistant' | 'user'; content: string; journey?: Journey; sources?: Source[] };
type SavedChat = { route: string; turns: Turn[]; draft: string; gps?: Place };

function savedChat(route: string): SavedChat | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(chatCache) ?? 'null');
    if (saved?.route === route && Array.isArray(saved.turns) && typeof saved.draft === 'string') return saved;
  } catch { /* Chat also works with storage disabled. */ }
}

type Reply = {
  message: string; sources: Source[];
  proposal?: { origin: Place; destination: Place; mode: RouteMode; data: Parameters<typeof readRoute>[0] };
};
type Speech = {
  lang: string; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
};
function speechConstructor() {
  const browser = window as Window & { SpeechRecognition?: new () => Speech; webkitSpeechRecognition?: new () => Speech };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

function Icon({ name, size = 20 }: { name: 'mic' | 'send' | 'close' | 'location' | 'wave' | 'stop' | 'arrow'; size?: number }) {
  const paths = {
    mic: <><rect x="9" y="2.5" width="6" height="12.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M9 21.5h6"/></>,
    send: <path d="M12 19V5m-6 6 6-6 6 6"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    location: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></>,
    wave: <path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const waves = Array.from({ length: 22 }, (_, line) => {
  const phase = line / 21;
  return Array.from({ length: 101 }, (_, i) => {
    const t = i / 100, envelope = Math.sin(t * Math.PI) ** 1.3;
    const y = 55 + envelope * (Math.sin(t * Math.PI * 3 + phase * 3) * 26 + (phase - .5) * 32);
    return (i ? 'L' : 'M') + (t * 420).toFixed(1) + ' ' + y.toFixed(1);
  }).join(' ');
});
function SoundWave() {
  return <svg className="chat-soundwave" viewBox="0 0 420 110" fill="none" aria-hidden="true">
    <defs><linearGradient id="chat-spectrum"><stop stopColor="#48ebd0"/><stop offset=".33" stopColor="#a8f8ff"/>
      <stop offset=".64" stopColor="#a491ff"/><stop offset="1" stopColor="#ff97d8"/></linearGradient></defs>
    {waves.map((d, i) => <path key={i} d={d} stroke="url(#chat-spectrum)" opacity={.45 + i / 44} strokeWidth=".95"/>)}
  </svg>;
}

function proposalSummary(trip: Journey, t: Translate, locale: string) {
  return [t(trip.mode === 'walk' ? '도보' : '대중교통'),
    trip.seconds !== undefined && t('약 {minutes}분', { minutes: Math.max(1, Math.round(trip.seconds / 60)) }),
    trip.meters !== undefined && formatMeters(trip.meters, locale)].filter(Boolean).join(' · ');
}

function RouteOffer({ trip, accept }: { trip: Journey; accept: (trip: Journey) => void }) {
  const { t, locale, language } = useLanguage();
  return <article className="chat-offer" aria-label={t('제안된 경로')}>
    <div className="chat-offer-title"><strong>{t('경로 제안')}</strong><span>{trip.provider === 'tmap' ? 'TMAP' : t('카카오맵')}</span></div>
    <dl>{([['출발', trip.origin], ['도착', trip.destination]] as const).map(([label, place]) =>
      <div key={label}><dt>{t(label)}</dt><dd>{placeLabel(place.name, language)}{place.detail && <small>{place.detail}</small>}</dd></div>)}</dl>
    <p>{proposalSummary(trip, t, locale)}</p>
    <button type="button" onClick={() => accept(trip)}>{t('수락하고 길 안내 시작')} <Icon name="arrow" size={18}/></button>
  </article>;
}

export function RouteChat({ origin, destination, mode, disabled, accept }: {
  origin?: Place; destination?: Place; mode: RouteMode; disabled: boolean; accept: (trip: Journey) => void;
}) {
  const { t, language, locale } = useLanguage();
  const query = useQuery();
  const open = query.get('dialog') === 'chat' && query.get('view') !== 'indoor';
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const recognition = useRef<Speech | null>(null);
  const request = useRef<AbortController | null>(null);
  const locationRequest = useRef(0);
  const route = JSON.stringify([origin?.point, destination?.point, mode]);
  const [saved] = useState(() => savedChat(route));
  const [turns, setTurns] = useState<Turn[]>(saved?.turns ?? []);
  const [draft, setDraft] = useState(saved?.draft ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [locating, setLocating] = useState(false);
  const [gps, setGps] = useState<Place | undefined>(saved?.gps);
  useEffect(() => {
    if (!open) return;
    // Keep the transcript in this tab. A copied URL contains only the dialog and route settings.
    const last = turns.at(-1);
    const interrupted = pending && last?.role === 'user';
    const snapshot: SavedChat = { route, turns: interrupted ? turns.slice(0, -1) : turns,
      draft: interrupted ? last.content : draft, gps };
    try { sessionStorage.setItem(chatCache, JSON.stringify(snapshot)); } catch { /* Storage is optional. */ }
  }, [open, route, turns, draft, pending, gps]);
  useEffect(() => () => {
    request.current?.abort();
    locationRequest.current++;
    recognition.current?.abort();
    recognition.current = null;
  }, []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [turns, pending, error]);

  useEffect(() => {
    const element = dialog.current!;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  function stopSpeech() {
    const speech = recognition.current;
    recognition.current = null;
    speech?.abort();
    setListening(false);
  }

  async function locate() {
    if (gps) { setGps(undefined); return; }
    const version = ++locationRequest.current;
    setLocating(true); setError('');
    try {
      const place = await currentOrigin();
      if (version === locationRequest.current) setGps(place);
    } catch (e) {
      if (version === locationRequest.current) setError(t(e instanceof Error ? e.message : '위치를 확인하지 못했습니다.') + ' ' + t('출발지 이름을 입력해 주세요.'));
    } finally { if (version === locationRequest.current) setLocating(false); }
  }

  function dictate() {
    if (recognition.current) { recognition.current.stop(); return; }
    const Recognition = speechConstructor();
    if (!Recognition) { setError('이 브라우저에서는 음성 입력을 사용할 수 없습니다. 메시지를 입력해 주세요.'); input.current?.focus(); return; }
    const speech = new Recognition();
    recognition.current = speech;
    const initial = draft.trimEnd();
    speech.lang = locale; speech.interimResults = true;
    speech.onresult = event => {
      if (recognition.current !== speech) return;
      const words = Array.from(event.results, result => result[0].transcript).join(' ');
      setDraft([initial, words].filter(Boolean).join(' ').slice(0, 2000));
    };
    speech.onend = () => { if (recognition.current === speech) { recognition.current = null; setListening(false); } };
    speech.onerror = event => {
      if (recognition.current !== speech || event.error === 'aborted') return;
      setError(event.error === 'not-allowed' ? '마이크 사용을 허용하거나 메시지를 입력해 주세요.' :
        '음성을 인식하지 못했습니다. 다시 말하거나 메시지를 입력해 주세요.');
    };
    setError(''); setListening(true);
    try { speech.start(); } catch { stopSpeech(); setError('마이크를 열 수 없습니다. 메시지를 입력해 주세요.'); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || request.current || locating || listening) return;
    const controller = new AbortController();
    request.current = controller;
    const next: Turn[] = [...turns, { role: 'user', content }];
    const previous = turns.findLast(turn => turn.journey)?.journey;
    setTurns(next); setDraft(''); setPending(true); setError('');
    try {
      const response = await fetch(import.meta.env.BASE_URL + 'api/assistant', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.slice(-17).map(turn => ({
          role: turn.role, content: turn.journey ? [turn.journey.origin.name, turn.journey.destination.name,
            proposalSummary(turn.journey, t, locale)].join(' → ') : turn.content,
        })), origin: gps ?? origin, destination, mode, language,
        previous: previous && { origin: previous.origin, destination: previous.destination, mode: previous.mode } }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.message === 'string' ? body.message : '대화 서버가 응답하지 않습니다. 다시 시도해 주세요.');
      }
      const reply: Reply = await response.json();
      const p = reply.proposal;
      const journey = p && readRoute(p.data, p.origin, p.destination, p.mode);
      if (!controller.signal.aborted) setTurns([...next, { role: 'assistant', content: reply.message, sources: reply.sources, journey }]);
    } catch (e) {
      if (!controller.signal.aborted) {
        setTurns(turns); setDraft(content);
        setError(e instanceof TypeError ? '대화 서버에 연결하지 못했습니다. 다시 보내 주세요.' :
          e instanceof Error ? e.message : '메시지를 보내지 못했습니다. 다시 시도해 주세요.');
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null; setPending(false);
      }
    }
  }

  return <>
    <button type="button" disabled={disabled} className="chat-launcher" aria-haspopup="dialog"
      onClick={() => updateUrl({ dialog: 'chat' }, 'push')}><Icon name="mic" size={19}/> {t('경로 대화')}</button>
    <dialog ref={dialog} className="route-chat" aria-labelledby="route-chat-title" onCancel={event => { event.preventDefault(); closeOverlay({ dialog: null }); }} onClose={() => {
      stopSpeech(); locationRequest.current++; setLocating(false);
    }}>
      <div className="chat-frame">
        <header className="chat-header"><h2 id="route-chat-title" tabIndex={-1} autoFocus><Icon name="wave"/>{t('경로 대화')}</h2>
          <button type="button" className="chat-icon" aria-label={t('대화 닫기')} onClick={() => closeOverlay({ dialog: null })}><Icon name="close"/></button>
        </header>
        <div className="chat-history" ref={log}>
          {!turns.length && <div className="chat-welcome" data-listening={listening}>
            <SoundWave/><h3>{t('어디로 갈까요?')}</h3><p>{t('출발지와 도착지를 말하거나 입력해 주세요.')}</p>
          </div>}
          <div role="log" aria-label={t('경로 대화 내역')} aria-live="polite" aria-relevant="additions">
            {turns.map((turn, index) => <div className={'chat-turn ' + turn.role} key={index}>
              {turn.content && <p><span className="route-announcement">{turn.role === 'user' ? t('나') : t('경로 도우미')}. </span>{turn.content}</p>}
              {turn.journey && <RouteOffer trip={turn.journey} accept={accept}/>}
              {!!turn.sources?.length && <ul className="chat-sources" aria-label={t('검색 출처')}>
                {turn.sources.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a></li>)}
              </ul>}
            </div>)}
          </div>
          {pending && <p className="chat-progress" role="status"><Icon name="wave" size={16}/> {t('응답을 기다리는 중…')}</p>}
        </div>
        <form className="chat-composer" onSubmit={send}>
          {error && <p className="chat-error" role="alert">{t(error)}</p>}
          <div className="chat-options">
            <button type="button" className="chat-location" aria-pressed={!!gps} disabled={locating || pending}
              onClick={() => void locate()}><Icon name="location" size={16}/>{locating ? t('위치 확인 중…') : gps ? t('현재 위치 사용 중') : t('현재 위치 사용')}</button>
            {listening && <span role="status">{t('듣고 있어요…')}</span>}
          </div>
          <div className="chat-entry">
            <button type="button" className="chat-icon chat-dictate" disabled={pending} aria-label={listening ? t('음성 입력 마치기') : t('음성 입력')}
              title={listening ? t('음성 입력 마치기') : t('음성 입력')} aria-pressed={listening} onClick={dictate}><Icon name={listening ? 'stop' : 'mic'}/></button>
            <textarea ref={input} rows={1} aria-label={t('경로 메시지')} placeholder={t('메시지 입력')} maxLength={2000}
              value={draft} readOnly={listening || pending} onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault(); event.currentTarget.form?.requestSubmit();
                }
              }}/>
            <button type="submit" className="chat-icon chat-send" disabled={!draft.trim() || pending || locating || listening} aria-label={t('메시지 보내기')}>
              <Icon name="send"/></button>
          </div>
        </form>
      </div>
    </dialog>
  </>;
}
