import { useEffect, useRef, useState } from 'react';
import type { IndoorCue } from './indoorGuidance';

const preference = 'station-indoor-voice-muted';
let current: SpeechSynthesisUtterance | undefined;

function muted() {
  try { return sessionStorage.getItem(preference) === 'yes'; } catch { return false; }
}

function stopVoice() {
  if (!current) return;
  current = undefined;
  window.speechSynthesis.cancel();
}

function speak(text: string, failed?: () => void) {
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ko-KR';
  utterance.onend = () => { if (current === utterance) current = undefined; };
  utterance.onerror = event => {
    if (current !== utterance) return;
    current = undefined;
    if (event.error !== 'interrupted' && event.error !== 'canceled') failed?.();
  };
  current = utterance;
  try { window.speechSynthesis.speak(utterance); }
  catch { current = undefined; failed?.(); }
}

const supported = () => !!window.speechSynthesis && typeof SpeechSynthesisUtterance === 'function';

// Start the platform synthesizer inside the user's tap, before permission and route requests.
export function prepareIndoorVoice(message: string) {
  if (supported() && !muted()) speak(message);
}

export function IndoorVoice({ cue }: { cue?: IndoorCue }) {
  const [enabled, setEnabled] = useState(() => !muted());
  const [needsTap, setNeedsTap] = useState(false);
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) stopVoice(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopVoice();
      heard.current.clear();
    };
  }, []);

  const reportFailure = () => setNeedsTap(true);
  useEffect(() => {
    if (!cue || !enabled || needsTap || !supported() || document.hidden || heard.current.has(cue.key)) return;
    heard.current.add(cue.key);
    speak(cue.spokenText ?? cue.text, reportFailure);
  }, [cue, enabled, needsTap]);

  if (!supported()) return <button className="settings-trigger" type="button" disabled>음성 안내 미지원</button>;
  const active = enabled && !needsTap;
  function toggle() {
    try { sessionStorage.setItem(preference, active ? 'yes' : 'no'); } catch { /* Some webviews disable storage. */ }
    setEnabled(!active);
    setNeedsTap(false);
    if (active) { stopVoice(); return; }
    if (cue) heard.current.add(cue.key);
    speak(cue?.spokenText ?? cue?.text ?? '음성 안내를 시작합니다. 태그를 비추세요.', reportFailure);
  }
  return <button className="settings-trigger voice-toggle" type="button" aria-pressed={active} onClick={toggle}>
    {active ? '음성 안내 끄기' : '음성 안내 켜기'}
  </button>;
}
